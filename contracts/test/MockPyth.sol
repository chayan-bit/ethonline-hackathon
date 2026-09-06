// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {MockPyth as UpstreamMockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @dev Test-only wrapper. Production deployments must use the configured Pyth address.
contract MockPyth is UpstreamMockPyth {
    constructor(uint256 validTimePeriod, uint256 singleUpdateFeeInWei)
        UpstreamMockPyth(validTimePeriod, singleUpdateFeeInWei)
    {}
}
