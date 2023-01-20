// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "./interfaces/ILoanAdapter.sol";
import "./interfaces/ILiquidityManager.sol";

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
    uint256 internal constant LOAN_RECEIPT_V1_HEADER_SIZE = 141;

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
     * @param liquidityTrail Liquidity trail
     */
    struct LoanReceiptV1 {
        uint8 version;
        address platform;
        uint256 loanId;
        address borrower;
        uint64 maturity;
        uint64 duration;
        address collateralToken;
        uint256 collateralTokenId;
        ILiquidityManager.LiquiditySource[] liquidityTrail;
    }

    /**************************************************************************/
    /* Tightly packed format */
    /**************************************************************************/

    /*
      Header (141 bytes)
          1   uint8   version               0:1
          20  address platform              1:21
          32  uint256 loanId                21:53
          20  address borrower              53:73
          8   uint64  maturity              73:81
          8   uint64  duration              81:89
          20  address collateralToken       89:109
          32  uint256 collateralTokenId     109:141

      Liquidity Trail (48 * N bytes)
          N   LiquiditySource[] liquidityTrail
              16  uint128 depth
              16  uint128 amount
              16  uint128 pending
    */

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @dev Compute loan receipt hash
     * @param receipt Loan Receipt
     * @return Loan Receipt hash
     */
    function hash(LoanReceiptV1 memory receipt) internal view returns (bytes32) {
        /* Take hash of chain ID (32 bytes) concatenated with encoded loan receipt */
        return keccak256(bytes.concat(abi.encodePacked(block.chainid), LoanReceipt.encode(receipt)));
    }

    /**
     * @dev Compute loan receipt hash
     * @param encodedReceipt Encoded loan receipt
     * @return Loan Receipt hash
     */
    function hash(bytes calldata encodedReceipt) internal view returns (bytes32) {
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
            receipt.borrower,
            receipt.maturity,
            receipt.duration,
            receipt.collateralToken,
            receipt.collateralTokenId
        );

        /* Encode liquidity trail */
        for (uint256 i; i < receipt.liquidityTrail.length; i++) {
            encodedReceipt = bytes.concat(
                encodedReceipt,
                abi.encodePacked(
                    receipt.liquidityTrail[i].depth,
                    receipt.liquidityTrail[i].used,
                    receipt.liquidityTrail[i].pending
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
        receipt.borrower = address(uint160(bytes20(encodedReceipt[53:73])));
        receipt.maturity = uint64(bytes8(encodedReceipt[73:81]));
        receipt.duration = uint64(bytes8(encodedReceipt[81:89]));
        receipt.collateralToken = address(uint160(bytes20(encodedReceipt[89:109])));
        receipt.collateralTokenId = uint256(bytes32(encodedReceipt[109:141]));

        /* Decode liquidity trail */
        uint256 numLiquiditySources = (encodedReceipt.length - LOAN_RECEIPT_V1_HEADER_SIZE) /
            LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
        receipt.liquidityTrail = new ILiquidityManager.LiquiditySource[](numLiquiditySources);
        for (uint256 i; i < numLiquiditySources; i++) {
            uint256 offset = LOAN_RECEIPT_V1_HEADER_SIZE + i * LOAN_RECEIPT_V1_PAYLOAD_ELEMENT_SIZE;
            receipt.liquidityTrail[i].depth = uint128(bytes16(encodedReceipt[offset:offset + 16]));
            receipt.liquidityTrail[i].used = uint128(bytes16(encodedReceipt[offset + 16:offset + 32]));
            receipt.liquidityTrail[i].pending = uint128(bytes16(encodedReceipt[offset + 32:offset + 48]));
        }

        return receipt;
    }

    /**
     * @dev Build a loan receipt from loan info and liquidity trail
     * @param platform Note token or lending platform address
     * @param loanInfo Loan info
     * @param trail Liquidity trail
     * @return Loan receipt
     */
    function fromLoanInfo(
        address platform,
        ILoanAdapter.LoanInfo memory loanInfo,
        ILiquidityManager.LiquiditySource[] memory trail
    ) internal pure returns (LoanReceiptV1 memory) {
        LoanReceiptV1 memory receipt = LoanReceiptV1({
            version: 1,
            platform: platform,
            loanId: loanInfo.loanId,
            borrower: loanInfo.borrower,
            maturity: loanInfo.maturity,
            duration: loanInfo.duration,
            collateralToken: loanInfo.collateralToken,
            collateralTokenId: loanInfo.collateralTokenId,
            liquidityTrail: new ILiquidityManager.LiquiditySource[](trail.length)
        });

        for (uint256 i = 0; i < trail.length; i++) {
            receipt.liquidityTrail[i].depth = trail[i].depth;
            receipt.liquidityTrail[i].used = trail[i].used;
            receipt.liquidityTrail[i].pending = trail[i].pending;
        }

        return receipt;
    }
}
