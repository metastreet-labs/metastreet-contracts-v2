// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import "@openzeppelin/contracts/interfaces/IERC721Metadata.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

import "../Pool.sol";
import "../interfaces/ILiquidity.sol";

/**
 * @title ERC20 Deposit Token Implementation
 * @author MetaStreet Labs
 */
contract ERC20DepositTokenImplementation is IERC20Metadata {
    using Tick for uint128;
    using SafeCast for uint256;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice ERC20 Errors from OpenZeppelin implementation:
     *         https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.0/contracts/interfaces/draft-IERC6093.sol
     */

    /**
     * @notice Insufficient balance
     *
     * @param sender Address whose tokens are being transferred.
     * @param balance Current balance for the interacting account.
     * @param needed Minimum amount required to perform a transfer.
     */
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);

    /**
     * @notice Insufficient allowance
     *
     * @param spender Address that may be allowed to operate on tokens without being their owner.
     * @param allowance Amount of tokens a `spender` is allowed to operate with.
     * @param needed Minimum amount required to perform a transfer.
     */
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    /**
     * @notice Invalid spender
     *
     * @param sender Address whose tokens are being transferred.
     */
    error ERC20InvalidSpender(address sender);

    /**
     * @notice Invalid Sender
     *
     * @param sender Address whose tokens are being transferred.
     */
    error ERC20InvalidSender(address sender);

    /**
     * @notice Invalid Receiver
     *
     * @param receiver Address to which tokens are being transferred.
     */
    error ERC20InvalidReceiver(address receiver);

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.1";

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool internal _initialized;

    /**
     * @notice MetaStreet V2 Pool
     */
    Pool internal _pool;

    /**
     * @notice Deposit tick
     */
    uint128 internal _tick;

    /**
     * @notice Owner => operator => allowance
     */
    mapping(address => mapping(address => uint256)) private _allowances;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice ERC20 Deposit Token Implementation constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");
        _initialized = true;

        /* Decode parameters */
        uint128 tick_ = abi.decode(params, (uint128));

        _pool = Pool(msg.sender);
        _tick = tick_;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function to get rounded loan limit for name() and symbol()
     *
     * @dev Solely utilized to generate rounded number in name() and symbol() getters.
     *      For absolute limit type, loan limits > 1 ETH are rounded to the nearest
     *      whole number. Under 1 ETH are rounded to the nearest hundredth place.
     *      For ratio limit type, loan limits are expressed as either a whole number
     *      percentage or as a 2 d.p percentage.
     *
     * @param loanLimit_ Loan limit as uint256
     *
     * @return Loan limit as string
     */
    function _getLoanLimit(Tick.LimitType limitType_, uint256 loanLimit_) internal pure returns (string memory) {
        /* If limit type is ratio, express loan limit as a percentage  */
        if (limitType_ == Tick.LimitType.Ratio) {
            /* Compute integer and decimals */
            string memory integer = Strings.toString(loanLimit_ / 100);
            uint256 decimals_ = loanLimit_ % 100;
            return
                decimals_ == 0
                    ? string.concat(integer, "%")
                    : string.concat(integer, ".", Strings.toString(decimals_), "%");
        }

        /* Handle loan limits > 1 ETH */
        if (loanLimit_ >= FIXED_POINT_SCALE) {
            return Strings.toString((loanLimit_ + (FIXED_POINT_SCALE / 2)) / FIXED_POINT_SCALE);
        } else {
            /* Handle loan limits < 1 ETH */
            uint256 scaledValue = loanLimit_ * 100;
            uint256 integer = scaledValue / FIXED_POINT_SCALE;
            if (scaledValue % FIXED_POINT_SCALE >= FIXED_POINT_SCALE / 2) {
                integer += 1;
            }
            uint256 hundredthPlaces = integer % 100;
            string memory decimalStr = hundredthPlaces < 10
                ? string.concat("0", Strings.toString(hundredthPlaces))
                : Strings.toString(hundredthPlaces);

            return string.concat("0.", decimalStr);
        }
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc IERC20Metadata
     */
    function name() public view returns (string memory) {
        (uint256 limit_, , , Tick.LimitType limitType_) = _tick.decode(Tick.BASIS_POINTS_SCALE);
        return
            string.concat(
                "MetaStreet V2 Deposit: ",
                IERC721Metadata(_pool.collateralToken()).symbol(),
                "-",
                IERC20Metadata(_pool.currencyToken()).symbol(),
                ":",
                _getLoanLimit(limitType_, limit_)
            );
    }

    /**
     * @inheritdoc IERC20Metadata
     */
    function symbol() public view returns (string memory) {
        (uint256 limit_, , , Tick.LimitType limitType_) = _tick.decode(Tick.BASIS_POINTS_SCALE);
        return
            string.concat(
                "m",
                IERC20Metadata(_pool.currencyToken()).symbol(),
                "-",
                IERC721Metadata(_pool.collateralToken()).symbol(),
                ":",
                _getLoanLimit(limitType_, limit_)
            );
    }

    /**
     * @inheritdoc IERC20Metadata
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @notice Pool
     * @return Pool address
     */
    function pool() external view returns (Pool) {
        return _pool;
    }

    /**
     * @notice Tick
     * @return Encoded tick
     */
    function tick() external view returns (uint128) {
        return _tick;
    }

    /**
     * @notice Tick loan limit
     * @return Loan limit in currency tokens
     */
    function limit() external view returns (uint128) {
        (uint256 limit_, , , ) = _tick.decode(Tick.BASIS_POINTS_SCALE);
        return limit_.toUint128();
    }

    /**
     * @notice Tick duration
     * @return Duration in seconds
     */
    function duration() external view returns (uint64) {
        (, uint256 durationIndex, , ) = _tick.decode(Tick.BASIS_POINTS_SCALE);
        return _pool.durations()[durationIndex];
    }

    /**
     * @notice Tick rate
     * @return Rate in interest per second
     */
    function rate() external view returns (uint64) {
        (, , uint256 rateIndex, ) = _tick.decode(Tick.BASIS_POINTS_SCALE);
        return _pool.rates()[rateIndex];
    }

    /**
     * @notice Currency token
     * @return Address of currency token
     */
    function currencyToken() external view returns (address) {
        return _pool.currencyToken();
    }

    /**
     * @notice Deposit share price
     * @return Deposit share price
     */
    function depositSharePrice() external view returns (uint256) {
        return _pool.depositSharePrice(_tick);
    }

    /**
     * @notice Redemption share price
     * @return Redemption share price
     */
    function redemptionSharePrice() external view returns (uint256) {
        return _pool.redemptionSharePrice(_tick);
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function to transfer tokens
     *
     * @param from From
     * @param to To
     * @param value Value
     */
    function _transfer(address from, address to, uint256 value) internal {
        /* No transfer to zero address */
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }

        /* Validate balance */
        uint256 fromBalance = balanceOf(from);
        if (fromBalance < value) {
            revert ERC20InsufficientBalance(from, fromBalance, value);
        }

        /* Call transfer on pool */
        _pool.transfer(from, to, _tick, value);

        emit Transfer(from, to, value);
    }

    /**************************************************************************/
    /* Hooks */
    /**************************************************************************/

    /**
     * @notice External transfer hook
     *
     * @param from From
     * @param to To
     * @param value Value
     */
    function onExternalTransfer(address from, address to, uint256 value) external {
        if (msg.sender != address(_pool)) revert InvalidCaller();

        emit Transfer(from, to, value);
    }

    /**************************************************************************/
    /* IERC20 API */
    /**************************************************************************/

    /**
     * @inheritdoc IERC20
     */
    function totalSupply() public view returns (uint256) {
        /* Get Pool node */
        ILiquidity.NodeInfo memory node = _pool.liquidityNode(_tick);

        /* Calculate total supply */
        return node.shares - node.redemptions;
    }

    /**
     * @inheritdoc IERC20
     */
    function balanceOf(address account) public view returns (uint256) {
        /* Get shares from deposits */
        (uint128 shares, ) = _pool.deposits(account, _tick);

        return shares;
    }

    /**
     * @inheritdoc IERC20
     */
    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @inheritdoc IERC20
     */
    function approve(address spender, uint256 value) public returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }

        _allowances[msg.sender][spender] = value;

        emit Approval(msg.sender, spender, value);

        return true;
    }

    /**
     * @inheritdoc IERC20
     */
    function transfer(address to, uint256 value) public returns (bool) {
        _transfer(msg.sender, to, value);

        return true;
    }

    /**
     * @inheritdoc IERC20
     */
    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        /* No transfer from zero address */
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }

        /* Check + update allowance */
        uint256 currentAllowance = allowance(from, msg.sender);
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(msg.sender, currentAllowance, value);
            }
            unchecked {
                _allowances[from][msg.sender] = currentAllowance - value;
            }
        }

        _transfer(from, to, value);

        return true;
    }
}
