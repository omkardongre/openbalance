package xyz.openbalance.terminal.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigInteger

class OfflineLimitsTest {
    private val reserve = ChannelView(
        channelId = "0x" + "3".repeat(64), remainingUnits = "20000000", acceptUntil = 200,
        maxPerSaleUnits = BigInteger("15000000"), salesLeft = 2, submitUntil = 300,
    )

    @Test
    fun blocksChargesThePerSaleCapRemainingBalanceOrSaleCountWouldRefuse() {
        assertNull(OfflineLimits.chargeBlock(BigInteger("15000000"), reserve))
        assertEquals(
            OfflineLimits.Block.OverPerSale(BigInteger("15000000")),
            OfflineLimits.chargeBlock(BigInteger("15000001"), reserve),
        )
        assertEquals(
            OfflineLimits.Block.OverRemaining(BigInteger("5000000")),
            OfflineLimits.chargeBlock(BigInteger("6000000"), reserve.copy(remainingUnits = "5000000")),
        )
        assertEquals(OfflineLimits.Block.NoSalesLeft, OfflineLimits.chargeBlock(BigInteger.ONE, reserve.copy(salesLeft = 0)))
    }

    @Test
    fun separatesSalesStillOnTheDeviceFromOnesTheRelayHolds() {
        val pending = OfflineLimits.pendingUploads(
            listOf(
                OfflineLimits.UnsettledSale("PENDING", false, BigInteger("4000000"), 500),
                OfflineLimits.UnsettledSale("RETRY", false, BigInteger("1000000"), 300),
                OfflineLimits.UnsettledSale("UPLOADING", true, BigInteger("2000000"), 200),
                OfflineLimits.UnsettledSale("RELAYED", true, BigInteger("3000000"), 100),
                OfflineLimits.UnsettledSale("QUARANTINED", false, BigInteger("9000000"), 150),
            ),
            nowSeconds = 50,
        )
        assertEquals(2, pending.waitingCount)
        assertEquals(BigInteger("5000000"), pending.waitingUnits)
        assertEquals(300L, pending.uploadBy)
        assertEquals(2, pending.settlingCount)
        assertEquals(BigInteger("5000000"), pending.settlingUnits)
        assertEquals(1, pending.needsAttentionCount)
        assertEquals(0, pending.missedCount)
    }

    @Test
    fun countsSalesPastTheirDeadlineAsMissedNotPending() {
        val pending = OfflineLimits.pendingUploads(
            listOf(
                OfflineLimits.UnsettledSale("RETRY", false, BigInteger("400000"), 100),
                OfflineLimits.UnsettledSale("RELAYED", true, BigInteger("300000"), 100),
                OfflineLimits.UnsettledSale("QUARANTINED", false, BigInteger("200000"), 100),
                OfflineLimits.UnsettledSale("PENDING", false, BigInteger("500000"), 400),
            ),
            nowSeconds = 100,
        )
        assertEquals(3, pending.missedCount)
        assertEquals(BigInteger("900000"), pending.missedUnits)
        assertEquals(1, pending.waitingCount)
        assertEquals(400L, pending.uploadBy)
        assertEquals(0, pending.settlingCount)
        assertEquals(0, pending.needsAttentionCount)
        assertEquals(false, OfflineLimits.isMissed("SETTLED", 100, 200))
        assertEquals(false, OfflineLimits.isMissed("RETRY", 0, 200))
    }
}
