// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { StrictWebAuthn } from "../StrictWebAuthn.sol";

/// @notice Immutable account ownership core. Any caller may relay an authorized command.
contract OpenBalanceAccount {
    using SafeERC20 for IERC20;

    struct Key {
        bytes32 x;
        bytes32 y;
    }

    struct Ownership {
        Key primary;
        Key backup;
        address recovery;
    }

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant COMMAND_TYPE = keccak256(
        "Command(bytes32 action,bytes32 terms,uint256 epoch,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW = keccak256("WITHDRAW");
    bytes32 public constant ROTATE = keccak256("ROTATE");
    bytes32 public constant RECOVER = keccak256("RECOVER");
    address public immutable factory;
    bool private initialized;
    bool private entered;
    Ownership public ownership;
    bytes32 public rpIdHash;
    string public origin;
    uint256 public epoch;
    uint256 public nonce;
    uint256 public recoveryNonce;

    error InvalidPolicy();
    error Unauthorized();
    error Expired();
    error Reentrant();
    event OwnershipChanged(uint256 indexed epoch, bytes32 ownershipHash);
    event CommandExecuted(bytes32 indexed digest, bytes32 indexed action);
    event Withdrawn(address indexed asset, address indexed recipient, uint256 amount);

    constructor() {
        factory = msg.sender;
        initialized = true;
    }

    modifier locked() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function initialize(Ownership calldata owners, bytes32 rp, string calldata site) external {
        if (initialized || msg.sender != factory) revert Unauthorized();
        _validate(owners);
        bytes memory value = bytes(site);
        if (rp == 0 || value.length == 0 || value.length > 200) revert InvalidPolicy();
        for (uint256 i; i < value.length; ++i) {
            if (
                uint8(value[i]) < 0x21 || uint8(value[i]) > 0x7e || value[i] == '"'
                    || value[i] == "\\"
            ) revert InvalidPolicy();
        }
        initialized = true;
        rpIdHash = rp;
        origin = site;
        ownership = owners;
        epoch = 1;
        emit OwnershipChanged(epoch, keccak256(abi.encode(owners)));
    }

    function commandDigest(bytes32 action, bytes32 terms, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("OpenBalanceAccount"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        uint256 sequence = action == RECOVER ? recoveryNonce : nonce;
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domain,
                keccak256(abi.encode(COMMAND_TYPE, action, terms, epoch, sequence, deadline))
            )
        );
    }

    /// @notice Only this exact asset, destination, and amount are authorized by the assertion.
    function withdraw(
        address asset,
        address recipient,
        uint256 amount,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        if (
            recipient == address(0) || recipient == address(this) || amount == 0
                || asset.code.length == 0
        ) revert InvalidPolicy();
        _authorize(
            WITHDRAW, keccak256(abi.encode(asset, recipient, amount)), deadline, backup, auth
        );
        IERC20(asset).safeTransfer(recipient, amount);
        emit Withdrawn(asset, recipient, amount);
    }

    /// @notice Either enrolled passkey can replace ownership and revoke outstanding commands.
    function rotate(
        Ownership calldata owners,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        _validate(owners);
        _authorize(ROTATE, keccak256(abi.encode(owners)), deadline, backup, auth);
        _replace(owners);
    }

    /// @notice EIP-712 recovery can be submitted without the passkey origin or platform relayer.
    function recover(Ownership calldata owners, uint256 deadline, bytes calldata signature)
        external
        locked
    {
        _validate(owners);
        if (block.timestamp >= deadline) revert Expired();
        bytes32 digest = commandDigest(RECOVER, keccak256(abi.encode(owners)), deadline);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (
            ownership.recovery == address(0) || err != ECDSA.RecoverError.NoError
                || signer != ownership.recovery
        ) revert Unauthorized();
        ++recoveryNonce;
        _replace(owners);
        emit CommandExecuted(digest, RECOVER);
    }

    function _authorize(
        bytes32 action,
        bytes32 terms,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) private {
        if (block.timestamp >= deadline) revert Expired();
        Key memory key = backup ? ownership.backup : ownership.primary;
        bytes32 digest = commandDigest(action, terms, deadline);
        if (
            epoch == 0 || (key.x == 0 && key.y == 0)
                || !StrictWebAuthn.verify(digest, auth, key.x, key.y, rpIdHash, origin)
        ) revert Unauthorized();
        ++nonce;
        emit CommandExecuted(digest, action);
    }

    function _replace(Ownership calldata owners) private {
        ownership = owners;
        ++epoch;
        emit OwnershipChanged(epoch, keccak256(abi.encode(owners)));
    }

    function _validate(Ownership calldata owners) private pure {
        if (!P256.isValidPublicKey(owners.primary.x, owners.primary.y)) revert InvalidPolicy();
        if (owners.backup.x != 0 || owners.backup.y != 0) {
            if (
                !P256.isValidPublicKey(owners.backup.x, owners.backup.y)
                    || (owners.primary.x == owners.backup.x && owners.primary.y == owners.backup.y)
            ) revert InvalidPolicy();
        }
    }
}
