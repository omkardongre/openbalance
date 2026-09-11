// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccountFactory } from "../src/accounts/AccountFactory.sol";
import { OpenBalanceAccount } from "../src/accounts/OpenBalanceAccount.sol";
import { EventFactory } from "../src/payments/EventFactory.sol";
import { EventRegistry } from "../src/payments/EventRegistry.sol";
import { SettlementLedger } from "../src/payments/SettlementLedger.sol";
import { ResilienceVault } from "../src/payments/ResilienceVault.sol";

interface VmReserve {
    function publicKeyP256(uint256 key) external pure returns (uint256, uint256);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32, bytes32);
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract ReserveToken is ERC20 {
    constructor() ERC20("Reserve Test USDC", "rtUSDC") { }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract ReserveChannelTest {
    VmReserve private constant vm =
        VmReserve(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 142;
    uint256 private constant RECOVERY_KEY = 143;
    uint256 private constant VENDOR_KEY = 144;
    uint256 private constant TERMINAL_KEY = 145;
    uint256 private constant CHANNEL_KEY = 146;
    uint256 private constant DEADLINE = 1_000;
    bytes32 private constant EVENT_ID = keccak256("event:reserve");
    bytes32 private constant VENDOR_ID = keccak256("vendor:reserve");
    bytes32 private constant TERMINAL_ID = keccak256("terminal:reserve:1");
    bytes32 private constant CHANNEL_ID = keccak256("channel:reserve:1");
    bytes32 private constant GENESIS = keccak256("channel:reserve:genesis");
    address private constant VENDOR_DESTINATION = address(0x2001);
    address private constant ORGANIZER_DESTINATION = address(0x2002);
    address private constant PLATFORM_DESTINATION = address(0x2003);

    ReserveToken private token;
    OpenBalanceAccount private account;
    EventRegistry private registry;
    SettlementLedger private ledger;
    ResilienceVault private vault;

    function setUp() public {
        token = new ReserveToken();
        AccountFactory accountFactory = new AccountFactory();
        account = OpenBalanceAccount(
            accountFactory.create(
                owners(), sha256("localhost"), "http://localhost:3000", bytes32(uint256(199))
            )
        );
        token.mint(address(account), 100_000);

        EventFactory eventFactory = new EventFactory();
        EventFactory.Deployment memory deployment =
            eventFactory.deployEvent(EVENT_ID, address(token), address(0x999), 500);
        registry = EventRegistry(deployment.registry);
        ledger = SettlementLedger(deployment.ledger);
        vault = ResilienceVault(deployment.vault);
        registry.registerConfig(
            1,
            EventRegistry.Config({
                validAfter: 0,
                validUntil: 900,
                organizerFeeBps: 200,
                platformFeeBps: 100,
                maximumAcceptanceDuration: 300,
                maximumSubmissionDelay: 120,
                organizerDestination: ORGANIZER_DESTINATION,
                platformDestination: PLATFORM_DESTINATION,
                termsHash: keccak256("reserve-terms:v1"),
                enabled: true
            })
        );
        registry.registerVendor(VENDOR_ID, vm.addr(VENDOR_KEY));
        bytes32 destinationDigest =
            registry.destinationDigest(VENDOR_ID, 1, VENDOR_DESTINATION, DEADLINE);
        registry.registerDestination(
            VENDOR_ID, 1, VENDOR_DESTINATION, DEADLINE, signature(VENDOR_KEY, destinationDigest)
        );
        registry.registerTerminal(TERMINAL_ID, 1, VENDOR_ID, vm.addr(TERMINAL_KEY), 0, 900);
    }

    function owners() private pure returns (OpenBalanceAccount.Ownership memory value) {
        (uint256 x, uint256 y) = vm.publicKeyP256(OWNER_KEY);
        value.primary = OpenBalanceAccount.Key(bytes32(x), bytes32(y));
        value.recovery = vm.addr(RECOVERY_KEY);
    }

    function assertion(bytes32 digest) private pure returns (WebAuthn.WebAuthnAuth memory auth) {
        auth.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), bytes4(0));
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        (auth.r, auth.s) = vm.signP256(
            OWNER_KEY,
            sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))))
        );
    }

    function signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function config() private view returns (ResilienceVault.ChannelConfig memory value) {
        value = ResilienceVault.ChannelConfig({
            channelId: CHANNEL_ID,
            eventId: EVENT_ID,
            asset: address(token),
            reserveUnits: 10_000,
            vendorId: VENDOR_ID,
            vendorDestinationVersion: 1,
            terminalInstanceId: TERMINAL_ID,
            terminalKeyVersion: 1,
            attendeeChannelSigner: vm.addr(CHANNEL_KEY),
            configVersion: 1,
            organizerFeeBps: 200,
            platformFeeBps: 100,
            maxPerVoucher: 4_000,
            maxVoucherCount: 3,
            acceptFrom: 100,
            acceptUntil: 220,
            submitUntil: 280,
            genesisDigest: GENESIS
        });
    }

    function open(ResilienceVault.ChannelConfig memory value) private {
        bytes32 termsHash = vault.channelTermsHash(value, address(account));
        bytes32 command = account.commandDigest(
            account.OPEN_CHANNEL(),
            keccak256(
                abi.encode(
                    address(vault), value.channelId, value.reserveUnits, uint256(10_000), termsHash
                )
            ),
            DEADLINE
        );
        account.openReserveChannel(
            address(vault), value, 10_000, DEADLINE, false, assertion(command)
        );
    }

    function voucher(
        uint32 sequence,
        bytes32 previousDigest,
        bytes32 paymentId,
        uint256 gross,
        uint256 cumulative
    ) private view returns (ResilienceVault.Voucher memory value) {
        value = ResilienceVault.Voucher({
            protocolVersion: 1,
            chainId: block.chainid,
            vault: address(vault),
            channelId: CHANNEL_ID,
            sequence: sequence,
            previousVoucherDigest: previousDigest,
            paymentId: paymentId,
            orderRefHash: keccak256(abi.encode("offline-order", sequence)),
            grossUnits: gross,
            cumulativeGrossUnits: cumulative,
            receiptCommitment: keccak256(abi.encode("offline-receipt", sequence)),
            acceptedAt: 150,
            acceptUntil: 220,
            submitUntil: 280,
            configVersion: 1
        });
    }

    function settle(ResilienceVault.Voucher memory value) private {
        bytes32 digest = vault.voucherDigest(value);
        vault.settleVoucher(value, signature(CHANNEL_KEY, digest), signature(TERMINAL_KEY, digest));
    }

    function testOwnerOpensExactImmutableReserve() public {
        ResilienceVault.ChannelConfig memory value = config();
        open(value);
        (address original, uint256 spent, uint32 next, bytes32 previous, bool reclaimed) =
            vault.channelState(CHANNEL_ID);
        assert(original == address(account));
        assert(spent == 0 && next == 1 && previous == GENESIS && !reclaimed);
        assert(token.balanceOf(address(account)) == 90_000);
        assert(token.balanceOf(address(vault)) == 10_000);
        assert(token.allowance(address(account), address(vault)) == 0);
        assert(vault.totalReserved() == 10_000);
        assert(vault.reservedFor(address(account)) == 10_000);

        ResilienceVault.ChannelConfig memory second = config();
        second.channelId = keccak256("channel:reserve:2");
        bytes32 termsHash = vault.channelTermsHash(second, address(account));
        bytes32 command = account.commandDigest(
            account.OPEN_CHANNEL(),
            keccak256(
                abi.encode(
                    address(vault),
                    second.channelId,
                    second.reserveUnits,
                    uint256(15_000),
                    termsHash
                )
            ),
            DEADLINE
        );
        WebAuthn.WebAuthnAuth memory auth = assertion(command);
        vm.expectRevert(OpenBalanceAccount.InvalidPolicy.selector);
        account.openReserveChannel(address(vault), second, 15_000, DEADLINE, false, auth);

        vm.expectRevert(ResilienceVault.AlreadyExists.selector);
        vault.openChannel(value);
    }

    function testVouchersSettleInOrderAfterTerminalRevocation() public {
        open(config());
        ResilienceVault.Voucher memory first =
            voucher(1, GENESIS, keccak256("offline-payment:1"), 4_000, 4_000);
        settle(first);
        bytes32 firstDigest = vault.voucherDigest(first);
        registry.setTerminalEnabled(TERMINAL_ID, 1, false);
        ResilienceVault.Voucher memory second =
            voucher(2, firstDigest, keccak256("offline-payment:2"), 1_000, 5_000);
        settle(second);

        (, uint256 spent, uint32 next, bytes32 previous,) = vault.channelState(CHANNEL_ID);
        assert(spent == 5_000 && next == 3 && previous == vault.voucherDigest(second));
        assert(vault.totalReserved() == 5_000);
        assert(vault.reservedFor(address(account)) == 5_000);
        assert(token.balanceOf(address(vault)) == 5_000);
        assert(token.balanceOf(address(ledger)) == 5_000);
        assert(ledger.totalLiability() == 5_000);
        bytes32 vendorBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("VENDOR"), VENDOR_ID, uint256(1)));
        assert(ledger.credits(vendorBeneficiary) == 4_850);
    }

    function testVoucherRejectsWrongSignaturesSequenceReplayAndCap() public {
        open(config());
        ResilienceVault.Voucher memory first =
            voucher(1, GENESIS, keccak256("offline-payment:bounds:1"), 4_000, 4_000);
        bytes32 digest = vault.voucherDigest(first);
        bytes memory attendee = signature(CHANNEL_KEY, digest);
        bytes memory terminal = signature(TERMINAL_KEY, digest);
        bytes memory wrongAttendee = signature(VENDOR_KEY, digest);
        vm.expectRevert(ResilienceVault.InvalidAttendeeSignature.selector);
        vault.settleVoucher(first, wrongAttendee, terminal);
        bytes memory wrongTerminal = signature(VENDOR_KEY, digest);
        vm.expectRevert(ResilienceVault.InvalidTerminalSignature.selector);
        vault.settleVoucher(first, attendee, wrongTerminal);

        settle(first);
        vm.expectRevert(ResilienceVault.InvalidVoucher.selector);
        vault.settleVoucher(first, attendee, terminal);

        ResilienceVault.Voucher memory duplicatePayment =
            voucher(2, digest, first.paymentId, 1_000, 5_000);
        bytes32 duplicateDigest = vault.voucherDigest(duplicatePayment);
        bytes memory duplicateAttendee = signature(CHANNEL_KEY, duplicateDigest);
        bytes memory duplicateTerminal = signature(TERMINAL_KEY, duplicateDigest);
        vm.expectRevert(SettlementLedger.InvalidPolicy.selector);
        vault.settleVoucher(duplicatePayment, duplicateAttendee, duplicateTerminal);
        (, uint256 spentAfterDuplicate, uint32 nextAfterDuplicate,,) =
            vault.channelState(CHANNEL_ID);
        assert(spentAfterDuplicate == 4_000 && nextAfterDuplicate == 2);

        ResilienceVault.Voucher memory gap =
            voucher(3, digest, keccak256("offline-payment:gap"), 1_000, 5_000);
        bytes32 gapDigest = vault.voucherDigest(gap);
        vm.expectRevert(ResilienceVault.InvalidVoucher.selector);
        vault.settleVoucher(
            gap, signature(CHANNEL_KEY, gapDigest), signature(TERMINAL_KEY, gapDigest)
        );

        ResilienceVault.Voucher memory overCap =
            voucher(2, digest, keccak256("offline-payment:cap"), 4_001, 8_001);
        bytes32 overDigest = vault.voucherDigest(overCap);
        vm.expectRevert(ResilienceVault.InvalidVoucher.selector);
        vault.settleVoucher(
            overCap, signature(CHANNEL_KEY, overDigest), signature(TERMINAL_KEY, overDigest)
        );
    }

    function testReclaimIsPermissionlessFinalAndPaysOriginalAccount() public {
        open(config());
        ResilienceVault.Voucher memory first =
            voucher(1, GENESIS, keccak256("offline-payment:reclaim"), 4_000, 4_000);
        settle(first);
        vm.expectRevert(ResilienceVault.InvalidPolicy.selector);
        vault.reclaim(CHANNEL_ID);

        vm.warp(280);
        vm.prank(address(0x777));
        uint256 returned = vault.reclaim(CHANNEL_ID);
        assert(returned == 6_000);
        assert(token.balanceOf(address(account)) == 96_000);
        assert(token.balanceOf(address(vault)) == 0);
        assert(vault.totalReserved() == 0);
        assert(vault.reservedFor(address(account)) == 0);
        (,,,, bool reclaimed) = vault.channelState(CHANNEL_ID);
        assert(reclaimed);

        vm.expectRevert(ResilienceVault.InvalidPolicy.selector);
        vault.reclaim(CHANNEL_ID);
        ResilienceVault.Voucher memory late =
            voucher(2, vault.voucherDigest(first), keccak256("offline-payment:late"), 1_000, 5_000);
        bytes32 digest = vault.voucherDigest(late);
        vm.expectRevert(ResilienceVault.InvalidVoucher.selector);
        vault.settleVoucher(late, signature(CHANNEL_KEY, digest), signature(TERMINAL_KEY, digest));
    }

    function testSharedChannelAndVoucherHashesMatch() public view {
        ResilienceVault.ChannelConfig memory channel = ResilienceVault.ChannelConfig({
            channelId: keccak256("channel:1"),
            eventId: keccak256("event:market-2026"),
            asset: address(0x0303),
            reserveUnits: 20_000_000,
            vendorId: keccak256("vendor:noodles"),
            vendorDestinationVersion: 1,
            terminalInstanceId: keccak256("terminal:noodles:1"),
            terminalKeyVersion: 1,
            attendeeChannelSigner: address(0x0505),
            configVersion: 1,
            organizerFeeBps: 200,
            platformFeeBps: 100,
            maxPerVoucher: 5_000_000,
            maxVoucherCount: 4,
            acceptFrom: 1_800_000_000,
            acceptUntil: 1_800_000_120,
            submitUntil: 1_800_000_180,
            genesisDigest: keccak256("channel:1:genesis")
        });
        assert(
            vault.channelTermsHashFor(10_143, address(0x0606), address(0x0202), channel)
                == 0x7d36cf640b5cdb33594c920e1287c8e000ea63de1676f4d3db8f7bed54393d36
        );
        ResilienceVault.Voucher memory value = ResilienceVault.Voucher({
            protocolVersion: 1,
            chainId: 10_143,
            vault: address(0x0606),
            channelId: channel.channelId,
            sequence: 1,
            previousVoucherDigest: channel.genesisDigest,
            paymentId: keccak256("offline-payment:1"),
            orderRefHash: keccak256("offline-order:1"),
            grossUnits: 4_000_000,
            cumulativeGrossUnits: 4_000_000,
            receiptCommitment: keccak256("offline-receipt:1"),
            acceptedAt: 1_800_000_060,
            acceptUntil: channel.acceptUntil,
            submitUntil: channel.submitUntil,
            configVersion: 1
        });
        assert(
            vault.voucherStructHash(value)
                == 0xf0fd7d5862fecf801ddacf176bf024e7f2e9958cf34ea4bc8d83abd9a2faf7e1
        );
    }

    function testFuzzSettlementAndReclaimConserveCollateral(uint256 input) public {
        uint256 amount = input % 4_000 + 1;
        open(config());
        ResilienceVault.Voucher memory value = voucher(
            1, GENESIS, keccak256(abi.encode("offline-payment:fuzz", input)), amount, amount
        );
        settle(value);
        vm.warp(280);
        vault.reclaim(CHANNEL_ID);
        assert(token.balanceOf(address(account)) == 100_000 - amount);
        assert(token.balanceOf(address(vault)) == 0);
        assert(token.balanceOf(address(ledger)) == amount);
        assert(ledger.totalLiability() == amount);
        assert(vault.totalReserved() == 0);
    }

    function testActivationRejectsPauseAndUnboundedWindows() public {
        ResilienceVault.ChannelConfig memory value = config();
        value.submitUntil = 400;
        bytes32 termsHash = vault.channelTermsHash(value, address(account));
        bytes32 command = account.commandDigest(
            account.OPEN_CHANNEL(),
            keccak256(
                abi.encode(
                    address(vault), value.channelId, value.reserveUnits, uint256(10_000), termsHash
                )
            ),
            DEADLINE
        );
        WebAuthn.WebAuthnAuth memory auth = assertion(command);
        vm.expectRevert(EventRegistry.Unavailable.selector);
        account.openReserveChannel(address(vault), value, 10_000, DEADLINE, false, auth);

        value = config();
        registry.pauseOnline();
        termsHash = vault.channelTermsHash(value, address(account));
        command = account.commandDigest(
            account.OPEN_CHANNEL(),
            keccak256(
                abi.encode(
                    address(vault), value.channelId, value.reserveUnits, uint256(10_000), termsHash
                )
            ),
            DEADLINE
        );
        auth = assertion(command);
        vm.expectRevert(EventRegistry.Unavailable.selector);
        account.openReserveChannel(address(vault), value, 10_000, DEADLINE, false, auth);
    }
}
