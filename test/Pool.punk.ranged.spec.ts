import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
  PunkCollateralWrapper,
  ICryptoPunksMarket,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Punk Ranged Collection", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
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
  let punkCollateralWrapper: PunkCollateralWrapper;
  let punkData: any;
  let punkTokenId: bigint;
  let cryptoPunksMarket: ICryptoPunksMarket;

  /* Constants */
  const PUNK_ID_1 = BigInt("20");
  const PUNK_ID_2 = BigInt("28");
  const PUNK_ID_3 = BigInt("35");
  const PUNK_OWNER = "0xA858DDc0445d8131daC4d1DE01f834ffcbA52Ef1"; /* Yuga Labs address */
  const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
  const WPUNKS_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const BLOCK_ID = 17965920;

  before("deploy fixture", async function () {
    /* Skip test if no MAINNET_URL env variable */
    if (!process.env.MAINNET_URL) {
      this.skip();
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_URL,
            blockNumber: BLOCK_ID,
          },
        },
      ],
    });

    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const punkCollateralWrapperFactory = await ethers.getContractFactory("PunkCollateralWrapper");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateRangedCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("10000"))) as TestERC20;
    await tok1.waitForDeployment();

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

    /* Deploy bundle collateral wrapper */
    punkCollateralWrapper = await punkCollateralWrapperFactory.deploy(PUNKS_ADDRESS, WPUNKS_ADDRESS);
    await punkCollateralWrapper.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      [await punkCollateralWrapper.getAddress()]
    )) as Pool;
    await poolImpl.waitForDeployment();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      await poolImpl.getAddress(),
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256", "uint256", "address", "address", "uint64[]", "uint64[]"],
          [
            WPUNKS_ADDRESS,
            PUNK_ID_1,
            PUNK_ID_3,
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

    /* Punk contract */
    cryptoPunksMarket = (await ethers.getContractAt("ICryptoPunksMarket", PUNKS_ADDRESS)) as ICryptoPunksMarket;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = await ethers.getImpersonatedSigner(PUNK_OWNER);
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

    /* Approve token to transfer NFTs by offering punk for 0 ethers */
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_1, 0, await punkCollateralWrapper.getAddress());
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_2, 0, await punkCollateralWrapper.getAddress());
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_3, 0, await punkCollateralWrapper.getAddress());

    /* Mint bundle */
    const mintTx = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);
    punkTokenId = (await extractEvent(mintTx, punkCollateralWrapper, "PunkMinted")).args.tokenId;
    punkData = (await extractEvent(mintTx, punkCollateralWrapper, "PunkMinted")).args.encodedBundle;

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);

    /* Approve pool to transfer bundle NFT */
    await punkCollateralWrapper.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);
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
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateRangedCollectionPool");
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
      expect(collateralWrappers[0]).to.equal(await punkCollateralWrapper.getAddress());
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

  async function setupLiquidity(): Promise<void> {
    const NUM_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
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

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates bundle loan with ranged filter", async function () {
      /* Compute borrow options */
      const borrowOptions = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [1, ethers.dataLength(punkData), punkData]
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await punkCollateralWrapper.getAddress(),
        punkTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        borrowOptions
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, punkCollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: punkTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(await punkCollateralWrapper.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(punkTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.dataLength(punkData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(punkData);
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

    it("originates bundle loan with delegation and ranged filter", async function () {
      /* Compute borrow options */
      const borrowOptions = ethers.solidityPacked(
        ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
        [1, ethers.dataLength(punkData), punkData, 3, 20, await accountBorrower.getAddress()]
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        await punkCollateralWrapper.getAddress(),
        punkTokenId,
        await sourceLiquidity(FixedPoint.from("25")),
        borrowOptions
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25"),
          30 * 86400,
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), 3n),
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, punkCollateralWrapper, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: punkTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25"),
      });

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await punkCollateralWrapper.getAddress(),
        tokenId: punkTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(await punkCollateralWrapper.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(punkTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.dataLength(punkData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(punkData);
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
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance bundle loan at maturity with same principal", async function () {
      /* Compute borrow options */
      const borrowOptions = ethers.solidityPacked(
        ["uint16", "uint16", "bytes"],
        [1, ethers.dataLength(punkData), punkData]
      );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          borrowOptions
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await punkCollateralWrapper.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(punkTokenId);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(4);

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

      expect(await pool.adminFeeBalance()).to.equal(adminFee);
    });
  });
});
