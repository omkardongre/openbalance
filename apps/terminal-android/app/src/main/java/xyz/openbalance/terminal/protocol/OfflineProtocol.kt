package xyz.openbalance.terminal.protocol

import org.json.JSONObject
import org.web3j.crypto.Keys
import org.web3j.crypto.Sign
import xyz.openbalance.terminal.security.Keccak
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

private const val QR_PREFIX = "obqr1:"
private const val MAX_QR_LENGTH = 4096
private val HEX_32 = Regex("^0x[0-9a-fA-F]{64}$")
private val ADDRESS = Regex("^0x[0-9a-fA-F]{40}$")
private val SIGNATURE = Regex("^0x[0-9a-fA-F]{130}$")
private val CURSOR = Regex("^([0-9a-f]{12}):([1-9][0-9]{0,9})$")
private const val VOUCHER_TYPE = "OfflineVoucher(uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion)"
private const val DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
private const val TERMINAL_INGRESS_TYPE = "OpenBalanceTerminalIngress(bytes32 audienceHash,bytes32 terminalId,uint256 keyVersion,uint64 sentAt,bytes32 nonce,bytes32 payloadHash)"

class InvalidOfflineExchange(message: String) : IllegalArgumentException(message)

data class ChannelSnapshot(
    val channelId: String,
    val terminalId: String,
    val chainId: BigInteger,
    val vault: String,
    val attendeeSigner: String,
    val terminalSigner: String,
    val configVersion: BigInteger,
    val reserveUnits: BigInteger,
    val maxPerVoucher: BigInteger,
    val maxVoucherCount: Long,
    val acceptFrom: Long,
    val acceptUntil: Long,
    val submitUntil: Long,
    val genesisDigest: String,
)

data class OfflineVoucher(
    val protocolVersion: Long = 1,
    val chainId: BigInteger,
    val vault: String,
    val channelId: String,
    val sequence: Long,
    val previousVoucherDigest: String,
    val paymentId: String,
    val orderRefHash: String,
    val grossUnits: BigInteger,
    val cumulativeGrossUnits: BigInteger,
    val receiptCommitment: String,
    val acceptedAt: Long,
    val acceptUntil: Long,
    val submitUntil: Long,
    val configVersion: BigInteger,
)

data class TerminalPaymentRequest(
    val requestId: String,
    val terminalId: String,
    val channelId: String,
    val paymentId: String,
    val sequence: Long,
    val voucher: String,
    val expiresAt: Long,
)

data class AttendeeVoucherResponse(val requestHash: String, val attendeeSignature: String)

/**
 * Version 2 request: the cashier charges an amount and the customer's phone picks which of its
 * reserves for this terminal pays. It carries no voucher; [cursors] lists, for every reserve the
 * terminal can charge now, the first 6 bytes of the reserve id and the position the terminal
 * expects next ("abcdef012345:3"), sorted. Must match `packages/protocol/src/open-exchange.ts`.
 */
data class OpenPaymentRequest(
    val requestId: String,
    val terminalId: String,
    val paymentId: String,
    val orderRefHash: String,
    val receiptCommitment: String,
    val grossUnits: BigInteger,
    val acceptedAt: Long,
    val expiresAt: Long,
    val cursors: List<String>,
)

/** The phone's version 2 answer: the reserve it paid from and its signature over that voucher. */
data class ChannelVoucherResponse(val requestHash: String, val channelId: String, val attendeeSignature: String)

data class VoucherReceipt(
    val receiptId: String,
    val terminalId: String,
    val channelId: String,
    val sequence: Long,
    val paymentId: String,
    val voucher: String,
    val attendeeSignature: String,
    val terminalSignature: String,
)

object OfflineProtocol {
    fun prepareVoucher(
        snapshot: ChannelSnapshot,
        nextSequence: Long,
        previousDigest: String,
        spentUnits: BigInteger,
        paymentId: String,
        orderRefHash: String,
        grossUnits: BigInteger,
        receiptCommitment: String,
        acceptedAt: Long,
        expiresAt: Long,
        requestId: String,
    ): Pair<OfflineVoucher, TerminalPaymentRequest> {
        requireSnapshot(snapshot)
        val cumulative = spentUnits + grossUnits
        if (nextSequence !in 1..snapshot.maxVoucherCount || grossUnits <= BigInteger.ZERO ||
            grossUnits > snapshot.maxPerVoucher || cumulative > snapshot.reserveUnits ||
            acceptedAt < snapshot.acceptFrom || acceptedAt >= snapshot.acceptUntil ||
            expiresAt < acceptedAt || expiresAt > snapshot.acceptUntil
        ) throw InvalidOfflineExchange("Sale exceeds finalized channel policy")
        listOf(paymentId, orderRefHash, receiptCommitment, previousDigest).forEach(::requireHex32)
        if (!requestId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$")))
            throw InvalidOfflineExchange("Invalid request ID")

        val voucher = OfflineVoucher(
            chainId = snapshot.chainId,
            vault = snapshot.vault,
            channelId = snapshot.channelId,
            sequence = nextSequence,
            previousVoucherDigest = previousDigest,
            paymentId = paymentId,
            orderRefHash = orderRefHash,
            grossUnits = grossUnits,
            cumulativeGrossUnits = cumulative,
            receiptCommitment = receiptCommitment,
            acceptedAt = acceptedAt,
            acceptUntil = snapshot.acceptUntil,
            submitUntil = snapshot.submitUntil,
            configVersion = snapshot.configVersion,
        )
        val encoded = encodeVoucher(voucher)
        return voucher to TerminalPaymentRequest(
            requestId = requestId,
            terminalId = snapshot.terminalId,
            channelId = snapshot.channelId,
            paymentId = paymentId,
            sequence = nextSequence,
            voucher = encoded,
            expiresAt = expiresAt,
        )
    }

    fun encodeRequestQr(request: TerminalPaymentRequest): String = encodeQr(canonicalRequest(request))

    /** Most reserves one version 2 request lists; keeps the QR comfortably scannable. */
    const val MAX_REQUEST_CURSORS = 48

    /** Key a reserve is listed under in a version 2 request: its id's first 6 bytes, lowercase. */
    fun cursorKey(channelId: String): String {
        requireHex32(channelId)
        return channelId.lowercase().substring(2, 14)
    }

    fun encodeOpenRequestQr(request: OpenPaymentRequest): String = encodeQr(canonicalOpenRequest(request))

    fun openRequestHash(request: OpenPaymentRequest): String = hex(Keccak.digest(canonicalOpenRequest(request).toByteArray()))

    /** Which request version a stored or scanned code carries (1 or 2). */
    fun qrVersion(value: String): Int = decodeQr(value).optInt("version", 0)

    fun decodeOpenRequestQr(value: String): OpenPaymentRequest {
        val json = decodeQr(value)
        val cursors = json.optJSONArray("cursors") ?: throw InvalidOfflineExchange("Invalid terminal payment request")
        val request = OpenPaymentRequest(
            requestId = json.requireString("requestId"),
            terminalId = json.requireString("terminalId"),
            paymentId = json.requireString("paymentId"),
            orderRefHash = json.requireString("orderRefHash"),
            receiptCommitment = json.requireString("receiptCommitment"),
            grossUnits = BigInteger(json.requireString("grossUnits")),
            acceptedAt = json.getLong("acceptedAt"),
            expiresAt = json.getLong("expiresAt"),
            cursors = List(cursors.length()) { cursors.getString(it) },
        )
        if (encodeOpenRequestQr(request) != value) throw InvalidOfflineExchange("Noncanonical payment request")
        return request
    }

    fun decodeChannelResponseQr(value: String): ChannelVoucherResponse {
        val json = decodeQr(value)
        val response = ChannelVoucherResponse(
            requestHash = json.requireString("requestHash"),
            channelId = json.requireString("channelId"),
            attendeeSignature = json.requireString("attendeeSignature"),
        )
        if (json.length() != 5 || json.optInt("version") != 2 ||
            json.requireString("kind") != "offline-voucher-response" ||
            !HEX_32.matches(response.requestHash) || !HEX_32.matches(response.channelId) ||
            !SIGNATURE.matches(response.attendeeSignature) ||
            // Compare bytes, not a re-serialized JSONObject: key order is part of the format.
            encodeQr(canonicalChannelResponse(response)) != value
        ) throw InvalidOfflineExchange("Invalid attendee voucher response")
        return response
    }

    /**
     * The voucher for a version 2 request paid from one reserve, at this terminal's own position
     * on it. The phone builds the same voucher from its records; if the two disagree the attendee
     * signature does not verify and nothing is countersigned. Enforces the reserve's finalized
     * caps and window the vault will enforce again.
     */
    fun buildVoucher(
        snapshot: ChannelSnapshot,
        nextSequence: Long,
        previousDigest: String,
        spentUnits: BigInteger,
        request: OpenPaymentRequest,
    ): OfflineVoucher {
        requireSnapshot(snapshot)
        canonicalOpenRequest(request)
        val cumulative = spentUnits + request.grossUnits
        if (nextSequence !in 1..snapshot.maxVoucherCount || request.grossUnits > snapshot.maxPerVoucher ||
            cumulative > snapshot.reserveUnits || request.acceptedAt < snapshot.acceptFrom ||
            request.acceptedAt >= snapshot.acceptUntil
        ) throw InvalidOfflineExchange("Sale exceeds finalized channel policy")
        requireHex32(previousDigest)
        return OfflineVoucher(
            chainId = snapshot.chainId,
            vault = snapshot.vault,
            channelId = snapshot.channelId,
            sequence = nextSequence,
            previousVoucherDigest = previousDigest,
            paymentId = request.paymentId,
            orderRefHash = request.orderRefHash,
            grossUnits = request.grossUnits,
            cumulativeGrossUnits = cumulative,
            receiptCommitment = request.receiptCommitment,
            acceptedAt = request.acceptedAt,
            acceptUntil = snapshot.acceptUntil,
            submitUntil = snapshot.submitUntil,
            configVersion = snapshot.configVersion,
        ).also(::validateVoucher)
    }

    fun verifyAttendeeVoucher(voucher: OfflineVoucher, signature: String, expectedSigner: String): String {
        if (!SIGNATURE.matches(signature)) throw InvalidOfflineExchange("Invalid signature")
        val recovered = recover(voucherDigest(voucher), signature)
        if (!recovered.equals(expectedSigner, ignoreCase = true))
            throw InvalidOfflineExchange("Attendee signature does not match channel authority")
        return signature.lowercase()
    }

    fun decodeAttendeeResponseQr(value: String): AttendeeVoucherResponse {
        val json = decodeQr(value)
        val response = AttendeeVoucherResponse(
            requestHash = json.requireString("requestHash"),
            attendeeSignature = json.requireString("attendeeSignature"),
        )
        if (json.length() != 4 || json.getInt("version") != 1 ||
            json.requireString("kind") != "offline-voucher-response" ||
            !HEX_32.matches(response.requestHash) || !SIGNATURE.matches(response.attendeeSignature) ||
            json.toString() != canonicalResponse(response)
        ) throw InvalidOfflineExchange("Invalid attendee voucher response")
        return response
    }

    fun requestHash(request: TerminalPaymentRequest): String = hex(Keccak.digest(canonicalRequest(request).toByteArray()))

    fun voucherDigest(voucher: OfflineVoucher): ByteArray {
        validateVoucher(voucher)
        val domain = hashSlots(
            Keccak.digest(DOMAIN_TYPE.toByteArray()),
            Keccak.digest("OpenBalanceOfflineVoucher".toByteArray()),
            Keccak.digest("1".toByteArray()),
            uint(voucher.chainId),
            address(voucher.vault),
        )
        val struct = hashSlots(
            Keccak.digest(VOUCHER_TYPE.toByteArray()),
            uint(voucher.protocolVersion), uint(voucher.chainId), address(voucher.vault), bytes32(voucher.channelId),
            uint(voucher.sequence), bytes32(voucher.previousVoucherDigest), bytes32(voucher.paymentId),
            bytes32(voucher.orderRefHash), uint(voucher.grossUnits), uint(voucher.cumulativeGrossUnits),
            bytes32(voucher.receiptCommitment), uint(voucher.acceptedAt), uint(voucher.acceptUntil),
            uint(voucher.submitUntil), uint(voucher.configVersion),
        )
        return Keccak.digest(byteArrayOf(0x19, 0x01) + domain + struct)
    }

    fun encodeVoucher(voucher: OfflineVoucher): String {
        validateVoucher(voucher)
        return hex(concatSlots(
            uint(voucher.protocolVersion), uint(voucher.chainId), address(voucher.vault), bytes32(voucher.channelId),
            uint(voucher.sequence), bytes32(voucher.previousVoucherDigest), bytes32(voucher.paymentId),
            bytes32(voucher.orderRefHash), uint(voucher.grossUnits), uint(voucher.cumulativeGrossUnits),
            bytes32(voucher.receiptCommitment), uint(voucher.acceptedAt), uint(voucher.acceptUntil),
            uint(voucher.submitUntil), uint(voucher.configVersion),
        ))
    }

    fun verifyAttendee(request: TerminalPaymentRequest, response: AttendeeVoucherResponse, expectedSigner: String, nowSeconds: Long): String {
        if (response.requestHash.lowercase() != requestHash(request) || nowSeconds > request.expiresAt)
            throw InvalidOfflineExchange("Attendee response is expired or targets another request")
        val voucher = decodeVoucher(request.voucher)
        val recovered = recover(voucherDigest(voucher), response.attendeeSignature)
        if (!recovered.equals(expectedSigner, ignoreCase = true))
            throw InvalidOfflineExchange("Attendee signature does not match channel authority")
        return response.attendeeSignature.lowercase()
    }

    fun decodeVoucher(value: String): OfflineVoucher {
        val bytes = fromHex(value)
        if (bytes.size != 32 * 15) throw InvalidOfflineExchange("Invalid offline voucher encoding")
        fun slot(i: Int) = bytes.copyOfRange(i * 32, (i + 1) * 32)
        val voucher = OfflineVoucher(
            protocolVersion = BigInteger(1, slot(0)).longValueExact(),
            chainId = BigInteger(1, slot(1)), vault = hex(slot(2).copyOfRange(12, 32)),
            channelId = hex(slot(3)), sequence = BigInteger(1, slot(4)).longValueExact(),
            previousVoucherDigest = hex(slot(5)), paymentId = hex(slot(6)), orderRefHash = hex(slot(7)),
            grossUnits = BigInteger(1, slot(8)), cumulativeGrossUnits = BigInteger(1, slot(9)),
            receiptCommitment = hex(slot(10)), acceptedAt = BigInteger(1, slot(11)).longValueExact(),
            acceptUntil = BigInteger(1, slot(12)).longValueExact(), submitUntil = BigInteger(1, slot(13)).longValueExact(),
            configVersion = BigInteger(1, slot(14)),
        )
        validateVoucher(voucher)
        if (!encodeVoucher(voucher).equals(value, ignoreCase = true))
            throw InvalidOfflineExchange("Noncanonical voucher encoding")
        return voucher
    }

    fun canonicalReceipt(receipt: VoucherReceipt): String {
        if (!receipt.receiptId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$")) ||
            !HEX_32.matches(receipt.terminalId) || !HEX_32.matches(receipt.channelId) ||
            receipt.sequence !in 1 until (1L shl 32) || !HEX_32.matches(receipt.paymentId) ||
            !receipt.voucher.matches(Regex("^0x(?:[0-9a-fA-F]{2})+$")) ||
            !SIGNATURE.matches(receipt.attendeeSignature) || !SIGNATURE.matches(receipt.terminalSignature)
        ) throw InvalidOfflineExchange("Invalid voucher receipt")
        return "{" + listOf(
            "\"receiptId\":${JSONObject.quote(receipt.receiptId)}",
            "\"terminalId\":\"${receipt.terminalId.lowercase()}\"",
            "\"channelId\":\"${receipt.channelId.lowercase()}\"",
            "\"sequence\":${receipt.sequence}",
            "\"paymentId\":\"${receipt.paymentId.lowercase()}\"",
            "\"voucher\":\"${receipt.voucher.lowercase()}\"",
            "\"attendeeSignature\":\"${receipt.attendeeSignature.lowercase()}\"",
            "\"terminalSignature\":\"${receipt.terminalSignature.lowercase()}\"",
        ).joinToString(",") + "}"
    }

    fun receiptPayloadHash(receipt: VoucherReceipt): String = hex(
        MessageDigest.getInstance("SHA-256").digest(canonicalReceipt(receipt).toByteArray(StandardCharsets.UTF_8)),
    )

    fun terminalIngressDigest(
        audience: String,
        terminalId: String,
        keyVersion: BigInteger,
        sentAt: Long,
        nonce: String,
        payloadHash: String,
    ): ByteArray {
        if (audience.isEmpty() || audience.length > 512 || keyVersion <= BigInteger.ZERO || sentAt < 0)
            throw InvalidOfflineExchange("Invalid terminal authorization")
        listOf(terminalId, nonce, payloadHash).forEach(::requireHex32)
        return hashSlots(
            Keccak.digest(TERMINAL_INGRESS_TYPE.toByteArray(StandardCharsets.UTF_8)),
            Keccak.digest(audience.toByteArray(StandardCharsets.UTF_8)),
            bytes32(terminalId),
            uint(keyVersion),
            uint(sentAt),
            bytes32(nonce),
            bytes32(payloadHash),
        )
    }

    private fun canonicalRequest(request: TerminalPaymentRequest): String {
        if (!request.requestId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$")) ||
            !HEX_32.matches(request.terminalId) || !HEX_32.matches(request.channelId) ||
            !HEX_32.matches(request.paymentId) || request.sequence !in 1 until (1L shl 32) ||
            request.expiresAt < 0
        ) throw InvalidOfflineExchange("Invalid terminal payment request")
        val voucher = decodeVoucher(request.voucher)
        if (!voucher.channelId.equals(request.channelId, true) || !voucher.paymentId.equals(request.paymentId, true) ||
            voucher.sequence != request.sequence || request.expiresAt !in voucher.acceptedAt..voucher.acceptUntil
        ) throw InvalidOfflineExchange("Payment request does not match voucher")
        return "{" + listOf(
            "\"version\":1",
            "\"kind\":\"offline-payment-request\"",
            "\"requestId\":${JSONObject.quote(request.requestId)}",
            "\"terminalId\":\"${request.terminalId.lowercase()}\"",
            "\"channelId\":\"${request.channelId.lowercase()}\"",
            "\"paymentId\":\"${request.paymentId.lowercase()}\"",
            "\"sequence\":${request.sequence}",
            "\"voucher\":\"${request.voucher.lowercase()}\"",
            "\"expiresAt\":${request.expiresAt}",
        ).joinToString(",") + "}"
    }

    private fun canonicalOpenRequest(request: OpenPaymentRequest): String {
        if (!request.requestId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$")) ||
            !HEX_32.matches(request.terminalId) || !HEX_32.matches(request.paymentId) ||
            !HEX_32.matches(request.orderRefHash) || !HEX_32.matches(request.receiptCommitment) ||
            request.grossUnits <= BigInteger.ZERO || request.grossUnits.bitLength() > 256 ||
            request.acceptedAt < 0 || request.expiresAt < request.acceptedAt ||
            request.cursors.isEmpty() || request.cursors.size > MAX_REQUEST_CURSORS
        ) throw InvalidOfflineExchange("Invalid terminal payment request")
        var previous = ""
        for (entry in request.cursors) {
            val match = CURSOR.matchEntire(entry) ?: throw InvalidOfflineExchange("Invalid terminal payment request")
            val key = match.groupValues[1]
            if (match.groupValues[2].toLong() >= (1L shl 32) || key <= previous)
                throw InvalidOfflineExchange("Invalid terminal payment request")
            previous = key
        }
        return "{" + listOf(
            "\"version\":2",
            "\"kind\":\"offline-payment-request\"",
            "\"requestId\":${JSONObject.quote(request.requestId)}",
            "\"terminalId\":\"${request.terminalId.lowercase()}\"",
            "\"paymentId\":\"${request.paymentId.lowercase()}\"",
            "\"orderRefHash\":\"${request.orderRefHash.lowercase()}\"",
            "\"receiptCommitment\":\"${request.receiptCommitment.lowercase()}\"",
            "\"grossUnits\":\"${request.grossUnits}\"",
            "\"acceptedAt\":${request.acceptedAt}",
            "\"expiresAt\":${request.expiresAt}",
            "\"cursors\":[" + request.cursors.joinToString(",") { "\"$it\"" } + "]",
        ).joinToString(",") + "}"
    }

    private fun canonicalChannelResponse(response: ChannelVoucherResponse) = "{" + listOf(
        "\"version\":2",
        "\"kind\":\"offline-voucher-response\"",
        "\"requestHash\":\"${response.requestHash.lowercase()}\"",
        "\"channelId\":\"${response.channelId.lowercase()}\"",
        "\"attendeeSignature\":\"${response.attendeeSignature.lowercase()}\"",
    ).joinToString(",") + "}"

    private fun canonicalResponse(response: AttendeeVoucherResponse) = "{" + listOf(
        "\"version\":1",
        "\"kind\":\"offline-voucher-response\"",
        "\"requestHash\":\"${response.requestHash.lowercase()}\"",
        "\"attendeeSignature\":\"${response.attendeeSignature.lowercase()}\"",
    ).joinToString(",") + "}"

    private fun encodeQr(value: String): String {
        val encoded = QR_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray())
        if (encoded.length > MAX_QR_LENGTH) throw InvalidOfflineExchange("QR payload exceeds supported size")
        return encoded
    }

    private fun decodeQr(value: String): JSONObject {
        if (!value.startsWith(QR_PREFIX) || value.length > MAX_QR_LENGTH) throw InvalidOfflineExchange("Invalid QR envelope")
        return try {
            val body = value.removePrefix(QR_PREFIX)
            val decoded = Base64.getUrlDecoder().decode(body)
            if (Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) != body)
                throw InvalidOfflineExchange("Noncanonical QR encoding")
            JSONObject(String(decoded, StandardCharsets.UTF_8))
        } catch (error: Exception) {
            if (error is InvalidOfflineExchange) throw error
            throw InvalidOfflineExchange("Invalid QR encoding")
        }
    }

    private fun recover(digest: ByteArray, signature: String): String {
        val raw = fromHex(signature)
        if (raw.size != 65) throw InvalidOfflineExchange("Invalid signature")
        val data = Sign.SignatureData(raw[64], raw.copyOfRange(0, 32), raw.copyOfRange(32, 64))
        val key = try { Sign.signedMessageHashToKey(digest, data) } catch (_: Exception) {
            throw InvalidOfflineExchange("Invalid signature")
        }
        // An address is the last 20 bytes of keccak256 over the 64-byte public key, not of the key itself.
        return "0x" + Keys.getAddress(key)
    }

    private fun validateVoucher(v: OfflineVoucher) {
        if (v.protocolVersion != 1L || v.chainId <= BigInteger.ZERO || !ADDRESS.matches(v.vault) ||
            !HEX_32.matches(v.channelId) || v.sequence !in 1 until (1L shl 32) ||
            !HEX_32.matches(v.previousVoucherDigest) || !HEX_32.matches(v.paymentId) || !HEX_32.matches(v.orderRefHash) ||
            v.grossUnits <= BigInteger.ZERO || v.cumulativeGrossUnits < v.grossUnits || !HEX_32.matches(v.receiptCommitment) ||
            v.acceptedAt !in 0 until v.acceptUntil || v.acceptUntil >= v.submitUntil || v.configVersion <= BigInteger.ZERO
        ) throw InvalidOfflineExchange("Invalid offline voucher")
    }

    private fun requireSnapshot(v: ChannelSnapshot) {
        listOf(v.channelId, v.terminalId, v.genesisDigest).forEach(::requireHex32)
        if (!ADDRESS.matches(v.vault) || !ADDRESS.matches(v.attendeeSigner) || !ADDRESS.matches(v.terminalSigner) ||
            v.chainId <= BigInteger.ZERO || v.configVersion <= BigInteger.ZERO || v.reserveUnits <= BigInteger.ZERO ||
            v.maxPerVoucher <= BigInteger.ZERO || v.maxPerVoucher > v.reserveUnits || v.maxVoucherCount !in 1 until (1L shl 32) ||
            v.acceptFrom !in 0 until v.acceptUntil || v.acceptUntil >= v.submitUntil
        ) throw InvalidOfflineExchange("Invalid finalized channel snapshot")
    }

    private fun requireHex32(value: String) { if (!HEX_32.matches(value)) throw InvalidOfflineExchange("Invalid bytes32 value") }
    private fun JSONObject.requireString(name: String): String = if (has(name) && get(name) is String) getString(name) else throw InvalidOfflineExchange("Missing $name")
    private fun hashSlots(vararg values: ByteArray): ByteArray = Keccak.digest(concatSlots(*values))
    private fun concatSlots(vararg values: ByteArray): ByteArray = values.fold(ByteArray(0)) { all, value ->
        if (value.size != 32) throw InvalidOfflineExchange("Invalid ABI slot")
        all + value
    }
    private fun uint(value: Long) = uint(BigInteger.valueOf(value))
    private fun uint(value: BigInteger): ByteArray {
        if (value < BigInteger.ZERO || value.bitLength() > 256) throw InvalidOfflineExchange("Invalid uint")
        val raw = value.toByteArray()
        val significant = raw.copyOfRange(maxOf(0, raw.size - 32), raw.size)
        return ByteArray(32).also { significant.copyInto(it, 32 - significant.size) }
    }
    private fun address(value: String): ByteArray = fromHex(value).let { if (it.size != 20) throw InvalidOfflineExchange("Invalid address") else ByteArray(12) + it }
    private fun bytes32(value: String): ByteArray = fromHex(value).also { if (it.size != 32) throw InvalidOfflineExchange("Invalid bytes32") }
    private fun fromHex(value: String): ByteArray {
        val clean = value.removePrefix("0x")
        if (clean.length % 2 != 0 || !clean.matches(Regex("^[0-9a-fA-F]+$"))) throw InvalidOfflineExchange("Invalid hex")
        return ByteArray(clean.length / 2) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
    private fun hex(value: ByteArray) = "0x" + value.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
