// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title Interface to a Collateral Liquidator
 */
interface ICollateralLiquidator is IERC721Receiver {
    /**
     * Get collateral liquidator name
     * @return Collateral liquidator name
     */
    function name() external view returns (string memory);
}
