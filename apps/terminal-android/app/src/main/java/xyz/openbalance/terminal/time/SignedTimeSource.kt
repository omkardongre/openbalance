package xyz.openbalance.terminal.time

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom
import javax.net.ssl.HttpsURLConnection

/** The server's signed answer, kept so a saved sample can be re-verified after the app restarts. */
data class TimeProof(
    val nonce: String,
    val unixMs: Long,
    val uncertaintyMs: Long,
    val signature: String,
    /** How long the request took on the monotonic clock; widens the latest bound. */
    val roundTripMs: Long,
)

data class TrustedTime(
    val earliestUnixMs: Long,
    val latestUnixMs: Long,
    val observedMonotonicMs: Long,
    val bootId: String,
    val proof: TimeProof,
)

class SignedTimeSource(
    private val context: Context,
    endpoint: String,
    publicKeyDerBase64: String,
    private val timeoutMs: Int = 5_000,
) {
    private val url = URL(endpoint)
    // Verified with the bundled BouncyCastle rather than the platform JCA: platform Ed25519 support
    // varies by Android release, and a terminal must not lose trusted time on an older OS.
    private val publicKey = ed25519PublicKey(Base64.decode(publicKeyDerBase64, Base64.DEFAULT))

    init {
        require(url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null)
        require(timeoutMs in 1..30_000)
    }

    fun sample(): TrustedTime {
        val nonce = ByteArray(32).also(SecureRandom()::nextBytes).toHex()
        val before = monotonic()
        val connection = (url.openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"; instanceFollowRedirects = false
            connectTimeout = timeoutMs; readTimeout = timeoutMs; doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
        connection.outputStream.use { it.write(JSONObject().put("nonce", nonce).toString().toByteArray()) }
        if (connection.responseCode != HttpURLConnection.HTTP_OK ||
            connection.contentType?.startsWith("application/json") != true
        ) throw IllegalStateException("Time authority unavailable")
        val body = connection.inputStream.use { input ->
            val output = ByteArrayOutputStream()
            val chunk = ByteArray(512)
            while (output.size() <= 2_048) {
                val count = input.read(chunk)
                if (count < 0) break
                output.write(chunk, 0, count)
            }
            val bytes = output.toByteArray()
            if (bytes.size > 2_048) throw IllegalStateException("Time response exceeds limit")
            String(bytes)
        }
        val after = monotonic()
        val data = JSONObject(body)
        if (data.length() != 4 || data.getString("nonce") != nonce) throw IllegalStateException("Time attestation mismatch")
        if (before.second != after.second) throw IllegalStateException("Invalid time attestation")
        val elapsed = after.first - before.first
        if (elapsed !in 0..timeoutMs.toLong()) throw IllegalStateException("Time request lost clock continuity")
        val proof = TimeProof(nonce, data.getLong("unixMs"), data.getLong("uncertaintyMs"), data.getString("signature"), elapsed)
        return fromProof(publicKey, proof, after.first, after.second, timeoutMs.toLong())
    }

    /**
     * Rebuilds a saved sample after the app was closed. The server signature is checked again, and
     * the sample is only usable on the same boot and within [MAX_SAMPLE_AGE_MS]: the monotonic clock
     * it counts forward on cannot be changed by the cashier, but it restarts with the phone.
     */
    fun restore(saved: TrustedTime): TrustedTime {
        val rebuilt = fromProof(publicKey, saved.proof, saved.observedMonotonicMs, saved.bootId, timeoutMs.toLong())
        current(rebuilt)
        return rebuilt
    }

    fun current(sample: TrustedTime): Pair<Long, Long> {
        val current = monotonic()
        if (current.second != sample.bootId) throw IllegalStateException("Trusted time continuity lost")
        return window(sample, current.first)
    }

    companion object {
        /**
         * How long a sample may be carried forward on the monotonic clock before it must be
         * refreshed: long enough to sell through a whole outage, since [window] widens the bounds
         * for clock drift as it ages.
         */
        const val MAX_SAMPLE_AGE_MS = 12 * 60 * 60 * 1_000L

        /**
         * Allowed monotonic-clock drift: 1 ms per elapsed second (1000 ppm), far above the tens of
         * ppm a phone's crystal drifts, so the true time always stays inside the bounds.
         */
        private const val DRIFT_DIVISOR = 1_000L

        /** Verifies the server's signature and turns the proof into a time window. */
        internal fun fromProof(
            key: Ed25519PublicKeyParameters,
            proof: TimeProof,
            observedMonotonicMs: Long,
            bootId: String,
            maxRoundTripMs: Long,
        ): TrustedTime {
            if (!proof.nonce.matches(Regex("^[a-f0-9]{64}$")) || !proof.signature.matches(Regex("^[a-f0-9]{128}$")) ||
                proof.uncertaintyMs !in 0..5_000 || proof.unixMs < proof.uncertaintyMs ||
                proof.roundTripMs !in 0..maxRoundTripMs || observedMonotonicMs < 0
            ) throw IllegalStateException("Invalid time attestation")
            val payload = ("{\"domain\":\"openbalance:terminal-time:v1\",\"nonce\":\"${proof.nonce}\"," +
                "\"unixMs\":${proof.unixMs},\"uncertaintyMs\":${proof.uncertaintyMs}}").toByteArray()
            val valid = Ed25519Signer().run {
                init(false, key); update(payload, 0, payload.size); verifySignature(proof.signature.hexBytes())
            }
            if (!valid) throw IllegalStateException("Time attestation signature rejected")
            return TrustedTime(
                proof.unixMs - proof.uncertaintyMs,
                Math.addExact(Math.addExact(proof.unixMs, proof.uncertaintyMs), proof.roundTripMs),
                observedMonotonicMs, bootId, proof,
            )
        }

        /** The sample counted forward to [nowMonotonicMs], widened for drift. Throws once too old. */
        internal fun window(sample: TrustedTime, nowMonotonicMs: Long): Pair<Long, Long> {
            if (nowMonotonicMs < sample.observedMonotonicMs) throw IllegalStateException("Trusted time continuity lost")
            val elapsed = nowMonotonicMs - sample.observedMonotonicMs
            check(elapsed <= MAX_SAMPLE_AGE_MS) { "Trusted time sample is stale; refresh while connected" }
            val drift = (elapsed + DRIFT_DIVISOR - 1) / DRIFT_DIVISOR
            return Math.subtractExact(Math.addExact(sample.earliestUnixMs, elapsed), drift) to
                Math.addExact(Math.addExact(sample.latestUnixMs, elapsed), drift)
        }

        private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
        private fun String.hexBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    private fun monotonic(): Pair<Long, String> {
        val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        check(boot >= 0) { "Device boot continuity is unavailable" }
        return SystemClock.elapsedRealtime() to boot.toString()
    }
}

/** Ed25519 SubjectPublicKeyInfo is a fixed 12-byte header followed by the 32-byte key. */
private val ED25519_SPKI_PREFIX = byteArrayOf(
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
)

internal fun ed25519PublicKey(spki: ByteArray): Ed25519PublicKeyParameters {
    require(spki.size == 44 && spki.copyOfRange(0, 12).contentEquals(ED25519_SPKI_PREFIX)) {
        "Time authority key is not an Ed25519 public key"
    }
    return Ed25519PublicKeyParameters(spki, 12)
}
