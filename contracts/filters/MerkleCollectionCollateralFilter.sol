// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "../CollateralFilter.sol";

/**
 * @title Merkle Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract MerkleCollectionCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

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
     * @notice MerkleCollectionCollateralFilter initializer
     */
    function _initialize(address token, bytes32 root, uint32 nodeCount, string memory metadataURI_) internal {
        /* Validate root */
        if (root == bytes32(0)) revert InvalidCollateralFilterParameters();

        _token = token;
        _root = root;
        _metadataURI = metadataURI_;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "MerkleCollectionCollateralFilter";
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
        uint256[] memory tokenIds,
        bytes calldata context
    ) internal view override {
        /* Validate token supported */
        if (token != _token) revert UnsupportedCollateral();

        /* Decode context */
        (bytes32[] memory proof, bool[] memory proofFlags) = abi.decode(context, (bytes32[], bool[]));

        /* Compute leaf hash */
        bytes32[] memory leaves = new bytes32[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(tokenIds[i]))));
        }

        if (!MerkleProof.multiProofVerify(proof, proofFlags, _root, leaves)) revert UnsupportedCollateral();
    }
}
