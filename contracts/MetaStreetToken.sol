// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./Pool.sol";

/**
 * @title MetaStreet Token
 * @author MetaStreet Labs
 */

contract MetaStreetToken is IERC20 {
    using Tick for uint128;

    /**************************************************************************/
    /* Errors*/
    /**************************************************************************/

    /**
     * @dev Indicates an error related to the current `balance` of a `sender`. Used in transfers.
     * @param sender Address whose tokens are being transferred.
     * @param balance Current balance for the interacting account.
     * @param needed Minimum amount required to perform a transfer.
     */
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);

    /**
     * @dev Indicates a failure with the `spender`’s `allowance`. Used in transfers.
     * @param spender Address that may be allowed to operate on tokens without being their owner.
     * @param allowance Amount of tokens a `spender` is allowed to operate with.
     * @param needed Minimum amount required to perform a transfer.
     */
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    /**
     * @dev Indicates a failure with the token `sender`. Used in transfers.
     * @param sender Address whose tokens are being transferred.
     */
    error ERC20InvalidSpender(address sender);

    /**
     * @dev Indicates a failure with the `approver` of a token to be approved. Used in approvals.
     * @param approver Address initiating an approval operation.
     */
    error ERC20InvalidApprover(address approver);

    /**
     * @dev Indicates a failure with the token `sender`. Used in transfers.
     * @param sender Address whose tokens are being transferred.
     */
    error ERC20InvalidSender(address sender);

    /**
     * @dev Indicates a failure with the token `receiver`. Used in transfers.
     * @param receiver Address to which tokens are being transferred.
     */
    error ERC20InvalidReceiver(address receiver);

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

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
     * @notice Currency token
     */
    IERC20 internal _currencyToken;

    /**
     * @notice Owner => operator => allowance
     */
    mapping(address => mapping(address => uint256)) private _allowances;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     */
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");
        _initialized = true;

        /* Decode parameters */
        uint128 tick_ = abi.decode(params, (uint128));

        _pool = Pool(msg.sender);
        _tick = tick_;
        _currencyToken = IERC20(Pool(msg.sender).currencyToken());
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function to get rounded loan limit for name() and symbol()
     *
     * @dev Solely utilized to generate rounded number in name() and symbol() getters.
     *      Loan limits > 1 ETH are rounded to the nearest whole number. Under 1 ETH
     *      are rounded to the nearest hundredth place.
     *
     * @return Loan limit as string
     */
    function _getLoanLimit(uint256 loanLimit_) internal pure returns (string memory) {
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
     * @notice Token name
     */
    function name() public view returns (string memory) {
        (uint256 limit_, , , ) = _tick.decode();

        return
            string.concat(
                "MetaStreet V2 Deposit: ",
                ERC721(_pool.collateralToken()).symbol(),
                "-",
                _getLoanLimit(limit_),
                ":",
                ERC20(_pool.currencyToken()).symbol()
            );
    }

    /**
     * @notice Token symbol
     */
    function symbol() public view returns (string memory) {
        (uint256 limit_, , , ) = _tick.decode();
        return string.concat("mst-", ERC721(_pool.collateralToken()).symbol(), "-", _getLoanLimit(limit_));
    }

    /**
     * @notice Token decimals
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @notice Pool
     */
    function pool() external view returns (Pool) {
        return _pool;
    }

    /**
     * @notice Tick
     */
    function tick() external view returns (uint128) {
        return _tick;
    }

    /**
     * @notice Tick loan limit
     */
    function limit() external view returns (uint128) {
        (uint256 limit_, , , ) = _tick.decode();
        return uint128(limit_);
    }

    /**
     * @notice Tick duration
     */
    function duration() external view returns (uint64) {
        (, uint256 durationIndex, , ) = _tick.decode();
        return _pool.durations()[durationIndex];
    }

    /**
     * @notice Tick rate
     */
    function rate() external view returns (uint64) {
        (, , uint256 rateIndex, ) = _tick.decode();
        return _pool.rates()[rateIndex];
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function to spend allowance
     * @param owner Account owner
     * @param spender Account spender
     * @param value Amount to spend
     */
    function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _approve(owner, spender, currentAllowance - value);
            }
        }
    }

    /**
     * @notice Helper function to approve allowance
     *
     * @param owner Account owner
     * @param spender Account spender
     * @param value Amount to approve
     */
    function _approve(address owner, address spender, uint256 value) internal virtual {
        if (owner == address(0)) {
            revert ERC20InvalidApprover(address(0));
        }
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[owner][spender] = value;

        emit Approval(owner, spender, value);
    }

    /**
     * @notice Helper function to validate transfer
     * @param from From
     * @param to To
     * @param value Value
     */
    function _validateTransfer(address from, address to, uint256 value) internal view {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }

        if (from != address(0)) {
            uint256 fromBalance = balanceOf(from);

            if (fromBalance < value) {
                revert ERC20InsufficientBalance(from, fromBalance, value);
            }
        }
    }

    /**************************************************************************/
    /* IERC20 API */
    /**************************************************************************/

    /**
     * @inheritdoc IERC20
     */
    function totalSupply() public view returns (uint256) {
        return _pool.totalSupply(_tick);
    }

    /**
     * @inheritdoc IERC20
     */
    function balanceOf(address account) public view returns (uint256) {
        return _pool.balanceOf(account, _tick);
    }

    /**
     * @inheritdoc IERC20
     */
    function transfer(address to, uint256 value) public returns (bool) {
        _validateTransfer(msg.sender, to, value);
        _pool.transfer(msg.sender, to, _tick, value);

        emit Transfer(msg.sender, to, value);

        return true;
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
    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        _validateTransfer(from, to, value);
        _spendAllowance(from, msg.sender, value);
        _pool.transfer(from, to, _tick, value);

        emit Transfer(from, to, value);

        return true;
    }
}
