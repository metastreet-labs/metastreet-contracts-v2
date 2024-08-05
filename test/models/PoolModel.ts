import { ethers } from "hardhat";

export type Liquidity = {
  value: bigint;
  available: bigint;
  pending: bigint;
};

type LoanReceipt = {
  principal: bigint;
  adminFee: bigint;
  repayment: bigint;
  maturity: bigint;
  duration: bigint;
};

export class PoolModel {
  /* Constants */
  private BASIS_POINTS_SCALE = BigInt(10000);
  private FIXED_POINT_SCALE = ethers.parseEther("1");

  /* States we are using for comparison */
  public adminFeeBalance: bigint = 0n;
  public liquidity: Liquidity = {
    value: 0n,
    available: 0n,
    pending: 0n,
  };
  public collateralBalances: bigint = 0n;
  public tokenBalances: bigint = 0n;

  /* Helper state to keep track of loan receipts */
  public loanReceipts: Map<string, Map<string, LoanReceipt>> = new Map<string, Map<string, LoanReceipt>>();

  /* Variables to be initialized */
  public _adminFeeRate: bigint;

  constructor(_adminFeeRate: bigint, _interestRateModelType: string, _interestRateModelParams: any) {
    this._adminFeeRate = _adminFeeRate;
  }

  public _prorateRepayment(blockTimestamp: bigint, loanReceipt: LoanReceipt): [bigint, bigint] {
    const proration =
      ((blockTimestamp - (loanReceipt.maturity - loanReceipt.duration)) * this.FIXED_POINT_SCALE) /
      loanReceipt.duration;
    const repayment =
      loanReceipt.principal + ((loanReceipt.repayment - loanReceipt.principal) * proration) / this.FIXED_POINT_SCALE;
    return [repayment, proration];
  }

  public deposit(amount: bigint, value: bigint, available: bigint, pending: bigint) {
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;
    this.tokenBalances = this.tokenBalances + amount;
  }

  public borrow(
    address: string,
    encodedLoanReceipt: string,
    repayment: bigint,
    principal: bigint,
    maturity: bigint,
    duration: bigint
  ) {
    /* Compute admin fee */
    const adminFee = (this._adminFeeRate * (repayment - principal)) / this.BASIS_POINTS_SCALE;

    /* Update liquidity */
    this.liquidity.available -= principal;
    this.liquidity.pending += repayment - adminFee;

    /* FIXME update with bundles */
    this.collateralBalances += 1n;

    /* Send principal to borrower */
    this.tokenBalances -= principal;

    let receipt: LoanReceipt = {
      adminFee,
      principal,
      repayment,
      maturity,
      duration,
    };

    /* Store loan receipt */
    let borrowerLoans = this.loanReceipts.get(address) ?? new Map<string, LoanReceipt>();
    borrowerLoans.set(encodedLoanReceipt, receipt);
    this.loanReceipts.set(address, borrowerLoans);
  }

  public repay(
    address: string,
    blockTimestamp: bigint,
    encodedLoanReceipt: string,
    value: bigint,
    available: bigint,
    pending: bigint
  ): bigint {
    const loanReceipts = this.loanReceipts.get(address) ?? new Map<string, LoanReceipt>();

    const loanReceipt = loanReceipts.get(encodedLoanReceipt);

    if (loanReceipt === undefined) {
      throw new Error("repay(): loanReceipt === undefined");
    }

    const [repayment, proration] = this._prorateRepayment(blockTimestamp, loanReceipt);

    /* Prorated admin fee */
    const proratedAdminFee = (loanReceipt.adminFee * proration) / this.FIXED_POINT_SCALE;

    /* Update admin fee total balance with prorated admin fee */
    this.adminFeeBalance += proratedAdminFee;

    /* Update top-level liquidity statistics */
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;

    /* Update token balances */
    this.tokenBalances += repayment;

    /* Update collateral balances */
    this.collateralBalances -= 1n;

    return repayment;
  }

  public redeem(value: bigint, available: bigint, pending: bigint) {
    /* Update liquidity value */
    this.liquidity.value = value;

    /* Update liquidity available */
    this.liquidity.available = available;

    /* Update liquidity pending */
    this.liquidity.pending = pending;
  }

  public withdraw(amount: bigint) {
    /* Transfer withdrawal amount */
    this.tokenBalances = this.tokenBalances - amount;
  }

  public refinance(
    address: string,
    blockTimestamp: bigint,
    value: bigint,
    available: bigint,
    pending: bigint,
    encodedLoanReceipt: string,
    newEncodedLoanReceipt: string,
    repayment: bigint,
    principal: bigint,
    maturity: bigint,
    duration: bigint
  ) {
    this.repay(address, blockTimestamp, encodedLoanReceipt, value, available, pending);

    this.borrow(address, newEncodedLoanReceipt, repayment, principal, maturity, duration);

    /* Update top level liquidity statistics */
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;
  }

  public liquidate() {
    /* Transfer collateral to liquidator contract */
    this.collateralBalances = this.collateralBalances - 1n;
  }

  public onCollateralLiquidated(
    address: string,
    encodedLoanReceipt: string,
    proceeds: bigint,
    value: bigint,
    available: bigint,
    pending: bigint
  ) {
    const loanReceipts = this.loanReceipts.get(address) ?? new Map<string, LoanReceipt>();

    const loanReceipt = loanReceipts.get(encodedLoanReceipt);

    if (loanReceipt === undefined) {
      throw new Error("repay(): loanReceipt === undefined");
    }

    /* Update top level liquidity statistics */
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;

    /* Transfer proceeds from liquidator to pool */
    this.tokenBalances = this.tokenBalances + proceeds;
  }
}
