// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface ICryptoPunks721 is IERC721 {
    function wrapPunk(uint256 punkIndex) external;

    function wrapPunkBatch(uint256[] calldata punkIndexes) external;

    function unwrapPunk(uint256 punkIndex) external;

    function unwrapPunkBatch(uint256[] calldata punkIndexes) external;

    function punkProxyForUser(address user) external view returns (address);

    function tokensOfOwner(address owner) external view returns (uint256[] memory);

    function totalSupply() external returns (uint256);
}
