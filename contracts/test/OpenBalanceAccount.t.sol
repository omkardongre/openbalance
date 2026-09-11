// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { OpenBalanceAccount } from "../src/accounts/OpenBalanceAccount.sol";
import { AccountFactory } from "../src/accounts/AccountFactory.sol";

interface VmAccount {
    function publicKeyP256(uint256 key) external pure returns (uint256, uint256);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32, bytes32);
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
}

contract AccountToken is ERC20 {
    constructor(address recipient) ERC20("Test", "TEST") {
        _mint(recipient, 1000);
    }
}

contract ValidatorConsumer {
    function validate(OpenBalanceAccount account, bytes32 payloadHash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        return account.isValidSignature(payloadHash, signature);
    }
}

contract OpenBalanceAccountTest {
    VmAccount private constant vm =
        VmAccount(address(uint160(uint256(keccak256("hevm cheat code")))));
    AccountFactory private factory;
    OpenBalanceAccount private account;
    AccountToken private token;
    ValidatorConsumer private consumer;
    ValidatorConsumer private otherConsumer;
    uint256 private constant DEADLINE = 1000;
    address private constant RECIPIENT = address(0xbeef);

    function owners(uint256 primary, uint256 backup, uint256 recoveryKey)
        private
        pure
        returns (OpenBalanceAccount.Ownership memory o)
    {
        (uint256 x, uint256 y) = vm.publicKeyP256(primary);
        o.primary = OpenBalanceAccount.Key(bytes32(x), bytes32(y));
        if (backup != 0) {
            (x, y) = vm.publicKeyP256(backup);
            o.backup = OpenBalanceAccount.Key(bytes32(x), bytes32(y));
        }
        if (recoveryKey != 0) o.recovery = vm.addr(recoveryKey);
    }

    function setUp() public {
        factory = new AccountFactory();
        account = OpenBalanceAccount(
            factory.create(
                owners(42, 43, 44),
                sha256("localhost"),
                "http://localhost:3000",
                bytes32(uint256(1))
            )
        );
        token = new AccountToken(address(account));
        consumer = new ValidatorConsumer();
        otherConsumer = new ValidatorConsumer();
    }

    function assertion(bytes32 digest, uint256 key)
        private
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        auth.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x05), bytes4(0));
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        (auth.r, auth.s) = vm.signP256(
            key,
            sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))))
        );
    }

    function withdrawal(uint256 amount) private view returns (WebAuthn.WebAuthnAuth memory) {
        return assertion(
            account.commandDigest(
                account.WITHDRAW(),
                keccak256(abi.encode(address(token), RECIPIENT, amount)),
                DEADLINE
            ),
            42
        );
    }

    function recovery(OpenBalanceAccount.Ownership memory o, uint256 key)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            key, account.commandDigest(account.RECOVER(), keccak256(abi.encode(o)), DEADLINE)
        );
        return abi.encodePacked(r, s, v);
    }

    function setValidator(address validator, bool enabled) private {
        bytes32 digest = account.commandDigest(
            account.SET_VALIDATOR(), keccak256(abi.encode(validator, enabled)), DEADLINE
        );
        account.setValidator(validator, enabled, DEADLINE, false, assertion(digest, 42));
    }

    function validatorSignature(
        address validator,
        bytes32 purpose,
        bytes32 payloadHash,
        uint256 key
    ) private view returns (bytes memory) {
        bytes32 digest = account.commandDigest(
            account.ERC1271_CALL(), keccak256(abi.encode(validator, purpose, payloadHash)), DEADLINE
        );
        return abi.encode(purpose, DEADLINE, false, assertion(digest, key));
    }

    function testFactoryPredictionIdempotencyAndPolicyBinding() public {
        address predicted = factory.predict(
            owners(42, 43, 44), sha256("localhost"), "http://localhost:3000", bytes32(uint256(1))
        );
        assert(predicted == address(account));
        vm.prank(RECIPIENT);
        assert(
            factory.create(
                owners(42, 43, 44),
                sha256("localhost"),
                "http://localhost:3000",
                bytes32(uint256(1))
            ) == predicted
        );
        assert(
            factory.predict(
                owners(45, 43, 44),
                sha256("localhost"),
                "http://localhost:3000",
                bytes32(uint256(1))
            ) != predicted
        );
        assert(account.epoch() == 1);
    }

    function testInitializationLocked() public {
        bytes32 rp = sha256("localhost");
        OpenBalanceAccount.Ownership memory next = owners(45, 0, 0);
        OpenBalanceAccount implementation = OpenBalanceAccount(factory.implementation());
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.initialize(next, rp, "http://localhost:3000");
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        implementation.initialize(next, rp, "http://localhost:3000");
    }

    function testSponsoredWithdrawalAndReplay() public {
        WebAuthn.WebAuthnAuth memory auth = withdrawal(100);
        vm.prank(RECIPIENT);
        account.withdraw(address(token), RECIPIENT, 100, DEADLINE, false, auth);
        assert(token.balanceOf(RECIPIENT) == 100 && account.nonce() == 1);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), RECIPIENT, 100, DEADLINE, false, auth);
    }

    function testAlteredDestinationAmountAndChainRejected() public {
        WebAuthn.WebAuthnAuth memory auth = withdrawal(100);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), address(123), 100, DEADLINE, false, auth);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), RECIPIENT, 101, DEADLINE, false, auth);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), RECIPIENT, 100, DEADLINE, false, auth);
    }

    function testTransferFailureRollsBackNonce() public {
        WebAuthn.WebAuthnAuth memory auth = withdrawal(1001);
        vm.expectRevert();
        account.withdraw(address(token), RECIPIENT, 1001, DEADLINE, false, auth);
        assert(account.nonce() == 0 && token.balanceOf(address(account)) == 1000);
    }

    function testBackupRotationRevokesPrimaryAndOldRecovery() public {
        WebAuthn.WebAuthnAuth memory old = withdrawal(10);
        OpenBalanceAccount.Ownership memory next = owners(45, 0, 46);
        bytes memory oldRecovery = recovery(next, 44);
        WebAuthn.WebAuthnAuth memory auth = assertion(
            account.commandDigest(account.ROTATE(), keccak256(abi.encode(next)), DEADLINE), 43
        );
        account.rotate(next, DEADLINE, true, auth);
        assert(account.epoch() == 2 && account.nonce() == 1);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, old);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.recover(next, DEADLINE, oldRecovery);
        bytes memory removedSigner = recovery(next, 44);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.recover(next, DEADLINE, removedSigner);
    }

    function testRecoveryPreservesFundsAndInvalidatesRootEvenSameKey() public {
        WebAuthn.WebAuthnAuth memory old = withdrawal(10);
        OpenBalanceAccount.Ownership memory next = owners(42, 43, 44);
        bytes memory sig = recovery(next, 44);
        account.recover(next, DEADLINE, sig);
        assert(
            account.epoch() == 2 && account.recoveryNonce() == 1
                && token.balanceOf(address(account)) == 1000
        );
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, old);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.recover(next, DEADLINE, sig);
        account.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, withdrawal(10));
    }

    function testExpiryAndMalformedRecovery() public {
        OpenBalanceAccount.Ownership memory next = owners(45, 0, 0);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.recover(next, DEADLINE, hex"00");
        WebAuthn.WebAuthnAuth memory auth = withdrawal(10);
        vm.warp(DEADLINE);
        vm.expectRevert(OpenBalanceAccount.Expired.selector);
        account.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, auth);
        vm.expectRevert(OpenBalanceAccount.Expired.selector);
        account.recover(next, DEADLINE, hex"00");
    }

    function testInvalidOwnerAndPolicyRejected() public {
        bytes32 rp = sha256("localhost");
        OpenBalanceAccount.Ownership memory duplicate = owners(42, 42, 0);
        OpenBalanceAccount.Ownership memory single = owners(42, 0, 0);
        vm.expectRevert(OpenBalanceAccount.InvalidPolicy.selector);
        factory.create(duplicate, rp, "http://localhost:3000", bytes32(0));
        vm.expectRevert(OpenBalanceAccount.InvalidPolicy.selector);
        factory.create(single, rp, 'bad"origin', bytes32(0));
    }

    function testFuzzWithdrawalConservesTokens(uint256 input) public {
        uint256 amount = input % 1000 + 1;
        account.withdraw(address(token), RECIPIENT, amount, DEADLINE, false, withdrawal(amount));
        assert(token.balanceOf(address(account)) + token.balanceOf(RECIPIENT) == 1000);
        assert(token.balanceOf(RECIPIENT) == amount);
    }

    function testOtherAccountAndActionCannotReuseSignature() public {
        OpenBalanceAccount other = OpenBalanceAccount(
            factory.create(
                owners(42, 43, 44),
                sha256("localhost"),
                "http://localhost:3000",
                bytes32(uint256(2))
            )
        );
        WebAuthn.WebAuthnAuth memory auth = withdrawal(10);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        other.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, auth);
        OpenBalanceAccount.Ownership memory next = owners(45, 0, 0);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.rotate(next, DEADLINE, false, auth);
    }

    function testRecoveryNewKeyCanSpendAndDisabledRecoveryCannot() public {
        OpenBalanceAccount.Ownership memory next = owners(45, 0, 0);
        account.recover(next, DEADLINE, recovery(next, 44));
        bytes32 digest = account.commandDigest(
            account.WITHDRAW(),
            keccak256(abi.encode(address(token), RECIPIENT, uint256(10))),
            DEADLINE
        );
        account.withdraw(address(token), RECIPIENT, 10, DEADLINE, false, assertion(digest, 45));
        bytes memory sig = recovery(next, 44);
        vm.expectRevert(OpenBalanceAccount.Unauthorized.selector);
        account.recover(next, DEADLINE, sig);
        assert(token.balanceOf(RECIPIENT) == 10);
    }

    function testAuthorizedValidatorAcceptsPurposeBoundSignature() public {
        bytes32 purpose = keccak256("PAYMENT_AUTHORIZATION");
        bytes32 payloadHash = keccak256("invoice:42:25-USDC");
        setValidator(address(consumer), true);
        bytes memory signature = validatorSignature(address(consumer), purpose, payloadHash, 42);

        assert(
            consumer.validate(account, payloadHash, signature) == IERC1271.isValidSignature.selector
        );
        assert(account.nonce() == 1);
        assert(
            consumer.validate(account, keccak256("invoice:42:26-USDC"), signature)
                == bytes4(0xffffffff)
        );
        assert(account.isValidSignature(payloadHash, signature) == bytes4(0xffffffff));
    }

    function testValidatorRejectsMalformedExpiredAndLoginAssertions() public {
        bytes32 purpose = keccak256("PAYMENT_AUTHORIZATION");
        bytes32 payloadHash = keccak256("invoice:42:25-USDC");
        setValidator(address(consumer), true);
        assert(consumer.validate(account, payloadHash, hex"00") == bytes4(0xffffffff));

        bytes memory loginAssertion =
            abi.encode(purpose, DEADLINE, false, assertion(payloadHash, 42));
        assert(consumer.validate(account, payloadHash, loginAssertion) == bytes4(0xffffffff));

        bytes memory signature = validatorSignature(address(consumer), purpose, payloadHash, 42);
        vm.warp(DEADLINE);
        assert(consumer.validate(account, payloadHash, signature) == bytes4(0xffffffff));
    }

    function testValidatorPermissionAndRootNonceRevokeSignatures() public {
        bytes32 purpose = keccak256("PAYMENT_AUTHORIZATION");
        bytes32 payloadHash = keccak256("invoice:42:25-USDC");
        setValidator(address(consumer), true);
        bytes memory signature = validatorSignature(address(consumer), purpose, payloadHash, 42);

        setValidator(address(consumer), false);
        assert(!account.validators(address(consumer)) && account.nonce() == 2);
        assert(consumer.validate(account, payloadHash, signature) == bytes4(0xffffffff));
    }

    function testValidatorAndNonceDomainsCannotReuseSignature() public {
        bytes32 purpose = keccak256("PAYMENT_AUTHORIZATION");
        bytes32 payloadHash = keccak256("invoice:42:25-USDC");
        setValidator(address(consumer), true);
        setValidator(address(otherConsumer), true);
        bytes memory signature = validatorSignature(address(consumer), purpose, payloadHash, 42);

        assert(
            consumer.validate(account, payloadHash, signature) == IERC1271.isValidSignature.selector
        );
        assert(otherConsumer.validate(account, payloadHash, signature) == bytes4(0xffffffff));

        account.withdraw(address(token), RECIPIENT, 1, DEADLINE, false, withdrawal(1));
        assert(account.validators(address(consumer)));
        assert(consumer.validate(account, payloadHash, signature) == bytes4(0xffffffff));
    }

    function testInvalidValidatorPoliciesRejected() public {
        for (uint256 i; i < 3; ++i) {
            address validator = i == 0 ? address(0) : i == 1 ? address(account) : address(123);
            bytes32 digest = account.commandDigest(
                account.SET_VALIDATOR(), keccak256(abi.encode(validator, true)), DEADLINE
            );
            WebAuthn.WebAuthnAuth memory auth = assertion(digest, 42);
            vm.expectRevert(OpenBalanceAccount.InvalidPolicy.selector);
            account.setValidator(validator, true, DEADLINE, false, auth);
        }
        assert(account.nonce() == 0);
    }
}
