// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {IAlloraAdapter, AlloraAdapterNumericData} from "../integrations/Allora/IAlloraAdapter.sol";

import "../interfaces/IPriceOracle.sol";

/**
 * @title Allora Price Oracle
 * @author MetaStreet Labs
 * @dev Assumes that topic ID implies a fixed collateral collection address
 * and a fixed currency (possibly fiat).
 */
contract AlloraPriceOracle is IPriceOracle {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid topic ID
     */
    error InvalidTopicId();

    /**
     * @notice Invalid data
     */
    error InvalidData();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Allora Adapter
     */
    IAlloraAdapter internal immutable _alloraAdapter;

    /**
     * @notice Allora Topic ID
     */
    uint256 internal immutable _topicId;

    /**
     * @notice Pool currency token
     */
    address internal immutable _currencyToken;

    /**
     * @notice Scale factor
     */
    uint256 internal immutable _scaleFactor;

    /**
     * @notice Scale direction
     */
    bool internal immutable _isScaleUp;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Allora Price Oracle constructor
     * @param alloraAdapter_ Allora adapter address
     * @param topicId Allora topic ID
     */
    constructor(address alloraAdapter_, uint256 topicId, uint8 quoteDecimals, address currencyToken) {
        if (topicId != 2 && topicId != 4) revert InvalidTopicId();

        _alloraAdapter = IAlloraAdapter(alloraAdapter_);
        _topicId = topicId;
        _currencyToken = currencyToken;

        /* Set scale direction and factor */
        uint8 decimals = IERC20Metadata(currencyToken).decimals();
        _isScaleUp = decimals > quoteDecimals;
        _scaleFactor = 10 ** (decimals > quoteDecimals ? decimals - quoteDecimals : quoteDecimals - decimals);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get price oracle implementation version
     * @return Price oracle implementation version
     */
    function IMPLEMENTATION_VERSION() external pure returns (string memory) {
        return "1.0";
    }

    /**
     * @notice Get Allora API version
     * @return Allora API version
     */
    function ALLORA_API_VERSION() external pure returns (string memory) {
        return "v1";
    }

    /**
     * @notice Get Allora adapter address
     * @return Allora adapter address
     */
    function alloraAdapter() external view returns (address) {
        return address(_alloraAdapter);
    }

    /**************************************************************************/
    /* Helpers */
    /**************************************************************************/

    /**
     * @notice Scale price from price oracle
     * @param value Value
     * @return Scaled price
     */
    function _scale(uint256 value) internal view returns (uint256) {
        if (_isScaleUp) {
            return value * _scaleFactor;
        } else {
            return value / _scaleFactor;
        }
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @inheritdoc IPriceOracle
     * @dev Assumes that topic ID implies a fixed collateral collection address
     * and a fixed (possibly fiat).
     */
    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory collateralTokenIds,
        uint256[] memory collateralTokenQuantities,
        bytes calldata oracleContext
    ) external view override returns (uint256) {
        /* Decode oracle context into AlloraAdapterNumericData */
        AlloraAdapterNumericData[] memory alloraAdapterNumericData = abi.decode(
            oracleContext,
            (AlloraAdapterNumericData[])
        );

        /* Validate currency token & array lengths */
        if (currencyToken != _currencyToken) revert InvalidData();
        if (
            collateralTokenIds.length != collateralTokenQuantities.length ||
            collateralTokenIds.length != alloraAdapterNumericData.length
        ) revert InvalidData();

        /* Validate and aggregate oracle prices */
        uint256 topicId = _topicId;
        uint256 totalOraclePrice;
        uint256 count;
        for (uint256 i; i < collateralTokenIds.length; i++) {
            /* Validate topic ID */
            if (alloraAdapterNumericData[i].numericData.topicId != topicId) revert InvalidData();

            /* Validate numeric data */
            (uint256 oraclePrice, ) = _alloraAdapter.verifyDataViewOnly(alloraAdapterNumericData[i]);

            /* Validate collateral token and collateral token ID */
            if (
                keccak256(abi.encodePacked(collateralToken, collateralTokenIds[i])) !=
                bytes32(alloraAdapterNumericData[i].numericData.extraData)
            ) revert InvalidData();

            /* Update total oracle price and collateral token count */
            totalOraclePrice += oraclePrice * collateralTokenQuantities[i];
            count += collateralTokenQuantities[i];
        }

        /* Return scaled average collateral token price */
        return _scale(totalOraclePrice / count);
    }
}
