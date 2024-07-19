// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../interfaces/IPriceOracle.sol";

/**
 * @title Test Contract for price oracle
 * @author MetaStreet Labs
 */
contract TestPriceOracle is IPriceOracle {
    /**
     * @notice Oracle price
     */
    uint256 internal _oraclePrice = 30 ether;

    /**
     * @notice Set oracle price
     * @param oraclePrice Oracle price
     */
    function setPrice(uint256 oraclePrice) external {
        _oraclePrice = oraclePrice;
    }

    /**
     * @inheritdoc IPriceOracle
     */
    function price(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes calldata
    ) external view returns (uint256) {
        return _oraclePrice;
    }
}
