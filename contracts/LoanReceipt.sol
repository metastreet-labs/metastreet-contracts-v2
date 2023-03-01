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
     */
    uint256 internal constant LOAN_RECEIPT_V1_HEADER_SIZE = 205;

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
     * @param platform Note token or lending platform
     * @param loanId Loan ID
     * @param borrower Borrower
     * @param maturity Loan maturity timestamp
     * @param duration Loan duration
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param nodeReceipts Node receipts
     */
    struct LoanReceiptV1 {
        uint8 version;
        address platform;
        uint256 loanId;
        uint256 principal;
        uint256 repayment;
        address borrower;
        uint64 maturity;
        uint64 duration;
        address collateralToken;
        uint256 collateralTokenId;
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
      Header (205 bytes)
          1   uint8   version               0:1
          20  address platform              1:21
          32  uint256 loanId                21:53
          32  uint256 principal             53:85
          32  uint256 repayment             85:117
          20  address borrower              117:137
          8   uint64  maturity              137:145
          8   uint64  duration              145:153
          20  address collateralToken       153:173
          32  uint256 collateralTokenId     173:205

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
            receipt.platform,
            receipt.loanId,
            receipt.principal,
            receipt.repayment,
            receipt.borrower,
            receipt.maturity,
            receipt.duration,
            receipt.collateralToken,
            receipt.collateralTokenId
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
        if ((encodedReceipt.length - LOAN_RECEIPT_V1_HEADER_SIZE) % LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE != 0)
            revert InvalidReceiptEncoding();
        /* Validate encoded receipt version */
        if (uint8(encodedReceipt[0]) != LOAN_RECEIPT_V1_VERSION) revert UnsupportedReceiptVersion();

        LoanReceiptV1 memory receipt;

        /* Decode header */
        receipt.version = uint8(encodedReceipt[0]);
        receipt.platform = address(uint160(bytes20(encodedReceipt[1:21])));
        receipt.loanId = uint256(bytes32(encodedReceipt[21:53]));
        receipt.principal = uint256(bytes32(encodedReceipt[53:85]));
        receipt.repayment = uint256(bytes32(encodedReceipt[85:117]));
        receipt.borrower = address(uint160(bytes20(encodedReceipt[117:137])));
        receipt.maturity = uint64(bytes8(encodedReceipt[137:145]));
        receipt.duration = uint64(bytes8(encodedReceipt[145:153]));
        receipt.collateralToken = address(uint160(bytes20(encodedReceipt[153:173])));
        receipt.collateralTokenId = uint256(bytes32(encodedReceipt[173:205]));

        /* Decode node receipts */
        uint256 numNodeReceipts = (encodedReceipt.length - LOAN_RECEIPT_V1_HEADER_SIZE) /
            LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
        receipt.nodeReceipts = new NodeReceipt[](numNodeReceipts);
        for (uint256 i; i < numNodeReceipts; i++) {
            uint256 offset = LOAN_RECEIPT_V1_HEADER_SIZE + i * LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
            receipt.nodeReceipts[i].depth = uint128(bytes16(encodedReceipt[offset:offset + 16]));
            receipt.nodeReceipts[i].used = uint128(bytes16(encodedReceipt[offset + 16:offset + 32]));
            receipt.nodeReceipts[i].pending = uint128(bytes16(encodedReceipt[offset + 32:offset + 48]));
        }

        return receipt;
    }

    /**
     * @dev Build a loan receipt from loan info and node receipts
     * @param platform Note token or lending platform address
     * @param loanInfo Loan info
     * @param nodeReceipts Node receipts
     * @return Loan receipt
     */
    function fromLoanInfo(
        address platform,
        ILoanAdapter.LoanInfo memory loanInfo,
        NodeReceipt[] memory nodeReceipts
    ) internal pure returns (LoanReceiptV1 memory) {
        LoanReceiptV1 memory receipt = LoanReceiptV1({
            version: 1,
            platform: platform,
            loanId: loanInfo.loanId,
            borrower: loanInfo.borrower,
            principal: loanInfo.principal,
            repayment: loanInfo.repayment,
            maturity: loanInfo.maturity,
            duration: loanInfo.duration,
            collateralToken: loanInfo.collateralToken,
            collateralTokenId: loanInfo.collateralTokenId,
            nodeReceipts: new NodeReceipt[](nodeReceipts.length)
        });

        for (uint256 i = 0; i < nodeReceipts.length; i++) {
            receipt.nodeReceipts[i].depth = nodeReceipts[i].depth;
            receipt.nodeReceipts[i].used = nodeReceipts[i].used;
            receipt.nodeReceipts[i].pending = nodeReceipts[i].pending;
        }

        return receipt;
    }
}
