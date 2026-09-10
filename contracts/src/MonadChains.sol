// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library MonadChains {
    uint256 internal constant MAINNET = 143;
    uint256 internal constant TESTNET = 10_143;

    function isSupported(uint256 chainId) internal pure returns (bool) {
        return chainId == MAINNET || chainId == TESTNET;
    }
}
