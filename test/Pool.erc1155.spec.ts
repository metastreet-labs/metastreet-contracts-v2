import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC1155,
  TestProxy,
  TestLoanReceipt,
  TestDelegationRegistry,
  ExternalCollateralLiquidator,
  Pool,
  ERC1155CollateralWrapper,
  DepositERC20,
} from "../typechain";

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
  let delegationRegistry: TestDelegationRegistry;
  let ERC1155CollateralWrapper: ERC1155CollateralWrapper;
  let depositERC20Impl: DepositERC20;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");
    const depositERC20ImplFactory = await ethers.getContractFactory("DepositERC20");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC1155Factory.deploy("https://nft1.com/token/")) as TestERC1155;
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

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy ERC1155 collateral wrapper */
    ERC1155CollateralWrapper = await ERC1155CollateralWrapperFactory.deploy();
    await ERC1155CollateralWrapper.deployed();

    /* Deploy deposit erc20 implementation */
    depositERC20Impl = (await depositERC20ImplFactory.deploy()) as DepositERC20;
    await depositERC20Impl.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegationRegistry.address,
      depositERC20Impl.address,
      [ERC1155CollateralWrapper.address],
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
      await tok1.transfer(depositor.address, ethers.utils.parseEther("2000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mintBatch(accountBorrower.address, [123, 124, 125], [1, 2, 3], "0x");

    /* Mint token to borrower */
    await tok1.transfer(accountBorrower.address, ethers.utils.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);

    /* Approve ERC1155Wrapper to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(ERC1155CollateralWrapper.address, true);

    /* Approve pool to transfer ERC1155Wrapper NFT */
    await ERC1155CollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);
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
      expect(collateralWrappers[0]).to.equal(ERC1155CollateralWrapper.address);
      expect(collateralWrappers[1]).to.equal(ethers.constants.AddressZero);
      expect(collateralWrappers[2]).to.equal(ethers.constants.AddressZero);
    });
    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(collateralLiquidator.address);
    });
    it("returns expected delegation registry", async function () {
      expect(await pool.delegationRegistry()).to.equal(delegationRegistry.address);
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

  async function setupLiquidity(amount?: ethers.BigNumber = FixedPoint.from("25")): Promise<void> {
    const NUM_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), amount, 0);
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

  async function createActiveERC1155Loan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string, ethers.BigNumber, string]> {
    /* Mint ERC1155 Wrapper */
    const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
      nft1.address,
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
        ERC1155CollateralWrapper.address,
        ERC1155WrapperTokenId,
        FixedPoint.from("26"),
        await sourceLiquidity(FixedPoint.from("25"), 6),
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
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
      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          nft1.address,
          [123, 124, 124, 125, 125, 125],
          6,
          await sourceLiquidity(FixedPoint.from("10")),
          "0x"
        )
      ).to.equal(FixedPoint.from("10.082191780812160000"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          [123, 124, 124, 125, 125, 125],
          6,
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        )
      ).to.equal(FixedPoint.from("25.205479452030400000"));
    });

    it("fails on insufficient liquidity for erc1155", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("1000"),
          30 * 86400,
          nft1.address,
          [123, 124, 124, 125, 125, 125],
          6,
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
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
        nft1.address,
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
        nft1.address,
        [123, 124, 124, 125, 125, 125],
        6,
        await sourceLiquidity(FixedPoint.from("25"), 6),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: ERC1155WrapperTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(ERC1155CollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(ERC1155WrapperData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(ERC1155WrapperData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(1);

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

    it("originates erc1155 loan with delegation", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        nft1.address,
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
        nft1.address,
        [123, 124, 124, 125, 125, 125],
        6,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData, 3, 20, accountBorrower.address]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData, 3, 20, accountBorrower.address]
          )
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: ERC1155CollateralWrapper.address,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(ERC1155CollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(ERC1155WrapperData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(ERC1155WrapperData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(1);

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

    it("originates erc1155 loan for a 85 ETH principal", async function () {
      /* Mint ERC1155Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        nft1.address,
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
        nft1.address,
        [123, 124, 124, 125, 125, 125],
        6,
        await sourceLiquidity(FixedPoint.from("85"), 6),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("85"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
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
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("88"),
          await sourceLiquidity(FixedPoint.from("85"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      /* Validate events */
      await expectEvent(mintTx, ERC1155CollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(borrowTx, ERC1155CollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: ERC1155WrapperTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(ERC1155CollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(ERC1155WrapperData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(ERC1155WrapperData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(10);

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

    it("fails on erc1155 with invalid option encoding", async function () {
      /* Mint erc1155 */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        nft1.address,
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
            ERC1155CollateralWrapper.address,
            ERC1155WrapperTokenId,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"), 6),
            ethers.utils.solidityPack(["uint16", "uint16", "bytes"], [1, 20 + 31 * 3, ERC1155WrapperData])
          )
      ).to.be.reverted;
    });

    it("fails on insufficient liquidity with erc1155", async function () {
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        nft1.address,
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
            ERC1155CollateralWrapper.address,
            ERC1155WrapperTokenId,
            FixedPoint.from("122"),
            await sourceLiquidity(FixedPoint.from("85"), 6),
            ethers.utils.solidityPack(
              ["uint16", "uint16", "bytes"],
              [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
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
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(nft1.address, [124, 125], [1, 2]);
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(accountBorrower.address);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [124, 125, 125],
        3,
        await sourceLiquidity(FixedPoint.from("25"), 3),
        "0x"
      );

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          repayment,
          await sourceLiquidity(FixedPoint.from("25"), 3),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(pool.address);

      const ERC1155WrapperLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const ERC1155WrapperLoanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(ERC1155WrapperLoanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(ERC1155WrapperLoanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, ERC1155CollateralWrapper, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: ERC1155WrapperTokenId,
      });

      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash: ERC1155WrapperLoanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(ERC1155WrapperLoanReceiptHash)).to.equal(2);

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

      expect(await ERC1155CollateralWrapper.ownerOf(ERC1155WrapperTokenId)).to.equal(accountBorrower.address);
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;
    let ERC1155WrapperTokenId: ethers.BigNumber;
    let ERC1155WrapperData: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity(FixedPoint.from("50"));
    });

    it("refinance erc1155 loan at maturity with admin fee and same principal", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, ERC1155WrapperTokenId] = await createActiveERC1155Loan(FixedPoint.from("25"));

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
          await sourceLiquidity(FixedPoint.from("25"), 6)
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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(ERC1155CollateralWrapper.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(ERC1155WrapperTokenId);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(1);

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

    it("erc1155 loan fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

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
              await sourceLiquidity(FixedPoint.from("25"), 6),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25"), 6),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
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
          ERC1155CollateralWrapper.address,
          ERC1155WrapperTokenId,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1"), 6),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "bytes"],
            [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
          )
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = ERC1155CollateralWrapper.address;
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
              ERC1155CollateralWrapper.address,
              ERC1155WrapperTokenId,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 6),
              ethers.utils.solidityPack(
                ["uint16", "uint16", "bytes"],
                [1, ethers.utils.hexDataLength(ERC1155WrapperData), ERC1155WrapperData]
              ),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1"), 6),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

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

    it("erc1155 loan fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"), 6)
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on repaid loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

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
            await sourceLiquidity(FixedPoint.from("25"), 6)
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("erc1155 loan fails on liquidated loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveERC1155Loan(FixedPoint.from("25"));

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
            await sourceLiquidity(FixedPoint.from("25"), 6)
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
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, ERC1155CollateralWrapper, "Transfer", {
        from: pool.address,
        to: collateralLiquidator.address,
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
