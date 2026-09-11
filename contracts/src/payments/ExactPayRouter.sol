// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { EventRegistry } from "./EventRegistry.sol";
import { SettlementLedger } from "./SettlementLedger.sol";
import { PaymentTypes } from "./PaymentTypes.sol";

/// @notice Commits payer-bound terminal intents and exact event settlement atomically.
contract ExactPayRouter {
    using SafeERC20 for IERC20;

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant INTENT_TYPE = keccak256(
        "PaymentIntent(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)"
    );
    bytes32 private constant VENDOR_ROLE = keccak256("VENDOR");
    bytes32 private constant ORGANIZER_ROLE = keccak256("ORGANIZER");
    bytes32 private constant PLATFORM_ROLE = keccak256("PLATFORM");

    enum PaymentState {
        NONE,
        PAID,
        CANCELLED
    }

    EventRegistry public immutable registry;
    SettlementLedger public immutable ledger;
    IERC20 public immutable asset;
    mapping(bytes32 paymentId => PaymentState) public paymentStates;
    bool private entered;

    error InvalidIntent();
    error InvalidTerminalSignature();
    error PaymentResolved();
    error Reentrant();
    event PaymentCommitted(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes32 indexed vendorId,
        uint256 configVersion,
        uint256 gross,
        uint256 organizerFee,
        uint256 platformFee,
        bytes32 receiptCommitment
    );
    event PaymentCancelled(bytes32 indexed paymentId, address indexed payer);

    constructor(address registry_, address ledger_) {
        registry = EventRegistry(registry_);
        ledger = SettlementLedger(ledger_);
        if (registry_.code.length == 0 || ledger_.code.length == 0) revert InvalidIntent();
        if (ledger.registry() != registry_ || address(ledger.asset()) != registry.asset()) {
            revert InvalidIntent();
        }
        asset = IERC20(registry.asset());
    }

    modifier locked() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function quote(bytes calldata encodedIntent)
        external
        view
        returns (bytes32 digest, address token, uint256 gross, address payer)
    {
        PaymentTypes.Intent memory intent = abi.decode(encodedIntent, (PaymentTypes.Intent));
        return (intentDigest(intent), intent.asset, intent.grossUnits, intent.payerAccount);
    }

    function pay(bytes calldata encodedIntent, bytes calldata terminalSignature) external locked {
        PaymentTypes.Intent memory intent = abi.decode(encodedIntent, (PaymentTypes.Intent));
        _validateBase(intent);
        if (intent.payerAccount != msg.sender) revert InvalidIntent();
        if (paymentStates[intent.paymentId] != PaymentState.NONE) revert PaymentResolved();
        (
            address terminalSigner,
            address vendorDestination,
            address organizerDestination,
            address platformDestination
        ) = registry.onlineTerms(intent);
        _checkTerminal(intentDigest(intent), terminalSignature, terminalSigner);

        paymentStates[intent.paymentId] = PaymentState.PAID;
        uint256 balanceBefore = asset.balanceOf(address(ledger));
        asset.safeTransferFrom(msg.sender, address(ledger), intent.grossUnits);
        if (asset.balanceOf(address(ledger)) - balanceBefore != intent.grossUnits) {
            revert InvalidIntent();
        }

        _record(intent, vendorDestination, organizerDestination, platformDestination);
    }

    function _record(
        PaymentTypes.Intent memory intent,
        address vendorDestination,
        address organizerDestination,
        address platformDestination
    ) private {
        bytes32[3] memory beneficiaryIds = [
            keccak256(
                abi.encode(
                    intent.eventId, VENDOR_ROLE, intent.vendorId, intent.vendorDestinationVersion
                )
            ),
            keccak256(abi.encode(intent.eventId, ORGANIZER_ROLE, intent.configVersion)),
            keccak256(abi.encode(intent.eventId, PLATFORM_ROLE, intent.configVersion))
        ];
        address[3] memory destinations =
            [vendorDestination, organizerDestination, platformDestination];
        ledger.recordPayment(
            intent.paymentId,
            intent.payerAccount,
            intent.vendorId,
            intent.grossUnits,
            intent.organizerFeeBps,
            intent.platformFeeBps,
            intent.receiptCommitment,
            beneficiaryIds,
            destinations
        );
        uint256 organizerFee = Math.mulDiv(intent.grossUnits, intent.organizerFeeBps, 10_000);
        uint256 platformFee = Math.mulDiv(intent.grossUnits, intent.platformFeeBps, 10_000);
        emit PaymentCommitted(
            intent.paymentId,
            intent.payerAccount,
            intent.vendorId,
            intent.configVersion,
            intent.grossUnits,
            organizerFee,
            platformFee,
            intent.receiptCommitment
        );
    }

    function cancel(bytes calldata encodedIntent, bytes calldata terminalSignature)
        external
        locked
    {
        PaymentTypes.Intent memory intent = abi.decode(encodedIntent, (PaymentTypes.Intent));
        _validateDomain(intent);
        if (intent.payerAccount != msg.sender) revert InvalidIntent();
        if (paymentStates[intent.paymentId] != PaymentState.NONE) revert PaymentResolved();
        address terminalSigner = registry.historicalTerminalSigner(
            intent.terminalInstanceId, intent.terminalKeyVersion, intent.vendorId
        );
        _checkTerminal(intentDigest(intent), terminalSignature, terminalSigner);
        paymentStates[intent.paymentId] = PaymentState.CANCELLED;
        emit PaymentCancelled(intent.paymentId, intent.payerAccount);
    }

    function intentDigest(PaymentTypes.Intent memory intent) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("OpenBalanceExactPay"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, intentStructHash(intent)));
    }

    function intentStructHash(PaymentTypes.Intent memory intent) public pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPE, intent));
    }

    function _validateBase(PaymentTypes.Intent memory intent) private view {
        _validateDomain(intent);
        if (
            intent.orderRefHash == 0 || intent.vendorId == 0 || intent.terminalInstanceId == 0
                || intent.receiptCommitment == 0 || intent.grossUnits == 0
                || block.timestamp < intent.validAfter || block.timestamp >= intent.expiresAt
        ) revert InvalidIntent();
    }

    function _validateDomain(PaymentTypes.Intent memory intent) private view {
        if (
            intent.schemaVersion != PaymentTypes.INTENT_SCHEMA_VERSION
                || intent.chainId != block.chainid || intent.router != address(this)
                || intent.eventId != registry.eventId() || intent.asset != address(asset)
                || intent.paymentId == 0
        ) revert InvalidIntent();
    }

    function _checkTerminal(bytes32 digest, bytes calldata signature, address expected)
        private
        pure
    {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (expected == address(0) || err != ECDSA.RecoverError.NoError || signer != expected) {
            revert InvalidTerminalSignature();
        }
    }
}
