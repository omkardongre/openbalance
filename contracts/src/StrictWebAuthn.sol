// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice Strict, bounded assertion profile for the initial browser compatibility probe.
/// @dev Accepts the standard ordered client-data fields with optional crossOrigin:false.
/// Additional fields/encodings require explicit compatibility review and are rejected.
library StrictWebAuthn {
    function verify(
        bytes32 challenge,
        WebAuthn.WebAuthnAuth memory auth,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        string memory origin
    ) internal view returns (bool) {
        if (auth.authenticatorData.length != 37 || bytes(auth.clientDataJSON).length > 512) {
            return false;
        }
        bytes memory data = auth.authenticatorData;
        bytes32 actualRp;
        assembly ("memory-safe") { actualRp := mload(add(data, 32)) }
        // No attestation, extension, or reserved flag bits in this assertion profile.
        if (actualRp != rpIdHash || (uint8(data[32]) & 0xe2) != 0) return false;
        string memory prefix = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            origin,
            '"'
        );
        bytes32 supplied = keccak256(bytes(auth.clientDataJSON));
        if (
            supplied != keccak256(bytes(string.concat(prefix, "}")))
                && supplied != keccak256(bytes(string.concat(prefix, ',"crossOrigin":false}')))
        ) return false;
        // Indices are derived from the accepted serialization, never trusted from the caller.
        auth.typeIndex = 1;
        auth.challengeIndex = 23;
        return WebAuthn.verify(abi.encodePacked(challenge), auth, x, y, true);
    }
}
