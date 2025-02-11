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

interface INodePassToken {
    function yieldPass() external view returns (address);
}

/**
 * @title Node Pass Collateral Filter
 * @author MetaStreet Labs
 */
contract NodePassCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* Error */
    /**************************************************************************/

    /**
     * @notice Invalid yield pass
     */
    error InvalidYieldPass();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Yield pass factory
     */
    IYieldPass private immutable _yieldPassFactory;

    /**
     * @notice Underlying node token
     */
    address private _nodeToken;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice NodePassCollateralFilter constructor
     * @param yieldPassFactory_ Yield pass factory
     */
    constructor(address yieldPassFactory_) {
        _yieldPassFactory = IYieldPass(yieldPassFactory_);
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice NodePassCollateralFilter initializer
     */
    function _initialize(address nodeToken_) internal {
        _nodeToken = nodeToken_;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "NodePassCollateralFilter";
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
        bytes calldata
    ) internal view override returns (bool) {
        /* Get yield pass */
        address yieldPass = INodePassToken(token).yieldPass();

        /* Get yield pass info */
        IYieldPass.YieldPassInfo memory yieldPassInfo = _yieldPassFactory.yieldPassInfo(yieldPass);

        /* Validate yield pass is valid */
        if (yieldPassInfo.nodeToken != _nodeToken) revert InvalidYieldPass();

        /* Validate yield pass is valid */
        return yieldPassInfo.nodePass == token && yieldPassInfo.expiryTime > block.timestamp;
    }
}
