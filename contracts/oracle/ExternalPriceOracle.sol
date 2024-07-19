// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "./PriceOracle.sol";

import "../interfaces/IPriceOracle.sol";

/**
 * @title External Price Oracle
 * @author MetaStreet Labs
 */
contract ExternalPriceOracle is PriceOracle {
    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @custom:storage-location erc7201:externalPriceOracle.priceOracleStorage
     * @param addr Price oracle address
     */
    struct PriceOracleStorage {
        address addr;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Price oracle storage slot
     * @dev keccak256(abi.encode(uint256(keccak256("externalPriceOracle.priceOracleStorage")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 private constant PRICE_ORACLE_LOCATION = 0x5cc3a0ef4fb602d81e01a142e768b704108e3b2e96852939d75763e011a39b00;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice ExternalPriceOracle initializer
     */
    function __initialize(address addr) internal {
        _getPriceOracleStorage().addr = addr;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Get reference to ERC-7201 price oracle address storage
     *
     * @return $ Reference to price oracle address storage
     */
    function _getPriceOracleStorage() private pure returns (PriceOracleStorage storage $) {
        assembly {
            $.slot := PRICE_ORACLE_LOCATION
        }
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get price oracle address
     *
     * @return Price oracle address
     */
    function priceOracle() public view returns (address) {
        return _getPriceOracleStorage().addr;
    }

    /**
     * @inheritdoc PriceOracle
     */
    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory tokenIds,
        uint256[] memory tokenIdQuantities,
        bytes calldata oracleContext
    ) public view override returns (uint256) {
        /* Cache price oracle address */
        address priceOracle_ = priceOracle();

        /* Return oracle price if price oracle exists, else 0 */
        return
            priceOracle_ != address(0)
                ? IPriceOracle(priceOracle_).price(
                    collateralToken,
                    currencyToken,
                    tokenIds,
                    tokenIdQuantities,
                    oracleContext
                )
                : 0;
    }
}
