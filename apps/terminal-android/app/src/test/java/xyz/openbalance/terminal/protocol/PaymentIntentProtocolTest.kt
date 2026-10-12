package xyz.openbalance.terminal.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.web3j.crypto.ECKeyPair
import org.web3j.crypto.Keys
import org.web3j.crypto.Sign
import java.math.BigInteger

/** Vectors produced by `@openbalance/protocol` (packages/protocol/src/payments.ts). */
class PaymentIntentProtocolTest {
    private val encoded =
        "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000279f00000000000000000000000044444444444444444444444444444444444444441111111111111111111111111111111111111111111111111111111111111111e5bf45ded2231996425a183968921d1a0f2b594d27b704f0d40a236cfe4bc7050000000000000000000000003333333333333333333333333333333333333333afb88035be9373cb52a3c9ea83465da7c557322a5a5b82dc82b730a709b704562222222222222222222222222222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000355555555555555555555555555555555555555555555555555555555555555550000000000000000000000006666666666666666666666666666666666666666000000000000000000000000000000000000000000000000000000000007a12000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000002eff46d1a690e1dd32a44bfb86800b8a1659d421771d0ec7f2cc3027070717272000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000006b49d4580000000000000000000000000000000000000000000000000000000000000001"
    private val digest = "0x59881a6d133f6e1f975bd1e0b652a683371ed31934b06087984b0e58077eb0f9"
    private val paymentId = "0xe5bf45ded2231996425a183968921d1a0f2b594d27b704f0d40a236cfe4bc705"
    private val orderRefHash = "0xafb88035be9373cb52a3c9ea83465da7c557322a5a5b82dc82b730a709b70456"
    private val receiptCommitment = "0xeff46d1a690e1dd32a44bfb86800b8a1659d421771d0ec7f2cc3027070717272"
    private val now = 1_800_000_100L

    private val expected = PaymentIntentProtocol.Expectation(
        chainId = BigInteger.valueOf(10_143),
        router = "0x4444444444444444444444444444444444444444",
        eventId = "0x" + "11".repeat(32),
        asset = "0x6666666666666666666666666666666666666666",
        terminalInstanceId = "0x" + "55".repeat(32),
        terminalKeyVersion = BigInteger.ONE,
        grossUnits = BigInteger.valueOf(500_000),
        orderRefHash = orderRefHash,
        receiptCommitment = receiptCommitment,
    )

    @Test
    fun decodesTheProtocolEncoding() {
        val intent = PaymentIntentProtocol.decode(encoded)
        assertEquals(1L, intent.schemaVersion)
        assertEquals(BigInteger.valueOf(10_143), intent.chainId)
        assertEquals("0x4444444444444444444444444444444444444444", intent.router)
        assertEquals("0x3333333333333333333333333333333333333333", intent.payerAccount)
        assertEquals("0x" + "22".repeat(32), intent.vendorId)
        assertEquals(BigInteger.valueOf(500_000), intent.grossUnits)
        assertEquals(200, intent.organizerFeeBps)
        assertEquals(100, intent.platformFeeBps)
        assertEquals(1_800_000_000L, intent.validAfter)
        assertEquals(1_800_000_600L, intent.expiresAt)
        assertEquals(paymentId, intent.paymentId)
    }

    @Test
    fun digestMatchesTheProtocol() {
        val actual = PaymentIntentProtocol.digest(PaymentIntentProtocol.decode(encoded))
        assertEquals(digest, OfflineProtocol.hex(actual))
    }

    @Test
    fun paymentIdMatchesTheServerDerivation() {
        assertEquals(paymentId, PaymentIntentProtocol.paymentId(PaymentIntentProtocol.decode(encoded), BigInteger.ONE))
    }

    @Test
    fun acceptsTheIntentItAskedFor() {
        PaymentIntentProtocol.verifyForSigning(PaymentIntentProtocol.decode(encoded), expected, BigInteger.ONE, now)
    }

    @Test
    fun refusesAnyChangedField() {
        val intent = PaymentIntentProtocol.decode(encoded)
        val other = "0x" + "99".repeat(32)
        val cases = listOf(
            "amount" to expected.copy(grossUnits = BigInteger.valueOf(500_001)),
            "terminal" to expected.copy(terminalInstanceId = other),
            "key version" to expected.copy(terminalKeyVersion = BigInteger.TWO),
            "router" to expected.copy(router = "0x" + "99".repeat(20)),
            "currency" to expected.copy(asset = "0x" + "99".repeat(20)),
            "network" to expected.copy(chainId = BigInteger.ONE),
            "event" to expected.copy(eventId = other),
            "order" to expected.copy(orderRefHash = other),
            "receipt" to expected.copy(receiptCommitment = other),
        )
        for ((name, wrong) in cases) {
            assertThrows(name, InvalidOfflineExchange::class.java) {
                PaymentIntentProtocol.verifyForSigning(intent, wrong, BigInteger.ONE, now)
            }
        }
        // A wrong order version changes the derived payment id.
        assertThrows(InvalidOfflineExchange::class.java) {
            PaymentIntentProtocol.verifyForSigning(intent, expected, BigInteger.TWO, now)
        }
        // Expired, and valid only in the far future.
        assertThrows(InvalidOfflineExchange::class.java) {
            PaymentIntentProtocol.verifyForSigning(intent, expected, BigInteger.ONE, 1_800_000_600L)
        }
        assertThrows(InvalidOfflineExchange::class.java) {
            PaymentIntentProtocol.verifyForSigning(intent, expected, BigInteger.ONE, 1_799_999_000L)
        }
    }

    @Test
    fun rejectsMalformedEncodings() {
        assertThrows(InvalidOfflineExchange::class.java) { PaymentIntentProtocol.decode(encoded.dropLast(2)) }
        assertThrows(InvalidOfflineExchange::class.java) { PaymentIntentProtocol.decode("0x") }
        // An address word with dirty upper bytes.
        val dirty = "0x" + encoded.removePrefix("0x").let { it.substring(0, 64 * 2 + 2) + "ff" + it.substring(64 * 2 + 4) }
        assertThrows(InvalidOfflineExchange::class.java) { PaymentIntentProtocol.decode(dirty) }
    }

    @Test
    fun terminalSignatureRecoversToTheTerminalKey() {
        val pair = ECKeyPair.create(BigInteger("1b".repeat(32), 16))
        val hash = PaymentIntentProtocol.digest(PaymentIntentProtocol.decode(encoded))
        val signature = Sign.signMessage(hash, pair, false)
        val recovered = Sign.signedMessageHashToKey(hash, signature)
        assertEquals(pair.publicKey, recovered)
        assertTrue(Keys.getAddress(recovered).isNotEmpty())
        // The server expects r || s || v with v in {27, 28}.
        assertTrue(signature.v.first().toInt() in 27..28)
    }
}
