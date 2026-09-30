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

    // A Monad testnet exchange: the vault's own voucherDigest for this voucher, and a response signed
    // by the headless attendee with the channel key the vault records for the channel.
    @Test
    fun verifiesAttendeeResponseAgainstVaultDigest() {
        val request = TerminalPaymentRequest(
            requestId = "2f768306-0b0b-4346-89c9-f175304fecaa",
            terminalId = "0x56f7f724f83c34f5489d09598305ff0f062b1fb038836eec9d658ddd07258e83",
            channelId = "0x9aea21cd7909272860d7c5592fc3e92c5bc3bb8a3086148a1431528902bca55b",
            paymentId = "0xbceb5b64fe215630f7d82a0c432f10f1f9dbf9b9cfb512c7a3207cded8683ba1",
            sequence = 1,
            voucher = "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000279f0000000000000000000000001537aded24e15fddc773172c263335b456ae2e5a9aea21cd7909272860d7c5592fc3e92c5bc3bb8a3086148a1431528902bca55b0000000000000000000000000000000000000000000000000000000000000001a3355e7015866c65d47ac585ee8654aa5cc4eabb94678097a210d114cc6076f8bceb5b64fe215630f7d82a0c432f10f1f9dbf9b9cfb512c7a3207cded8683ba10c9035562a6d9894510e553705a4cf823a9521caa7bebb2152b44746ed78a96200000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f4240ba42165a24f65677ddbc52b26dae0b5d0ad7a81b95cfbd23bbbe3a03f65f9ac5000000000000000000000000000000000000000000000000000000006abca052000000000000000000000000000000000000000000000000000000006abca851000000000000000000000000000000000000000000000000000000006abcaaa90000000000000000000000000000000000000000000000000000000000000001",
            expiresAt = 1790746829,
        )
        assertEquals(
            "0xfaf052b928a51260c69b607dbbf11a2e5b4af61c3e76210b1f5c1c7ab98391ef",
            "0x" + OfflineProtocol.voucherDigest(OfflineProtocol.decodeVoucher(request.voucher)).toHex(),
        )
        assertEquals("0x6b2498b3b2c57cf7919a92c8a553ad4ee924efac82368f9d98a31b6294a99ed1", OfflineProtocol.requestHash(request))
        val signature = "0xd6d50a8e5a3f3ffcc0b5bc926e0b6b353faadf44fd1987103ef5ebfa1d5ce1153a3a9a174b4b1d45696db87ffb7401b63b3dd1f66f0816efc37e2992cbcef0c41b"
        OfflineProtocol.verifyAttendee(
            request, AttendeeVoucherResponse(request.requestHash(), signature),
            "0xeAAefe7F108510D987442A51730C1b3a8A34D582", 1790746800,
        )
    }

    private fun TerminalPaymentRequest.requestHash() = OfflineProtocol.requestHash(this)

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

    @Test
    fun matchesSharedTerminalIngressDigest() {
        assertEquals(
            "e9024814580bd8331ef833d1fecbcbac93622d652efc92f5bb0e6edc183aa070",
            OfflineProtocol.terminalIngressDigest(
                "https://relay.example/v1/vouchers",
                h('7'),
                BigInteger.ONE,
                110,
                h('9'),
                h('a'),
            ).toHex(),
        )
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
