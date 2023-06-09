// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

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
     * @param liquidationSalt Liquidation salt
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param highestBid Highest bid
     */
    struct Auction {
        address currencyToken;
        uint64 endTime;
        bytes32 liquidationSalt;
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
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    event AuctionStarted(address indexed collateralToken, uint256 indexed collateralTokenId);

    /**
     * @notice Emitted when an auction receives a bid
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param bidder Bidder
     * @param amount Bid amount
     */
    event AuctionBid(
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        address indexed bidder,
        uint256 amount
    );

    /**
     * @notice Emitted when an auction is ended and collateral is claimed by winner
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param winner Winner of auction
     * @param proceeds Proceeds in currency tokens
     */
    event AuctionEnded(
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        address indexed winner,
        uint256 proceeds
    );

    /**
     * @notice Emitted when liquidation is liquidated
     * @param liquidationHash Liquidation hash
     * @param proceeds Proceeds in currency tokens
     */
    event CollateralLiquidated(bytes32 indexed liquidationHash, uint256 proceeds);

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
     * @notice Collateral wrappers (max 5)
     */
    address internal immutable _collateralWrapper1;
    address internal immutable _collateralWrapper2;
    address internal immutable _collateralWrapper3;
    address internal immutable _collateralWrapper4;
    address internal immutable _collateralWrapper5;

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
     * @notice EnglishAuctionCollateralLiquidator constructor
     */
    constructor(address[] memory collateralWrappers_) {
        /* Validate number of collateral wrappers */
        if (collateralWrappers_.length > 5) revert InvalidParameters();

        /* Assign collateral wrappers */
        _collateralWrapper1 = (collateralWrappers_.length > 0) ? collateralWrappers_[0] : address(0);
        _collateralWrapper2 = (collateralWrappers_.length > 1) ? collateralWrappers_[1] : address(0);
        _collateralWrapper3 = (collateralWrappers_.length > 2) ? collateralWrappers_[2] : address(0);
        _collateralWrapper4 = (collateralWrappers_.length > 3) ? collateralWrappers_[3] : address(0);
        _collateralWrapper5 = (collateralWrappers_.length > 4) ? collateralWrappers_[4] : address(0);

        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @dev Fee-on-transfer currency tokens are not supported
     */
    function initialize(
        uint64 auctionDuration,
        uint64 timeExtensionWindow,
        uint64 timeExtension,
        uint64 minimumBidBasisPoints
    ) external {
        require(!_initialized, "Already initialized");
        if (auctionDuration <= timeExtensionWindow) revert InvalidParameters();
        if (auctionDuration == 0) revert InvalidParameters();

        _initialized = true;
        _auctionDuration = auctionDuration;
        _timeExtensionWindow = timeExtensionWindow;
        _timeExtension = timeExtension;
        _minimumBidBasisPoints = minimumBidBasisPoints;
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
     * @notice Helper function to check if collateral token is a collateral wrapper
     * @param collateralToken Collateral token
     */
    function _isCollateralWrapper(address collateralToken) internal view returns (bool) {
        return
            collateralToken == _collateralWrapper1 ||
            collateralToken == _collateralWrapper2 ||
            collateralToken == _collateralWrapper3 ||
            collateralToken == _collateralWrapper4 ||
            collateralToken == _collateralWrapper5;
    }

    /**
     * @notice Helper function to compute liquidation hash
     * @param liquidationSalt Liquidation salt
     * @param liquidationContext Liquidation callback context
     */
    function _liquidationHash(
        bytes32 liquidationSalt,
        bytes calldata liquidationContext
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, liquidationSalt, liquidationContext));
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
     * @param currencyToken Currency token
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationSalt Liquidation salt
     * @param liquidationHash Liquidation hash
     */
    function _createAuction(
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        bytes32 liquidationSalt,
        bytes32 liquidationHash
    ) internal {
        /* Compute collateral hash */
        bytes32 collateralHash = _collateralHash(collateralToken, collateralTokenId);

        /* Validate auction does not exists */
        if (_auctions[collateralHash].liquidationSalt != bytes32(0)) revert InvalidAuction();

        /* Create collateral auction */
        _auctions[collateralHash] = Auction({
            currencyToken: currencyToken,
            endTime: 0,
            liquidationSalt: liquidationSalt,
            collateralToken: collateralToken,
            collateralTokenId: collateralTokenId,
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
     * @param liquidationHash Liquidation hash
     * @param liquidationContext Liquidation context
     */
    function _processLiquidation(
        Auction memory auction_,
        bytes32 liquidationHash,
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

            /* If source is a contract that implements ICollateralLiquidationReceiver, make collateral liquidation callback */
            if (
                Address.isContract(liquidation_.source) &&
                ERC165Checker.supportsInterface(liquidation_.source, type(ICollateralLiquidationReceiver).interfaceId)
            )
                ICollateralLiquidationReceiver(liquidation_.source).onCollateralLiquidated(
                    liquidationContext,
                    liquidation_.proceeds
                );

            /* Delete liquidation since all auctions are completed */
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
        bytes calldata collateralWrapperContext,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Check collateralToken and currencyToken is not zero address */
        if (collateralToken == address(0) || currencyToken == address(0)) revert InvalidToken();

        /* Compute liquidation salt */
        bytes32 liquidationSalt = keccak256(
            abi.encodePacked(currencyToken, collateralToken, collateralTokenId, collateralWrapperContext)
        );

        /* Compute liquidation hash */
        bytes32 liquidationHash = _liquidationHash(liquidationSalt, liquidationContext);

        /* Validate liquidation does not exist */
        if (_liquidations[liquidationHash].source != address(0)) revert InvalidLiquidation();

        /* Declare underlying collateral token address and IDs */
        address underlyingCollateralToken;
        uint256[] memory underlyingCollateralTokenIds;

        /* Cache check for collateral wrapper  */
        bool isCollateralWrapper = _isCollateralWrapper(collateralToken);

        /* Determine if collateral token is a whitelisted collateral wrapper */
        if (isCollateralWrapper) {
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

        /* Iterate through underlying collaterals to create an auction for each underlying collateral */
        for (uint16 i = 0; i < underlyingCollateralTokenIds.length; i++) {
            _createAuction(
                currencyToken,
                underlyingCollateralToken,
                underlyingCollateralTokenIds[i],
                liquidationSalt,
                liquidationHash
            );
        }

        /* Create liquidation */
        _liquidations[liquidationHash] = Liquidation({
            source: msg.sender,
            auctionCount: uint16(underlyingCollateralTokenIds.length),
            proceeds: 0
        });

        /* Transfer collateral token from source to this contract */
        IERC721(collateralToken).transferFrom(msg.sender, address(this), collateralTokenId);

        /* Unwrap if collateral token is a collateral wrapper */
        if (isCollateralWrapper)
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

        /* Validate that auction exists */
        if (auction_.liquidationSalt == bytes32(0)) revert InvalidAuction();

        /* Validate auction has not ended */
        if (auction_.endTime != 0 && auction_.endTime < uint64(block.timestamp)) revert InvalidBid();

        /* Validate bid amount is bigger than the minimum bid amount */
        if (
            amount <= auction_.highestBid.amount ||
            amount - auction_.highestBid.amount <
            (auction_.highestBid.amount * _minimumBidBasisPoints) / BASIS_POINTS_SCALE
        ) revert InvalidBid();

        /* If auction has not started */
        if (auction_.endTime == 0) {
            /* Start auction */
            _auctions[collateralHash].endTime = uint64(block.timestamp) + _auctionDuration;

            /* Emit AuctionStarted */
            emit AuctionStarted(auction_.collateralToken, auction_.collateralTokenId);
        } else if ((auction_.endTime - uint64(block.timestamp)) <= _timeExtensionWindow) {
            /* Update end time if auction is already in progress and bid within _timeExtensionWindow */
            _auctions[collateralHash].endTime = uint64(block.timestamp) + _timeExtension;
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
        emit AuctionBid(collateralToken, collateralTokenId, msg.sender, amount);
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
        if (auction_.liquidationSalt == bytes32(0)) revert InvalidAuction();

        /* Compute liquidation hash */
        bytes32 liquidationHash = _liquidationHash(auction_.liquidationSalt, liquidationContext);

        /* Validate liquidation exists */
        if (_liquidations[liquidationHash].source == address(0)) revert InvalidClaim();

        /* Validate that auction was started */
        if (auction_.highestBid.bidder == address(0)) revert InvalidClaim();

        /* Validate that auction has ended */
        if (uint64(block.timestamp) <= auction_.endTime) revert InvalidClaim();

        /* Process liquidation proceeds */
        _processLiquidation(auction_, liquidationHash, liquidationContext);

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
            auction_.collateralToken,
            auction_.collateralTokenId,
            auction_.highestBid.bidder,
            auction_.highestBid.amount
        );
    }
}
