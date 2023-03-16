// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "../interfaces/ICollateralWrapper.sol";
import "../interfaces/IPool.sol";

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
     * @notice Emitted when bundle collateral wrapper token is minted
     * @param tokenId token id of the new collateral wrapper token
     * @param account address that created the bundle
     * @param encodedBundle bytes array of the token address and token ids
     */
    event BundleCollateralWrapperTokenMinted(uint256 indexed tokenId, address indexed account, bytes encodedBundle);

    /**
     * @notice Emitted when bundle collateral wrapper token is unwrapped
     * @param tokenId token id of the bundle collateral wrapper token
     * @param account address that unwrapped the bundle
     */
    event BundleCollateralWrapperTokenUnwrapped(uint256 tokenId, address account);

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice LoanCollateralWrapper constructor
     */
    constructor() ERC721("MetaStreet Bundle Collateral Wrapper", "MSBCW") {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public view override(ERC721, ICollateralWrapper) returns (string memory) {
        return super.name();
    }

    /**
     * @notice Check if token id exists
     * @param tokenId token id
     * @return True if token id exists, otherwise false
     */
    function exists(uint256 tokenId) external view returns (bool) {
        return _exists(tokenId);
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function enumerate(uint256 tokenId, bytes calldata context) external view returns (IPool.AssetInfo[] memory) {
        if (tokenId != uint256(hash(context))) revert InvalidContext();

        /* get token address from context */
        address token = address(uint160(bytes20(context[0:20])));

        /* cache number of tokens in context */
        uint256 count = (context.length - 20) / 32;

        /* instantiate asset info array */
        IPool.AssetInfo[] memory assets = new IPool.AssetInfo[](count);

        /* populate asset info array */
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = 20 + i * 32;
            assets[i] = IPool.AssetInfo({
                assetType: IPool.AssetType.ERC721,
                token: token,
                tokenId: uint256(bytes32(context[offset:offset + 32]))
            });
        }

        return assets;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Compute bundleTokenId hash
     * @param encodedBundle Encoded bundle
     * @return bundleTokenId hash
     */
    function hash(bytes memory encodedBundle) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded bundle */
        return keccak256(bytes.concat(abi.encodePacked(block.chainid), encodedBundle));
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice deposit NFT collateral into contract and mint a BundleCollateralWrapper token
     * @dev collateral token and token ids are encoded, hashed and stored as the BundleCollateralWrapper token id
     * @param token collateral token address
     * @param tokenIds array of tokenIds
     */
    function mint(address token, uint256[] calldata tokenIds) external returns (uint256) {
        /* create encodedBundle */
        bytes memory encodedBundle = abi.encodePacked(token);

        /* cache length of tokenIds array */
        uint256 count = tokenIds.length;

        /* for each ERC-721 asset, add to encoded bundle and transfer to this contract */
        for (uint256 i = 0; i < count; i++) {
            encodedBundle = bytes.concat(encodedBundle, abi.encodePacked(tokenIds[i]));
            IERC721(token).transferFrom(msg.sender, address(this), tokenIds[i]);
        }

        /* hash encodedBundle */
        uint256 tokenId = uint256(hash(encodedBundle));

        /* mint BundleCollateralWrapper token */
        _mint(msg.sender, tokenId);

        emit BundleCollateralWrapperTokenMinted(tokenId, msg.sender, encodedBundle);

        return tokenId;
    }

    /**
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256 tokenId, bytes calldata context) external {
        if (tokenId != uint256(hash(context))) revert InvalidContext();
        if (msg.sender != ownerOf(tokenId)) revert InvalidCaller();

        /* get token address from context */
        address token = address(uint160(bytes20(context[0:20])));

        /* cache number of token ids */
        uint256 count = (context.length - 20) / 32;

        _burn(tokenId);

        /* transfer assets back to owner of token */
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = 20 + i * 32;
            IERC721(token).transferFrom(address(this), msg.sender, uint256(bytes32(context[offset:offset + 32])));
        }

        emit BundleCollateralWrapperTokenUnwrapped(tokenId, msg.sender);
    }
}
