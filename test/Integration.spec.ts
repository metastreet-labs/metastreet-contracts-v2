import { expect } from "chai";
import { ethers } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  ILiquidity,
  Pool,
  BundleCollateralWrapper,
  ERC20DepositTokenImplementation,
  WeightedRateCollectionPool,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

import { PoolModel } from "./models/PoolModel";

describe("Integration", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidatorImpl: ExternalCollateralLiquidator;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: WeightedRateCollectionPool;
  let poolModel: PoolModel;
  let accountDepositors: SignerWithAddress[9];
  let accountBorrowers: SignerWithAddress[10];
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  /* Toggle logging */
  const SILENCE_LOG = true;

  /* Test Config */
  const CONFIG = {
    functionCalls: [deposit, borrow, repay, refinance, redeem, withdraw, liquidate, onCollateralLiquidated],
    maxFunctionCalls: 1000,
    principals: [1, 2] /* min: 1 ethers, max: 2 ethers */,
    ticks: ["1", "2"] /* min and max needs to be within the bounds of principals */,
    borrowDurations: [1, 30 * 86400] /* min: 1 second, max: 30 days */,
    tickDurations: [30 * 86400, 14 * 86400, 7 * 86400] /* 7 days, 14 days, 30 days */,
    tickRates: [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
    depositAmounts: [25, 50] /* min: 25 ethers, max: 50 ethers */,
    numberOfBorrowers: 8 /* max allowed is 8!! */,
    numberOfDepositors: 3 /* max allowed is 9!! */,
    liquidationProceedsRatio: [0, 50, 100, 300] /* 0%, 50%, 100%, 300% of repayment */,
    isSharesRedeemAmountRandomized: false,
    adminFeeRate: 45 /* 0.45% */,
  };

  /* Test Suite Internal Storage */
  /* address -> (tick -> [amount, shares, shares pending withdrawals, depositor]) */
  let deposits: Map<string, Map<string, [bigint, bigint, bigint, SignerWithAddress]>>;
  /* address -> (tick -> redemption id) */
  let redemptionIds: Map<string, Map<string, bigint[]>>;
  /* list of (borrower address, token id, encoded loan receipt) */
  let loans: [SignerWithAddress, bigint, string][];
  /* address -> list of token ids - removed when used as collateral */
  let collateralsOwned: Map<string, Set<bigint>>;
  /* token id counter */
  let collateralTokenId: bigint = 0n;
  /* list of (borrower address, token id, encoded loan receipt) */
  let defaultedLoans: [SignerWithAddress, bigint, string][];

  let callSequence: any[];
  let callStatistics: any;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("1000000000000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.waitForDeployment();

    /* Deploy external collateral liquidator implementation */
    collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.waitForDeployment();

    /* Deploy collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      await collateralLiquidatorImpl.getAddress(),
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.waitForDeployment();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      await proxy.getAddress()
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry v1 */
    delegateRegistryV1 = await delegateRegistryV1Factory.deploy();
    await delegateRegistryV1.waitForDeployment();

    /* Deploy test delegation registry v2 */
    delegateRegistryV2 = await delegateRegistryV2Factory.deploy();
    await delegateRegistryV2.waitForDeployment();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.waitForDeployment();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      [await bundleCollateralWrapper.getAddress()]
    )) as Pool;
    await poolImpl.waitForDeployment();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      await poolImpl.getAddress(),
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address[]", "address", "address", "uint64[]", "uint64[]"],
          [
            [await nft1.getAddress()],
            await tok1.getAddress(),
            ethers.ZeroAddress,
            CONFIG.tickDurations,
            CONFIG.tickRates,
          ]
        ),
      ])
    );
    await proxy.waitForDeployment();
    pool = (await ethers.getContractAt(
      "WeightedRateCollectionPool",
      await proxy.getAddress()
    )) as WeightedRateCollectionPool;

    /* Set admin rate */
    await pool.setAdminFee(CONFIG.adminFeeRate, ethers.ZeroAddress, 0);

    /* Arrange accounts */
    accountDepositors = accounts.slice(0, CONFIG.numberOfDepositors + 1);
    accountBorrowers = accounts.slice(10, 10 + CONFIG.numberOfBorrowers + 1);
    accountLender = accounts[19];
    accountLiquidator = accountLender;

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(await depositor.getAddress(), ethers.parseEther("100000000"));
      await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
    }

    /* Transfer TOK1 to borrowers and approve Pool */
    for (const borrower of accountBorrowers) {
      await tok1.transfer(await borrower.getAddress(), ethers.parseEther("100000000"));
      await tok1.connect(borrower).approve(await pool.getAddress(), ethers.MaxUint256);
      await nft1.connect(borrower).setApprovalForAll(await pool.getAddress(), true);
    }

    /* Transfer TOK1 to liquidator */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100000000"));
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Instantiate Pool Model class */
    poolModel = new PoolModel(BigInt(CONFIG.adminFeeRate), "fixed", null);

    /* Create call sequence */
    callSequence = await generateCallSequence();
  });

  beforeEach("snapshot blockchain", async () => {
    /* Reset internal storage */
    collateralsOwned = new Map<string, Set<bigint>>();
    loans = [];
    defaultedLoans = [];
    deposits = new Map<string, Map<string, [bigint, bigint, bigint, SignerWithAddress]>>();
    redemptionIds = new Map<string, Map<string, bigint[]>>();
    collateralTokenId = 0n;
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

  /****************************************************************************/
  /* Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");

  function consoleLog(message: string) {
    if (!SILENCE_LOG) {
      console.log(message);
    }
  }

  function getRandomInteger(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
  }

  function getRandomBN(max: bigint): bigint {
    const randomBytes = ethers.randomBytes(32);
    let randomBigInt = BigInt(0);

    for (let i = 0; i < randomBytes.length; i++) {
      randomBigInt = (randomBigInt << BigInt(8)) | BigInt(randomBytes[i]);
    }
    return randomBigInt % max;
  }

  function filterNodes(
    durationIndex: number,
    nodes: ILiquidity.NodeInfoStructOutput[]
  ): ILiquidity.NodeInfoStructOutput[] {
    const filteredNodes = [];
    for (const node of nodes) {
      const tickDecoded = Tick.decode(node.tick);
      if (tickDecoded.durationIndex == durationIndex) {
        filteredNodes.push(node);
      }
    }

    return filteredNodes;
  }

  function shuffleNodes(array: any[]): ILiquidity.NodeInfoStructOutput[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = temp;
    }
    return shuffled;
  }

  function randomizeNodes(nodes: ILiquidity.NodeInfoStructOutput[]): ILiquidity.NodeInfoStructOutput[] {
    nodes = shuffleNodes(nodes);
    const randomizedNodes = [];
    let ticks = new Set<string>();
    for (const node of nodes) {
      const tickDecoded = Tick.decode(node.tick);
      const limit = ethers.formatEther(tickDecoded.limit);
      /* Select only one node per tick limit */
      if (!ticks.has(limit)) {
        randomizedNodes.push(node);
        ticks + limit;
      }
    }

    return randomizedNodes;
  }

  function sortNodes(nodes: ILiquidity.NodeInfoStructOutput[]): ILiquidity.NodeInfoStructOutput[] {
    nodes.sort((a, b) => {
      const aLimit = Tick.decode(a.tick).limit;
      const bLimit = Tick.decode(b.tick).limit;
      if (aLimit > bLimit) {
        return 1;
      } else if (aLimit < bLimit) {
        return -1;
      } else {
        return 0;
      }
    });
    return nodes;
  }

  function removeLoanFromStorage(store: [SignerWithAddress, bigint, string][], encodedLoanReceipt: string) {
    const indexOfRepaidLoan: number = store.findIndex(
      (l: [SignerWithAddress, bigint, string]) => l[2] === encodedLoanReceipt
    );
    if (indexOfRepaidLoan === -1) {
      throw new Error("Loan should be in store");
    }
    /* Remove this loan */
    store.splice(indexOfRepaidLoan, 1);
  }

  function flattenDeposits(hasRedemptionPending: boolean): [bigint, bigint, bigint, bigint, SignerWithAddress][] {
    const flattenedDeposits: [bigint, bigint, bigint, bigint, SignerWithAddress][] = [];
    deposits.forEach(async (ticks: Map<string, [bigint, bigint, bigint, SignerWithAddress]>, address: string) => {
      ticks.forEach(async (value: [bigint, bigint, bigint, SignerWithAddress], tick: string) => {
        const [amount, shares, sharesPendingWithdrawal, depositor] = value;
        /* If we want deposits with redemption pending, then sharesPendingWithdrawal cannot be 0 */
        if (!hasRedemptionPending === (sharesPendingWithdrawal === 0n)) {
          /* Exclude redemptionPending deposits */
          flattenedDeposits.push([BigInt(tick), amount, shares, sharesPendingWithdrawal, depositor]);
        }
      });
    });
    return flattenedDeposits;
  }

  async function sourceLiquidity(
    amount: bigint,
    duration?: bigint = BigInt(30 * 86400),
    multiplier?: bigint = 1n
  ): Promise<bigint[]> {
    let nodes = await pool.liquidityNodes(0, MaxUint128);

    const ticks = [];

    const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
    const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

    /* Lookup duration index */
    const durations = await pool.durations();

    if (duration > durations[0]) {
      throw new Error("Invalid duration");
    }

    let durationIndex = durations.length - 1;
    for (; durationIndex > 0; durationIndex--) {
      if (duration <= durations[durationIndex]) break;
    }

    /* Filter nodes based on duration index */
    nodes = filterNodes(durationIndex, nodes);

    /* Randomize selection of a node from nodes of the same duration index */
    nodes = randomizeNodes(nodes);

    /* Sort nodes in ascending order of tick limit */
    nodes = sortNodes(nodes);

    let taken = 0n;

    for (const node of nodes) {
      const tickDecoded = Tick.decode(node.tick);
      const limit = tickDecoded.limit;
      const take = minBN(minBN(limit * multiplier - taken, node.available), amount - taken);
      if (take === 0n) continue;
      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== amount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);
    return ticks;
  }

  async function liquidityNodes(): Promise<bigint[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    let value = 0n;
    let available = 0n;
    let pending = 0n;
    let accrued = 0n;
    let accrualRate = 0n;
    for (let node of nodes) {
      value = value + node.value;
      available = available + node.available;
      pending = pending + node.pending;

      const [_, accrual] = await pool.liquidityNodeWithAccrual(node.tick);
      accrued = accrued + accrual.accrued;
      accrualRate = accrualRate + accrual.rate;
    }
    return [value, available, pending, accrued, accrualRate];
  }

  async function compareStates(): Promise<void> {
    consoleLog("\nComparing states...");
    /* Compare admin fee balance */
    expect(await pool.adminFeeBalance()).to.equal(poolModel.adminFeeBalance, "Admin fee balance unequal");

    /* Compare pool's token balance */
    expect(await tok1.balanceOf(await pool.getAddress())).to.equal(poolModel.tokenBalances, "Token balance unequal");

    /* Compare pool's collateral balance */
    expect(await nft1.balanceOf(await pool.getAddress())).to.equal(
      poolModel.collateralBalances,
      "Collateral balance unequal"
    );
    consoleLog(
      `Balances => admin fee: ${poolModel.adminFeeBalance}, token: ${poolModel.tokenBalances}, collateral: ${poolModel.collateralBalances}`
    );

    /* Compare top level liquidity */
    const [value, available, pending] = await liquidityNodes();
    expect(value).to.equal(poolModel.liquidity.value, "Value liquidity unequal");
    expect(available).to.equal(poolModel.liquidity.available, "Available liquidity unequal");
    expect(pending).to.equal(poolModel.liquidity.pending, "Pending liquidity unequal");
    consoleLog(`Top level liquidity => value: ${value}, available: ${available}, pending: ${pending}`);

    /* Compare shares to ERC20 deposit token balance */
    const flattenedDeposits = flattenDeposits(false);
    for (const deposit of flattenedDeposits) {
      const [tick, , shares, , depositor] = deposit;
      const tokenAddr = await pool.depositToken(BigInt(tick));
      const token = (await ethers.getContractAt(
        "ERC20DepositTokenImplementation",
        tokenAddr
      )) as ERC20DepositTokenImplementation;
      const erc20DepositTokenBalance = await token.balanceOf(await depositor.getAddress());
      expect(erc20DepositTokenBalance).to.equal(shares, "ERC20 deposit token balance unequal");
    }
  }

  async function getTransactionTimestamp(blockNumber: bigint): Promise<bigint> {
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
      consoleLog("Executing deposit()...");

      const depositor = accountDepositors[getRandomInteger(0, accountDepositors.length)];

      const tick = Tick.encode(
        CONFIG.ticks[getRandomInteger(0, CONFIG.ticks.length)],
        getRandomInteger(0, CONFIG.tickDurations.length),
        getRandomInteger(0, CONFIG.tickRates.length)
      );

      const amount = ethers.parseEther(
        getRandomInteger(CONFIG.depositAmounts[0], CONFIG.depositAmounts[CONFIG.depositAmounts.length - 1]).toString()
      );

      /* Check node is empty */
      const node = await pool.liquidityNode(tick);
      if (node.value + node.shares + node.available + node.pending !== 0n) {
        consoleLog("Node is not empty");
        return;
      }

      /* Execute deposit() on Pool */
      consoleLog(`Params => tick: ${tick}, amount: ${amount}`);

      const depositTx = await pool
        .connect(depositor)
        .multicall([
          pool.interface.encodeFunctionData("deposit", [tick, amount, 0]),
          pool.interface.encodeFunctionData("tokenize", [tick]),
        ]);

      const [value, available, pending] = await liquidityNodes();

      /* Get shares */
      const shares = (await extractEvent(depositTx, pool, "Deposited")).args.shares;

      /* Execute deposit() on PoolModel */
      poolModel.deposit(amount, value, available, pending);

      /* Update our helper variables */
      const depositorsDeposits =
        deposits.get(await depositor.getAddress()) ?? new Map<string, [bigint, bigint, bigint, SignerWithAddress]>();
      const tickDeposit = depositorsDeposits.get(tick.toString()) ?? [
        0n,
        0n,
        0n /* shares pending withdrawal */,
        depositor,
      ];
      const newTickDeposit: [bigint, bigint, bigint, SignerWithAddress] = [
        tickDeposit[0] + amount,
        tickDeposit[1] + shares,
        tickDeposit[2] /* shares pending withdrawal */,
        depositor,
      ];
      depositorsDeposits.set(tick.toString(), newTickDeposit);
      deposits.set(await depositor.getAddress(), depositorsDeposits);

      callStatistics["deposit"] += 1;
      consoleLog(`${await depositor.getAddress()}: Deposited ${amount} at tick ${tick}`);
    } catch (e) {
      consoleLog(`deposit() failed: ${e}`);
      throw e;
    }
  }

  async function borrow(): Promise<void> {
    try {
      consoleLog("Executing borrow()...");

      const borrower = accountBorrowers[getRandomInteger(0, accountBorrowers.length)];
      consoleLog(`Borrower: ${await borrower.getAddress()}`);

      const duration = BigInt(
        getRandomInteger(CONFIG.borrowDurations[0], CONFIG.borrowDurations[CONFIG.borrowDurations.length - 1])
      );

      const principal = ethers.parseEther(
        getRandomInteger(CONFIG.principals[0], CONFIG.principals[CONFIG.principals.length - 1]).toString()
      );

      /* Source liquidity */
      let _ticks: bigint[] = [];
      try {
        _ticks = await sourceLiquidity(principal, duration, 1n);
      } catch (err) {
        consoleLog("Insufficient liquidity");
        return;
      }

      /* Get max repayment */
      const maxRepayment = principal * 2n;

      let tokenId;

      /* Check if borrower has existing collaterals */
      const borrowerCollaterals = collateralsOwned.get(await borrower.getAddress());
      if (borrowerCollaterals === undefined || borrowerCollaterals.size === 0) {
        tokenId = collateralTokenId;
        /* Mint before borrowing */
        await nft1.mint(await borrower.getAddress(), tokenId);

        /* Increase collateralTokenId counter since we just minted one */
        collateralTokenId = collateralTokenId + 1n;
      } else {
        const _borrowerCollaterals = Array.from(borrowerCollaterals);
        tokenId = _borrowerCollaterals[Math.floor(Math.random() * _borrowerCollaterals.length)];

        /* Remove token id from borrower's collaterals */
        borrowerCollaterals.delete(tokenId);
        collateralsOwned.set(await borrower.getAddress(), borrowerCollaterals);
      }
      /* Simulate borrow to get repayment value */
      const repayment = await pool
        .connect(borrower)
        .borrow.staticCall(principal, duration, await nft1.getAddress(), tokenId, maxRepayment, _ticks, "0x");

      /* Execute borrow() on Pool */
      consoleLog(`Params => principal: ${principal}, duration: ${duration}, maxRepayment: ${maxRepayment}`);
      const borrowTx = await pool
        .connect(borrower)
        .borrow(principal, duration, await nft1.getAddress(), tokenId, maxRepayment, _ticks, "0x");

      /* Get block timestamp of borrow transaction */
      const blockTimestamp = BigInt(await getTransactionTimestamp(borrowTx.blockNumber));

      /* Get encoded loan receipt */
      const encodedLoanReceipt: string = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Execute borrow() on PoolModel */
      poolModel.borrow(
        await borrower.getAddress(),
        encodedLoanReceipt,
        repayment,
        principal,
        blockTimestamp + duration,
        duration
      );

      /* Store encode loan receipt and borrower's loan count */
      loans.push([borrower, tokenId, encodedLoanReceipt]);

      callStatistics["borrow"] += 1;
      consoleLog(`Borrowed ${principal} for ${duration} seconds`);
    } catch (e) {
      consoleLog(`borrow() failed: ${e}`);
      throw e;
    }
  }

  async function repay(): Promise<void> {
    try {
      consoleLog("Executing repay()...");

      /* Skip repay() if there are no existing loans */
      if (loans.length === 0) {
        consoleLog("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;
      consoleLog(`Borrower: ${await borrower.getAddress()}`);

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = BigInt(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (timestamp > maturity) {
        /* Liquidate expired loan */
        await liquidate(loan);

        return;
      }

      /* Go fast forward to a random timestamp that is before maturity */
      const randomTimestamp = getRandomBN(maturity - timestamp) + timestamp;
      await helpers.time.increaseTo(randomTimestamp);

      /* Execute repay() on Pool */
      const repayTx = await pool.connect(borrower).repay(encodedLoanReceipt);
      const [value, available, pending] = await liquidityNodes();

      /* Get block timestamp of repay transaction */
      const blockTimestamp = BigInt(await getTransactionTimestamp(repayTx.blockNumber));

      /* Get new encoded loan receipt */
      const repayment: bigint = (await extractEvent(repayTx, pool, "LoanRepaid")).args.repayment;

      /* Execute repay() on PoolModel */
      poolModel.repay(await borrower.getAddress(), blockTimestamp, encodedLoanReceipt, value, available, pending);

      /* Remove loan from internal records based on encoded loan receipt */
      removeLoanFromStorage(loans, encodedLoanReceipt);

      /* Indicate that borrower now has the collateral */
      const borrowerCollaterals: Set<bigint> = collateralsOwned.get(await borrower.getAddress()) ?? new Set();
      borrowerCollaterals.add(tokenId);
      collateralsOwned.set(await borrower.getAddress(), borrowerCollaterals);

      callStatistics["repay"] += 1;
      consoleLog(
        `Repaid ${repayment} for loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      consoleLog(`repay() failed: ${e}`);
      throw e;
    }
  }

  async function refinance(): Promise<void> {
    try {
      consoleLog("Executing refinance()...");

      const duration = BigInt(
        getRandomInteger(CONFIG.borrowDurations[0], CONFIG.borrowDurations[CONFIG.borrowDurations.length - 1])
      );
      const principal = ethers.parseEther(
        getRandomInteger(CONFIG.principals[0], CONFIG.principals[CONFIG.principals.length - 1]).toString()
      );

      /* Skip refinance() if there are no existing loans */
      if (loans.length === 0) {
        consoleLog("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;
      consoleLog(`Borrower: ${await borrower.getAddress()}`);

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = BigInt(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (timestamp > maturity) {
        /* Liquidate expired loan */
        await liquidate(loan);
        return;
      }

      /* Go fast forward to a random timestamp that is before maturity */
      const randomTimestamp = getRandomBN(maturity - timestamp - 1n) + timestamp;
      await helpers.time.increaseTo(randomTimestamp);

      /* Source liquidity */
      let _ticks: bigint[] = [];
      try {
        _ticks = await sourceLiquidity(principal, duration, 1);
      } catch (err) {
        consoleLog("Insufficient liquidity");
        return;
      }

      /* Get max repayment */
      const maxRepayment = principal * 2n;

      /* Simulate refinance to get repayment value */
      consoleLog(`Params => principal: ${principal}, duration: ${duration}, maxRepayment: ${maxRepayment}`);
      const repayment = await pool
        .connect(borrower)
        .refinance.staticCall(encodedLoanReceipt, principal, duration, maxRepayment, _ticks, "0x");

      /* Execute repay() on Pool */
      const refinanceTx = await pool
        .connect(borrower)
        .refinance(encodedLoanReceipt, principal, duration, maxRepayment, _ticks, "0x");
      const [value, available, pending] = await liquidityNodes();

      /* Get block timestamp of borrow transaction */
      const blockTimestamp = BigInt(await getTransactionTimestamp(refinanceTx.blockNumber));

      /* Get new encoded loan receipt */
      const newEncodedLoanReceipt: string = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Execute refinance() on PoolModel */
      poolModel.refinance(
        await borrower.getAddress(),
        blockTimestamp,
        value,
        available,
        pending,
        encodedLoanReceipt,
        newEncodedLoanReceipt,
        repayment,
        principal,
        blockTimestamp + duration,
        duration
      );

      /* Remove loan from internal records based on encoded loan receipt */
      removeLoanFromStorage(loans, encodedLoanReceipt);

      /* Store new encode loan receipt and borrower's loan count */
      loans.push([borrower, tokenId, newEncodedLoanReceipt]);

      callStatistics["refinance"] += 1;
      consoleLog(
        `Refinanced loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      consoleLog(`refinance() failed: ${e}`);
      throw e;
    }
  }

  async function redeem(): Promise<void> {
    try {
      consoleLog("Executing redeem()...");

      /* Randomly select existing deposit that has redemption pending = false */
      const flattenedDeposits = flattenDeposits(false);
      if (flattenedDeposits.length === 0) {
        consoleLog("No deposits with no redemption pending");
        return;
      }
      const [tick, amount, shares, sharesPendingWithdrawal, depositor] =
        flattenedDeposits[getRandomInteger(0, flattenedDeposits.length)];
      consoleLog(`Depositor: ${await depositor.getAddress()}`);

      /* If randomized, redeem at least 1 */
      const sharesRedeemAmount = CONFIG.isSharesRedeemAmountRandomized ? getRandomBN(shares - 1n) + 1n : shares;

      /* Execute redeem() on Pool */
      consoleLog(`Params => tick: ${tick}, shares: ${sharesRedeemAmount}`);
      const redemptionId = await pool.connect(depositor).redeem.staticCall(tick, sharesRedeemAmount);
      await pool.connect(depositor).redeem(tick, sharesRedeemAmount);

      const [value, available, pending] = await liquidityNodes();

      /* Execute redeem() on PoolModel */
      poolModel.redeem(value, available, pending);

      /* Update our helper variables */
      const depositorsDeposits = deposits.get(await depositor.getAddress());

      if (depositorsDeposits === undefined) {
        throw new Error("depositorDeposits should exists");
      }

      /* Set redemption pending to true */
      const newTickDeposit: [bigint, bigint, bigint, SignerWithAddress] = [
        amount,
        shares - sharesRedeemAmount,
        sharesPendingWithdrawal + sharesRedeemAmount,
        depositor,
      ];
      depositorsDeposits.set(tick.toString(), newTickDeposit);
      deposits.set(await depositor.getAddress(), depositorsDeposits);

      /* Add redemption ID */
      const depositorTickRedemption = redemptionIds.get(await depositor.getAddress()) ?? new Map<string, bigint[]>();
      const depositorTickRedemptionIds = depositorTickRedemption.get(tick) ?? [];
      depositorTickRedemptionIds.push(redemptionId);
      depositorTickRedemption.set(tick, depositorTickRedemptionIds);
      redemptionIds.set(await depositor.getAddress(), depositorTickRedemption);

      callStatistics["redeem"] += 1;
      consoleLog(`${await depositor.getAddress()}: Redeemed ${sharesRedeemAmount} shares at tick ${tick}`);
    } catch (e) {
      consoleLog(`redeem() failed: ${e}`);
      throw e;
    }
  }

  async function withdraw(): Promise<void> {
    try {
      consoleLog("Executing withdraw()...");

      /* Randomly select existing deposit that has redemption pending = true */
      const flattenedDeposits = flattenDeposits(true);
      if (flattenedDeposits.length === 0) {
        consoleLog("No deposits with pending redemption");
        return;
      }

      const [tick, amount, shares, sharesPendingWithdrawal, depositor] =
        flattenedDeposits[getRandomInteger(0, flattenedDeposits.length)];

      /* Simulate withdrawal is possible */
      const depositorTickRedemption = redemptionIds.get(await depositor.getAddress()) ?? new Map<string, bigint>();
      const depositorTickRedemptionIds = depositorTickRedemption.get(tick) ?? [];

      if (depositorTickRedemptionIds.length === 0) {
        throw new Error("depositorTickRedemptionIds should exists");
      }
      const redemptionId = depositorTickRedemptionIds[0];
      const redemptionAvailable = await pool.redemptionAvailable(await depositor.getAddress(), tick, redemptionId);

      /* Delete redemption ID if entire redemption is available */
      const redemption = await pool.redemptions(await depositor.getAddress(), tick, redemptionId);
      if (redemption.pending === redemptionAvailable[0]) {
        depositorTickRedemption.set(tick, depositorTickRedemptionIds.slice(1));
        redemptionIds.set(await depositor.getAddress(), depositorTickRedemption);
      }

      /* Skip withdraw if shares and amount are both 0 */
      if (redemptionAvailable[0] === 0 && redemptionAvailable[1] === 0) {
        return;
      }

      /* Execute withdraw() on Pool */
      consoleLog(`Params => tick: ${tick}`);

      const withdrawTx = await pool.connect(depositor).withdraw(tick, redemptionId);

      /* Get shares */
      const _shares = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares;

      /* Get amount */
      const _amount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;

      /* Execute withdraw() on PoolModel */
      poolModel.withdraw(_amount);

      /* Update our helper variables */
      const depositorsDeposits = deposits.get(await depositor.getAddress());

      if (depositorsDeposits === undefined) {
        throw new Error("depositorDeposits should exists");
      }

      const newAmount = amount - _amount;
      const newSharesPendingWithdrawal = sharesPendingWithdrawal - _shares;

      /* Remove deposit record if fully repaid and no outstanding shares to be redeemed */
      if (newSharesPendingWithdrawal === 0n && shares === 0n) {
        depositorsDeposits.delete(tick.toString());
      } else {
        /* Else, update depositor record */
        const newTickDeposit: [bigint, bigint, bigint, SignerWithAddress] = [
          newAmount,
          shares,
          newSharesPendingWithdrawal,
          depositor,
        ];
        depositorsDeposits.set(tick.toString(), newTickDeposit);
      }
      deposits.set(await depositor.getAddress(), depositorsDeposits);

      callStatistics["withdraw"] += 1;
      consoleLog(`${await depositor.getAddress()}: Withdrew ${_shares} shares and ${amount} tokens at tick ${tick}`);
    } catch (e) {
      consoleLog(`withdraw() failed: ${e}`);
      throw e;
    }
  }

  async function liquidate(expiredLoan: any = null): Promise<void> {
    try {
      consoleLog("Executing liquidate()...");

      /* Skip liquidate() if there are no existing loans */
      if (loans.length === 0) {
        consoleLog("No existing loans exists");
        return;
      }

      /* Randomly select existing loans */
      const loan = expiredLoan ?? loans[getRandomInteger(0, loans.length)];

      const [borrower, tokenId, encodedLoanReceipt] = loan;

      /* Get previous block timestamp */
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      const timestamp = BigInt(block.timestamp);

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);
      const maturity = decodedLoanReceipt.maturity;

      /* Check if expired */
      if (maturity >= timestamp) {
        /* Fast forward to one second after maturity */
        await helpers.time.increaseTo(maturity + 1n);
      }

      /* Execute liquidate on Pool */
      await pool.liquidate(encodedLoanReceipt);

      /* Execute liquidate on PoolModel */
      poolModel.liquidate();

      /* Update our helper variables */
      removeLoanFromStorage(loans, encodedLoanReceipt);
      defaultedLoans.push([borrower, tokenId, encodedLoanReceipt]);

      callStatistics["liquidate"] += 1;
      consoleLog(
        `Liquidated loan ${encodedLoanReceipt.slice(0, 10)}...${encodedLoanReceipt.slice(
          encodedLoanReceipt.length - 10,
          encodedLoanReceipt.length
        )}`
      );
    } catch (e) {
      consoleLog(`liquidate() failed: ${e}`);
      throw e;
    }
  }

  async function onCollateralLiquidated(): Promise<void> {
    try {
      consoleLog("Executing onCollateralLiquidated()...");

      /* Skip onCollateralLiquidated() if there are no existing loans */
      if (defaultedLoans.length === 0) {
        consoleLog("No existing defaulted loans exists");
        return;
      }

      /* Randomly select existing a defaulted loans */
      const defaultedLoan = defaultedLoans[getRandomInteger(0, defaultedLoans.length)];
      const [borrower, tokenId, encodedLoanReceipt] = defaultedLoan;

      /* Decode loan receipt to get maturity */
      const decodedLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Proceeds ratio */
      const proceedsRatio = BigInt(
        CONFIG.liquidationProceedsRatio[getRandomInteger(0, CONFIG.liquidationProceedsRatio.length)]
      );

      /* Compute proceeds */
      const proceeds = (decodedLoanReceipt.repayment * proceedsRatio) / 10000n;

      /* Execute liquidate on Pool */
      consoleLog(`Params => proceeds: ${proceeds}`);
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          decodedLoanReceipt.collateralToken,
          decodedLoanReceipt.collateralTokenId,
          "0x",
          encodedLoanReceipt
        );
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          decodedLoanReceipt.collateralToken,
          decodedLoanReceipt.collateralTokenId,
          "0x",
          encodedLoanReceipt,
          proceeds
        );
      const [value, available, pending] = await liquidityNodes();

      /* Execute liquidate on PoolModel */
      poolModel.onCollateralLiquidated(
        await borrower.getAddress(),
        encodedLoanReceipt,
        proceeds,
        value,
        available,
        pending
      );

      /* Update our helper variables */
      removeLoanFromStorage(defaultedLoans, encodedLoanReceipt);

      callStatistics["onCollateralLiquidated"] += 1;
      consoleLog(`Restored liquidation proceeds of ${proceeds}`);
    } catch (e) {
      consoleLog(`onCollateralLiquidated() failed: ${e}`);
      throw e;
    }
  }

  describe("#test", async function () {
    it("integration test", async function () {
      for (let i = 0; i < callSequence.length; i++) {
        consoleLog("\n--------------\n");
        const functionCall = callSequence[i];
        await functionCall();
        await compareStates();
      }
    });
  });

  after("integration test report", async function () {
    /* Repay all outstanding loans */
    while (loans.length != 0) {
      await repay();
    }

    /* Restore all outstanding defaulted loans */
    while (defaultedLoans.length != 0) {
      await onCollateralLiquidated();
    }

    /* Check that accrued and accrualRate are 0 */
    const [value, available, pending, accrued, accrualRate] = await liquidityNodes();
    expect(accrued).to.equal(0, "Accrued is not 0");
    expect(accrualRate).to.equal(0, "AccrualRate is not 0");

    consoleLog("\nSuccessful calls:");
    consoleLog(callStatistics);
  });
});
