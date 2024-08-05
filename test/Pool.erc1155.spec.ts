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
  let ERC1155CollateralWrapper: ERC1155CollateralWrapper;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
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
    ERC1155CollateralWrapper = await ERC1155CollateralWrapperFactory.deploy();
    await ERC1155CollateralWrapper.waitForDeployment();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      [await ERC1155CollateralWrapper.getAddress()]
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
      await tok1.transfer(await depositor.getAddress(), ethers.parseEther("2000"));
      await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mintBatch(await accountBorrower.getAddress(), [123, 124, 125], [1, 2, 3], "0x");

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

    /* Approve ERC1155Wrapper to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await ERC1155CollateralWrapper.getAddress(), true);

    /* Approve pool to transfer ERC1155Wrapper NFT */
    await ERC1155CollateralWrapper.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);
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
      expect(await pool.currencyToken()).to.equal(await tok1.getAddress());
    });

    it("returns expected admin fee rate", async function () {
      expect(await pool.adminFeeRate()).to.equal(0);
    });

    it("returns expected collateral wrappers", async function () {
      const collateralWrappers = await pool.collateralWrappers();
      expect(collateralWrappers[0]).to.equal(await ERC1155CollateralWrapper.getAddress());
      expect(collateralWrappers[1]).to.equal(ethers.ZeroAddress);
      expect(collateralWrappers[2]).to.equal(ethers.ZeroAddress);
    });

    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(await collateralLiquidator.getAddress());
    });

    it("returns expected delegation registry v1", async function () {
      expect(await pool.delegationRegistry()).to.equal(await delegateRegistryV1.getAddress());
    });

    it("returns expected delegation registry v2", async function () {
      expect(await pool.delegationRegistryV2()).to.equal(await delegateRegistryV2.getAddress());
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function setupLiquidity(amount?: bigint = FixedPoint.from("25")): Promise<void> {
    const NUM_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), amount, 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10000n)) / 10000n;
    }
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

  async function createActiveERC1155Loan(
    principal: bigint,
    duration?: number = 30 * 86400
  ): Promise<[string, string, bigint, string]> {
    /* Mint ERC1155 Wrapper */
    const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
      await nft1.getAddress(),
      [123, 124, 125],
      [1, 2, 2]
    );
    const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
    const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.encodedBatch;

    /* Borrow */
    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(
        FixedPoint.from("25"),
        30 * 86400,
        await ERC1155CollateralWrapper.getAddress(),
        ERC1155WrapperTokenId,
        FixedPoint.from("26"),
        await sourceLiquidity(FixedPoint.from("25"), 6n),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
        )
      );

    /* Extract loan receipt */
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

    return [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId, ERC1155WrapperData];
  }

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes repayment for erc1155", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          await sourceLiquidity(FixedPoint.from("10")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        )
      ).to.equal(FixedPoint.from("10.082191780812160000"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        )
      ).to.equal(FixedPoint.from("25.205479452030400000"));
    });

    it("fails on insufficient liquidity for erc1155", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      await expect(
        pool.quote(
          FixedPoint.from("1000"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates erc1155 loan", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await ERC1155CollateralWrapper.getAddress(),
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
          await ERC1155CollateralWrapper.getAddress(),
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
          await ERC1155CollateralWrapper.getAddress(),
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
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
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
      expect(decodedLoanReceipt.collateralToken).to.equal(await ERC1155CollateralWrapper.getAddress());
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

    it("originates erc1155 loan with delegation", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await ERC1155CollateralWrapper.getAddress(),
        ERC1155WrapperTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData, 3, 20, await accountBorrower.getAddress()]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData, 3, 20, await accountBorrower.getAddress()]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData, 3, 20, await accountBorrower.getAddress()]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await ERC1155CollateralWrapper.getAddress(),
        tokenId: ERC1155WrapperTokenId,
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
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await ERC1155CollateralWrapper.getAddress());
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

    it("originates erc1155 loan for a 85 ETH principal", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("85"),
        30 * 86400,
        await ERC1155CollateralWrapper.getAddress(),
        ERC1155WrapperTokenId,
        await sourceLiquidity(FixedPoint.from("85"), 6n),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
        )
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("85"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
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
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Validate events */
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
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
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await ERC1155CollateralWrapper.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.dataLength(ERC1155WrapperData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(ERC1155WrapperData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(10);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("85"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("fails on erc1155 with invalid option encoding", async function () {
      /* Mint erc1155 */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      /* Set length of tokenId to 31 instead of 32 */
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            await ERC1155CollateralWrapper.getAddress(),
            ERC1155WrapperTokenId,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"), 6n),
            ethers.solidityPacked(["uint16", "uint16", "bytes"], [1, 20 + 31 * 3, ERC1155WrapperData])
          )
      ).to.be.reverted;
    });

    it("fails on insufficient liquidity with erc1155", async function () {
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [123, 124, 125],
        [1, 2, 3]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("120"),
            30 * 86400,
            await ERC1155CollateralWrapper.getAddress(),
            ERC1155WrapperTokenId,
            FixedPoint.from("122"),
            await sourceLiquidity(FixedPoint.from("85"), 6n),
            ethers.solidityPacked(
              ["uint16", "uint16", "bytes"],
              [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
            )
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays erc1155 loan at maturity", async function () {
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        await nft1.getAddress(),
        [124, 125],
        [1, 2]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(
        await accountBorrower.getAddress()
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await ERC1155CollateralWrapper.getAddress(),
        ERC1155WrapperTokenId,
        await sourceLiquidity(FixedPoint.from("25"), 3n),
        ethers.solidityPacked(
          ["uint16", "uint16", "bytes"],
          [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
        )
      );

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          repayment,
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(await pool.getAddress());

      const ERC1155WrapperLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const ERC1155WrapperLoanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(ERC1155WrapperLoanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(ERC1155WrapperLoanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, ERC1155CollateralWrapper, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash: ERC1155WrapperLoanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(ERC1155WrapperLoanReceiptHash)).to.equal(2);

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

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(
        await accountBorrower.getAddress()
      );
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;
    let ERC1155WrapperTokenId: bigint;
    let ERC1155WrapperData: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity(FixedPoint.from("50"));
    });

    it("refinance erc1155 loan at maturity with admin fee and same principal", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId] = await createActiveERC1155Loan(FixedPoint.from("25"));

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
          await sourceLiquidity(FixedPoint.from("25"), 6n),
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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await ERC1155CollateralWrapper.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(1);

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

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);

      expect(await pool.adminFeeBalance()).to.closeTo((adminFee * 9500n) / 10000n, "1");
    });

    it("erc1155 loan fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId] = await createActiveERC1155Loan(FixedPoint.from("25"));

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
              await sourceLiquidity(FixedPoint.from("25"), 6n),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25"), 6n),
              "0x",
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFee(500);
      [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId, ERC1155WrapperData] = await createActiveERC1155Loan(
        FixedPoint.from("25")
      );

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          1,
          await ERC1155CollateralWrapper.getAddress(),
          ERC1155WrapperTokenId,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1"), 6n),
          ethers.solidityPacked(
            ["uint16", "uint16", "bytes"],
            [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
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
              await ERC1155CollateralWrapper.getAddress(),
              ERC1155WrapperTokenId,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 6n),
              ethers.solidityPacked(
                ["uint16", "uint16", "bytes"],
                [1, ethers.dataLength(ERC1155WrapperData), ERC1155WrapperData]
              ),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 6n),
              "0x",
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFee(500);
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("1")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("erc1155 loan fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFee(500);
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            "0xa9059cbb0000000000000000000000001f9090aae28b8a3dceadf281b0f12828e676c326",
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"), 6n),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on repaid loan", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

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
            await sourceLiquidity(FixedPoint.from("25"), 6n),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on liquidated loan", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

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
            await sourceLiquidity(FixedPoint.from("25"), 6n),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#liquidate", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;
    let ERC1155WrapperTokenId: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidates expired erc1155 loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId] = await createActiveERC1155Loan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, ERC1155CollateralWrapper, "Transfer", {
        from: await pool.getAddress(),
        to: await collateralLiquidator.getAddress(),
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });
  });
});
