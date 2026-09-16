package xyz.openbalance.terminal.provisioning

import org.json.JSONArray
import org.json.JSONObject
import xyz.openbalance.terminal.protocol.ChannelSnapshot
import xyz.openbalance.terminal.security.Keccak
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.HttpsURLConnection

data class VerifiedChannel(val snapshot: ChannelSnapshot, val proofHash: String, val finalizedBlockNumber: BigInteger, val finalizedBlockHash: String)

class FinalizedChannelVerifier(rpcEndpoint: String, private val timeoutMs: Int = 10_000) {
    private val rpc = RpcTransport(rpcEndpoint, timeoutMs)
    private val zeroAddress = "0x" + "0".repeat(40)

    fun verify(batch: ProvisioningBatch, channelId: String, localSigner: String): VerifiedChannel {
        val manifest = batch.deployment
        val chainId = rpc.quantity("eth_chainId")
        require(chainId == manifest.chainId) { "RPC chain does not match deployment" }
        require(batch.terminal.terminalSigner.equals(localSigner, true)) { "Provisioning belongs to another terminal key" }

        val finalized = rpc.block("finalized")
        require(finalized.number >= batch.projection.finalizedBlockNumber) { "RPC finalized head trails the provisioning projection" }
        val projected = rpc.block(hexQuantity(batch.projection.finalizedBlockNumber))
        require(projected.hash.equals(batch.projection.finalizedBlockHash, true)) { "Provisioning projection is not on the finalized chain" }
        val block = hexQuantity(finalized.number)

        mapOf(
            "registry" to manifest.registry,
            "ledger" to manifest.ledger,
            "router" to manifest.router,
            "vault" to manifest.vault,
        ).forEach { (name, contract) ->
            val code = rpc.hex("eth_getCode", JSONArray().put(contract.address).put(block))
            require(code != "0x" && Keccak.hex(hexBytes(code)).equals(contract.runtimeCodeHash, true)) {
                "$name runtime code does not match the pinned deployment"
            }
        }

        require(callBytes32(manifest.registry.address, "eventId()", block) == manifest.eventId) { "Registry event mismatch" }
        require(callAddress(manifest.registry.address, "asset()", block) == manifest.asset) { "Registry asset mismatch" }
        require(callAddress(manifest.ledger.address, "registry()", block) == manifest.registry.address)
        require(callAddress(manifest.ledger.address, "asset()", block) == manifest.asset)
        require(callAddress(manifest.ledger.address, "router()", block) == manifest.router.address)
        require(callAddress(manifest.ledger.address, "vault()", block) == manifest.vault.address)
        listOf(manifest.router, manifest.vault).forEach { contract ->
            require(callAddress(contract.address, "registry()", block) == manifest.registry.address)
            require(callAddress(contract.address, "ledger()", block) == manifest.ledger.address)
            require(callAddress(contract.address, "asset()", block) == manifest.asset)
        }

        val config = call(manifest.vault.address, "channelConfig(bytes32)", listOf(channelId), block, 18)
        require(config.bytes32(0) == channelId && config.bytes32(1) == manifest.eventId) { "Channel deployment scope mismatch" }
        require(config.address(2) == manifest.asset) { "Channel asset mismatch" }
        val reserveUnits = config.uint(3).positive("reserve")
        val vendorId = config.bytes32(4)
        val destinationVersion = config.uint(5).positive("destination version")
        val terminalId = config.bytes32(6)
        val terminalKeyVersion = config.uint(7).positive("terminal key version")
        val attendeeSigner = config.address(8).notZero("attendee signer")
        val configVersion = config.uint(9).positive("configuration version")
        val organizerFeeBps = config.uint(10).boundedInt(10_000, "organizer fee")
        val platformFeeBps = config.uint(11).boundedInt(10_000, "platform fee")
        require(organizerFeeBps + platformFeeBps <= 10_000) { "Channel fees exceed gross" }
        val maxPerVoucher = config.uint(12).positive("maximum voucher amount")
        require(maxPerVoucher <= reserveUnits)
        val maxVoucherCount = config.uint(13).boundedLong(1, 4_294_967_295L, "maximum voucher count")
        val acceptFrom = config.uint(14).boundedLong(0, 281_474_976_710_655L, "accept from")
        val acceptUntil = config.uint(15).boundedLong(1, 281_474_976_710_655L, "accept until")
        val submitUntil = config.uint(16).boundedLong(1, 281_474_976_710_655L, "submit until")
        val genesis = config.bytes32(17)
        require(acceptFrom < acceptUntil && acceptUntil < submitUntil) { "Channel time window is invalid" }
        require(terminalId == batch.terminal.terminalInstanceId && terminalKeyVersion == batch.terminal.terminalKeyVersion) {
            "Channel is assigned to another terminal instance"
        }

        val state = call(manifest.vault.address, "channelState(bytes32)", listOf(channelId), block, 5)
        state.address(0).notZero("original account")
        require(state.uint(1) == BigInteger.ZERO && state.uint(2) == BigInteger.ONE && state.bytes32(3) == genesis && !state.boolean(4)) {
            "Only untouched active channels can be installed"
        }
        val recipients = call(manifest.vault.address, "channelRecipients(bytes32)", listOf(channelId), block, 3)
        val vendor = recipients.address(0).notZero("vendor recipient")
        val organizer = recipients.address(1).notZero("organizer recipient")
        val platform = recipients.address(2).notZero("platform recipient")

        val terminalSigner = callAddress(
            manifest.registry.address,
            "historicalTerminalSigner(bytes32,uint256,bytes32)",
            block,
            listOf(terminalId, slot(terminalKeyVersion), vendorId),
        )
        require(terminalSigner.equals(localSigner, true)) { "Finalized terminal authority does not match this device" }
        val destination = call(manifest.registry.address, "destinations(bytes32,uint256)", listOf(vendorId, slot(destinationVersion)), block, 2)
        require(destination.address(0) == vendor && destination.boolean(1)) { "Finalized vendor destination is unavailable" }
        val policy = call(manifest.registry.address, "configs(uint256)", listOf(slot(configVersion)), block, 10)
        require(policy.uint(2).toInt() == organizerFeeBps && policy.uint(3).toInt() == platformFeeBps)
        require(policy.address(6) == organizer && policy.address(7) == platform && policy.boolean(9)) { "Finalized event policy mismatch" }
        val validAfter = policy.uint(0).longValueExact()
        val validUntil = policy.uint(1).longValueExact()
        val maxAcceptance = policy.uint(4).longValueExact()
        val maxSubmission = policy.uint(5).longValueExact()
        require(acceptFrom >= validAfter && acceptUntil <= validUntil && acceptUntil - acceptFrom <= maxAcceptance && submitUntil - acceptUntil <= maxSubmission) {
            "Channel window exceeds finalized event policy"
        }

        val snapshot = ChannelSnapshot(
            channelId, terminalId, manifest.chainId, manifest.vault.address, attendeeSigner,
            terminalSigner, configVersion, reserveUnits, maxPerVoucher, maxVoucherCount,
            acceptFrom, acceptUntil, submitUntil, genesis,
        )
        val proofHash = Keccak.hex(
            listOf("openbalance:terminal-channel-proof:v1", manifest.chainId, finalized.number, finalized.hash, channelId, terminalSigner, genesis)
                .joinToString(":").toByteArray(),
        )
        return VerifiedChannel(snapshot, proofHash, finalized.number, finalized.hash)
    }

    private fun callAddress(address: String, signature: String, block: String, args: List<String> = emptyList()) =
        call(address, signature, args, block, 1).address(0)
    private fun callBytes32(address: String, signature: String, block: String) = call(address, signature, emptyList(), block, 1).bytes32(0)
    private fun call(address: String, signature: String, args: List<String>, block: String, slots: Int): Slots {
        val selector = Keccak.digest(signature.toByteArray()).copyOfRange(0, 4).hex(false)
        val result = rpc.hex("eth_call", JSONArray().put(JSONObject().put("to", address).put("data", "0x$selector${args.joinToString("") { it.removePrefix("0x") }}")).put(block))
        return Slots(result, slots)
    }
    private fun String.notZero(field: String) = also { require(it != zeroAddress) { "$field is unavailable" } }
    private fun BigInteger.positive(field: String) = also { require(it > BigInteger.ZERO) { "$field is invalid" } }
    private fun BigInteger.boundedInt(max: Int, field: String) = toInt().also { require(this <= BigInteger.valueOf(max.toLong())) { "$field is invalid" } }
    private fun BigInteger.boundedLong(min: Long, max: Long, field: String) = longValueExact().also { require(it in min..max) { "$field is invalid" } }
}

internal data class RpcBlock(val number: BigInteger, val hash: String)

internal class RpcTransport(endpoint: String, private val timeoutMs: Int) {
    private val url = URL(endpoint)
    private val ids = AtomicLong()
    init {
        require(url.protocol == "https" && url.userInfo == null && url.query == null && url.ref == null)
        require(timeoutMs in 1..30_000)
    }
    fun quantity(method: String): BigInteger = parseQuantity(result(method, JSONArray()) as String)
    fun hex(method: String, params: JSONArray): String = (result(method, params) as String).lowercase().also { require(it.matches(Regex("^0x(?:[0-9a-f]{2})*$"))) }
    fun block(tag: String): RpcBlock {
        val json = result("eth_getBlockByNumber", JSONArray().put(tag).put(false)) as? JSONObject
            ?: throw IllegalStateException("RPC block is unavailable")
        return RpcBlock(parseQuantity(json.getString("number")), json.getString("hash").lowercase().also { require(it.matches(Regex("^0x[0-9a-f]{64}$"))) })
    }
    fun objectResult(method: String, params: JSONArray): JSONObject = result(method, params) as? JSONObject
        ?: throw IllegalStateException("RPC object result is unavailable")
    private fun result(method: String, params: JSONArray): Any {
        val id = ids.incrementAndGet()
        val request = JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString().toByteArray()
        val connection = (url.openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"; instanceFollowRedirects = false; connectTimeout = timeoutMs; readTimeout = timeoutMs; doOutput = true
            setRequestProperty("Content-Type", "application/json"); setRequestProperty("Accept", "application/json")
        }
        try {
            connection.outputStream.use { it.write(request) }
            if (connection.responseCode != HttpURLConnection.HTTP_OK || connection.contentType?.startsWith("application/json") != true)
                throw IllegalStateException("RPC request failed")
            val body = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream(); val chunk = ByteArray(4_096)
                while (output.size() <= 131_072) { val count = input.read(chunk); if (count < 0) break; output.write(chunk, 0, count) }
                output.toByteArray().also { require(it.size <= 131_072) }.decodeToString()
            }
            val response = JSONObject(body)
            require(response.getLong("id") == id && response.getString("jsonrpc") == "2.0" && !response.has("error")) { "RPC returned an error" }
            return response.get("result")
        } finally { connection.disconnect() }
    }
}

internal class Slots(value: String, expected: Int) {
    private val slots = value.removePrefix("0x").also { require(it.length == expected * 64) }.chunked(64)
    fun uint(index: Int) = BigInteger(slots[index], 16)
    fun bytes32(index: Int) = "0x${slots[index]}".lowercase()
    fun address(index: Int) = "0x${slots[index].takeLast(40)}".lowercase()
    fun boolean(index: Int) = uint(index).let { require(it == BigInteger.ZERO || it == BigInteger.ONE); it == BigInteger.ONE }
}

private fun slot(value: BigInteger) = value.toString(16).padStart(64, '0')
private fun hexQuantity(value: BigInteger) = "0x${value.toString(16)}"
private fun parseQuantity(value: String): BigInteger = BigInteger(value.removePrefix("0x").ifEmpty { "0" }, 16)
private fun hexBytes(value: String) = value.removePrefix("0x").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
private fun ByteArray.hex(prefix: Boolean = true) = (if (prefix) "0x" else "") + joinToString("") { "%02x".format(it.toInt() and 0xff) }
