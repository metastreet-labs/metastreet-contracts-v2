// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/IPool.sol";
import "../LoanReceipt.sol";

/**
 * @title External Collateral Liquidator (trusted)
 * @author MetaStreet Labs
 */
contract ExternalCollateralLiquidator is AccessControl, ICollateralLiquidator {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Access Control Roles */
    /**************************************************************************/

    /**
     * @notice Collateral liquidator role
     */
    bytes32 public constant COLLATERAL_LIQUIDATOR_ROLE = keccak256("COLLATERAL_LIQUIDATOR");

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid transfer
     */
    error InvalidTransfer();

    /**
     * @notice Invalid collateral state
     */
    error InvalidCollateralState();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when collateral is received
     * @param collateralHash Collateral hash
     * @param pool Pool that provided collateral
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     */
    event CollateralReceived(
        bytes32 indexed collateralHash,
        address indexed pool,
        address collateralToken,
        uint256 collateralTokenId
    );

    /**
     * @notice Emitted when collateral is withdrawn
     * @param collateralHash Collateral hash
     * @param pool Pool that provided collateral
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     */
    event CollateralWithdrawn(
        bytes32 indexed collateralHash,
        address indexed pool,
        address collateralToken,
        uint256 collateralTokenId
    );

    /**
     * @notice Emitted when collateral is liquidated
     * @param collateralHash Collateral hash
     * @param pool Pool that provided collateral
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     * @param proceeds Proceeds in currency tokens
     */
    event CollateralLiquidated(
        bytes32 indexed collateralHash,
        address indexed pool,
        address collateralToken,
        uint256 collateralTokenId,
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
     * @notice Initialized boolean
     */
    bool private _initialized;

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
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     */
    function initialize() external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/
    /**
     * Get collateral status
     * @param collateralHash Collateral hash
     * @return Collateral tracker
     */
    function collateralStatus(bytes32 collateralHash) external view returns (CollateralStatus) {
        return _collateralTracker[collateralHash];
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
        if (operator != from) revert InvalidCaller();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(data);

        /* Validate collateral is received */
        if (IERC721(receipt.collateralToken).ownerOf(receipt.collateralTokenId) != address(this))
            revert InvalidTransfer();

        /* Compute collateral hash */
        bytes32 collateralHash = keccak256(abi.encodePacked(block.chainid, from, data));

        /* Update collateral tracker */
        _collateralTracker[collateralHash] = CollateralStatus.Present;

        emit CollateralReceived(collateralHash, from, receipt.collateralToken, receipt.collateralTokenId);

        return this.onERC721Received.selector;
    }

    /**
     * @notice Withdraw collateral
     *
     * Emits a {CollateralWithdrawn} event.
     *
     * @param pool Pool that provided the collateral
     * @param loanReceipt Loan receipt
     */
    function withdrawCollateral(
        address pool,
        bytes calldata loanReceipt
    ) external onlyRole(COLLATERAL_LIQUIDATOR_ROLE) {
        /* Compute collateral hash */
        bytes32 collateralHash = keccak256(abi.encodePacked(block.chainid, pool, loanReceipt));

        /* Validate collateral is present */
        if (_collateralTracker[collateralHash] != CollateralStatus.Present) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer collateral to caller */
        IERC721(receipt.collateralToken).safeTransferFrom(address(this), msg.sender, receipt.collateralTokenId);

        /* Update collateral tracker */
        _collateralTracker[collateralHash] = CollateralStatus.Withdrawn;

        emit CollateralWithdrawn(collateralHash, pool, receipt.collateralToken, receipt.collateralTokenId);
    }

    /**
     * @notice Liquidate collateral
     *
     * Emits a {CollateralLiquidated} event.
     *
     * @param pool Pool that provided the collateral
     * @param loanReceipt Loan receipt
     * @param proceeds Proceeds from collateral liquidation
     */
    function liquidateCollateral(
        address pool,
        bytes calldata loanReceipt,
        uint256 proceeds
    ) external onlyRole(COLLATERAL_LIQUIDATOR_ROLE) {
        /* Compute collateral hash */
        bytes32 collateralHash = keccak256(abi.encodePacked(block.chainid, pool, loanReceipt));

        /* Validate collateral is withdrawn */
        if (_collateralTracker[collateralHash] != CollateralStatus.Withdrawn) revert InvalidCollateralState();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.decode(loanReceipt);

        /* Transfer proceeds from caller to this contract */
        IERC20(IPool(pool).currencyToken()).safeTransferFrom(msg.sender, address(this), proceeds);

        /* Approve pool to pull funds from this contract */
        IERC20(IPool(pool).currencyToken()).approve(pool, proceeds);

        /* Callback into pool */
        IPool(pool).onCollateralLiquidated(loanReceipt, proceeds);

        /* Remove collateral tracker */
        delete _collateralTracker[collateralHash];

        emit CollateralLiquidated(collateralHash, pool, receipt.collateralToken, receipt.collateralTokenId, proceeds);
    }
}
