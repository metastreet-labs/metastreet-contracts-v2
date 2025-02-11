// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "./CollateralFilter.sol";

/**
 * @title Yield Pass Interface
 * @author MetaStreet Foundation
 */
interface IYieldPass {
    /**
     * @notice Yield pass info
     * @param startTime Start timestamp
     * @param expiryTime Expiry timestamp
     * @param nodeToken Node token
     * @param yieldPass Yield pass token
     * @param nodePass Node pass token
     * @param yieldAdapter Yield adapter
     */
    struct YieldPassInfo {
        uint64 startTime;
        uint64 expiryTime;
        address nodeToken;
        address yieldPass;
        address nodePass;
        address yieldAdapter;
    }

    /**
     * @notice Get yield pass info
     * @param yieldPass Yield pass token
     * @return Yield pass info
     */
    function yieldPassInfo(address yieldPass) external view returns (YieldPassInfo memory);
}

/**
 * @title Yield Pass Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract YieldPassCollectionCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Yield pass market
     */
    IYieldPass private _yieldPassMarket;

    /**
     * @notice Underlying node token
     */
    address private _nodeToken;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice YieldPassCollectionCollateralFilter initializer
     */
    function _initialize(address yieldPassMarket_, address nodeToken_) internal {
        if (yieldPassMarket_ == address(0)) revert InvalidCollateralFilterParameters();

        _yieldPassMarket = IYieldPass(yieldPassMarket_);
        _nodeToken = nodeToken_;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "YieldPassCollectionCollateralFilter";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_VERSION() external pure override returns (string memory) {
        return "1.0";
    }

    /**
     * @inheritdoc CollateralFilter
     * @dev Used in Pool for querying price oracle
     * @dev Used in ERC20DepositTokenImplementation for metadata
     */
    function collateralToken() public view override returns (address) {
        return _nodeToken;
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralTokens() external view override returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = _nodeToken;

        return tokens;
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function _collateralSupported(
        address token,
        uint256,
        uint256,
        bytes calldata context
    ) internal view override returns (bool) {
        /* Decode yield pass */
        address yieldPass = abi.decode(context, (address));

        /* Get yield pass info */
        IYieldPass.YieldPassInfo memory yieldPassInfo = _yieldPassMarket.yieldPassInfo(yieldPass);

        /* Validate yield pass is valid */
        return yieldPassInfo.nodePass == token && yieldPassInfo.expiryTime > block.timestamp;
    }
}
