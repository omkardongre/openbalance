// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { StrictWebAuthn } from "./StrictWebAuthn.sol";

/// @notice Non-custodial compatibility probe; this contract has no payment capabilities.
contract WebAuthnProbe {
    bytes32 public immutable x;
    bytes32 public immutable y;
    bytes32 public immutable rpIdHash;
    string public origin;
    uint256 public nonce;
    bytes32 private constant PURPOSE = keccak256("OpenBalance.WebAuthnProbe.v1");

    error InvalidPolicy();
    error InvalidAssertion();
    error Expired();
    event AssertionAccepted(uint256 indexed nonce, bytes32 challenge);

    constructor(bytes32 x_, bytes32 y_, bytes32 rpIdHash_, string memory origin_) {
        bytes memory value = bytes(origin_);
        if (
            !P256.isValidPublicKey(x_, y_) || rpIdHash_ == 0 || value.length == 0
                || value.length > 200
        ) {
            revert InvalidPolicy();
        }
        for (uint256 i; i < value.length; ++i) {
            if (
                uint8(value[i]) < 0x21 || uint8(value[i]) > 0x7e || value[i] == '"'
                    || value[i] == "\\"
            ) {
                revert InvalidPolicy();
            }
        }
        x = x_;
        y = y_;
        rpIdHash = rpIdHash_;
        origin = origin_;
    }

    function challenge(uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(PURPOSE, block.chainid, address(this), nonce, deadline));
    }

    /// @dev Any caller may sponsor a valid assertion; caller cannot change its domain or nonce.
    function submit(uint256 deadline, WebAuthn.WebAuthnAuth calldata auth) external {
        if (block.timestamp >= deadline) revert Expired();
        bytes32 digest = challenge(deadline);
        if (!StrictWebAuthn.verify(digest, auth, x, y, rpIdHash, origin)) {
            revert InvalidAssertion();
        }
        uint256 accepted = nonce++;
        emit AssertionAccepted(accepted, digest);
    }

    /// @notice Reverts if the native precompile is unavailable; distinct from the fallback verifier.
    function verifyNative(bytes32 hash, bytes32 r, bytes32 s) external view returns (bool) {
        return P256.verifyNative(hash, r, s, x, y);
    }
}
