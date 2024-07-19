// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import "../interfaces/ICollateralLiquidationReceiver.sol";
import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/ICollateralWrapper.sol";

/**
 * @title English Auction Collateral Liquidator
 * @author MetaStreet Labs
 */
contract EnglishAuctionCollateralLiquidator is ICollateralLiquidator, ReentrancyGuard, ERC1155Holder {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "2.1";

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**
     * @notice Claim delay as non-winner
     */
    uint256 internal constant CLAIM_DELAY = 1 days;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid parameters
     */
    error InvalidParameters();

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
     * @notice Auction
     * @param quantity Quantity of token ID
     * @param endTime Auction end time
     * @param highestBidder Highest bidder
     * @param highestBid Highest bid
     */
    struct Auction {
        uint256 quantity;
        uint64 endTime;
        address highestBidder;
        uint256 highestBid;
    }

    /**
     * @notice Liquidation
     * @param source Address the liquidation came from
     * @param currencyToken Currency token
     * @param collateralToken Collateral token
     * @param auctionCount Number of auctions that have not ended
     * @param liquidationContextHash Liquidation context hash
     * @param proceeds Proceeds from liquidations
     */
    struct Liquidation {
        address source;
        address currencyToken;
        address collateralToken;
        uint16 auctionCount;
        bytes32 liquidationContextHash;
        uint256 proceeds;
    }

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a liquidation is started
     * @param liquidationHash Liquidation hash
     * @param source Liquidation source
     * @param liquidationContextHash Liquidation context hash
     * @param currencyToken Currency token
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param auctionCount Auction count
     */
    event LiquidationStarted(
        bytes32 indexed liquidationHash,
        address indexed source,
        bytes32 indexed liquidationContextHash,
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        uint16 auctionCount
    );

    /**
     * @notice Emitted when an auction is created
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param quantity Quantity of collateral token
     */
    event AuctionCreated(
        bytes32 indexed liquidationHash,
        address indexed collateralToken,
        uint256 indexed collateralTokenId,
        uint256 quantity
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
    mapping(bytes32 => mapping(address => mapping(uint256 => Auction))) private _auctions;

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
        uint64 auctionDuration_,
        uint64 timeExtensionWindow_,
        uint64 timeExtension_,
        uint64 minimumBidBasisPoints_
    ) external {
        require(!_initialized, "Already initialized");
        if (auctionDuration_ <= timeExtensionWindow_) revert InvalidParameters();
        if (timeExtension_ <= timeExtensionWindow_) revert InvalidParameters();
        if (auctionDuration_ == 0) revert InvalidParameters();

        _initialized = true;
        _auctionDuration = auctionDuration_;
        _timeExtensionWindow = timeExtensionWindow_;
        _timeExtension = timeExtension_;
        _minimumBidBasisPoints = minimumBidBasisPoints_;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get collateral wrappers
     * @return Collateral wrappers
     */
    function collateralWrappers() external view returns (address[] memory) {
        address[] memory collateralWrappers_ = new address[](5);
        collateralWrappers_[0] = _collateralWrapper1;
        collateralWrappers_[1] = _collateralWrapper2;
        collateralWrappers_[2] = _collateralWrapper3;
        collateralWrappers_[3] = _collateralWrapper4;
        collateralWrappers_[4] = _collateralWrapper5;
        return collateralWrappers_;
    }

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

    /**
     * Get liquidation details
     * @param liquidationHash Liquidation hash
     * @return Liquidation Liquidation details
     */
    function liquidations(bytes32 liquidationHash) external view returns (Liquidation memory) {
        return _liquidations[liquidationHash];
    }

    /**
     * Get auction details
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @return Auction Auction details
     */
    function auctions(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId
    ) external view returns (Auction memory) {
        return _auctions[liquidationHash][collateralToken][collateralTokenId];
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
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    function _liquidationHash(address collateralToken, uint256 collateralTokenId) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, collateralToken, collateralTokenId, block.timestamp));
    }

    /**
     * @notice Helper function to compute liquidation context hash
     * @param liquidationContext Liquidation context
     */
    function _liquidationContextHash(bytes calldata liquidationContext) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, liquidationContext));
    }

    /**
     * @notice Helper function to create an auction
     *
     * Emits a {AuctionCreated} event.
     *
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param quantity Quantity
     */
    function _createAuction(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 quantity
    ) internal {
        /* Create collateral auction */
        _auctions[liquidationHash][collateralToken][collateralTokenId] = Auction({
            quantity: quantity,
            endTime: 0,
            highestBidder: address(0),
            highestBid: 0
        });

        /* Emit AuctionCreated */
        emit AuctionCreated(liquidationHash, collateralToken, collateralTokenId, quantity);
    }

    /**
     * @notice Helper function to process a collateral liquidation
     *
     * Emits a {CollateralLiquidated} event.
     *
     * @param auction_ Auction
     * @param liquidationHash Liquidation hash
     * @param liquidationContext Liquidation context
     * @return Collateral token
     */
    function _processLiquidation(
        Auction memory auction_,
        bytes32 liquidationHash,
        bytes calldata liquidationContext
    ) internal returns (address) {
        /* Get liquidation */
        Liquidation memory liquidation_ = _liquidations[liquidationHash];

        /* Validate liquidation exists */
        if (liquidation_.source == address(0)) revert InvalidClaim();

        /* Validate liquidation context */
        if (liquidation_.liquidationContextHash != _liquidationContextHash(liquidationContext)) revert InvalidClaim();

        /* Liquidate if all auctions for the liquidation are completed */
        if (liquidation_.auctionCount == 1) {
            /* Validate claim delay if claimed by non-winner */
            if (auction_.highestBidder != msg.sender && auction_.endTime + CLAIM_DELAY >= block.timestamp)
                revert InvalidClaim();

            /* Compute total proceeds */
            uint256 proceeds = liquidation_.proceeds + auction_.highestBid;

            /* Delete liquidation since all auctions are completed */
            delete _liquidations[liquidationHash];

            /* Transfer proceeds from this contract to source */
            IERC20(liquidation_.currencyToken).safeTransfer(liquidation_.source, proceeds);

            /* If source is a contract that implements ICollateralLiquidationReceiver, make collateral liquidation callback */
            if (
                Address.isContract(liquidation_.source) &&
                ERC165Checker.supportsInterface(liquidation_.source, type(ICollateralLiquidationReceiver).interfaceId)
            ) ICollateralLiquidationReceiver(liquidation_.source).onCollateralLiquidated(liquidationContext, proceeds);

            /* Emit LiquidationEnded */
            emit LiquidationEnded(liquidationHash, proceeds);
        } else {
            /* Update liquidation proceeds */
            _liquidations[liquidationHash].proceeds += auction_.highestBid;

            /* Update liquidation active auctions */
            _liquidations[liquidationHash].auctionCount -= 1;
        }

        return liquidation_.collateralToken;
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
        bytes32 liquidationHash = _liquidationHash(collateralToken, collateralTokenId);

        /* Validate liquidation does not exist */
        if (_liquidations[liquidationHash].source != address(0)) revert InvalidLiquidation();

        /* Declare underlying collateral token address and IDs */
        address underlyingCollateralToken;
        uint256[] memory underlyingCollateralTokenIds;
        uint256[] memory underlyingQuantities;

        /* Cache check for collateral wrapper  */
        bool isCollateralWrapper = _isCollateralWrapper(collateralToken);

        /* Determine if collateral token is a whitelisted collateral wrapper */
        if (isCollateralWrapper) {
            /* Get underlying collateral token, underlying collateral token IDs, and quantities of each token ID */
            (underlyingCollateralToken, underlyingCollateralTokenIds, underlyingQuantities) = ICollateralWrapper(
                collateralToken
            ).enumerateWithQuantities(collateralTokenId, collateralWrapperContext);
        } else {
            /* Assign collateral token address and ID */
            underlyingCollateralToken = collateralToken;
            underlyingCollateralTokenIds = new uint256[](1);
            underlyingCollateralTokenIds[0] = collateralTokenId;
            underlyingQuantities = new uint256[](1);
            underlyingQuantities[0] = 1;
        }

        /* Compute liquidation context hash */
        bytes32 liquidationContextHash = _liquidationContextHash(liquidationContext);

        /* Emit LiquidationStarted */
        emit LiquidationStarted(
            liquidationHash,
            msg.sender,
            liquidationContextHash,
            currencyToken,
            collateralToken,
            collateralTokenId,
            uint16(underlyingCollateralTokenIds.length)
        );

        /* Iterate through underlying collaterals to create an auction for each underlying collateral */
        for (uint16 i = 0; i < underlyingCollateralTokenIds.length; i++) {
            _createAuction(
                liquidationHash,
                underlyingCollateralToken,
                underlyingCollateralTokenIds[i],
                underlyingQuantities[i]
            );
        }

        /* Create liquidation */
        _liquidations[liquidationHash] = Liquidation({
            source: msg.sender,
            currencyToken: currencyToken,
            collateralToken: collateralToken,
            auctionCount: uint16(underlyingCollateralTokenIds.length),
            liquidationContextHash: liquidationContextHash,
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
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param amount Bid amount
     */
    function bid(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 amount
    ) external nonReentrant {
        /* Get auction */
        Auction memory auction_ = _auctions[liquidationHash][collateralToken][collateralTokenId];

        /* Get liquidation */
        Liquidation memory liquidation_ = _liquidations[liquidationHash];

        /* Validate liquidation exists */
        if (liquidation_.source == address(0)) revert InvalidAuction();

        /* Validate that auction exists */
        if (auction_.quantity == 0) revert InvalidAuction();

        /* Validate auction has not ended */
        if (auction_.endTime != 0 && auction_.endTime < uint64(block.timestamp)) revert InvalidBid();

        /* Validate bid amount is bigger than the minimum bid amount */
        if (
            amount <= auction_.highestBid ||
            amount - auction_.highestBid < (auction_.highestBid * _minimumBidBasisPoints) / BASIS_POINTS_SCALE
        ) revert InvalidBid();

        /* If auction has not started */
        if (auction_.endTime == 0) {
            /* Calculate end time */
            uint64 endTime = uint64(block.timestamp) + _auctionDuration;

            /* Start auction */
            _auctions[liquidationHash][collateralToken][collateralTokenId].endTime = endTime;

            /* Emit AuctionStarted */
            emit AuctionStarted(liquidationHash, collateralToken, collateralTokenId, endTime);
        } else if (auction_.endTime - uint64(block.timestamp) <= _timeExtensionWindow) {
            /* Calculate new end time */
            uint64 endTime = uint64(block.timestamp) + _timeExtension;

            /* Update end time if auction is already in progress and within
             * time extension window */
            _auctions[liquidationHash][collateralToken][collateralTokenId].endTime = endTime;

            /* Emit AuctionExtended */
            emit AuctionExtended(liquidationHash, collateralToken, collateralTokenId, endTime);
        }

        /* Update auction with new bid */
        _auctions[liquidationHash][collateralToken][collateralTokenId].highestBidder = msg.sender;
        _auctions[liquidationHash][collateralToken][collateralTokenId].highestBid = amount;

        /* If not first bidder */
        if (auction_.highestBidder != address(0)) {
            /* Transfer previous bid back from collateral liquidator to previous bidder */
            IERC20(liquidation_.currencyToken).safeTransfer(auction_.highestBidder, auction_.highestBid);
        }

        /* Transfer bid amount from bidder to collateral liquidator */
        IERC20(liquidation_.currencyToken).safeTransferFrom(msg.sender, address(this), amount);

        /* Emit AuctionBid */
        emit AuctionBid(liquidationHash, collateralToken, collateralTokenId, msg.sender, amount);
    }

    /**
     * @notice Claim collateral and liquidate if possible
     *
     * Emits a {CollateralLiquidated} event.
     * Emits a {AuctionEnded} event.
     *
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationContext Liquidation context
     */
    function claim(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata liquidationContext
    ) external nonReentrant {
        /* Get auction */
        Auction memory auction_ = _auctions[liquidationHash][collateralToken][collateralTokenId];

        /* Validate that auction exists */
        if (auction_.quantity == 0) revert InvalidAuction();

        /* Validate that auction was started */
        if (auction_.highestBidder == address(0)) revert InvalidClaim();

        /* Validate that auction has ended */
        if (uint64(block.timestamp) <= auction_.endTime) revert InvalidClaim();

        /* Process liquidation proceeds */
        address wrappedCollateralToken = _processLiquidation(auction_, liquidationHash, liquidationContext);

        /* Delete auction */
        delete _auctions[liquidationHash][collateralToken][collateralTokenId];

        /* Transfer collateral from contract to auction winner */
        if (_isCollateralWrapper(wrappedCollateralToken)) {
            /* Get transfer call target and calldata */
            (address target, bytes memory data) = ICollateralWrapper(wrappedCollateralToken).transferCalldata(
                collateralToken,
                address(this),
                auction_.highestBidder,
                collateralTokenId,
                auction_.quantity
            );

            /* Transfer collateral */
            (bool success, ) = target.call(data);

            /* Validate call success */
            if (!success) revert InvalidClaim();
        } else {
            IERC721(collateralToken).transferFrom(address(this), auction_.highestBidder, collateralTokenId);
        }

        /* Emit AuctionEnded */
        emit AuctionEnded(
            liquidationHash,
            collateralToken,
            collateralTokenId,
            auction_.highestBidder,
            auction_.highestBid
        );
    }
}
