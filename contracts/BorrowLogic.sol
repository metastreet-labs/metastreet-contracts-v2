// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./Pool.sol";
import "./LoanReceipt.sol";
import "./LiquidityLogic.sol";

import "./interfaces/IPool.sol";
import "./integrations/DelegateCash/IDelegateRegistryV1.sol";
import "./integrations/DelegateCash/IDelegateRegistryV2.sol";

/**
 * @title Borrow Logic
 * @author MetaStreet Labs
 */
library BorrowLogic {
    using SafeCast for uint256;
    using LiquidityLogic for LiquidityLogic.Liquidity;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Borrow options tag size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_TAG_SIZE = 2;

    /**
     * @notice Borrow options length size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_LENGTH_SIZE = 2;

    /**************************************************************************/
    /* Helpers */
    /**************************************************************************/

    /**
     * @notice Helper function to extract specified option tag from options
     * data
     *
     * @dev Options are encoded as:
     *   2 byte uint16 tag
     *   2 byte uint16 length
     *   n byte bytes  data
     * The first matching tag is returned.
     *
     * @param options Encoded options
     * @param tag Tag to find
     * @return Options data
     */
    function _getOptionsData(bytes calldata options, Pool.BorrowOptions tag) internal pure returns (bytes calldata) {
        /* Scan the options for the tag */
        for (uint256 offsetTag; offsetTag < options.length; ) {
            /* Compute offsets with for tag length and data */
            uint256 offsetLength = offsetTag + BORROW_OPTIONS_TAG_SIZE;
            uint256 offsetData = offsetTag + BORROW_OPTIONS_TAG_SIZE + BORROW_OPTIONS_LENGTH_SIZE;

            /* The tag is in the first 2 bytes of each options item */
            uint256 currentTag = uint16(bytes2(options[offsetTag:offsetLength]));

            /* The length of the options data is in the second 2 bytes of each options item, after the tag */
            uint256 dataLength = uint16(bytes2(options[offsetLength:offsetData]));

            /* Return the offset and length if the tag is found */
            if (currentTag == uint256(tag)) {
                return options[offsetData:offsetData + dataLength];
            }

            /* Increment to next options item */
            offsetTag = offsetData + dataLength;
        }

        /* Return empty slice if no tag is found */
        return options[0:0];
    }

    /**
     * @notice Helper function that calls delegate.cash registry to delegate token
     *
     * @param delegations Delegate storage
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param delegateRegistryV1 Delegate registry v1 address
     * @param delegateRegistryV2 Delegate registry v2 address
     * @param options Options data
     */
    function _optionDelegateCash(
        Pool.DelegateStorage storage delegations,
        address collateralToken,
        uint256 collateralTokenId,
        address delegateRegistryV1,
        address delegateRegistryV2,
        bytes calldata options
    ) external {
        /* Find delegate.cash v2 tagged data in options */
        bytes calldata delegateDataV2 = _getOptionsData(options, Pool.BorrowOptions.DelegateCashV2);

        if (delegateDataV2.length != 0) {
            if (delegateRegistryV2 == address(0)) revert IPool.InvalidBorrowOptions();
            if (delegateDataV2.length != 20) revert IPool.InvalidBorrowOptions();

            /* Store delegate in mapping */
            delegations.delegates[collateralToken][collateralTokenId] = Pool.Delegate({
                version: Pool.DelegateVersion.DelegateCashV2,
                to: address(uint160(bytes20(delegateDataV2)))
            });

            /* Delegate token */
            IDelegateRegistryV2(delegateRegistryV2).delegateERC721(
                address(uint160(bytes20(delegateDataV2))),
                collateralToken,
                collateralTokenId,
                "",
                true
            );

            /* Return if found, skip additional search */
            return;
        }

        /* Find delegate.cash v1 tagged data in options, if v2 data is empty */
        bytes calldata delegateDataV1 = _getOptionsData(options, Pool.BorrowOptions.DelegateCashV1);

        if (delegateDataV1.length != 0) {
            if (delegateRegistryV1 == address(0)) revert IPool.InvalidBorrowOptions();
            if (delegateDataV1.length != 20) revert IPool.InvalidBorrowOptions();

            /* Store delegate in mapping */
            delegations.delegates[collateralToken][collateralTokenId] = Pool.Delegate({
                version: Pool.DelegateVersion.DelegateCashV1,
                to: address(uint160(bytes20(delegateDataV1)))
            });

            /* Delegate token */
            IDelegateRegistryV1(delegateRegistryV1).delegateForToken(
                address(uint160(bytes20(delegateDataV1))),
                collateralToken,
                collateralTokenId,
                true
            );
        }
    }

    /**
     * @notice Helper function to revoke token delegate
     *
     * @param delegations Delegate storage
     * @param collateralToken Contract address of token that delegation is being removed from
     * @param collateralTokenId Token id of token that delegation is being removed from
     * @param delegateRegistryV1 Delegate registry v1 address
     * @param delegateRegistryV2 Delegate registry v2 address
     */
    function _revokeDelegates(
        Pool.DelegateStorage storage delegations,
        address collateralToken,
        uint256 collateralTokenId,
        address delegateRegistryV1,
        address delegateRegistryV2
    ) external {
        Pool.Delegate memory delegate = delegations.delegates[collateralToken][collateralTokenId];

        if (delegate.version == Pool.DelegateVersion.None) {
            return;
        } else if (delegate.version == Pool.DelegateVersion.DelegateCashV2) {
            IDelegateRegistryV2(delegateRegistryV2).delegateERC721(
                delegate.to,
                collateralToken,
                collateralTokenId,
                "",
                false
            );
        } else if (delegate.version == Pool.DelegateVersion.DelegateCashV1) {
            IDelegateRegistryV1(delegateRegistryV1).delegateForToken(
                delegate.to,
                collateralToken,
                collateralTokenId,
                false
            );
        }

        /* Remove delegate from mapping */
        delete delegations.delegates[collateralToken][collateralTokenId];
    }

    /**
     * @dev Helper function to calculated prorated repayment
     * @param loanReceipt Decoded loan receipt
     * @return repayment Repayment amount in currency tokens
     * @return adminFee Admin fee amount in currency tokens
     * @return proration Proration based on elapsed duration
     */
    function _prorateRepayment(
        LoanReceipt.LoanReceiptV2 memory loanReceipt
    ) internal view returns (uint256 repayment, uint256 adminFee, uint256 proration) {
        /* Minimum of proration and 1.0 */
        proration = Math.min(
            ((block.timestamp - (loanReceipt.maturity - loanReceipt.duration)) * LiquidityLogic.FIXED_POINT_SCALE) /
                loanReceipt.duration,
            LiquidityLogic.FIXED_POINT_SCALE
        );

        /* Compute prorated admin fee */
        adminFee = (loanReceipt.adminFee * proration) / LiquidityLogic.FIXED_POINT_SCALE;

        /* Compute repayment using prorated interest */
        repayment =
            loanReceipt.principal +
            (((loanReceipt.repayment - loanReceipt.principal) * proration) / LiquidityLogic.FIXED_POINT_SCALE);
    }

    /**
     * @dev Helper function to decode a loan receipt
     * @param loanReceipt Loan receipt
     * @return Decoded loan receipt
     */
    function _decodeLoanReceipt(bytes calldata loanReceipt) external pure returns (LoanReceipt.LoanReceiptV2 memory) {
        return LoanReceipt.decode(loanReceipt);
    }

    /**
     * @dev Helper function to handle borrow accounting
     * @param self Pool storage
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken Collateral token address
     * @param collateralTokenId Collateral token ID
     * @param repayment Repayment amount in currency tokens
     * @param maxRepayment Maximum repayment amount in currency tokens
     * @param adminFee Admin fee
     * @param nodes Liquidity nodes
     * @param count Liquidity nodes count
     * @param collateralWrapperContext Collateral wrapper context data
     * @return Encoded loan receipt, loan receipt hash
     */
    function _borrow(
        Pool.PoolStorage storage self,
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 repayment,
        uint256 maxRepayment,
        uint256 adminFee,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count,
        bytes memory collateralWrapperContext
    ) external returns (bytes memory, bytes32) {
        /* Validate principal is non-zero */
        if (principal == 0) revert IPool.InvalidParameters();

        /* Validate duration is non-zero */
        if (duration == 0) revert IPool.UnsupportedLoanDuration();

        /* Validate repayment */
        if (repayment > maxRepayment) revert IPool.RepaymentTooHigh();

        /* Build the loan receipt */
        LoanReceipt.LoanReceiptV2 memory receipt = LoanReceipt.LoanReceiptV2({
            version: 2,
            principal: principal,
            repayment: repayment,
            adminFee: adminFee,
            borrower: msg.sender,
            maturity: (block.timestamp + duration).toUint64(),
            duration: duration,
            collateralToken: collateralToken,
            collateralTokenId: collateralTokenId,
            collateralWrapperContextLen: collateralWrapperContext.length.toUint16(),
            collateralWrapperContext: collateralWrapperContext,
            nodeReceipts: new LoanReceipt.NodeReceipt[](count)
        });

        /* Use liquidity nodes */
        for (uint256 i; i < count; i++) {
            /* Use node */
            self.liquidity.use(nodes[i].tick, nodes[i].used, nodes[i].pending, duration);

            /* Construct node receipt */
            receipt.nodeReceipts[i] = LoanReceipt.NodeReceipt({
                tick: nodes[i].tick,
                used: nodes[i].used,
                pending: nodes[i].pending
            });
        }

        /* Encode and hash the loan receipt */
        bytes memory encodedLoanReceipt = LoanReceipt.encode(receipt);
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate no loan receipt hash collision */
        if (self.loans[loanReceiptHash] != Pool.LoanStatus.Uninitialized) revert IPool.InvalidLoanReceipt();

        /* Store loan status */
        self.loans[loanReceiptHash] = Pool.LoanStatus.Active;

        return (encodedLoanReceipt, loanReceiptHash);
    }

    /**
     * @dev Helper function to handle repay accounting
     * @param self Pool storage
     * @param feeShareStorage Fee share storage
     * @param encodedLoanReceipt Encoded loan receipt
     * @return Repayment amount in currency tokens, fee share amount in
     * currency tokens, decoded loan receipt, loan receipt hash
     */
    function _repay(
        Pool.PoolStorage storage self,
        Pool.FeeShareStorage storage feeShareStorage,
        bytes calldata encodedLoanReceipt
    ) external returns (uint256, uint256, LoanReceipt.LoanReceiptV2 memory, bytes32) {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan receipt */
        if (self.loans[loanReceiptHash] != Pool.LoanStatus.Active) revert IPool.InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV2 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Validate borrow and repay is not in same block */
        if (loanReceipt.maturity - loanReceipt.duration == block.timestamp) revert IPool.InvalidLoanReceipt();

        /* Validate caller is borrower */
        if (msg.sender != loanReceipt.borrower) revert IPool.InvalidCaller();

        /* Compute prorated repayment using prorated interest, prorated admin fee and proration */
        (uint256 repayment, uint256 adminFee, uint256 proration) = _prorateRepayment(loanReceipt);

        /* Compute elapsed time since loan origination */
        uint64 elapsed = uint64(block.timestamp + loanReceipt.duration - loanReceipt.maturity);

        /* Restore liquidity nodes */
        for (uint256 i; i < loanReceipt.nodeReceipts.length; i++) {
            /* Restore node */
            self.liquidity.restore(
                loanReceipt.nodeReceipts[i].tick,
                loanReceipt.nodeReceipts[i].used,
                loanReceipt.nodeReceipts[i].pending,
                loanReceipt.nodeReceipts[i].used +
                    uint128(
                        ((loanReceipt.nodeReceipts[i].pending - loanReceipt.nodeReceipts[i].used) * proration) /
                            LiquidityLogic.FIXED_POINT_SCALE
                    ),
                loanReceipt.duration,
                elapsed
            );
        }

        /* Compute fee share amount */
        uint256 feeShareAmount = (adminFee == 0)
            ? 0
            : (adminFee * feeShareStorage.split) / LiquidityLogic.BASIS_POINTS_SCALE;

        /* Update admin fee total balance with prorated admin fee less fee share */
        self.adminFeeBalance += adminFee - feeShareAmount;

        /* Mark loan status repaid */
        self.loans[loanReceiptHash] = Pool.LoanStatus.Repaid;

        return (repayment, feeShareAmount, loanReceipt, loanReceiptHash);
    }

    /**
     * @dev Helper function to handle liquidate accounting
     * @param self Pool storage
     * @param encodedLoanReceipt Encoded loan receipt
     * @return Decoded loan receipt, loan receipt hash
     */
    function _liquidate(
        Pool.PoolStorage storage self,
        bytes calldata encodedLoanReceipt
    ) external returns (LoanReceipt.LoanReceiptV2 memory, bytes32) {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active */
        if (self.loans[loanReceiptHash] != Pool.LoanStatus.Active) revert IPool.InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV2 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Validate loan is expired */
        if (block.timestamp <= loanReceipt.maturity) revert IPool.LoanNotExpired();

        /* Mark loan status liquidated */
        self.loans[loanReceiptHash] = Pool.LoanStatus.Liquidated;

        return (loanReceipt, loanReceiptHash);
    }

    /**
     * @dev Helper function to handle collateral liquidation accounting
     * @param self Pool storage
     * @param encodedLoanReceipt Encoded loan receipt
     * @param proceeds Proceeds amount in currency tokens
     * @return Borrower surplus, decoded loan receipt, loan receipt hash
     */
    function _onCollateralLiquidated(
        Pool.PoolStorage storage self,
        bytes calldata encodedLoanReceipt,
        uint256 proceeds
    ) external returns (uint256, LoanReceipt.LoanReceiptV2 memory, bytes32) {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is liquidated */
        if (self.loans[loanReceiptHash] != Pool.LoanStatus.Liquidated) revert IPool.InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV2 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Compute borrower's share of liquidation surplus */
        uint256 borrowerSurplus = proceeds > loanReceipt.repayment ? proceeds - loanReceipt.repayment : 0;

        /* Compute lenders' surplus from admin fee */
        uint256 lendersSurplus = proceeds - borrowerSurplus > loanReceipt.repayment - loanReceipt.adminFee
            ? proceeds - borrowerSurplus - (loanReceipt.repayment - loanReceipt.adminFee)
            : 0;

        /* Compute total interest for prorating lenders' surplus */
        uint256 totalInterest = loanReceipt.repayment - loanReceipt.adminFee - loanReceipt.principal;

        /* Compute elapsed time since loan origination */
        uint64 elapsed = uint64(block.timestamp + loanReceipt.duration - loanReceipt.maturity);

        /* Restore liquidity nodes */
        uint256 proceedsRemaining = proceeds - borrowerSurplus;
        uint256 lastIndex = loanReceipt.nodeReceipts.length - 1;
        for (uint256 i; i < loanReceipt.nodeReceipts.length; i++) {
            /* Compute amount to restore, prorating any lenders' surplus */
            uint256 restored = (i == lastIndex)
                ? proceedsRemaining
                : Math.min(loanReceipt.nodeReceipts[i].pending, proceedsRemaining) +
                    (
                        totalInterest != 0
                            ? (lendersSurplus *
                                (loanReceipt.nodeReceipts[i].pending - loanReceipt.nodeReceipts[i].used)) /
                                totalInterest
                            : 0
                    );

            /* Restore node */
            self.liquidity.restore(
                loanReceipt.nodeReceipts[i].tick,
                loanReceipt.nodeReceipts[i].used,
                loanReceipt.nodeReceipts[i].pending,
                restored.toUint128(),
                loanReceipt.duration,
                elapsed
            );

            /* Update proceeds remaining */
            proceedsRemaining -= restored;
        }

        /* Mark loan status collateral liquidated */
        self.loans[loanReceiptHash] = Pool.LoanStatus.CollateralLiquidated;

        return (borrowerSurplus, loanReceipt, loanReceiptHash);
    }

    /**
     * @dev Helper function to set admin fee
     * @param self Pool storage
     * @param feeShareStorage Fee share storage
     * @param rate Admin fee rate in basis points
     * @param feeShareRecipient Recipient of fee share
     * @param feeShareSplit Fee share split in basis points
     */
    function _setAdminFee(
        Pool.PoolStorage storage self,
        Pool.FeeShareStorage storage feeShareStorage,
        uint32 rate,
        address feeShareRecipient,
        uint16 feeShareSplit
    ) external {
        /* Validate caller is pool admin */
        if (msg.sender != self.admin) revert IPool.InvalidCaller();
        /* Validate rate and fee share split */
        if (rate >= LiquidityLogic.BASIS_POINTS_SCALE) revert IPool.InvalidParameters();
        if (feeShareSplit > LiquidityLogic.BASIS_POINTS_SCALE) revert IPool.InvalidParameters();

        self.adminFeeRate = rate;

        feeShareStorage.recipient = feeShareRecipient;
        feeShareStorage.split = feeShareSplit;
    }

    /**
     * @dev Helper function to withdraw admin fees
     * @param self Pool storage
     * @param recipient Recipient account
     * @return Withdraw amount
     */
    function _withdrawAdminFees(Pool.PoolStorage storage self, address recipient) external returns (uint256) {
        if (msg.sender != self.admin) revert IPool.InvalidCaller();
        if (recipient == address(0)) revert IPool.InvalidParameters();

        uint256 amount = self.adminFeeBalance;

        /* Update admin fees balance */
        self.adminFeeBalance = 0;

        return amount;
    }
}
