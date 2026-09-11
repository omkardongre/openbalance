// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccountFactory } from "../src/accounts/AccountFactory.sol";
import { OpenBalanceAccount } from "../src/accounts/OpenBalanceAccount.sol";
import { PaymentTypes } from "../src/payments/PaymentTypes.sol";
import { EventFactory } from "../src/payments/EventFactory.sol";
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
    function warp(uint256 timestamp) external;
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
    uint256 private constant SESSION_KEY = 83;
    uint256 private constant RECOVERY_KEY = 84;
    uint256 private constant DEADLINE = 1000;
    bytes32 private constant EVENT_ID = keccak256("event:market-2026");
    bytes32 private constant SESSION_ID = keccak256("session:attendee-device:1");
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
        EventFactory eventFactory = new EventFactory();
        EventFactory.Deployment memory deployment =
            eventFactory.deployEvent(EVENT_ID, address(token), address(0x999), 500);
        registry = EventRegistry(deployment.registry);
        ledger = SettlementLedger(deployment.ledger);
        router = ExactPayRouter(deployment.router);

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

    function sessionConfig(uint256 maxPerPayment, uint256 maxTotal)
        private
        view
        returns (OpenBalanceAccount.OnlineSessionConfig memory config)
    {
        (uint256 x, uint256 y) = vm.publicKeyP256(SESSION_KEY);
        config = OpenBalanceAccount.OnlineSessionConfig({
            sessionId: SESSION_ID,
            signer: OpenBalanceAccount.Key(bytes32(x), bytes32(y)),
            eventId: EVENT_ID,
            router: address(router),
            asset: address(token),
            maxPerPayment: maxPerPayment,
            maxTotal: maxTotal,
            validAfter: 0,
            validUntil: 800
        });
    }

    function setSession(OpenBalanceAccount.OnlineSessionConfig memory config) private {
        bytes32 digest = account.commandDigest(
            account.SET_SESSION(), account.onlineSessionTermsHash(config), DEADLINE
        );
        account.setOnlineSession(config, DEADLINE, false, assertion(digest));
    }

    function revokeSession(uint256 revision) private {
        bytes32 digest = account.commandDigest(
            account.REVOKE_SESSION(), keccak256(abi.encode(SESSION_ID, revision)), DEADLINE
        );
        account.revokeOnlineSession(SESSION_ID, revision, DEADLINE, false, assertion(digest));
    }

    function sessionSignature(PaymentTypes.Intent memory value, uint256 revision)
        private
        view
        returns (bytes32 r, bytes32 s)
    {
        return vm.signP256(
            SESSION_KEY,
            account.sessionPaymentDigest(SESSION_ID, revision, router.intentDigest(value))
        );
    }

    function sessionPay(PaymentTypes.Intent memory value, uint256 revision) private {
        (bytes32 r, bytes32 s) = sessionSignature(value, revision);
        account.payWithOnlineSession(SESSION_ID, abi.encode(value), terminalSignature(value), r, s);
    }

    function sessionState()
        private
        view
        returns (uint256 spentGross, uint256 revision, bool active, uint256 accountEpoch)
    {
        return account.onlineSessionState(SESSION_ID);
    }

    function refundIntent(
        PaymentTypes.Intent memory payment,
        bytes32 refundId,
        uint256 refundUnits,
        uint256 cumulativeRefundUnits,
        uint256 vendorCreditUnits
    ) private view returns (PaymentTypes.RefundIntent memory value) {
        value = PaymentTypes.RefundIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            router: address(router),
            eventId: EVENT_ID,
            refundId: refundId,
            paymentId: payment.paymentId,
            payerAccount: address(account),
            vendorId: VENDOR_ID,
            asset: address(token),
            refundUnits: refundUnits,
            cumulativeRefundUnits: cumulativeRefundUnits,
            vendorCreditUnits: vendorCreditUnits,
            fundingSource: vm.addr(VENDOR_KEY),
            validAfter: 0,
            expiresAt: 500
        });
    }

    function refund(PaymentTypes.RefundIntent memory value) private {
        router.refund(value, ecdsaSignature(VENDOR_KEY, router.refundDigest(value)));
    }

    function fundRefunds(uint256 amount) private {
        address vendor = vm.addr(VENDOR_KEY);
        token.mint(vendor, amount);
        vm.prank(vendor);
        token.approve(address(router), amount);
    }

    function vendorBeneficiaryId() private pure returns (bytes32) {
        return keccak256(abi.encode(EVENT_ID, keccak256("VENDOR"), VENDOR_ID, uint256(1)));
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

    function testLedgerRejectsSelfBeneficiaryDestination() public {
        registry.registerConfig(
            2,
            EventRegistry.Config({
                validAfter: 0,
                validUntil: 900,
                organizerFeeBps: 200,
                platformFeeBps: 100,
                maximumAcceptanceDuration: 300,
                maximumSubmissionDelay: 120,
                organizerDestination: address(ledger),
                platformDestination: PLATFORM_DESTINATION,
                termsHash: keccak256("terms:self-destination"),
                enabled: true
            })
        );
        PaymentTypes.Intent memory value = intent(keccak256("payment:self-destination"));
        value.configVersion = 2;
        (bytes memory encoded, bytes memory terminal, WebAuthn.WebAuthnAuth memory auth) =
            preparePay(value);
        vm.expectRevert(SettlementLedger.InvalidPolicy.selector);
        account.pay(address(router), encoded, terminal, DEADLINE, false, auth);
        assert(token.balanceOf(address(ledger)) == 0 && ledger.totalLiability() == 0);
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

    function testPartialRefundsUseVendorCreditAndExactFreshFunding() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:mixed"));
        pay(payment);
        PaymentTypes.RefundIntent memory first =
            refundIntent(payment, keccak256("refund:mixed:1"), 5_000, 5_000, 5_000);
        refund(first);
        assert(token.balanceOf(address(account)) == 992_655);
        assert(ledger.credits(vendorBeneficiaryId()) == 6_976);
        assert(ledger.totalLiability() == 7_345);

        fundRefunds(369);
        PaymentTypes.RefundIntent memory second =
            refundIntent(payment, keccak256("refund:mixed:2"), 7_345, 12_345, 6_976);
        refund(second);
        (,,, uint256 refundedGross,) = ledger.refundTerms(payment.paymentId);
        assert(refundedGross == payment.grossUnits);
        assert(token.balanceOf(address(account)) == 1_000_000);
        assert(token.balanceOf(address(ledger)) == 369);
        assert(ledger.totalLiability() == 369);
        assert(ledger.credits(vendorBeneficiaryId()) == 0);
        assert(ledger.refunds(second.refundId) == payment.paymentId);
    }

    function testRefundRequiresVendorSignatureAndOriginalPayer() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:authority"));
        pay(payment);
        PaymentTypes.RefundIntent memory value =
            refundIntent(payment, keccak256("refund:authority"), 1_000, 1_000, 1_000);
        bytes memory wrongSignature = ecdsaSignature(TERMINAL_KEY, router.refundDigest(value));
        vm.expectRevert(ExactPayRouter.InvalidRefundAuthorization.selector);
        router.refund(value, wrongSignature);

        bytes memory vendorSignature = ecdsaSignature(VENDOR_KEY, router.refundDigest(value));
        value.payerAccount = address(0x1234);
        vm.expectRevert(ExactPayRouter.InvalidIntent.selector);
        router.refund(value, vendorSignature);
        assert(ledger.refunds(value.refundId) == 0);
        assert(ledger.credits(vendorBeneficiaryId()) == 11_976);
    }

    function testRefundRejectsForeignDomainFundingSourceAndExpiry() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:domain"));
        pay(payment);
        PaymentTypes.RefundIntent memory value =
            refundIntent(payment, keccak256("refund:domain"), 1_000, 1_000, 1_000);
        bytes memory signature = ecdsaSignature(VENDOR_KEY, router.refundDigest(value));

        value.chainId += 1;
        vm.expectRevert(ExactPayRouter.InvalidIntent.selector);
        router.refund(value, signature);
        value.chainId = block.chainid;
        value.fundingSource = address(0x1234);
        vm.expectRevert(ExactPayRouter.InvalidIntent.selector);
        router.refund(value, signature);
        value.fundingSource = vm.addr(VENDOR_KEY);
        vm.warp(value.expiresAt);
        vm.expectRevert(ExactPayRouter.InvalidIntent.selector);
        router.refund(value, signature);
        assert(ledger.refunds(value.refundId) == 0);
    }

    function testRefundRejectsOverRefundReplayAndInsufficientCredit() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:bounds"));
        pay(payment);
        PaymentTypes.RefundIntent memory insufficient =
            refundIntent(payment, keccak256("refund:insufficient"), 12_000, 12_000, 12_000);
        bytes memory insufficientSignature =
            ecdsaSignature(VENDOR_KEY, router.refundDigest(insufficient));
        vm.expectRevert(SettlementLedger.InvalidPolicy.selector);
        router.refund(insufficient, insufficientSignature);
        assert(token.balanceOf(address(account)) == 987_655);

        PaymentTypes.RefundIntent memory first =
            refundIntent(payment, keccak256("refund:bounds:1"), 1_000, 1_000, 1_000);
        refund(first);
        PaymentTypes.RefundIntent memory replayedId =
            refundIntent(payment, first.refundId, 1_000, 2_000, 1_000);
        bytes memory replaySignature = ecdsaSignature(VENDOR_KEY, router.refundDigest(replayedId));
        vm.expectRevert(SettlementLedger.InvalidPolicy.selector);
        router.refund(replayedId, replaySignature);

        PaymentTypes.RefundIntent memory over =
            refundIntent(payment, keccak256("refund:over"), 11_346, 12_346, 10_976);
        fundRefunds(370);
        bytes memory overSignature = ecdsaSignature(VENDOR_KEY, router.refundDigest(over));
        vm.expectRevert(ExactPayRouter.InvalidIntent.selector);
        router.refund(over, overSignature);
        assert(token.balanceOf(address(account)) == 988_655);
        assert(ledger.credits(vendorBeneficiaryId()) == 10_976);
    }

    function testRefundContinuesWhileOnlineSalesPaused() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:paused"));
        pay(payment);
        registry.pauseOnline();
        PaymentTypes.RefundIntent memory value =
            refundIntent(payment, keccak256("refund:paused"), 1_000, 1_000, 1_000);
        refund(value);
        assert(token.balanceOf(address(account)) == 988_655);
    }

    function testWithdrawnVendorCreditRequiresFreshRefundFunding() public {
        PaymentTypes.Intent memory payment = intent(keccak256("payment:refund:withdrawn"));
        pay(payment);
        ledger.withdrawFor(vendorBeneficiaryId());
        PaymentTypes.RefundIntent memory unavailable =
            refundIntent(payment, keccak256("refund:withdrawn"), 1_000, 1_000, 1_000);
        bytes memory unavailableSignature =
            ecdsaSignature(VENDOR_KEY, router.refundDigest(unavailable));
        vm.expectRevert(SettlementLedger.InvalidPolicy.selector);
        router.refund(unavailable, unavailableSignature);

        fundRefunds(1_000);
        PaymentTypes.RefundIntent memory funded =
            refundIntent(payment, unavailable.refundId, 1_000, 1_000, 0);
        refund(funded);
        assert(token.balanceOf(address(account)) == 988_655);
        assert(ledger.totalLiability() == 369);
    }

    function testOnlineSessionEnforcesPerPaymentAndTotalCaps() public {
        setSession(sessionConfig(13_000, 20_000));
        PaymentTypes.Intent memory first = intent(keccak256("payment:session:1"));
        sessionPay(first, 1);
        PaymentTypes.Intent memory second = intent(keccak256("payment:session:2"));
        second.grossUnits = 7_655;
        sessionPay(second, 1);
        (uint256 spent, uint256 revision, bool active, uint256 accountEpoch) = sessionState();
        assert(spent == 20_000 && revision == 1 && active && accountEpoch == account.epoch());
        assert(account.nonce() == 1 && token.allowance(address(account), address(router)) == 0);

        PaymentTypes.Intent memory overTotal = intent(keccak256("payment:session:over-total"));
        overTotal.grossUnits = 1;
        (bytes32 r, bytes32 s) = sessionSignature(overTotal, 1);
        bytes memory encoded = abi.encode(overTotal);
        bytes memory terminal = terminalSignature(overTotal);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, terminal, r, s);
        (spent,,,) = sessionState();
        assert(spent == 20_000);

        OpenBalanceAccount.OnlineSessionConfig memory perPayment = sessionConfig(12_000, 20_000);
        revokeSession(1);
        setSession(perPayment);
        PaymentTypes.Intent memory tooLarge = intent(keccak256("payment:session:over-per-payment"));
        (r, s) = sessionSignature(tooLarge, 3);
        encoded = abi.encode(tooLarge);
        terminal = terminalSignature(tooLarge);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, terminal, r, s);
    }

    function testOnlineSessionScopeAndAtomicRollback() public {
        OpenBalanceAccount.OnlineSessionConfig memory invalid = sessionConfig(13_000, 20_000);
        invalid.eventId = keccak256("event:other");
        bytes32 invalidDigest = account.commandDigest(
            account.SET_SESSION(), account.onlineSessionTermsHash(invalid), DEADLINE
        );
        WebAuthn.WebAuthnAuth memory invalidAuth = assertion(invalidDigest);
        vm.expectRevert(OpenBalanceAccount.InvalidPolicy.selector);
        account.setOnlineSession(invalid, DEADLINE, false, invalidAuth);

        setSession(sessionConfig(13_000, 20_000));
        PaymentTypes.Intent memory value = intent(keccak256("payment:session:rollback"));
        (bytes32 r, bytes32 s) = sessionSignature(value, 1);
        bytes memory encoded = abi.encode(value);
        bytes memory wrongTerminal = ecdsaSignature(VENDOR_KEY, router.intentDigest(value));
        vm.expectRevert(ExactPayRouter.InvalidTerminalSignature.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, wrongTerminal, r, s);
        (uint256 spent,,,) = sessionState();
        assert(spent == 0 && token.allowance(address(account), address(router)) == 0);

        (r, s) = vm.signP256(
            SESSION_KEY + 1, account.sessionPaymentDigest(SESSION_ID, 1, router.intentDigest(value))
        );
        bytes memory terminal = terminalSignature(value);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, terminal, r, s);
        (spent,,,) = sessionState();
        assert(spent == 0);

        (bytes32 boundR, bytes32 boundS) = sessionSignature(value, 1);
        value.paymentId = keccak256("payment:session:altered");
        encoded = abi.encode(value);
        terminal = terminalSignature(value);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, terminal, boundR, boundS);
    }

    function testRevocationAndRecoveryInvalidateSessionSignatures() public {
        OpenBalanceAccount.OnlineSessionConfig memory config = sessionConfig(13_000, 20_000);
        setSession(config);
        PaymentTypes.Intent memory revoked = intent(keccak256("payment:session:revoked"));
        (bytes32 oldR, bytes32 oldS) = sessionSignature(revoked, 1);
        bytes memory encodedRevoked = abi.encode(revoked);
        bytes memory revokedTerminal = terminalSignature(revoked);
        revokeSession(1);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encodedRevoked, revokedTerminal, oldR, oldS);

        setSession(config);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encodedRevoked, revokedTerminal, oldR, oldS);

        PaymentTypes.Intent memory recovered = intent(keccak256("payment:session:recovered"));
        (bytes32 recoveryR, bytes32 recoveryS) = sessionSignature(recovered, 3);
        OpenBalanceAccount.Ownership memory next = owners();
        bytes32 recoveryDigest =
            account.commandDigest(account.RECOVER(), keccak256(abi.encode(next)), DEADLINE);
        account.recover(next, DEADLINE, ecdsaSignature(RECOVERY_KEY, recoveryDigest));
        bytes memory encodedRecovered = abi.encode(recovered);
        bytes memory recoveredTerminal = terminalSignature(recovered);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(
            SESSION_ID, encodedRecovered, recoveredTerminal, recoveryR, recoveryS
        );
    }

    function testExpiredOnlineSessionCannotPay() public {
        setSession(sessionConfig(13_000, 20_000));
        PaymentTypes.Intent memory value = intent(keccak256("payment:session:expired"));
        value.expiresAt = 850;
        (bytes32 r, bytes32 s) = sessionSignature(value, 1);
        bytes memory encoded = abi.encode(value);
        bytes memory terminal = terminalSignature(value);
        vm.warp(800);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.payWithOnlineSession(SESSION_ID, encoded, terminal, r, s);
    }

    function testOnlineSessionTermsHashMatchesSharedVector() public view {
        OpenBalanceAccount.OnlineSessionConfig memory config = OpenBalanceAccount.OnlineSessionConfig({
            sessionId: keccak256("session:attendee-device:1"),
            signer: OpenBalanceAccount.Key(
                bytes32(
                    uint256(0x1111111111111111111111111111111111111111111111111111111111111111)
                ),
                bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222))
            ),
            eventId: keccak256("event:market-2026"),
            router: address(0x0101),
            asset: address(0x0303),
            maxPerPayment: 13_000,
            maxTotal: 20_000,
            validAfter: 100,
            validUntil: 800
        });
        assert(
            account.onlineSessionTermsHash(config)
                == 0xb70e058329e6eda61d7ab51be697828426d3df8387a6db3c89e41e53775e52e3
        );
    }

    function testRefundStructHashMatchesSharedVector() public view {
        PaymentTypes.RefundIntent memory value = PaymentTypes.RefundIntent({
            schemaVersion: 1,
            chainId: 10_143,
            router: address(0x0101),
            eventId: keccak256("event:market-2026"),
            refundId: keccak256("refund:1"),
            paymentId: keccak256("payment:1"),
            payerAccount: address(0x0202),
            vendorId: keccak256("vendor:noodles"),
            asset: address(0x0303),
            refundUnits: 5_000_000,
            cumulativeRefundUnits: 5_000_000,
            vendorCreditUnits: 4_850_000,
            fundingSource: address(0x0404),
            validAfter: 1_800_000_100,
            expiresAt: 1_800_003_600
        });
        assert(
            router.refundStructHash(value)
                == 0x22dbd5a9e0c5faa0c0357665dbdb86f4e03daecf5499a16ed554f4c95cd1cc88
        );
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

    function testFuzzCreditFundedRefundConserves(uint256 input) public {
        uint256 amount = input % 11_976 + 1;
        PaymentTypes.Intent memory payment =
            intent(keccak256(abi.encode("payment:refund:fuzz", input)));
        pay(payment);
        PaymentTypes.RefundIntent memory value = refundIntent(
            payment, keccak256(abi.encode("refund:fuzz", input)), amount, amount, amount
        );
        refund(value);
        assert(token.balanceOf(address(account)) == 987_655 + amount);
        assert(token.balanceOf(address(ledger)) == payment.grossUnits - amount);
        assert(ledger.totalLiability() == payment.grossUnits - amount);
        assert(ledger.credits(vendorBeneficiaryId()) == 11_976 - amount);
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
