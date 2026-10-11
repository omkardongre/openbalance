package xyz.openbalance.terminal.time

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import xyz.openbalance.terminal.security.EncryptedJournalPayloads

/**
 * Keeps the last signed time sample across app restarts, so closing the app offline does not stop
 * sales. Sealed with the hardware-backed journal key: the server signature covers the time itself,
 * and the seal covers the monotonic reading and boot it was taken on, which a cashier must not edit.
 */
class TrustedTimeStore(context: Context) {
    private val preferences = context.getSharedPreferences("terminal-time-v1", Context.MODE_PRIVATE)
    private val payloads = EncryptedJournalPayloads()
    private val aad = "openbalance:terminal-time-sample:v1".toByteArray()

    fun load(): TrustedTime? {
        val nonce = preferences.getString("nonce", null) ?: return null
        val ciphertext = preferences.getString("ciphertext", null) ?: return null
        val json = JSONObject(
            String(payloads.open(Base64.decode(nonce, Base64.NO_WRAP), Base64.decode(ciphertext, Base64.NO_WRAP), aad)),
        )
        val proof = json.getJSONObject("proof").let {
            TimeProof(it.getString("nonce"), it.getLong("unixMs"), it.getLong("uncertaintyMs"), it.getString("signature"), it.getLong("roundTripMs"))
        }
        return TrustedTime(json.getLong("earliestUnixMs"), json.getLong("latestUnixMs"), json.getLong("observedMonotonicMs"), json.getString("bootId"), proof)
    }

    fun save(sample: TrustedTime) {
        val json = JSONObject()
            .put("earliestUnixMs", sample.earliestUnixMs).put("latestUnixMs", sample.latestUnixMs)
            .put("observedMonotonicMs", sample.observedMonotonicMs).put("bootId", sample.bootId)
            .put(
                "proof",
                JSONObject().put("nonce", sample.proof.nonce).put("unixMs", sample.proof.unixMs)
                    .put("uncertaintyMs", sample.proof.uncertaintyMs).put("signature", sample.proof.signature)
                    .put("roundTripMs", sample.proof.roundTripMs),
            )
        val sealed = payloads.seal(json.toString().toByteArray(), aad)
        preferences.edit()
            .putString("nonce", Base64.encodeToString(sealed.first, Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(sealed.second, Base64.NO_WRAP))
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }
}
