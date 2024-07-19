// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IPriceOracle.sol";

import "../integrations/Chainlink/AggregatorV3Interface.sol";
import "../integrations/Chainlink/FeedRegistryInterface.sol";

/**
 * @title Chainlink Price Oracle
 * @author MetaStreet Labs
 */
contract ChainlinkPriceOracle is IPriceOracle {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid rate
     */
    error InvalidRate();

    /**
     * @notice Invalid floor price
     */
    error InvalidFloorPrice();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice NFT price oracle
     */
    AggregatorV3Interface internal immutable _nftPriceOracle;

    /**
     * @notice Currency price feed registry
     */
    FeedRegistryInterface internal immutable _priceFeedRegistry;

    /**
     * @notice Currency of oracle price
     * @dev Address for ETH: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
     */
    address internal immutable _oracleCurrency;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Chainlink Price Oracle constructor
     * @param nftPriceOracle_ Address for price oracle of a given NFT collection
     * @param priceFeedRegistry_ Address for registry of currency price feeds
     * @param oracleCurrency_ Currency the oracle price is denominated in
     */
    constructor(address nftPriceOracle_, address priceFeedRegistry_, address oracleCurrency_) {
        _nftPriceOracle = AggregatorV3Interface(nftPriceOracle_);
        _priceFeedRegistry = FeedRegistryInterface(priceFeedRegistry_);
        _oracleCurrency = oracleCurrency_;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get address of NFT price oracle
     * @return NFT price oracle
     */
    function nftPriceOracle() external view returns (address) {
        return address(_nftPriceOracle);
    }

    /**
     * @notice Get address of price feed registry
     * @return Price feed registry
     */
    function priceFeedRegistry() external view returns (address) {
        return address(_priceFeedRegistry);
    }

    /**
     * @notice Get address of the NFT price oracle currency
     * @return Currency of the NFT price oracle
     */
    function oracleCurrency() external view returns (address) {
        return _oracleCurrency;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Get value of given currency in oracle currency
     * @dev Price feed registry will revert if feed does not exist
     * @param currencyToken Currency token
     * @return Value of given currency in oracle currency
     */
    function _exchangeRate(address currencyToken) internal view returns (uint256) {
        /* Get price of currency token in terms of oracle currency */
        (, int256 rate, , , ) = _priceFeedRegistry.latestRoundData(currencyToken, _oracleCurrency);

        /* Validate rate is non-zero and non-negative */
        if (rate <= 0) revert InvalidRate();

        return uint256(rate);
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @inheritdoc IPriceOracle
     */
    function price(
        address,
        address currencyToken,
        uint256[] memory,
        uint256[] memory,
        bytes calldata
    ) external view override returns (uint256) {
        /* Get floor price in oracle currency, reverts if feed does not exist */
        (, int256 floorPrice, , , ) = _nftPriceOracle.latestRoundData();

        /* Validate floor price is non-zero and non-negative */
        if (floorPrice <= 0) revert InvalidFloorPrice();

        /* Return floor price denominated in given currency token */
        return Math.mulDiv(uint256(floorPrice), FIXED_POINT_SCALE, _exchangeRate(currencyToken)) / FIXED_POINT_SCALE;
    }
}
