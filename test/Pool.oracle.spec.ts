import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  TestPriceOracle,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Price Oracle", function () {
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
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let priceOracle: TestPriceOracle;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const testPriceOracleFactory = await ethers.getContractFactory("TestPriceOracle");
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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.waitForDeployment();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy test price oracle */
    priceOracle = await testPriceOracleFactory.deploy();
    await priceOracle.waitForDeployment();

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
            await priceOracle.getAddress(),
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
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
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation name", async function () {
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateCollectionPool");
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_RATIO_LIMITS = 6;
    const NUM_ABSOLUTE_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_ABSOLUTE_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10000n)) / 10000n;
    }

    limit = BigInt(4000);
    for (let i = 0; i < NUM_RATIO_LIMITS; i++) {
      await pool.connect(accountDepositors[1]).deposit(Tick.encode(limit, 0, 0, 18, 1), FixedPoint.from("20"), 0);
      limit = limit + BigInt(1000);
    }
  }

  async function sourceLiquidity(
    amount: bigint,
    multiplier?: bigint = 1n,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<bigint[]> {
    const oraclePrice = await priceOracle.price(ethers.ZeroAddress, ethers.ZeroAddress, [], [], "0x");
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const normalizedNodes = [...nodes];
    const ticks = [];

    /* Sort nodes by limits */
    normalizedNodes.sort((a, b) => {
      const limitA = Tick.decode(a.tick, oraclePrice).limit;
      const limitB = Tick.decode(b.tick, oraclePrice).limit;
      return limitA < limitB ? -1 : limitA > limitB ? 1 : 0;
    });

    let taken = 0n;

    for (const node of normalizedNodes) {
      const limit = Tick.decode(node.tick, oraclePrice).limit;

      if (limit === 0n) continue;

      const take = minBN(minBN(limit * multiplier - taken, node.available), amount - taken);
      if (take === 0n) break;

      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== amount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);
    return ticks;
  }

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes repayment for single collateral", async function () {
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [5, ethers.dataLength("0x11"), "0x11"]
      );

      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          await nft1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("10")),
          oracleContext
        )
      ).to.equal(FixedPoint.from("10.082191780812159999"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("25")),
          oracleContext
        )
      ).to.equal(FixedPoint.from("25.205479452030399990"));
    });

    it("correctly quotes repayment for bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("10")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
            [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
          )
        )
      ).to.equal(FixedPoint.from("10.082191780812160000"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
            [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
          )
        )
      ).to.equal(FixedPoint.from("25.205479452030400000"));
    });

    it("fails on insufficient liquidity for bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      await expect(
        pool.quote(
          FixedPoint.from("1000"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
            [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
          )
        )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [5, ethers.dataLength("0x11"), "0x11"]
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        oracleContext
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          oracleContext
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          oracleContext
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(2);
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(21);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates bundle loan", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await bundleCollateralWrapper.getAddress(),
        bundleTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
          [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
            [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
            [1, ethers.dataLength(bundleData), bundleData, 5, ethers.dataLength("0x11"), "0x11"]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, bundleCollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(2);
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await bundleCollateralWrapper.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.dataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(4);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("fails on insufficient liquidity", async function () {
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [5, ethers.dataLength("0x11"), "0x11"]
      );

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("120"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("122"),
            await sourceLiquidity(FixedPoint.from("25"), 3n),
            oracleContext
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on invalid ordering after oracle price changes", async function () {
      const ticks = await sourceLiquidity(FixedPoint.from("25"));

      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [5, ethers.dataLength("0x11"), "0x11"]
      );

      await priceOracle.setPrice(FixedPoint.from("60"));

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26"),
            ticks,
            oracleContext
          )
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });
  });
});
