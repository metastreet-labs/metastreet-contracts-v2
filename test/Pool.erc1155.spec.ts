import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC1155,
  TestProxy,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  Pool,
  ERC1155CollateralWrapper,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { BigIntMath } from "./helpers/Math";
import { Tick } from "./helpers/Tick";

describe("Pool ERC1155", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC1155;
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
  let erc1155CollateralWrapper: ERC1155CollateralWrapper;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;
  let poolImplFactory: ethers.ContractFactory;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const erc1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");

    poolImplFactory = await getContractFactoryWithLibraries("WeightedRateERC1155CollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("10000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC1155Factory.deploy("https://nft1.com/token/")) as TestERC1155;
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

    /* Deploy ERC1155 collateral wrapper */
    erc1155CollateralWrapper = await erc1155CollateralWrapperFactory.deploy();
    await erc1155CollateralWrapper.waitForDeployment();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      [await erc1155CollateralWrapper.getAddress()]
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
    await nft1.mintBatch(await accountBorrower.getAddress(), [123, 124, 125], [1, 2, 3], "0x");

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

    /* Approve ERC1155Wrapper to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await erc1155CollateralWrapper.getAddress(), true);

    /* Approve pool to transfer ERC1155Wrapper NFT */
    await erc1155CollateralWrapper.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Deployment */
  /****************************************************************************/

  describe("deployment", async function () {
    it("reverts on deploying with invalid collateral wrappers", async function () {
      /* Invalid length */
      await expect(
        poolImplFactory.deploy(
          await collateralLiquidator.getAddress(),
          await delegateRegistryV1.getAddress(),
          await delegateRegistryV2.getAddress(),
          await erc20DepositTokenImpl.getAddress(),
          []
        )
      ).to.be.reverted;

      /* Invalid length */
      await expect(
        poolImplFactory.deploy(
          await collateralLiquidator.getAddress(),
          await delegateRegistryV1.getAddress(),
          await delegateRegistryV2.getAddress(),
          await erc20DepositTokenImpl.getAddress(),
          [await erc1155CollateralWrapper.getAddress(), await erc1155CollateralWrapper.getAddress()]
        )
      ).to.be.reverted;

      /* Invalid collateral wrapper */
      await expect(
        poolImplFactory.deploy(
          await collateralLiquidator.getAddress(),
          await delegateRegistryV1.getAddress(),
          await delegateRegistryV2.getAddress(),
          await erc20DepositTokenImpl.getAddress(),
          [await collateralLiquidator.getAddress()]
        )
      ).to.be.reverted;
    });
  });

  /****************************************************************************/
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation name", async function () {
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateERC1155CollectionPool");
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

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10000n)) / 10000n;
    }
  }

  async function amendLiquidity(ticks: bigint[]): Promise<bigint[]> {
    /* Replace four ticks with alternate duration and rates */
    ticks[3] = Tick.encode(Tick.decode(ticks[3]).limit, 2, 0);
    ticks[5] = Tick.encode(Tick.decode(ticks[5]).limit, 1, 1);
    ticks[7] = Tick.encode(Tick.decode(ticks[7]).limit, 1, 1);
    ticks[9] = Tick.encode(Tick.decode(ticks[9]).limit, 0, 2);
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

  async function createActiveLoan(principal: bigint, duration?: number = 30 * 86400): Promise<[string, string]> {
    const tokenId =
      (await nft1.balanceOf(await accountBorrower.getAddress(), 123)) == 1n
        ? 123
        : (await nft1.balanceOf(await accountBorrower.getAddress(), 124)) == 1n
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

  async function createActiveERC1155CWLoan(
    principal: bigint,
    duration?: number = 30 * 86400
  ): Promise<[string, string, bigint, string]> {
    /* Mint ERC1155 Wrapper */
    const mintTx = await erc1155CollateralWrapper
      .connect(accountBorrower)
      .mint(await nft1.getAddress(), [123, 124, 125], [1, 2, 2]);
    const erc1155WrapperTokenId = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args.tokenId;
    const erc1155WrapperData = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args.encodedBatch;

    /* Borrow */
    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(
        FixedPoint.from("25"),
        30 * 86400,
        await erc1155CollateralWrapper.getAddress(),
        erc1155WrapperTokenId,
        FixedPoint.from("26"),
        await sourceLiquidity(FixedPoint.from("25"), 6n),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(erc1155WrapperData), erc1155WrapperData]
        )
      );

    /* Extract loan receipt */
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

    return [loanReceipt, loanReceiptHash, erc1155WrapperTokenId, erc1155WrapperData];
  }

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan with ERC1155", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
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
          "0x"
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
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "TransferSingle", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        id: 123,
        value: 1,
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
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

    it("originates loan with ERC1155 collateral wrapper", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await erc1155CollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 124, 125], [1, 2, 3]);
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await erc1155CollateralWrapper.getAddress(),
        ERC1155WrapperTokenId,
        await sourceLiquidity(FixedPoint.from("25"), 6n),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await erc1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await erc1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, erc1155CollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, erc1155CollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: ERC1155WrapperTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(await erc1155CollateralWrapper.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.dataLength(ERC1155WrapperData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(ERC1155WrapperData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(1);

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

    it("originates a loan from various duration and rate ticks", async function () {
      const ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      /* Borrow */
      await pool
        .connect(accountBorrower)
        .borrow(FixedPoint.from("25"), 7 * 86400, await nft1.getAddress(), 123, FixedPoint.from("26"), ticks, "0x");
    });

    it("originates loan with v1 delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
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
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
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
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "TransferSingle", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        id: 123,
        value: 1,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 123,
        value: true,
      });

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
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

      /* Validate delegation */
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          123
        )
      ).to.equal(true);
    });

    it("originates loan with v2 delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
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
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
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
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "TransferSingle", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        id: 123,
        value: 1,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 123,
        rights: ethers.ZeroHash,
        enable: true,
      });

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
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

      /* Validate delegation */
      expect(
        await delegateRegistryV2.checkDelegateForERC721(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          123,
          ethers.ZeroHash
        )
      ).to.equal(true);
    });

    it("originates loan with admin fee", async function () {
      /* Set admin fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
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
          "0x"
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
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "TransferSingle", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        id: 123,
        value: 1,
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
      expect(decodedLoanReceipt.principal).to.equal(FixedPoint.from("25"));
      expect(decodedLoanReceipt.repayment).to.equal(repayment);
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment - adminFee);
      expect(repayment).to.equal(totalPending + adminFee);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.closeTo((adminFee * 9500n) / 10000n, "1");

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, pool, "AdminFeeShareTransferred", {
        feeShareRecipient: accounts[2].address,
        feeShareAmount: (adminFee * 500n) / 10000n,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("fails on zero principal", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            0,
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidParameters");
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            await tok1.getAddress(),
            123,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral");
    });

    it("fails on exceeded max repayment", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("25.01"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "RepaymentTooHigh");
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("30"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("31"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails with non-increasing tick", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      const temp = ticks[4];
      ticks[4] = ticks[5];
      ticks[5] = temp;

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 30 * 86400, await nft1.getAddress(), 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duplicate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      ticks[4] = ticks[5];

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 30 * 86400, await nft1.getAddress(), 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with excessive ticks", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("150"),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("151"),
            await sourceLiquidity(FixedPoint.from("150")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails with low duration ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 8 * 86400, await nft1.getAddress(), 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duration equals 0", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            0,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedLoanDuration");
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays loan at maturity with ERC1155", async function () {
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
      await expectEvent(repayTx, nft1, "TransferSingle", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        id: 123,
        value: 1,
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

    it("repays loan at maturity with ERC1155 collateral wrapper", async function () {
      /* Create Loan */
      let [loanReceipt, loanReceiptHash, erc1155WrapperTokenId] = await createActiveERC1155CWLoan(
        FixedPoint.from("25")
      );

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

      await expectEvent(repayTx, erc1155CollateralWrapper, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: erc1155WrapperTokenId,
      });

      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash: loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks */
      let totalDelta = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const delta = nodeReceipt.pending - nodeReceipt.used;
        const node = await pool.liquidityNode(nodeReceipt.tick);
        expect(node.value).to.equal(FixedPoint.from("25") + delta);
        expect(node.available).to.equal(FixedPoint.from("25") + delta);
        expect(node.pending).to.equal(0n);
        totalDelta = totalDelta + delta;
      }

      expect(await erc1155CollateralWrapper.ownerOf(erc1155WrapperTokenId)).to.equal(
        await accountBorrower.getAddress()
      );
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

      await expectEvent(repayTx, nft1, "TransferSingle", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        id: 124,
        value: 1,
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

      /* Calculate fee share */
      const feeShare = await pool.adminFeeBalance();

      /* Validate events */
      await expectEvent(
        repayTx,
        tok1,
        "Transfer",
        {
          from: await accountBorrower.getAddress(),
          to: await pool.getAddress(),
          value: repayment,
        },
        0
      );

      await expectEvent(
        repayTx,
        tok1,
        "Transfer",
        {
          from: await pool.getAddress(),
          to: accounts[2].address,
          value: feeShare - 1n,
        },
        1
      );

      await expectEvent(repayTx, nft1, "TransferSingle", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        id: 124,
        value: 1,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("repays removes v1 delegation", async function () {
      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
        );

      /* Validate events */
      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        value: true,
      });

      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        value: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124
        )
      ).to.equal(false);
    });

    it("repays removes v2 delegation", async function () {
      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
        );

      /* Validate events */
      await expectEvent(borrowTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        rights: ethers.ZeroHash,
        enable: true,
      });

      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        rights: ethers.ZeroHash,
        enable: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV2.checkDelegateForERC721(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124,
          ethers.ZeroHash
        )
      ).to.equal(false);
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

        await expectEvent(repayTx, nft1, "TransferSingle", {
          from: await pool.getAddress(),
          to: await accountBorrower.getAddress(),
          id: 123,
          value: 1,
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

    it("can repay after expiration and prior to liquidation", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const repayment = decodedLoanReceipt.repayment;

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment,
      });

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

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124
        )
      ).to.equal(false);
    });

    it("fails on invalid caller", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));
      await expect(pool.connect(accountLender).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid loan receipt", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .repay("0xa9059cbb0000000000000000000000001f9090aae28b8a3dceadf281b0f12828e676c326")
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on liquidated loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on same block repayment", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      const [loanReceipt, _] = await createActiveLoan(FixedPoint.from("25"));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Get token id */
      const tokenId =
        (await nft1.balanceOf(await accountBorrower.getAddress(), 123)) == 1n
          ? 123
          : (await nft1.balanceOf(await accountBorrower.getAddress(), 124)) == 1n
            ? 124
            : 125;

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          1,
          await nft1.getAddress(),
          tokenId,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = {
        version: decodedExistingLoanReceipt.version,
        principal: decodedExistingLoanReceipt.principal,
        repayment: decodedExistingLoanReceipt.repayment,
        adminFee: decodedExistingLoanReceipt.adminFee,
        borrower: decodedExistingLoanReceipt.borrower,
        maturity: BigInt("10000000001"),
        duration: decodedExistingLoanReceipt.duration,
        collateralToken: decodedExistingLoanReceipt.collateralToken,
        collateralTokenId: decodedExistingLoanReceipt.collateralTokenId,
        collateralWrapperContextLen: decodedExistingLoanReceipt.collateralWrapperContextLen,
        collateralWrapperContext: decodedExistingLoanReceipt.collateralWrapperContext,
        nodeReceipts: [
          {
            tick: decodedExistingLoanReceipt.nodeReceipts[0].tick,
            used: decodedExistingLoanReceipt.nodeReceipts[0].used,
            pending: decodedExistingLoanReceipt.nodeReceipts[0].pending,
          },
        ],
      };
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
              await nft1.getAddress(),
              tokenId,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("25")),
              "0x",
            ]),
            pool.interface.encodeFunctionData("repay", [encodedLoanReceipt]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#liquidate", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidates expired loan with ERC1155", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      const tokenId = (await extractEvent(liquidateTx, erc1155CollateralWrapper, "Transfer")).args[2];

      /* Validate events */
      const ids = (await extractEvent(liquidateTx, nft1, "TransferBatch")).args.ids;
      expect(ids).to.be.eql([123n]);

      const values = (await extractEvent(liquidateTx, nft1, "TransferBatch")).args[4];
      expect(values).to.be.eql([1n]);

      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate owner of collateral wrapper */
      expect(await erc1155CollateralWrapper.ownerOf(tokenId)).to.equal(await collateralLiquidator.getAddress());

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });

    it("liquidates expired loan with ERC1155 collateral wrapper", async function () {
      /* Create Loan */
      let [loanReceipt, loanReceiptHash, erc1155WrapperTokenId] = await createActiveERC1155CWLoan(
        FixedPoint.from("25")
      );

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, erc1155CollateralWrapper, "Transfer", {
        from: await pool.getAddress(),
        to: await collateralLiquidator.getAddress(),
        tokenId: erc1155WrapperTokenId,
      });

      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });

    it("fails on non-expired loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "LoanNotExpired");
    });

    it("fails on repaid loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan after expiration", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity + 1n);

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });
});
