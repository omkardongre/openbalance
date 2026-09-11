// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library PaymentTypes {
    uint32 internal constant INTENT_SCHEMA_VERSION = 1;
    uint32 internal constant REFUND_SCHEMA_VERSION = 1;

    struct Intent {
        uint32 schemaVersion;
        uint256 chainId;
        address router;
        bytes32 eventId;
        bytes32 paymentId;
        address payerAccount;
        bytes32 orderRefHash;
        bytes32 vendorId;
        uint256 vendorDestinationVersion;
        bytes32 terminalInstanceId;
        address asset;
        uint256 grossUnits;
        uint16 organizerFeeBps;
        uint16 platformFeeBps;
        uint256 configVersion;
        bytes32 receiptCommitment;
        uint48 validAfter;
        uint48 expiresAt;
        uint256 terminalKeyVersion;
    }

    struct RefundIntent {
        uint32 schemaVersion;
        uint256 chainId;
        address router;
        bytes32 eventId;
        bytes32 refundId;
        bytes32 paymentId;
        address payerAccount;
        bytes32 vendorId;
        address asset;
        uint256 refundUnits;
        uint256 cumulativeRefundUnits;
        uint256 vendorCreditUnits;
        address fundingSource;
        uint48 validAfter;
        uint48 expiresAt;
    }
}
