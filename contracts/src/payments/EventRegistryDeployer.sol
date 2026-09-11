// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { EventRegistry } from "./EventRegistry.sol";

/// @dev Size-bounded deployment helper controlled only by its creating factory.
contract EventRegistryDeployer {
    address private immutable factory;

    error Unauthorized();

    constructor() {
        factory = msg.sender;
    }

    function deploy(
        bytes32 eventId,
        address asset,
        address organizer,
        address riskOperator,
        uint16 maximumFeeBps
    ) external returns (EventRegistry registry) {
        if (msg.sender != factory) revert Unauthorized();
        registry = new EventRegistry(eventId, asset, organizer, riskOperator, maximumFeeBps);
    }
}
