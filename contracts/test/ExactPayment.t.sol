// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccountFactory } from "../src/accounts/AccountFactory.sol";
import { OpenBalanceAccount } from "../src/accounts/OpenBalanceAccount.sol";
import { PaymentTypes } from "../src/payments/PaymentTypes.sol";
import { EventRegistry } from "../src/payments/EventRegistry.sol";
import { SettlementLedger } from "../src/payments/SettlementLedger.sol";
import { ExactPayRouter } from "../src/payments/ExactPayRouter.sol";

interface VmPayment {
    function publicKeyP256(uint256 key) external pure returns (uint256, uint256);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32, bytes32);
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
}

contract PaymentToken is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") { }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract ExactPaymentTest {
    VmPayment private constant vm =
        VmPayment(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 42;
    uint256 private constant VENDOR_KEY = 81;
    uint256 private constant TERMINAL_KEY = 82;
    uint256 private constant DEADLINE = 1000;
    bytes32 private constant EVENT_ID = keccak256("event:market-2026");
    bytes32 private constant VENDOR_ID = keccak256("vendor:noodles");
    bytes32 private constant TERMINAL_ID = keccak256("terminal:noodles:1");
    address private constant VENDOR_DESTINATION = address(0x1001);
    address private constant ORGANIZER_DESTINATION = address(0x1002);
    address private constant PLATFORM_DESTINATION = address(0x1003);

    PaymentToken private token;
    OpenBalanceAccount private account;
    EventRegistry private registry;
    SettlementLedger private ledger;
    ExactPayRouter private router;

    function setUp() public {
        token = new PaymentToken();
        AccountFactory factory = new AccountFactory();
        account = OpenBalanceAccount(
            factory.create(
                owners(), sha256("localhost"), "http://localhost:3000", bytes32(uint256(99))
            )
        );
        token.mint(address(account), 1_000_000);
        registry = new EventRegistry(EVENT_ID, address(token), address(this), address(0x999), 500);
        ledger = new SettlementLedger(address(registry), address(token));
        router = new ExactPayRouter(address(registry), address(ledger));
        ledger.bindRouter(address(router));

        registry.registerConfig(
            1,
            EventRegistry.Config({
                validAfter: 0,
                validUntil: 900,
                organizerFeeBps: 200,
                platformFeeBps: 100,
                organizerDestination: ORGANIZER_DESTINATION,
                platformDestination: PLATFORM_DESTINATION,
                termsHash: keccak256("terms:v1"),
                enabled: true
            })
        );
        registry.registerVendor(VENDOR_ID, vm.addr(VENDOR_KEY));
        bytes32 destinationDigest =
            registry.destinationDigest(VENDOR_ID, 1, VENDOR_DESTINATION, DEADLINE);
        registry.registerDestination(
            VENDOR_ID,
            1,
            VENDOR_DESTINATION,
            DEADLINE,
            ecdsaSignature(VENDOR_KEY, destinationDigest)
        );
        registry.registerTerminal(TERMINAL_ID, 1, VENDOR_ID, vm.addr(TERMINAL_KEY), 0, 900);
    }

    function owners() private pure returns (OpenBalanceAccount.Ownership memory value) {
        (uint256 x, uint256 y) = vm.publicKeyP256(OWNER_KEY);
        value.primary = OpenBalanceAccount.Key(bytes32(x), bytes32(y));
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

    function intent(bytes32 paymentId) private view returns (PaymentTypes.Intent memory value) {
        value = PaymentTypes.Intent({
            schemaVersion: 1,
            chainId: block.chainid,
            router: address(router),
            eventId: EVENT_ID,
            paymentId: paymentId,
            payerAccount: address(account),
            orderRefHash: keccak256("erpnext:order:42:v1"),
            vendorId: VENDOR_ID,
            vendorDestinationVersion: 1,
            terminalInstanceId: TERMINAL_ID,
            asset: address(token),
            grossUnits: 12_345,
            organizerFeeBps: 200,
            platformFeeBps: 100,
            configVersion: 1,
            receiptCommitment: keccak256("private-receipt-with-random-salt"),
            validAfter: 0,
            expiresAt: 500,
            terminalKeyVersion: 1
        });
    }

    function terminalSignature(PaymentTypes.Intent memory value)
        private
        view
        returns (bytes memory)
    {
        return ecdsaSignature(TERMINAL_KEY, router.intentDigest(value));
    }

    function ecdsaSignature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function pay(PaymentTypes.Intent memory value) private {
        (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth) =
            preparePay(value);
        account.pay(address(router), encoded, signature, DEADLINE, false, auth);
    }

    function preparePay(PaymentTypes.Intent memory value)
        private
        view
        returns (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth)
    {
        encoded = abi.encode(value);
        signature = terminalSignature(value);
        bytes32 digest = router.intentDigest(value);
        bytes32 command = account.commandDigest(
            account.PAY(), keccak256(abi.encode(address(router), digest)), DEADLINE
        );
        auth = assertion(command);
    }

    function cancel(PaymentTypes.Intent memory value) private {
        (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth) =
            prepareCancel(value);
        account.cancelPayment(address(router), encoded, signature, DEADLINE, false, auth);
    }

    function prepareCancel(PaymentTypes.Intent memory value)
        private
        view
        returns (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth)
    {
        encoded = abi.encode(value);
        signature = terminalSignature(value);
        bytes32 digest = router.intentDigest(value);
        bytes32 command = account.commandDigest(
            account.CANCEL(), keccak256(abi.encode(address(router), digest)), DEADLINE
        );
        auth = assertion(command);
    }

    function testExactPaymentAllocatesAndClearsAllowance() public {
        PaymentTypes.Intent memory value = intent(keccak256("payment:1"));
        pay(value);
        assert(token.balanceOf(address(account)) == 987_655);
        assert(token.balanceOf(address(ledger)) == 12_345);
        assert(token.allowance(address(account), address(router)) == 0);
        assert(ledger.totalLiability() == 12_345);
        assert(router.paymentStates(value.paymentId) == ExactPayRouter.PaymentState.PAID);

        bytes32 vendorBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("VENDOR"), VENDOR_ID, uint256(1)));
        bytes32 organizerBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("ORGANIZER"), uint256(1)));
        bytes32 platformBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("PLATFORM"), uint256(1)));
        assert(ledger.credits(vendorBeneficiary) == 11_976);
        assert(ledger.credits(organizerBeneficiary) == 246);
        assert(ledger.credits(platformBeneficiary) == 123);

        vm.prank(address(0x777));
        ledger.withdrawFor(vendorBeneficiary);
        assert(token.balanceOf(VENDOR_DESTINATION) == 11_976);
        assert(ledger.totalLiability() == 369);
        vm.expectRevert(SettlementLedger.NothingToWithdraw.selector);
        ledger.withdrawFor(vendorBeneficiary);
    }

    function testPaymentReplayFailsAndRollsBackAccountNonce() public {
        PaymentTypes.Intent memory value = intent(keccak256("payment:replay"));
        pay(value);
        uint256 consumed = account.nonce();
        (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth) =
            preparePay(value);
        vm.expectRevert(ExactPayRouter.PaymentResolved.selector);
        account.pay(address(router), encoded, signature, DEADLINE, false, auth);
        assert(account.nonce() == consumed);
        assert(token.balanceOf(address(ledger)) == value.grossUnits);
    }

    function testAlteredIntentAndWrongTerminalFailAtomically() public {
        PaymentTypes.Intent memory value = intent(keccak256("payment:altered"));
        bytes memory originalTerminalSignature = terminalSignature(value);
        value.grossUnits += 1;
        bytes memory encoded = abi.encode(value);
        bytes32 digest = router.intentDigest(value);
        bytes32 command = account.commandDigest(
            account.PAY(), keccak256(abi.encode(address(router), digest)), DEADLINE
        );
        WebAuthn.WebAuthnAuth memory auth = assertion(command);
        vm.expectRevert(ExactPayRouter.InvalidTerminalSignature.selector);
        account.pay(address(router), encoded, originalTerminalSignature, DEADLINE, false, auth);
        assert(account.nonce() == 0 && token.balanceOf(address(ledger)) == 0);
    }

    function testPauseBlocksPaymentButHistoricalCancellationRemains() public {
        PaymentTypes.Intent memory value = intent(keccak256("payment:cancel"));
        registry.pauseOnline();
        (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth) =
            preparePay(value);
        vm.expectRevert(EventRegistry.Unavailable.selector);
        account.pay(address(router), encoded, signature, DEADLINE, false, auth);
        cancel(value);
        assert(router.paymentStates(value.paymentId) == ExactPayRouter.PaymentState.CANCELLED);
        (encoded, signature, auth) = preparePay(value);
        vm.expectRevert(ExactPayRouter.PaymentResolved.selector);
        account.pay(address(router), encoded, signature, DEADLINE, false, auth);
    }

    function testPaymentWinsCancellationRace() public {
        PaymentTypes.Intent memory value = intent(keccak256("payment:paid-first"));
        pay(value);
        (bytes memory encoded, bytes memory signature, WebAuthn.WebAuthnAuth memory auth) =
            prepareCancel(value);
        vm.expectRevert(ExactPayRouter.PaymentResolved.selector);
        account.cancelPayment(address(router), encoded, signature, DEADLINE, false, auth);
    }

    function testDestinationRequiresVendorApprovalAndCannotBeReplaced() public {
        vm.expectRevert(EventRegistry.Unauthorized.selector);
        registry.registerDestination(
            VENDOR_ID,
            2,
            address(0x2001),
            DEADLINE,
            ecdsaSignature(TERMINAL_KEY, keccak256("wrong"))
        );

        bytes32 digest = registry.destinationDigest(VENDOR_ID, 1, address(0x2001), DEADLINE);
        vm.expectRevert(EventRegistry.AlreadyExists.selector);
        registry.registerDestination(
            VENDOR_ID, 1, address(0x2001), DEADLINE, ecdsaSignature(VENDOR_KEY, digest)
        );
    }

    function testRiskOperatorCanDisableButCannotEnableTerminal() public {
        address risk = address(0x999);
        vm.prank(risk);
        registry.setTerminalEnabled(TERMINAL_ID, 1, false);
        vm.prank(risk);
        vm.expectRevert(EventRegistry.Unauthorized.selector);
        registry.setTerminalEnabled(TERMINAL_ID, 1, true);
        registry.setTerminalEnabled(TERMINAL_ID, 1, true);
    }

    function testCanonicalIntentStructHashMatchesSharedVector() public view {
        PaymentTypes.Intent memory value = PaymentTypes.Intent({
            schemaVersion: 1,
            chainId: 10_143,
            router: address(0x0101),
            eventId: keccak256("event:market-2026"),
            paymentId: keccak256("payment:1"),
            payerAccount: address(0x0202),
            orderRefHash: keccak256("order:42:v1"),
            vendorId: keccak256("vendor:noodles"),
            vendorDestinationVersion: 1,
            terminalInstanceId: keccak256("terminal:noodles:1"),
            asset: address(0x0303),
            grossUnits: 12_345_000,
            organizerFeeBps: 200,
            platformFeeBps: 100,
            configVersion: 1,
            receiptCommitment: keccak256("salted-private-receipt"),
            validAfter: 1_800_000_000,
            expiresAt: 1_800_000_300,
            terminalKeyVersion: 1
        });
        assert(
            router.intentStructHash(value)
                == 0x43dafb74a49c5b8df4499917fd6b9b96af7ce26e59c53bd4eb1d0e8bad56928c
        );
    }

    function testFuzzPaymentConservesAllocations(uint256 input) public {
        uint256 gross = input % 1e18 + 1;
        token.mint(address(account), gross);
        PaymentTypes.Intent memory value = intent(keccak256(abi.encode("payment:fuzz", input)));
        value.grossUnits = gross;
        pay(value);

        bytes32 vendorBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("VENDOR"), VENDOR_ID, uint256(1)));
        bytes32 organizerBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("ORGANIZER"), uint256(1)));
        bytes32 platformBeneficiary =
            keccak256(abi.encode(EVENT_ID, keccak256("PLATFORM"), uint256(1)));
        assert(
            ledger.credits(vendorBeneficiary) + ledger.credits(organizerBeneficiary)
                    + ledger.credits(platformBeneficiary) == gross
        );
        assert(ledger.totalLiability() == gross && token.balanceOf(address(ledger)) == gross);
    }
}
