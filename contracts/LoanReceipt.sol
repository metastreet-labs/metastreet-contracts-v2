// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "./interfaces/ILoanAdapter.sol";
import "./interfaces/ILiquidity.sol";

/**
 * @title LoanReceipt
 * @author MetaStreet Labs
 */
library LoanReceipt {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid receipt encoding
     */
    error InvalidReceiptEncoding();

    /**
     * @notice Unsupported receipt version
     */
    error UnsupportedReceiptVersion();

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice LoanReceiptV1 version
     */
    uint8 internal constant LOAN_RECEIPT_V1_VERSION = 1;

    /**
     * @notice LoanReceiptV1 header size in bytes
     * @dev Header excludes borrow options byte array
     */
    uint256 internal constant LOAN_RECEIPT_V1_HEADER_SIZE = 155;

    /**
     * @notice LoanReceiptV1 payload element size in bytes
     */
    uint256 internal constant LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE = 48;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice LoanReceiptV1
     * @param version Version (1)
     * @param principal Principal amount in currency tokens
     * @param repayment Repayment amount in currency tokens
     * @param borrower Borrower
     * @param maturity Loan maturity timestamp
     * @param duration Loan duration
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param collateralContextLength Collateral context length
     * @param collateralContextData Collateral context data
     * @param nodeReceipts Node receipts
     */
    struct LoanReceiptV1 {
        uint8 version;
        uint256 principal;
        uint256 repayment;
        address borrower;
        uint64 maturity;
        uint64 duration;
        address collateralToken;
        uint256 collateralTokenId;
        uint16 collateralContextLength;
        bytes collateralContextData;
        NodeReceipt[] nodeReceipts;
    }

    /**
     * @notice Node receipt
     * @param depth Depth
     * @param used Used amount
     * @param pending Pending amount
     */
    struct NodeReceipt {
        uint128 depth;
        uint128 used;
        uint128 pending;
    }

    /**************************************************************************/
    /* Tightly packed format */
    /**************************************************************************/

    /*
      Header (153 bytes)
          1   uint8   version                 0:1
          32  uint256 principal               1:33
          32  uint256 repayment               33:65
          20  address borrower                65:85
          8   uint64  maturity                85:93
          8   uint64  duration                93:101
          20  address collateralToken         101:121
          32  uint256 collateralTokenId       121:153
          2   uint16  collateralContextLength 153:155
          -- borrowOptions byte array --      155:___   

      Node Receipts (48 * N bytes)
          N   NodeReceipts[] nodeReceipts
              16  uint128 depth
              16  uint128 used
              16  uint128 pending
    */

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @dev Compute loan receipt hash
     * @param encodedReceipt Encoded loan receipt
     * @return Loan Receipt hash
     */
    function hash(bytes memory encodedReceipt) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded loan receipt */
        return keccak256(bytes.concat(abi.encodePacked(block.chainid), encodedReceipt));
    }

    /**
     * @dev Encode a loan receipt into bytes
     * @param receipt Loan Receipt
     * @return Encoded loan receipt
     */
    function encode(LoanReceiptV1 memory receipt) internal pure returns (bytes memory) {
        /* Encode header */
        bytes memory encodedReceipt = abi.encodePacked(
            receipt.version,
            receipt.principal,
            receipt.repayment,
            receipt.borrower,
            receipt.maturity,
            receipt.duration,
            receipt.collateralToken,
            receipt.collateralTokenId,
            receipt.collateralContextLength,
            receipt.collateralContextData
        );

        /* Encode node receipts */
        for (uint256 i; i < receipt.nodeReceipts.length; i++) {
            encodedReceipt = bytes.concat(
                encodedReceipt,
                abi.encodePacked(
                    receipt.nodeReceipts[i].depth,
                    receipt.nodeReceipts[i].used,
                    receipt.nodeReceipts[i].pending
                )
            );
        }

        return encodedReceipt;
    }

    /**
     * @dev Decode a loan receipt from bytes
     * @param encodedReceipt Encoded loan Receipt
     * @return Decoded loan receipt
     */
    function decode(bytes calldata encodedReceipt) internal pure returns (LoanReceiptV1 memory) {
        /* Validate encoded receipt length */
        if (encodedReceipt.length < LOAN_RECEIPT_V1_HEADER_SIZE) revert InvalidReceiptEncoding();

        uint16 collateralContextLength = uint16(bytes2(encodedReceipt[153:155]));

        if (encodedReceipt.length < LOAN_RECEIPT_V1_HEADER_SIZE + collateralContextLength)
            revert InvalidReceiptEncoding();

        if (
            (encodedReceipt.length - LOAN_RECEIPT_V1_HEADER_SIZE - collateralContextLength) %
                LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE !=
            0
        ) revert InvalidReceiptEncoding();

        /* Validate encoded receipt version */
        if (uint8(encodedReceipt[0]) != LOAN_RECEIPT_V1_VERSION) revert UnsupportedReceiptVersion();

        LoanReceiptV1 memory receipt;

        /* Decode header */
        receipt.version = uint8(encodedReceipt[0]);
        receipt.principal = uint256(bytes32(encodedReceipt[1:33]));
        receipt.repayment = uint256(bytes32(encodedReceipt[33:65]));
        receipt.borrower = address(uint160(bytes20(encodedReceipt[65:85])));
        receipt.maturity = uint64(bytes8(encodedReceipt[85:93]));
        receipt.duration = uint64(bytes8(encodedReceipt[93:101]));
        receipt.collateralToken = address(uint160(bytes20(encodedReceipt[101:121])));
        receipt.collateralTokenId = uint256(bytes32(encodedReceipt[121:153]));
        receipt.collateralContextLength = uint16(bytes2(encodedReceipt[153:155]));
        receipt.collateralContextData = encodedReceipt[155:155 + receipt.collateralContextLength];

        /* Decode node receipts */
        uint256 numNodeReceipts = (encodedReceipt.length -
            LOAN_RECEIPT_V1_HEADER_SIZE -
            receipt.collateralContextLength) / LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
        receipt.nodeReceipts = new NodeReceipt[](numNodeReceipts);
        for (uint256 i; i < numNodeReceipts; i++) {
            uint256 offset = LOAN_RECEIPT_V1_HEADER_SIZE +
                receipt.collateralContextLength +
                i *
                LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
            receipt.nodeReceipts[i].depth = uint128(bytes16(encodedReceipt[offset:offset + 16]));
            receipt.nodeReceipts[i].used = uint128(bytes16(encodedReceipt[offset + 16:offset + 32]));
            receipt.nodeReceipts[i].pending = uint128(bytes16(encodedReceipt[offset + 32:offset + 48]));
        }

        return receipt;
    }
}
