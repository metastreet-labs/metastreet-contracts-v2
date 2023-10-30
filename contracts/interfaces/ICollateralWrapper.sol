// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a Collateral Wrapper
 */
interface ICollateralWrapper {
    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get collateral wrapper name
     * @return Collateral wrapper name
     */
    function name() external view returns (string memory);

    /**
     * @notice Enumerate wrapped collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     * @return token Token address
     * @return tokenIds List of unique token ids
     */
    function enumerate(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds);

    /**
     * @notice Enumerate wrapped collateral with quantities of each token id
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     * @return token Token address
     * @return tokenIds List of unique token ids
     * @return quantities List of quantities of each token id
     */
    function enumerateWithQuantities(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds, uint256[] memory quantities);

    /**
     * @notice Get total token count represented by wrapped collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     * @return tokenCount Total token count
     */
    function count(uint256 tokenId, bytes calldata context) external view returns (uint256 tokenCount);

    /*
     * Transfer collateral calldata
     * @param token Collateral token
     * @param from From address
     * @param to To address
     * @param tokenId Collateral wrapper token ID
     * @param quantity Quantity of token ID
     * @return target Transfer target
     * @return data Transfer calldata
     */
    function transferCalldata(
        address token,
        address from,
        address to,
        uint256 tokenId,
        uint256 quantity
    ) external returns (address target, bytes memory data);

    /*
     * Unwrap collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     */
    function unwrap(uint256 tokenId, bytes calldata context) external;
}
