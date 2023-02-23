// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title Interface to a purchase escrow platform.
 * @author MetaStreet Labs
 */
interface IPurchaseEscrow {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid address (e.g. zero address)
     */
    error InvalidAddress();

    /**
     * @notice Invalid repayment (i.e. repayment < principal)
     */
    error InvalidRepayment();

    /**
     * @notice Invalid duration (i.e. duration is zero)
     */
    error InvalidDuration();

    /**
     * @notice Invalid token
     */
    error InvalidToken();

    /**
     * @notice Invalid escrow status
     */
    error InvalidStatus();

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid payment
     */
    error InvalidPayment();

    /**
     * @notice Escrow not expired
     */
    error EscrowNotExpired();

    /**
     * @notice Invalid order hash
     */
    error InvalidOrderHash();

    /**
     * @notice Cancel failed
     */
    error CancelFailed();

    /**
     * @notice Order not filled
     */
    error OrderNotFilled();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Purchase escrow status
     */
    enum PurchaseEscrowStatus {
        Uninitialized,
        Active,
        Repaid,
        Liquidated
    }

    /**
     * @notice Supported listing marketplaces
     */
    enum Marketplace {
        Seaport
    }

    /**
     * @notice Purchase escrow terms
     * @param status Status
     * @param token Token contract
     * @param buyer Buyer address
     * @param tokenId Token ID
     * @param principal Principal in currency tokens
     * @param repayment Repayment in currency tokens
     * @param consideration Consideration in currency tokens, if listed
     * @param startTime Start time in seconds since Unix epoch
     * @param duration Duration in seconds
     * @param orderHash Order hash, if listed
     */
    struct PurchaseEscrowTerms {
        PurchaseEscrowStatus status;
        IERC721 token;
        address buyer;
        uint256 tokenId;
        uint256 principal;
        uint256 repayment;
        uint256 consideration;
        uint64 startTime;
        uint64 duration;
        bytes32 orderHash;
    }

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a purchase escrow is created
     * @param escrowId Escrow ID
     * @param lender Lender address
     * @param buyer Buyer address
     * @param token Token address
     * @param tokenId Token ID
     * @param principal Principal in currency tokens
     * @param repayment Repayment in currency tokens
     * @param duration Duration in seconds
     */
    event PurchaseEscrowCreated(
        uint256 indexed escrowId,
        address lender,
        address buyer,
        address token,
        uint256 tokenId,
        uint256 principal,
        uint256 repayment,
        uint64 duration
    );

    /**
     * @notice Emitted when a purchase escrow is repaid
     * @param escrowId Escrow ID
     */
    event PurchaseEscrowRepaid(uint256 indexed escrowId);

    /**
     * @notice Emitted when a purchase escrow is liquidated
     * @param escrowId Escrow ID
     */
    event PurchaseEscrowLiquidated(uint256 indexed escrowId);

    /**
     * @notice Emitted when a purchase escrow is transferred
     * @param escrowId Escrow ID
     * @param from Previous buyer address
     * @param to New buyer address
     */
    event PurchaseEscrowTransferred(uint256 indexed escrowId, address from, address to);

    /**
     * @notice Emitted when a purchase escrow is listed on a marketplace
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     * @param listingPrice Listing price in currency tokens
     * @param consideration Buyer consideration in currency tokens
     * @param totalFees Total fees (marketplace fee + royalties) in currency tokens
     * @param listingData Listing data (marketplace specific)
     */
    event PurchaseEscrowListed(
        uint256 indexed escrowId,
        Marketplace marketplace,
        uint256 listingPrice,
        uint256 consideration,
        uint256 totalFees,
        bytes listingData
    );

    /**
     * @notice Emitted when a purchase escrow is delisted from a marketplace
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     */
    event PurchaseEscrowDelisted(uint256 indexed escrowId, Marketplace marketplace);

    /**
     * @notice Emitted when a purchase escrow is sold in a marketplace listing
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     */
    event PurchaseEscrowSold(uint256 indexed escrowId, Marketplace marketplace);

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get currency token
     * @return Currency token contract
     */
    function currencyToken() external view returns (IERC20);

    /**
     * @notice Get lender note
     * @return Lender note token contract
     */
    function lenderNoteToken() external view returns (IERC721);

    /**
     * @notice Get purchase escrow terms
     * @param escrowId Escrow ID
     * @return Purchase escrow info
     */
    function purchaseEscrows(uint256 escrowId) external view returns (PurchaseEscrowTerms memory);

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Create a purchase escrow for an NFT.
     *
     * Mints a lender note to the lender.
     *
     * @param buyer Buyer address
     * @param token Token contract
     * @param tokenId Token ID
     * @param principal Principal in currency tokens
     * @param repayment Repayment in currency tokens
     * @param duration Duration in seconds
     * @return Escrow ID
     */
    function create(
        address buyer,
        IERC721 token,
        uint256 tokenId,
        uint256 principal,
        uint256 repayment,
        uint64 duration
    ) external returns (uint256);

    /**
     * @notice Repay a purchase escrow and claim the underlying NFT.
     *
     * Caller must be the purchase escrow buyer. Lender note is burned on
     * successful repayment.
     *
     * @param escrowId Escrow ID
     */
    function repay(uint256 escrowId) external;

    /**
     * @notice Repay a purchase escrow with ETH and claim the underlying NFT.
     *
     * Caller must be the purchase escrow buyer. Lender note is burned on
     * successful repayment. Only supported if underlying currency token is
     * WETH.
     *
     * @param escrowId Escrow ID
     */
    function repayETH(uint256 escrowId) external payable;

    /**
     * @notice Liquidate an expired purchase escrow and claim the underlying NFT.
     *
     * Caller must own the lender note. Lender notes is burned on liquidation.
     *
     * @param escrowId Escrow ID
     */
    function liquidate(uint256 escrowId) external;

    /**
     * @notice Transfer purchase escrow buyer to target and call.
     *
     * Caller must be the purchase escrow buyer.
     *
     * @param escrowId Escrow ID
     * @param target Target buyer
     * @param data Calldata
     */
    function transferAndCall(
        uint256 escrowId,
        address target,
        bytes calldata data
    ) external payable;

    /**
     * @notice List purchase escrow collateral for sale on a marketplace.
     *
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     * @param listingPrice Listing price in currency tokens
     * @param feeBasisPoints Fee basis points
     * @param feeRecipient Fee recipient
     * @param royaltyBasisPoints Royalty basis points
     * @param royaltyRecipient Royalty recipient
     * @param startTimestamp Listing start timestamp
     * @param endTimestamp Listing end timestamp
     * @param salt Random salt
     */
    function createListing(
        uint256 escrowId,
        Marketplace marketplace,
        uint256 listingPrice,
        uint256 feeBasisPoints,
        address feeRecipient,
        uint256 royaltyBasisPoints,
        address royaltyRecipient,
        uint256 startTimestamp,
        uint256 endTimestamp,
        uint256 salt
    ) external;

    /**
     * @notice Cancel a purchase escrow collateral listing from a marketplace.
     *
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     * @param listingData Listing data (marketplace specific)
     */
    function cancelListing(
        uint256 escrowId,
        Marketplace marketplace,
        bytes memory listingData
    ) external;

    /**
     * @notice Check if a purchase escrow collateral listing is filled.
     *
     * @param escrowId Escrow ID
     * @return True if filled, false if not
     */
    function isListingFilled(uint256 escrowId) external returns (bool);

    /**
     * @notice Process a successful marketplace sale after listing.
     *
     * @param escrowId Escrow ID
     * @param marketplace Marketplace
     */
    function processSale(uint256 escrowId, Marketplace marketplace) external;
}
