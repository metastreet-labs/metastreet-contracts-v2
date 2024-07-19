// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "../../Pool.sol";

contract TestMaliciousERC20 {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* State */
    /**************************************************************************/
    /**
     * @notice MetaStreet V2 Pool
     */
    Pool internal _pool;

    /**
     * @notice Deposit tick
     */
    uint128 internal _tick;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address pool_, uint128 tick_) {
        _pool = Pool(pool_);
        _tick = tick_;
    }

    /**************************************************************************/
    /* IERC20 API */
    /**************************************************************************/

    function transfer(address to, uint256 value) public returns (bool) {
        _pool.transfer(msg.sender, to, _tick, value);

        return true;
    }
}
