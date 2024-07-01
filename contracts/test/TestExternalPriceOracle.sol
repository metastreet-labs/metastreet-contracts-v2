// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../oracle/ExternalPriceOracle.sol";

/**
 * @title Test Contract for external price oracle
 * @author MetaStreet Labs
 */
contract TestExternalPriceOracle is ExternalPriceOracle {
    constructor(address addr) {
        ExternalPriceOracle.__initialize(addr);
    }

    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory tokenIds,
        uint256[] memory tokenIdQuantities,
        bytes calldata oracleContext,
        bytes memory /* Dummy variable to avoid same function sig as ExternalPriceOracle.price() */
    ) external view returns (uint256, uint256, address) {
        return ExternalPriceOracle.price(collateralToken, currencyToken, tokenIds, tokenIdQuantities, oracleContext);
    }
}
