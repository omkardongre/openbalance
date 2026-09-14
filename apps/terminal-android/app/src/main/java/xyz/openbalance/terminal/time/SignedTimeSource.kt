package xyz.openbalance.terminal.time

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import javax.net.ssl.HttpsURLConnection

data class TrustedTime(val earliestUnixMs: Long, val latestUnixMs: Long, val observedMonotonicMs: Long, val bootId: String)

class SignedTimeSource(
    private val context: Context,
    endpoint: String,
    publicKeyDerBase64: String,
    private val timeoutMs: Int = 5_000,
) {
    private val url = URL(endpoint)
    private val publicKey = KeyFactory.getInstance("Ed25519").generatePublic(
        X509EncodedKeySpec(Base64.decode(publicKeyDerBase64, Base64.DEFAULT)),
    )

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
        val unixMs = data.getLong("unixMs")
        val uncertaintyMs = data.getLong("uncertaintyMs")
        val signature = data.getString("signature")
        if (!signature.matches(Regex("^[a-f0-9]{128}$")) || uncertaintyMs < 0 || unixMs < 0 || before.second != after.second)
            throw IllegalStateException("Invalid time attestation")
        require(uncertaintyMs <= 5_000 && unixMs >= uncertaintyMs)
        val payload = "{\"domain\":\"openbalance:terminal-time:v1\",\"nonce\":\"$nonce\",\"unixMs\":$unixMs,\"uncertaintyMs\":$uncertaintyMs}".toByteArray()
        val valid = Signature.getInstance("Ed25519").run {
            initVerify(publicKey); update(payload); verify(signature.hexBytes())
        }
        if (!valid) throw IllegalStateException("Time attestation signature rejected")
        val elapsed = after.first - before.first
        if (elapsed !in 0..timeoutMs.toLong()) throw IllegalStateException("Time request lost clock continuity")
        return TrustedTime(unixMs - uncertaintyMs, Math.addExact(Math.addExact(unixMs, uncertaintyMs), elapsed), after.first, after.second)
    }

    fun current(sample: TrustedTime): Pair<Long, Long> {
        val current = monotonic()
        if (current.second != sample.bootId || current.first < sample.observedMonotonicMs)
            throw IllegalStateException("Trusted time continuity lost")
        val elapsed = current.first - sample.observedMonotonicMs
        check(elapsed <= 300_000) { "Trusted time sample is stale; refresh while connected" }
        val drift = (elapsed + 999) / 1_000
        return Math.subtractExact(Math.addExact(sample.earliestUnixMs, elapsed), drift) to
            Math.addExact(Math.addExact(sample.latestUnixMs, elapsed), drift)
    }

    private fun monotonic(): Pair<Long, String> {
        val boot = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        check(boot >= 0) { "Device boot continuity is unavailable" }
        return SystemClock.elapsedRealtime() to boot.toString()
    }
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun String.hexBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
