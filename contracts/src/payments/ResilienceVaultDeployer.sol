// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ResilienceVault } from "./ResilienceVault.sol";

/// @notice Factory-bound helper that keeps event-factory runtime below EVM code limits.
contract ResilienceVaultDeployer {
    address private immutable factory;

    error Unauthorized();

    constructor() {
        factory = msg.sender;
    }

    function deploy(address registry, address ledger) external returns (ResilienceVault vault) {
        if (msg.sender != factory) revert Unauthorized();
        vault = new ResilienceVault(registry, ledger);
    }
}
