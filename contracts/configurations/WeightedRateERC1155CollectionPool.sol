// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/CollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";
import "../wrappers/ERC1155CollateralWrapper.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and ERC1155 Collection
 * Collateral Filter
 * @dev Only supports ERC1155 transfers for quantity of 1
 * @author MetaStreet Labs
 */
contract WeightedRateERC1155CollectionPool is
    Pool,
    WeightedInterestRateModel,
    CollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice  ERC1155 collateral wrapper address
     */
    address private immutable _erc1155CollateralWrapper;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param collateralLiquidator Collateral liquidator
     * @param delegateRegistryV1 Delegation registry v1 contract
     * @param delegateRegistryV2 Delegation registry v2 contract
     * @param erc20DepositTokenImplementation ERC20 Deposit Token implementation address
     * @param collateralWrappers Collateral wrappers
     * @param erc1155CollateralWrapper ERC1155 collateral wrapper
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV1,
        address delegateRegistryV2,
        address erc20DepositTokenImplementation,
        address[] memory collateralWrappers,
        address erc1155CollateralWrapper
    )
        Pool(collateralLiquidator, delegateRegistryV1, delegateRegistryV2, collateralWrappers)
        WeightedInterestRateModel()
        ERC20DepositToken(erc20DepositTokenImplementation)
        ExternalPriceOracle()
    {
        /* Validate collateral wrappers are disabled */
        require(collateralWrappers.length == 0, "Disable collateral wrappers");

        /* Disable initialization of implementation contract */
        _storage.currencyToken = IERC20(address(1));

        /* Set ERC1155 collateral wrapper for liquidation */
        _erc1155CollateralWrapper = erc1155CollateralWrapper;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @dev Fee-on-transfer currency tokens are not supported
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(address(_storage.currencyToken) == address(0), "Already initialized");

        /* Decode parameters */
        (
            address[] memory collateralTokens_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_
        ) = abi.decode(params, (address[], address, address, uint64[], uint64[]));

        /* Initialize Collateral Filter */
        CollectionCollateralFilter._initialize(collateralTokens_);

        /* Initialize External Price Oracle */
        ExternalPriceOracle.__initialize(priceOracle_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);
    }

    /**************************************************************************/
    /* Overrides */
    /**************************************************************************/

    /**
     * @dev Helper function to transfer collateral
     * @param from From
     * @param to To
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    function _transferCollateral(
        address from,
        address to,
        address collateralToken,
        uint256 collateralTokenId
    ) internal override {
        IERC1155(collateralToken).safeTransferFrom(from, to, collateralTokenId, 1, "");
    }

    /**
     * @dev Helper function to approve collateral transfer
     */
    function liquidate(bytes calldata encodedLoanReceipt) external override nonReentrant {
        /* Handle liquidate accounting */
        (LoanReceipt.LoanReceiptV2 memory loanReceipt, bytes32 loanReceiptHash) = BorrowLogic._liquidate(
            _storage,
            encodedLoanReceipt
        );

        /* Revoke delegates */
        BorrowLogic._revokeDelegates(
            _getDelegateStorage(),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            _delegateRegistryV1,
            _delegateRegistryV2
        );

        /* Approve collateral for transfer to ERC1155 collateral wrapper */
        IERC1155(loanReceipt.collateralToken).setApprovalForAll(_erc1155CollateralWrapper, true);

        /* Assign token IDs and quantities */
        uint256[] memory collateralTokenIds = new uint256[](1);
        collateralTokenIds[0] = loanReceipt.collateralTokenId;
        uint256[] memory quantities = new uint256[](1);
        quantities[0] = 1;

        /* Mint ERC1155 collateral wrapper */
        (uint256 tokenId, bytes memory collateralWrapperContext) = ERC1155CollateralWrapper(_erc1155CollateralWrapper)
            .mint(loanReceipt.collateralToken, collateralTokenIds, quantities);

        /* Unset approval of collateral for transfer to ERC1155 collateral wrapper */
        IERC1155(loanReceipt.collateralToken).setApprovalForAll(_erc1155CollateralWrapper, false);

        /* Approve wrapped collateral for transfer to _collateralLiquidator */
        IERC721(_erc1155CollateralWrapper).approve(address(_collateralLiquidator), tokenId);

        /* Start liquidation with collateral liquidator */
        _collateralLiquidator.liquidate(
            address(_storage.currencyToken),
            _erc1155CollateralWrapper,
            tokenId,
            collateralWrapperContext,
            encodedLoanReceipt
        );

        /* Emit Loan Liquidated */
        emit LoanLiquidated(loanReceiptHash);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateERC1155CollectionPool";
    }

    /**************************************************************************/
    /* ERC1155Holder */
    /**************************************************************************/

    function onERC1155Received(address, address, uint256, uint256, bytes memory) public pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override(Pool) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
