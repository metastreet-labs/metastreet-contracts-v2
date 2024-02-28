// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.19;

/**
 * @title IYieldHub
 * @dev Subset of full interface
 */
interface IYieldHub {
    struct YieldToken {
        uint8 stake;
        uint8 issuanceType; // mint/transfer
        uint32 tokenType; // erc20/erc1155
        uint256 tokenId;
        uint256 start;
        uint256 end;
        uint256 rate;
    }

    function yieldTokens(address _token) external returns (YieldToken memory);

    function getTokenReward(address _token) external;

    function getTotalClaimable(address _user, address _token) external view returns (uint256);
}
