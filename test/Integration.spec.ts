import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegationRegistry,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
} from "../typechain";

import { extractEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint.ts";
import { PoolModel } from "./integration/PoolModel";

describe("Integration", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidatorImpl: ExternalCollateralLiquidator;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: Pool;
  let poolModel: PoolModel;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[9];
  let accountBorrowers: SignerWithAddress[10];
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegationRegistry: TestDelegationRegistry;
  let bundleCollateralWrapper: BundleCollateralWrapper;

  /* Test Config */
  const CONFIG = {
    /* functionCalls: [deposit, borrow, repay, refinance, redeem, withdraw, liquidate, onCollateralLiquidated], */
    functionCalls: [deposit, withdraw, redeem, borrow, liquidate, onCollateralLiquidated],
    maxFunctionCalls: 1000,
    principals: [1] /* min: 1 ethers, max: 2 ethers */,
    durations: [1, 30 * 86400] /* min: 1 second, max: 30 * 86499 seconds */,
    depths: ["1"],
    depositAmounts: [25, 50] /* min: 25 ethers, max: 50 ethers */,
    numberOfBorrowers: 8 /* max allowed is 8!! */,
    numberOfDepositors: 1 /* max allowed is 9!! */,
    liquidationProceedsRatio: [0] /* 0%, 50%, 100%, 300% of repayment */,
    isSharesRedeemAmountRandomized: false,
    adminFeeRate: 45 /* 4.5% */,
    originationFeeRate: 45 /* 4.5% */,
    fixedInterestRate: FixedPoint.normalizeRate("0.02"),
    tickThreshold: FixedPoint.from("0.05"),
    tickExponential: FixedPoint.from("2.0"),
  };

  /* Test Suite Internal Storage */
  /* address -> (depth -> [amount, shares, shares pending withdrawals, depositor]) */
  let deposits: Map<string, Map<string, [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress]>>;
  /* list of (borrower address, token id, encoded loan receipt) */
  let loans: [SignerWithAddress, ethers.BigNumber, string][];
  /* address -> list of token ids - removed when used as collateral */
  let collateralsOwned: Map<string, Set<ethers.BigNumber>>;
  /* token id counter */
  let collateralTokenId: ethers.BigNumber = ethers.constants.Zero;
  /* list of (borrower address, token id, encoded loan receipt) */
  let defaultedLoans: [SignerWithAddress, ethers.BigNumber, string][];

  let callSequence: any[];
  let callStatistics: any;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("FixedRateSingleCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy(
      "Token 1",
      "TOK1",
      18,
      ethers.utils.parseEther("1000000000000")
    )) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

    /* Deploy external collateral liquidator implementation */
    collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      collateralLiquidatorImpl.address,
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(delegationRegistry.address, [bundleCollateralWrapper.address])) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint64", "uint256", "tuple(uint64, uint64, uint64)"],
          [
            nft1.address,
            tok1.address,
            30 * 86400,
            45,
            [CONFIG.fixedInterestRate, CONFIG.tickThreshold, CONFIG.tickExponential],
          ]
        ),
        collateralLiquidator.address,
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* Set admin rate */
    await pool.setAdminFeeRate(CONFIG.adminFeeRate);

    /* Arrange accounts */
    accountDepositors = accounts.slice(0, CONFIG.numberOfDepositors + 1);
    accountBorrowers = accounts.slice(10, 10 + CONFIG.numberOfBorrowers + 1);
    accountLender = accounts[19];
    accountLiquidator = accountLender;

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("100000000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }

    /* Transfer TOK1 to borrowers and approve Pool */
    for (const borrower of accountBorrowers) {
      await tok1.transfer(borrower.address, ethers.utils.parseEther("100000000"));
      await tok1.connect(borrower).approve(pool.address, ethers.constants.MaxUint256);
      await nft1.connect(borrower).setApprovalForAll(pool.address, true);
    }

    /* Transfer TOK1 to liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100000000"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Instantiate Pool Model class */
    poolModel = new PoolModel(
      ethers.BigNumber.from(CONFIG.adminFeeRate),
      ethers.BigNumber.from(CONFIG.originationFeeRate),
      "fixed",
      [CONFIG.fixedInterestRate, CONFIG.tickThreshold, CONFIG.tickExponential]
    );

    /* Create call sequence */
    callSequence = await generateCallSequence();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);

    /* Reset internal storage */
    collateralsOwned = new Map<string, Set<ethers.BigNumber>>();
    loans = [];
    defaultedLoans = [];
    deposits = new Map<
      string,
      Map<string, [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress]>
    >();
    collateralTokenId = ethers.constants.Zero;
    callStatistics = {
      deposit: 0,
      borrow: 0,
      repay: 0,
      refinance: 0,
      redeem: 0,
      withdraw: 0,
      liquidate: 0,
      onCollateralLiquidated: 0,
    };
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");

  function getRandomInteger(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  function getRandomBN(max: ethers.BigNumber): ethers.BigNumber {
    return ethers.BigNumber.from(ethers.utils.randomBytes(32)).mod(max);
  }

  function removeLoanFromStorage(store: [SignerWithAddress, ethers.BigNumber, string][], encodedLoanReceipt: string) {
    const indexOfRepaidLoan: number = store.findIndex(
      (l: [SignerWithAddress, ethers.BigNumber, string]) => l[2] === encodedLoanReceipt
    );
    if (indexOfRepaidLoan === -1) {
      throw new Error("Loan should be in store");
    }
    /* Remove this loan */
    store.splice(indexOfRepaidLoan, 1);
  }

  function flattenDeposits(
    hasRedemptionPending: boolean
  ): [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress][] {
    const flattenedDeposits: [
      ethers.BigNumber,
      ethers.BigNumber,
      ethers.BigNumber,
      ethers.BigNumber,
      SignerWithAddress
    ][] = [];
    deposits.forEach(
      async (
        depths: Map<string, [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress]>,
        address: string
      ) => {
        depths.forEach(
          async (value: [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress], depth: string) => {
            const [amount, shares, sharesPendingWithdrawal, depositor] = value;
            /* If we want deposits with redemption pending, then sharesPendingWithdrawal cannot be 0 */
            if (!hasRedemptionPending === sharesPendingWithdrawal.eq(ethers.constants.Zero)) {
              /* Exclude redemptionPending deposits */
              flattenedDeposits.push([depth, amount, shares, sharesPendingWithdrawal, depositor]);
            }
          }
        );
      }
    );
    return flattenedDeposits;
  }

  async function sourceLiquidity(amount: ethers.BigNumber, itemCount: ethers.BigNumber): Promise<ethers.BigNumber[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const depths = [];

    const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
    const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

    let taken = ethers.constants.Zero;
    let prevDepth = ethers.constants.Zero;
    let carry = ethers.constants.Zero;
    for (const node of nodes) {
      const depthAmount = node.depth.sub(prevDepth).mul(itemCount).add(carry);
      const take = minBN(minBN(depthAmount, node.available), amount.sub(taken));
      carry = node.available.lt(depthAmount) ? depthAmount.sub(node.available) : ethers.constants.Zero;
      prevDepth = node.depth;
      if (take.isZero()) continue;
      depths.push(node.depth);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return depths;
  }

  async function compareStates(): Promise<void> {
    console.log("\nComparing states...");
    /* Compare admin fee balance */
    expect(await pool.adminFeeBalance()).to.equal(poolModel.adminFeeBalance, "Admin fee balance unequal");

    /* Compare pool's token balance */
    expect(await tok1.balanceOf(pool.address)).to.equal(poolModel.tokenBalances, "Token balance unequal");

    /* Compare pool's collateral balance */
    expect(await nft1.balanceOf(pool.address)).to.equal(poolModel.collateralBalances, "Collateral balance unequal");
    console.log(
      `Balances => admin fee: ${poolModel.adminFeeBalance}, token: ${poolModel.tokenBalances}, collateral: ${poolModel.collateralBalances}`
    );

    /* Compare top level liquidity */
    const [total, used, _] = await pool.liquidityStatistics();
    expect(total).to.equal(poolModel.liquidity.total, "Total liquidity unequal");
    expect(used).to.equal(poolModel.liquidity.used, "Used liquidity unequal");
    console.log(`Top level liquidity => total: ${total}, used: ${used}`);
  }

  async function getTransactionTimestamp(blockNumber: ethers.BigNumber): Promise<ethers.BigNumber> {
    const block = await ethers.provider.getBlock(blockNumber);
    return block.timestamp;
  }

  async function generateCallSequence(): Promise<any[]> {
    const callSequence = [];
    for (let i = 0; i < CONFIG.maxFunctionCalls; i++) {
      const functionCallIndex = getRandomInteger(0, CONFIG.functionCalls.length);
      const functionCall = CONFIG.functionCalls[functionCallIndex];

      callSequence.push(functionCall);
    }
    return callSequence;
  }

  /****************************************************************************/
  /* Function Wrappers */
  /****************************************************************************/

  async function deposit(): Promise<void> {
    try {
      console.log("Executing deposit()...");

      const depositor = accountDepositors[getRandomInteger(0, accountDepositors.length)];
      const depth = ethers.utils.parseEther(CONFIG.depths[getRandomInteger(0, CONFIG.depths.length)]);
      const amount = ethers.utils.parseEther(
        getRandomInteger(CONFIG.depositAmounts[0], CONFIG.depositAmounts[CONFIG.depositAmounts.length - 1]).toString()
      );

      /* Execute deposit() on Pool */
      console.log(`Params => depth: ${depth}, amount: ${amount}`);
      const depositTx = await pool.connect(depositor).deposit(depth, amount);

      const [totalAfter, usedAfter, numNodesAfter] = await pool.liquidityStatistics();

      /* Get shares */
      const shares = (await extractEvent(depositTx, pool, "Deposited")).args.shares;

      /* Execute deposit() on PoolModel */
      poolModel.deposit(amount, totalAfter);

      /* Update our helper variables */
      const depositorsDeposits =
        deposits.get(depositor.address) ??
        new Map<string, [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress]>();
      const depthDeposit = depositorsDeposits.get(depth.toString()) ?? [
        ethers.constants.Zero,
        ethers.constants.Zero,
        ethers.constants.Zero /* shares pending withdrawal */,
        depositor,
      ];
      const newDepthDeposit: [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress] = [
        depthDeposit[0].add(amount),
        depthDeposit[1].add(shares),
        depthDeposit[2] /* shares pending withdrawal */,
        depositor,
      ];
      depositorsDeposits.set(depth.toString(), newDepthDeposit);
      deposits.set(depositor.address, depositorsDeposits);

      callStatistics["deposit"] += 1;
      console.log(`${depositor.address}: Deposited ${amount} at depth ${depth}`);
    } catch (e) {
      console.log("deposit() failed:", e);
      throw new Error();
    }
  }

  async function borrow(): Promise<void> {
    try {
      console.log("Executing borrow()...");

      const borrower = accountBorrowers[getRandomInteger(0, accountBorrowers.length)];
      console.log(`Borrower: ${borrower.address}`);

      const duration = ethers.BigNumber.from(
        getRandomInteger(CONFIG.durations[0], CONFIG.durations[CONFIG.durations.length - 1])
      );

      const principal = ethers.utils.parseEther(
        getRandomInteger(CONFIG.principals[0], CONFIG.principals[CONFIG.principals.length - 1]).toString()
      );

      /* Check if liquidity available */
      const liquidity = await pool.liquidityAvailable(MaxUint128, ethers.BigNumber.from(1));
      if (liquidity.lt(principal)) {
        console.log("Insufficient liquidity");
        return;
      }

      /* Source liquidity */
      const _depths = await sourceLiquidity(principal, 1);

      /* Get max repayment */
      const maxRepayment = principal.mul(2);

      let tokenId;

      /* Check if borrower has existing collaterals */
      const borrowerCollaterals = collateralsOwned.get(borrower.address);
      if (borrowerCollaterals === undefined || borrowerCollaterals.size === 0) {
        tokenId = collateralTokenId;
        /* Mint before borrowing */
        await nft1.mint(borrower.address, tokenId);

        /* Increase collateralTokenId counter since we just minted one */
        collateralTokenId = collateralTokenId.add(1);
      } else {
        const _borrowerCollaterals = Array.from(borrowerCollaterals);
        tokenId = _borrowerCollaterals[Math.floor(Math.random() * _borrowerCollaterals.length)];

        /* Remove token id from borrower's collaterals */
        borrowerCollaterals.delete(tokenId);
        collateralsOwned.set(borrower.address, borrowerCollaterals);
      }

      /* Simulate borrow to get repayment value */
      const repayment = await pool
        .connect(borrower)
        .callStatic.borrow(principal, duration, nft1.address, tokenId, maxRepayment, _depths, "0x");

      /* Execute borrow() on Pool */
      console.log(`Params => principal: ${principal}, duration: ${duration}, maxRepayment: ${maxRepayment}`);
      const borrowTx = await pool
        .connect(borrower)
        .borrow(principal, duration, nft1.address, tokenId, maxRepayment, _depths, "0x");

      /* Get block timestamp of borrow transaction */
      const blockTimestamp = ethers.BigNumber.from(await getTransactionTimestamp(borrowTx.blockNumber));

      /* Get encoded loan receipt */
      const encodedLoanReceipt: string = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Execute borrow() on PoolModel */
      poolModel.borrow(
        borrower.address,
        encodedLoanReceipt,
        repayment,
        principal,
        blockTimestamp.add(duration),
        duration
      );

      /* Store encode loan receipt and borrower's loan count */
      loans.push([borrower, tokenId, encodedLoanReceipt]);

      callStatistics["borrow"] += 1;
      console.log(`Borrowed ${principal} for ${duration} seconds`);
    } catch (e) {
      console.log("borrow() failed:", e);
      throw new Error();
    }
  }

  async function repay(): Promise<void> {
    try {
      console.log("Executing repay()...");

      /* Skip repay() if there are no existing loans */
      if (loans.length === 0) {
        console.log("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;
      console.log(`Borrower: ${borrower.address}`);

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = ethers.BigNumber.from(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (timestamp.gt(maturity)) {
        /* Remove loan from internal records based on encoded loan receipt */
        removeLoanFromStorage(loans, encodedLoanReceipt);
        return;
      }

      /* Go fast forward to a random timestamp that is before maturity */
      const randomTimestamp = getRandomBN(maturity.sub(timestamp)).add(timestamp);
      await helpers.time.increaseTo(randomTimestamp);

      /* Execute repay() on Pool */
      const repayTx = await pool.connect(borrower).repay(encodedLoanReceipt);
      let [total, used, numNodes] = await pool.liquidityStatistics();

      /* Get block timestamp of repay transaction */
      const blockTimestamp = ethers.BigNumber.from(await getTransactionTimestamp(repayTx.blockNumber));

      /* Get new encoded loan receipt */
      const repayment: ethers.BigNumber = (await extractEvent(repayTx, pool, "LoanRepaid")).args.repayment;

      /* Execute repay() on PoolModel */
      poolModel.repay(borrower.address, blockTimestamp, encodedLoanReceipt, total);

      /* Remove loan from internal records based on encoded loan receipt */
      removeLoanFromStorage(loans, encodedLoanReceipt);

      /* Indicate that borrower now has the collateral */
      const borrowerCollaterals: Set<ethers.BigNumber> = collateralsOwned.get(borrower.address) ?? new Set();
      borrowerCollaterals.add(tokenId);
      collateralsOwned.set(borrower.address, borrowerCollaterals);

      callStatistics["repay"] += 1;
      console.log(
        `Repaid ${repayment} for loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      console.log("repay() failed:", e);
      throw new Error();
    }
  }

  async function refinance(): Promise<void> {
    try {
      console.log("Executing refinance()...");

      const duration = ethers.BigNumber.from(
        getRandomInteger(CONFIG.durations[0], CONFIG.durations[CONFIG.durations.length - 1])
      );
      const principal = ethers.utils.parseEther(
        getRandomInteger(CONFIG.principals[0], CONFIG.principals[CONFIG.principals.length - 1]).toString()
      );

      /* Skip refinance() if there are no existing loans */
      if (loans.length === 0) {
        console.log("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;
      console.log(`Borrower: ${borrower.address}`);

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = ethers.BigNumber.from(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (timestamp.gt(maturity)) {
        /* Remove loan from internal records based on encoded loan receipt */
        removeLoanFromStorage(loans, encodedLoanReceipt);
        return;
      }

      /* Go fast forward to a random timestamp that is before maturity */
      const randomTimestamp = getRandomBN(maturity.sub(timestamp)).add(timestamp);
      await helpers.time.increaseTo(randomTimestamp);

      /* Check if liquidity available */
      const liquidity = await pool.liquidityAvailable(MaxUint128, ethers.BigNumber.from(1));
      if (liquidity.lt(principal)) {
        console.log("Insufficient liquidity");
        return;
      }

      /* Source liquidity */
      const _depths = await sourceLiquidity(principal, 1);

      /* Get max repayment */
      const maxRepayment = principal.mul(2);

      /* Simulate refinance to get repayment value */
      console.log(`Params => principal: ${principal}, duration: ${duration}, maxRepayment: ${maxRepayment}`);
      const repayment = await pool
        .connect(borrower)
        .callStatic.refinance(encodedLoanReceipt, principal, duration, maxRepayment, _depths);

      /* Execute repay() on Pool */
      const refinanceTx = await pool
        .connect(borrower)
        .refinance(encodedLoanReceipt, principal, duration, maxRepayment, _depths);
      let [total, used, numNodes] = await pool.liquidityStatistics();

      /* Get block timestamp of borrow transaction */
      const blockTimestamp = ethers.BigNumber.from(await getTransactionTimestamp(refinanceTx.blockNumber));

      /* Get new encoded loan receipt */
      const newEncodedLoanReceipt: string = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Execute refinance() on PoolModel */
      poolModel.refinance(
        borrower.address,
        blockTimestamp,
        encodedLoanReceipt,
        total,
        newEncodedLoanReceipt,
        repayment,
        principal,
        blockTimestamp.add(duration),
        duration
      );

      /* Remove loan from internal records based on encoded loan receipt */
      removeLoanFromStorage(loans, encodedLoanReceipt);

      /* Store new encode loan receipt and borrower's loan count */
      loans.push([borrower, tokenId, newEncodedLoanReceipt]);

      callStatistics["refinance"] += 1;
      console.log(
        `Refinanced loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      console.log("refinance() failed:", e);
      throw new Error();
    }
  }

  async function redeem(): Promise<void> {
    try {
      console.log("Executing redeem()...");

      /* Randomly select existing deposit that has redemption pending = false */
      const flattenedDeposits = flattenDeposits(false);
      if (flattenedDeposits.length === 0) {
        console.log("No deposits with no redemption pending");
        return;
      }
      const [depth, amount, shares, sharesPendingWithdrawal, depositor] =
        flattenedDeposits[getRandomInteger(0, flattenedDeposits.length)];
      console.log(`Depositor: ${depositor.address}`);

      /* If randomized, redeem at least 1 */
      const sharesRedeemAmount = CONFIG.isSharesRedeemAmountRandomized ? getRandomBN(shares.sub(1)).add(1) : shares;

      /* redeem() decreases liquidity.total if it is not insolvent, so we do a
       * snapshot before and after, so we can adjust liquidity.total in our
       * Pool */
      const [totalBefore, usedBefore, numNodesBefore] = await pool.liquidityStatistics();

      /* Execute redeem() on Pool */
      console.log(`Params => depth: ${depth}, shares: ${sharesRedeemAmount}`);
      await pool.connect(depositor).redeem(depth, sharesRedeemAmount);

      const [totalAfter, usedAfter, numNodesAfter] = await pool.liquidityStatistics();

      /* Execute redeem() on PoolModel */
      poolModel.redeem(totalBefore.sub(totalAfter));

      /* Update our helper variables */
      const depositorsDeposits = deposits.get(depositor.address);

      if (depositorsDeposits === undefined) {
        throw new Error("depositorDeposits should exists");
      }

      /* Set redemption pending to true */
      const newDepthDeposit: [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress] = [
        amount,
        shares.sub(sharesRedeemAmount),
        sharesPendingWithdrawal.add(sharesRedeemAmount),
        depositor,
      ];
      depositorsDeposits.set(depth.toString(), newDepthDeposit);
      deposits.set(depositor.address, depositorsDeposits);

      callStatistics["redeem"] += 1;
      console.log(`${depositor.address}: Redeemed ${sharesRedeemAmount} shares at depth ${depth}`);
    } catch (e) {
      console.log("redeem() failed:", e);
      throw new Error();
    }
  }

  async function withdraw(): Promise<void> {
    try {
      console.log("Executing withdraw()...");

      /* Randomly select existing deposit that has redemption pending = true */
      const flattenedDeposits = flattenDeposits(true);
      if (flattenedDeposits.length === 0) {
        console.log("No deposits with pending redemption");
        return;
      }

      const [depth, amount, shares, sharesPendingWithdrawal, depositor] =
        flattenedDeposits[getRandomInteger(0, flattenedDeposits.length)];
      console.log(`Depositor: ${depositor.address}`);

      /* Execute withdraw() on Pool */
      console.log(`Params => depth: ${depth}`);
      const withdrawTx = await pool.connect(depositor).withdraw(depth);

      /* Get shares */
      const _shares = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares;

      /* Get amount */
      const _amount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;

      /* Execute withdraw() on PoolModel */
      poolModel.withdraw(_amount);

      /* Update our helper variables */
      const depositorsDeposits = deposits.get(depositor.address);

      if (depositorsDeposits === undefined) {
        throw new Error("depositorDeposits should exists");
      }

      const newAmount = amount.sub(_amount);
      const newSharesPendingWithdrawal = sharesPendingWithdrawal.sub(_shares);

      /* Remove deposit record if fully repaid and no outstanding shares to be redeemed */
      if (newSharesPendingWithdrawal.eq(ethers.constants.Zero) && shares.eq(ethers.constants.Zero)) {
        depositorsDeposits.delete(depth.toString());
      } else {
        /* Else, update depositor record */
        const newDepthDeposit: [ethers.BigNumber, ethers.BigNumber, ethers.BigNumber, SignerWithAddress] = [
          newAmount,
          shares,
          newSharesPendingWithdrawal,
          depositor,
        ];
        depositorsDeposits.set(depth.toString(), newDepthDeposit);
      }
      deposits.set(depositor.address, depositorsDeposits);

      callStatistics["withdraw"] += 1;
      console.log(`${depositor.address}: Withdrew ${_shares} shares and ${amount} tokens at depth ${depth}`);
    } catch (e) {
      console.log("withdraw() failed:", e);
      throw new Error();
    }
  }

  async function liquidate(): Promise<void> {
    try {
      console.log("Executing liquidate()...");

      /* Skip liquidate() if there are no existing loans */
      if (loans.length === 0) {
        console.log("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = ethers.BigNumber.from(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (maturity.gte(timestamp)) {
        /* Fast forward to one second after maturity */
        await helpers.time.increaseTo(maturity.add(1).toNumber());
      }

      /* Execute liquidate on Pool */
      await pool.liquidate(encodedLoanReceipt);

      /* Execute liquidate on PoolModel */
      poolModel.liquidate();

      /* Update our helper variables */
      removeLoanFromStorage(loans, encodedLoanReceipt);
      defaultedLoans.push([borrower, tokenId, encodedLoanReceipt]);

      callStatistics["liquidate"] += 1;
      console.log(
        `Liquidated loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      console.log("liquidate() failed:", e);
      throw new Error();
    }
  }

  async function onCollateralLiquidated(): Promise<void> {
    try {
      console.log("Executing onCollateralLiquidated()...");

      /* Skip onCollateralLiquidated() if there are no existing loans */
      if (defaultedLoans.length === 0) {
        console.log("No existing defaulted loans exists");
        return;
      }

      /* Randomly select existing a defaulted loans */
      const defaultedLoan = defaultedLoans[getRandomInteger(0, defaultedLoans.length)];
      const [borrower, tokenId, encodedLoanReceipt] = defaultedLoan;

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Proceeds ratio */
      const proceedsRatio = ethers.BigNumber.from(
        CONFIG.liquidationProceedsRatio[getRandomInteger(0, CONFIG.liquidationProceedsRatio.length)]
      );

      /* Compute proceeds */
      const proceeds = decodedLoanReceipt.repayment.mul(proceedsRatio).div(10000);

      /* Execute liquidate on Pool */
      console.log(`Params => proceeds: ${proceeds}`);
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          pool.address,
          tok1.address,
          decodedLoanReceipt.collateralToken,
          decodedLoanReceipt.collateralTokenId,
          "0x",
          encodedLoanReceipt
        );
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          pool.address,
          tok1.address,
          decodedLoanReceipt.collateralToken,
          decodedLoanReceipt.collateralTokenId,
          "0x",
          encodedLoanReceipt,
          proceeds
        );
      const [total, used, _] = await pool.liquidityStatistics();

      /* Execute liquidate on PoolModel */
      poolModel.onCollateralLiquidated(borrower.address, encodedLoanReceipt, proceeds, total);

      /* Update our helper variables */
      removeLoanFromStorage(defaultedLoans, encodedLoanReceipt);

      callStatistics["onCollateralLiquidated"] += 1;
      console.log(`Restored liquidation proceeds of ${proceeds}`);
    } catch (e) {
      console.log("onCollateralLiquidated() failed:", e);
      throw new Error();
    }
  }

  describe("#test", async function () {
    it("integration test", async function () {
      for (let i = 0; i < callSequence.length; i++) {
        console.log("\n--------------\n");
        const functionCall = callSequence[i];
        await functionCall();
        await compareStates();
      }
      console.log("\n\nCall sequence completed!");
      console.log("\nSuccessful calls:");
      console.log(callStatistics);
    });
  });
});
