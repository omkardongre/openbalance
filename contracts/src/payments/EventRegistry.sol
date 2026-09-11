// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { PaymentTypes } from "./PaymentTypes.sol";

/// @notice Versioned event, vendor, destination, and terminal authority.
contract EventRegistry {
    struct Config {
        uint48 validAfter;
        uint48 validUntil;
        uint16 organizerFeeBps;
        uint16 platformFeeBps;
        uint48 maximumAcceptanceDuration;
        uint48 maximumSubmissionDelay;
        address organizerDestination;
        address platformDestination;
        bytes32 termsHash;
        bool enabled;
    }

    struct Vendor {
        address authority;
        bool enabled;
    }

    struct Destination {
        address account;
        bool enabled;
    }

    struct Terminal {
        bytes32 vendorId;
        address signer;
        uint48 validAfter;
        uint48 validUntil;
        bool enabled;
    }

    struct ReserveTermsRequest {
        bytes32 vendorId;
        uint256 destinationVersion;
        bytes32 terminalId;
        uint256 terminalVersion;
        uint256 configVersion;
        uint16 organizerFeeBps;
        uint16 platformFeeBps;
        uint48 acceptFrom;
        uint48 acceptUntil;
        uint48 submitUntil;
    }

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant DESTINATION_TYPE = keccak256(
        "DestinationApproval(bytes32 vendorId,uint256 version,address destination,uint256 deadline)"
    );

    bytes32 public immutable eventId;
    address public immutable asset;
    address public immutable organizer;
    address public immutable riskOperator;
    uint16 public immutable maximumFeeBps;
    bool public onlinePaused;
    mapping(uint256 version => Config) public configs;
    mapping(bytes32 vendorId => Vendor) public vendors;
    mapping(bytes32 vendorId => mapping(uint256 version => Destination)) public destinations;
    mapping(bytes32 terminalId => mapping(uint256 version => Terminal)) public terminals;

    error InvalidPolicy();
    error Unauthorized();
    error AlreadyExists();
    error Unavailable();
    event ConfigRegistered(uint256 indexed version, bytes32 indexed termsHash);
    event VendorRegistered(bytes32 indexed vendorId, address indexed authority);
    event DestinationRegistered(bytes32 indexed vendorId, uint256 indexed version, address account);
    event TerminalRegistered(bytes32 indexed terminalId, uint256 indexed version, bytes32 vendorId);
    event ConfigStatusChanged(uint256 indexed version, bool enabled);
    event VendorStatusChanged(bytes32 indexed vendorId, bool enabled);
    event DestinationStatusChanged(bytes32 indexed vendorId, uint256 indexed version, bool enabled);
    event TerminalStatusChanged(bytes32 indexed terminalId, uint256 indexed version, bool enabled);
    event OnlinePauseChanged(bool paused);

    constructor(
        bytes32 eventId_,
        address asset_,
        address organizer_,
        address riskOperator_,
        uint16 maximumFeeBps_
    ) {
        if (
            eventId_ == 0 || asset_.code.length == 0 || organizer_ == address(0)
                || riskOperator_ == address(0) || maximumFeeBps_ > 10_000
        ) revert InvalidPolicy();
        eventId = eventId_;
        asset = asset_;
        organizer = organizer_;
        riskOperator = riskOperator_;
        maximumFeeBps = maximumFeeBps_;
    }

    modifier onlyOrganizer() {
        if (msg.sender != organizer) revert Unauthorized();
        _;
    }

    function registerConfig(uint256 version, Config calldata config) external onlyOrganizer {
        if (
            version == 0 || configs[version].validUntil != 0
                || config.validAfter >= config.validUntil
                || uint256(config.organizerFeeBps) + config.platformFeeBps > maximumFeeBps
                || config.maximumAcceptanceDuration == 0 || config.maximumSubmissionDelay == 0
                || config.organizerDestination == address(0)
                || config.platformDestination == address(0) || config.termsHash == 0
        ) revert InvalidPolicy();
        configs[version] = config;
        emit ConfigRegistered(version, config.termsHash);
    }

    function registerVendor(bytes32 vendorId, address authority) external onlyOrganizer {
        if (vendorId == 0 || authority == address(0)) revert InvalidPolicy();
        if (vendors[vendorId].authority != address(0)) revert AlreadyExists();
        vendors[vendorId] = Vendor(authority, true);
        emit VendorRegistered(vendorId, authority);
    }

    function registerDestination(
        bytes32 vendorId,
        uint256 version,
        address destination,
        uint256 deadline,
        bytes calldata vendorSignature
    ) external onlyOrganizer {
        Vendor memory vendor = vendors[vendorId];
        if (
            vendor.authority == address(0) || !vendor.enabled || version == 0
                || destination == address(0) || block.timestamp >= deadline
        ) revert InvalidPolicy();
        if (destinations[vendorId][version].account != address(0)) revert AlreadyExists();
        bytes32 digest = destinationDigest(vendorId, version, destination, deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, vendorSignature);
        if (err != ECDSA.RecoverError.NoError || signer != vendor.authority) revert Unauthorized();
        destinations[vendorId][version] = Destination(destination, true);
        emit DestinationRegistered(vendorId, version, destination);
    }

    function registerTerminal(
        bytes32 terminalId,
        uint256 version,
        bytes32 vendorId,
        address signer,
        uint48 validAfter,
        uint48 validUntil
    ) external onlyOrganizer {
        if (
            terminalId == 0 || version == 0 || !vendors[vendorId].enabled || signer == address(0)
                || validAfter >= validUntil
        ) revert InvalidPolicy();
        if (terminals[terminalId][version].signer != address(0)) revert AlreadyExists();
        terminals[terminalId][version] = Terminal(vendorId, signer, validAfter, validUntil, true);
        emit TerminalRegistered(terminalId, version, vendorId);
    }

    function pauseOnline() external {
        if (msg.sender != riskOperator && msg.sender != organizer) revert Unauthorized();
        onlinePaused = true;
        emit OnlinePauseChanged(true);
    }

    function unpauseOnline() external onlyOrganizer {
        onlinePaused = false;
        emit OnlinePauseChanged(false);
    }

    function setConfigEnabled(uint256 version, bool enabled) external {
        _authorizeStatus(enabled);
        if (configs[version].validUntil == 0) revert Unavailable();
        configs[version].enabled = enabled;
        emit ConfigStatusChanged(version, enabled);
    }

    function setVendorEnabled(bytes32 vendorId, bool enabled) external {
        _authorizeStatus(enabled);
        if (vendors[vendorId].authority == address(0)) revert Unavailable();
        vendors[vendorId].enabled = enabled;
        emit VendorStatusChanged(vendorId, enabled);
    }

    function setDestinationEnabled(bytes32 vendorId, uint256 version, bool enabled) external {
        _authorizeStatus(enabled);
        if (destinations[vendorId][version].account == address(0)) revert Unavailable();
        destinations[vendorId][version].enabled = enabled;
        emit DestinationStatusChanged(vendorId, version, enabled);
    }

    function setTerminalEnabled(bytes32 terminalId, uint256 version, bool enabled) external {
        _authorizeStatus(enabled);
        if (terminals[terminalId][version].signer == address(0)) revert Unavailable();
        terminals[terminalId][version].enabled = enabled;
        emit TerminalStatusChanged(terminalId, version, enabled);
    }

    function destinationDigest(
        bytes32 vendorId,
        uint256 version,
        address destination,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("OpenBalanceEventRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(abi.encode(DESTINATION_TYPE, vendorId, version, destination, deadline))
            )
        );
    }

    function onlineTerms(PaymentTypes.Intent calldata intent)
        external
        view
        returns (
            address terminalSigner,
            address vendorDestination,
            address organizerDestination,
            address platformDestination
        )
    {
        Config memory config = configs[intent.configVersion];
        Vendor memory vendor = vendors[intent.vendorId];
        Destination memory destination =
            destinations[intent.vendorId][intent.vendorDestinationVersion];
        Terminal memory terminal = terminals[intent.terminalInstanceId][intent.terminalKeyVersion];
        if (
            onlinePaused || !config.enabled || !vendor.enabled || !destination.enabled
                || !terminal.enabled || terminal.vendorId != intent.vendorId
                || block.timestamp < config.validAfter || block.timestamp >= config.validUntil
                || block.timestamp < terminal.validAfter || block.timestamp >= terminal.validUntil
                || config.organizerFeeBps != intent.organizerFeeBps
                || config.platformFeeBps != intent.platformFeeBps
        ) revert Unavailable();
        return (
            terminal.signer,
            destination.account,
            config.organizerDestination,
            config.platformDestination
        );
    }

    function reserveTerms(ReserveTermsRequest calldata request)
        external
        view
        returns (
            address terminalSigner,
            address vendorDestination,
            address organizerDestination,
            address platformDestination
        )
    {
        Config memory config = configs[request.configVersion];
        Vendor memory vendor = vendors[request.vendorId];
        Destination memory destination = destinations[request.vendorId][request.destinationVersion];
        Terminal memory terminal = terminals[request.terminalId][request.terminalVersion];
        if (
            onlinePaused || !config.enabled || !vendor.enabled || !destination.enabled
                || !terminal.enabled || terminal.vendorId != request.vendorId
                || block.timestamp < config.validAfter || block.timestamp >= config.validUntil
                || block.timestamp < terminal.validAfter || block.timestamp >= terminal.validUntil
                || request.acceptFrom < terminal.validAfter
                || request.acceptUntil > terminal.validUntil || request.acceptFrom < block.timestamp
                || request.acceptFrom < config.validAfter
                || request.acceptFrom >= request.acceptUntil
                || request.acceptUntil >= request.submitUntil
                || request.acceptUntil > config.validUntil
                || request.acceptUntil - request.acceptFrom > config.maximumAcceptanceDuration
                || request.submitUntil - request.acceptUntil > config.maximumSubmissionDelay
                || config.organizerFeeBps != request.organizerFeeBps
                || config.platformFeeBps != request.platformFeeBps
        ) revert Unavailable();
        return (
            terminal.signer,
            destination.account,
            config.organizerDestination,
            config.platformDestination
        );
    }

    function historicalTerminalSigner(bytes32 terminalId, uint256 version, bytes32 vendorId)
        external
        view
        returns (address)
    {
        Terminal memory terminal = terminals[terminalId][version];
        if (terminal.vendorId != vendorId) return address(0);
        return terminal.signer;
    }

    function historicalVendorAuthority(bytes32 vendorId) external view returns (address) {
        return vendors[vendorId].authority;
    }

    function _authorizeStatus(bool enabled) private view {
        if (msg.sender != organizer && (enabled || msg.sender != riskOperator)) {
            revert Unauthorized();
        }
    }
}
