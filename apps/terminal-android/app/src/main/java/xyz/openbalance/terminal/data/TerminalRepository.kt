package xyz.openbalance.terminal.data

import androidx.room.withTransaction
import org.json.JSONObject
import xyz.openbalance.terminal.protocol.ChannelSnapshot
import xyz.openbalance.terminal.protocol.OfflineProtocol
import xyz.openbalance.terminal.protocol.OpenPaymentRequest
import xyz.openbalance.terminal.protocol.TerminalPaymentRequest
import xyz.openbalance.terminal.protocol.VoucherReceipt
import xyz.openbalance.terminal.security.EncryptedJournalPayloads
import xyz.openbalance.terminal.security.TerminalKeyStore
import xyz.openbalance.terminal.security.Keccak
import xyz.openbalance.terminal.protocol.CheckoutCommitments
import xyz.openbalance.terminal.provisioning.PosOrder
import xyz.openbalance.terminal.provisioning.VendorProfile
import java.math.BigInteger
import java.security.SecureRandom
import java.util.UUID

data class UploadAuthorization(val keyVersion: Long, val sentAt: Long, val nonce: String, val signature: String)
/**
 * What the journal stores for one sale. [requestQr] is the code shown to the customer, kept byte
 * for byte. A version 2 request is not tied to a reserve until the customer answers, so
 * [voucher] is null until then; version 1 rows (from before) carry the voucher in the request.
 */
data class SalePayload(
    val requestQr: String,
    val grossUnits: BigInteger,
    val expiresAt: Long,
    val openRequest: OpenPaymentRequest?,
    val voucher: String?,
    val attendeeSignature: String?,
    val receipt: VoucherReceipt?,
    val uploadAuthorization: UploadAuthorization? = null,
)
data class SaleView(
    val requestId: String,
    val channelId: String,
    val state: String,
    val relayState: String,
    val requestQr: String,
    val receiptJson: String?,
    val transactionHash: String?,
    val lastUploadError: String?,
    val grossUnits: String = "0",
    /** Request expiry, epoch seconds: the attendee must answer before this. */
    val expiresAt: Long = 0,
    /** Creation time, epoch milliseconds. */
    val createdAt: Long = 0,
    /** The reserve's submission deadline, epoch seconds: an unsettled sale is lost after it. */
    val submitUntil: Long = 0,
)
data class RelayUploadLease(
    val requestId: String,
    val receipt: VoucherReceipt,
    val authorization: UploadAuthorization?,
    val attempts: Int,
    val acknowledged: Boolean,
)
data class OrderView(
    val orderId: String,
    val orderReference: String,
    val description: String,
    val grossUnits: String,
    val assetSymbol: String,
    val assetDecimals: Int,
    val expiresAt: Long,
    val state: String,
    /** The payment request charged against this order, once one exists. */
    val requestId: String? = null,
)
data class ChannelView(
    val channelId: String,
    val remainingUnits: String,
    val acceptUntil: Long,
    /** The reserve's finalized per-sale cap. */
    val maxPerSaleUnits: BigInteger = BigInteger.ZERO,
    /** Sales the reserve can still take before its finalized sale count runs out. */
    val salesLeft: Long = 0,
    /** Offline sales against this reserve must reach the chain before this, epoch seconds. */
    val submitUntil: Long = 0,
)

class TerminalRepository(
    private val database: TerminalDatabase,
    private val keys: TerminalKeyStore,
    private val payloads: EncryptedJournalPayloads = EncryptedJournalPayloads(),
) {
    private val dao = database.terminalDao()

    suspend fun installVerifiedChannel(snapshot: ChannelSnapshot, finalizedProofHash: String, now: Long): Boolean {
        require(finalizedProofHash.matches(Regex("^0x[0-9a-fA-F]{64}$")))
        require(snapshot.terminalSigner.equals(keys.getOrCreate().signer, true)) { "Channel belongs to another terminal key" }
        val canonical = snapshotJson(snapshot)
        val hash = Keccak.hex(canonical.toByteArray())
        val existing = dao.channel(snapshot.channelId.lowercase())
        if (existing != null) {
            check(existing.snapshotHash == hash) {
                "Finalized channel snapshot conflict"
            }
            return false
        }
        return dao.insertChannel(
            ChannelEntity(
                snapshot.channelId.lowercase(), canonical, hash, finalizedProofHash.lowercase(),
                1, "0", snapshot.genesisDigest.lowercase(), now, now,
            ),
        ) != -1L
    }

    suspend fun importOrders(orders: List<PosOrder>, now: Long): Int = database.withTransaction {
        var created = 0
        for (order in orders) {
            val canonical = orderJson(order)
            val existing = dao.order(order.orderId)
            if (existing != null) {
                check(existing.orderRefHash == order.orderRefHash && existing.orderVersion == order.orderVersion.toString() &&
                    existing.grossUnits == order.grossUnits.toString() && existing.receiptCommitment == order.receiptCommitment &&
                    existing.expiresAt == order.expiresAt && String(payloads.open(existing.payloadNonce, existing.payloadCiphertext, order.orderId.toByteArray())) == canonical
                ) { "Imported POS order conflict" }
                continue
            }
            val sealed = payloads.seal(canonical.toByteArray(), order.orderId.toByteArray())
            check(dao.insertOrder(
                OrderEntity(
                    order.orderId, order.orderRefHash, order.orderVersion.toString(), order.grossUnits.toString(),
                    order.receiptCommitment, order.expiresAt, "IMPORTED", sealed.first, sealed.second, null, now, now,
                ),
            ) != -1L) { "POS order import conflict" }
            created++
        }
        created
    }

    /**
     * Creates a payment request for an order without choosing a reserve: the customer's phone
     * picks one of its reserves for this stall when it answers. The request lists every reserve
     * this terminal can charge for the amount, with the position it expects next on each, so the
     * phone builds the same voucher the terminal will. Throws when no reserve can cover it.
     */
    suspend fun prepareOrderSale(
        orderId: String,
        acceptedAt: Long,
        latestTrustedAt: Long,
        nowSeconds: Long,
        now: Long,
    ): SaleView =
        database.withTransaction {
            val order = requireNotNull(dao.order(orderId)) { "POS order is not imported" }
            check(order.state == "IMPORTED" && order.expiresAt > nowSeconds) { "POS order is unavailable" }
            releaseExpiredUnboundRequests(nowSeconds, now)
            val gross = BigInteger(order.grossUnits)
            val eligible = chargeableChannels(gross, acceptedAt, nowSeconds)
            check(eligible.isNotEmpty()) { "No customer reserve here can pay this amount" }
            // One terminal identity per request; after a re-pairing, older reserves may name another.
            val terminalId = eligible.first().second.terminalId.lowercase()
            val cursors = eligible.filter { it.second.terminalId.equals(terminalId, true) }
                .sortedByDescending { it.second.acceptUntil }
                .distinctBy { OfflineProtocol.cursorKey(it.first.channelId) }
                .take(OfflineProtocol.MAX_REQUEST_CURSORS)
                .map { "${OfflineProtocol.cursorKey(it.first.channelId)}:${it.first.nextSequence}" }
                .sorted()
            val expiresAt = minOf(order.expiresAt, Math.addExact(nowSeconds, REQUEST_SECONDS))
            check(latestTrustedAt >= acceptedAt && latestTrustedAt < expiresAt) { "Trusted time does not fit the payment window" }
            val requestId = UUID.randomUUID().toString()
            var paymentBytes: ByteArray
            do paymentBytes = ByteArray(32).also(SecureRandom()::nextBytes) while (paymentBytes.all { it == 0.toByte() })
            val paymentId = "0x" + paymentBytes.toHex()
            val request = OpenPaymentRequest(
                requestId, terminalId, paymentId, order.orderRefHash.lowercase(), order.receiptCommitment.lowercase(),
                gross, acceptedAt, expiresAt, cursors,
            )
            val payload = SalePayload(OfflineProtocol.encodeOpenRequestQr(request), gross, expiresAt, request, null, null, null)
            dao.insertSale(newSale(requestId, UNBOUND + requestId, 0, paymentId, seal(requestId, payload), now))
            check(dao.markOrderRequested(orderId, requestId, nowSeconds, now) == 1) { "POS order was already used" }
            view(requireNotNull(dao.sale(requestId)))
        }

    /**
     * Reserves this terminal can charge [gross] against now, newest first, with their parsed
     * terms. A reserve whose next position is still held by an older, live or answered request is
     * left out until that request settles one way or the other.
     */
    private suspend fun chargeableChannels(gross: BigInteger, acceptedAt: Long, nowSeconds: Long) =
        dao.channels().mapNotNull { row ->
            val snapshot = parseSnapshot(row.snapshotJson)
            val held = dao.saleAt(row.channelId, row.nextSequence)
            val heldOpen = held != null && !(held.state == "PREPARED" && open(held).expiresAt <= nowSeconds)
            val remaining = snapshot.reserveUnits - BigInteger(row.spentUnits)
            if (heldOpen || nowSeconds >= snapshot.acceptUntil || acceptedAt < snapshot.acceptFrom ||
                acceptedAt >= snapshot.acceptUntil || row.nextSequence > snapshot.maxVoucherCount ||
                gross > snapshot.maxPerVoucher || gross > remaining
            ) null else row to snapshot
        }

    /** Unanswered version 2 requests past their expiry hold nothing; drop them and free their orders. */
    private suspend fun releaseExpiredUnboundRequests(nowSeconds: Long, now: Long) {
        for (row in dao.preparedUnbound()) {
            if (open(row).expiresAt > nowSeconds) continue
            if (dao.deleteUnansweredSale(row.requestId) == 1) dao.expireRequestedOrder(row.requestId, now)
        }
    }

    /**
     * A sale the cashier keys in on the terminal, the way card terminals take a custom amount. It
     * needs no connection: the terminal records its own order with the same order-reference hash and
     * receipt commitment the protocol defines for POS orders, then charges it like an imported one.
     */
    suspend fun prepareKeypadSale(
        vendor: VendorProfile,
        description: String,
        grossUnits: BigInteger,
        acceptedAt: Long,
        latestTrustedAt: Long,
        nowSeconds: Long,
        now: Long,
    ): SaleView = database.withTransaction {
        require(grossUnits > BigInteger.ZERO) { "Enter an amount" }
        val suffix = ByteArray(3).also(SecureRandom()::nextBytes).toHex()
        val reference = "KP-" + keypadReferenceFormat.format(java.time.Instant.ofEpochSecond(nowSeconds)) + "-" + suffix
        val version = BigInteger.ONE
        val display = CheckoutCommitments.Display(
            vendor.vendorName, reference, version, description, vendor.assetSymbol, vendor.assetDecimals,
        )
        val order = PosOrder(
            orderId = UUID.randomUUID().toString(),
            orderRefHash = CheckoutCommitments.orderReferenceHash(reference, version),
            orderVersion = version,
            grossUnits = grossUnits,
            receiptCommitment = CheckoutCommitments.receiptCommitment(display, grossUnits),
            // Only bounds the order row; the request itself expires within two minutes.
            expiresAt = Math.addExact(nowSeconds, KEYPAD_ORDER_SECONDS),
            vendorName = vendor.vendorName,
            orderReference = reference,
            description = description,
            assetSymbol = vendor.assetSymbol,
            assetDecimals = vendor.assetDecimals,
        )
        check(importOrders(listOf(order), now) == 1) { "Keypad order conflict" }
        prepareOrderSale(order.orderId, acceptedAt, latestTrustedAt, nowSeconds, now)
    }

    /**
     * Takes the customer's answer to a version 2 request and, in one transaction, binds the sale to
     * the reserve they chose, checks their signature against the voucher this terminal builds
     * from its own position on that reserve, and countersigns. Nothing the phone says about the
     * reserve's state is trusted: a phone that is out of step simply fails the signature check.
     */
    suspend fun respond(requestId: String, qr: String, nowSeconds: Long, now: Long, signingTime: () -> Pair<Long, Long>): SaleView =
        database.withTransaction {
            val row = requireNotNull(dao.sale(requestId)) { "Sale not found" }
            if (row.state == "ACCEPTED") return@withTransaction view(row)
            if (row.state == "ATTENDEE_SIGNED") return@withTransaction accept(requestId, nowSeconds, now, signingTime)
            check(row.state == "PREPARED" && row.channelId.startsWith(UNBOUND)) { "This payment cannot take an answer" }
            val payload = open(row)
            val request = requireNotNull(payload.openRequest) { "This payment cannot take an answer" }
            val response = OfflineProtocol.decodeChannelResponseQr(qr)
            check(response.requestHash.equals(OfflineProtocol.openRequestHash(request), true)) {
                "That approval is for another payment"
            }
            check(nowSeconds <= request.expiresAt) { "The approval came too late. Charge again" }
            val channelId = response.channelId.lowercase()
            val channel = requireNotNull(dao.channel(channelId)) { "That reserve is not on this terminal. Tap Refresh and charge again" }
            val snapshot = parseSnapshot(channel.snapshotJson)
            check(snapshot.terminalId.equals(request.terminalId, true)) { "That reserve belongs to another stall" }
            check("${OfflineProtocol.cursorKey(channelId)}:${channel.nextSequence}" in request.cursors) {
                "That reserve was not offered for this payment. Charge again"
            }
            releaseExpiredRequest(channelId, channel.nextSequence, nowSeconds, now)
            val voucher = OfflineProtocol.buildVoucher(
                snapshot, channel.nextSequence, channel.lastVoucherDigest, BigInteger(channel.spentUnits), request,
            )
            val signature = OfflineProtocol.verifyAttendeeVoucher(voucher, response.attendeeSignature, snapshot.attendeeSigner)
            val bound = payload.copy(voucher = OfflineProtocol.encodeVoucher(voucher), attendeeSignature = signature)
            val sealed = seal(requestId, bound)
            check(dao.bindSale(requestId, row.channelId, channelId, voucher.sequence, sealed.first, sealed.second, now) == 1) {
                "Payment changed while it was being accepted"
            }
            accept(requestId, nowSeconds, now, signingTime)
        }

    suspend fun accept(requestId: String, nowSeconds: Long, now: Long, signingTime: () -> Pair<Long, Long>): SaleView = database.withTransaction {
        val row = requireNotNull(dao.sale(requestId)) { "Sale not found" }
        if (row.state == "ACCEPTED") return@withTransaction view(row)
        check(row.state == "ATTENDEE_SIGNED") { "Sale is not ready" }
        val payload = open(row)
        val attendeeSignature = requireNotNull(payload.attendeeSignature)
        val channel = requireNotNull(dao.channel(row.channelId))
        val snapshot = parseSnapshot(channel.snapshotJson)
        val encodedVoucher = requireNotNull(payload.voucher) { "Sale is not tied to a reserve yet" }
        val voucher = OfflineProtocol.decodeVoucher(encodedVoucher)
        check(nowSeconds < voucher.acceptUntil && nowSeconds <= payload.expiresAt) { "Acceptance window closed" }
        check(channel.nextSequence == voucher.sequence && channel.lastVoucherDigest.equals(voucher.previousVoucherDigest, true)) { "Channel cursor conflict" }
        val terminalSignature = "0x" + keys.signDigest(OfflineProtocol.voucherDigest(voucher)).toHex()
        val time = signingTime()
        check(time.first >= Math.multiplyExact(snapshot.acceptFrom, 1000L) &&
            time.second < Math.multiplyExact(voucher.acceptUntil, 1000L) &&
            time.second <= Math.multiplyExact(payload.expiresAt, 1000L)) { "Signing crossed the acceptance window" }
        val receipt = VoucherReceipt(
            receiptId = "receipt:${Keccak.hex(requestId.toByteArray()).removePrefix("0x")}", terminalId = snapshot.terminalId,
            channelId = snapshot.channelId, sequence = voucher.sequence, paymentId = voucher.paymentId,
            voucher = encodedVoucher, attendeeSignature = attendeeSignature, terminalSignature = terminalSignature,
        )
        val receiptJson = OfflineProtocol.canonicalReceipt(receipt)
        val sealed = seal(requestId, payload.copy(receipt = receipt))
        check(dao.transition(requestId, "ATTENDEE_SIGNED", "ACCEPTED", sealed.first, sealed.second, now) == 1)
        check(dao.markRelayPending(requestId, now) == 1)
        check(dao.advanceChannel(row.channelId, voucher.sequence, voucher.sequence + 1, voucher.cumulativeGrossUnits.toString(), "0x" + OfflineProtocol.voucherDigest(voucher).toHex(), now) == 1)
        view(requireNotNull(dao.sale(requestId))).copy(receiptJson = receiptJson)
    }

    suspend fun leaseRelayUploads(limit: Int, owner: String, now: Long, leaseMilliseconds: Long): List<RelayUploadLease> =
        database.withTransaction {
            require(limit in 1..100 && owner.matches(Regex("^[A-Za-z0-9:_-]{1,128}$")))
            require(now >= 0 && leaseMilliseconds in 1_000..300_000)
            val leases = mutableListOf<RelayUploadLease>()
            for (candidate in dao.uploadCandidates(now, limit)) {
                val leaseUntil = Math.addExact(now, leaseMilliseconds)
                if (dao.leaseUpload(candidate.requestId, owner, now, leaseUntil) != 1) continue
                val leased = requireNotNull(dao.sale(candidate.requestId))
                val payload = open(leased)
                leases += RelayUploadLease(
                    requestId = leased.requestId,
                    receipt = requireNotNull(payload.receipt) { "Accepted sale is missing its receipt" },
                    authorization = payload.uploadAuthorization,
                    attempts = leased.uploadAttempts,
                    acknowledged = leased.relayAcknowledgedAt != null,
                )
            }
            leases
        }

    suspend fun saveUploadAuthorization(
        requestId: String,
        owner: String,
        authorization: UploadAuthorization,
        now: Long,
    ) = database.withTransaction {
        val row = requireNotNull(dao.sale(requestId)) { "Sale not found" }
        val payload = open(row).copy(uploadAuthorization = authorization)
        val sealed = seal(requestId, payload)
        check(dao.saveUploadPayload(requestId, owner, sealed.first, sealed.second, now) == 1) {
            "Relay upload lease was lost"
        }
    }

    suspend fun completeRelayUpload(
        requestId: String,
        owner: String,
        relayState: String,
        nextAttemptAt: Long,
        transactionHash: String?,
        lastError: String?,
        acknowledgedAt: Long?,
        now: Long,
    ) {
        require(relayState in setOf("RETRY", "RELAYED", "SETTLED", "QUARANTINED"))
        require(nextAttemptAt >= now && (transactionHash == null || transactionHash.matches(Regex("^0x[0-9a-fA-F]{64}$"))))
        require(lastError == null || lastError.length in 1..500)
        check(
            dao.completeUploadLease(
                requestId, owner, relayState, nextAttemptAt, transactionHash?.lowercase(),
                lastError, acknowledgedAt, now,
            ) == 1,
        ) { "Relay upload lease was lost" }
    }

    suspend fun recoverSales(limit: Int = 100): List<SaleView> = dao.sales(limit).map(::view)
    suspend fun pendingRelayCount(): Int = dao.pendingRelayCount()
    suspend fun channels(): List<ChannelEntity> = dao.channels()
    suspend fun channelViews(): List<ChannelView> = dao.channels().map { row ->
        val snapshot = parseSnapshot(row.snapshotJson)
        ChannelView(
            row.channelId, (snapshot.reserveUnits - BigInteger(row.spentUnits)).toString(), snapshot.acceptUntil,
            snapshot.maxPerVoucher, (snapshot.maxVoucherCount - row.nextSequence + 1).coerceAtLeast(0), snapshot.submitUntil,
        )
    }

    /** Every unsettled accepted sale, not just the recent list, so the totals cannot undercount. */
    suspend fun pendingUploads(): OfflineLimits.PendingUploads = OfflineLimits.pendingUploads(
        dao.unsettledSales().map { row ->
            val voucher = OfflineProtocol.decodeVoucher(requireNotNull(open(row).voucher))
            OfflineLimits.UnsettledSale(row.relayState, row.relayAcknowledgedAt != null, voucher.grossUnits, voucher.submitUntil)
        },
        // Display only: the deadline the vault enforces is chain time, which this clock tracks closely.
        System.currentTimeMillis() / 1_000,
    )
    suspend fun orderViews(): List<OrderView> = dao.orders().map { row ->
        val value = JSONObject(String(payloads.open(row.payloadNonce, row.payloadCiphertext, row.orderId.toByteArray())))
        OrderView(
            row.orderId, value.getString("orderReference"), value.getString("description"), row.grossUnits,
            value.getString("assetSymbol"), value.getInt("assetDecimals"), row.expiresAt, row.state, row.requestId,
        )
    }

    /**
     * A request the attendee never answered holds the channel's next sequence only until it expires.
     * The terminal countersigns only after verifying the attendee's signature, so an unanswered
     * request carries no terminal signature and can never settle; releasing it lets the channel
     * continue at the same sequence. A request that is still live, or one the terminal has already
     * scanned an answer for, keeps the sequence.
     */
    private suspend fun releaseExpiredRequest(channelId: String, sequence: Long, nowSeconds: Long, now: Long) {
        val held = dao.saleAt(channelId, sequence) ?: return
        check(held.state == "PREPARED" && open(held).expiresAt <= nowSeconds) {
            "Channel sequence is held by an open or answered payment request"
        }
        check(dao.deleteUnansweredSale(held.requestId) == 1) { "Expired payment request changed concurrently" }
        dao.expireRequestedOrder(held.requestId, now)
    }

    private fun view(row: SaleEntity): SaleView {
        val payload = open(row)
        val voucher = payload.voucher?.let(OfflineProtocol::decodeVoucher)
        return SaleView(
            row.requestId, if (row.channelId.startsWith(UNBOUND)) "" else row.channelId, row.state, row.relayState,
            payload.requestQr, payload.receipt?.let(OfflineProtocol::canonicalReceipt),
            row.transactionHash, row.lastUploadError,
            payload.grossUnits.toString(),
            payload.expiresAt, row.createdAt, voucher?.submitUntil ?: 0,
        )
    }

    private fun seal(requestId: String, payload: SalePayload): Pair<ByteArray, ByteArray> = payloads.seal(
        payloadJson(payload).toByteArray(), requestId.toByteArray(),
    )
    private fun open(row: SaleEntity): SalePayload = parsePayload(
        String(payloads.open(row.payloadNonce, row.payloadCiphertext, row.requestId.toByteArray())),
    )

    private fun payloadJson(value: SalePayload) = JSONObject().apply {
        put("requestQr", value.requestQr)
        put("voucher", value.voucher ?: JSONObject.NULL)
        put("attendeeSignature", value.attendeeSignature ?: JSONObject.NULL)
        put("receipt", value.receipt?.let(OfflineProtocol::canonicalReceipt) ?: JSONObject.NULL)
        put("uploadAuthorization", value.uploadAuthorization?.let { authorizationJson(it) } ?: JSONObject.NULL)
    }.toString()

    private fun parsePayload(value: String): SalePayload {
        val json = JSONObject(value)
        val requestQr = json.getString("requestQr")
        val receipt = if (json.isNull("receipt")) null else parseReceipt(json.getString("receipt"))
        val authorization = if (!json.has("uploadAuthorization") || json.isNull("uploadAuthorization")) null
        else parseAuthorization(json.getJSONObject("uploadAuthorization"))
        val attendeeSignature = if (json.isNull("attendeeSignature")) null else json.getString("attendeeSignature")
        if (OfflineProtocol.qrVersion(requestQr) == 2) {
            val request = OfflineProtocol.decodeOpenRequestQr(requestQr)
            val voucher = if (!json.has("voucher") || json.isNull("voucher")) null else json.getString("voucher")
            return SalePayload(requestQr, request.grossUnits, request.expiresAt, request, voucher, attendeeSignature, receipt, authorization)
        }
        // Version 1 rows: the request was already tied to one reserve and carries the voucher.
        val legacy = decodeRequestQr(requestQr)
        val voucher = OfflineProtocol.decodeVoucher(legacy.voucher)
        return SalePayload(requestQr, voucher.grossUnits, legacy.expiresAt, null, legacy.voucher, attendeeSignature, receipt, authorization)
    }

    private fun decodeRequestQr(value: String): TerminalPaymentRequest {
        val body = String(android.util.Base64.decode(value.removePrefix("obqr1:"), android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
        val j = JSONObject(body)
        return TerminalPaymentRequest(j.getString("requestId"), j.getString("terminalId"), j.getString("channelId"), j.getString("paymentId"), j.getLong("sequence"), j.getString("voucher"), j.getLong("expiresAt"))
            .also { check(OfflineProtocol.encodeRequestQr(it) == value) { "Stored request is not canonical" } }
    }

    private fun parseReceipt(value: String): VoucherReceipt = JSONObject(value).let { j ->
        VoucherReceipt(j.getString("receiptId"), j.getString("terminalId"), j.getString("channelId"), j.getLong("sequence"), j.getString("paymentId"), j.getString("voucher"), j.getString("attendeeSignature"), j.getString("terminalSignature"))
            .also { check(OfflineProtocol.canonicalReceipt(it) == value) }
    }

    private fun authorizationJson(value: UploadAuthorization) = JSONObject().apply {
        put("keyVersion", value.keyVersion)
        put("sentAt", value.sentAt)
        put("nonce", value.nonce.lowercase())
        put("signature", value.signature.lowercase())
    }

    private fun parseAuthorization(value: JSONObject) = UploadAuthorization(
        value.getLong("keyVersion"), value.getLong("sentAt"), value.getString("nonce"), value.getString("signature"),
    )

    private fun newSale(
        requestId: String,
        channelId: String,
        sequence: Long,
        paymentId: String,
        sealed: Pair<ByteArray, ByteArray>,
        now: Long,
    ) = SaleEntity(
        requestId = requestId,
        channelId = channelId,
        sequence = sequence,
        paymentId = paymentId,
        state = "PREPARED",
        payloadNonce = sealed.first,
        payloadCiphertext = sealed.second,
        relayState = "NOT_READY",
        uploadAttempts = 0,
        nextUploadAt = 0,
        uploadLeaseOwner = null,
        uploadLeaseUntil = null,
        transactionHash = null,
        lastUploadError = null,
        relayAcknowledgedAt = null,
        createdAt = now,
        updatedAt = now,
    )

    private fun snapshotJson(s: ChannelSnapshot) = JSONObject().apply {
        put("channelId", s.channelId.lowercase()); put("terminalId", s.terminalId.lowercase()); put("chainId", s.chainId.toString())
        put("vault", s.vault.lowercase()); put("attendeeSigner", s.attendeeSigner.lowercase()); put("terminalSigner", s.terminalSigner.lowercase())
        put("configVersion", s.configVersion.toString()); put("reserveUnits", s.reserveUnits.toString()); put("maxPerVoucher", s.maxPerVoucher.toString())
        put("maxVoucherCount", s.maxVoucherCount); put("acceptFrom", s.acceptFrom); put("acceptUntil", s.acceptUntil); put("submitUntil", s.submitUntil)
        put("genesisDigest", s.genesisDigest.lowercase())
    }.toString()

    private fun parseSnapshot(value: String): ChannelSnapshot = JSONObject(value).let { j ->
        ChannelSnapshot(j.getString("channelId"), j.getString("terminalId"), BigInteger(j.getString("chainId")), j.getString("vault"), j.getString("attendeeSigner"), j.getString("terminalSigner"), BigInteger(j.getString("configVersion")), BigInteger(j.getString("reserveUnits")), BigInteger(j.getString("maxPerVoucher")), j.getLong("maxVoucherCount"), j.getLong("acceptFrom"), j.getLong("acceptUntil"), j.getLong("submitUntil"), j.getString("genesisDigest"))
    }

    private fun orderJson(order: PosOrder) = JSONObject().apply {
        put("vendorName", order.vendorName)
        put("orderReference", order.orderReference)
        put("description", order.description)
        put("assetSymbol", order.assetSymbol)
        put("assetDecimals", order.assetDecimals)
    }.toString()

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private companion object {
        const val KEYPAD_ORDER_SECONDS = 600L
        /** How long a customer has to answer a payment request. */
        const val REQUEST_SECONDS = 120L
        /** channelId placeholder for a request the customer has not answered (no reserve chosen yet). */
        const val UNBOUND = "unbound:"
        val keypadReferenceFormat: java.time.format.DateTimeFormatter =
            java.time.format.DateTimeFormatter.ofPattern("yyMMdd-HHmmss").withZone(java.time.ZoneOffset.UTC)
    }
}
