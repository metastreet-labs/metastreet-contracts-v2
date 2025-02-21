// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

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
     * @notice Quote EIP-712 typehash V1
     */
    bytes32 public constant QUOTE_TYPEHASH_V1 =
        keccak256(
            "Quote(address token,uint256 tokenId,address currency,uint256 price,uint64 timestamp,uint64 duration)"
        );

    /**
     * @notice Quote EIP-712 typehash V2
     */
    bytes32 public constant QUOTE_TYPEHASH_V2 =
        keccak256(
            "QuoteV2(address token,uint256 startTokenId,uint256 endTokenId,address currency,uint256 price,uint64 timestamp,uint64 duration)"
        );

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Unsupported token
     */
    error UnsupportedToken();

    /**
     * @notice Invalid quote
     */
    error InvalidQuote();

    /**
     * @notice Matching quote not found
     */
    error QuoteNotFound();

    /**
     * @notice Invalid timestamp
     */
    error InvalidTimestamp();

    /**
     * @notice Invalid signer
     */
    error InvalidSigner();

    /**
     * @notice Invalid length
     */
    error InvalidLength();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when price oracle signer is set
     * @param collateralToken Collateral token
     * @param signer Signer
     * @param quoteType Quote type
     */
    event SignerUpdated(address indexed collateralToken, address signer, QuoteType quoteType);

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Quote type
     * @dev QuoteV1 is used for a single token ID
     * @dev QuoteV2 is used for a range of token IDs
     */
    enum QuoteType {
        QuoteV1,
        QuoteV2
    }

    /**
     * @notice Quote V1
     * @param token Token
     * @param tokenId Token ID
     * @param currency Currency
     * @param price Price
     * @param timestamp Timestamp
     * @param duration Duration validity
     */
    struct QuoteV1 {
        address token;
        uint256 tokenId;
        address currency;
        uint256 price;
        uint64 timestamp;
        uint64 duration;
    }

    /**
     * @notice Quote V2
     * @param token Token
     * @param startTokenId Start token ID
     * @param endTokenId End token ID
     * @param currency Currency
     * @param price Price
     * @param timestamp Timestamp
     * @param duration Duration validity
     */
    struct QuoteV2 {
        address token;
        uint256 startTokenId;
        uint256 endTokenId;
        address currency;
        uint256 price;
        uint64 timestamp;
        uint64 duration;
    }

    /**
     * @notice Quote with signature
     * @param quote Quote (V1)
     * @param signature ECDSA signature
     */
    struct SignedQuoteV1 {
        QuoteV1 quote;
        bytes signature;
    }

    /**
     * @notice Quote with signature
     * @param quote Quote (V2)
     * @param signature ECDSA signature
     */
    struct SignedQuoteV2 {
        QuoteV2 quote;
        bytes signature;
    }

    /**
     * @notice Price oracle signer
     * @param signer Signer
     * @param quoteType Quote type
     */
    struct PriceOracleSigner {
        address signer;
        QuoteType quoteType;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Mapping of collection to price oracle signers
     */
    mapping(address => PriceOracleSigner) internal _priceOracleSigners;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Simple Signed Price Oracle constructor
     * @param name_ Domain separator name
     */
    constructor(string memory name_) EIP712(name_, DOMAIN_VERSION()) {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     */
    function initialize(address owner) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _transferOwnership(owner);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get price oracle implementation version
     * @return Price oracle implementation version
     */
    function IMPLEMENTATION_VERSION() public pure returns (string memory) {
        return "1.4";
    }

    /**
     * @notice Get signing domain version
     * @return Signing domain version
     */
    function DOMAIN_VERSION() public pure returns (string memory) {
        return "1.2";
    }

    /**
     * @notice Get price oracle signer for collateral token
     * @param collateralToken Collateral token
     * @return Price oracle signer
     */
    function priceOracleSigner(address collateralToken) external view returns (PriceOracleSigner memory) {
        return _priceOracleSigners[collateralToken];
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Verify multiple quotes
     * @param collateralToken Collateral token
     * @param collateralTokenIds Collateral token IDs
     * @param collateralTokenQuantities Collateral token quantities
     * @param poolCurrency Pool currency
     * @param oracleContext Oracle context
     * @return Average oracle price
     */
    function _verifyQuoteV1(
        address collateralToken,
        uint256[] memory collateralTokenIds,
        uint256[] memory collateralTokenQuantities,
        address poolCurrency,
        bytes calldata oracleContext
    ) internal view returns (uint256) {
        /* Decode oracle context into a SignedQuoteV1 array */
        SignedQuoteV1[] memory signedQuotes = abi.decode(oracleContext, (SignedQuoteV1[]));

        /* Validate arrays have equal lengths */
        if (signedQuotes.length != collateralTokenIds.length) revert InvalidLength();

        /* Validate and aggregate oracle prices */
        uint256 totalOraclePrice;
        uint256 count;
        for (uint256 i; i < collateralTokenIds.length; i++) {
            QuoteV1 memory quote = signedQuotes[i].quote;

            /* Validate token ID and currency */
            if (
                collateralToken != quote.token ||
                collateralTokenIds[i] != quote.tokenId ||
                poolCurrency != quote.currency
            ) revert InvalidQuote();

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
                            QUOTE_TYPEHASH_V1,
                            collateralToken,
                            collateralTokenIds[i],
                            poolCurrency,
                            quote.price,
                            quote.timestamp,
                            quote.duration
                        )
                    )
                ),
                signedQuotes[i].signature
            );

            /* Validate signer */
            if (signerAddress != _priceOracleSigners[collateralToken].signer) revert InvalidSigner();

            /* Update total oracle price and collateral token count */
            totalOraclePrice += signedQuotes[i].quote.price * collateralTokenQuantities[i];
            count += collateralTokenQuantities[i];
        }

        return totalOraclePrice / count;
    }

    /**
     * @notice Verify multiple quotes (v2)
     * @param collateralToken Collateral token
     * @param collateralTokenIds Collateral token IDs
     * @param collateralTokenQuantities Collateral token quantities
     * @param poolCurrency Pool currency
     * @param oracleContext Oracle context
     * @return Average oracle price
     */
    function _verifyQuoteV2(
        address collateralToken,
        uint256[] memory collateralTokenIds,
        uint256[] memory collateralTokenQuantities,
        address poolCurrency,
        bytes calldata oracleContext
    ) internal view returns (uint256) {
        /* Decode oracle context into a SignedQuoteV2 */
        SignedQuoteV2[] memory signedQuotes = abi.decode(oracleContext, (SignedQuoteV2[]));

        /* Validate and aggregate oracle prices */
        uint256 totalOraclePrice;
        uint256 count;
        for (uint256 i; i < collateralTokenIds.length; i++) {
            /* Find quote for token ID */
            QuoteV2 memory quote;
            bytes memory signature;
            for (uint256 j; j < signedQuotes.length; j++) {
                /* Continue if token ID is outside quote range */
                if (
                    collateralTokenIds[i] < signedQuotes[j].quote.startTokenId ||
                    collateralTokenIds[i] > signedQuotes[j].quote.endTokenId
                ) continue;

                /* Set quote and signature */
                quote = signedQuotes[j].quote;
                signature = signedQuotes[j].signature;
                break;
            }

            /* Validate quote was found */
            if (signature.length == 0) revert QuoteNotFound();

            /* Validate token and currency */
            if (collateralToken != quote.token || poolCurrency != quote.currency) revert InvalidQuote();

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
                            QUOTE_TYPEHASH_V2,
                            collateralToken,
                            quote.startTokenId,
                            quote.endTokenId,
                            poolCurrency,
                            quote.price,
                            quote.timestamp,
                            quote.duration
                        )
                    )
                ),
                signature
            );

            /* Validate signer */
            if (signerAddress != _priceOracleSigners[collateralToken].signer) revert InvalidSigner();

            /* Update total oracle price and collateral token count */
            totalOraclePrice += quote.price * collateralTokenQuantities[i];
            count += collateralTokenQuantities[i];
        }

        return totalOraclePrice / count;
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
    ) external view override returns (uint256) {
        /* Validate array have equal lengths */
        if (collateralTokenIds.length != collateralTokenQuantities.length) revert InvalidLength();

        /* Validate price oracle signer is set */
        if (_priceOracleSigners[collateralToken].signer == address(0)) revert UnsupportedToken();

        return
            _priceOracleSigners[collateralToken].quoteType == QuoteType.QuoteV1
                ? _verifyQuoteV1(
                    collateralToken,
                    collateralTokenIds,
                    collateralTokenQuantities,
                    currencyToken,
                    oracleContext
                )
                : _verifyQuoteV2(
                    collateralToken,
                    collateralTokenIds,
                    collateralTokenQuantities,
                    currencyToken,
                    oracleContext
                );
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
     * @param quoteType Quote type
     */
    function setSigner(address collateralToken, address signer, QuoteType quoteType) external onlyOwner {
        _priceOracleSigners[collateralToken].signer = signer;
        _priceOracleSigners[collateralToken].quoteType = quoteType;

        emit SignerUpdated(collateralToken, signer, quoteType);
    }
}
