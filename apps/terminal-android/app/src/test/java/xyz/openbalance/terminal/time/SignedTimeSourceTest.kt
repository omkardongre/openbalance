package xyz.openbalance.terminal.time

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class SignedTimeSourceTest {
    private val privateKey = Ed25519PrivateKeyParameters(SecureRandom())
    private val publicKey = privateKey.generatePublicKey()
    private val nonce = "ab".repeat(32)

    private fun proof(unixMs: Long = 1_760_000_000_000L, uncertaintyMs: Long = 200L): TimeProof {
        val payload = ("{\"domain\":\"openbalance:terminal-time:v1\",\"nonce\":\"$nonce\"," +
            "\"unixMs\":$unixMs,\"uncertaintyMs\":$uncertaintyMs}").toByteArray()
        val signature = Ed25519Signer().run { init(true, privateKey); update(payload, 0, payload.size); generateSignature() }
        return TimeProof(nonce, unixMs, uncertaintyMs, signature.joinToString("") { "%02x".format(it) }, 300L)
    }

    @Test
    fun savedProofVerifiesAgainAndRebuildsTheSameWindow() {
        val sample = SignedTimeSource.fromProof(publicKey, proof(), 5_000L, "7", 5_000L)
        assertEquals(1_760_000_000_000L - 200L, sample.earliestUnixMs)
        assertEquals(1_760_000_000_000L + 200L + 300L, sample.latestUnixMs)
        val restored = SignedTimeSource.fromProof(publicKey, sample.proof, sample.observedMonotonicMs, sample.bootId, 5_000L)
        assertEquals(sample, restored)
    }

    @Test
    fun editedTimeIsRejected() {
        val forged = proof().copy(unixMs = 1_800_000_000_000L)
        assertThrows(IllegalStateException::class.java) {
            SignedTimeSource.fromProof(publicKey, forged, 5_000L, "7", 5_000L)
        }
    }

    @Test
    fun windowCountsForwardWidensForDriftAndExpires() {
        val sample = SignedTimeSource.fromProof(publicKey, proof(), 5_000L, "7", 5_000L)
        val eightHours = 8 * 60 * 60 * 1_000L
        val (earliest, latest) = SignedTimeSource.window(sample, 5_000L + eightHours)
        assertEquals(sample.earliestUnixMs + eightHours - eightHours / 1_000, earliest)
        assertEquals(sample.latestUnixMs + eightHours + eightHours / 1_000, latest)
        assertTrue(latest - earliest < 60_000L)
        assertThrows(IllegalStateException::class.java) {
            SignedTimeSource.window(sample, 5_000L + SignedTimeSource.MAX_SAMPLE_AGE_MS + 1)
        }
        assertThrows(IllegalStateException::class.java) { SignedTimeSource.window(sample, 4_999L) }
    }
}
