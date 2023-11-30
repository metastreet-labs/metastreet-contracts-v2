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
  BundleCollateralWrapper,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Bundle", function () {
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

    /* Deploy test delegation registry v1 */
    delegateRegistryV1 = await delegateRegistryV1Factory.deploy();
    await delegateRegistryV1.deployed();

    /* Deploy test delegation registry v2 */
    delegateRegistryV2 = await delegateRegistryV2Factory.deploy();
    await delegateRegistryV2.deployed();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegateRegistryV1.address,
      delegateRegistryV2.address,
      erc20DepositTokenImpl.address,
      [bundleCollateralWrapper.address],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
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
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("1000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mint(accountBorrower.address, 123);
    await nft1.mint(accountBorrower.address, 124);
    await nft1.mint(accountBorrower.address, 125);

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
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation name", async function () {
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateCollectionPool");
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("getters", async function () {
    it("returns expected currency token", async function () {
      expect(await pool.currencyToken()).to.equal(tok1.address);
    });

    it("returns expected admin fee rate", async function () {
      expect(await pool.adminFeeRate()).to.equal(0);
    });

    it("returns expected collateral wrappers", async function () {
      const collateralWrappers = await pool.collateralWrappers();
      expect(collateralWrappers[0]).to.equal(bundleCollateralWrapper.address);
      expect(collateralWrappers[1]).to.equal(ethers.constants.AddressZero);
      expect(collateralWrappers[2]).to.equal(ethers.constants.AddressZero);
    });

    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(collateralLiquidator.address);
    });

    it("returns expected delegation registry v1", async function () {
      expect(await pool.delegationRegistry()).to.equal(delegateRegistryV1.address);
    });

    it("returns expected delegation registry v2", async function () {
      expect(await pool.delegationRegistryV2()).to.equal(delegateRegistryV2.address);
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = limit.mul(TICK_LIMIT_SPACING_BASIS_POINTS.add(10000)).div(10000);
    }
  }

  async function sourceLiquidity(
    amount: ethers.BigNumber,
    multiplier?: number = 1,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<ethers.BigNumber[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    let taken = ethers.constants.Zero;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit.isZero()) continue;

      const take = minBN(minBN(limit.mul(multiplier).sub(taken), node.available), amount.sub(taken));
      if (take.isZero()) break;

      ticks.push(node.tick);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
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

    const ticks = await sourceLiquidity(principal);

    const repayment = await pool.quote(principal, duration, nft1.address, tokenId, ticks, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, ticks, "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createActiveBundleLoan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string, ethers.BigNumber, string]> {
    /* Mint bundle */
    const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
    const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
    const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

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
          [1, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );

    /* Extract loan receipt */
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

    return [loanReceipt, loanReceiptHash, bundleTokenId, bundleData];
  }

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes repayment for bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("10")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        )
      ).to.equal(FixedPoint.from("10.082191780812160000"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        )
      ).to.equal(FixedPoint.from("25.205479451965600000"));
    });

    it("fails on insufficient liquidity for bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      await expect(
        pool.quote(
          FixedPoint.from("1000"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates bundle loan", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

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
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(4);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates bundle loan with delegation", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
          [1, ethers.utils.hexDataLength(bundleData), bundleData, 3, 20, accountBorrower.address]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData, 3, 20, accountBorrower.address]
          )
        );

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
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData, 3, 20, accountBorrower.address]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: bundleCollateralWrapper.address,
        tokenId: bundleTokenId,
        value: true,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(4);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates bundle loan for a 85 ETH principal", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("85"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        await sourceLiquidity(FixedPoint.from("85"), 3),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("85"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("85"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      /* Validate events */
      await expectEvent(mintTx, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("85"),
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(17);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("85"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("fails on bundle with invalid option encoding", async function () {
      /* Mint bundle */
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Set length of tokenId to 31 instead of 32 */
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"), 3),
            ethers.utils.solidityPack(["uint16", "uint16", "bytes"], [1, 20 + 31 * 3, bundleData])
          )
      ).to.be.reverted;
    });

    it("fails on insufficient liquidity with bundle", async function () {
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("120"),
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            FixedPoint.from("122"),
            await sourceLiquidity(FixedPoint.from("85"), 3),
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(bundleData), bundleData]
            )
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays bundle loan at maturity", async function () {
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          repayment,
          await sourceLiquidity(FixedPoint.from("25"), 2),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(pool.address);

      const bundleLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const bundleLoanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(bundleLoanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(bundleLoanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, bundleCollateralWrapper, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash: bundleLoanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(bundleLoanReceiptHash)).to.equal(2);

      /* Validate ticks */
      let totalDelta = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const delta = nodeReceipt.pending.sub(nodeReceipt.used);
        const node = await pool.liquidityNode(nodeReceipt.tick);
        expect(node.value).to.equal(FixedPoint.from("25").add(delta));
        expect(node.available).to.equal(FixedPoint.from("25").add(delta));
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalDelta = totalDelta.add(delta);
      }

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;
    let bundleTokenId: ethers.BigNumber;
    let bundleData: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance bundle loan at maturity with admin fee and same principal", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(decodedLoanReceipt.repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedNewLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp + 15 * 86400
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(4);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment.sub(decodedLoanReceipt.principal),
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

    it("bundle loan fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Validate inability to do both refinance() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25")),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash, bundleTokenId, bundleData] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          1,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(bundleData), bundleData]
          )
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = bundleCollateralWrapper.address;
      nodeReceipt.borrower = accountBorrower.address;
      nodeReceipt.maturity = ethers.BigNumber.from("10000000001");
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      /* Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow() */
      await helpers.time.increaseTo(9999999999);

      /* Validate inability to do both borrow() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              FixedPoint.from("1"),
              1,
              bundleCollateralWrapper.address,
              bundleTokenId,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 3),
              ethers.utils.solidityPack(
                ["uint16", "uint16", "bytes"],
                [1, ethers.utils.hexDataLength(bundleData), bundleData]
              ),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 3),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("1"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("bundle loan fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on repaid loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on liquidated loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Refinance */
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#liquidate", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;
    let bundleTokenId: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidates expired bundle loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, bundleCollateralWrapper, "Transfer", {
        from: pool.address,
        to: collateralLiquidator.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });
  });
});
