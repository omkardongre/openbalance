package xyz.openbalance.terminal.relay

import org.json.JSONObject
import xyz.openbalance.terminal.data.RelayUploadLease
import xyz.openbalance.terminal.data.TerminalRepository
import xyz.openbalance.terminal.data.UploadAuthorization
import xyz.openbalance.terminal.protocol.OfflineProtocol
import xyz.openbalance.terminal.protocol.VoucherReceipt
import xyz.openbalance.terminal.provisioning.ProvisioningConfig
import xyz.openbalance.terminal.provisioning.FinalizedReceiptVerifier
import xyz.openbalance.terminal.security.TerminalKeyStore
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.URL
import java.security.SecureRandom
import javax.net.ssl.HttpsURLConnection
import kotlin.math.absoluteValue

data class RelaySyncSummary(val uploaded: Int, val settled: Int, val retried: Int, val quarantined: Int)

class RelayUploadClient(
    private val repository: TerminalRepository,
    private val keys: TerminalKeyStore,
    private val timeoutMilliseconds: Int = 10_000,
    private val leaseMilliseconds: Long = 30_000,
    private val pollMilliseconds: Long = 5_000,
    private val initialBackoffMilliseconds: Long = 2_000,
    private val maximumBackoffMilliseconds: Long = 300_000,
    private val maximumAuthorizationAgeSeconds: Long = 60,
) {
    init {
        require(timeoutMilliseconds in 500..60_000)
        require(leaseMilliseconds in 1_000..300_000)
        require(pollMilliseconds in 1_000..300_000)
        require(initialBackoffMilliseconds in 1_000..maximumBackoffMilliseconds)
        require(maximumAuthorizationAgeSeconds in 10..900)
    }

    suspend fun runBatch(config: ProvisioningConfig, limit: Int = 20, nowMilliseconds: Long = System.currentTimeMillis()): RelaySyncSummary {
        val identity = keys.getOrCreate()
        val owner = "android-${identity.signer.takeLast(24)}"
        val leases = repository.leaseRelayUploads(limit, owner, nowMilliseconds, leaseMilliseconds)
        var uploaded = 0
        var settled = 0
        var retried = 0
        var quarantined = 0
        for (lease in leases) {
            when (upload(config, identity, owner, lease, nowMilliseconds)) {
                "RELAYED" -> uploaded++
                "SETTLED" -> settled++
                "RETRY" -> retried++
                "QUARANTINED" -> quarantined++
            }
        }
        return RelaySyncSummary(uploaded, settled, retried, quarantined)
    }

    private suspend fun upload(
        config: ProvisioningConfig,
        identity: TerminalKeyStore.Identity,
        owner: String,
        lease: RelayUploadLease,
        nowMilliseconds: Long,
    ): String {
        val nowSeconds = nowMilliseconds / 1_000
        return try {
            val authorization = authorization(config, identity, owner, lease, nowSeconds, nowMilliseconds)
            val response = post(config.relayEndpoint, lease.receipt, authorization)
            if (response.statusCode in setOf(200, 201)) {
                val body = JSONObject(response.body)
                require(body.getString("receiptId") == lease.receipt.receiptId) { "Relay acknowledgement targets another receipt" }
                val remoteState = body.getString("state")
                val transactionHash = body.optString("transactionHash").takeIf { it.isNotEmpty() && it != "null" }
                when (remoteState) {
                    "SETTLED" -> {
                        require(transactionHash?.matches(Regex("^0x[0-9a-fA-F]{64}$")) == true) {
                            "Finalized relay acknowledgement lacks a transaction hash"
                        }
                        val verifiedHash = FinalizedReceiptVerifier(config.rpcEndpoint).verify(lease.receipt, transactionHash)
                        finish(lease, owner, nowMilliseconds, "SETTLED", nowMilliseconds, verifiedHash, null, nowMilliseconds)
                    }
                    "QUARANTINED" -> finish(lease, owner, nowMilliseconds, "QUARANTINED", nowMilliseconds, transactionHash, "Relay quarantined receipt", null)
                    "PENDING", "RETRY", "SUBMITTED" -> finish(
                        lease, owner, nowMilliseconds, "RELAYED", Math.addExact(nowMilliseconds, pollMilliseconds), transactionHash, null, nowMilliseconds,
                    )
                    else -> throw IllegalArgumentException("Relay acknowledgement has an invalid state")
                }
            } else if (response.statusCode in setOf(400, 401, 403, 409, 422)) {
                finish(lease, owner, nowMilliseconds, "QUARANTINED", nowMilliseconds, null, "Relay rejected receipt with HTTP ${response.statusCode}", null)
            } else {
                retry(lease, owner, nowMilliseconds, "Relay returned HTTP ${response.statusCode}")
            }
        } catch (error: Exception) {
            retry(lease, owner, nowMilliseconds, safeError(error))
        }
    }

    private suspend fun authorization(
        config: ProvisioningConfig,
        identity: TerminalKeyStore.Identity,
        owner: String,
        lease: RelayUploadLease,
        nowSeconds: Long,
        nowMilliseconds: Long,
    ): UploadAuthorization {
        lease.authorization?.let {
            if (it.keyVersion == identity.keyVersion && (nowSeconds - it.sentAt).absoluteValue <= maximumAuthorizationAgeSeconds)
                return it
        }
        val nonceBytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val nonce = "0x" + nonceBytes.toHex()
        val payloadHash = OfflineProtocol.receiptPayloadHash(lease.receipt)
        val digest = OfflineProtocol.terminalIngressDigest(
            config.relayEndpoint,
            lease.receipt.terminalId,
            BigInteger.valueOf(identity.keyVersion),
            nowSeconds,
            nonce,
            payloadHash,
        )
        val authorization = UploadAuthorization(
            identity.keyVersion,
            nowSeconds,
            nonce,
            "0x" + keys.signDigest(digest).toHex(),
        )
        repository.saveUploadAuthorization(lease.requestId, owner, authorization, nowMilliseconds)
        return authorization
    }

    private suspend fun retry(lease: RelayUploadLease, owner: String, now: Long, reason: String): String {
        val exponent = (lease.attempts - 1).coerceIn(0, 20)
        val delay = (initialBackoffMilliseconds * (1L shl exponent)).coerceAtMost(maximumBackoffMilliseconds)
        finish(
            lease,
            owner,
            now,
            if (lease.acknowledged) "RELAYED" else "RETRY",
            Math.addExact(now, delay),
            null,
            reason,
            null,
        )
        return "RETRY"
    }

    private suspend fun finish(
        lease: RelayUploadLease,
        owner: String,
        completedAt: Long,
        state: String,
        nextAttemptAt: Long,
        transactionHash: String?,
        error: String?,
        acknowledgedAt: Long?,
    ): String {
        repository.completeRelayUpload(
            lease.requestId,
            owner,
            state,
            nextAttemptAt,
            transactionHash,
            error?.take(500),
            acknowledgedAt,
            completedAt,
        )
        return state
    }

    private fun post(endpoint: String, receipt: VoucherReceipt, authorization: UploadAuthorization): HttpResult {
        val body = JSONObject().apply {
            put("receipt", JSONObject(OfflineProtocol.canonicalReceipt(receipt)))
            put("authorization", JSONObject().apply {
                put("keyVersion", authorization.keyVersion.toString())
                put("sentAt", authorization.sentAt)
                put("nonce", authorization.nonce)
                put("signature", authorization.signature)
            })
        }.toString().toByteArray()
        require(body.size <= 128 * 1_024) { "Relay request exceeds supported size" }
        val connection = (URL(endpoint).openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMilliseconds
            readTimeout = timeoutMilliseconds
            instanceFollowRedirects = false
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-store")
            setFixedLengthStreamingMode(body.size)
        }
        return try {
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val declared = connection.contentLengthLong
            require(declared <= MAX_RESPONSE_BYTES) { "Relay acknowledgement exceeds supported size" }
            val input = if (status in 200..299) connection.inputStream else connection.errorStream
            HttpResult(status, input?.use(::readBounded)?.decodeToString().orEmpty())
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(input: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(2_048)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            require(output.size() + read <= MAX_RESPONSE_BYTES) { "Relay acknowledgement exceeds supported size" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private fun safeError(error: Exception) = (error.message ?: error::class.java.simpleName).take(500)
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private data class HttpResult(val statusCode: Int, val body: String)

    companion object {
        private const val MAX_RESPONSE_BYTES = 16 * 1_024L
    }
}
