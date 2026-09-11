// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { EventRegistry } from "./EventRegistry.sol";
import { EventRegistryDeployer } from "./EventRegistryDeployer.sol";
import { ExactPayRouter } from "./ExactPayRouter.sol";
import { ExactPayRouterDeployer } from "./ExactPayRouterDeployer.sol";
import { SettlementLedger } from "./SettlementLedger.sol";

/// @notice Atomically creates and permanently binds the online contracts for an organizer event.
contract EventFactory {
    struct Deployment {
        address registry;
        address ledger;
        address router;
    }

    EventRegistryDeployer private immutable registryDeployer;
    ExactPayRouterDeployer private immutable routerDeployer;
    mapping(bytes32 deploymentKey => Deployment deployment) private deployments;
    bool private entered;

    error AlreadyExists();
    error InvalidDeployment();
    error Reentrant();
    event EventDeployed(
        address indexed organizer,
        bytes32 indexed eventId,
        address indexed registry,
        address ledger,
        address router,
        address asset,
        address riskOperator,
        uint16 maximumFeeBps
    );

    constructor() {
        registryDeployer = new EventRegistryDeployer();
        routerDeployer = new ExactPayRouterDeployer();
    }

    function key(address organizer, bytes32 eventId) public pure returns (bytes32) {
        return keccak256(abi.encode(organizer, eventId));
    }

    function getDeployment(address organizer, bytes32 eventId)
        external
        view
        returns (Deployment memory)
    {
        return deployments[key(organizer, eventId)];
    }

    function deployEvent(bytes32 eventId, address asset, address riskOperator, uint16 maximumFeeBps)
        external
        returns (Deployment memory deployment)
    {
        if (entered) revert Reentrant();
        bytes32 deploymentKey = key(msg.sender, eventId);
        if (deployments[deploymentKey].registry != address(0)) revert AlreadyExists();
        entered = true;

        EventRegistry registry =
            registryDeployer.deploy(eventId, asset, msg.sender, riskOperator, maximumFeeBps);
        SettlementLedger ledger = new SettlementLedger(address(registry), asset);
        ExactPayRouter router = routerDeployer.deploy(address(registry), address(ledger));
        ledger.bindRouter(address(router));

        if (
            registry.organizer() != msg.sender || registry.eventId() != eventId
                || registry.asset() != asset || registry.riskOperator() != riskOperator
                || registry.maximumFeeBps() != maximumFeeBps
                || ledger.registry() != address(registry) || address(ledger.asset()) != asset
                || ledger.binder() != address(this) || ledger.router() != address(router)
                || address(router.registry()) != address(registry)
                || address(router.ledger()) != address(ledger) || address(router.asset()) != asset
        ) revert InvalidDeployment();

        deployment = Deployment({
            registry: address(registry), ledger: address(ledger), router: address(router)
        });
        deployments[deploymentKey] = deployment;
        entered = false;
        emit EventDeployed(
            msg.sender,
            eventId,
            deployment.registry,
            deployment.ledger,
            deployment.router,
            asset,
            riskOperator,
            maximumFeeBps
        );
    }
}
