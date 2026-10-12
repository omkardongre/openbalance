package xyz.openbalance.terminal.protocol

import xyz.openbalance.terminal.security.Keccak
import java.math.BigInteger

private const val INTENT_TYPE =
    "PaymentIntent(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)"
private const val DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
private const val WORDS = 19

/**
 * The online payment a customer is about to make, as the server built it when the customer scanned
 * the stall's code. Kotlin port of `PaymentIntent` in `@openbalance/protocol` (payments.ts).
 */
data class PaymentIntent(
    val schemaVersion: Long,
    val chainId: BigInteger,
    val router: String,
    val eventId: String,
    val paymentId: String,
    val payerAccount: String,
    val orderRefHash: String,
    val vendorId: String,
    val vendorDestinationVersion: BigInteger,
    val terminalInstanceId: String,
    val asset: String,
    val grossUnits: BigInteger,
    val organizerFeeBps: Int,
    val platformFeeBps: Int,
    val configVersion: BigInteger,
    val receiptCommitment: String,
    val validAfter: Long,
    val expiresAt: Long,
    val terminalKeyVersion: BigInteger,
)

/**
 * Online payments are authorized by the stall terminal signing the EIP-712 digest of the exact
 * intent. The server builds the intent, so the phone decodes it and checks every field it can know
 * on its own before signing: a server (or anyone in between) cannot get a signature for a
 * different amount, stall, receipt or terminal than the cashier typed.
 */
object PaymentIntentProtocol {
    /** What this terminal expects the intent for one of its own orders to say. */
    data class Expectation(
        val chainId: BigInteger,
        val router: String,
        val eventId: String,
        val asset: String,
        val terminalInstanceId: String,
        val terminalKeyVersion: BigInteger,
        val grossUnits: BigInteger,
        val orderRefHash: String,
        val receiptCommitment: String,
    )

    /** The static ABI encoding of the intent tuple: 19 words, no offsets. */
    fun decode(encoded: String): PaymentIntent {
        val bytes = OfflineProtocol.fromHex(encoded)
        if (bytes.size != WORDS * 32) throw InvalidOfflineExchange("Invalid payment intent encoding")
        fun word(index: Int) = bytes.copyOfRange(index * 32, (index + 1) * 32)
        fun number(index: Int, bits: Int): BigInteger {
            val value = BigInteger(1, word(index))
            if (value.bitLength() > bits) throw InvalidOfflineExchange("Invalid payment intent encoding")
            return value
        }
        fun address(index: Int): String {
            val raw = word(index)
            if (raw.copyOfRange(0, 12).any { it != 0.toByte() }) throw InvalidOfflineExchange("Invalid payment intent encoding")
            return OfflineProtocol.hex(raw.copyOfRange(12, 32))
        }
        fun bytes32(index: Int) = OfflineProtocol.hex(word(index))
        return PaymentIntent(
            schemaVersion = number(0, 32).toLong(),
            chainId = number(1, 256),
            router = address(2),
            eventId = bytes32(3),
            paymentId = bytes32(4),
            payerAccount = address(5),
            orderRefHash = bytes32(6),
            vendorId = bytes32(7),
            vendorDestinationVersion = number(8, 256),
            terminalInstanceId = bytes32(9),
            asset = address(10),
            grossUnits = number(11, 256),
            organizerFeeBps = number(12, 16).toInt(),
            platformFeeBps = number(13, 16).toInt(),
            configVersion = number(14, 256),
            receiptCommitment = bytes32(15),
            validAfter = number(16, 48).toLong(),
            expiresAt = number(17, 48).toLong(),
            terminalKeyVersion = number(18, 256),
        )
    }

    /** `paymentIntentDigest`: the EIP-712 hash the terminal signs and the router verifies. */
    fun digest(intent: PaymentIntent): ByteArray {
        val domain = OfflineProtocol.hashSlots(
            Keccak.digest(DOMAIN_TYPE.toByteArray()),
            Keccak.digest("OpenBalanceExactPay".toByteArray()),
            Keccak.digest("1".toByteArray()),
            OfflineProtocol.uint(intent.chainId),
            OfflineProtocol.address(intent.router),
        )
        val struct = OfflineProtocol.hashSlots(
            Keccak.digest(INTENT_TYPE.toByteArray()),
            OfflineProtocol.uint(intent.schemaVersion), OfflineProtocol.uint(intent.chainId),
            OfflineProtocol.address(intent.router), OfflineProtocol.bytes32(intent.eventId),
            OfflineProtocol.bytes32(intent.paymentId), OfflineProtocol.address(intent.payerAccount),
            OfflineProtocol.bytes32(intent.orderRefHash), OfflineProtocol.bytes32(intent.vendorId),
            OfflineProtocol.uint(intent.vendorDestinationVersion), OfflineProtocol.bytes32(intent.terminalInstanceId),
            OfflineProtocol.address(intent.asset), OfflineProtocol.uint(intent.grossUnits),
            OfflineProtocol.uint(intent.organizerFeeBps.toLong()), OfflineProtocol.uint(intent.platformFeeBps.toLong()),
            OfflineProtocol.uint(intent.configVersion), OfflineProtocol.bytes32(intent.receiptCommitment),
            OfflineProtocol.uint(intent.validAfter), OfflineProtocol.uint(intent.expiresAt),
            OfflineProtocol.uint(intent.terminalKeyVersion),
        )
        return Keccak.digest(byteArrayOf(0x19, 0x01) + domain + struct)
    }

    /** The payment id the server derives at bind time: keccak256(abi.encode(event, vendor, order, payer, version)). */
    fun paymentId(intent: PaymentIntent, orderVersion: BigInteger): String = OfflineProtocol.hex(
        Keccak.digest(
            OfflineProtocol.concatSlots(
                OfflineProtocol.bytes32(intent.eventId), OfflineProtocol.bytes32(intent.vendorId),
                OfflineProtocol.bytes32(intent.orderRefHash), OfflineProtocol.address(intent.payerAccount),
                OfflineProtocol.uint(orderVersion),
            ),
        ),
    )

    /**
     * Throws unless the intent is exactly the payment this terminal asked for. The vendor id, fees
     * and destination version cannot be known here; the router checks them against the on-chain
     * registry, and the terminal instance and key version it does know are pinned below.
     */
    fun verifyForSigning(intent: PaymentIntent, expected: Expectation, orderVersion: BigInteger, nowSeconds: Long) {
        fun same(a: String, b: String) = a.equals(b, ignoreCase = true)
        val problem = when {
            intent.schemaVersion != 1L -> "unsupported version"
            intent.chainId != expected.chainId -> "another network"
            !same(intent.router, expected.router) -> "another payment contract"
            !same(intent.eventId, expected.eventId) -> "another event"
            !same(intent.asset, expected.asset) -> "another currency"
            !same(intent.terminalInstanceId, expected.terminalInstanceId) -> "another terminal"
            intent.terminalKeyVersion != expected.terminalKeyVersion -> "another terminal key"
            intent.grossUnits != expected.grossUnits -> "another amount"
            !same(intent.orderRefHash, expected.orderRefHash) -> "another order"
            !same(intent.receiptCommitment, expected.receiptCommitment) -> "another receipt"
            !same(intent.paymentId, paymentId(intent, orderVersion)) -> "an unexpected payment id"
            intent.organizerFeeBps + intent.platformFeeBps > 10_000 -> "invalid fees"
            intent.expiresAt <= nowSeconds -> "already expired"
            intent.validAfter > nowSeconds + MAX_CLOCK_SKEW_SECONDS -> "not yet valid"
            intent.expiresAt - intent.validAfter > MAX_INTENT_SECONDS -> "too long a window"
            else -> null
        }
        if (problem != null) throw InvalidOfflineExchange("The payment request was changed ($problem)")
    }

    private const val MAX_CLOCK_SKEW_SECONDS = 300L
    private const val MAX_INTENT_SECONDS = 3_600L
}
