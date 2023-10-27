// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {ICryptoPunksMarket} from "../interfaces/ICryptoPunksMarket.sol";
import "../interfaces/ICollateralWrapper.sol";

/**
 * @title Punk Collateral Wrapper
 * @author MetaStreet Labs
 */
contract PunkCollateralWrapper is ICollateralWrapper, ERC721, ReentrancyGuard {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Crypto punk market on mainnet
     */
    ICryptoPunksMarket internal constant PUNKS_MARKET = ICryptoPunksMarket(0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB);

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
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice PunkCollateralWrapper constructor
     */
    constructor() ERC721("MetaStreet Punk Collateral Wrapper", "MSPCW") {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ERC721, ICollateralWrapper) returns (string memory) {
        return "MetaStreet Punk Collateral Wrapper";
    }

    /**
     * @inheritdoc ERC721
     */
    function symbol() public pure override returns (string memory) {
        return "MSPCW";
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

        /* Set token as punks market address */
        token = address(PUNKS_MARKET);

        /* Compute number of tokens in context */
        uint256 count_ = context.length / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](count_);

        /* Populate asset info array */
        uint256 offset;
        for (uint256 i; i < count_; i++) {
            tokenIds[i] = uint256(bytes32(context[offset:offset + 32]));
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
     * @notice Deposit Punk NFT collateral into contract and mint a PunkCollateralWrapper token
     *
     * Emits a {PunkMinted} event
     *
     * @dev Token ids are encoded, hashed and stored as
     * the PunkCollateralWrapper token ID.
     * @param tokenIds Punk token IDs
     */
    function mint(uint256[] memory tokenIds) external nonReentrant returns (uint256) {
        /* Validate token IDs count */
        if (tokenIds.length == 0 || tokenIds.length > MAX_BUNDLE_SIZE) revert InvalidSize();

        /* Create encoded bundle */
        bytes memory encodedBundle;

        /* For each punk, add to encoded bundle and transfer to this contract */
        for (uint256 i; i < tokenIds.length; i++) {
            encodedBundle = abi.encodePacked(encodedBundle, tokenIds[i]);

            /* Validate that caller owns the punk */
            if (PUNKS_MARKET.punkIndexToAddress(tokenIds[i]) != msg.sender) revert InvalidCaller();

            /* Requires offerPunkForSaleToAddress with 0 ethers to this contract */
            PUNKS_MARKET.buyPunk(tokenIds[i]);
        }

        /* Hash encodedBundle */
        uint256 tokenId = uint256(_hash(encodedBundle));

        /* Mint PunkCollateralWrapper token */
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
        uint256 count_ = context.length / 32;

        _burn(tokenId);

        /* Transfer punk back to owner of token */
        uint256 offset;
        for (uint256 i; i < count_; i++) {
            PUNKS_MARKET.transferPunk(msg.sender, uint256(bytes32(context[offset:offset + 32])));
            offset += 32;
        }

        /* Emits PunkUnwrapped */
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
