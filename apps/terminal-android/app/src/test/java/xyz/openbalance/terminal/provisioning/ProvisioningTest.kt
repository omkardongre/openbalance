package xyz.openbalance.terminal.provisioning

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import java.math.BigInteger
import java.time.Instant
import java.util.UUID

class ProvisioningTest {
    private fun h(character: Char) = "0x" + character.toString().repeat(64)
    private fun a(character: Char) = "0x" + character.toString().repeat(40)

    @Test
    fun decodesBoundedProvisioningAndAbiState() {
        val orderId = UUID.randomUUID()
        val json = """{"schemaVersion":1,"deployment":{"chainId":10143,"eventId":"${h('1')}","asset":"${a('2')}","registry":{"address":"${a('3')}","runtimeCodeHash":"${h('4')}"},"ledger":{"address":"${a('5')}","runtimeCodeHash":"${h('6')}"},"router":{"address":"${a('7')}","runtimeCodeHash":"${h('8')}"},"vault":{"address":"${a('9')}","runtimeCodeHash":"${h('a')}"}},"terminal":{"terminalInstanceId":"${h('b')}","terminalKeyVersion":"1","terminalSigner":"${a('c')}"},"projection":{"finalizedBlockNumber":"42","finalizedBlockHash":"${h('d')}"},"channelIds":["${h('e')}"],"orders":[{"orderId":"$orderId","state":"OFFLINE_IMPORTED","orderRefHash":"${h('f')}","orderVersion":"1","grossUnits":"12500000","receiptCommitment":"${h('1')}","expiresAt":"2026-09-14T12:00:00Z","display":{"vendorName":"North Gate Coffee","orderReference":"ORDER-1042","orderVersion":"1","description":"Two coffees","assetSymbol":"USDC","assetDecimals":6}}]}"""
        val batch = ConnectedProvisioningClient().decode(json)
        assertEquals(BigInteger("10143"), batch.deployment.chainId)
        assertEquals(orderId.toString(), batch.orders.single().orderId)
        assertEquals(Instant.parse("2026-09-14T12:00:00Z").epochSecond, batch.orders.single().expiresAt)

        val encoded = "0x" + "0".repeat(63) + "1" + "0".repeat(63) + "0"
        val state = Slots(encoded, 2)
        assertEquals(BigInteger.ONE, state.uint(0))
        assertFalse(state.boolean(1))

        assertArrayEquals(
            "583bdde6d9c2c5db95b0e59a79fdd6df333828f7203e486c97dc8e407ada813c".chunked(2).map { it.toInt(16).toByte() }.toByteArray(),
            terminalProvisioningDigest(
                BigInteger("10143"), h('1'), h('2'), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
        )
    }
}
