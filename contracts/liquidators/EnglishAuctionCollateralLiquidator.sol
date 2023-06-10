// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/ICollateralLiquidationReceiver.sol";
import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/ICollateralWrapper.sol";

/**
 * @title English Auction Collateral Liquidator
 * @author MetaStreet Labs
 */
contract EnglishAuctionCollateralLiquidator is ICollateralLiquidator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid parameters
     */
    error InvalidParameters();

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid token
     */
    error InvalidToken();

    /**
     * @notice Invalid auction
     */
    error InvalidAuction();

    /**
     * @notice Invalid liquidation
     */
    error InvalidLiquidation();

    /**
     * @notice Invalid bid
     */
    error InvalidBid();

    /**
     * @notice Invalid collateral claim
     */
    error InvalidClaim();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Bid
     * @param bidder Bidder offering the amount
     * @param amount Amount of tokens offered
     */
    struct Bid {
        address bidder;
        uint256 amount;
    }

    /**
     * @notice Auction
     * @param liquidationHash Liquidation hash
     * @param endTime Auction end time
     * @param highestBid Highest bid
     */
    struct Auction {
        bytes32 liquidationHash;
        uint64 endTime;
        Bid highestBid;
    }

    /**
     * @notice Liquidation
     * @param source Address the liquidation came from
     * @param auctionCount Number of auctions that have not ended
     * @param currencyToken Currency token
     * @param liquidationContextHash Liquidation context hash
     * @param proceeds Proceeds from liquidations
     */
    struct Liquidation {
        address source;
        uint16 auctionCount;
        address currencyToken;
        bytes32 liquidationContextHash;
        uint256 proceeds;
    }

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a liquidation is started
     * @param liquidationHash Liquidation hash
     * @param liquidationContextHash Liquidation context hash
     * @param auctionCount Auction count
     * @param source Liquidation source
     * @param currencyToken Currency token
     */
    event LiquidationStarted(
        bytes32 indexed liquidationHash,
        bytes32 indexed liquidationContextHash,
        uint256 auctionCount,
        address source,
        address currencyToken
    );

    /**
     * @notice Emitted when an auction is created
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    event AuctionCreated(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId
    );

    /**
     * @notice Emitted when an auction is started
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param endTime Auction end time
     */
    event AuctionStarted(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        uint64 endTime
    );

    /**
     * @notice Emitted when an auction is extended
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param endTime Auction end time
     */
    event AuctionExtended(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        uint64 endTime
    );

    /**
     * @notice Emitted when an auction receives a bid
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param bidder Bidder
     * @param amount Bid amount
     */
    event AuctionBid(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        address bidder,
        uint256 amount
    );

    /**
     * @notice Emitted when an auction is ended and collateral is claimed by winner
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param winner Winner of auction
     * @param proceeds Proceeds in currency tokens
     */
    event AuctionEnded(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        address winner,
        uint256 proceeds
    );

    /**
     * @notice Emitted when a liquidation is ended
     * @param liquidationHash Liquidation hash
     * @param proceeds Proceeds in currency tokens
     */
    event LiquidationEnded(bytes32 indexed liquidationHash, uint256 proceeds);

    /**
     * @notice Emitted when collateral wrappers are updated
     * @param collateralWrapper Collateral wrapper
     * @param enabled True if enabled, false if disabled
     */
    event CollateralWrapperUpdated(address indexed collateralWrapper, bool enabled);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Auction duration
     */
    uint64 private _auctionDuration;

    /**
     * @notice Duration window before an auction's end time
     */
    uint64 private _timeExtensionWindow;

    /**
     * @notice Time extension of auction when a new bid is made within _timeExtensionWindow
     */
    uint64 private _timeExtension;

    /**
     * @notice Minimum bid increment from previous bid
     */
    uint64 private _minimumBidBasisPoints;

    /**
     * @notice Admin
     */
    address private _admin;

    /**
     * @notice Collateral wrappers
     */
    mapping(address => bool) private _collateralWrappers;

    /**
     * @dev Collateral auctions
     */
    mapping(bytes32 => Auction) private _auctions;

    /**
     * @dev Liquidation tracker
     */
    mapping(bytes32 => Liquidation) private _liquidations;

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get auction duration
     * @return Auction duration
     */
    function auctionDuration() external view returns (uint64) {
        return _auctionDuration;
    }

    /**
     * @notice Get time extension window
     * @return Time extension window
     */
    function timeExtensionWindow() external view returns (uint64) {
        return _timeExtensionWindow;
    }

    /**
     * @notice Get time extension
     * @return Time extension
     */
    function timeExtension() external view returns (uint64) {
        return _timeExtension;
    }

    /**
     * @notice Get minimum bid basis points
     * @return Minimum bid basis points
     */
    function minimumBidBasisPoints() external view returns (uint64) {
        return _minimumBidBasisPoints;
    }

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
    function initialize(
        address admin,
        uint64 auctionDuration_,
        uint64 timeExtensionWindow_,
        uint64 timeExtension_,
        uint64 minimumBidBasisPoints_,
        address[] calldata collateralWrappers
    ) external {
        require(!_initialized, "Already initialized");
        if (timeExtension_ <= timeExtensionWindow_) revert InvalidParameters();
        if (auctionDuration_ <= timeExtensionWindow_) revert InvalidParameters();
        if (auctionDuration_ == 0) revert InvalidParameters();

        _initialized = true;
        _admin = admin;
        _auctionDuration = auctionDuration_;
        _timeExtensionWindow = timeExtensionWindow_;
        _timeExtension = timeExtension_;
        _minimumBidBasisPoints = minimumBidBasisPoints_;

        for (uint256 i; i < collateralWrappers.length; i++) {
            _collateralWrappers[collateralWrappers[i]] = true;
        }
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * Get liquidation details
     * @param liquidationHash Liquidation hash
     * @return Liquidation Liquidation details
     */
    function liquidation(bytes32 liquidationHash) external view returns (Liquidation memory) {
        return _liquidations[liquidationHash];
    }

    /**
     * Get auction details
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @return Auction Auction details
     */
    function auction(address collateralToken, uint256 collateralTokenId) external view returns (Auction memory) {
        /* Compute collateral hash */
        bytes32 collateralHash = _collateralHash(collateralToken, collateralTokenId);

        return _auctions[collateralHash];
    }

    /**************************************************************************/
    /* Helper Functions */
    /**************************************************************************/

    /**
     * @notice Helper function to compute liquidation context hash
     * @param liquidationContext Liquidation context
     */
    function _liquidationContextHash(bytes calldata liquidationContext) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, liquidationContext));
    }

    /**
     * @notice Helper function to compute liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param collateralWrapperContext Collateral wrapper context
     */
    function _liquidationHash(
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralWrapperContext
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, collateralToken, collateralTokenId, collateralWrapperContext));
    }

    /**
     * @notice Helper function to compute collateral hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    function _collateralHash(address collateralToken, uint256 collateralTokenId) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, collateralToken, collateralTokenId));
    }

    /**
     * @notice Helper function to create an auction
     *
     * Emits a {AuctionCreated} event.
     *
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationHash Liquidation hash
     */
    function _createAuction(address collateralToken, uint256 collateralTokenId, bytes32 liquidationHash) internal {
        /* Compute collateral hash */
        bytes32 collateralHash = _collateralHash(collateralToken, collateralTokenId);

        /* Validate auction does not exists */
        if (_auctions[collateralHash].liquidationHash != bytes32(0)) revert InvalidAuction();

        /* Create collateral auction */
        _auctions[collateralHash] = Auction({
            liquidationHash: liquidationHash,
            endTime: 0,
            highestBid: Bid(address(0), 0)
        });

        /* Emit AuctionCreated */
        emit AuctionCreated(liquidationHash, collateralToken, collateralTokenId);
    }

    /**
     * @notice Helper function to process a collateral liquidation
     *
     * Emits a {CollateralLiquidated} event.
     *
     * @param auction_ Auction
     * @param liquidationContext Liquidation context
     */
    function _processLiquidation(Auction memory auction_, bytes calldata liquidationContext) internal {
        /* Get liquidation */
        Liquidation memory liquidation_ = _liquidations[auction_.liquidationHash];

        /* Validate liquidation exists */
        if (liquidation_.source == address(0)) revert InvalidClaim();

        /* Validate liquidation context */
        if (liquidation_.liquidationContextHash != _liquidationContextHash(liquidationContext)) revert InvalidClaim();

        /* Liquidate if all auctions for the liquidation are completed */
        if (liquidation_.auctionCount - 1 == 0) {
            /* Compute total proceeds */
            uint256 proceeds = liquidation_.proceeds + auction_.highestBid.amount;

            /* Transfer proceeds from this contract to source */
            IERC20(liquidation_.currencyToken).safeTransfer(liquidation_.source, proceeds);

            /* If source is a contract, try collateral liquidation callback */
            if (Address.isContract(liquidation_.source))
                try
                    ICollateralLiquidationReceiver(liquidation_.source).onCollateralLiquidated(
                        liquidationContext,
                        proceeds
                    )
                {} catch {}

            /* Delete liquidation since all auctions are completed */
            delete _liquidations[auction_.liquidationHash];

            /* Emit LiquidationEnded */
            emit LiquidationEnded(auction_.liquidationHash, proceeds);
        } else {
            /* Update liquidation proceeds */
            _liquidations[auction_.liquidationHash].proceeds += auction_.highestBid.amount;

            /* Update liquidation active auctions */
            _liquidations[auction_.liquidationHash].auctionCount -= 1;
        }
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralLiquidator
     */
    function name() external pure returns (string memory) {
        return "EnglishAuctionCollateralLiquidator";
    }

    /**
     * @inheritdoc ICollateralLiquidator
     */
    function liquidate(
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralWrapperContext,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Check collateral token and currency token is not zero address */
        if (collateralToken == address(0) || currencyToken == address(0)) revert InvalidToken();

        /* Compute liquidation hash */
        bytes32 liquidationHash = _liquidationHash(collateralToken, collateralTokenId, collateralWrapperContext);

        /* Validate liquidation does not exist */
        if (_liquidations[liquidationHash].source != address(0)) revert InvalidLiquidation();

        /* Declare underlying collateral token address and IDs */
        address underlyingCollateralToken;
        uint256[] memory underlyingCollateralTokenIds;

        /* Determine if collateral token is a whitelisted collateral wrapper */
        if (_collateralWrappers[collateralToken]) {
            /* Get underlying collateral token and underlying collateral token IDs */
            (underlyingCollateralToken, underlyingCollateralTokenIds) = ICollateralWrapper(collateralToken).enumerate(
                collateralTokenId,
                collateralWrapperContext
            );
        } else {
            /* Assign collateral token address and ID */
            underlyingCollateralToken = collateralToken;
            underlyingCollateralTokenIds = new uint256[](1);
            underlyingCollateralTokenIds[0] = collateralTokenId;
        }

        /* Emit LiquidationStarted */
        emit LiquidationStarted(
            liquidationHash,
            _liquidationContextHash(liquidationContext),
            underlyingCollateralTokenIds.length,
            msg.sender,
            currencyToken
        );

        /* Iterate through underlying collaterals to create an auction for each underlying collateral */
        for (uint16 i = 0; i < underlyingCollateralTokenIds.length; i++) {
            _createAuction(underlyingCollateralToken, underlyingCollateralTokenIds[i], liquidationHash);
        }

        /* Create liquidation */
        _liquidations[liquidationHash] = Liquidation({
            source: msg.sender,
            auctionCount: uint16(underlyingCollateralTokenIds.length),
            currencyToken: currencyToken,
            liquidationContextHash: _liquidationContextHash(liquidationContext),
            proceeds: 0
        });

        /* Transfer collateral token from source to this contract */
        IERC721(collateralToken).transferFrom(msg.sender, address(this), collateralTokenId);

        /* Unwrap bundle collateral if collateral token is a collateral wrapper */
        if (_collateralWrappers[collateralToken])
            ICollateralWrapper(collateralToken).unwrap(collateralTokenId, collateralWrapperContext);
    }

    /**
     * @notice Bid on an auction
     *
     * Emits a {AuctionBid} event.
     *
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param amount Bid amount
     */
    function bid(address collateralToken, uint256 collateralTokenId, uint256 amount) external nonReentrant {
        /* Compute collateral hash */
        bytes32 collateralHash = _collateralHash(collateralToken, collateralTokenId);

        /* Get auction */
        Auction memory auction_ = _auctions[collateralHash];

        /* Get liquidation */
        Liquidation memory liquidation_ = _liquidations[auction_.liquidationHash];

        /* Validate liquidation exists */
        if (liquidation_.source == address(0)) revert InvalidAuction();

        /* Validate that auction exists */
        if (auction_.liquidationHash == bytes32(0)) revert InvalidAuction();

        /* Validate auction has not ended */
        if (auction_.endTime != 0 && auction_.endTime < uint64(block.timestamp)) revert InvalidBid();

        /* Validate bid amount is bigger than the minimum bid amount */
        if (
            amount <= auction_.highestBid.amount ||
            amount - auction_.highestBid.amount <
            Math.mulDiv(auction_.highestBid.amount, _minimumBidBasisPoints, BASIS_POINTS_SCALE)
        ) revert InvalidBid();

        /* If auction has not started */
        if (auction_.endTime == 0) {
            /* Calculate end time */
            uint64 endTime = uint64(block.timestamp) + _auctionDuration;

            /* Start auction */
            _auctions[collateralHash].endTime = endTime;

            /* Emit AuctionStarted */
            emit AuctionStarted(auction_.liquidationHash, collateralToken, collateralTokenId, endTime);
        } else if (auction_.endTime - uint64(block.timestamp) <= _timeExtensionWindow) {
            /* Calculate new end time */
            uint64 endTime = uint64(block.timestamp) + _timeExtension;

            /* Update end time if auction is already in progress and within
             * time extension window */
            _auctions[collateralHash].endTime = endTime;

            /* Emit AuctionExtended */
            emit AuctionExtended(auction_.liquidationHash, collateralToken, collateralTokenId, endTime);
        }

        /* Update auction with new bid */
        _auctions[collateralHash].highestBid = Bid({bidder: msg.sender, amount: amount});

        /* If not first bidder */
        if (auction_.highestBid.bidder != address(0)) {
            /* Transfer previous bid back from collateral liquidator to previous bidder */
            IERC20(liquidation_.currencyToken).transfer(auction_.highestBid.bidder, auction_.highestBid.amount);
        }

        /* Transfer bid amount from bidder to collateral liquidator */
        IERC20(liquidation_.currencyToken).safeTransferFrom(msg.sender, address(this), amount);

        /* Emit AuctionBid */
        emit AuctionBid(auction_.liquidationHash, collateralToken, collateralTokenId, msg.sender, amount);
    }

    /**
     * @notice Claim collateral and liquidate if possible
     *
     * Emits a {CollateralLiquidated} event.
     * Emits a {AuctionEnded} event.
     *
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationContext Liquidation context
     */
    function claim(
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Compute collateral hash */
        bytes32 collateralHash = _collateralHash(collateralToken, collateralTokenId);

        /* Get auction */
        Auction memory auction_ = _auctions[collateralHash];

        /* Validate that auction exists */
        if (auction_.liquidationHash == bytes32(0)) revert InvalidAuction();

        /* Validate that auction has ended */
        if (uint64(block.timestamp) <= auction_.endTime) revert InvalidClaim();

        /* Process liquidation proceeds */
        _processLiquidation(auction_, liquidationContext);

        /* Delete auction */
        delete _auctions[collateralHash];

        /* Transfer collateral from contract to auction winner */
        IERC721(collateralToken).transferFrom(address(this), auction_.highestBid.bidder, collateralTokenId);

        /* Emit AuctionEnded */
        emit AuctionEnded(
            auction_.liquidationHash,
            collateralToken,
            collateralTokenId,
            auction_.highestBid.bidder,
            auction_.highestBid.amount
        );
    }

    /**
     * @notice Update collateral wrapper
     *
     * Emits a {CollateralWrapperUpdated} event.
     *
     * @param collateralWrapper Collateral wrapper
     * @param enabled True if enabled, false if disabled
     */
    function setCollateralWrapper(address collateralWrapper, bool enabled) external {
        if (msg.sender != _admin) revert InvalidCaller();

        /* Update collateral wrappers */
        _collateralWrappers[collateralWrapper] = enabled;

        /* Emit CollateralWrapperUpdated */
        emit CollateralWrapperUpdated(collateralWrapper, enabled);
    }
}
