// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import "../interfaces/IPriceOracle.sol";

/**
 * @title Simple Signed Price Oracle
 * @author MetaStreet Labs
 */
contract SimpleSignedPriceOracle is Ownable2Step, EIP712, IPriceOracle {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Quote EIP-712 typehash
     */
    bytes32 public constant QUOTE_TYPEHASH =
        keccak256(
            "Quote(address token,uint256 tokenId,address currency,uint256 price,uint64 timestamp,uint64 duration)"
        );

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid fee rate
     */
    error InvalidFeeRate();

    /**
     * @notice Invalid quote
     */
    error InvalidQuote();

    /**
     * @notice Invalid timestamp
     */
    error InvalidTimestamp();

    /**
     * @notice Invalid signature
     */
    error InvalidSignature();

    /**
     * @notice Invalid signer
     */
    error InvalidSigner();

    /**
     * @notice Invalid length
     */
    error InvalidLength();

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when price oracle signer is set
     * @param collateralToken Collateral token
     * @param signer Signer
     */
    event SignerUpdated(address indexed collateralToken, address signer);

    /**
     * @notice Emitted when price oracle fee rate or fee recipient is updated
     * @param collateralToken Collateral token
     * @param feeRate Fee rate
     * @param feeRecipient Fee recipient
     */
    event FeeUpdated(address indexed collateralToken, uint256 feeRate, address feeRecipient);

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Quote
     * @param token Token
     * @param tokenId Token ID
     * @param currency Currency
     * @param price Price
     * @param timestamp Timestamp
     * @param duration Duration validity
     */
    struct Quote {
        address token;
        uint256 tokenId;
        address currency;
        uint256 price;
        uint64 timestamp;
        uint64 duration;
    }

    /**
     * @notice Quote with signature
     * @param quote Quote
     * @param signature ECDSA signature
     */
    struct SignedQuote {
        Quote quote;
        bytes signature;
    }

    /**
     * @notice Oracle information
     * @param signer Signer
     * @param feeRate Fee rate
     * @param feeRecipient Fee recipient
     */
    struct OracleInfo {
        address signer;
        uint256 feeRate;
        address feeRecipient;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Mapping of collection to price oracle information
     */
    mapping(address => OracleInfo) internal _priceOracle;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Simple Signed Price Oracle constructor
     * @param name_ Domain separator name
     */
    constructor(string memory name_) EIP712(name_, IMPLEMENTATION_VERSION()) {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     */
    function initialize() external {
        require(!_initialized, "Already initialized");

        _initialized = true;

        _transferOwnership(msg.sender);
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Verify quote and signer
     * @param signer Signer
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param poolCurrency Pool currency
     * @param signedQuote Signed quote
     */
    function _verifyQuote(
        address signer,
        address collateralToken,
        uint256 collateralTokenId,
        address poolCurrency,
        SignedQuote memory signedQuote
    ) internal view {
        Quote memory quote = signedQuote.quote;

        /* Validate quote token, token ID, and currency */
        if (collateralToken != quote.token || collateralTokenId != quote.tokenId || poolCurrency != quote.currency)
            revert InvalidQuote();

        /* Validate quote price is non-zero */
        if (quote.price == 0) revert InvalidQuote();

        /* Validate quote timestamp */
        if (quote.timestamp > block.timestamp || quote.timestamp + quote.duration < block.timestamp)
            revert InvalidTimestamp();

        /* Recover quote signer */
        address signerAddress = ECDSA.recover(
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        QUOTE_TYPEHASH,
                        collateralToken,
                        collateralTokenId,
                        poolCurrency,
                        quote.price,
                        quote.timestamp,
                        quote.duration
                    )
                )
            ),
            signedQuote.signature
        );

        /* Validate signer */
        if (signerAddress != signer) revert InvalidSigner();
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get price oracle implementation version
     * @return Price oracle implementation version
     */
    function IMPLEMENTATION_VERSION() public pure returns (string memory) {
        return "1.2";
    }

    /**
     * @notice Get price oracle signer for collateral token
     * @param collateralToken Collateral token
     * @return Price oracle signer
     */
    function priceOracleSigner(address collateralToken) external view returns (address) {
        return _priceOracle[collateralToken].signer;
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @inheritdoc IPriceOracle
     */
    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory collateralTokenIds,
        uint256[] memory collateralTokenQuantities,
        bytes calldata oracleContext
    ) external view override returns (uint256, uint256, address) {
        /* Get oracle info */
        OracleInfo memory oracleInfo = _priceOracle[collateralToken];

        /* Decode oracle context into a SignedQuote array */
        SignedQuote[] memory signedQuotes = abi.decode(oracleContext, (SignedQuote[]));

        /* Validate arrays have equal lengths */
        if (signedQuotes.length != collateralTokenIds.length) revert InvalidLength();
        if (collateralTokenIds.length != collateralTokenQuantities.length) revert InvalidLength();

        /* Validate and aggregate oracle prices */
        uint256 totalOraclePrice;
        uint256 count;
        for (uint256 i; i < collateralTokenIds.length; i++) {
            /* Validate quote and signer */
            _verifyQuote(oracleInfo.signer, collateralToken, collateralTokenIds[i], currencyToken, signedQuotes[i]);

            /* Update total oracle price and collateral token count */
            totalOraclePrice += signedQuotes[i].quote.price * collateralTokenQuantities[i];
            count += collateralTokenQuantities[i];
        }

        /* Return average collateral token price, fee rate, and fee recipient */
        return (totalOraclePrice / count, oracleInfo.feeRate, oracleInfo.feeRecipient);
    }

    /**************************************************************************/
    /* Admin API */
    /**************************************************************************/

    /**
     * @notice Set price oracle signer for collateral token
     *
     * Emits a {SignerUpdated} event.
     *
     * @param collateralToken Collateral token
     * @param signer Signer
     */
    function setSigner(address collateralToken, address signer) external onlyOwner {
        _priceOracle[collateralToken].signer = signer;

        emit SignerUpdated(collateralToken, signer);
    }

    /**
     * @notice Set oracle fee rate
     *
     * Emits a {FeeRateUpdated} event.
     *
     * @param collateralToken Collateral token
     * @param feeRate Fee rate
     * @param feeRecipient Fee recipient
     */
    function setFeeRate(address collateralToken, uint256 feeRate, address feeRecipient) external {
        if (msg.sender != _priceOracle[collateralToken].signer) revert InvalidCaller();

        /* Validate fee rate */
        if (feeRate > BASIS_POINTS_SCALE) revert InvalidFeeRate();

        _priceOracle[collateralToken].feeRate = feeRate;
        _priceOracle[collateralToken].feeRecipient = feeRecipient;

        emit FeeUpdated(collateralToken, feeRate, feeRecipient);
    }
}
