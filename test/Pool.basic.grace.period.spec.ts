import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
  WeightedRateGracePeriodRangedCollectionPool,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { BigIntMath } from "./helpers/Math";
import { Tick } from "./helpers/Tick";

describe("Pool Basic Grace Period", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: Pool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateGracePeriodRangedCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("10000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.waitForDeployment();

    /* Deploy external collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
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

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      []
    )) as Pool;
    await poolImpl.waitForDeployment();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      await poolImpl.getAddress(),
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256", "uint256", "address", "address", "uint64[]", "uint64[]", "uint256", "uint256"],
          [
            await nft1.getAddress(),
            0,
            1000,
            await tok1.getAddress(),
            ethers.ZeroAddress,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
            30 * 86400,
            FixedPoint.normalizeRate("0.05"),
          ]
        ),
      ])
    );
    await proxy.waitForDeployment();
    pool = (await ethers.getContractAt("Pool", await proxy.getAddress())) as Pool;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(await depositor.getAddress(), ethers.parseEther("1000"));
      await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mint(await accountBorrower.getAddress(), 123);
    await nft1.mint(await accountBorrower.getAddress(), 124);
    await nft1.mint(await accountBorrower.getAddress(), 125);

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation name", async function () {
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateGracePeriodRangedCollectionPool");
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("getters", async function () {
    it("returns expected grace period duration", async function () {
      expect(await pool.gracePeriodDuration()).to.equal(30 * 86400);
    });

    it("returns expected grace period interest rate per second", async function () {
      expect(await pool.gracePeriodRate()).to.equal(FixedPoint.normalizeRate("0.05"));
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_LIMITS = 35;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    const pool_ = (await ethers.getContractAt(
      "WeightedRateGracePeriodRangedCollectionPool",
      await pool.getAddress()
    )) as WeightedRateGracePeriodRangedCollectionPool;

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool_.setDepositWhitelist(Tick.encode(limit), accountDepositors[0], true);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10000n)) / 10000n;
    }
  }

  async function amendLiquidity(ticks: bigint[]): Promise<bigint[]> {
    const pool_ = (await ethers.getContractAt(
      "WeightedRateGracePeriodRangedCollectionPool",
      await pool.getAddress()
    )) as WeightedRateGracePeriodRangedCollectionPool;

    /* Replace four ticks with alternate duration and rates */
    ticks[3] = Tick.encode(Tick.decode(ticks[3]).limit, 2, 0);
    ticks[5] = Tick.encode(Tick.decode(ticks[5]).limit, 1, 1);
    ticks[7] = Tick.encode(Tick.decode(ticks[7]).limit, 1, 1);
    ticks[9] = Tick.encode(Tick.decode(ticks[9]).limit, 0, 2);

    await pool_.setDepositWhitelist(ticks[3], accountDepositors[0], true);
    await pool_.setDepositWhitelist(ticks[5], accountDepositors[0], true);
    await pool_.setDepositWhitelist(ticks[7], accountDepositors[0], true);
    await pool_.setDepositWhitelist(ticks[9], accountDepositors[0], true);

    await pool.connect(accountDepositors[0]).deposit(ticks[3], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[5], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[7], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[9], FixedPoint.from("25"), 0);
    return ticks;
  }

  async function sourceLiquidity(
    amount: bigint,
    multiplier?: bigint = 1n,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<bigint[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    let taken = 0n;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit === 0n) continue;

      const take = minBN(minBN(limit * multiplier - taken, node.available), amount - taken);
      if (take === 0n) break;

      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== amount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
  }

  async function setupImpairedTick(): Promise<void> {
    /* Get pool contract */
    const pool_ = (await ethers.getContractAt(
      "WeightedRateGracePeriodRangedCollectionPool",
      await pool.getAddress()
    )) as WeightedRateGracePeriodRangedCollectionPool;

    /* Set deposit whitelist */
    await pool_.setDepositWhitelist(Tick.encode("10"), accountDepositors[0], true);

    /* Create deposit at 10 ETH tick */
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);

    /* Create expired loan taking 5 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("5"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt
      );

    /* Liquidate collateral and process liquidation for 0.20 ETH */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt,
        FixedPoint.from("0.20")
      );

    /* 10 ETH tick price is 0.20 ETH / 5.0 shares = 0.04 */
  }

  async function setupInsolventTick(): Promise<void> {
    /* Get pool contract */
    const pool_ = (await ethers.getContractAt(
      "WeightedRateGracePeriodRangedCollectionPool",
      await pool.getAddress()
    )) as WeightedRateGracePeriodRangedCollectionPool;

    /* Set deposit whitelist */
    await pool_.setDepositWhitelist(Tick.encode("5"), accountDepositors[0], true);
    await pool_.setDepositWhitelist(Tick.encode("10"), accountDepositors[0], true);
    await pool_.setDepositWhitelist(Tick.encode("15"), accountDepositors[0], true);

    /* Create deposits at 5 ETH, 10 ETH, and 15 ETH ticks */
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("5"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

    /* Create expired loan taking 15 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("15"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt
      );

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt,
        FixedPoint.from("5")
      );

    /* Ticks 10 ETH and 15 ETH are now insolvent */
  }

  async function createActiveLoan(principal: bigint, duration?: number = 30 * 86400): Promise<[string, string]> {
    const tokenId =
      (await nft1.ownerOf(123)) === (await accountBorrower.getAddress())
        ? 123
        : (await nft1.ownerOf(124)) === (await accountBorrower.getAddress())
          ? 124
          : 125;

    const ticks = await sourceLiquidity(principal);

    const repayment = await pool.quote(principal, duration, await nft1.getAddress(), tokenId, ticks, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, await nft1.getAddress(), tokenId, repayment, ticks, "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createExpiredLoan(principal: bigint): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Wait for loan expiration */
    const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
    await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

    return [loanReceipt, loanReceiptHash];
  }

  async function createRepaidLoan(principal: bigint): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Repay */
    await pool.connect(accountBorrower).repay(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  async function createLiquidatedLoan(principal: bigint): Promise<bigint> {
    /* Create expired loan */
    const [loanReceipt, loanReceiptHash] = await createExpiredLoan(principal);

    /* Liquidate */
    await pool.connect(accountLender).liquidate(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  /****************************************************************************/
  /* Deposit API */
  /****************************************************************************/

  describe("#deposit", async function () {
    it("deposits reverts if not whitelisted", async function () {
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("25"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });
  });

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays loan at maturity", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment,
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = 0n;
      let totalUsed = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
        totalPending = totalPending + nodeReceipt.pending;
        totalUsed = totalUsed + nodeReceipt.used;
      }
    });

    it("repays with admin fee", async function () {
      /* set admin fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment - decodedLoanReceipt.principal + decodedLoanReceipt.principal;

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: repayment,
      });

      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 124,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("repays with admin fee and fee share", async function () {
      /* set admin fee */
      await pool.setAdminFee(4400, accounts[2].address, 5000);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment;

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: repayment,
      });

      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 124,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    for (const [description, timeElapsed] of [
      ["one third", (30 * 86400) / 3],
      ["8 / 9ths", (8 * 30 * 86400) / 9],
      ["1 second", 1],
    ]) {
      it(`repays loan after ${description} of loan duration has elasped`, async function () {
        const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));
        const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

        /* Repay */
        await helpers.time.setNextBlockTimestamp(
          decodedLoanReceipt.maturity - decodedLoanReceipt.duration + BigInt(timeElapsed)
        );
        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        /* Calculate proration */
        const repayTxTimestamp = BigInt((await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp);
        const proration =
          FixedPoint.from(repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)) /
          decodedLoanReceipt.duration;

        /* Calculate prorated repayment amount */
        const repayment =
          ((decodedLoanReceipt.repayment - decodedLoanReceipt.principal) * proration) / ethers.WeiPerEther +
          decodedLoanReceipt.principal;

        /* Validate events */
        await expectEvent(repayTx, tok1, "Transfer", {
          from: await accountBorrower.getAddress(),
          to: await pool.getAddress(),
          value: repayment,
        });

        await expectEvent(repayTx, nft1, "Transfer", {
          from: await pool.getAddress(),
          to: await accountBorrower.getAddress(),
          tokenId: 123,
        });

        await expectEvent(repayTx, pool, "LoanRepaid", {
          loanReceiptHash,
          repayment,
        });

        /* Validate state */
        expect(await pool.loans(loanReceiptHash)).to.equal(2);

        /* Validate ticks */
        let totalDelta = 0n;
        for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
          const delta = ((nodeReceipt.pending - nodeReceipt.used) * proration) / ethers.WeiPerEther;
          const node = await pool.liquidityNode(nodeReceipt.tick);
          expect(node.value).to.equal(FixedPoint.from("25") + delta);
          expect(node.available).to.equal(FixedPoint.from("25") + delta);
          expect(node.pending).to.equal(0n);
          totalDelta = totalDelta + delta;
        }
      });
    }

    it("repays after grace period", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + BigInt(30 * 86400) - BigInt(1));

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      const baseInterest =
        ((decodedLoanReceipt.repayment - decodedLoanReceipt.principal) * BigInt(30 * 86400)) /
        decodedLoanReceipt.duration;
      const gracePeriodInterest =
        (decodedLoanReceipt.principal * FixedPoint.normalizeRate("0.05") * BigInt(30 * 86400)) / BigInt(1e18);
      const totalGraceInterest = baseInterest + gracePeriodInterest;

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment + totalGraceInterest,
      });

      /* Validate ticks and liquidity statistics */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
      }

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + BigInt(37 * 86400) - BigInt(1));

      /* Deposit 1 ether into each tick */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        await pool.connect(accountDepositors[0]).deposit(nodeReceipt.tick, FixedPoint.from("1"), 0);
      }

      /* Validate ticks and liquidity statistics */
      let actualGracePeriodInterest = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("26") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.gt(value);
        expect(node.available).to.gt(value);
        expect(node.value).to.equal(node.available);
        expect(node.pending).to.equal(0n);
        actualGracePeriodInterest = actualGracePeriodInterest + node.value - value;
      }

      expect(actualGracePeriodInterest).to.closeTo(totalGraceInterest, "41000");
    });

    it("can repay after grace period and prior to liquidation", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const repayment = decodedLoanReceipt.repayment;

      await helpers.time.increaseTo(decodedLoanReceipt.maturity);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      const baseInterest = (decodedLoanReceipt.repayment - decodedLoanReceipt.principal) / decodedLoanReceipt.duration;
      const gracePeriodInterest = (decodedLoanReceipt.principal * FixedPoint.normalizeRate("0.05")) / BigInt(1e18);
      const totalGraceInterest = baseInterest + gracePeriodInterest;

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: repayment + totalGraceInterest,
      });

      /* Validate ticks and liquidity statistics */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
      }
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan during grace period and same principal", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity + 15n * 86400n);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      const baseInterest =
        ((decodedLoanReceipt.repayment - decodedLoanReceipt.principal) * BigInt(15 * 86400)) /
        decodedLoanReceipt.duration;
      const gracePeriodInterest =
        (decodedLoanReceipt.principal * FixedPoint.normalizeRate("0.05") * BigInt(15 * 86400)) / BigInt(1e18);
      const totalGraceInterest = baseInterest + gracePeriodInterest;

      /* Validate events and repayments */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment - decodedLoanReceipt.principal + totalGraceInterest,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment + totalGraceInterest,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");
    });

    it("refinance loan at maturity with admin fee and same principal", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(4400, accounts[2].address, 5000);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment - decodedLoanReceipt.principal,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expectEvent(refinanceTx, pool, "AdminFeeShareTransferred", {
        feeShareRecipient: accounts[2].address,
        feeShareAmount: adminFee / 2n,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.closeTo(adminFee / 2n, "1");
    });

    it("refinance loan at maturity with admin fee and smaller principal (1 ETH less)", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal - FixedPoint.from("1"),
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(15);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment - decodedNewLoanReceipt.principal,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.equal(adminFee);
    });

    it("refinance loan at maturity with admin fee and bigger principal (1 ETH more)", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal + FixedPoint.from("1"),
          15 * 86400,
          FixedPoint.from("27"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: decodedNewLoanReceipt.principal - decodedLoanReceipt.repayment,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.equal(adminFee);
    });
  });

  /****************************************************************************/
  /* Admin Grace Period API */
  /****************************************************************************/

  describe("#setGracePeriod", async function () {
    it("admin set grace period successfully", async function () {
      const pool_ = (await ethers.getContractAt(
        "WeightedRateGracePeriodRangedCollectionPool",
        await pool.getAddress()
      )) as WeightedRateGracePeriodRangedCollectionPool;
      const tx = await pool_.setGracePeriod(30 * 86400, FixedPoint.normalizeRate("0.05"));

      /* Validate rate was successfully set */
      expect(await pool.gracePeriodDuration()).to.equal(30 * 86400);
      expect(await pool.gracePeriodRate()).to.equal(FixedPoint.normalizeRate("0.05"));
    });
  });

  /****************************************************************************/
  /* Admin Deposit Whitelist API */
  /****************************************************************************/

  describe("#setDepositWhitelist", async function () {
    it("admin set deposit whitelist successfully", async function () {
      const pool_ = (await ethers.getContractAt(
        "WeightedRateGracePeriodRangedCollectionPool",
        await pool.getAddress()
      )) as WeightedRateGracePeriodRangedCollectionPool;
      const tx = await pool_.setDepositWhitelist(1, accountDepositors[0], true);

      /* Validate rate was successfully set */
      expect(await pool_.isDepositWhitelisted(accountDepositors[0], 1)).to.equal(true);
      expect(await pool_.isDepositWhitelisted(accountDepositors[1], 1)).to.equal(false);
    });
  });
});
