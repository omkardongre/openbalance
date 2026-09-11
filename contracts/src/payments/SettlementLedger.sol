// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Custody-backed, fixed-destination beneficiary credits for one event asset.
contract SettlementLedger {
    using SafeERC20 for IERC20;

    struct PaymentRecord {
        address payer;
        bytes32 vendorId;
        uint256 gross;
        uint256 vendorNet;
        uint256 organizerFee;
        uint256 platformFee;
        bytes32 receiptCommitment;
        bytes32 vendorBeneficiaryId;
        uint256 refundedGross;
    }

    address public immutable registry;
    IERC20 public immutable asset;
    address public immutable binder;
    address public router;
    address public vault;
    uint256 public totalLiability;
    bool private entered;
    mapping(bytes32 beneficiaryId => address destination) public beneficiaryDestinations;
    mapping(bytes32 beneficiaryId => uint256 amount) public credits;
    mapping(bytes32 paymentId => PaymentRecord) public payments;
    mapping(bytes32 refundId => bytes32 paymentId) public refunds;

    error InvalidPolicy();
    error Unauthorized();
    error AlreadyExists();
    error Insolvent();
    error NothingToWithdraw();
    error Reentrant();
    event RouterBound(address indexed router);
    event VaultBound(address indexed vault);
    event PaymentCredited(bytes32 indexed paymentId, address indexed payer, uint256 gross);
    event RefundPaid(
        bytes32 indexed refundId,
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 amount,
        uint256 vendorCreditUsed
    );
    event Withdrawn(bytes32 indexed beneficiaryId, address indexed destination, uint256 amount);

    constructor(address registry_, address asset_) {
        if (registry_.code.length == 0 || asset_.code.length == 0) revert InvalidPolicy();
        registry = registry_;
        asset = IERC20(asset_);
        binder = msg.sender;
    }

    modifier locked() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function bindRouter(address router_) external {
        if (msg.sender != binder) revert Unauthorized();
        if (router != address(0)) revert AlreadyExists();
        if (router_.code.length == 0) revert InvalidPolicy();
        router = router_;
        emit RouterBound(router_);
    }

    function bindVault(address vault_) external {
        if (msg.sender != binder) revert Unauthorized();
        if (vault != address(0)) revert AlreadyExists();
        if (vault_.code.length == 0) revert InvalidPolicy();
        vault = vault_;
        emit VaultBound(vault_);
    }

    function recordPayment(
        bytes32 paymentId,
        address payer,
        bytes32 vendorId,
        uint256 gross,
        uint16 organizerFeeBps,
        uint16 platformFeeBps,
        bytes32 receiptCommitment,
        bytes32[3] calldata beneficiaryIds,
        address[3] calldata destinations
    ) external {
        if (msg.sender != router) revert Unauthorized();
        _recordPayment(
            paymentId,
            payer,
            vendorId,
            gross,
            organizerFeeBps,
            platformFeeBps,
            receiptCommitment,
            beneficiaryIds,
            destinations
        );
    }

    function recordVaultPayment(
        bytes32 paymentId,
        address payer,
        bytes32 vendorId,
        uint256 gross,
        uint16 organizerFeeBps,
        uint16 platformFeeBps,
        bytes32 receiptCommitment,
        bytes32[3] calldata beneficiaryIds,
        address[3] calldata destinations
    ) external {
        if (msg.sender != vault) revert Unauthorized();
        _recordPayment(
            paymentId,
            payer,
            vendorId,
            gross,
            organizerFeeBps,
            platformFeeBps,
            receiptCommitment,
            beneficiaryIds,
            destinations
        );
    }

    function refundTerms(bytes32 paymentId)
        external
        view
        returns (
            address payer,
            bytes32 vendorId,
            uint256 gross,
            uint256 refundedGross,
            bytes32 vendorBeneficiaryId
        )
    {
        PaymentRecord storage payment = payments[paymentId];
        return (
            payment.payer,
            payment.vendorId,
            payment.gross,
            payment.refundedGross,
            payment.vendorBeneficiaryId
        );
    }

    function recordRefund(
        bytes32 refundId,
        bytes32 paymentId,
        address payer,
        bytes32 vendorId,
        uint256 refundUnits,
        uint256 cumulativeRefundUnits,
        uint256 vendorCreditUnits
    ) external locked {
        if (msg.sender != router) revert Unauthorized();
        PaymentRecord storage payment = payments[paymentId];
        bytes32 vendorBeneficiaryId = payment.vendorBeneficiaryId;
        if (
            refundId == 0 || refunds[refundId] != 0 || payment.payer != payer
                || payment.vendorId != vendorId || refundUnits == 0
                || vendorCreditUnits > refundUnits
                || payment.refundedGross + refundUnits != cumulativeRefundUnits
                || cumulativeRefundUnits > payment.gross
                || credits[vendorBeneficiaryId] < vendorCreditUnits
        ) revert InvalidPolicy();

        uint256 freshUnits = refundUnits - vendorCreditUnits;
        if (asset.balanceOf(address(this)) < totalLiability + freshUnits) revert Insolvent();
        uint256 payerBalanceBefore = asset.balanceOf(payer);
        uint256 ledgerBalanceBefore = asset.balanceOf(address(this));

        refunds[refundId] = paymentId;
        payment.refundedGross = cumulativeRefundUnits;
        credits[vendorBeneficiaryId] -= vendorCreditUnits;
        totalLiability -= vendorCreditUnits;
        asset.safeTransfer(payer, refundUnits);
        if (
            asset.balanceOf(payer) - payerBalanceBefore != refundUnits
                || ledgerBalanceBefore - asset.balanceOf(address(this)) != refundUnits
        ) revert InvalidPolicy();
        emit RefundPaid(refundId, paymentId, payer, refundUnits, vendorCreditUnits);
    }

    function _recordPayment(
        bytes32 paymentId,
        address payer,
        bytes32 vendorId,
        uint256 gross,
        uint16 organizerFeeBps,
        uint16 platformFeeBps,
        bytes32 receiptCommitment,
        bytes32[3] memory beneficiaryIds,
        address[3] memory destinations
    ) private {
        if (payments[paymentId].payer != address(0) || payer == address(0) || gross == 0) {
            revert InvalidPolicy();
        }
        uint256 organizerFee = Math.mulDiv(gross, organizerFeeBps, 10_000);
        uint256 platformFee = Math.mulDiv(gross, platformFeeBps, 10_000);
        if (organizerFee + platformFee > gross) revert InvalidPolicy();
        uint256 vendorNet = gross - organizerFee - platformFee;
        if (asset.balanceOf(address(this)) < totalLiability + gross) revert Insolvent();

        uint256[3] memory amounts = [vendorNet, organizerFee, platformFee];
        for (uint256 i; i < 3; ++i) {
            if (
                beneficiaryIds[i] == 0 || destinations[i] == address(0)
                    || destinations[i] == address(this)
            ) revert InvalidPolicy();
            address current = beneficiaryDestinations[beneficiaryIds[i]];
            if (current != address(0) && current != destinations[i]) revert InvalidPolicy();
            beneficiaryDestinations[beneficiaryIds[i]] = destinations[i];
            credits[beneficiaryIds[i]] += amounts[i];
        }
        totalLiability += gross;
        payments[paymentId] = PaymentRecord(
            payer,
            vendorId,
            gross,
            vendorNet,
            organizerFee,
            platformFee,
            receiptCommitment,
            beneficiaryIds[0],
            0
        );
        emit PaymentCredited(paymentId, payer, gross);
    }

    function withdrawFor(bytes32 beneficiaryId) external locked returns (uint256 amount) {
        address destination = beneficiaryDestinations[beneficiaryId];
        amount = credits[beneficiaryId];
        if (destination == address(0) || amount == 0) revert NothingToWithdraw();
        credits[beneficiaryId] = 0;
        totalLiability -= amount;
        asset.safeTransfer(destination, amount);
        emit Withdrawn(beneficiaryId, destination, amount);
    }
}
