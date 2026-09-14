package xyz.openbalance.terminal.provisioning

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

class ConnectedProvisioningClient(private val timeoutMs: Int = 10_000) {
    fun fetch(config: ProvisioningConfig, terminalSigner: String, signDigest: (ByteArray) -> ByteArray): ProvisioningBatch {
        require(timeoutMs in 1..30_000)
        val challenge = challenge(request(config, "/v1/terminal/provisioning-challenges", null))
        val signature = signDigest(
            terminalProvisioningDigest(challenge.chainId, challenge.eventId, challenge.terminalInstanceId, challenge.value),
        ).also { require(it.size == 65) }.toHex()
        val body = JSONObject().put("challenge", challenge.value).put("terminalSignature", signature).toString()
        val batch = decode(request(config, "/v1/terminal/provisioning", body))
        require(batch.deployment.chainId == challenge.chainId && batch.deployment.eventId == challenge.eventId &&
            batch.terminal.terminalInstanceId == challenge.terminalInstanceId && batch.terminal.terminalSigner.equals(terminalSigner, true)
        ) { "Provisioning response changed terminal scope" }
        return batch
    }

    private fun request(config: ProvisioningConfig, path: String, body: String?): String {
        val connection = (URL("${config.apiEndpoint}$path").openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"
            instanceFollowRedirects = false
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer ${config.accessToken}")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            if (connection.responseCode != HttpURLConnection.HTTP_OK ||
                connection.contentType?.startsWith("application/json") != true
            ) throw IllegalStateException("Terminal provisioning service rejected the request")
            return readBounded(connection)
        } finally {
            connection.disconnect()
        }
    }

    private data class Challenge(
        val value: String,
        val chainId: BigInteger,
        val eventId: String,
        val terminalInstanceId: String,
    )

    private fun challenge(value: String): Challenge {
        val json = JSONObject(value)
        require(json.length() == 5 && json.getInt("schemaVersion") == 1)
        return Challenge(
            json.getString("challenge").also { require(it.matches(Regex("^[A-Za-z0-9_-]{43}$"))) },
            positive(json.get("chainId")),
            bytes32(json.getString("eventId")),
            bytes32(json.getString("terminalInstanceId")),
        )
    }

    private fun readBounded(connection: HttpsURLConnection): String = connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val chunk = ByteArray(4_096)
        while (output.size() <= 262_144) {
            val count = input.read(chunk)
            if (count < 0) break
            output.write(chunk, 0, count)
        }
        output.toByteArray().also { require(it.size <= 262_144) { "Provisioning response exceeds limit" } }.decodeToString()
    }

    internal fun decode(value: String): ProvisioningBatch {
        val root = JSONObject(value)
        require(root.length() == 6 && root.getInt("schemaVersion") == 1) { "Invalid provisioning response" }
        val deployment = root.getJSONObject("deployment").also { require(it.length() == 7) }
        val terminal = root.getJSONObject("terminal").also { require(it.length() == 3) }
        val projection = root.getJSONObject("projection").also { require(it.length() == 2) }
        return ProvisioningBatch(
            deployment = DeploymentPin(
                chainId = positive(deployment.get("chainId")),
                eventId = bytes32(deployment.getString("eventId")),
                asset = address(deployment.getString("asset")),
                registry = contract(deployment.getJSONObject("registry")),
                ledger = contract(deployment.getJSONObject("ledger")),
                router = contract(deployment.getJSONObject("router")),
                vault = contract(deployment.getJSONObject("vault")),
            ),
            terminal = TerminalPin(
                bytes32(terminal.getString("terminalInstanceId")),
                positive(terminal.get("terminalKeyVersion")),
                address(terminal.getString("terminalSigner")),
            ),
            projection = ProjectionPin(
                unsigned(projection.get("finalizedBlockNumber")),
                bytes32(projection.getString("finalizedBlockHash")),
            ),
            channelIds = root.getJSONArray("channelIds").strings(100).map(::bytes32),
            orders = root.getJSONArray("orders").objects(100).map(::order),
        )
    }

    private fun order(json: JSONObject): PosOrder {
        require(json.length() == 8 && json.getString("state") == "OFFLINE_IMPORTED") { "Invalid POS order" }
        UUID.fromString(json.getString("orderId"))
        val display = json.getJSONObject("display").also { require(it.length() == 6) }
        val expiry = Instant.parse(json.getString("expiresAt")).epochSecond
        require(expiry > 0)
        return PosOrder(
            orderId = json.getString("orderId"),
            orderRefHash = bytes32(json.getString("orderRefHash")),
            orderVersion = positive(json.get("orderVersion")),
            grossUnits = positive(json.get("grossUnits")),
            receiptCommitment = bytes32(json.getString("receiptCommitment")),
            expiresAt = expiry,
            vendorName = label(display.getString("vendorName")),
            orderReference = label(display.getString("orderReference")),
            description = label(display.getString("description")),
            assetSymbol = display.getString("assetSymbol").also { require(it.matches(Regex("^[A-Z0-9]{2,12}$"))) },
            assetDecimals = display.getInt("assetDecimals").also { require(it in 0..36) },
        ).also { require(it.orderVersion.toString() == display.getString("orderVersion")) }
    }

    private fun contract(json: JSONObject): ContractPin {
        require(json.length() == 2)
        return ContractPin(address(json.getString("address")), bytes32(json.getString("runtimeCodeHash")))
    }
    private fun label(value: String) = value.also {
        require(it.isNotEmpty() && it.length <= 160 && it.none { character -> character.code < 32 || character.code == 127 })
    }
    private fun address(value: String) = value.lowercase().also { require(it.matches(Regex("^0x[0-9a-f]{40}$"))) }
    private fun bytes32(value: String) = value.lowercase().also { require(it.matches(Regex("^0x[0-9a-f]{64}$"))) }
    private fun unsigned(value: Any) = BigInteger(value.toString()).also { require(it >= BigInteger.ZERO) }
    private fun positive(value: Any) = unsigned(value).also { require(it > BigInteger.ZERO) }
    private fun JSONArray.strings(max: Int) = (0 until length()).also { require(length() <= max) }.map(::getString)
    private fun JSONArray.objects(max: Int) = (0 until length()).also { require(length() <= max) }.map(::getJSONObject)
    private fun ByteArray.toHex() = "0x" + joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

internal fun terminalProvisioningDigest(chainId: BigInteger, eventId: String, terminalId: String, challenge: String): ByteArray {
    require(chainId > BigInteger.ZERO)
    val decoded = java.util.Base64.getUrlDecoder().decode(challenge)
    require(decoded.size == 32)
    val domain = xyz.openbalance.terminal.security.Keccak.digest("openbalance:terminal-provisioning:v1".toByteArray())
    return xyz.openbalance.terminal.security.Keccak.digest(
        domain + abiUint(chainId) + rawBytes32(eventId) + rawBytes32(terminalId) + decoded,
    )
}

private fun abiUint(value: BigInteger) = value.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
private fun rawBytes32(value: String): ByteArray {
    require(value.matches(Regex("^0x[0-9a-fA-F]{64}$")))
    return value.removePrefix("0x").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
