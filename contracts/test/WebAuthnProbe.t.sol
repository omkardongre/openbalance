// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { WebAuthnProbe } from "../src/WebAuthnProbe.sol";

interface VmProbe {
    function publicKeyP256(uint256 key) external pure returns (uint256 x, uint256 y);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32 r, bytes32 s);
    function expectRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function prank(address sender) external;
}

contract WebAuthnProbeTest {
    VmProbe private constant vm = VmProbe(address(uint160(uint256(keccak256("hevm cheat code")))));
    WebAuthnProbe private probe;
    uint256 private constant KEY = 42; // Test-only key, never used for deployment.
    uint256 private constant DEADLINE = 1000;

    function setUp() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(KEY);
        probe =
            new WebAuthnProbe(bytes32(x), bytes32(y), sha256("localhost"), "http://localhost:3000");
    }

    function assertion(bytes32 digest, bytes1 flags, string memory origin, bytes32 rp)
        private
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        auth.authenticatorData = abi.encodePacked(rp, flags, bytes4(0));
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"',
            origin,
            '","crossOrigin":false}'
        );
        return sign(auth);
    }

    function sign(WebAuthn.WebAuthnAuth memory auth)
        private
        pure
        returns (WebAuthn.WebAuthnAuth memory)
    {
        (auth.r, auth.s) = vm.signP256(
            KEY,
            sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))))
        );
        return auth;
    }

    function valid() private view returns (WebAuthn.WebAuthnAuth memory) {
        return
            assertion(probe.challenge(DEADLINE), 0x05, "http://localhost:3000", sha256("localhost"));
    }

    function testSponsorAndReplay() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        vm.prank(address(0xbeef));
        probe.submit(DEADLINE, auth);
        assert(probe.nonce() == 1);
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
        assert(probe.nonce() == 1);
    }

    function testRejectWrongOrigin() public {
        WebAuthn.WebAuthnAuth memory auth =
            assertion(probe.challenge(DEADLINE), 0x05, "https://evil.invalid", sha256("localhost"));
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testRejectWrongRp() public {
        WebAuthn.WebAuthnAuth memory auth = assertion(
            probe.challenge(DEADLINE), 0x05, "http://localhost:3000", sha256("evil.invalid")
        );
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testFuzzFlags(uint8 flags) public {
        WebAuthn.WebAuthnAuth memory auth = assertion(
            probe.challenge(DEADLINE), bytes1(flags), "http://localhost:3000", sha256("localhost")
        );
        bool allowed =
            (flags & 5) == 5 && (flags & 0xe2) == 0 && ((flags & 8) != 0 || (flags & 16) == 0);
        if (!allowed) vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
        assert(probe.nonce() == (allowed ? 1 : 0));
    }

    function testRejectChainReplay() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        vm.chainId(block.chainid + 1);
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testRejectContractReplay() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        WebAuthnProbe other =
            new WebAuthnProbe(probe.x(), probe.y(), probe.rpIdHash(), probe.origin());
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        other.submit(DEADLINE, auth);
    }

    function testDeadlineBoundary() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        vm.warp(DEADLINE);
        vm.expectRevert(WebAuthnProbe.Expired.selector);
        probe.submit(DEADLINE, auth);
    }

    function testRejectMalformedJsonEvenWithValidSignature() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        auth.clientDataJSON = string.concat(auth.clientDataJSON, ',"origin":"https://evil.invalid"');
        auth = sign(auth);
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testRejectInvalidSignature() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        auth.r = bytes32(0);
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testAcceptProfileWithoutCrossOrigin() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(probe.challenge(DEADLINE))),
            '","origin":"http://localhost:3000"}'
        );
        auth = sign(auth);
        // Arbitrary offsets cannot influence the strict verifier.
        auth.typeIndex = type(uint256).max;
        auth.challengeIndex = type(uint256).max;
        probe.submit(DEADLINE, auth);
        assert(probe.nonce() == 1);
    }

    function testRejectShortAuthenticatorData() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        auth.authenticatorData = hex"05";
        auth = sign(auth);
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE, auth);
    }

    function testDeadlineCannotBeExtended() public {
        WebAuthn.WebAuthnAuth memory auth = valid();
        vm.expectRevert(WebAuthnProbe.InvalidAssertion.selector);
        probe.submit(DEADLINE + 1, auth);
    }

    function testRejectInvalidPublicKey() public {
        bytes32 rp = sha256("localhost");
        vm.expectRevert(WebAuthnProbe.InvalidPolicy.selector);
        new WebAuthnProbe(bytes32(0), bytes32(0), rp, "http://localhost:3000");
    }
}
