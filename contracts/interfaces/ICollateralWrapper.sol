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
     * @param tokenId Wrapped collateral token id
     * @param context Implementation-specific context
     * @return token Token address
     * @return tokenIds List of unique token ids
     */
    function enumerate(
        uint256 tokenId,
        bytes calldata context
    ) external view returns (address token, uint256[] memory tokenIds);

    /**
     * @notice Get total token count represented by wrapped collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     * @return tokenCount Total token count
     */
    function count(uint256 tokenId, bytes calldata context) external view returns (uint256 tokenCount);

    /**
     * Unwrap collateral
     * @param tokenId Collateral wrapper token ID
     * @param context Implementation-specific context
     */
    function unwrap(uint256 tokenId, bytes calldata context) external;

    /**
     * @notice Validate loan terms for wrapped collateral
     * @param principal Loan principal
     * @param repayment Loan repayment
     * @param duration Loan duration
     * @param tokenId Wrapped collateral token id
     * @param context Implementation-specific context
     */
    function validate(
        uint256 principal,
        uint256 repayment,
        uint64 duration,
        uint256 tokenId,
        bytes calldata context
    ) external view;
}
