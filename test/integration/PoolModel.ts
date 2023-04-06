import { ethers } from "hardhat";

export type Liquidity = {
  total: ethers.BigNumber;
  used: ethers.BigNumber;
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
    total: ethers.constants.Zero,
    used: ethers.constants.Zero,
  };
  public collateralBalances: ethers.BigNumber = ethers.constants.Zero;
  public tokenBalances: ethers.BigNumber = ethers.constants.Zero;

  /* Helper state to keep track of loan receipts */
  public loanReceipts: Map<string, Map<string, LoanReceipt>> = new Map<string, Map<string, LoanReceipt>>();

  /* Variables to be initialized */
  public _adminFeeRate: ethers.BigNumber;
  public _originationFeeRate: ethers.BigNumber;

  constructor(
    _adminFeeRate: ethers.BigNumber,
    _originationFeeRate: ethers.BigNumber,
    _interestRateModelType: string,
    _interestRateModelParams: any
  ) {
    this._adminFeeRate = _adminFeeRate;
    this._originationFeeRate = _originationFeeRate;
  }

  public _prorateRepayment(
    blockTimestamp: ethers.BigNumber,
    loanReceipt: LoanReceipt
  ): [ethers.BigNumber, ethers.BigNumber] {
    const proration = blockTimestamp
      .sub(loanReceipt.maturity.sub(loanReceipt.duration))
      .mul(this.FIXED_POINT_SCALE)
      .div(loanReceipt.duration);
    const originationFee = loanReceipt.principal.mul(this._originationFeeRate).div(this.BASIS_POINTS_SCALE);
    const repayment = loanReceipt.principal
      .add(originationFee)
      .add(
        loanReceipt.repayment.sub(originationFee).sub(loanReceipt.principal).mul(proration).div(this.FIXED_POINT_SCALE)
      );
    return [repayment, proration];
  }

  public deposit(amount: ethers.BigNumber, liquidityTotal: ethers.BigNumber) {
    this.liquidity.total = liquidityTotal;
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
    /* Update top level liquidity statistics */
    this.liquidity.used = this.liquidity.used.add(principal);

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
    total: ethers.BigNumber
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

    /* Update liquidity used */
    this.liquidity.used = this.liquidity.used.sub(loanReceipt.principal);

    /* Update liquidity total */
    this.liquidity.total = total;

    /* Update token balances */
    this.tokenBalances = this.tokenBalances.add(repayment);

    /* Update collateral balances */
    this.collateralBalances = this.collateralBalances.sub(1);

    return repayment;
  }

  public redeem(amount: ethers.BigNumber) {
    /* Subtract amount from total liquidity if not node not insolvent */
    this.liquidity.total = this.liquidity.total.sub(amount);
  }

  public withdraw(amount: ethers.BigNumber) {
    /* Transfer Withdrawal Amount */
    this.tokenBalances = this.tokenBalances.sub(amount);
  }

  public refinance(
    address: string,
    blockTimestamp: ethers.BigNumber,
    encodedLoanReceipt: string,
    liquidityTotal: ethers.BigNumber,
    newEncodedLoanReceipt: string,
    repayment: ethers.BigNumber,
    principal: ethers.BigNumber,
    maturity: ethers.BigNumber,
    duration: ethers.BigNumber
  ): ethers.BigNumber {
    this.repay(address, blockTimestamp, encodedLoanReceipt, liquidityTotal);

    return this.borrow(address, newEncodedLoanReceipt, repayment, principal, maturity, duration);
  }

  public liquidate() {
    /* Transfer collateral to liquidator contract */
    this.collateralBalances = this.collateralBalances.sub(1);
  }

  public onCollateralLiquidated(
    address: string,
    encodedLoanReceipt: string,
    proceeds: ethers.BigNumber,
    total: ethers.BigNumber
  ) {
    const loanReceipts = this.loanReceipts.get(address) ?? new Map<string, LoanReceipt>();

    const loanReceipt = loanReceipts.get(encodedLoanReceipt);

    if (loanReceipt === undefined) {
      throw new Error("repay(): loanReceipt === undefined");
    }

    /* Update top level liquidity statistics */
    this.liquidity.total = total;
    this.liquidity.used = this.liquidity.used.sub(loanReceipt.principal);

    /* Transfer proceeds from liquidator to pool */
    this.tokenBalances = this.tokenBalances.add(proceeds);
  }
}
