// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ResilienceVault } from "../payments/ResilienceVault.sol";
import { IReceiver } from "./IReceiver.sol";

/// @notice Turns scheduled workflow reports into reserve returns for one event's vault.
/// @dev Holds no funds, has no owner and adds no authority. Its only effect is
/// `ResilienceVault.reclaim`, which anyone may call after a channel's submission deadline and which
/// always pays the channel's original account. The forwarder check bounds who can spend this
/// contract's calls, not who can return a reserve. Channels are attempted independently, so one that
/// is unknown, not yet eligible or already returned never blocks the rest, and a replayed report can
/// only re-attempt returns the vault refuses to repeat.
contract ReclaimTrigger is IReceiver {
    uint256 public constant MAX_CHANNELS_PER_REPORT = 32;

    address public immutable forwarder;
    ResilienceVault public immutable vault;

    error InvalidPolicy();
    error UnauthorizedSender();

    event ReclaimAttempted(bytes32 indexed channelId, bool returned, uint256 returnedUnits);

    constructor(address forwarder_, address vault_) {
        if (forwarder_.code.length == 0 || vault_.code.length == 0) revert InvalidPolicy();
        forwarder = forwarder_;
        vault = ResilienceVault(vault_);
    }

    /// @param report `abi.encode(address vault, bytes32[] channelIds)`; the vault must be this
    /// trigger's, so a report built for another event cannot be applied here.
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedSender();
        (address target, bytes32[] memory channelIds) = abi.decode(report, (address, bytes32[]));
        uint256 count = channelIds.length;
        if (target != address(vault) || count == 0 || count > MAX_CHANNELS_PER_REPORT) {
            revert InvalidPolicy();
        }
        for (uint256 index; index < count; ++index) {
            bytes32 channelId = channelIds[index];
            try vault.reclaim(channelId) returns (uint256 returnedUnits) {
                emit ReclaimAttempted(channelId, true, returnedUnits);
            } catch {
                emit ReclaimAttempted(channelId, false, 0);
            }
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
