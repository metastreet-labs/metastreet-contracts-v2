// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/IPool.sol";
import "../LoanReceipt.sol";

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

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @dev Associated pool
     */
    IPool private _pool;

    /**
     * @dev Collateral tracker
     */
    mapping(bytes32 => CollateralStatus) private _collateralTracker;

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
     * Get associated pool
     * @return Pool address
     */
    function pool() external view returns (address) {
        return address(_pool);
    }

    /**
     * Get collateral status
     * @param loanReceiptHash Loan receipt hash
     * @return Collateral tracker
     */
    function collateralStatus(bytes32 loanReceiptHash) external view returns (CollateralStatus) {
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
        if (operator != from || from != address(_pool)) revert InvalidCaller();

        /* Get loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(data);

        /* Update collateral tracker */
        _collateralTracker[loanReceiptHash] = CollateralStatus.Present;

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

        /* Validate collateral is present */
        if (_collateralTracker[loanReceiptHash] != CollateralStatus.Present) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer collateral to caller */
        IERC721(receipt.collateralToken).safeTransferFrom(address(this), msg.sender, receipt.collateralTokenId);

        /* Update collateral tracker */
        _collateralTracker[loanReceiptHash] = CollateralStatus.Withdrawn;

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

        /* Validate collateral is withdrawn */
        if (_collateralTracker[loanReceiptHash] != CollateralStatus.Withdrawn) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer proceeds from caller to this contract */
        IERC20(_pool.currencyToken()).safeTransferFrom(msg.sender, address(this), proceeds);

        /* Callback into pool */
        _pool.onCollateralLiquidated(loanReceipt, proceeds);

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
     * @notice Set associated pool
     */
    function setPool(IPool newPool) external onlyOwner {
        if (address(_pool) != address(0)) {
            /* Reset token approval on current pool */
            IERC20(_pool.currencyToken()).approve(address(_pool), 0);
        }

        /* Approve pool to pull funds from this contract */
        IERC20(newPool.currencyToken()).approve(address(newPool), type(uint256).max);

        _pool = newPool;
    }
}
