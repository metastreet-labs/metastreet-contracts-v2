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
  EnglishAuctionCollateralLiquidator,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
  ERC1155CollateralWrapper,
} from "../typechain";

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
  let pool: Pool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let bundleCollateralWrapper: BundleCollateralWrapper;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("20000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

    /* Deploy external collateral liquidator implementation */
    const externalCollateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await externalCollateralLiquidatorImpl.deployed();

    /* Deploy external collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      externalCollateralLiquidatorImpl.address,
      externalCollateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.deployed();
    externalCollateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      5000,
      externalCollateralLiquidator.address,
      ethers.constants.AddressZero,
      [bundleCollateralWrapper.address],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool using external collateral liquidator */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint64[]", "uint64[]"],
          [
            nft1.address,
            tok1.address,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await externalCollateralLiquidator.grantRole(
      await externalCollateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("3000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(externalCollateralLiquidator.address, ethers.constants.MaxUint256);

    /* Mint NFT to borrower */
    for (let i = 123; i < 123 + 20; i++) {
      await nft1.mint(accountBorrower.address, i);
    }

    /* Mint token to borrower */
    await tok1.transfer(accountBorrower.address, ethers.utils.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);

    /* Approve bundle to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);

    /* Approve pool to transfer bundle NFT */
    await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);
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

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");

  function constructMerkleNodeIds(startId: number, count: number): ethers.BigNumber[][] {
    const nodes = [];
    for (let i = startId; i < startId + count; i++) {
      nodes.push([ethers.BigNumber.from(i)]);
    }

    return nodes;
  }

  async function setupLiquidity(pool: Pool): Promise<void> {
    const NUM_TICKS = 16;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_TICKS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("80"), 0);
      limit = limit.mul(TICK_LIMIT_SPACING_BASIS_POINTS.add(10000)).div(10000);
    }
  }

  async function sourceLiquidity(
    pool: Pool,
    amount: ethers.BigNumber,
    multiplier?: number = 1
  ): Promise<ethers.BigNumber[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
    const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

    let taken = ethers.constants.Zero;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      const take = minBN(minBN(limit.mul(multiplier).sub(taken), node.available), amount.sub(taken));
      if (take.isZero()) continue;
      ticks.push(node.tick);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

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
    await externalCollateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

    /* Liquidate collateral and process liquidation */
    await externalCollateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(pool.address, loanReceipt, FixedPoint.from("5"));
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

      expect(gasUsed).to.be.lt(220000);
    });
    it("deposit (existing tick)", async function () {
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(100000);
    });
    it("deposit (existing deposit)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(85000);
    });
  });

  describe("#redeem", async function () {
    it("redeem (partial)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(125000);
    });
    it("redeem (entire)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1.0"));

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(125000);
    });
  });

  describe("#withdraw", async function () {
    it("withdraw", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1.0"));

      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      const gasUsed = (await withdrawTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(60000);
    });
  });

  describe("#rebalance", async function () {
    it("multicall redeem + rebalance (new tick)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      const redeemRebalanceTx = await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("redeem", [Tick.encode("10"), FixedPoint.from("1.0")]),
          pool.interface.encodeFunctionData("rebalance", [Tick.encode("10"), Tick.encode("15"), 0, 0]),
        ]);

      const gasUsed = (await redeemRebalanceTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(220000);
    });

    it("multicall redeem + rebalance (existing tick)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("15"), FixedPoint.from("1"), 0);

      const redeemRebalanceTx = await pool
        .connect(accountDepositors[0])
        .multicall([
          pool.interface.encodeFunctionData("redeem", [Tick.encode("10"), FixedPoint.from("1.0")]),
          pool.interface.encodeFunctionData("rebalance", [Tick.encode("10"), Tick.encode("15"), 0, 0]),
        ]);

      const gasUsed = (await redeemRebalanceTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(165000);
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
      [FixedPoint.from("15"), 10, 270000],
      [FixedPoint.from("25"), 16, 349000],
    ]) {
      it(`borrow (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(principal, 30 * 86400, nft1.address, 123, principal.add(FixedPoint.from("1")), ticks, "0x");

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
        await nft1.mint(accountBorrower.address, 150);
        await nft1.connect(accountBorrower).transferFrom(accountBorrower.address, pool.address, 150);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(principal, 30 * 86400, nft1.address, 123, principal.add(FixedPoint.from("1")), ticks, "0x");

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        const gasUsed = (await borrowTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas - 15000);
      });
    }

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 289000],
      [FixedPoint.from("250"), 16, 368000],
    ]) {
      it(`borrow (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            principal.add(FixedPoint.from("10")),
            ticks,
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
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
        const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [135, 136, 137]);
        const bundleTokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

        /* Transfer bundle to pool */
        await bundleCollateralWrapper
          .connect(accountBorrower)
          .transferFrom(accountBorrower.address, pool.address, bundleTokenId1);

        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            principal.add(FixedPoint.from("10")),
            ticks,
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
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
      [FixedPoint.from("15"), 10, 250000],
      [FixedPoint.from("25"), 16, 335000],
    ]) {
      it(`repay (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(principal, 30 * 86400, nft1.address, 123, principal.add(FixedPoint.from("1")), ticks, "0x");

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

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 270000],
      [FixedPoint.from("250"), 16, 355000],
    ]) {
      it(`repay (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            principal.add(FixedPoint.from("10")),
            ticks,
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
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
      [FixedPoint.from("15"), 10, 353000],
      [FixedPoint.from("25"), 16, 472000],
    ]) {
      it(`refinance (single, ${numTicks} ticks)`, async function () {
        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(principal, 30 * 86400, nft1.address, 123, principal.add(FixedPoint.from("1")), ticks, "0x");

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const refinanceTx = await pool
          .connect(accountBorrower)
          .refinance(loanReceipt, principal, 30 * 86400, principal.add(FixedPoint.from("1")), ticks);

        const gasUsed = (await refinanceTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(maxGas);
      });
    }

    for (const [principal, numTicks, maxGas] of [
      [FixedPoint.from("150"), 10, 378000],
      [FixedPoint.from("250"), 16, 496000],
    ]) {
      it(`refinance (bundle of 10, ${numTicks} ticks)`, async function () {
        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, 10);
        expect(ticks.length).to.equal(numTicks);

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            principal.add(FixedPoint.from("10")),
            ticks,
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
          );

        /* Validate correct number of nodes were used */
        const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
        const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
        expect(decodedLoanReceipt.nodeReceipts.length).to.equal(numTicks);

        await helpers.time.increase(15 * 86400);

        const refinanceTx = await pool
          .connect(accountBorrower)
          .refinance(loanReceipt, principal, 30 * 86400, principal.add(FixedPoint.from("10")), ticks);

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
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(pool, FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(175000);
    });

    it("liquidate (bundle of 10, external, 16 ticks)", async function () {
      /* Mint bundle of 10 */
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("250"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("260"),
          await sourceLiquidity(pool, FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(180000);
    });

    describe("english auction collateral liquidator", async function () {
      let poolEACLImpl: Pool;
      let poolEACL: Pool;
      let englishAuctionCollateralLiquidator: EnglishAuctionCollateralLiquidator;
      let singleLoanReceipt: string;
      let bundleLoanReceipt: string;

      beforeEach("setup pool", async function () {
        const testProxyFactory = await ethers.getContractFactory("TestProxy");
        const englishAuctionCollateralLiquidatorFactory = await ethers.getContractFactory(
          "EnglishAuctionCollateralLiquidator"
        );
        const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");

        /* Deploy english auction collateral liquidator implementation */
        const englishAuctionCollateralLiquidatorImpl = await englishAuctionCollateralLiquidatorFactory.deploy([
          bundleCollateralWrapper.address,
        ]);
        await englishAuctionCollateralLiquidatorImpl.deployed();

        /* Deploy english auction collateral liquidator */
        let proxy = await testProxyFactory.deploy(
          englishAuctionCollateralLiquidatorImpl.address,
          englishAuctionCollateralLiquidatorImpl.interface.encodeFunctionData("initialize", [
            ethers.BigNumber.from(86400),
            ethers.BigNumber.from(60 * 10),
            ethers.BigNumber.from(60 * 20),
            ethers.BigNumber.from(199),
          ])
        );
        await proxy.deployed();

        englishAuctionCollateralLiquidator = (await ethers.getContractAt(
          "EnglishAuctionCollateralLiquidator",
          proxy.address
        )) as EnglishAuctionCollateralLiquidator;

        /* Deploy pool implementation */
        poolEACLImpl = (await poolImplFactory.deploy(
          5000,
          englishAuctionCollateralLiquidator.address,
          ethers.constants.AddressZero,
          [bundleCollateralWrapper.address],
          [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
        )) as Pool;
        await poolEACLImpl.deployed();

        /* Deploy poolEACL using english auction collateral liquidator */
        proxy = await testProxyFactory.deploy(
          poolEACLImpl.address,
          poolEACLImpl.interface.encodeFunctionData("initialize", [
            ethers.utils.defaultAbiCoder.encode(
              ["address", "address", "uint64[]", "uint64[]"],
              [
                nft1.address,
                tok1.address,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.deployed();
        poolEACL = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(poolEACL.address, ethers.constants.MaxUint256);
          await tok1
            .connect(depositor)
            .approve(englishAuctionCollateralLiquidator.address, ethers.constants.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft1.connect(accountBorrower).setApprovalForAll(poolEACL.address, true);
        /* Approve pool to transfer token (for repayment) */
        await tok1.connect(accountBorrower).approve(poolEACL.address, ethers.constants.MaxUint256);
        /* Approve pool to transfer bundle NFT */
        await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(poolEACL.address, true);

        await setupLiquidity(poolEACL);
      });

      beforeEach("borrow", async function () {
        /* Borrow single and expire */
        const borrowSingleTx = await poolEACL
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            nft1.address,
            123,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(poolEACL, ethers.utils.parseEther("25")),
            "0x"
          );
        singleLoanReceipt = (await extractEvent(borrowSingleTx, poolEACL, "LoanOriginated")).args.loanReceipt;
        await helpers.time.increaseTo((await pool.decodeLoanReceipt(singleLoanReceipt)).maturity.toNumber() + 1);

        /* Mint bundle of 10 */
        const mintTx = await bundleCollateralWrapper
          .connect(accountBorrower)
          .mint(nft1.address, [124, 125, 126, 127, 128, 129, 130, 131, 132, 133]);
        const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
        const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

        /* Borrow bundle and expire */
        const borrowBundleTx = await poolEACL
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("250"),
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            ethers.utils.parseEther("260"),
            await sourceLiquidity(poolEACL, ethers.utils.parseEther("250"), 10),
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
          );
        bundleLoanReceipt = (await extractEvent(borrowBundleTx, poolEACL, "LoanOriginated")).args.loanReceipt;
        await helpers.time.increaseTo((await pool.decodeLoanReceipt(bundleLoanReceipt)).maturity.toNumber() + 1);
      });

      it("liquidate (single, english auction, 16 ticks)", async function () {
        const liquidateTx = await poolEACL.liquidate(singleLoanReceipt);

        const gasUsed = (await liquidateTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(255000);
      });

      it("liquidate (bundle of 10, english auction, 16 ticks)", async function () {
        const liquidateTx = await poolEACL.liquidate(bundleLoanReceipt);

        const gasUsed = (await liquidateTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(665000);
      });

      it("bid (first, english auction)", async function () {
        await poolEACL.liquidate(singleLoanReceipt);

        const bidTx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(nft1.address, 123, FixedPoint.from("1"));

        const gasUsed = (await bidTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(135000);
      });

      it("bid (second, english auction)", async function () {
        await poolEACL.liquidate(singleLoanReceipt);

        await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(nft1.address, 123, FixedPoint.from("1"));
        const bid2Tx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[1])
          .bid(nft1.address, 123, FixedPoint.from("2"));

        const gasUsed = (await bid2Tx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(90000);
      });

      it("claim (single, english auction)", async function () {
        await poolEACL.liquidate(singleLoanReceipt);

        /* Bid on collateral */
        await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .bid(nft1.address, 123, FixedPoint.from("1"));

        /* Wait for auction expiration */
        await helpers.time.increase(86400);

        /* Claim collateral */
        const claimTx = await englishAuctionCollateralLiquidator
          .connect(accountDepositors[0])
          .claim(nft1.address, 123, singleLoanReceipt);

        const gasUsed = (await claimTx.wait()).gasUsed;
        gasReport.push([this.test.title, gasUsed]);

        expect(gasUsed).to.be.lt(380000);
      });

      it("claim (first / middle / last of bundle, english auction)", async function () {
        await poolEACL.liquidate(bundleLoanReceipt);

        /* Bid on all collateral */
        const underlyingCollaterals = [124, 125, 126, 127, 128, 129, 130, 131, 132, 133];
        for (const underlyingCollateral of underlyingCollaterals) {
          await englishAuctionCollateralLiquidator
            .connect(accountDepositors[0])
            .bid(nft1.address, underlyingCollateral, FixedPoint.from("1"));
        }

        /* Wait for auction expiration */
        await helpers.time.increase(86400);

        /* Claim all collateral */
        const gasUsed = [];
        for (const underlyingCollateral of underlyingCollaterals) {
          const claimTx = await englishAuctionCollateralLiquidator
            .connect(accountDepositors[0])
            .claim(nft1.address, underlyingCollateral, bundleLoanReceipt);
          gasUsed.push((await claimTx.wait()).gasUsed);
        }

        gasReport.push([`claim (first of bundle, english auction)`, gasUsed[0]]);
        gasReport.push([`claim (middle of bundle, english auction)`, gasUsed[4]]);
        gasReport.push([`claim (last of bundle, english auction)`, gasUsed[9]]);

        expect(gasUsed[0]).to.be.lt(125000);
        expect(gasUsed[4]).to.be.lt(90000);
        expect(gasUsed[9]).to.be.lt(365000);
      });
    });
  });

  describe("#bundle mint", async function () {
    it("mint (bundle of 10)", async function () {
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);

      const gasUsed = (await mintTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(250000);
    });
  });

  describe("#bundle unwrap", async function () {
    it("unwrap (bundle of 10)", async function () {
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(nft1.address, [123, 124, 125, 126, 127, 128, 129, 130, 131, 132]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      const unwrapTx = await bundleCollateralWrapper.connect(accountBorrower).unwrap(bundleTokenId, bundleData);

      const gasUsed = (await unwrapTx.wait()).gasUsed;
      gasReport.push([this.test.title, gasUsed]);

      expect(gasUsed).to.be.lt(170000);
    });
  });

  describe("#merkle", async function () {
    let poolImpl: Pool;
    let pool: Pool;
    let collateralLiquidator: ExternalCollateralLiquidator;
    let proxy;
    let testProxyFactory: any;

    beforeEach("setup pool", async function () {
      testProxyFactory = await ethers.getContractFactory("TestProxy");
      const poolImplFactory = await ethers.getContractFactory("WeightedRateMerkleCollectionPool");
      const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");

      /* Deploy external collateral liquidator implementation */
      const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
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

      /* Deploy pool implementation */
      poolImpl = (await poolImplFactory.deploy(
        5000,
        collateralLiquidator.address,
        ethers.constants.AddressZero,
        [],
        [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
      )) as Pool;
      await poolImpl.deployed();
    });
    for (const [count, principal, numTicks, maxGas] of [
      [10, FixedPoint.from("15"), 10, 279100],
      [10, FixedPoint.from("25"), 16, 358100],
      [100, FixedPoint.from("15"), 10, 282810],
      [100, FixedPoint.from("25"), 16, 361800],
      [1000, FixedPoint.from("15"), 10, 366600],
      [1000, FixedPoint.from("25"), 16, 366600],
    ]) {
      it(`merkle borrow (single, ${numTicks} ticks, ${count} token ids)`, async function () {
        /* Build merkle tree */
        const merkleNodeIds = constructMerkleNodeIds(122, count);
        const nodeCount = Math.ceil(Math.log2(merkleNodeIds.length));
        const merkleTree = MerkleTree.buildTree(merkleNodeIds, ["uint256"]);

        /* Deploy poolMerkle */
        proxy = await testProxyFactory.deploy(
          poolImpl.address,
          poolImpl.interface.encodeFunctionData("initialize", [
            ethers.utils.defaultAbiCoder.encode(
              ["address", "bytes32", "uint32", "string", "address", "uint64[]", "uint64[]"],
              [
                nft1.address,
                merkleTree.root,
                nodeCount,
                "https://api.example.com/v2/",
                tok1.address,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.deployed();
        pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);
        /* Approve pool to transfer token (for repayment) */
        await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);

        await setupLiquidity(pool);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal);
        expect(ticks.length).to.equal(numTicks);

        /* Compute merkle proof */
        const merkleProof = MerkleTree.buildProof("123", nodeCount, merkleTree);

        /* Compute borrow options */
        const borrowOptions = ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [2, ethers.utils.hexDataLength(merkleProof), merkleProof]
        );

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(principal, 30 * 86400, nft1.address, 123, principal.add(FixedPoint.from("1")), ticks, borrowOptions);

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
    let tokenIds: ethers.BigNumber[];
    let ERC1155WrapperTokenId: ethers.BigNumber;
    let ERC1155WrapperData: any;
    let nft2: TestERC1155;

    beforeEach("setup pool", async function () {
      testProxyFactory = await ethers.getContractFactory("TestProxy");
      const poolImplFactory = await ethers.getContractFactory("WeightedRateSetCollectionPool");
      const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
      const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
      const testERC1155Factory = await ethers.getContractFactory("TestERC1155");

      /* Deploy external collateral liquidator implementation */
      const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
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

      /* Deploy test NFT */
      nft2 = (await testERC1155Factory.deploy("https://nft1.com/token/")) as TestERC1155;
      await nft2.deployed();

      /* Deploy ERC1155 collateral wrapper */
      ERC1155CollateralWrapper = await ERC1155CollateralWrapperFactory.deploy();
      await ERC1155CollateralWrapper.deployed();

      /* Deploy pool implementation */
      poolImpl = (await poolImplFactory.deploy(
        5000,
        collateralLiquidator.address,
        ethers.constants.AddressZero,
        [ERC1155CollateralWrapper.address],
        [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
      )) as Pool;
      await poolImpl.deployed();

      /* Approve ERC1155Wrapper to transfer NFT */
      await nft2.connect(accountBorrower).setApprovalForAll(ERC1155CollateralWrapper.address, true);
    });
    for (const [principal, numTicks, totalTokenIds, maxGas] of [
      [FixedPoint.from("245"), 10, 16, 360000],
      [FixedPoint.from("434"), 16, 16, 440000],
      [FixedPoint.from("490"), 10, 32, 440000],
      [FixedPoint.from("868"), 16, 32, 520000],
    ]) {
      it(`erc1155 borrow (total token IDs ${totalTokenIds}, ${numTicks} tick)`, async function () {
        /* Mint NFT to borrower */
        tokenIds = Array.from(Array(totalTokenIds), (_, index) => index + 1); /* Token ids from 1 to totalTokenIds */
        const tokenCounts = Array.from(Array(totalTokenIds), (_, index) => 1); /* 1 per token id */
        await nft2.mintBatch(accountBorrower.address, tokenIds, tokenCounts, "0x");

        /* Mint ERC1155Wrapper */
        const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
          nft2.address,
          tokenIds,
          tokenCounts
        );
        ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
        ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.encodedBatch;

        /* Deploy pool */
        proxy = await testProxyFactory.deploy(
          poolImpl.address,
          poolImpl.interface.encodeFunctionData("initialize", [
            ethers.utils.defaultAbiCoder.encode(
              ["address", "uint256[]", "address", "uint64[]", "uint64[]"],
              [
                nft2.address,
                tokenIds,
                tok1.address,
                [30 * 86400, 14 * 86400, 7 * 86400],
                [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
              ]
            ),
          ])
        );
        await proxy.deployed();
        pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

        /* Transfer TOK1 to depositors and approve Pool */
        for (const depositor of accountDepositors) {
          await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
        }
        /* Approve pool to transfer NFT */
        await nft2.connect(accountBorrower).setApprovalForAll(pool.address, true);

        /* Approve pool to transfer ERC1155Wrapper NFT */
        await ERC1155CollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

        await setupLiquidity(pool);

        /* Source liquidity */
        const ticks = await sourceLiquidity(pool, principal, totalTokenIds);
        expect(ticks.length).to.equal(numTicks);

        /* Compute borrow options */
        const borrowOptions = ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
        );

        /* Borrow */
        const borrowTx = await pool
          .connect(accountBorrower)
          .borrow(
            principal,
            30 * 86400,
            ERC1155CollateralWrapper.address,
            ERC1155WrapperTokenId,
            principal.add(FixedPoint.from("10")),
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
