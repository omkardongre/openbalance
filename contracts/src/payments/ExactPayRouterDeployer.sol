// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ExactPayRouter } from "./ExactPayRouter.sol";

/// @dev Size-bounded deployment helper controlled only by its creating factory.
contract ExactPayRouterDeployer {
    address private immutable factory;

    error Unauthorized();

    constructor() {
        factory = msg.sender;
    }

    function deploy(address registry, address ledger) external returns (ExactPayRouter router) {
        if (msg.sender != factory) revert Unauthorized();
        router = new ExactPayRouter(registry, ledger);
    }
}
