// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../interfaces/IPriceOracle.sol";

/**
 * @title Reservoir Price Oracle
 * @author MetaStreet Labs
 */
contract ReservoirPriceOracle is IPriceOracle {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid message ID
     */
    error InvalidMessageId();

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
     * @notice Invalid currency
     */
    error InvalidCurrency();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Message
     * @param ID ID corresponding to the collection (using EIP-712 structured-data hashing)
     * @param payload Payload
     * @param timestamp The UNIX timestamp when the message was signed by the oracle
     * @param signature ECDSA signature or EIP-2098 compact signature
     */
    struct Message {
        bytes32 id;
        bytes payload;
        uint256 timestamp;
        bytes signature;
    }

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Reservoir price oracle signer
     */
    address private constant PRICE_ORACLE_SIGNER = 0xAeB1D03929bF87F69888f381e73FBf75753d75AF;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Max message age
     */
    uint256 internal immutable _maxMessageAge;

    /**
     * @notice Price kind
     */
    uint8 internal immutable _priceKind;

    /**
     * @notice TWAP seconds
     */
    uint256 internal immutable _twapSeconds;

    /**
     * @notice Only use data from non-flagged tokens
     */
    bool internal immutable _onlyNonFlaggedTokens;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Reservoir Price Oracle constructor
     * @param maxMessageAge_ Max message age
     * @param priceKind_ Price kind
     * @param twapSeconds_ Twap seconds
     * @param onlyNonFlaggedTokens_ Only non-flagged tokens
     */
    constructor(uint256 maxMessageAge_, uint8 priceKind_, uint256 twapSeconds_, bool onlyNonFlaggedTokens_) {
        _maxMessageAge = maxMessageAge_;
        _priceKind = priceKind_;
        _twapSeconds = twapSeconds_;
        _onlyNonFlaggedTokens = onlyNonFlaggedTokens_;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Compute message ID for collection
     * @param collateralToken Collateral token
     * @return Message ID
     */
    function _messageId(address collateralToken) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "ContractWideCollectionPrice(uint8 kind,uint256 twapSeconds,address contract,bool onlyNonFlaggedTokens)"
                    ),
                    _priceKind,
                    _twapSeconds,
                    collateralToken,
                    _onlyNonFlaggedTokens
                )
            );
    }

    /**
     * @notice Verify message
     * @dev Modified from
     * https://github.com/reservoirprotocol/oracle/blob/629d8101acaf1bcac3485f6dd63a474c828614ea/contracts/ReservoirOracle.sol
     */
    function _verifyMessage(address collateralToken, Message memory message) internal view virtual {
        /* Ensure the message matches the requested ID */
        if (_messageId(collateralToken) != message.id) revert InvalidMessageId();

        /* Ensure the message timestamp is valid */
        if (message.timestamp > block.timestamp || message.timestamp + _maxMessageAge < block.timestamp)
            revert InvalidTimestamp();

        bytes32 r;
        bytes32 s;
        uint8 v;

        /* Extract the individual signature fields from the signature */
        bytes memory signature = message.signature;
        if (signature.length == 64) {
            /* EIP-2098 compact signature */
            bytes32 vs;
            assembly {
                r := mload(add(signature, 0x20))
                vs := mload(add(signature, 0x40))
                s := and(vs, 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
                v := add(shr(255, vs), 27)
            }
        } else if (signature.length == 65) {
            /* ECDSA signature */
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
        } else {
            revert InvalidSignature();
        }

        address signerAddress = ecrecover(
            keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n32",
                    /* EIP-712 structured-data hash */
                    keccak256(
                        abi.encode(
                            keccak256("Message(bytes32 id,bytes payload,uint256 timestamp,uint256 chainId)"),
                            message.id,
                            keccak256(message.payload),
                            message.timestamp,
                            block.chainid
                        )
                    )
                )
            ),
            v,
            r,
            s
        );

        /* Ensure the signer matches the designated oracle address */
        if (signerAddress != PRICE_ORACLE_SIGNER) revert InvalidSigner();
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get price oracle implementation version
     * @return Price oracle implementation version
     */
    function IMPLEMENTATION_VERSION() external pure returns (string memory) {
        return "1.0";
    }

    /**
     * @notice Get reservoir API version
     * @return Reservoir API version
     */
    function RESERVOIR_API_VERSION() external pure returns (string memory) {
        return "v6";
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
        uint256[] memory,
        uint256[] memory,
        bytes calldata oracleContext
    ) external view override returns (uint256) {
        /* Decode oracle context into Message */
        Message memory message = abi.decode(oracleContext, (Message));

        /* Validate message id, timestamp, and signer address */
        _verifyMessage(collateralToken, message);

        (address oracleCurrency, uint256 oraclePrice) = abi.decode(message.payload, (address, uint256));

        /* Validate message currency is pool currency */
        if (oracleCurrency != currencyToken) revert InvalidCurrency();

        return oraclePrice;
    }
}
