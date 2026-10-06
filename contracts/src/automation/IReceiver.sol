// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Receiver for Chainlink CRE reports. The forwarder verifies the DON signatures, checks this
/// interface through ERC-165, then calls `onReport`. A revert marks the delivery failed and lets it be
/// retried, so receivers must tolerate a report arriving more than once.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
