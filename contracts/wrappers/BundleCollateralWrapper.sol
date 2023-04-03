// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "../interfaces/ICollateralWrapper.sol";

/**
 * @title Bundle Collateral Wrapper
 */
contract BundleCollateralWrapper is ICollateralWrapper, ERC721, ERC721Holder {
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

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice BundleCollateralWrapper constructor
     */
    constructor() ERC721("MetaStreet Bundle Collateral Wrapper", "MSBCW") {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ERC721, ICollateralWrapper) returns (string memory) {
        return "MetaStreet Bundle Collateral Wrapper";
    }

    /**
     * @inheritdoc ERC721
     */
    function symbol() public pure override returns (string memory) {
        return "MSBCW";
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

        /* Get token address from context */
        token = address(uint160(bytes20(context[0:20])));

        /* Compute number of tokens in context */
        uint256 count = (context.length - 20) / 32;

        /* Instantiate asset info array */
        tokenIds = new uint256[](count);

        /* Populate asset info array */
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = 20 + i * 32;
            tokenIds[i] = uint256(bytes32(context[offset:offset + 32]));
        }
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

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Deposit NFT collateral into contract and mint a BundleCollateralWrapper token
     *
     * Emits a {BundleMinted} event
     *
     * @dev Collateral token and token ids are encoded, hashed and stored as
     * the BundleCollateralWrapper token ID.
     * @param token Collateral token address
     * @param tokenIds List of token IDs
     */
    function mint(address token, uint256[] calldata tokenIds) external returns (uint256) {
        /* Create encodedBundle */
        bytes memory encodedBundle = abi.encodePacked(token);

        /* For each ERC-721 asset, add to encoded bundle and transfer to this contract */
        for (uint256 i = 0; i < tokenIds.length; i++) {
            encodedBundle = bytes.concat(encodedBundle, abi.encodePacked(tokenIds[i]));
            IERC721(token).transferFrom(msg.sender, address(this), tokenIds[i]);
        }

        /* Hash encodedBundle */
        uint256 tokenId = uint256(_hash(encodedBundle));

        /* Mint BundleCollateralWrapper token */
        _mint(msg.sender, tokenId);

        emit BundleMinted(tokenId, msg.sender, encodedBundle);

        return tokenId;
    }

    /**
     * Emits a {BundleUnwrapped} event
     *
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256 tokenId, bytes calldata context) external {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();
        if (msg.sender != ownerOf(tokenId)) revert InvalidCaller();

        /* Get token address from context */
        address token = address(uint160(bytes20(context[0:20])));

        /* Compute number of token ids */
        uint256 count = (context.length - 20) / 32;

        _burn(tokenId);

        /* Transfer assets back to owner of token */
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = 20 + i * 32;
            IERC721(token).transferFrom(address(this), msg.sender, uint256(bytes32(context[offset:offset + 32])));
        }

        emit BundleUnwrapped(tokenId, msg.sender);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(ICollateralWrapper).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
