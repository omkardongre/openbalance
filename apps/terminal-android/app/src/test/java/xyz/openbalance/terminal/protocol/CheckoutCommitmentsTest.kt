package xyz.openbalance.terminal.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import java.math.BigInteger

/** Vectors produced by `@openbalance/protocol` (packages/protocol/src/checkout.ts). */
class CheckoutCommitmentsTest {
    @Test
    fun orderReferenceHashMatchesProtocol() {
        assertEquals(
            "0xbdadfb82bc2909fb8db6dbe3682f9367dcc2fdd4db7fe29a2e4121d31fc77ab8",
            CheckoutCommitments.orderReferenceHash("KP-261009-101500-ab12", BigInteger.ONE),
        )
    }

    @Test
    fun receiptCommitmentMatchesProtocol() {
        assertEquals(
            "0x4fad967e91ba0d231e95a6c4b62c9cbdc6b7e0b762641925c9ffbc01f6ff681e",
            CheckoutCommitments.receiptCommitment(
                CheckoutCommitments.Display(
                    "OpenBalance Android Terminal", "KP-261009-101500-ab12", BigInteger.ONE,
                    "Custom amount", "USDC", 6,
                ),
                BigInteger("1250000"),
            ),
        )
    }

    @Test
    fun escapesLikeJsonStringify() {
        assertEquals(
            "0xa496588b7778680875700f279cabe1f5b5c7b0c80f9140bbe9b99ec21cf993c3",
            CheckoutCommitments.receiptCommitment(
                CheckoutCommitments.Display("Café \"Q\" \\ Ünï 😀", "R/1", BigInteger("7"), "x", "USDC", 6),
                BigInteger.ONE,
            ),
        )
    }

    @Test
    fun rejectsLabelsTheProtocolRejects() {
        assertFalse(CheckoutCommitments.isBoundedLabel(""))
        assertFalse(CheckoutCommitments.isBoundedLabel("a\nb"))
        assertFalse(CheckoutCommitments.isBoundedLabel("x".repeat(161)))
        assertFalse(CheckoutCommitments.isBoundedLabel("\uD83D"))
        assertThrows(IllegalArgumentException::class.java) {
            CheckoutCommitments.orderReferenceHash("ok", BigInteger.ZERO)
        }
    }
}
