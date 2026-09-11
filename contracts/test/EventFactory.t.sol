// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EventFactory } from "../src/payments/EventFactory.sol";
import { EventRegistry } from "../src/payments/EventRegistry.sol";
import { ExactPayRouter } from "../src/payments/ExactPayRouter.sol";
import { SettlementLedger } from "../src/payments/SettlementLedger.sol";
import { ResilienceVault } from "../src/payments/ResilienceVault.sol";

interface VmEventFactory {
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
}

contract EventFactoryToken is ERC20 {
    constructor() ERC20("Factory Test USDC", "ftUSDC") { }
}

contract EventFactoryTest {
    VmEventFactory private constant vm =
        VmEventFactory(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant EVENT_ID = keccak256("event:factory");
    address private constant RISK_OPERATOR = address(0x999);

    EventFactory private factory;
    EventFactoryToken private token;

    function setUp() public {
        factory = new EventFactory();
        token = new EventFactoryToken();
    }

    function testDeploymentIsAtomicAndPermanentlyBound() public {
        EventFactory.Deployment memory created =
            factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);
        EventFactory.Deployment memory stored = factory.getDeployment(address(this), EVENT_ID);

        assert(created.registry == stored.registry);
        assert(created.ledger == stored.ledger);
        assert(created.router == stored.router);
        assert(created.vault == stored.vault);

        EventRegistry registry = EventRegistry(created.registry);
        SettlementLedger ledger = SettlementLedger(created.ledger);
        ExactPayRouter router = ExactPayRouter(created.router);
        ResilienceVault vault = ResilienceVault(created.vault);
        assert(registry.eventId() == EVENT_ID);
        assert(registry.organizer() == address(this));
        assert(registry.riskOperator() == RISK_OPERATOR);
        assert(registry.maximumFeeBps() == 500);
        assert(registry.asset() == address(token));
        assert(ledger.registry() == address(registry));
        assert(address(ledger.asset()) == address(token));
        assert(ledger.binder() == address(factory));
        assert(ledger.router() == address(router));
        assert(ledger.vault() == address(vault));
        assert(address(router.registry()) == address(registry));
        assert(address(router.ledger()) == address(ledger));
        assert(address(router.asset()) == address(token));
        assert(address(vault.registry()) == address(registry));
        assert(address(vault.ledger()) == address(ledger));
        assert(address(vault.asset()) == address(token));

        vm.expectRevert(SettlementLedger.Unauthorized.selector);
        ledger.bindRouter(address(0x1234));
    }

    function testDuplicateOrganizerEventCannotReplaceDeployment() public {
        EventFactory.Deployment memory first =
            factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);
        vm.expectRevert(EventFactory.AlreadyExists.selector);
        factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);
        EventFactory.Deployment memory stored = factory.getDeployment(address(this), EVENT_ID);
        assert(stored.registry == first.registry && stored.router == first.router);
    }

    function testSameEventIdIsScopedToOrganizer() public {
        EventFactory.Deployment memory ours =
            factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);
        address anotherOrganizer = address(0xA11CE);
        vm.prank(anotherOrganizer);
        EventFactory.Deployment memory theirs =
            factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);

        assert(ours.registry != theirs.registry);
        assert(EventRegistry(theirs.registry).organizer() == anotherOrganizer);
        assert(factory.getDeployment(address(this), EVENT_ID).registry == ours.registry);
        assert(factory.getDeployment(anotherOrganizer, EVENT_ID).registry == theirs.registry);
    }

    function testRevertedCreationDoesNotReserveIdentity() public {
        vm.expectRevert(EventRegistry.InvalidPolicy.selector);
        factory.deployEvent(EVENT_ID, address(0x1234), RISK_OPERATOR, 500);
        assert(factory.getDeployment(address(this), EVENT_ID).registry == address(0));

        EventFactory.Deployment memory created =
            factory.deployEvent(EVENT_ID, address(token), RISK_OPERATOR, 500);
        assert(created.registry != address(0));
    }
}
