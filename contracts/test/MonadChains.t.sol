// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import { MonadChains } from "../src/MonadChains.sol";

contract MonadChainsTest {
    function testRecognizesSupportedNetworks() public pure {
        assert(MonadChains.isSupported(MonadChains.MAINNET));
        assert(MonadChains.isSupported(MonadChains.TESTNET));
    }

    function testRejectsOtherNetworks(uint256 chainId) public pure {
        if (chainId != MonadChains.MAINNET && chainId != MonadChains.TESTNET) {
            assert(!MonadChains.isSupported(chainId));
        }
    }
}
