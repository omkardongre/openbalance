package xyz.openbalance.terminal.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.math.BigInteger

class OfflineProtocolTest {
    private fun h(character: Char) = "0x" + character.toString().repeat(64)

    private val snapshot = ChannelSnapshot(
        channelId = h('3'), terminalId = h('7'), chainId = BigInteger("10143"),
        vault = "0x9999999999999999999999999999999999999999",
        attendeeSigner = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
        terminalSigner = "0x1563915e194d8cfba1943570603f7606a3115508",
        configVersion = BigInteger.ONE, reserveUnits = BigInteger("1000"),
        maxPerVoucher = BigInteger("500"), maxVoucherCount = 10,
        acceptFrom = 50, acceptUntil = 200, submitUntil = 300, genesisDigest = h('8'),
    )

    @Test
    fun matchesSharedVoucherDigestAndRequestHash() {
        val (voucher, request) = OfflineProtocol.prepareVoucher(
            snapshot = snapshot, nextSequence = 1, previousDigest = h('8'), spentUnits = BigInteger.ZERO,
            paymentId = h('a'), orderRefHash = h('b'), grossUnits = BigInteger("125"),
            receiptCommitment = h('c'), acceptedAt = 100, expiresAt = 150, requestId = "request:android",
        )
        assertEquals(
            "0x47c1d6bc2bb46c1176e8ad195e125e3292edfe594ef789df55df3e49bb97228e",
            "0x" + OfflineProtocol.voucherDigest(voucher).toHex(),
        )
        assertEquals(
            "0xe85604206386c5aa56c24560a6239f21b7ab1b31bd6c5a892e986ee9990b812b",
            OfflineProtocol.requestHash(request),
        )
        assertEquals(voucher, OfflineProtocol.decodeVoucher(request.voucher))
    }

    @Test
    fun rejectsExpiredOrCrossRequestAttendeeResponse() {
        val (_, request) = OfflineProtocol.prepareVoucher(
            snapshot, 1, h('8'), BigInteger.ZERO, h('a'), h('b'), BigInteger("125"), h('c'),
            100, 150, "request:android",
        )
        val invalidSignature = "0x" + "00".repeat(65)
        assertThrows(InvalidOfflineExchange::class.java) {
            OfflineProtocol.verifyAttendee(
                request,
                AttendeeVoucherResponse(h('0'), invalidSignature),
                snapshot.attendeeSigner,
                151,
            )
        }
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
