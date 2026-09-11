// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { P256 } from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import { WebAuthn } from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { StrictWebAuthn } from "../StrictWebAuthn.sol";

interface IExactPayRouter {
    function eventId() external view returns (bytes32);
    function asset() external view returns (IERC20);
    function quote(bytes calldata intent)
        external
        view
        returns (bytes32 digest, address asset, uint256 gross, address payer);
    function pay(bytes calldata intent, bytes calldata terminalSignature) external;
    function cancel(bytes calldata intent, bytes calldata terminalSignature) external;
}

/// @notice Immutable account ownership core. Any caller may relay an authorized command.
contract OpenBalanceAccount is IERC1271 {
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

    struct OnlineSessionConfig {
        bytes32 sessionId;
        Key signer;
        bytes32 eventId;
        address router;
        address asset;
        uint256 maxPerPayment;
        uint256 maxTotal;
        uint48 validAfter;
        uint48 validUntil;
    }

    struct OnlineSession {
        Key signer;
        bytes32 eventId;
        address router;
        address asset;
        uint256 maxPerPayment;
        uint256 maxTotal;
        uint256 spentGross;
        uint48 validAfter;
        uint48 validUntil;
        uint256 accountEpoch;
        uint256 revision;
        bool active;
    }

    bytes32 private constant DOMAIN_TYPE = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant COMMAND_TYPE = keccak256(
        "Command(bytes32 action,bytes32 terms,uint256 epoch,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant SESSION_PAYMENT_TYPE = keccak256(
        "SessionPayment(bytes32 sessionId,uint256 revision,bytes32 intentDigest,uint256 accountEpoch)"
    );
    bytes32 public constant WITHDRAW = keccak256("WITHDRAW");
    bytes32 public constant ROTATE = keccak256("ROTATE");
    bytes32 public constant RECOVER = keccak256("RECOVER");
    bytes32 public constant SET_VALIDATOR = keccak256("SET_VALIDATOR");
    bytes32 public constant ERC1271_CALL = keccak256("ERC1271_CALL");
    bytes32 public constant PAY = keccak256("PAY");
    bytes32 public constant CANCEL = keccak256("CANCEL");
    bytes32 public constant SET_SESSION = keccak256("SET_SESSION");
    bytes32 public constant REVOKE_SESSION = keccak256("REVOKE_SESSION");
    bytes4 private constant INVALID_SIGNATURE = 0xffffffff;
    address public immutable factory;
    bool private initialized;
    bool private entered;
    Ownership public ownership;
    bytes32 public rpIdHash;
    string public origin;
    uint256 public epoch;
    uint256 public nonce;
    uint256 public recoveryNonce;
    mapping(address validator => bool enabled) public validators;
    mapping(bytes32 sessionId => OnlineSession session) public onlineSessions;
    mapping(bytes32 sessionId => uint256 revision) public sessionRevisions;

    error InvalidPolicy();
    error Unauthorized();
    error Expired();
    error Reentrant();
    event OwnershipChanged(uint256 indexed epoch, bytes32 ownershipHash);
    event CommandExecuted(bytes32 indexed digest, bytes32 indexed action);
    event Withdrawn(address indexed asset, address indexed recipient, uint256 amount);
    event ValidatorPermissionChanged(address indexed validator, bool enabled);
    event PaymentCommandExecuted(address indexed router, bytes32 indexed intentDigest);
    event CancellationCommandExecuted(address indexed router, bytes32 indexed intentDigest);
    event OnlineSessionSet(
        bytes32 indexed sessionId,
        uint256 indexed revision,
        address indexed router,
        bytes32 eventId,
        address asset,
        uint256 maxPerPayment,
        uint256 maxTotal,
        uint48 validAfter,
        uint48 validUntil
    );
    event OnlineSessionRevoked(bytes32 indexed sessionId, uint256 indexed revision);
    event SessionPaymentExecuted(
        bytes32 indexed sessionId,
        uint256 indexed revision,
        bytes32 indexed intentDigest,
        uint256 gross,
        uint256 spentGross
    );

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
        uint256 sequence = action == RECOVER ? recoveryNonce : nonce;
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
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

    /// @notice Grants or revokes one contract's ability to validate purpose-bound signatures.
    function setValidator(
        address validator,
        bool enabled,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        if (
            validator == address(0) || validator == address(this)
                || (enabled && validator.code.length == 0)
        ) revert InvalidPolicy();
        _authorize(SET_VALIDATOR, keccak256(abi.encode(validator, enabled)), deadline, backup, auth);
        validators[validator] = enabled;
        emit ValidatorPermissionChanged(validator, enabled);
    }

    /// @notice Executes one exact terminal intent with no persistent token allowance.
    function pay(
        address router,
        bytes calldata intent,
        bytes calldata terminalSignature,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        if (router.code.length == 0) revert InvalidPolicy();
        (bytes32 intentDigest, address token, uint256 gross, address payer) =
            IExactPayRouter(router).quote(intent);
        if (token.code.length == 0 || gross == 0 || payer != address(this)) revert InvalidPolicy();
        _authorize(PAY, keccak256(abi.encode(router, intentDigest)), deadline, backup, auth);
        IERC20(token).forceApprove(router, gross);
        IExactPayRouter(router).pay(intent, terminalSignature);
        IERC20(token).forceApprove(router, 0);
        emit PaymentCommandExecuted(router, intentDigest);
    }

    /// @notice Cancels one payer-bound signed intent without granting spending authority.
    function cancelPayment(
        address router,
        bytes calldata intent,
        bytes calldata terminalSignature,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        if (router.code.length == 0) revert InvalidPolicy();
        (bytes32 intentDigest,,, address payer) = IExactPayRouter(router).quote(intent);
        if (payer != address(this)) revert InvalidPolicy();
        _authorize(CANCEL, keccak256(abi.encode(router, intentDigest)), deadline, backup, auth);
        IExactPayRouter(router).cancel(intent, terminalSignature);
        emit CancellationCommandExecuted(router, intentDigest);
    }

    function setOnlineSession(
        OnlineSessionConfig calldata config,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        if (
            config.sessionId == 0 || !P256.isValidPublicKey(config.signer.x, config.signer.y)
                || config.eventId == 0 || config.router.code.length == 0
                || config.asset.code.length == 0 || config.maxPerPayment == 0
                || config.maxTotal < config.maxPerPayment || config.validAfter >= config.validUntil
                || block.timestamp >= config.validUntil || onlineSessions[config.sessionId].active
                || IExactPayRouter(config.router).eventId() != config.eventId
                || address(IExactPayRouter(config.router).asset()) != config.asset
        ) revert InvalidPolicy();
        _authorize(SET_SESSION, onlineSessionTermsHash(config), deadline, backup, auth);
        uint256 revision = ++sessionRevisions[config.sessionId];
        onlineSessions[config.sessionId] = OnlineSession({
            signer: config.signer,
            eventId: config.eventId,
            router: config.router,
            asset: config.asset,
            maxPerPayment: config.maxPerPayment,
            maxTotal: config.maxTotal,
            spentGross: 0,
            validAfter: config.validAfter,
            validUntil: config.validUntil,
            accountEpoch: epoch,
            revision: revision,
            active: true
        });
        emit OnlineSessionSet(
            config.sessionId,
            revision,
            config.router,
            config.eventId,
            config.asset,
            config.maxPerPayment,
            config.maxTotal,
            config.validAfter,
            config.validUntil
        );
    }

    function revokeOnlineSession(
        bytes32 sessionId,
        uint256 expectedRevision,
        uint256 deadline,
        bool backup,
        WebAuthn.WebAuthnAuth calldata auth
    ) external locked {
        OnlineSession storage session = onlineSessions[sessionId];
        if (!session.active || session.revision != expectedRevision) revert InvalidPolicy();
        _authorize(
            REVOKE_SESSION,
            keccak256(abi.encode(sessionId, expectedRevision)),
            deadline,
            backup,
            auth
        );
        session.active = false;
        uint256 revision = ++sessionRevisions[sessionId];
        session.revision = revision;
        emit OnlineSessionRevoked(sessionId, revision);
    }

    function payWithOnlineSession(
        bytes32 sessionId,
        bytes calldata intent,
        bytes calldata terminalSignature,
        bytes32 r,
        bytes32 s
    ) external locked {
        OnlineSession storage session = onlineSessions[sessionId];
        if (
            !session.active || session.accountEpoch != epoch || block.timestamp < session.validAfter
                || block.timestamp >= session.validUntil
        ) revert Unauthorized();
        (bytes32 intentDigest, address token, uint256 gross, address payer) =
            IExactPayRouter(session.router).quote(intent);
        if (
            token != session.asset || payer != address(this) || gross == 0
                || gross > session.maxPerPayment || session.spentGross > session.maxTotal - gross
                || !P256.verify(
                    sessionPaymentDigest(sessionId, session.revision, intentDigest),
                    r,
                    s,
                    session.signer.x,
                    session.signer.y
                )
        ) revert Unauthorized();
        session.spentGross += gross;
        IERC20(token).forceApprove(session.router, gross);
        IExactPayRouter(session.router).pay(intent, terminalSignature);
        IERC20(token).forceApprove(session.router, 0);
        emit SessionPaymentExecuted(
            sessionId, session.revision, intentDigest, gross, session.spentGross
        );
    }

    function onlineSessionState(bytes32 sessionId)
        external
        view
        returns (uint256 spentGross, uint256 revision, bool active, uint256 accountEpoch)
    {
        OnlineSession storage session = onlineSessions[sessionId];
        return (session.spentGross, session.revision, session.active, session.accountEpoch);
    }

    function onlineSessionTermsHash(OnlineSessionConfig memory config)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(config));
    }

    function sessionPaymentDigest(bytes32 sessionId, uint256 revision, bytes32 intentDigest)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(
                    abi.encode(SESSION_PAYMENT_TYPE, sessionId, revision, intentDigest, epoch)
                )
            )
        );
    }

    /// @notice ERC-1271 validation is available only to explicitly authorized contracts.
    /// @dev The caller must enforce replay protection for its purpose-specific payload.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (!validators[msg.sender]) return INVALID_SIGNATURE;
        try this.validateErc1271(hash, signature, msg.sender) returns (bool valid) {
            return valid ? IERC1271.isValidSignature.selector : INVALID_SIGNATURE;
        } catch {
            return INVALID_SIGNATURE;
        }
    }

    /// @dev External self-call makes malformed ABI return the ERC-1271 invalid value, not a revert.
    function validateErc1271(bytes32 hash, bytes calldata signature, address validator)
        external
        view
        returns (bool)
    {
        if (msg.sender != address(this) || !validators[validator]) revert Unauthorized();
        (bytes32 purpose, uint256 deadline, bool backup, WebAuthn.WebAuthnAuth memory auth) =
            abi.decode(signature, (bytes32, uint256, bool, WebAuthn.WebAuthnAuth));
        if (purpose == 0 || block.timestamp >= deadline) return false;
        bytes32 digest = commandDigest(
            ERC1271_CALL, keccak256(abi.encode(validator, purpose, hash)), deadline
        );
        Key memory key = backup ? ownership.backup : ownership.primary;
        return epoch != 0 && (key.x != 0 || key.y != 0)
            && StrictWebAuthn.verify(digest, auth, key.x, key.y, rpIdHash, origin);
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

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("OpenBalanceAccount"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
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
