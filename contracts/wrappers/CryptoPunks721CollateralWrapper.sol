// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/ICollateralWrapper.sol";

/**
 * @title Punk 721 Collateral Wrapper
 * @author MetaStreet Labs
 */
contract CryptoPunks721CollateralWrapper is ICollateralWrapper, ERC721, ReentrancyGuard {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Maximum bundle size
     */
    uint256 internal constant MAX_BUNDLE_SIZE = 32;

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
     * @param punks721Token Crypto Punks 721 token address
     * @param punksToken Crypto Punks token address returned by enumerate API
     *
     * @dev This collateral wrapper is deployed with punks721Token set to Yuga
     * Lab's Ͼ721, and with punksToken set to WPUNKS, which is returned by the
     * enumerate API, for backwards compatibility with existing Crypto Punks
     * pools.
     */
    constructor(
        address punks721Token,
        address punksToken
    ) ERC721("MetaStreet CryptoPunks721 Collateral Wrapper", "MSCP721CW") {
        _punks721 = IERC721(punks721Token);
        _punksToken = punksToken;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ERC721, ICollateralWrapper) returns (string memory) {
        return "MetaStreet CryptoPunks721 Collateral Wrapper";
    }

    /**
     * @inheritdoc ERC721
     */
    function symbol() public pure override returns (string memory) {
        return "MSCP721CW";
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

        /* Set punks token */
        token = _punksToken;

        /* Compute number of tokens in context */
        uint256 tokenCount = context.length / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](tokenCount);

        /* Populate asset info array */
        uint256 offset;
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

        /* Set punks token */
        token = _punksToken;

        /* Compute number of tokens in context */
        uint256 tokenCount = context.length / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](tokenCount);

        /* Instantiate quantities array */
        quantities = new uint256[](tokenCount);

        /* Populate arrays */
        uint256 offset;
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
        return context.length / 32;
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
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Compute hash of encoded bundle
     * @param encodedBundle Encoded bundle
     * @return Hash of encoded bundle
     */
    function _hash(bytes memory encodedBundle) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded bundle */
        return keccak256(abi.encodePacked(block.chainid, encodedBundle));
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Deposit NFT collateral into contract and mint a CryptoPunks721CollateralWrapper token
     *
     * Emits a {PunkMinted} event
     *
     * @dev Collateral token ids are encoded, hashed and stored as
     * the CryptoPunks721CollateralWrapper token ID.
     * @param tokenIds List of token IDs
     */
    function mint(uint256[] calldata tokenIds) external nonReentrant returns (uint256) {
        /* Validate token IDs count */
        if (tokenIds.length == 0 || tokenIds.length > MAX_BUNDLE_SIZE) revert InvalidSize();

        /* Create encoded bundle */
        bytes memory encodedBundle;

        /* For each ERC-721 asset, add to encoded bundle and transfer to this contract */
        for (uint256 i; i < tokenIds.length; i++) {
            encodedBundle = abi.encodePacked(encodedBundle, tokenIds[i]);
            _punks721.transferFrom(msg.sender, address(this), tokenIds[i]);
        }

        /* Hash encodedBundle */
        uint256 tokenId = uint256(_hash(encodedBundle));

        /* Mint CryptoPunks721CollateralWrapper token */
        _mint(msg.sender, tokenId);

        emit PunkMinted(tokenId, msg.sender, encodedBundle);

        return tokenId;
    }

    /**
     * Emits a {PunkUnwrapped} event
     *
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256 tokenId, bytes calldata context) external nonReentrant {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();
        if (msg.sender != ownerOf(tokenId)) revert InvalidCaller();

        /* Compute number of token ids */
        uint256 tokenCount = context.length / 32;

        _burn(tokenId);

        /* Transfer assets back to owner of token */
        uint256 offset;
        for (uint256 i; i < tokenCount; i++) {
            _punks721.transferFrom(address(this), msg.sender, uint256(bytes32(context[offset:offset + 32])));
            offset += 32;
        }

        emit PunkUnwrapped(tokenId, msg.sender);
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
