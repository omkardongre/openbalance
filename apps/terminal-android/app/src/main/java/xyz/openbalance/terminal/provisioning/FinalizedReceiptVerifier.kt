package xyz.openbalance.terminal.provisioning

import org.json.JSONArray
import xyz.openbalance.terminal.protocol.OfflineProtocol
import xyz.openbalance.terminal.protocol.VoucherReceipt
import xyz.openbalance.terminal.security.Keccak
import java.math.BigInteger

class FinalizedReceiptVerifier(rpcEndpoint: String, timeoutMilliseconds: Int = 10_000) {
    private val rpc = RpcTransport(rpcEndpoint, timeoutMilliseconds)
    private val eventTopic = Keccak.hex(
        "VoucherSettled(bytes32,bytes32,uint32,uint256,uint256,bytes32)".toByteArray(),
    )

    fun verify(receipt: VoucherReceipt, transactionHash: String): String {
        require(transactionHash.matches(Regex("^0x[0-9a-fA-F]{64}$"))) { "Invalid settlement transaction hash" }
        val voucher = OfflineProtocol.decodeVoucher(receipt.voucher)
        require(rpc.quantity("eth_chainId") == voucher.chainId) { "Settlement proof is on another chain" }
        val finalized = rpc.block("finalized")
        val transaction = rpc.objectResult(
            "eth_getTransactionReceipt",
            JSONArray().put(transactionHash.lowercase()),
        )
        require(quantity(transaction.getString("status")) == BigInteger.ONE) { "Settlement transaction reverted" }
        val blockNumber = quantity(transaction.getString("blockNumber"))
        require(blockNumber <= finalized.number) { "Settlement transaction is not finalized" }
        val canonical = rpc.block(hexQuantity(blockNumber))
        require(canonical.hash.equals(transaction.getString("blockHash"), true)) {
            "Settlement transaction is not in the canonical finalized block"
        }
        val expectedSequence = slot(BigInteger.valueOf(receipt.sequence))
        val expectedDigest = "0x" + OfflineProtocol.voucherDigest(voucher).toHex()
        val matches = transaction.getJSONArray("logs").let { logs ->
            (0 until logs.length()).map { logs.getJSONObject(it) }.filter { log ->
                if (!log.getString("address").equals(voucher.vault, true)) return@filter false
                val topics = log.getJSONArray("topics")
                topics.length() == 4 &&
                    topics.getString(0).equals(eventTopic, true) &&
                    topics.getString(1).equals(receipt.channelId, true) &&
                    topics.getString(2).equals(receipt.paymentId, true) &&
                    topics.getString(3).removePrefix("0x").equals(expectedSequence, true) &&
                    eventDataMatches(log.getString("data"), voucher.grossUnits, voucher.cumulativeGrossUnits, expectedDigest)
            }
        }
        require(matches.size == 1) { "Finalized transaction does not contain exactly one matching voucher settlement" }
        return transactionHash.lowercase()
    }

    private fun eventDataMatches(value: String, gross: BigInteger, cumulative: BigInteger, digest: String): Boolean =
        runCatching {
            val slots = value.removePrefix("0x").also { require(it.length == 192) }.chunked(64)
            BigInteger(slots[0], 16) == gross && BigInteger(slots[1], 16) == cumulative &&
                "0x${slots[2]}".equals(digest, true)
        }.getOrDefault(false)

    private fun quantity(value: String) = BigInteger(value.removePrefix("0x").ifEmpty { "0" }, 16)
    private fun slot(value: BigInteger) = value.toString(16).padStart(64, '0')
    private fun hexQuantity(value: BigInteger) = "0x${value.toString(16)}"
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
