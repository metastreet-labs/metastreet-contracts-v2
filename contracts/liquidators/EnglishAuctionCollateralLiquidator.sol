// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

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
     * @param currencyToken Currency token
     * @param endTime Auction end time
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param highestBid Highest bid
     */
    struct Auction {
        address currencyToken;
        uint64 endTime;
        bytes32 liquidationHash;
        address collateralToken;
        uint256 collateralTokenId;
        Bid highestBid;
    }

    /**
     * @notice Liquidation
     * @param source Address the liquidation came from
     * @param auctionCount Number of auctions that have not ended
     * @param proceeds Proceeds from liquidations
     */
    struct Liquidation {
        address source;
        uint16 auctionCount;
        uint256 proceeds;
    }

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when an auction is created
     * @param collateralHash Collateral hash
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    event AuctionCreated(
        bytes32 indexed collateralHash,
        bytes32 indexed liquidationHash,
        address collateralToken,
        uint256 collateralTokenId
    );

    /**
     * @notice Emitted when an auction is started
     * @param collateralHash Collateral hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    event AuctionStarted(bytes32 indexed collateralHash, address collateralToken, uint256 collateralTokenId);

    /**
     * @notice Emitted when an auction receives a bid
     * @param collateralHash Collateral hash
     * @param bidder Bidder
     * @param amount Bid amount
     */
    event AuctionBid(bytes32 indexed collateralHash, address indexed bidder, uint256 amount);

    /**
     * @notice Emitted when an auction is ended and collateral is claimed by winner
     * @param winner Winner of auction
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param proceeds Proceeds in currency tokens
     */
    event AuctionEnded(address indexed winner, address collateralToken, uint256 collateralTokenId, uint256 proceeds);

    /**
     * @notice Emitted when liquidation is liquidated
     * @param liquidationHash Liquidation hash
     * @param proceeds Proceeds in currency tokens
     */
    event CollateralLiquidated(bytes32 indexed liquidationHash, uint256 proceeds);

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
        uint64 auctionDuration,
        uint64 timeExtensionWindow,
        uint64 timeExtension,
        uint64 minimumBidBasisPoints,
        address[] calldata collateralWrappers
    ) external {
        require(!_initialized, "Already initialized");
        if (timeExtension <= timeExtensionWindow) revert InvalidParameters();
        if (auctionDuration <= timeExtensionWindow) revert InvalidParameters();
        if (auctionDuration == 0) revert InvalidParameters();

        _initialized = true;
        _admin = admin;
        _auctionDuration = auctionDuration;
        _timeExtensionWindow = timeExtensionWindow;
        _timeExtension = timeExtension;
        _minimumBidBasisPoints = minimumBidBasisPoints;

        for (uint256 i = 0; i < collateralWrappers.length; i++) {
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
     * @param collateralHash Collateral hash
     * @return Auction Auction details
     */
    function auction(bytes32 collateralHash) external view returns (Auction memory) {
        return _auctions[collateralHash];
    }

    /**************************************************************************/
    /* Helper Functions */
    /**************************************************************************/

    /**
     * @notice Helper function to compute liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param currencyToken Currency token
     * @param collateralContext Collateral context for collateral wrapper
     * @param liquidationContext Liquidation callback context
     */
    function _liquidationHash(
        address collateralToken,
        uint256 collateralTokenId,
        address currencyToken,
        bytes calldata collateralContext,
        bytes calldata liquidationContext
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    block.chainid,
                    collateralToken,
                    collateralTokenId,
                    collateralContext,
                    currencyToken,
                    liquidationContext
                )
            );
    }

    /**
     * @notice Helper function to create an auction
     *
     * Emits a {AuctionCreated} event.
     *
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    function _createAuction(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        address currencyToken
    ) internal {
        /* Compute collateral hash */
        bytes32 collateralHash = keccak256(abi.encodePacked(block.chainid, collateralToken, collateralTokenId));

        /* Validate auction does not exists */
        if (_auctions[collateralHash].liquidationHash != bytes32(0)) revert InvalidAuction();

        /* Create collateral auction */
        _auctions[collateralHash] = Auction({
            currencyToken: currencyToken,
            endTime: 0,
            liquidationHash: liquidationHash,
            collateralToken: collateralToken,
            collateralTokenId: collateralTokenId,
            highestBid: Bid(address(0), 0)
        });

        /* Emit AuctionCreated */
        emit AuctionCreated(collateralHash, liquidationHash, collateralToken, collateralTokenId);
    }

    /**
     * @notice Helper function to process a collateral liquidation
     *
     * Emits a {CollateralLiquidated} event.
     *
     * @param auction_ Auction
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationHash Liquidation hash
     * @param collateralContext Collateral context
     * @param liquidationContext Liquidation context
     */
    function _processLiquidation(
        Auction memory auction_,
        address collateralToken,
        uint256 collateralTokenId,
        bytes32 liquidationHash,
        bytes calldata collateralContext,
        bytes calldata liquidationContext
    ) internal {
        /* Update liquidation proceeds */
        _liquidations[liquidationHash].proceeds += auction_.highestBid.amount;

        /* Update liquidation active auctions */
        _liquidations[liquidationHash].auctionCount -= 1;

        /* Get liquidation */
        Liquidation memory liquidation_ = _liquidations[liquidationHash];

        /* Liquidate if all auctions for the liquidation are completed */
        if (liquidation_.auctionCount == 0) {
            /* Transfer proceeds from this contract to source */
            IERC20(auction_.currencyToken).safeTransfer(liquidation_.source, liquidation_.proceeds);

            /* If transfer is successful and source is a contract, try collateral liquidation callback */
            if (Address.isContract(liquidation_.source))
                try
                    ICollateralLiquidationReceiver(liquidation_.source).onCollateralLiquidated(
                        auction_.currencyToken,
                        collateralToken,
                        collateralTokenId,
                        collateralContext,
                        liquidationContext,
                        liquidation_.proceeds
                    )
                {} catch {}

            /* Delete liquidation if all auctions are completed */
            delete _liquidations[liquidationHash];

            /* Emit CollateralLiquidated */
            emit CollateralLiquidated(liquidationHash, liquidation_.proceeds);
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
        bytes calldata collateralContext,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Check collateralToken and currencyToken is not zero address */
        if (collateralToken == address(0) || currencyToken == address(0)) revert InvalidToken();

        /* Compute liquidation hash */
        bytes32 liquidationHash = _liquidationHash(
            collateralToken,
            collateralTokenId,
            currencyToken,
            collateralContext,
            liquidationContext
        );

        /* Validate liquidation does not exist */
        if (_liquidations[liquidationHash].source != address(0)) revert InvalidLiquidation();

        /* Declare underlying collateral token address and IDs */
        address underlyingCollateralToken;
        uint256[] memory underlyingCollateralTokenIds;

        /* Determine if collateral token is a collateral wrapper */
        if (_collateralWrappers[collateralToken]) {
            /* Get underlying collateral token and underlying collateral token IDs */
            (underlyingCollateralToken, underlyingCollateralTokenIds) = ICollateralWrapper(collateralToken).enumerate(
                collateralTokenId,
                collateralContext
            );
        } else {
            /* Assign collateral token address and ID */
            underlyingCollateralToken = collateralToken;
            underlyingCollateralTokenIds = new uint256[](1);
            underlyingCollateralTokenIds[0] = collateralTokenId;
        }

        /* Iterate through underlying collaterals to create an auction for each underlying collateral */
        for (uint16 i = 0; i < underlyingCollateralTokenIds.length; i++) {
            _createAuction(liquidationHash, underlyingCollateralToken, underlyingCollateralTokenIds[i], currencyToken);
        }

        /* Create liquidation */
        _liquidations[liquidationHash] = Liquidation({
            source: msg.sender,
            auctionCount: uint16(underlyingCollateralTokenIds.length),
            proceeds: 0
        });

        /* Transfer collateral token from source to this contract */
        IERC721(collateralToken).transferFrom(msg.sender, address(this), collateralTokenId);

        /* Unwrap bundle collateral if collateral token is a collateral wrapper */
        if (_collateralWrappers[collateralToken])
            ICollateralWrapper(collateralToken).unwrap(collateralTokenId, collateralContext);
    }

    /**
     * @notice Bid on an auction
     *
     * Emits a {AuctionBid} event.
     *
     * @param collateralHash Collateral hash
     * @param amount Bid amount
     */
    function bid(bytes32 collateralHash, uint256 amount) external nonReentrant {
        /* Get auction */
        Auction memory auction_ = _auctions[collateralHash];

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
            /* Start auction */
            _auctions[collateralHash].endTime = uint64(block.timestamp) + _auctionDuration;

            /* Emit AuctionStarted */
            emit AuctionStarted(collateralHash, auction_.collateralToken, auction_.collateralTokenId);
        } else {
            /* Update end time if auction is already in progress and bid within _timeExtensionWindow */
            _auctions[collateralHash].endTime = (auction_.endTime - uint64(block.timestamp)) <= _timeExtensionWindow
                ? uint64(block.timestamp) + _timeExtension
                : auction_.endTime;
        }

        /* Update auction with new bid */
        _auctions[collateralHash].highestBid = Bid({bidder: msg.sender, amount: amount});

        /* If not first bidder */
        if (auction_.highestBid.bidder != address(0)) {
            /* Transfer previous bid back from collateral liquidator to previous bidder */
            IERC20(auction_.currencyToken).transfer(auction_.highestBid.bidder, auction_.highestBid.amount);
        }

        /* Transfer bid amount from bidder to collateral liquidator */
        IERC20(auction_.currencyToken).safeTransferFrom(msg.sender, address(this), amount);

        /* Emit AuctionBid */
        emit AuctionBid(collateralHash, msg.sender, amount);
    }

    /**
     * @notice Claim collateral and liquidate if possible
     *
     * Emits a {CollateralLiquidated} event.
     * Emits a {AuctionEnded} event.
     *
     * @param collateralHash Collateral hash
     * @param collateralToken Collateral token from liquidate parameter earlier
     * @param collateralTokenId Collateral token ID from liquidate parameter earlier
     * @param collateralContext Collateral context
     * @param liquidationContext Liquidation context
     */
    function claim(
        bytes32 collateralHash,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralContext,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Get auction */
        Auction memory auction_ = _auctions[collateralHash];

        /* Compute liquidation hash */
        bytes32 liquidationHash = _liquidationHash(
            collateralToken,
            collateralTokenId,
            auction_.currencyToken,
            collateralContext,
            liquidationContext
        );

        /* Validate liquidation hash matches auction */
        if (auction_.liquidationHash != liquidationHash) revert InvalidClaim();

        /* Validate that auction has ended and the auction has a bid */
        if (uint64(block.timestamp) <= auction_.endTime || auction_.highestBid.bidder == address(0))
            revert InvalidClaim();

        /* Process liquidation proceeds */
        _processLiquidation(
            auction_,
            collateralToken,
            collateralTokenId,
            liquidationHash,
            collateralContext,
            liquidationContext
        );

        /* Delete auction */
        delete _auctions[collateralHash];

        /* Transfer collateral from contract to auction winner */
        IERC721(auction_.collateralToken).transferFrom(
            address(this),
            auction_.highestBid.bidder,
            auction_.collateralTokenId
        );

        /* Emit AuctionEnded */
        emit AuctionEnded(
            auction_.highestBid.bidder,
            auction_.collateralToken,
            auction_.collateralTokenId,
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