// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { OpenBalanceAccount } from "./OpenBalanceAccount.sol";

contract AccountFactory {
    address public immutable implementation;
    event AccountCreated(address indexed account, bytes32 indexed salt);

    constructor() {
        implementation = address(new OpenBalanceAccount());
    }

    function predict(
        OpenBalanceAccount.Ownership calldata owners,
        bytes32 rp,
        string calldata site,
        bytes32 userSalt
    ) public view returns (address) {
        return Clones.predictDeterministicAddress(
            implementation, keccak256(abi.encode(owners, rp, site, userSalt)), address(this)
        );
    }

    /// @notice Repeated or front-run creation returns the same initialized user-owned account.
    function create(
        OpenBalanceAccount.Ownership calldata owners,
        bytes32 rp,
        string calldata site,
        bytes32 userSalt
    ) external returns (address account) {
        bytes32 salt = keccak256(abi.encode(owners, rp, site, userSalt));
        account = predict(owners, rp, site, userSalt);
        if (account.code.length != 0) return account;
        account = Clones.cloneDeterministic(implementation, salt);
        OpenBalanceAccount(account).initialize(owners, rp, site);
        emit AccountCreated(account, salt);
    }
}
