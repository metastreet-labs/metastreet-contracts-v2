// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../integrations/CyberKongz/IYieldHub.sol";

import "./IKongzBundleCollateralWrapper.sol";

/**
 * @title Test Contract Wrapper for KongzBundleCollateralWrapper
 * @author MetaStreet Labs
 */
contract TestKongzBundleCollateralWrapper {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Input length mismatch
     */
    error MismatchLength();

    /**
     * @notice Mismatched banana balances
     */
    error MismatchBalance();

    /**
     * @notice Mismatched claimable bananas
     */
    error MismatchClaimable();

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    IKongzBundleCollateralWrapper public immutable _kongzBundleCollateralWrapper;

    IERC721 public immutable _kongz;

    IERC20 public immutable _banana;

    IYieldHub internal immutable _yieldHub;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address kongzBundleCollateralWrapper, address kongz, address banana, address yieldHub) {
        _kongzBundleCollateralWrapper = IKongzBundleCollateralWrapper(kongzBundleCollateralWrapper);
        _kongz = IERC721(kongz);
        _banana = IERC20(banana);
        _yieldHub = IYieldHub(yieldHub);

        _kongz.setApprovalForAll(kongzBundleCollateralWrapper, true);
    }

    /**
     * @notice Claim rewards for bundle collateral token ID and validate
     * claimed amount against control
     *
     * @param tokenId Bundle collateral token ID
     * @param context Context
     */
    function claim(uint256 tokenId, bytes calldata context) public {
        /* Get claimable from yield hub and colleteral wrapper */
        (uint256 controlClaimable, uint256 bundleClaimable) = claimable(tokenId, context);

        /* Validate claimable from control and collateral wrapper matches */
        if (controlClaimable != bundleClaimable) revert MismatchClaimable();

        /* Get balance of before get rewards and claim */
        uint256 bananaBalanceBefore = _banana.balanceOf(address(this));

        /* Get rewards and claim */
        _kongzBundleCollateralWrapper.claim(tokenId, context);
        _yieldHub.getTokenReward(address(_banana));

        /* Get balance of after get rewards and unwrap */
        uint256 bananaBalanceAfter = _banana.balanceOf(address(this));

        /* Validate balance delta is correct */
        if (bananaBalanceAfter - bananaBalanceBefore != controlClaimable + bundleClaimable) revert MismatchBalance();
    }

    /**
     * @notice Unwrap bundle collateral ID and validate claimed amount against control
     *
     * @param tokenId Bundle collateral token ID
     * @param context Context
     */
    function unwrap(uint256 tokenId, bytes calldata context) public {
        /* Get claimable from yield hub and colleteral wrapper */
        (uint256 controlClaimable, uint256 bundleClaimable) = claimable(tokenId, context);

        /* Validate claimable from control and collateral wrapper matches */
        if (controlClaimable != bundleClaimable) revert MismatchClaimable();

        /* Get balance of before get rewards and unwrap */
        uint256 bananaBalanceBefore = _banana.balanceOf(address(this));

        /* Get rewards and unwrap */
        _kongzBundleCollateralWrapper.unwrap(tokenId, context);
        _yieldHub.getTokenReward(address(_banana));

        /* Get balance of after get rewards and unwrap */
        uint256 bananaBalanceAfter = _banana.balanceOf(address(this));

        /* Validate balance delta is correct */
        if (bananaBalanceAfter - bananaBalanceBefore != controlClaimable + bundleClaimable) revert MismatchBalance();
    }

    /**
     * @notice Get claimable from yield hub (control) and collateral wrapper
     *
     * @param tokenId Bundle collateral token ID
     * @param context Context
     */
    function claimable(uint256 tokenId, bytes calldata context) public view returns (uint256, uint256) {
        return (
            _yieldHub.getTotalClaimable(address(this), address(_banana)) /* Control claimable */,
            _kongzBundleCollateralWrapper.claimable(tokenId, context) /* Bundle claimable */
        );
    }

    /**
     * @notice Transfer token IDs to this contract. Control token IDs stay in this contract.
     * The others will be minted as a bundle through the collateral wrapper
     *
     * @param tokenIdsControl Control token IDs
     * @param tokenIds Token IDs to be minted
     */
    function mint(uint256[] calldata tokenIdsControl, uint256[] calldata tokenIds) public {
        if (tokenIdsControl.length != tokenIds.length) revert MismatchLength();

        /* Control token IDs */
        for (uint256 i; i < tokenIdsControl.length; i++) {
            _kongz.transferFrom(msg.sender, address(this), tokenIdsControl[i]);
        }

        /* Token IDs to mint */
        for (uint256 i; i < tokenIds.length; i++) {
            _kongz.transferFrom(msg.sender, address(this), tokenIds[i]);
        }
        _kongzBundleCollateralWrapper.mint(tokenIds);
    }
}
