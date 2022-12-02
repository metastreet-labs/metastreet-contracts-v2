// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title Interface to a LiquidationStrategy
 */
interface ILiquidationStrategy is IERC721Receiver {
    function name() external view returns (string memory);
}
