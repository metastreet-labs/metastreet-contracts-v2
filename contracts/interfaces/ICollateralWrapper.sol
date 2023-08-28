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
     * @return count Total token count
     */
    function enumerate(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds, uint256 count);

    /*
     * Unwrap collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     */
    function unwrap(uint256 tokenId, bytes calldata context) external;
}
