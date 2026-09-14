// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Explicitly labelled local-only six-decimal asset for reproducible Anvil scenarios.
contract LocalTestToken is ERC20 {
    error InvalidRecipient();

    constructor(address recipient, uint256 initialSupply) ERC20("Local Test USDC", "ltUSDC") {
        if (recipient == address(0)) revert InvalidRecipient();
        _mint(recipient, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
