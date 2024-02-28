// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title IKongz
 * @dev Subset of full interface
 */
interface IKongz is IERC721 {
    function balanceOG(address _user) external view returns (uint256);
}
