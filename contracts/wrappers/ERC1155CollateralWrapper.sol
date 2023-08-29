// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "../interfaces/ICollateralWrapper.sol";

/**
 * @title ERC1155 Collateral Wrapper
 * @author MetaStreet Labs
 */
contract ERC1155CollateralWrapper is ICollateralWrapper, ERC721, ERC1155Holder, ReentrancyGuard {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Maximum batch size
     */
    uint256 internal constant MAX_BATCH_SIZE = 32;

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
     * @notice Invalid batch size
     */
    error InvalidSize();

    /**
     * @notice Invalid token id
     */
    error InvalidOrdering();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Encoding nonce
     */
    uint256 private _nonce;

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when batch is minted
     * @param tokenId Token ID of the new collateral wrapper token
     * @param account Address that created the batch
     * @param encodedBatch Encoded batch data
     */
    event BatchMinted(uint256 indexed tokenId, address indexed account, bytes encodedBatch);

    /**
     * @notice Emitted when batch is unwrapped
     * @param tokenId Token ID of the batch collateral wrapper token
     * @param account Address that unwrapped the batch
     */
    event BatchUnwrapped(uint256 indexed tokenId, address indexed account);

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice BatchCollateralWrapper constructor
     */
    constructor() ERC721("MetaStreet ERC1155 Collateral Wrapper", "MSMTCW") {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralWrapper
     */
    function name() public pure override(ERC721, ICollateralWrapper) returns (string memory) {
        return "MetaStreet ERC1155 Collateral Wrapper";
    }

    /**
     * @inheritdoc ERC721
     */
    function symbol() public pure override returns (string memory) {
        return "MSMTCW";
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
    function enumerate(uint256 tokenId, bytes calldata context) external view returns (address, uint256[] memory) {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();

        /* Decode context */
        (address token, , uint256 batchSize, uint256[] memory tokenIds, uint256[] memory multipliers) = abi.decode(
            context,
            (address, uint256, uint256, uint256[], uint256[])
        );

        /* Declare flatten token ids array with batch size */
        uint256[] memory flattenTokenIds = new uint256[](batchSize);

        /* Assign token ids to flatten token ids array */
        uint256 index;
        for (uint256 i; i < tokenIds.length; i++) {
            for (uint256 j; j < multipliers[i]; j++) {
                flattenTokenIds[index++] = tokenIds[i];
            }
        }

        return (token, flattenTokenIds);
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Compute hash of encoded batch
     * @param encodedBatch Encoded batch
     * @return batchTokenId Hash
     */
    function _hash(bytes memory encodedBatch) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded batch */
        return keccak256(abi.encodePacked(block.chainid, encodedBatch));
    }

    /**************************************************************************/
    /* User API */
    /**************************************************************************/

    /**
     * @notice Deposit a ERC1155 collateral into contract and mint a ERC1155CollateralWrapper token
     *
     * Emits a {BatchMinted} event
     *
     * @dev Collateral token, nonce, token ids, batch size, and multipliers are encoded,
     * hashed and stored as the ERC1155CollateralWrapper token ID.
     * @param token Collateral token address
     * @param tokenIds List of token ids
     * @param multipliers List of multipliers
     */
    function mint(
        address token,
        uint256[] calldata tokenIds,
        uint256[] calldata multipliers
    ) external nonReentrant returns (uint256) {
        /* Validate token ids and multipliers count */
        if (tokenIds.length == 0 || tokenIds.length != multipliers.length) revert InvalidSize();

        /* Validate token ID and multiplier */
        uint256 batchSize;
        for (uint256 i; i < tokenIds.length; i++) {
            /* Validate unique token ID */
            if (i != 0 && tokenIds[i] <= tokenIds[i - 1]) revert InvalidOrdering();

            /* Validate multiplier is non-zero */
            if (multipliers[i] == 0) revert InvalidSize();

            /* Compute batch size */
            batchSize += multipliers[i];
        }

        /* Validate batch size */
        if (batchSize > MAX_BATCH_SIZE) revert InvalidSize();

        /* Create encoded batch and increment nonce */
        bytes memory encodedBatch = abi.encode(token, _nonce++, batchSize, tokenIds, multipliers);

        /* Hash encoded batch */
        uint256 tokenId = uint256(_hash(encodedBatch));

        /* Batch transfer tokens */
        IERC1155(token).safeBatchTransferFrom(msg.sender, address(this), tokenIds, multipliers, "");

        /* Mint ERC1155CollateralWrapper token */
        _mint(msg.sender, tokenId);

        emit BatchMinted(tokenId, msg.sender, encodedBatch);

        return tokenId;
    }

    /**
     * Emits a {BatchUnwrapped} event
     *
     * @inheritdoc ICollateralWrapper
     */
    function unwrap(uint256 tokenId, bytes calldata context) external nonReentrant {
        if (tokenId != uint256(_hash(context))) revert InvalidContext();
        if (msg.sender != ownerOf(tokenId)) revert InvalidCaller();

        /* Decode context */
        (address token, , , uint256[] memory tokenIds, uint256[] memory multipliers) = abi.decode(
            context,
            (address, uint256, uint256, uint256[], uint256[])
        );

        /* Burn ERC1155CollateralWrapper token */
        _burn(tokenId);

        /* Batch transfer tokens back to token owner */
        IERC1155(token).safeBatchTransferFrom(address(this), msg.sender, tokenIds, multipliers, "");

        emit BatchUnwrapped(tokenId, msg.sender);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC1155Receiver) returns (bool) {
        return interfaceId == type(ICollateralWrapper).interfaceId || super.supportsInterface(interfaceId);
    }
}
