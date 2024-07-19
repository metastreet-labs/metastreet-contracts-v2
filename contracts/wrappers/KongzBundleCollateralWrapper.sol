// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/ICollateralWrapper.sol";

import "../integrations/CyberKongz/IYieldHub.sol";

/**
 * @title CyberKongz Bundle Collateral Wrapper
 * @author MetaStreet Labs
 */
contract KongzBundleCollateralWrapper is ICollateralWrapper, ERC721, ReentrancyGuard {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.1";

    /**
     * @notice Maximum bundle size
     */
    uint256 internal constant MAX_BUNDLE_SIZE = 16;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid context
     */
    error InvalidContext();

    /**
     * @notice Invalid bundle size
     */
    error InvalidSize();

    /**
     * @notice Invalid parameter
     */
    error InvalidParameter();

    /**
     * @notice Invalid token ID
     * @param tokenId Token ID
     */
    error InvalidTokenId(uint256 tokenId);

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when bundle is minted
     * @param tokenId Token ID of the new collateral wrapper token
     * @param account Address that created the bundle
     * @param encodedBundle Encoded bundle data
     */
    event BundleMinted(uint256 indexed tokenId, address indexed account, bytes encodedBundle);

    /**
     * @notice Emitted when bundle is unwrapped
     * @param tokenId Token ID of the bundle collateral wrapper token
     * @param account Address that unwrapped the bundle
     */
    event BundleUnwrapped(uint256 indexed tokenId, address indexed account);

    /**
     * @notice Emitted when yield is claimed
     * @param tokenId Token ID of the bundle collateral wrapper token
     * @param account Address that unwrapped the bundle
     * @param amount Amount of yield claimed
     */
    event YieldClaimed(uint256 indexed tokenId, address indexed account, uint256 amount);

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice CyberKongz ERC721
     */
    IERC721 internal immutable _cyberkongz;

    /**
     * @notice Banana ERC20
     */
    IERC20 internal immutable _banana;

    /**
     * @notice CyberKongz YieldHub
     */
    IYieldHub internal immutable _yieldHub;

    /**
     * @notice CyberKongz YieldToken start
     */
    uint256 internal immutable _yieldTokenStart;

    /**
     * @notice CyberKongz YieldToken end
     */
    uint256 internal immutable _yieldTokenEnd;

    /**
     * @notice CyberKongz YieldToken rate
     */
    uint256 internal immutable _yieldTokenRate;

    /**
     * @notice Eligible max token ID (inclusive)
     */
    uint256 internal immutable _maxTokenId;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Token ID to last updated timestamps
     */
    mapping(uint256 => uint256) internal _lastUpdatedTimestamps;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice KongzBundleCollateralWrapper constructor
     */
    constructor(
        address cyberkongz,
        address banana,
        address yieldHub,
        uint256 maxTokenId
    ) ERC721("MetaStreet CyberKongz Bundle Collateral Wrapper", "MSCKBCW") {
        _cyberkongz = IERC721(cyberkongz);
        _banana = IERC20(banana);
        _yieldHub = IYieldHub(yieldHub);

        IYieldHub.YieldToken memory yieldToken = IYieldHub(yieldHub).yieldTokens(banana);

        /* Validate the yield token takes the correct code path */
        if (yieldToken.stake != uint8(0)) revert InvalidParameter();

        _yieldTokenStart = yieldToken.start;
        _yieldTokenEnd = yieldToken.end;
        _yieldTokenRate = yieldToken.rate;

        _maxTokenId = maxTokenId;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ERC721, ICollateralWrapper) returns (string memory) {
        return "MetaStreet CyberKongz Bundle Collateral Wrapper";
    }

    /**
     * @inheritdoc ERC721
     */
    function symbol() public pure override returns (string memory) {
        return "MSCKBCW";
    }

    /**
     * @notice Check if token ID exists
     * @param tokenId Token ID
     * @return True if token ID exists, otherwise false
     */
    function exists(uint256 tokenId) external view returns (bool) {
        return _exists(tokenId);
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function enumerate(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds) {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();

        /* Set token as cyberkongz token */
        token = address(_cyberkongz);

        /* Compute number of tokens in context */
        uint256 tokenCount = (context.length - 20) / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](tokenCount);

        /* Populate asset info array */
        uint256 offset = 20;
        for (uint256 i; i < tokenCount; i++) {
            tokenIds[i] = uint256(bytes32(context[offset:offset + 32]));
            offset += 32;
        }
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function enumerateWithQuantities(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds, uint256[] memory quantities) {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();

        /* Set token as cyberkongz token */
        token = address(_cyberkongz);

        /* Compute number of tokens in context */
        uint256 tokenCount = (context.length - 20) / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](tokenCount);

        /* Instantiate quantities array */
        quantities = new uint256[](tokenCount);

        /* Populate arrays */
        uint256 offset = 20;
        for (uint256 i; i < tokenCount; i++) {
            tokenIds[i] = uint256(bytes32(context[offset:offset + 32]));
            quantities[i] = 1;
            offset += 32;
        }
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function count(uint256 tokenId, bytes calldata context) external view returns (uint256) {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();

        /* Compute number of tokens in context */
        return (context.length - 20) / 32;
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function transferCalldata(
        address token,
        address from,
        address to,
        uint256 tokenId,
        uint256
    ) external pure returns (address, bytes memory) {
        return (token, abi.encodeWithSelector(IERC721.transferFrom.selector, from, to, tokenId));
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Compute hash of encoded bundle
     * @param encodedBundle Encoded bundle
     * @return bundleTokenId Hash
     */
    function _hash(bytes memory encodedBundle) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded bundle */
        return keccak256(abi.encodePacked(block.chainid, encodedBundle));
    }

    /**
     * @dev Helper to get min of A and B
     * @param a A
     * @param b B
     * @return Min of A and B
     */
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /**
     * @dev Helper to get max of A and B
     * @param a A
     * @param b B
     * @return Max of A and B
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    /**
     * @dev Helper to claim rewards for this contract and transfer to minter
     * @param minter Minter
     * @param tokenId Token ID
     * @param tokenCount Token count
     */
    function _claim(address minter, uint256 tokenId, uint256 tokenCount) internal {
        /* Claim rewards for this contract */
        _yieldHub.getTokenReward(address(_banana));

        /* Cache last updated timestamp */
        uint256 lastUpdatedTimestamp = _lastUpdatedTimestamps[tokenId];

        /* Nothing to claim when outside yield window */
        if (block.timestamp < _yieldTokenStart || lastUpdatedTimestamp > _yieldTokenEnd) return;

        /* Calculate delta since last updated timestamp */
        uint256 delta = min(block.timestamp, _yieldTokenEnd) - max(lastUpdatedTimestamp, _yieldTokenStart);

        /* Calculate claimable BANANA and send to minter */
        uint256 amount = (tokenCount * _yieldTokenRate * delta) / 86400;
        if (amount > 0) {
            amount = Math.min(amount, _banana.balanceOf(address(this)));
            _banana.transfer(minter, amount);
        }

        emit YieldClaimed(tokenId, minter, amount);
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Deposit NFT collateral into contract and mint a BundleCollateralWrapper token
     *
     * Emits a {BundleMinted} event
     *
     * @dev Minter and collateral token IDs are encoded, hashed and stored as
     * the KongzBundleCollateralWrapper token ID.
     * @param tokenIds List of token IDs
     */
    function mint(uint256[] calldata tokenIds) external nonReentrant returns (uint256) {
        /* Validate token IDs count */
        if (tokenIds.length == 0 || tokenIds.length > MAX_BUNDLE_SIZE) revert InvalidSize();

        /* Create encodedBundle */
        bytes memory encodedBundle = abi.encodePacked(msg.sender);

        /* For each ERC-721 asset, add to encoded bundle and transfer to this contract */
        for (uint256 i; i < tokenIds.length; i++) {
            if (tokenIds[i] > _maxTokenId) revert InvalidTokenId(tokenIds[i]);

            encodedBundle = abi.encodePacked(encodedBundle, tokenIds[i]);
            _cyberkongz.transferFrom(msg.sender, address(this), tokenIds[i]);
        }

        /* Hash encodedBundle */
        uint256 tokenId = uint256(_hash(encodedBundle));

        /* Mint BundleCollateralWrapper token */
        _mint(msg.sender, tokenId);

        /* Update last updated timestamp */
        _lastUpdatedTimestamps[tokenId] = block.timestamp;

        emit BundleMinted(tokenId, msg.sender, encodedBundle);

        return tokenId;
    }

    /**
     * Emits a {BundleUnwrapped} event
     *
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256 tokenId, bytes calldata context) external nonReentrant {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();
        if (msg.sender != ownerOf(tokenId)) revert InvalidCaller();

        /* Get minter of escrowed CyberKongz */
        address minter = address(uint160(bytes20(context[0:20])));

        /* Compute number of token IDs */
        uint256 tokenCount = (context.length - 20) / 32;

        _burn(tokenId);

        /* Update this contract's BANANA balance and transfer BANANA to minter */
        _claim(minter, tokenId, tokenCount);

        /* Delete last updated timestamp record for token ID */
        delete _lastUpdatedTimestamps[tokenId];

        /* Transfer assets back to owner of token */
        uint256 offset = 20;
        for (uint256 i; i < tokenCount; i++) {
            _cyberkongz.transferFrom(address(this), msg.sender, uint256(bytes32(context[offset:offset + 32])));
            offset += 32;
        }

        emit BundleUnwrapped(tokenId, msg.sender);
    }

    /**
     * @notice Claim BANANA
     *
     * Emits a {YieldClaimed} event
     *
     * @param tokenId Collateral token ID
     * @param context Encoded and hashed minter address and collateral token IDs
     */
    function claim(uint256 tokenId, bytes calldata context) external nonReentrant {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();
        if (!_exists(tokenId)) revert InvalidContext();

        /* Get minter of escrowed CyberKongz */
        address minter = address(uint160(bytes20(context[0:20])));

        /* Compute number of token IDs */
        uint256 tokenCount = (context.length - 20) / 32;

        /* Update this contract's BANANA balance and transfer BANANA to minter */
        _claim(minter, tokenId, tokenCount);

        /* Update last updated timestamp record  */
        _lastUpdatedTimestamps[tokenId] = block.timestamp;
    }

    /**
     * @notice Get amount of BANANA claimable for bundle collateral token ID
     *
     * @param tokenId Collateral token ID
     * @param context Encoded and hashed minter address and collateral token IDs
     * @return Amount of BANANA claimable
     */
    function claimable(uint256 tokenId, bytes calldata context) external view returns (uint256) {
        /* Compute contract's BANANA balance with simulated rewards fetch */
        uint256 balance = _banana.balanceOf(address(this)) +
            _yieldHub.getTotalClaimable(address(this), address(_banana));

        /* Compute number of token IDs */
        uint256 tokenCount = (context.length - 20) / 32;

        /* Cache last updated timestamp */
        uint256 lastUpdatedTimestamp = _lastUpdatedTimestamps[tokenId];

        /* Nothing to claim when outside yield window */
        if (block.timestamp < _yieldTokenStart || lastUpdatedTimestamp > _yieldTokenEnd) return 0;

        /* Calculate delta since last updated timestamp */
        uint256 delta = min(block.timestamp, _yieldTokenEnd) - max(lastUpdatedTimestamp, _yieldTokenStart);

        /* Calculate claimable BANANA */
        uint256 amount = (tokenCount * _yieldTokenRate * delta) / 86400;
        return Math.min(amount, balance);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ICollateralWrapper).interfaceId || super.supportsInterface(interfaceId);
    }
}
