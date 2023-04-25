import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  TestLoanReceipt,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
} from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint.ts";
import { Tick } from "./helpers/Tick";

describe("Pool Gas", function () {
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
  let bundleCollateralWrapper: BundleCollateralWrapper;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("FixedRateSingleCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(ethers.constants.AddressZero, [bundleCollateralWrapper.address])) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint256", "uint64[]", "uint64[]", "tuple(uint64, uint64, uint64)"],
          [
            nft1.address,
            tok1.address,
            45,
            [7 * 86400, 14 * 86400, 30 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
            [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")],
          ]
        ),
        collateralLiquidator.address,
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
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("1500"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

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

  async function setupLiquidity(): Promise<void> {
    const NUM_TICKS = 16;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("1.0");
    for (let i = 0; i < NUM_TICKS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("80"));
      limit = limit.mul(TICK_LIMIT_SPACING_BASIS_POINTS).div(10000);
    }
  }

  async function sourceLiquidity(amount: ethers.BigNumber, multiplier?: number = 1): Promise<ethers.BigNumber[]> {
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
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("5"), FixedPoint.from("5"));
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"));
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"));

    /* Create expired loan taking 15 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("15"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(pool.address, loanReceipt, FixedPoint.from("5"));
  }

  async function createActiveLoan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string]> {
    const tokenId =
      (await nft1.ownerOf(123)) === accountBorrower.address
        ? 123
        : (await nft1.ownerOf(124)) === accountBorrower.address
        ? 124
        : 125;

    const repayment = await pool.quote(principal, duration, nft1.address, [tokenId], "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, await sourceLiquidity(principal), "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createActiveBundleLoan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string, ethers.BigNumber, string]> {
    /* Mint bundle */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
    const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
    const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
    const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

    await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

    /* Borrow */
    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(
        FixedPoint.from("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        FixedPoint.from("26"),
        await sourceLiquidity(FixedPoint.from("25"), 3),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [2, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );

    /* Extract loan receipt */
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

    return [loanReceipt, loanReceiptHash, bundleTokenId, bundleData];
  }

  async function createExpiredLoan(principal: ethers.BigNumber): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Wait for loan expiration */
    const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
    await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

    return [loanReceipt, loanReceiptHash];
  }

  async function createRepaidLoan(principal: ethers.BigNumber): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Repay */
    await pool.connect(accountBorrower).repay(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  async function createLiquidatedLoan(principal: ethers.BigNumber): Promise<ethers.BigNumber> {
    /* Create expired loan */
    const [loanReceipt, loanReceiptHash] = await createExpiredLoan(principal);

    /* Liquidate */
    await pool.connect(accountLender).liquidate(loanReceipt);

    return [loanReceipt, loanReceiptHash];
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
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push(["deposit (new tick)", gasUsed]);

      expect(gasUsed).to.be.lt(260000);
    });
    it("deposit (existing tick)", async function () {
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("1"));
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push(["deposit (existing tick)", gasUsed]);

      expect(gasUsed).to.be.lt(105000);
    });
    it("deposit (existing deposit)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));

      const gasUsed = (await depositTx.wait()).gasUsed;
      gasReport.push(["deposit (existing deposit)", gasUsed]);

      expect(gasUsed).to.be.lt(85000);
    });
  });

  describe("#redeem", async function () {
    it("redeem (partial)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push(["redeem (partial)", gasUsed]);

      expect(gasUsed).to.be.lt(110000);
    });
    it("redeem (entire)", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));

      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1.0"));

      const gasUsed = (await redeemTx.wait()).gasUsed;
      gasReport.push(["redeem (entire)", gasUsed]);

      expect(gasUsed).to.be.lt(110000);
    });
  });

  describe("#withdraw", async function () {
    it("withdraw", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"));
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1.0"));

      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"));

      const gasUsed = (await withdrawTx.wait()).gasUsed;
      gasReport.push(["withdraw", gasUsed]);

      expect(gasUsed).to.be.lt(60000);
    });
  });

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("borrow (single, 16 ticks)", async function () {
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      const gasUsed = (await borrowTx.wait()).gasUsed;
      gasReport.push(["borrow (single, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(355000);
    });
    it("borrow (single, existing, 16 ticks) ", async function () {
      /* Mint NFT to pool */
      await nft1.mint(pool.address, 150);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      const gasUsed = (await borrowTx.wait()).gasUsed;
      gasReport.push(["borrow (single, existing, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(340000);
    });
    it("borrow (bundle of 10, 16 ticks)", async function () {
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
          await sourceLiquidity(FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [2, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      const gasUsed = (await borrowTx.wait()).gasUsed;
      gasReport.push(["borrow (bundle of 10, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(385000);
    });
    it("borrow (bundle of 10, existing, 16 ticks)", async function () {
      /* Mint bundle of 3 */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [135, 136, 137]);
      const bundleTokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Transfer bundle to pool */
      await bundleCollateralWrapper
        .connect(accountBorrower)
        ["safeTransferFrom(address,address,uint256)"](accountBorrower.address, pool.address, bundleTokenId1);

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
          await sourceLiquidity(FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [2, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      const gasUsed = (await borrowTx.wait()).gasUsed;
      gasReport.push(["borrow (bundle of 10, existing, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(370000);
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("repay (single)", async function () {
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increase(15 * 86400);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      const gasUsed = (await repayTx.wait()).gasUsed;
      gasReport.push(["repay (single, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(355000);
    });
    it("repay (bundle of 10)", async function () {
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
          await sourceLiquidity(FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [2, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increase(15 * 86400);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      const gasUsed = (await repayTx.wait()).gasUsed;
      gasReport.push(["repay (bundle of 10, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(385000);
    });
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance (single)", async function () {
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increase(15 * 86400);

      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          30 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"))
        );

      const gasUsed = (await refinanceTx.wait()).gasUsed;
      gasReport.push(["refinance (single, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(485000);
    });
    it("refinance (bundle of 10)", async function () {
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
          await sourceLiquidity(FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [2, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increase(15 * 86400);

      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          30 * 86400,
          FixedPoint.from("260"),
          await sourceLiquidity(FixedPoint.from("250"), 10)
        );

      const gasUsed = (await refinanceTx.wait()).gasUsed;
      gasReport.push(["refinance (bundle of 10, 16 ticks)", gasUsed]);

      expect(gasUsed).to.be.lt(520000);
    });
  });

  describe("#liquidate", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidate (single)", async function () {
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push(["liquidate (single)", gasUsed]);

      expect(gasUsed).to.be.lt(180000);
    });
    it("liquidate (bundle of 10)", async function () {
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
          await sourceLiquidity(FixedPoint.from("250"), 10),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [2, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate 16 nodes were used */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await pool.decodeLoanReceipt(loanReceipt);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      const liquidateTx = await pool.liquidate(loanReceipt);

      const gasUsed = (await liquidateTx.wait()).gasUsed;
      gasReport.push(["liquidate (bundle of 10)", gasUsed]);

      expect(gasUsed).to.be.lt(185000);
    });
  });

  /****************************************************************************/
  /* Gas Reporting */
  /****************************************************************************/

  after("gas report", async function () {
    console.log("\n  Pool Gas Report");
    for (const entry of gasReport) {
      console.log(`    ${entry[0].padEnd(50)}${entry[1]}`);
    }
  });
});
