package xyz.openbalance.terminal.data

import java.math.BigInteger

/**
 * Offline limits a cashier sees before charging. Every limit comes from the reserve's finalized
 * on-chain terms, so the terminal never invents a number: the vault would reject a sale over the
 * per-sale cap, past the reserve's remaining balance, or beyond its sale count anyway. Checking
 * first turns a failed charge into a disabled button with a reason.
 */
object OfflineLimits {
    sealed interface Block {
        data class OverPerSale(val maxPerSaleUnits: BigInteger) : Block
        data class OverRemaining(val remainingUnits: BigInteger) : Block
        data object NoSalesLeft : Block
    }

    fun chargeBlock(orderUnits: BigInteger, reserve: ChannelView): Block? = when {
        reserve.salesLeft <= 0 -> Block.NoSalesLeft
        orderUnits > reserve.maxPerSaleUnits -> Block.OverPerSale(reserve.maxPerSaleUnits)
        orderUnits > BigInteger(reserve.remainingUnits) -> Block.OverRemaining(BigInteger(reserve.remainingUnits))
        else -> null
    }

    /**
     * Sales the terminal accepted offline that have not settled yet. A sale still on the device
     * must reach the venue relay before its reserve's submission deadline, or the vault will refuse
     * it and the vendor is not paid; one the relay already holds is out of the terminal's hands.
     * Quarantined sales were rejected by the relay and need an operator.
     */
    data class PendingUploads(
        val waitingCount: Int = 0,
        val waitingUnits: BigInteger = BigInteger.ZERO,
        /** Earliest submission deadline among sales still on the device, epoch seconds. */
        val uploadBy: Long? = null,
        val settlingCount: Int = 0,
        val settlingUnits: BigInteger = BigInteger.ZERO,
        val needsAttentionCount: Int = 0,
        /** Unsettled sales whose submission deadline has passed: the vault will never pay them. */
        val missedCount: Int = 0,
        val missedUnits: BigInteger = BigInteger.ZERO,
    )

    data class UnsettledSale(val relayState: String, val acknowledged: Boolean, val grossUnits: BigInteger, val submitUntil: Long)

    /**
     * A sale that has not settled by its reserve's `submitUntil` can no longer settle: the vault
     * refuses vouchers after the deadline and the attendee can take that money back. It stops being
     * "pending" and is counted as missed instead, so no warning waits for something that cannot happen.
     */
    fun isMissed(relayState: String, submitUntil: Long, nowSeconds: Long): Boolean =
        relayState != "SETTLED" && submitUntil > 0 && nowSeconds >= submitUntil

    fun pendingUploads(sales: List<UnsettledSale>, nowSeconds: Long): PendingUploads {
        val (missed, live) = sales.partition { isMissed(it.relayState, it.submitUntil, nowSeconds) }
        val waiting = live.filter { it.relayState != "QUARANTINED" && !it.acknowledged && it.relayState != "RELAYED" }
        val settling = live.filter { it.relayState != "QUARANTINED" && (it.acknowledged || it.relayState == "RELAYED") }
        return PendingUploads(
            missedCount = missed.size,
            missedUnits = missed.fold(BigInteger.ZERO) { sum, sale -> sum + sale.grossUnits },
            waitingCount = waiting.size,
            waitingUnits = waiting.fold(BigInteger.ZERO) { sum, sale -> sum + sale.grossUnits },
            uploadBy = waiting.minOfOrNull { it.submitUntil },
            settlingCount = settling.size,
            settlingUnits = settling.fold(BigInteger.ZERO) { sum, sale -> sum + sale.grossUnits },
            needsAttentionCount = live.count { it.relayState == "QUARANTINED" },
        )
    }
}
