package xyz.openbalance.terminal.provisioning

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import xyz.openbalance.terminal.security.EncryptedJournalPayloads
import java.net.URL

data class ProvisioningConfig(
    val apiEndpoint: String,
    val rpcEndpoint: String,
    val relayEndpoint: String,
    val accessToken: String,
)

class ProvisioningStore(context: Context) {
    private val preferences = context.getSharedPreferences("terminal-provisioning-v2", Context.MODE_PRIVATE)
    private val payloads = EncryptedJournalPayloads()
    private val aad = "openbalance:terminal-provisioning:v2".toByteArray()

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
        require(value.startsWith("obterm2:") && value.length <= 4_096) { "Invalid terminal enrollment QR" }
        val bytes = Base64.decode(
            value.removePrefix("obterm2:"),
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
                // A new enrollment may belong to another vendor; its profile arrives on the next sync.
                .remove("vendorNonce")
                .remove("vendorCiphertext")
                .commit(),
        ) { "Terminal enrollment was not durably stored" }
        return config
    }

    /** The vendor display from the last successful sync, kept so keypad sales work offline. */
    fun vendor(): VendorProfile? {
        val nonce = preferences.getString("vendorNonce", null) ?: return null
        val ciphertext = preferences.getString("vendorCiphertext", null) ?: return null
        val json = JSONObject(
            String(payloads.open(Base64.decode(nonce, Base64.NO_WRAP), Base64.decode(ciphertext, Base64.NO_WRAP), vendorAad)),
        )
        return VendorProfile(json.getString("vendorName"), json.getString("assetSymbol"), json.getInt("assetDecimals"))
    }

    fun saveVendor(value: VendorProfile) {
        val json = JSONObject()
            .put("vendorName", value.vendorName)
            .put("assetSymbol", value.assetSymbol)
            .put("assetDecimals", value.assetDecimals)
            .toString()
        val sealed = payloads.seal(json.toByteArray(), vendorAad)
        check(
            preferences.edit()
                .putString("vendorNonce", Base64.encodeToString(sealed.first, Base64.NO_WRAP))
                .putString("vendorCiphertext", Base64.encodeToString(sealed.second, Base64.NO_WRAP))
                .commit(),
        ) { "Vendor profile was not durably stored" }
    }

    private val vendorAad = "openbalance:terminal-vendor:v1".toByteArray()

    private fun decode(value: String): ProvisioningConfig {
        val json = JSONObject(value)
        require(json.length() == 5 && json.getInt("schemaVersion") == 2) { "Unsupported terminal enrollment" }
        return ProvisioningConfig(
            apiEndpoint = endpoint(json.getString("apiEndpoint")),
            rpcEndpoint = endpoint(json.getString("rpcEndpoint")),
            relayEndpoint = relayEndpoint(json.getString("relayEndpoint")),
            accessToken = json.getString("accessToken").also {
                require(it.matches(Regex("^[A-Za-z0-9_-]{43}$"))) { "Invalid terminal credential" }
            },
        )
    }

    private fun encode(value: ProvisioningConfig) = JSONObject().apply {
        put("schemaVersion", 2)
        put("apiEndpoint", value.apiEndpoint)
        put("rpcEndpoint", value.rpcEndpoint)
        put("relayEndpoint", value.relayEndpoint)
        put("accessToken", value.accessToken)
    }.toString()

    private fun endpoint(value: String): String {
        val url = URL(value)
        require(url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null) {
            "Provisioning endpoints must use HTTPS without embedded credentials"
        }
        return value.trimEnd('/')
    }

    private fun relayEndpoint(value: String): String {
        val normalized = endpoint(value)
        require(URL(normalized).path == "/v1/vouchers") {
            "Relay endpoint must target the authenticated voucher ingress"
        }
        return normalized
    }
}
