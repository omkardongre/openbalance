package xyz.openbalance.terminal.checkout

import org.json.JSONObject
import xyz.openbalance.terminal.provisioning.ProvisioningConfig
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

/** Why an online checkout call did not work, so the caller can tell "try offline" from "stop". */
class OnlineCheckoutException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind {
        /** The server could not be reached or answered with a server error: an offline sale may still work. */
        UNREACHABLE,
        /** This terminal's access was refused (revoked or expired credential). */
        DENIED,
        /** The order is gone or expired. */
        GONE,
        /** The server refused this request for good (conflict, validation). */
        REFUSED,
    }
}

/** An order the terminal just opened for a customer to scan. */
data class OnlineOrder(val orderId: String, val checkoutUrl: String, val expiresAt: Long)

/** How the server says a stall's order stands. */
data class CashierOrder(
    /** CREATED (nobody scanned yet), BOUND (a customer signed in), READY (this terminal signed). */
    val state: String,
    val checkoutUrl: String?,
    val expiresAt: Long,
    val paymentId: String?,
    val encodedIntent: String?,
    val intentDigest: String?,
    val settlement: Settlement?,
)

data class Settlement(val status: String, val transactionHash: String?)

/**
 * The stall's side of an online (one-scan) payment. The terminal opens an order, shows the link as
 * a QR, and once a customer has signed in to it signs the payment with its own key. The customer
 * pays from their own balance; nothing here moves money.
 */
class OnlineCheckoutClient(private val timeoutMs: Int = 8_000) {
    init {
        require(timeoutMs in 1..30_000)
    }

    fun create(
        config: ProvisioningConfig,
        orderReference: String,
        description: String,
        grossUnits: BigInteger,
    ): OnlineOrder {
        val body = JSONObject()
            .put("orderReference", orderReference)
            .put("orderVersion", "1")
            .put("description", description)
            .put("grossUnits", grossUnits.toString())
            .toString()
        // A fresh key per order: a retry of this same call would be a new sale, never a replay.
        val json = send(config, "POST", "/v1/terminal/checkout-orders", body, "ol-" + UUID.randomUUID())
        val url = json.optString("checkoutUrl").takeIf { it.startsWith("https://") }
            ?: throw OnlineCheckoutException(OnlineCheckoutException.Kind.REFUSED, "Online payments are not set up on this server")
        return OnlineOrder(json.getString("orderId"), url, instant(json.getString("expiresAt")))
    }

    fun cashier(config: ProvisioningConfig, orderId: String): CashierOrder {
        val json = send(config, "GET", "/v1/checkout-orders/$orderId/cashier", null, null)
        val settlement = json.optJSONObject("settlement")?.let {
            Settlement(it.getString("status"), it.optString("transactionHash").takeIf { hash -> hash.isNotEmpty() })
        }
        return CashierOrder(
            state = json.getString("state"),
            checkoutUrl = json.optString("checkoutUrl").takeIf { it.startsWith("https://") },
            expiresAt = instant(json.getString("expiresAt")),
            paymentId = json.optString("paymentId").takeIf { it.isNotEmpty() },
            encodedIntent = json.optString("encodedIntent").takeIf { it.isNotEmpty() },
            intentDigest = json.optString("intentDigest").takeIf { it.isNotEmpty() },
            settlement = settlement,
        )
    }

    /** Hands the server this terminal's signature over the bound payment. Repeating it is harmless. */
    fun attachSignature(config: ProvisioningConfig, orderId: String, signatureHex: String) {
        send(config, "POST", "/v1/terminal/checkout-orders/$orderId/terminal-signature", JSONObject().put("terminalSignature", signatureHex).toString(), null)
    }

    private fun instant(value: String): Long = Instant.parse(value).epochSecond

    private fun send(config: ProvisioningConfig, method: String, path: String, body: String?, idempotencyKey: String?): JSONObject {
        val connection = try {
            (URL("${config.apiEndpoint}$path").openConnection() as HttpsURLConnection).apply {
                requestMethod = method
                instanceFollowRedirects = false
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer ${config.accessToken}")
                idempotencyKey?.let { setRequestProperty("Idempotency-Key", it) }
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
        } catch (error: IOException) {
            throw OnlineCheckoutException(OnlineCheckoutException.Kind.UNREACHABLE, "The server could not be reached")
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            if (code in 200..299) {
                if (connection.contentType?.startsWith("application/json") != true)
                    throw OnlineCheckoutException(OnlineCheckoutException.Kind.UNREACHABLE, "The server answered in an unexpected way")
                return JSONObject(read(connection.inputStream.use { it.readBytesBounded() }))
            }
            val errorBody = runCatching { read(connection.errorStream?.use { it.readBytesBounded() } ?: ByteArray(0)) }.getOrDefault("")
            val kind = when {
                code == HttpURLConnection.HTTP_UNAUTHORIZED || code == HttpURLConnection.HTTP_FORBIDDEN -> OnlineCheckoutException.Kind.DENIED
                code == HttpURLConnection.HTTP_NOT_FOUND -> OnlineCheckoutException.Kind.GONE
                code == 429 || code >= 500 -> OnlineCheckoutException.Kind.UNREACHABLE
                else -> OnlineCheckoutException.Kind.REFUSED
            }
            throw OnlineCheckoutException(kind, errorMessage(errorBody, code))
        } catch (error: OnlineCheckoutException) {
            throw error
        } catch (error: IOException) {
            throw OnlineCheckoutException(OnlineCheckoutException.Kind.UNREACHABLE, "The server could not be reached")
        } finally {
            connection.disconnect()
        }
    }

    private fun errorMessage(body: String, code: Int): String =
        runCatching { JSONObject(body).optString("error").takeIf { it.isNotEmpty() } }.getOrNull()?.replace('_', ' ')
            ?: "The server refused the request ($code)"

    private fun read(bytes: ByteArray) = bytes.decodeToString()

    private fun java.io.InputStream.readBytesBounded(): ByteArray {
        val output = ByteArrayOutputStream()
        val chunk = ByteArray(4_096)
        while (true) {
            val count = read(chunk)
            if (count < 0) break
            output.write(chunk, 0, count)
            if (output.size() > MAX_RESPONSE_BYTES) throw OnlineCheckoutException(OnlineCheckoutException.Kind.UNREACHABLE, "The server answer was too large")
        }
        return output.toByteArray()
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 64 * 1024
    }
}
