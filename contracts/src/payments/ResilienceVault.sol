// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EventRegistry } from "./EventRegistry.sol";
import { SettlementLedger } from "./SettlementLedger.sol";

/// @notice Fully collateralized terminal-scoped reserves with permissionless expiry return.
contract ResilienceVault {
    using SafeERC20 for IERC20;

    struct ChannelConfig {
        bytes32 channelId;
        bytes32 eventId;
        address asset;
        uint256 reserveUnits;
        bytes32 vendorId;
        uint256 vendorDestinationVersion;
        bytes32 terminalInstanceId;
        uint256 terminalKeyVersion;
        address attendeeChannelSigner;
        uint256 configVersion;
        uint16 organizerFeeBps;
        uint16 platformFeeBps;
        uint256 maxPerVoucher;
        uint32 maxVoucherCount;
        uint48 acceptFrom;
        uint48 acceptUntil;
        uint48 submitUntil;
        bytes32 genesisDigest;
    }

    struct Voucher {
        uint32 protocolVersion;
        uint256 chainId;
        address vault;
        bytes32 channelId;
        uint32 sequence;
        bytes32 previousVoucherDigest;
        bytes32 paymentId;
        bytes32 orderRefHash;
        uint256 grossUnits;
        uint256 cumulativeGrossUnits;
        bytes32 receiptCommitment;
        uint48 acceptedAt;
        uint48 acceptUntil;
        uint48 submitUntil;
        uint256 configVersion;
    }

    struct Channel {
        address originalAccount;
        address terminalSigner;
        address[3] destinations;
        uint256 spentGross;
        uint32 nextSequence;
        bytes32 lastVoucherDigest;
        bool reclaimed;
    }

    uint32 public constant VOUCHER_PROTOCOL_VERSION = 1;
    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant VOUCHER_TYPE = keccak256(
        "OfflineVoucher(uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion)"
    );
    bytes32 private constant VENDOR_ROLE = keccak256("VENDOR");
    bytes32 private constant ORGANIZER_ROLE = keccak256("ORGANIZER");
    bytes32 private constant PLATFORM_ROLE = keccak256("PLATFORM");

    EventRegistry public immutable registry;
    SettlementLedger public immutable ledger;
    IERC20 public immutable asset;
    uint256 public totalReserved;
    bool private entered;
    mapping(bytes32 channelId => ChannelConfig config) private channelConfigs;
    mapping(bytes32 channelId => Channel channel) private channels;
    mapping(address originalAccount => uint256 amount) public reservedFor;

    error InvalidPolicy();
    error InvalidVoucher();
    error InvalidAttendeeSignature();
    error InvalidTerminalSignature();
    error AlreadyExists();
    error Reentrant();
    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed originalAccount,
        bytes32 indexed vendorId,
        bytes32 terminalInstanceId,
        uint256 reserveUnits,
        uint48 acceptUntil,
        uint48 submitUntil
    );
    event VoucherSettled(
        bytes32 indexed channelId,
        bytes32 indexed paymentId,
        uint32 indexed sequence,
        uint256 grossUnits,
        uint256 cumulativeGrossUnits,
        bytes32 voucherDigest
    );
    event ChannelReclaimed(
        bytes32 indexed channelId, address indexed originalAccount, uint256 returnedUnits
    );

    constructor(address registry_, address ledger_) {
        if (registry_.code.length == 0 || ledger_.code.length == 0) revert InvalidPolicy();
        registry = EventRegistry(registry_);
        ledger = SettlementLedger(ledger_);
        if (ledger.registry() != registry_ || address(ledger.asset()) != registry.asset()) {
            revert InvalidPolicy();
        }
        asset = IERC20(registry.asset());
    }

    modifier locked() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function eventId() external view returns (bytes32) {
        return registry.eventId();
    }

    function quoteChannel(ChannelConfig calldata config)
        external
        view
        returns (bytes32 termsHash, address token, uint256 reserveUnits, address originalAccount)
    {
        _validateConfig(config);
        _resolveTerms(config);
        return
            (channelTermsHash(config, msg.sender), address(asset), config.reserveUnits, msg.sender);
    }

    function openChannel(ChannelConfig calldata config) external locked {
        _validateConfig(config);
        if (channelConfigs[config.channelId].channelId != 0) revert AlreadyExists();
        (
            address terminalSigner,
            address vendorDestination,
            address organizerDestination,
            address platformDestination
        ) = _resolveTerms(config);

        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), config.reserveUnits);
        if (asset.balanceOf(address(this)) - balanceBefore != config.reserveUnits) {
            revert InvalidPolicy();
        }
        channelConfigs[config.channelId] = config;
        channels[config.channelId] = Channel({
            originalAccount: msg.sender,
            terminalSigner: terminalSigner,
            destinations: [vendorDestination, organizerDestination, platformDestination],
            spentGross: 0,
            nextSequence: 1,
            lastVoucherDigest: config.genesisDigest,
            reclaimed: false
        });
        totalReserved += config.reserveUnits;
        reservedFor[msg.sender] += config.reserveUnits;
        emit ChannelOpened(
            config.channelId,
            msg.sender,
            config.vendorId,
            config.terminalInstanceId,
            config.reserveUnits,
            config.acceptUntil,
            config.submitUntil
        );
    }

    function settleVoucher(
        Voucher calldata voucher,
        bytes calldata attendeeSignature,
        bytes calldata terminalSignature
    ) external locked {
        ChannelConfig storage config = channelConfigs[voucher.channelId];
        Channel storage channel = channels[voucher.channelId];
        bytes32 digest = voucherDigest(voucher);
        if (
            config.channelId == 0 || channel.reclaimed || block.timestamp >= config.submitUntil
                || voucher.protocolVersion != VOUCHER_PROTOCOL_VERSION
                || voucher.chainId != block.chainid || voucher.vault != address(this)
                || voucher.sequence != channel.nextSequence
                || voucher.previousVoucherDigest != channel.lastVoucherDigest
                || voucher.paymentId == 0 || voucher.orderRefHash == 0
                || voucher.receiptCommitment == 0 || voucher.grossUnits == 0
                || voucher.grossUnits > config.maxPerVoucher
                || voucher.cumulativeGrossUnits != channel.spentGross + voucher.grossUnits
                || voucher.cumulativeGrossUnits > config.reserveUnits
                || voucher.sequence > config.maxVoucherCount
                || voucher.acceptedAt < config.acceptFrom
                || voucher.acceptedAt >= config.acceptUntil
                || voucher.acceptUntil != config.acceptUntil
                || voucher.submitUntil != config.submitUntil
                || voucher.configVersion != config.configVersion
        ) revert InvalidVoucher();
        _checkSignature(digest, attendeeSignature, config.attendeeChannelSigner, true);
        _checkSignature(digest, terminalSignature, channel.terminalSigner, false);

        channel.spentGross = voucher.cumulativeGrossUnits;
        channel.nextSequence = voucher.sequence + 1;
        channel.lastVoucherDigest = digest;
        totalReserved -= voucher.grossUnits;
        reservedFor[channel.originalAccount] -= voucher.grossUnits;
        uint256 ledgerBalanceBefore = asset.balanceOf(address(ledger));
        asset.safeTransfer(address(ledger), voucher.grossUnits);
        if (asset.balanceOf(address(ledger)) - ledgerBalanceBefore != voucher.grossUnits) {
            revert InvalidVoucher();
        }
        _recordPayment(config, channel, voucher);
        emit VoucherSettled(
            voucher.channelId,
            voucher.paymentId,
            voucher.sequence,
            voucher.grossUnits,
            voucher.cumulativeGrossUnits,
            digest
        );
    }

    function reclaim(bytes32 channelId) external locked returns (uint256 returnedUnits) {
        ChannelConfig storage config = channelConfigs[channelId];
        Channel storage channel = channels[channelId];
        if (config.channelId == 0 || channel.reclaimed || block.timestamp < config.submitUntil) {
            revert InvalidPolicy();
        }
        channel.reclaimed = true;
        returnedUnits = config.reserveUnits - channel.spentGross;
        totalReserved -= returnedUnits;
        reservedFor[channel.originalAccount] -= returnedUnits;
        uint256 balanceBefore = asset.balanceOf(channel.originalAccount);
        asset.safeTransfer(channel.originalAccount, returnedUnits);
        if (asset.balanceOf(channel.originalAccount) - balanceBefore != returnedUnits) {
            revert InvalidPolicy();
        }
        emit ChannelReclaimed(channelId, channel.originalAccount, returnedUnits);
    }

    function channelTermsHash(ChannelConfig memory config, address originalAccount)
        public
        view
        returns (bytes32)
    {
        return channelTermsHashFor(block.chainid, address(this), originalAccount, config);
    }

    function channelTermsHashFor(
        uint256 chainId,
        address vault,
        address originalAccount,
        ChannelConfig memory config
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId, vault, originalAccount, config));
    }

    function voucherDigest(Voucher memory voucher) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("OpenBalanceOfflineVoucher"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, voucherStructHash(voucher)));
    }

    function voucherStructHash(Voucher memory voucher) public pure returns (bytes32) {
        return keccak256(abi.encode(VOUCHER_TYPE, voucher));
    }

    function channelConfig(bytes32 channelId) external view returns (ChannelConfig memory) {
        return channelConfigs[channelId];
    }

    function channelState(bytes32 channelId)
        external
        view
        returns (
            address originalAccount,
            uint256 spentGross,
            uint32 nextSequence,
            bytes32 lastVoucherDigest,
            bool reclaimed
        )
    {
        Channel storage channel = channels[channelId];
        return (
            channel.originalAccount,
            channel.spentGross,
            channel.nextSequence,
            channel.lastVoucherDigest,
            channel.reclaimed
        );
    }

    function channelRecipients(bytes32 channelId)
        external
        view
        returns (address vendor, address organizer, address platform)
    {
        address[3] storage destinations = channels[channelId].destinations;
        return (destinations[0], destinations[1], destinations[2]);
    }

    function _validateConfig(ChannelConfig calldata config) private view {
        if (
            config.channelId == 0 || config.eventId != registry.eventId()
                || config.asset != address(asset) || config.reserveUnits == 0
                || config.vendorId == 0 || config.vendorDestinationVersion == 0
                || config.terminalInstanceId == 0 || config.terminalKeyVersion == 0
                || config.attendeeChannelSigner == address(0) || config.configVersion == 0
                || config.maxPerVoucher == 0 || config.maxPerVoucher > config.reserveUnits
                || config.maxVoucherCount == 0 || config.maxVoucherCount == type(uint32).max
                || config.genesisDigest == 0
        ) revert InvalidPolicy();
    }

    function _resolveTerms(ChannelConfig calldata config)
        private
        view
        returns (
            address terminalSigner,
            address vendorDestination,
            address organizerDestination,
            address platformDestination
        )
    {
        return registry.reserveTerms(
            EventRegistry.ReserveTermsRequest({
                vendorId: config.vendorId,
                destinationVersion: config.vendorDestinationVersion,
                terminalId: config.terminalInstanceId,
                terminalVersion: config.terminalKeyVersion,
                configVersion: config.configVersion,
                organizerFeeBps: config.organizerFeeBps,
                platformFeeBps: config.platformFeeBps,
                acceptFrom: config.acceptFrom,
                acceptUntil: config.acceptUntil,
                submitUntil: config.submitUntil
            })
        );
    }

    function _recordPayment(
        ChannelConfig storage config,
        Channel storage channel,
        Voucher calldata voucher
    ) private {
        bytes32[3] memory beneficiaryIds = [
            keccak256(
                abi.encode(
                    config.eventId, VENDOR_ROLE, config.vendorId, config.vendorDestinationVersion
                )
            ),
            keccak256(abi.encode(config.eventId, ORGANIZER_ROLE, config.configVersion)),
            keccak256(abi.encode(config.eventId, PLATFORM_ROLE, config.configVersion))
        ];
        ledger.recordVaultPayment(
            voucher.paymentId,
            channel.originalAccount,
            config.vendorId,
            voucher.grossUnits,
            config.organizerFeeBps,
            config.platformFeeBps,
            voucher.receiptCommitment,
            beneficiaryIds,
            channel.destinations
        );
    }

    function _checkSignature(
        bytes32 digest,
        bytes calldata signature,
        address expected,
        bool attendee
    ) private pure {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != expected) {
            if (attendee) revert InvalidAttendeeSignature();
            revert InvalidTerminalSignature();
        }
    }
}
