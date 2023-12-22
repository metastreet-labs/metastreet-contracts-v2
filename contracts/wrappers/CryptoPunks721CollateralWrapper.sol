// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
// import "@openzeppelin/contracts/utils/introspection/ERC165";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/ICollateralWrapper.sol";

/**
 * @title Punk 721 Collateral Wrapper
 * @author MetaStreet Labs
 */
contract CryptoPunks721CollateralWrapper is ICollateralWrapper, IERC721, IERC721Metadata, ReentrancyGuard {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Total punks
     */
    uint256 internal constant TOTAL_PUNKS = 10_000;

    /**
     * @notice Maximum bundle size
     */
    uint256 internal constant MAX_BUNDLE_SIZE = 16;

    /**
     * @notice Token ID bits
     */
    uint256 internal constant TOKEN_ID_BITS = 16;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid encoding
     */
    error InvalidEncoding();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when punk collateral wrapper is minted
     * @param tokenId Token ID of the new collateral wrapper token
     * @param account Address that created the punk collateral wrapper
     * @param encodedBundle Encoded bundle data
     */
    event PunkMinted(uint256 indexed tokenId, address indexed account, bytes encodedBundle);

    /**
     * @notice Emitted when punk collateral wrapper is unwrapped
     * @param tokenId Token ID of the punk collateral wrapper token
     * @param account Address that unwrapped the punk collateral wrapper
     */
    event PunkUnwrapped(uint256 indexed tokenId, address indexed account);

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice Pool
     */
    address internal immutable _pool;

    /**
     * @notice Liquidator
     */
    address internal immutable _liquidator;

    /**
     * @notice Yuga Lab's Crypto Punks Wrapper
     */
    IERC721 internal immutable _punks721;

    /**
     * @notice Crypto Punks Token (returned by enumerate API)
     */
    address internal immutable _punksToken;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice CryptoPunks721CollateralWrapper constructor
     * @param pool Pool address
     * @param liquidator Liquidator
     * @param punks721Token Crypto Punks 721 token address
     * @param punksToken Crypto Punks token address returned by enumerate API
     *
     * @dev This collateral wrapper is deployed with punks721Token set to Yuga
     * Lab's Ͼ721, and with punksToken set to WPUNKS, which is returned by the
     * enumerate API, for backwards compatibility with existing Crypto Punks
     * pools.
     */
    constructor(address pool, address liquidator, address punks721Token, address punksToken) {
        _pool = pool;
        _liquidator = liquidator;
        _punks721 = IERC721(punks721Token);
        _punksToken = punksToken;
    }

    /**************************************************************************/
    /* No-op IERC721 */
    /**************************************************************************/

    function balanceOf(address) public view returns (uint256) {}

    function ownerOf(uint256) public view returns (address) {}

    function approve(address, uint256) public {}

    function getApproved(uint256) public view returns (address) {}

    function setApprovalForAll(address, bool) public {}

    function isApprovedForAll(address, address) public view returns (bool) {}

    function safeTransferFrom(address, address, uint256) public {}

    function safeTransferFrom(address, address, uint256, bytes memory) public {}

    /**************************************************************************/
    /* No-op IERC721Metadata */
    /**************************************************************************/

    function tokenURI(uint256) external view returns (string memory) {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ICollateralWrapper, IERC721Metadata) returns (string memory) {
        return "MetaStreet CryptoPunks721 Collateral Wrapper";
    }

    /**
     * @inheritdoc IERC721Metadata
     */
    function symbol() public pure override returns (string memory) {
        return "MSCP721CW";
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function enumerate(
        uint256 encodedTokenId,
        bytes calldata
    ) external view returns (address token, uint256[] memory tokenIds) {
        /* Compute number of tokens in encoded token ID */
        uint256 tokenCount;
        for (; tokenCount < MAX_BUNDLE_SIZE; tokenCount++) {
            if (uint16(encodedTokenId >> (tokenCount * TOKEN_ID_BITS)) >= TOTAL_PUNKS) break;
        }

        /* Instantiate asset info array */
        tokenIds = new uint256[](tokenCount);

        /* Populate asset info array */
        for (uint i; i < tokenCount; i++) {
            tokenIds[i] = uint16(encodedTokenId >> (i * TOKEN_ID_BITS));
        }

        /* Set punks token */
        token = _punksToken;
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function enumerateWithQuantities(
        uint256 encodedTokenId,
        bytes calldata
    ) external view returns (address token, uint256[] memory tokenIds, uint256[] memory quantities) {
        /* Compute number of tokens in encoded token ID */
        uint256 tokenCount;
        for (; tokenCount < MAX_BUNDLE_SIZE; tokenCount++) {
            if (uint16(encodedTokenId >> (tokenCount * TOKEN_ID_BITS)) >= TOTAL_PUNKS) break;
        }

        /* Instantiate asset info array and quantities array */
        tokenIds = new uint256[](tokenCount);
        quantities = new uint256[](tokenCount);

        /* Populate asset info array */
        for (uint i; i < tokenCount; i++) {
            tokenIds[i] = uint16(encodedTokenId >> (i * TOKEN_ID_BITS));
            quantities[i] = 1;
        }

        /* Set punks token */
        token = _punksToken;
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function count(uint256 encodedTokenId, bytes calldata) external pure returns (uint256) {
        uint256 tokenCount;
        for (; tokenCount < MAX_BUNDLE_SIZE; tokenCount++) {
            if (uint16(encodedTokenId >> (tokenCount * TOKEN_ID_BITS)) >= TOTAL_PUNKS) break;
        }

        return tokenCount;
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function transferCalldata(
        address,
        address from,
        address to,
        uint256 tokenId,
        uint256
    ) external view returns (address, bytes memory) {
        return (address(_punks721), abi.encodeWithSelector(IERC721.transferFrom.selector, from, to, tokenId));
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     *
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256, bytes calldata) external nonReentrant {}

    /**
     * @notice Transfer punks 721
     * @param from From
     * @param encodedTokenId Encoded token ID
     *
     * @dev This function can only be called by the pool or liquidator contract. Special care must be
     * taken to make sure no user-supplied functions are allowed to be called from the pool and
     * liquidator contract. Requires punk owner to have approved this contract.
     */
    function transferFrom(address from, address, uint256 encodedTokenId) public override nonReentrant {
        /* Validate that this function is called by pool or liquidator */
        if (msg.sender != _pool && msg.sender != _liquidator) revert InvalidCaller();

        /* Iterate through encoded token ID and transfers underlying token IDs */
        uint256 tokenCount;
        for (; tokenCount < MAX_BUNDLE_SIZE; tokenCount++) {
            uint256 tokenId = uint16(encodedTokenId >> (tokenCount * TOKEN_ID_BITS));

            if (tokenId >= TOTAL_PUNKS) break;

            _punks721.transferFrom(from, msg.sender == _pool ? address(this) : _liquidator, tokenId);
        }

        /* Validate at least one punk was transferred */
        if (tokenCount == 0) revert InvalidEncoding();
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == type(ICollateralWrapper).interfaceId ||
            interfaceId == type(IERC721).interfaceId ||
            interfaceId == type(IERC721Metadata).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
