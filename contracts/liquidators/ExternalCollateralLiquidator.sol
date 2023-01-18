// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/IPool.sol";
import "../LoanReceipt.sol";

import "hardhat/console.sol";

/**
 * @title External Collateral Liquidator (trusted)
 * @author MetaStreet Labs
 */
contract ExternalCollateralLiquidator is Ownable, ICollateralLiquidator {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid collateral state
     */
    error InvalidCollateralState();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when collateral is withdrawn
     * @param account Account
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     * @param loanReceiptHash Loan receipt hash
     */
    event CollateralWithdrawn(
        address indexed account,
        address indexed collateralToken,
        uint256 collateralTokenId,
        bytes32 loanReceiptHash
    );

    /**
     * @notice Emitted when collateral is liquidated
     * @param account Account
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     * @param proceeds Proceeds in currency tokens
     * @param loanReceiptHash Loan receipt hash
     */
    event CollateralLiquidated(
        address indexed account,
        address indexed collateralToken,
        uint256 collateralTokenId,
        bytes32 loanReceiptHash,
        uint256 proceeds
    );

    /**************************************************************************/
    /* Enums */
    /**************************************************************************/

    /**
     * @notice Collateral Status
     */
    enum CollateralStatus {
        Absent,
        Present,
        Withdrawn
    }

    /**
     * @notice Collateral Tracker
     * @param status Collateral status
     * @param pool Associated pool
     */
    struct CollateralTracker {
        CollateralStatus status;
        IPool pool;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @dev Approved pools
     */
    mapping(address => bool) private _approvedPools;

    /**
     * @dev Collateral tracker
     */
    mapping(bytes32 => CollateralTracker) private _collateralTracker;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice ExternalCollateralLiquidator constructor
     */
    constructor() {}

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * Get approved pool status
     * @param pool Pool
     * @return True if approved, otherwise false
     */
    function isApprovedPool(address pool) external view returns (bool) {
        return _approvedPools[pool];
    }

    /**
     * Get collateral tracker
     * @param loanReceiptHash Loan receipt hash
     * @return Collateral tracker
     */
    function collateralTracker(bytes32 loanReceiptHash) external view returns (CollateralTracker memory) {
        return _collateralTracker[loanReceiptHash];
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralLiquidator
     */
    function name() external pure returns (string memory) {
        return "ExternalCollateralLiquidator";
    }

    /**
     * @inheritdoc IERC721Receiver
     */
    function onERC721Received(
        address operator,
        address from,
        uint256,
        bytes calldata data
    ) external virtual returns (bytes4) {
        /* Validate caller */
        if (operator != from || !_approvedPools[from]) revert InvalidCaller();

        /* Get loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(data);

        /* Update collateral tracker */
        _collateralTracker[loanReceiptHash] = CollateralTracker({status: CollateralStatus.Present, pool: IPool(from)});

        return this.onERC721Received.selector;
    }

    /**
     * @notice Withdraw collateral
     *
     * Emits a {CollateralWithdrawn} event.
     *
     * @param loanReceipt Loan receipt
     */
    function withdrawCollateral(bytes calldata loanReceipt) external onlyOwner {
        /* Look up collateral tracker */
        bytes32 loanReceiptHash = LoanReceipt.hash(loanReceipt);
        CollateralTracker storage collateral = _collateralTracker[loanReceiptHash];

        /* Validate collateral is present */
        if (collateral.status != CollateralStatus.Present) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer collateral to caller */
        IERC721(receipt.collateralToken).safeTransferFrom(address(this), msg.sender, receipt.collateralTokenId);

        /* Update collateral tracker */
        collateral.status = CollateralStatus.Withdrawn;

        emit CollateralWithdrawn(msg.sender, receipt.collateralToken, receipt.collateralTokenId, loanReceiptHash);
    }

    /**
     * @notice Liquidate collateral
     *
     * Emits a {CollateralLiquidated} event.
     *
     * @param loanReceipt Loan receipt
     * @param proceeds Proceeds from collateral liquidation
     */
    function liquidateCollateral(bytes calldata loanReceipt, uint256 proceeds) external onlyOwner {
        /* Look up collateral tracker */
        bytes32 loanReceiptHash = LoanReceipt.hash(loanReceipt);
        CollateralTracker storage collateral = _collateralTracker[loanReceiptHash];

        /* Validate collateral is withdrawn */
        if (collateral.status != CollateralStatus.Withdrawn) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer proceeds from caller to this contract */
        IERC20(collateral.pool.currencyToken()).safeTransferFrom(msg.sender, address(this), proceeds);

        /* Callback into pool */
        collateral.pool.onCollateralLiquidated(loanReceipt, proceeds);

        /* Remove collateral tracker */
        delete _collateralTracker[loanReceiptHash];

        emit CollateralLiquidated(
            msg.sender,
            receipt.collateralToken,
            receipt.collateralTokenId,
            loanReceiptHash,
            proceeds
        );
    }

    /**
     * @notice Add an approved pool
     */
    function addPool(IPool pool) external onlyOwner {
        /* Approve pool to pull funds from this contract */
        IERC20(pool.currencyToken()).approve(address(pool), type(uint256).max);

        _approvedPools[address(pool)] = true;
    }

    /**
     * @notice Remove an approved pool
     */
    function removePool(IPool pool) external onlyOwner {
        if (!_approvedPools[address(pool)]) return;

        /* Reset token approval */
        IERC20(pool.currencyToken()).approve(address(pool), 0);

        _approvedPools[address(pool)] = false;
    }
}
