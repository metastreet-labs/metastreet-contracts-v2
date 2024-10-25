import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ChainlinkPriceOracle,
  ExternalCollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Chainlink Price Oracle (6 decimals)", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: Pool;
  let snapshotId: string;
  let accountDepositor: SignerWithAddress;
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let priceOracle: ChainlinkPriceOracle;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  const SCALE = 10n ** 12n;

  const XAUM_ID = BigInt("66");
  const XAUM_OWNER = "0x89Bb23E4a82E04a253d9f11767feDf321C127799";
  const XAUM_ADDRESS = "0x67dcC9C33363Cc0e650738528Fe4Fef1d658C7EE";
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const USDC_OWNER = "0x54edC2D90BBfE50526E333c7FfEaD3B0F22D39F0";
  const BLOCK_ID = 20991555;

  /* XAU/USD */
  const BASE_PRICE_FEED = "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6";

  /* USDC/USD */
  const QUOTE_PRICE_FEED = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

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

    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const chainlinkPriceOracleFactory = await ethers.getContractFactory("ChainlinkPriceOracle");
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

    /* XAUM contract */
    nft1 = (await ethers.getContractAt("TestERC721", XAUM_ADDRESS)) as TestERC721;

    /* USDC contract */
    tok1 = (await ethers.getContractAt("TestERC20", USDC_ADDRESS)) as TestERC20;

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

    /* Deploy chainlink price oracle */
    priceOracle = await chainlinkPriceOracleFactory.deploy(BASE_PRICE_FEED, QUOTE_PRICE_FEED);
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
    accountDepositor = await ethers.getImpersonatedSigner(USDC_OWNER);
    accountBorrower = await ethers.getImpersonatedSigner(XAUM_OWNER);
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Approve Pool */
    await tok1.connect(accountDepositor).approve(await pool.getAddress(), ethers.MaxUint256);

    /* Transfer TOK1 to borrower */
    await tok1.connect(accountDepositor).transfer(await accountBorrower.getAddress(), FixedPoint.from("1000000", 6));

    /* Transfer TOK1 to collateral liquidator */
    await tok1.connect(accountDepositor).transfer(await accountLiquidator.getAddress(), FixedPoint.from("1000000", 6));

    /* Transfer TOK1 to lender */
    await tok1.connect(accountDepositor).transfer(await accountLender.getAddress(), FixedPoint.from("1000000", 6));

    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

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
  /* Tick Helpers */
  /****************************************************************************/

  function scaleTickEncode(limit: bigint, decimals: number) {
    return Tick.encode(limit, undefined, undefined, decimals, 1);
  }

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_RATIO_LIMITS = 6;

    let limit = BigInt(4000);
    for (let i = 0; i < NUM_RATIO_LIMITS; i++) {
      await pool.connect(accountDepositor).deposit(scaleTickEncode(limit, 18), FixedPoint.from("35000", 6), 0);
      limit = limit + BigInt(1000);
    }
  }

  async function sourceLiquidity(
    amount: bigint,
    multiplier?: bigint = 1n,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<bigint[]> {
    const normalizedAmount = amount * SCALE;
    const oraclePrice = (await priceOracle.price(XAUM_ADDRESS, USDC_ADDRESS, [XAUM_ID], [1], "0x")) * SCALE;
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

      const take = minBN(minBN(limit * multiplier - taken, node.available), normalizedAmount - taken);

      if (take === 0n) break;

      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== normalizedAmount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);
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
      expect(
        await pool.quote(
          FixedPoint.from("2000", 6),
          30 * 86400,
          await nft1.getAddress(),
          XAUM_ID,
          await sourceLiquidity(FixedPoint.from("2000", 6)),
          "0x"
        )
      ).to.equal(FixedPoint.from("2016.438357", 6));

      expect(
        await pool.quote(
          FixedPoint.from("1500", 6),
          30 * 86400,
          await nft1.getAddress(),
          XAUM_ID,
          await sourceLiquidity(FixedPoint.from("1500", 6)),
          "0x"
        )
      ).to.equal(FixedPoint.from("1512.328768", 6));
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("2000", 6),
        30 * 86400,
        await nft1.getAddress(),
        XAUM_ID,
        await sourceLiquidity(FixedPoint.from("2000", 6)),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("2000", 6),
          30 * 86400,
          await nft1.getAddress(),
          XAUM_ID,
          FixedPoint.from("2500", 6),
          await sourceLiquidity(FixedPoint.from("2000", 6)),
          "0x"
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("2000", 6),
          30 * 86400,
          await nft1.getAddress(),
          XAUM_ID,
          FixedPoint.from("2500", 6),
          await sourceLiquidity(FixedPoint.from("2000", 6)),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: XAUM_ID,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("2000", 6),
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
      expect(decodedLoanReceipt.collateralTokenId).to.equal(XAUM_ID);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(5);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("2000"));
      expect(totalPending).to.closeTo(repayment * SCALE, BigInt("1000000000000"));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });
  });
});
