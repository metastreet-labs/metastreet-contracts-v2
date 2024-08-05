import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestERC1155,
  TestProxy,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  EnglishAuctionCollateralLiquidator,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
  ERC1155CollateralWrapper,
  ERC20DepositTokenImplementation,
  WeightedRateCollectionPool,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint.ts";
import { Tick } from "./helpers/Tick";
import { MerkleTree } from "./helpers/MerkleTree";

describe("Pool Gas", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let externalCollateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: WeightedRateCollectionPool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let bundleCollateralWrapper: BundleCollateralWrapper;
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
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("20000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.waitForDeployment();

    /* Deploy external collateral liquidator implementation */
    const externalCollateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await externalCollateralLiquidatorImpl.waitForDeployment();

    /* Deploy external collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      await externalCollateralLiquidatorImpl.getAddress(),
      externalCollateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.waitForDeployment();
    externalCollateralLiquidator = (await ethers.getContractAt(
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
      await externalCollateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      [await bundleCollateralWrapper.getAddress()]
    )) as Pool;
    await poolImpl.waitForDeployment();

    /* Deploy pool using external collateral liquidator */
    proxy = await testProxyFactory.deploy(
      await poolImpl.getAddress(),
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address[]", "address", "address", "uint64[]", "uint64[]"],
          [
            [await nft1.getAddress()],
            await tok1.getAddress(),
            ethers.ZeroAddress,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.waitForDeployment();
    pool = (await ethers.getContractAt(
      "WeightedRateCollectionPool",
      await proxy.getAddress()
    )) as WeightedRateCollectionPool;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await externalCollateralLiquidator.grantRole(
      await externalCollateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(await depositor.getAddress(), ethers.parseEther("3000"));
      await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(await externalCollateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Mint NFT to borrower */
    for (let i = 123; i < 123 + 20; i++) {
      await nft1.mint(await accountBorrower.getAddress(), i);
    }

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

    /* Approve bundle to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await bundleCollateralWrapper.getAddress(), true);

    /* Approve pool to transfer bundle NFT */
    await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");

  function constructMerkleNodeIds(startId: number, count: number): bigint[][] {
    const nodes = [];
    for (let i = startId; i < startId + count; i++) {
      nodes.push([BigInt(i)]);
    }

    return nodes;
  }

  async function setupLiquidity(pool: Pool): Promise<void> {
    const NUM_TICKS = 16;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_TICKS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("80"), 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10000n)) / 10000n;
    }
  }

  async function sourceLiquidity(pool: Pool, amount: bigint, multiplier?: bigint = 1n): Promise<bigint[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
    const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

    let taken = 0n;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      const take = minBN(minBN(limit * multiplier - taken, node.available), amount - taken);
      if (take === 0n) continue;
      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== amount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
  }

  async function setupInsolventTick(): Promise<void> {
    /* Create two deposits at 10 ETH and 20 ETH ticks */
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("5"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

    /* Create expired loan taking 15 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("15"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await externalCollateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(await pool.getAddress(), loanReceipt);

    /* Liquidate collateral and process liquidation */
    await externalCollateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(await pool.getAddress(), loanReceipt, FixedPoint.from("5"));
  }

  /****************************************************************************/
  /* Gas Tracking */
  /****************************************************************************/

  const gasReport: [string, number][] = [];

  /****************************************************************************/
  /* Deposit API */
  /****************************************************************************/

  describe("#deposit", async function () {
    it("deposit (new tick)", async function () {
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(248000);
    });

    it("deposit (existing tick)", async function () {
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(110000n);
    });

    it("deposit (existing deposit)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;

      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(95000);
    });

    it("multicall deposit + tokenize (new tick)", async function () {
      const depositTx = await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("deposit", [Tick.encode("10"), FixedPoint.from("1"), 0]),
          pool.interface.encodeFunctionData("tokenize", [Tick.encode("10")]),
        ]);

      const gasUsed = (await depositTx.wait()).gasUsed;

      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(470000);
    });

    it("deposit (existing tick, tokenized)", async function () {
      await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("deposit", [Tick.encode("10"), FixedPoint.from("1"), 0]),
          pool.interface.encodeFunctionData("tokenize", [Tick.encode("10")]),
        ]);

      const depositTx = await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;

      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(122000);
    });

    it("deposit (existing deposit, tokenized)", async function () {
      await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("deposit", [Tick.encode("10"), FixedPoint.from("1"), 0]),
          pool.interface.encodeFunctionData("tokenize", [Tick.encode("10")]),
        ]);

      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;

      gasReport.push([this.test.title, gasUsed]);
      expect(gasUsed).to.be.lt(105000);
    });
  });

  describe("#redeem", async function () {
    it("redeem (partial)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(130000);
    });
    it("redeem (entire)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const shares = (await pool.deposits(accountDepositors[0].address, Tick.encode("10"))).shares;

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), shares);

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(135000);
    });
  });

  describe("#withdraw", async function () {
    it("withdraw", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const shares = (await pool.deposits(accountDepositors[0].address, Tick.encode("10"))).shares;

      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), shares);

      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      const gasUsed = (await withdrawTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(67000);
    });
  });

  describe("#rebalance", async function () {
    it("multicall redeem + rebalance (new tick)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const shares = (await pool.deposits(accountDepositors[0].address, Tick.encode("10"))).shares;

      const redeemRebalanceTx = await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("redeem", [Tick.encode("10"), shares]),
          pool.interface.encodeFunctionData("rebalance", [Tick.encode("10"), Tick.encode("15"), 0, 0]),
        ]);

      const gasUsed = (await redeemRebalanceTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(275000);
    });

    it("multicall redeem + rebalance (existing tick)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const shares = (await pool.deposits(accountDepositors[0].address, Tick.encode("10"))).shares;

      await pool.connect(accountDepositors[1]).deposit(Tick.encode("15"), FixedPoint.from("1"), 0);

      const redeemRebalanceTx = await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("redeem", [Tick.encode("10"), shares]),
          pool.interface.encodeFunctionData("rebalance", [Tick.encode("10"), Tick.encode("15"), 0, 0]),
        ]);

      const gasUsed = (await redeemRebalanceTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(195000);
    });
  });

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity(pool);
    });

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("15"), 10, 357000],
      [FixedPoint.from("25"), 16, 485000],
    ]) {
      it(`borrow (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            "0x"
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });

      it(`borrow (single, existing, ${numTicks} ticks)`, async function () {
        /* Mint and transfer NFT to pool */
        await nft1.mint(await accountBorrower.getAddress(), 150);
        await nft1
          .connect(accountBorrower)
          .transferFrom(await accountBorrower.getAddress(), await pool.getAddress(), 150);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            "0x"
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas - 15000);
      });

      it(`borrow with v1 delegation (single, existing, ${numTicks} ticks)`, async function () {
        /* Mint and transfer NFT to pool */
        await nft1.mint(await accountBorrower.getAddress(), 150);
        await nft1
          .connect(accountBorrower)
          .transferFrom(await accountBorrower.getAddress(), await pool.getAddress(), 150);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);
        expect(gasUsed).to.be.lt(maxGas + 258000 - 14000);
      });

      it(`borrow with v2 delegation (single, existing, ${numTicks} ticks)`, async function () {
        /* Mint and transfer NFT to pool */
        await nft1.mint(await accountBorrower.getAddress(), 150);
        await nft1
          .connect(accountBorrower)
          .transferFrom(await accountBorrower.getAddress(), await pool.getAddress(), 150);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas + 185000 - 14000);
      });
    }

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 385000],
      [FixedPoint.from("250"), 16, 512000],
    ]) {
      it(`borrow (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10n);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await bundleCollateralWrapper.getAddress(),
            bundleTokenId,
            BigInt(principal) + FixedPoint.from("10"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });

      it(`borrow (bundle of 10, existing, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 3 */
        const mintTx1 = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [135, 136, 137]);
        const bundleTokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

        /* Transfer bundle to pool */
        await bundleCollateralWrapper
          .connect(accountBorrower)
          .transferFrom(await accountBorrower.getAddress(), await pool.getAddress(), bundleTokenId1);

        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10n);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await bundleCollateralWrapper.getAddress(),
            bundleTokenId,
            BigInt(principal) + FixedPoint.from("10"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas - 15000);
      });
    }
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity(pool);
    });

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("15"), 10, 338000],
      [FixedPoint.from("25"), 16, 480000],
    ]) {
      it(`repay (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            "0x"
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        const gasUsed = (await repayTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });

      it(`repay with v1 delegation (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        const gasUsed = (await repayTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas + 25000);
      });

      it(`repay with v2 delegation (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86700);

        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        const gasUsed = (await repayTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas + 35000);
      });
    }

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 360000],
      [FixedPoint.from("250"), 16, 502000],
    ]) {
      it(`repay (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10n);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await bundleCollateralWrapper.getAddress(),
            bundleTokenId,
            BigInt(principal) + FixedPoint.from("10"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        const gasUsed = (await repayTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity(pool);
    });

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("15"), 10, 478000],
      [FixedPoint.from("25"), 16, 690000],
    ]) {
      it(`refinance (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            "0x"
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const refinanceTx = await pool
          .connect(accountBorrower)
          .refinance(loanReceipt, principal, 30 * 86400, BigInt(principal) + FixedPoint.from("1"), ticks, "0x");

        const gasUsed = (await refinanceTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 510000],
      [FixedPoint.from("250"), 16, 722000],
    ]) {
      it(`refinance (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10n);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await bundleCollateralWrapper.getAddress(),
            bundleTokenId,
            BigInt(principal) + FixedPoint.from("10"),
            ticks,
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const refinanceTx = await pool
          .connect(accountBorrower)
          .refinance(loanReceipt, principal, 30 * 86400, BigInt(principal) + FixedPoint.from("10"), ticks, "0x");

        const gasUsed = (await refinanceTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }
  });

  describe("#liquidate", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity(pool);
    });

    it("liquidate (single, external, 16 ticks)", async function () {
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(pool, FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(195000);
    });

    it("liquidate (bundle of 10, external, 16 ticks)", async function () {
      /* Mint bundle of 10 */
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("250"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          FixedPoint.from("260"),
          await sourceLiquidity(pool, FixedPoint.from("250"), 10n),
          ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(200000);
    });

    describe("english auction collateral liquidator", async function () {
      let poolEACLImpl: Pool;
      let poolEACL: Pool;
      let englishAuctionCollateralLiquidator: EnglishAuctionCollateralLiquidator;
      let singleLoanReceipt: string;
      let bundleLoanReceipt: string;
      let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

      beforeEach("setup pool", async function () {
        const testProxyFactory = await ethers.getContractFactory("TestProxy");
        const englishAuctionCollateralLiquidatorFactory = await ethers.getContractFactory(
          "EnglishAuctionCollateralLiquidator"
        );
        const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
        const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
          "LiquidityLogic",
          "DepositLogic",
          "BorrowLogic",
          "ERC20DepositTokenFactory",
        ]);

        /* Deploy english auction collateral liquidator implementation */
        const englishAuctionCollateralLiquidatorImpl = await englishAuctionCollateralLiquidatorFactory.deploy([
          await bundleCollateralWrapper.getAddress(),
        ]);
        await englishAuctionCollateralLiquidatorImpl.waitForDeployment();

        /* Deploy english auction collateral liquidator */
        let proxy = await testProxyFactory.deploy(
          await englishAuctionCollateralLiquidatorImpl.getAddress(),
          englishAuctionCollateralLiquidatorImpl.interface.encodeFunctionData("initialize", [
            BigInt(86400),
            BigInt(60 * 10),
            BigInt(60 * 20),
            BigInt(199),
          ])
        );
        await proxy.waitForDeployment();

        englishAuctionCollateralLiquidator = (await ethers.getContractAt(
          "EnglishAuctionCollateralLiquidator",
          await proxy.getAddress()
        )) as EnglishAuctionCollateralLiquidator;

        /* Deploy ERC20 despoit token implementation */
        erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
        await erc20DepositTokenImpl.waitForDeployment();

        /* Deploy pool implementation */
        poolEACLImpl = (await poolImplFactory.deploy(
          await englishAuctionCollateralLiquidator.getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          await erc20DepositTokenImpl.getAddress(),
          [await bundleCollateralWrapper.getAddress()]
        )) as Pool;
        await poolEACLImpl.waitForDeployment();

        /* Deploy poolEACL using english auction collateral liquidator */
        proxy = await testProxyFactory.deploy(
          await poolEACLImpl.getAddress(),
          poolEACLImpl.interface.encodeFunctionData("initialize", [
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["address[]", "address", "address", "uint64[]", "uint64[]"],
              [
                [await nft1.getAddress()],
                await tok1.getAddress(),
                ethers.ZeroAddress,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.waitForDeployment();
        poolEACL = (await ethers.getContractAt("Pool", await proxy.getAddress())) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(await poolEACL.getAddress(), ethers.MaxUint256);
          await tok1
            .connect(depositor)
            .approve(await englishAuctionCollateralLiquidator.getAddress(), ethers.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft1.connect(accountBorrower).setApprovalForAll(await poolEACL.getAddress(), true);
        /* Approve pool to transfer token (for repayment) */
        await tok1.connect(accountBorrower).approve(await poolEACL.getAddress(), ethers.MaxUint256);
        /* Approve pool to transfer bundle NFT */
        await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(await poolEACL.getAddress(), true);

        await setupLiquidity(poolEACL);
      });

      beforeEach("borrow", async function () {
        /* Borrow single and expire */
        const borrowSingleTx = await poolEACL
          .connect(accountBorrower)
          .borrow(
            ethers.parseEther("25"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            ethers.parseEther("26"),
            await sourceLiquidity(poolEACL, ethers.parseEther("25")),
            "0x"
          );
        singleLoanReceipt = (await extractEvent(borrowSingleTx, poolEACL, "LoanOriginated")).args.loanReceipt;
        await helpers.time.increaseTo((await pool.decodeLoanReceipt(singleLoanReceipt)).maturity + 1n);

        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(await nft1.getAddress(), [124, 125, 126, 127, 128, 129, 130, 131, 132, 133]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Borrow bundle and expire */
        const borrowBundleTx = await poolEACL
          .connect(accountBorrower)
          .borrow(
            ethers.parseEther("250"),
            30 * 86400,
            await bundleCollateralWrapper.getAddress(),
            bundleTokenId,
            ethers.parseEther("260"),
            await sourceLiquidity(poolEACL, ethers.parseEther("250"), 10n),
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, ethers.dataLength(bundleData), bundleData])
          );
        bundleLoanReceipt = (await extractEvent(borrowBundleTx, poolEACL, "LoanOriginated")).args.loanReceipt;
        await helpers.time.increaseTo((await pool.decodeLoanReceipt(bundleLoanReceipt)).maturity + 1n);
      });

      it("liquidate (single, english auction, 16 ticks)", async function () {
        const liquidateTx = await poolEACL.liquidate(singleLoanReceipt);

        const gasUsed = (await liquidateTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(295000);
      });

      it("liquidate (bundle of 10, english auction, 16 ticks)", async function () {
        const liquidateTx = await poolEACL.liquidate(bundleLoanReceipt);

        const gasUsed = (await liquidateTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(711000);
      });

      it("bid (first, english auction)", async function () {
        const liquidateTx = await poolEACL.liquidate(singleLoanReceipt);

        /* Get liquidationHash */
        const liquidationHash = (await extractEvent(liquidateTx, englishAuctionCollateralLiquidator, "AuctionCreated"))
          .args[0];

        const bidTx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(liquidationHash, await nft1.getAddress(), 123, FixedPoint.from("1"));

        const gasUsed = (await bidTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(135000);
      });

      it("bid (second, english auction)", async function () {
        const liquidateTx = await poolEACL.liquidate(singleLoanReceipt);

        /* Get liquidationHash */
        const liquidationHash = (await extractEvent(liquidateTx, englishAuctionCollateralLiquidator, "AuctionCreated"))
          .args[0];

        await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(liquidationHash, await nft1.getAddress(), 123, FixedPoint.from("1"));
        const bid2Tx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[1])
          .bid(liquidationHash, await nft1.getAddress(), 123, FixedPoint.from("2"));

        const gasUsed = (await bid2Tx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(90000);
      });

      it("claim (single, english auction)", async function () {
        const liquidateTx = await poolEACL.liquidate(singleLoanReceipt);

        /* Get liquidationHash */
        const liquidationHash = (await extractEvent(liquidateTx, englishAuctionCollateralLiquidator, "AuctionCreated"))
          .args[0];

        /* Bid on collateral */
        await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(liquidationHash, await nft1.getAddress(), 123, FixedPoint.from("1"));

        /* Wait for auction expiration */
        await helpers.time.increase(86400);

        /* Claim collateral */
        const claimTx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .claim(liquidationHash, await nft1.getAddress(), 123, singleLoanReceipt);

        const gasUsed = (await claimTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(510000n);
      });

      it("claim (first / middle / last of bundle, english auction)", async function () {
        const liquidateTx = await poolEACL.liquidate(bundleLoanReceipt);

        /* Get liquidationHash */
        const liquidationHash = (await extractEvent(liquidateTx, englishAuctionCollateralLiquidator, "AuctionCreated"))
          .args[0];

        /* Bid on all collateral */
        const underlyingCollaterals = [124, 125, 126, 127, 128, 129, 130, 131, 132, 133];
        for (const underlyingCollateral of underlyingCollaterals) {
          await englishAuctionCollateralLiquidator
            .connect(accountDepositors[0])
            .bid(liquidationHash, await nft1.getAddress(), underlyingCollateral, FixedPoint.from("1"));
        }

        /* Wait for auction expiration */
        await helpers.time.increase(86400);

        /* Claim all collateral */
        const gasUsed = [];
        for (const underlyingCollateral of underlyingCollaterals) {
          const claimTx = await englishAuctionCollateralLiquidator
            .connect(accountDepositors[0])
            .claim(liquidationHash, await nft1.getAddress(), underlyingCollateral, bundleLoanReceipt);
          gasUsed.push((await claimTx.wait()).gasUsed);
        }

        gasReport.push([`claim (first of bundle, english auction)`, gasUsed[0]]);
        gasReport.push([`claim (middle of bundle, english auction)`, gasUsed[4]]);
        gasReport.push([`claim (last of bundle, english auction)`, gasUsed[9]]);

        expect(gasUsed[0]).to.be.lt(128000);
        expect(gasUsed[4]).to.be.lt(94000);
        expect(gasUsed[9]).to.be.lt(500000);
      });
    });
  });

  describe("#bundle mint", async function () {
    it("mint (bundle of 10)", async function () {
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);

      const gasUsed = (await mintTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(245000);
    });
  });

  describe("#bundle unwrap", async function () {
    it("unwrap (bundle of 10)", async function () {
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      const unwrapTx = await bundleCollateralWrapper.connect(accountBorrower).unwrap(bundleTokenId, bundleData);

      const gasUsed = (await unwrapTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(165000);
    });
  });

  describe("#merkle", async function () {
    let poolImpl: Pool;
    let pool: Pool;
    let collateralLiquidator: ExternalCollateralLiquidator;
    let proxy;
    let testProxyFactory: any;
    let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

    beforeEach("setup pool", async function () {
      testProxyFactory = await ethers.getContractFactory("TestProxy");
      const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateMerkleCollectionPool", [
        "LiquidityLogic",
        "DepositLogic",
        "BorrowLogic",
        "ERC20DepositTokenFactory",
      ]);
      const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
      const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");

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

      /* Deploy ERC20 despoit token implementation */
      erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
      await erc20DepositTokenImpl.waitForDeployment();

      /* Deploy pool implementation */
      poolImpl = (await poolImplFactory.deploy(
        await collateralLiquidator.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        await erc20DepositTokenImpl.getAddress(),
        []
      )) as Pool;
      await poolImpl.waitForDeployment();
    });
    for (const [count, principal, numTicks, maxGas] of [
      [10, FixedPoint.from("15"), 10, 369000],
      [10, FixedPoint.from("25"), 16, 496000],
      [100, FixedPoint.from("15"), 10, 373000],
      [100, FixedPoint.from("25"), 16, 500000],
      [1000, FixedPoint.from("15"), 10, 377000],
      [1000, FixedPoint.from("25"), 16, 505000],
    ]) {
      it(`merkle borrow (single, ${numTicks} ticks, ${count} token ids)`, async function () {
        /* Build merkle tree */
        const merkleNodeIds = constructMerkleNodeIds(122, count);
        const nodeCount = Math.ceil(Math.log2(merkleNodeIds.length));
        const merkleTree = MerkleTree.buildTree(merkleNodeIds, ["uint256"]);

        /* Deploy poolMerkle */
        proxy = await testProxyFactory.deploy(
          await poolImpl.getAddress(),
          poolImpl.interface.encodeFunctionData("initialize", [
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["address", "bytes32", "uint32", "string", "address", "address", "uint64[]", "uint64[]"],
              [
                await nft1.getAddress(),
                merkleTree.root,
                nodeCount,
                "https://api.example.com/v2/",
                await tok1.getAddress(),
                ethers.ZeroAddress,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.waitForDeployment();
        pool = (await ethers.getContractAt("Pool", await proxy.getAddress())) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);
        /* Approve pool to transfer token (for repayment) */
        await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

        await setupLiquidity(pool);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Compute merkle proof */
        const merkleProof = MerkleTree.buildProof("123", nodeCount, merkleTree);

        /* Compute borrow options */
        const borrowOptions = ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [2, ethers.dataLength(merkleProof), merkleProof]
        );

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await nft1.getAddress(),
            123,
            BigInt(principal) + FixedPoint.from("1"),
            ticks,
            borrowOptions
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }
  });

  describe("#erc1155 (with set collection collateral filter)", async function () {
    let poolImpl: Pool;
    let pool: Pool;
    let collateralLiquidator: ExternalCollateralLiquidator;
    let proxy;
    let testProxyFactory: any;
    let ERC1155CollateralWrapper: ERC1155CollateralWrapper;
    let tokenIds: bigint[];
    let ERC1155WrapperTokenId: bigint;
    let ERC1155WrapperData: any;
    let nft2: TestERC1155;
    let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

    beforeEach("setup pool", async function () {
      testProxyFactory = await ethers.getContractFactory("TestProxy");
      const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateSetCollectionPool", [
        "LiquidityLogic",
        "DepositLogic",
        "BorrowLogic",
        "ERC20DepositTokenFactory",
      ]);
      const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
      const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
      const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
      const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");

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

      /* Deploy test NFT */
      nft2 = (await testERC1155Factory.deploy("https://nft1.com/token/")) as TestERC1155;
      await nft2.waitForDeployment();

      /* Deploy ERC1155 collateral wrapper */
      ERC1155CollateralWrapper = await ERC1155CollateralWrapperFactory.deploy();
      await ERC1155CollateralWrapper.waitForDeployment();

      /* Deploy ERC20 despoit token implementation */
      erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
      await erc20DepositTokenImpl.waitForDeployment();

      /* Deploy pool implementation */
      poolImpl = (await poolImplFactory.deploy(
        await collateralLiquidator.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        await erc20DepositTokenImpl.getAddress(),
        [await ERC1155CollateralWrapper.getAddress()]
      )) as Pool;
      await poolImpl.waitForDeployment();

      /* Approve ERC1155Wrapper to transfer NFT */
      await nft2.connect(accountBorrower).setApprovalForAll(await ERC1155CollateralWrapper.getAddress(), true);
    });
    for (const [principal, numTicks, totalTokenIds, maxGas] of [
      [FixedPoint.from("245"), 10, 16, 458000],
      [FixedPoint.from("434"), 16, 16, 586000],
      [FixedPoint.from("490"), 10, 32, 545000],
      [FixedPoint.from("868"), 16, 32, 673000],
    ]) {
      it(`erc1155 borrow (total token IDs ${totalTokenIds}, ${numTicks} tick)`, async function () {
        /* Mint NFT to borrower */
        tokenIds = Array.from(Array(totalTokenIds), (_, index) => index + 1); /* Token ids from 1 to totalTokenIds */
        const tokenCounts = Array.from(Array(totalTokenIds), (_, index) => 1); /* 1 per token id */
        await nft2.mintBatch(await accountBorrower.getAddress(), tokenIds, tokenCounts, "0x");

        /* Mint ERC1155Wrapper */
        const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
          await nft2.getAddress(),
          tokenIds,
          tokenCounts
        );
        ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
        ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.encodedBatch;

        /* Deploy pool */
        proxy = await testProxyFactory.deploy(
          await poolImpl.getAddress(),
          poolImpl.interface.encodeFunctionData("initialize", [
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["address", "uint256[]", "address", "address", "uint64[]", "uint64[]"],
              [
                await nft2.getAddress(),
                tokenIds,
                await tok1.getAddress(),
                ethers.ZeroAddress,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.waitForDeployment();
        pool = (await ethers.getContractAt("Pool", await proxy.getAddress())) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft2.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

        /* Approve pool to transfer ERC1155Wrapper NFT */
        await ERC1155CollateralWrapper.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

        await setupLiquidity(pool);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, BigInt(principal), BigInt(totalTokenIds));
        expect(ticks.length).to.equal(numTicks);

        /* Compute borrow options */
        const borrowOptions = ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
        );

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            await ERC1155CollateralWrapper.getAddress(),
            ERC1155WrapperTokenId,
            BigInt(principal) + FixedPoint.from("10"),
            ticks,
            borrowOptions
          );

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }
  });

  /****************************************************************************/
  /* Gas Reporting */
  /****************************************************************************/

  after("gas report", async function () {
    console.log("\n  Pool Gas Report");
    for (const entry of gasReport) {
      console.log(`    ${entry[0].padEnd(55)}${entry[1]}`);
    }
  });
});
