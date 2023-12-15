import { ethers } from "hardhat";

export type Liquidity = {
  value: ethers.BigNumber;
  available: ethers.BigNumber;
  pending: ethers.BigNumber;
};

type LoanReceipt = {
  principal: ethers.BigNumber;
  repayment: ethers.BigNumber;
  maturity: ethers.BigNumber;
  duration: ethers.BigNumber;
};

export class PoolModel {
  /* Constants */
  private BASIS_POINTS_SCALE = ethers.BigNumber.from(10000);
  private FIXED_POINT_SCALE = ethers.utils.parseEther("1");

  /* States we are using for comparison */
  public adminFeeBalance: ethers.BigNumber = ethers.constants.Zero;
  public liquidity: Liquidity = {
    value: ethers.constants.Zero,
    available: ethers.constants.Zero,
    pending: ethers.constants.Zero,
  };
  public collateralBalances: ethers.BigNumber = ethers.constants.Zero;
  public tokenBalances: ethers.BigNumber = ethers.constants.Zero;

  /* Helper state to keep track of loan receipts */
  public loanReceipts: Map<string, Map<string, LoanReceipt>> = new Map<string, Map<string, LoanReceipt>>();

  /* Variables to be initialized */
  public _adminFeeRate: ethers.BigNumber;

  constructor(_adminFeeRate: ethers.BigNumber) {
    this._adminFeeRate = _adminFeeRate;
  }

  public _prorateRepayment(
    blockTimestamp: ethers.BigNumber,
    loanReceipt: LoanReceipt
  ): [ethers.BigNumber, ethers.BigNumber] {
    const proration = blockTimestamp
      .sub(loanReceipt.maturity.sub(loanReceipt.duration))
      .mul(this.FIXED_POINT_SCALE)
      .div(loanReceipt.duration);
    const repayment = loanReceipt.principal.add(
      loanReceipt.repayment.sub(loanReceipt.principal).mul(proration).div(this.FIXED_POINT_SCALE)
    );
    return [repayment, proration];
  }

  public deposit(
    amount: ethers.BigNumber,
    value: ethers.BigNumber,
    available: ethers.BigNumber,
    pending: ethers.BigNumber
  ) {
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;
    this.tokenBalances = this.tokenBalances.add(amount);
  }

  public borrow(
    address: string,
    encodedLoanReceipt: string,
    repayment: ethers.BigNumber,
    principal: ethers.BigNumber,
    maturity: ethers.BigNumber,
    duration: ethers.BigNumber
  ) {
    /* Compute admin fee */
    const adminFee = this._adminFeeRate.mul(repayment.sub(principal)).div(this.BASIS_POINTS_SCALE);

    /* Update liquidity  */
    this.liquidity.available = this.liquidity.available.sub(principal);
    this.liquidity.pending = this.liquidity.pending.add(repayment.sub(adminFee));

    /* FIXME update with bundles */
    this.collateralBalances = this.collateralBalances.add(1);

    /* Send principal to borrower */
    this.tokenBalances = this.tokenBalances.sub(principal);

    let receipt: LoanReceipt = {
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
    blockTimestamp: ethers.BigNumber,
    encodedLoanReceipt: string,
    value: ethers.BigNumber,
    available: ethers.BigNumber,
    pending: ethers.BigNumber
  ): ethers.BigNumber {
    const loanReceipts = this.loanReceipts.get(address) ?? new Map<string, LoanReceipt>();

    const loanReceipt = loanReceipts.get(encodedLoanReceipt);

    if (loanReceipt === undefined) {
      throw new Error("repay(): loanReceipt === undefined");
    }

    /* Compute admin fee */
    const adminFee = this._adminFeeRate
      .mul(loanReceipt.repayment.sub(loanReceipt.principal))
      .div(this.BASIS_POINTS_SCALE);

    const [repayment, proration] = this._prorateRepayment(blockTimestamp, loanReceipt);

    /* Total pending is essential repayment less admin fee */
    const repaymentLessAdminFee = loanReceipt.repayment.sub(adminFee);

    /* Prorated admin fee */
    const proratedAdminFee = loanReceipt.repayment
      .sub(repaymentLessAdminFee)
      .mul(proration)
      .div(this.FIXED_POINT_SCALE);

    /* Update admin fee total balance with prorated admin fee */
    this.adminFeeBalance = this.adminFeeBalance.add(proratedAdminFee);

    /* Update top level liquidity statistics */
    this.liquidity.value = value;
    this.liquidity.available = available;
    this.liquidity.pending = pending;

    /* Update token balances */
    this.tokenBalances = this.tokenBalances.add(repayment);

    /* Update collateral balances */
    this.collateralBalances = this.collateralBalances.sub(1);

    return repayment;
  }

  public redeem(value: ethers.BigNumber, available: ethers.BigNumber, pending: ethers.BigNumber) {
    /* Update liquidity value */
    this.liquidity.value = value;

    /* Update liquidity available */
    this.liquidity.available = available;

    /* Update liquidity pending */
    this.liquidity.pending = pending;
  }

  public withdraw(amount: ethers.BigNumber) {
    /* Transfer withdrawal amount */
    this.tokenBalances = this.tokenBalances.sub(amount);
  }

  public refinance(
    address: string,
    blockTimestamp: ethers.BigNumber,
    value: ethers.BigNumber,
    available: ethers.BigNumber,
    pending: ethers.BigNumber,
    encodedLoanReceipt: string,
    newEncodedLoanReceipt: string,
    repayment: ethers.BigNumber,
    principal: ethers.BigNumber,
    maturity: ethers.BigNumber,
    duration: ethers.BigNumber
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
    this.collateralBalances = this.collateralBalances.sub(1);
  }

  public onCollateralLiquidated(
    address: string,
    encodedLoanReceipt: string,
    proceeds: ethers.BigNumber,
    value: ethers.BigNumber,
    available: ethers.BigNumber,
    pending: ethers.BigNumber
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
    this.tokenBalances = this.tokenBalances.add(proceeds);
  }
}
