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
 * @title Pool Configuration with a Weighted Interest Rate Model, Collection
 * Collateral Filter, and native ERC1155 support
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
     * @notice ERC1155 Collateral Wrapper address
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
     * @param collateralWrappers Collateral wrappers (must be one, ERC1155 Collateral Wrapper)
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV1,
        address delegateRegistryV2,
        address erc20DepositTokenImplementation,
        address[] memory collateralWrappers
    )
        Pool(collateralLiquidator, delegateRegistryV1, delegateRegistryV2, collateralWrappers)
        WeightedInterestRateModel()
        ERC20DepositToken(erc20DepositTokenImplementation)
        ExternalPriceOracle()
    {
        /* Validate collateral wrappers */
        if (collateralWrappers.length != 1) revert InvalidParameters();
        if (
            keccak256(abi.encodePacked(ICollateralWrapper(collateralWrappers[0]).name())) !=
            keccak256("MetaStreet ERC1155 Collateral Wrapper")
        ) revert InvalidParameters();

        /* Disable initialization of implementation contract */
        _storage.currencyToken = IERC20(address(1));

        /* Set ERC1155 collateral wrapper for liquidation */
        _erc1155CollateralWrapper = collateralWrappers[0];
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
     * @inheritdoc Pool
     */
    function _transferCollateral(
        address from,
        address to,
        address collateralToken,
        uint256 collateralTokenId
    ) internal override {
        /* Use ERC721 transfer for ERC1155 collateral wrapper */
        if (collateralToken == _erc1155CollateralWrapper) {
            super._transferCollateral(from, to, collateralToken, collateralTokenId);
        } else {
            IERC1155(collateralToken).safeTransferFrom(from, to, collateralTokenId, 1, "");
        }
    }

    /**
     * @inheritdoc Pool
     */
    function _liquidateCollateral(
        address collateralToken,
        uint256 collateralTokenId,
        bytes memory collateralWrapperContext,
        bytes calldata encodedLoanReceipt
    ) internal override {
        /* Use ERC721 collateral liquidation if already ERC1155 collateral wrapper */
        if (collateralToken == _erc1155CollateralWrapper) {
            super._liquidateCollateral(
                collateralToken,
                collateralTokenId,
                collateralWrapperContext,
                encodedLoanReceipt
            );

            return;
        }

        /* Assign token IDs and quantities */
        uint256[] memory collateralTokenIds = new uint256[](1);
        collateralTokenIds[0] = collateralTokenId;
        uint256[] memory quantities = new uint256[](1);
        quantities[0] = 1;

        /* Approve collateral for transfer to ERC1155 collateral wrapper */
        IERC1155(collateralToken).setApprovalForAll(_erc1155CollateralWrapper, true);

        /* Mint ERC1155 collateral wrapper */
        uint256 tokenId = ERC1155CollateralWrapper(_erc1155CollateralWrapper).mint(
            collateralToken,
            collateralTokenIds,
            quantities
        );

        /* Unset approval of collateral for transfer to ERC1155 collateral wrapper */
        IERC1155(collateralToken).setApprovalForAll(_erc1155CollateralWrapper, false);

        /* Synthesize collateral wrapper context */
        collateralWrapperContext = abi.encode(
            collateralToken,
            ERC1155CollateralWrapper(_erc1155CollateralWrapper).nonce() - 1,
            uint256(1),
            collateralTokenIds,
            quantities
        );

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
        /* Batch transfers not supported */
        return 0;
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
