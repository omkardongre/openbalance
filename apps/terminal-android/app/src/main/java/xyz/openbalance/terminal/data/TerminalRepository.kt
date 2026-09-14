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
import java.math.BigInteger

data class SalePayload(val request: TerminalPaymentRequest, val attendeeSignature: String?, val receipt: VoucherReceipt?)
data class SaleView(val requestId: String, val channelId: String, val state: String, val requestQr: String, val receiptJson: String?)

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
            check(existing.snapshotHash == hash && existing.finalizedProofHash.equals(finalizedProofHash, true)) {
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
        dao.insertSale(
            SaleEntity(requestId, channel.channelId, channel.nextSequence, paymentId.lowercase(), "PREPARED", sealed.first, sealed.second, now, now),
        )
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
        check(dao.advanceChannel(row.channelId, voucher.sequence, voucher.sequence + 1, voucher.cumulativeGrossUnits.toString(), "0x" + OfflineProtocol.voucherDigest(voucher).toHex(), now) == 1)
        view(requireNotNull(dao.sale(requestId))).copy(receiptJson = receiptJson)
    }

    suspend fun recoverSales(): List<SaleView> = dao.sales().map(::view)
    suspend fun channels(): List<ChannelEntity> = dao.channels()

    private fun view(row: SaleEntity): SaleView {
        val payload = open(row)
        return SaleView(row.requestId, row.channelId, row.state, OfflineProtocol.encodeRequestQr(payload.request), payload.receipt?.let(OfflineProtocol::canonicalReceipt))
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
    }.toString()

    private fun parsePayload(value: String): SalePayload {
        val json = JSONObject(value)
        val request = decodeRequestQr(json.getString("requestQr"))
        val receipt = if (json.isNull("receipt")) null else parseReceipt(json.getString("receipt"))
        return SalePayload(request, if (json.isNull("attendeeSignature")) null else json.getString("attendeeSignature"), receipt)
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

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
