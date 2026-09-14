package xyz.openbalance.terminal.provisioning

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import xyz.openbalance.terminal.security.EncryptedJournalPayloads
import java.net.URL

data class ProvisioningConfig(val apiEndpoint: String, val rpcEndpoint: String, val accessToken: String)

class ProvisioningStore(context: Context) {
    private val preferences = context.getSharedPreferences("terminal-provisioning-v1", Context.MODE_PRIVATE)
    private val payloads = EncryptedJournalPayloads()
    private val aad = "openbalance:terminal-provisioning:v1".toByteArray()

    fun current(): ProvisioningConfig? {
        val nonce = preferences.getString("nonce", null) ?: return null
        val ciphertext = preferences.getString("ciphertext", null) ?: return null
        return decode(
            String(
                payloads.open(
                    Base64.decode(nonce, Base64.NO_WRAP),
                    Base64.decode(ciphertext, Base64.NO_WRAP),
                    aad,
                ),
            ),
        )
    }

    fun installQr(value: String): ProvisioningConfig {
        require(value.startsWith("obterm1:") && value.length <= 4_096) { "Invalid terminal enrollment QR" }
        val bytes = Base64.decode(
            value.removePrefix("obterm1:"),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        require(bytes.size <= 2_048) { "Terminal enrollment payload exceeds limit" }
        val config = decode(String(bytes))
        val canonical = encode(config)
        require(canonical == String(bytes)) { "Terminal enrollment payload is not canonical" }
        val sealed = payloads.seal(canonical.toByteArray(), aad)
        check(
            preferences.edit()
                .putString("nonce", Base64.encodeToString(sealed.first, Base64.NO_WRAP))
                .putString("ciphertext", Base64.encodeToString(sealed.second, Base64.NO_WRAP))
                .commit(),
        ) { "Terminal enrollment was not durably stored" }
        return config
    }

    private fun decode(value: String): ProvisioningConfig {
        val json = JSONObject(value)
        require(json.length() == 4 && json.getInt("schemaVersion") == 1) { "Unsupported terminal enrollment" }
        return ProvisioningConfig(
            apiEndpoint = endpoint(json.getString("apiEndpoint")),
            rpcEndpoint = endpoint(json.getString("rpcEndpoint")),
            accessToken = json.getString("accessToken").also {
                require(it.matches(Regex("^[A-Za-z0-9_-]{43}$"))) { "Invalid terminal credential" }
            },
        )
    }

    private fun encode(value: ProvisioningConfig) = JSONObject().apply {
        put("schemaVersion", 1)
        put("apiEndpoint", value.apiEndpoint)
        put("rpcEndpoint", value.rpcEndpoint)
        put("accessToken", value.accessToken)
    }.toString()

    private fun endpoint(value: String): String {
        val url = URL(value)
        require(url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null) {
            "Provisioning endpoints must use HTTPS without embedded credentials"
        }
        return value.trimEnd('/')
    }
}
