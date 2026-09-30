package xyz.openbalance.terminal.data

import androidx.room.withTransaction
import org.json.JSONObject
import xyz.openbalance.terminal.protocol.AttendeeVoucherResponse
import xyz.openbalance.terminal.protocol.ChannelSnapshot
import xyz.openbalance.terminal.protocol.OfflineProtocol
import xyz.openbalance.terminal.protocol.TerminalPaymentRequest
import xyz.openbalance.terminal.protocol.VoucherReceipt
import xyz.openbalance.terminal.security.EncryptedJournalPayloads
import xyz.openbalance.terminal.security.TerminalKeyStore
import xyz.openbalance.terminal.security.Keccak
import xyz.openbalance.terminal.provisioning.PosOrder
import java.math.BigInteger
import java.security.SecureRandom
import java.util.UUID

data class UploadAuthorization(val keyVersion: Long, val sentAt: Long, val nonce: String, val signature: String)
data class SalePayload(
    val request: TerminalPaymentRequest,
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
)
data class ChannelView(val channelId: String, val remainingUnits: String, val acceptUntil: Long)

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

    suspend fun prepareOrderSale(
        orderId: String,
        channelId: String,
        acceptedAt: Long,
        latestTrustedAt: Long,
        nowSeconds: Long,
        now: Long,
    ): SaleView =
        database.withTransaction {
            val order = requireNotNull(dao.order(orderId)) { "POS order is not imported" }
            check(order.state == "IMPORTED" && order.expiresAt > nowSeconds) { "POS order is unavailable" }
            val channel = requireNotNull(dao.channel(channelId.lowercase())) { "Channel is not installed" }
            val snapshot = parseSnapshot(channel.snapshotJson)
            val expiresAt = minOf(order.expiresAt, snapshot.acceptUntil, Math.addExact(nowSeconds, 120))
            check(latestTrustedAt >= acceptedAt && latestTrustedAt < expiresAt) { "Trusted time does not fit the payment window" }
            releaseExpiredRequest(channel.channelId, channel.nextSequence, nowSeconds, now)
            val requestId = UUID.randomUUID().toString()
            var paymentBytes: ByteArray
            do paymentBytes = ByteArray(32).also(SecureRandom()::nextBytes) while (paymentBytes.all { it == 0.toByte() })
            val paymentId = "0x" + paymentBytes.toHex()
            val (_, request) = OfflineProtocol.prepareVoucher(
                snapshot, channel.nextSequence, channel.lastVoucherDigest, BigInteger(channel.spentUnits),
                paymentId, order.orderRefHash, BigInteger(order.grossUnits), order.receiptCommitment,
                acceptedAt, expiresAt, requestId,
            )
            val sealed = seal(requestId, SalePayload(request, null, null))
            dao.insertSale(newSale(requestId, channel.channelId, channel.nextSequence, paymentId, sealed, now))
            check(dao.markOrderRequested(orderId, requestId, nowSeconds, now) == 1) { "POS order was already used" }
            view(requireNotNull(dao.sale(requestId)))
        }

    suspend fun prepareSale(
        channelId: String,
        requestId: String,
        paymentId: String,
        orderRefHash: String,
        grossUnits: BigInteger,
        receiptCommitment: String,
        acceptedAt: Long,
        expiresAt: Long,
        now: Long,
    ): SaleView = database.withTransaction {
        val channel = requireNotNull(dao.channel(channelId.lowercase())) { "Channel is not installed" }
        val snapshot = parseSnapshot(channel.snapshotJson)
        val (_, request) = OfflineProtocol.prepareVoucher(
            snapshot, channel.nextSequence, channel.lastVoucherDigest, BigInteger(channel.spentUnits),
            paymentId, orderRefHash, grossUnits, receiptCommitment, acceptedAt, expiresAt, requestId,
        )
        val payload = SalePayload(request, null, null)
        val sealed = seal(requestId, payload)
        dao.insertSale(newSale(requestId, channel.channelId, channel.nextSequence, paymentId.lowercase(), sealed, now))
        view(requireNotNull(dao.sale(requestId)))
    }

    suspend fun recordAttendeeResponse(requestId: String, qr: String, nowSeconds: Long, now: Long): SaleView =
        database.withTransaction {
            val row = requireNotNull(dao.sale(requestId)) { "Sale not found" }
            check(row.state == "PREPARED" || row.state == "ATTENDEE_SIGNED") { "Sale cannot accept attendee response" }
            val current = open(row)
            val snapshot = parseSnapshot(requireNotNull(dao.channel(row.channelId)).snapshotJson)
            val response = OfflineProtocol.decodeAttendeeResponseQr(qr)
            val signature = OfflineProtocol.verifyAttendee(current.request, response, snapshot.attendeeSigner, nowSeconds)
            if (current.attendeeSignature != null) check(current.attendeeSignature == signature) { "Attendee signature conflict" }
            val next = current.copy(attendeeSignature = signature)
            val sealed = seal(requestId, next)
            if (row.state == "PREPARED") check(dao.transition(requestId, "PREPARED", "ATTENDEE_SIGNED", sealed.first, sealed.second, now) == 1)
            view(requireNotNull(dao.sale(requestId)))
        }

    suspend fun accept(requestId: String, nowSeconds: Long, now: Long, signingTime: () -> Pair<Long, Long>): SaleView = database.withTransaction {
        val row = requireNotNull(dao.sale(requestId)) { "Sale not found" }
        if (row.state == "ACCEPTED") return@withTransaction view(row)
        check(row.state == "ATTENDEE_SIGNED") { "Sale is not ready" }
        val payload = open(row)
        val attendeeSignature = requireNotNull(payload.attendeeSignature)
        val channel = requireNotNull(dao.channel(row.channelId))
        val snapshot = parseSnapshot(channel.snapshotJson)
        val voucher = OfflineProtocol.decodeVoucher(payload.request.voucher)
        check(nowSeconds < voucher.acceptUntil && nowSeconds <= payload.request.expiresAt) { "Acceptance window closed" }
        check(channel.nextSequence == voucher.sequence && channel.lastVoucherDigest.equals(voucher.previousVoucherDigest, true)) { "Channel cursor conflict" }
        val terminalSignature = "0x" + keys.signDigest(OfflineProtocol.voucherDigest(voucher)).toHex()
        val time = signingTime()
        check(time.first >= Math.multiplyExact(snapshot.acceptFrom, 1000L) &&
            time.second < Math.multiplyExact(voucher.acceptUntil, 1000L) &&
            time.second <= Math.multiplyExact(payload.request.expiresAt, 1000L)) { "Signing crossed the acceptance window" }
        val receipt = VoucherReceipt(
            receiptId = "receipt:${Keccak.hex(requestId.toByteArray()).removePrefix("0x")}", terminalId = snapshot.terminalId,
            channelId = snapshot.channelId, sequence = voucher.sequence, paymentId = voucher.paymentId,
            voucher = payload.request.voucher, attendeeSignature = attendeeSignature, terminalSignature = terminalSignature,
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

    suspend fun recoverSales(): List<SaleView> = dao.sales().map(::view)
    suspend fun pendingRelayCount(): Int = dao.pendingRelayCount()
    suspend fun channels(): List<ChannelEntity> = dao.channels()
    suspend fun channelViews(): List<ChannelView> = dao.channels().map { row ->
        val snapshot = parseSnapshot(row.snapshotJson)
        ChannelView(row.channelId, (snapshot.reserveUnits - BigInteger(row.spentUnits)).toString(), snapshot.acceptUntil)
    }
    suspend fun orderViews(): List<OrderView> = dao.orders().map { row ->
        val value = JSONObject(String(payloads.open(row.payloadNonce, row.payloadCiphertext, row.orderId.toByteArray())))
        OrderView(
            row.orderId, value.getString("orderReference"), value.getString("description"), row.grossUnits,
            value.getString("assetSymbol"), value.getInt("assetDecimals"), row.expiresAt, row.state,
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
        check(held.state == "PREPARED" && open(held).request.expiresAt <= nowSeconds) {
            "Channel sequence is held by an open or answered payment request"
        }
        check(dao.deleteUnansweredSale(held.requestId) == 1) { "Expired payment request changed concurrently" }
        dao.expireRequestedOrder(held.requestId, now)
    }

    private fun view(row: SaleEntity): SaleView {
        val payload = open(row)
        return SaleView(
            row.requestId, row.channelId, row.state, row.relayState,
            OfflineProtocol.encodeRequestQr(payload.request), payload.receipt?.let(OfflineProtocol::canonicalReceipt),
            row.transactionHash, row.lastUploadError,
        )
    }

    private fun seal(requestId: String, payload: SalePayload): Pair<ByteArray, ByteArray> = payloads.seal(
        payloadJson(payload).toByteArray(), requestId.toByteArray(),
    )
    private fun open(row: SaleEntity): SalePayload = parsePayload(
        String(payloads.open(row.payloadNonce, row.payloadCiphertext, row.requestId.toByteArray())),
    )

    private fun payloadJson(value: SalePayload) = JSONObject().apply {
        put("requestQr", OfflineProtocol.encodeRequestQr(value.request))
        put("attendeeSignature", value.attendeeSignature ?: JSONObject.NULL)
        put("receipt", value.receipt?.let(OfflineProtocol::canonicalReceipt) ?: JSONObject.NULL)
        put("uploadAuthorization", value.uploadAuthorization?.let { authorizationJson(it) } ?: JSONObject.NULL)
    }.toString()

    private fun parsePayload(value: String): SalePayload {
        val json = JSONObject(value)
        val request = decodeRequestQr(json.getString("requestQr"))
        val receipt = if (json.isNull("receipt")) null else parseReceipt(json.getString("receipt"))
        val authorization = if (!json.has("uploadAuthorization") || json.isNull("uploadAuthorization")) null
        else parseAuthorization(json.getJSONObject("uploadAuthorization"))
        return SalePayload(
            request,
            if (json.isNull("attendeeSignature")) null else json.getString("attendeeSignature"),
            receipt,
            authorization,
        )
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
}
