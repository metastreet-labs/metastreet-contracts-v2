// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "../CollateralFilter.sol";

/**
 * @title Merkle Collateral Filter
 * @author MetaStreet Labs
 */
contract MerkleCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid root
     */
    error InvalidRoot();

    /**
     * @notice Invalid node count
     */
    error InvalidNodeCount();

    /**
     * @notice Invalid context
     */
    error InvalidContext();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**
     * @notice Number of nodes for each proof
     */
    uint32 private _nodeCount;

    /**
     * @notice Merkle root
     */
    bytes32 private _root;

    /**
     * @notice Metadata URI
     */
    string private _metadataURI;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice MerkleCollateralFilter initializer
     */
    function _initialize(address token, bytes memory params) internal {
        /* Decode parameters */
        (bytes32 root, uint32 nodeCount, string memory metadataURI_) = abi.decode(params, (bytes32, uint32, string));

        if (root == "") revert InvalidRoot();
        if (nodeCount == 0) revert InvalidNodeCount();

        _token = token;
        _root = root;
        _nodeCount = nodeCount;
        _metadataURI = metadataURI_;
    }

    /**************************************************************************/
    /* Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function that returns merkle proof in bytes32[] shape
     * @param context Context
     * @param nodeCount Node count
     * @return merkleProof Merkle proof
     */
    function _merkleProof(
        bytes calldata context,
        uint256 nodeCount
    ) internal pure returns (bytes32[] memory merkleProof) {
        /* Reduce number of merkle nodes by 1 if last 32 bytes are empty */
        if (bytes32(context[context.length - 32:]) == bytes32(0)) nodeCount -= 1;

        /* Instantiate merkle proof array */
        merkleProof = new bytes32[](nodeCount);

        /* Declare offset */
        uint256 offset;

        /* Populate merkle proof array */
        for (uint256 i; i < nodeCount; i++) {
            /* Set node */
            merkleProof[i] = bytes32(context[offset:]);

            /* Compute next offset */
            offset += 32;
        }
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "MerkleCollateralFilter";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_VERSION() external pure override returns (string memory) {
        return "1.0";
    }

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() external view override returns (address) {
        return _token;
    }

    /**
     * @notice Get merkle root
     * @return Merkle root
     */
    function merkleRoot() external view returns (bytes32) {
        return _root;
    }

    /**
     * @notice Get metadata URI
     * @return Metadata URI
     */
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function _collateralSupported(
        address token,
        uint256 tokenId,
        uint256 index,
        bytes calldata context
    ) internal view override returns (bool) {
        /* Validate token supported */
        if (token != _token) return false;

        /* Declare node count */
        uint256 nodeCount = _nodeCount;

        /* Compute proof length */
        uint256 proofLength = nodeCount * 32;

        /* Compute start and end index */
        uint256 startIndex = index * proofLength;
        uint256 endIndex = startIndex + proofLength;

        /* Validate context length */
        if (context.length < endIndex) revert InvalidContext();

        /* Compute proof from context */
        bytes32[] memory proof = _merkleProof(context[startIndex:endIndex], nodeCount);

        /* Cast token id into bytes32 */
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId))));

        return MerkleProof.verify(proof, _root, leaf);
    }
}
