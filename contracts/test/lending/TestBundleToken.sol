// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/**
 * @title Test Bundle Token
 */
contract TestBundleToken is ERC721, ERC721Holder {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a Bundle Minted
     * @param bundleId Bundle ID
     * @param account Account address
     */
    event BundleMinted(uint256 indexed bundleId, address indexed account);

    /**
     * @notice Emitted when an NFT is deposited in a bundle
     * @param bundleId Bundle ID
     * @param account Account address
     * @param token Token address
     * @param tokenId Token ID
     */
    event BundleDeposited(uint256 indexed bundleId, address indexed account, address token, uint256 tokenId);

    /**
     * @notice Emitted when an NFT is withdrawn
     * @param bundleId Bundle ID
     * @param account Account address
     */
    event BundleWithdrawn(uint256 indexed bundleId, address indexed account);

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Bundled Asset
     * @param token Token contract
     * @param tokenId Token ID
     */
    struct BundledAsset {
        IERC721 token;
        uint256 tokenId;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @dev Bundles
     */
    mapping(uint256 => BundledAsset[]) private _bundles;

    /**
     * @dev Bundle ID counter
     */
    uint256 private _bundleId;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestBundle constructor
     */
    constructor() ERC721("Test Bundle", "BUN") {}

    /**************************************************************************/
    /* Privileged API */
    /**************************************************************************/

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Check if note token ID exists
     * @param tokenId Note token ID
     * @return True note token ID exists, otherwise false
     */
    function exists(uint256 tokenId) external view returns (bool) {
        return _exists(tokenId);
    }

    /**
     * @notice Get contents of bundle
     * @param bundleId Bundle ID
     * @return Assets
     */
    function contents(uint256 bundleId) external view returns (BundledAsset[] memory) {
        return _bundles[bundleId];
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Mint bundle to caller
     * @return Bundle ID
     */
    function mint() external returns (uint256) {
        uint256 bundleId = _bundleId++;

        _safeMint(msg.sender, bundleId);

        emit BundleMinted(bundleId, msg.sender);

        return bundleId;
    }

    /**
     * @notice Deposit into bundle
     * @param bundleId Bundle ID
     * @param token Token contract
     * @param tokenId Token ID
     */
    function deposit(uint256 bundleId, IERC721 token, uint256 tokenId) external {
        /* Validate caller */
        if (msg.sender != ownerOf(bundleId)) revert InvalidCaller();

        /* Add asset to bundle */
        _bundles[bundleId].push(BundledAsset({token: token, tokenId: tokenId}));

        /* Transfer asset */
        token.safeTransferFrom(msg.sender, address(this), tokenId);

        emit BundleDeposited(bundleId, msg.sender, address(token), tokenId);
    }

    /**
     * @notice Withdraw all assets from bundle and destroy it
     * @param bundleId Bundle ID
     */
    function withdraw(uint256 bundleId) external {
        /* Validate caller */
        if (msg.sender != ownerOf(bundleId)) revert InvalidCaller();

        /* Withdraw each asset */
        BundledAsset[] storage assets = _bundles[bundleId];
        for (uint256 i; i < assets.length; i++) {
            assets[i].token.safeTransferFrom(address(this), msg.sender, assets[i].tokenId);
        }

        /* Delete bundle and burn token */
        delete _bundles[bundleId];
        _burn(bundleId);

        emit BundleWithdrawn(bundleId, msg.sender);
    }
}
