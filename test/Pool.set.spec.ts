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
  ExternalCollateralLiquidator,
  Pool,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Set Collection", function () {
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
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateSetCollectionPool", [
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

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegateRegistryV1.address,
      delegateRegistryV2.address,
      erc20DepositTokenImpl.address,
      []
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "uint256[]", "address", "address", "uint64[]", "uint64[]"],
          [
            nft1.address,
            [123, 124, 125],
            tok1.address,
            ethers.constants.AddressZero,
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
    await nft1.mint(accountBorrower.address, 126);

    /* Mint token to borrower */
    await tok1.transfer(accountBorrower.address, ethers.utils.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);
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
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateSetCollectionPool");
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
      expect(collateralWrappers[0]).to.equal(ethers.constants.AddressZero);
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
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

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

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes repayment with set collection filter", async function () {
      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          nft1.address,
          123,
          await sourceLiquidity(FixedPoint.from("10")),
          "0x"
        )
      ).to.eql([FixedPoint.from("10.082191780812159999"), ethers.constants.Zero]);

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        )
      ).to.eql([FixedPoint.from("25.205479452030399994"), ethers.constants.Zero]);
    });

    it("fails on unsupported collateral with set collection filter", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          nft1.address,
          126,
          await sourceLiquidity(FixedPoint.from("10")),
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan with set collection filter", async function () {
      /* Quote repayment */
      const [repayment, oracleFee] = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
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
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

    it("originates loan with delegation with set collection filter", async function () {
      /* Compute borrow options */
      const borrowOptions = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes20"],
        [3, 20, accountBorrower.address]
      );

      /* Quote repayment */
      const [repayment, oracleFee] = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        123,
        await sourceLiquidity(FixedPoint.from("25")),
        borrowOptions
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

      /* Validate delegation */
      expect(
        await delegateRegistryV1.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(true);
    });

    it("originates loan with v2 delegation with set collection filter", async function () {
      /* Compute borrow options */
      const borrowOptions = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes20"],
        [4, 20, accountBorrower.address]
      );

      /* Quote repayment */
      const [repayment, oracleFee] = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        await sourceLiquidity(FixedPoint.from("25")),
        borrowOptions
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV2, "DelegateERC721", {
        from: pool.address,
        to: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        rights: ethers.constants.HashZero,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

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

      /* Validate delegation */
      expect(
        await delegateRegistryV2.checkDelegateForERC721(
          accountBorrower.address,
          pool.address,
          nft1.address,
          123,
          ethers.constants.HashZero
        )
      ).to.equal(true);
    });
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan at maturity with same principal and set collection filter", async function () {
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

      /* Extract loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

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
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

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
    });
  });
});
