import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  AlloraPriceOracle,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

/* Requires chain ID to be set to 11155111 for hardhat in hardhat.config.ts */
describe.skip("Pool Allora Price Oracle", function () {
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
  let priceOracle: AlloraPriceOracle;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  /* API Response for Watches (NFT ID: 23) */
  const data = {
    request_id: "8557fa1c-77d2-4744-a3c5-2ffce8b4956b",
    status: true,
    data: {
      signature:
        "0x286b85a22c8f0d4340be53e9ab241357bd8fd3939ec8c72b0bf5d02cd123277569917f80f430cff697d52474703ac71dfa31d3807a65785310704f66434fef061c",
      numeric_data: {
        topic_id: "4",
        numeric_values: ["13444395688084593000000"],
        timestamp: 1709116612,
        extra_data: "0x8730b88d28d6a481b2f0db59b73b83963bc5323cd009a27cf98e8b23203cf985",
      },
    },
  };
  const ALLORA_ADAPTER_NUMERIC_DATA = [
    data.data.signature,
    [
      ethers.BigNumber.from(data.data.numeric_data.topic_id),
      ethers.BigNumber.from(data.data.numeric_data.timestamp),
      data.data.numeric_data.extra_data,
      [ethers.BigNumber.from(data.data.numeric_data.numeric_values[0])],
    ],
    "0x",
  ];
  /* Constants */
  const WATCHES_ID = ethers.BigNumber.from("23");
  const WATCHES_ADDRESS = "0x75F9F22D1070fDd56bD1DDF2DB4d65aB0F759431";
  const WATCHES_OWNER = "0xD585c0c1287689eB60e3Fb59887B3633C386B207";
  const USDT_ADDRESS = "0x7f11f79DEA8CE904ed0249a23930f2e59b43a385";
  const USDT_OWNER = "0xb7F8C4e776AB9208a41D114a058Dc0F432bB1c45";
  const ALLORA_ADAPTER_ADDRESS = "0xBEd9F9B7509288fCfe4d49F761C625C832e6264A";
  const TOPIC_ID = 4;
  const BLOCK_ID = 5380190;

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
            jsonRpcUrl: process.env.SEPOLIA_URL,
            blockNumber: BLOCK_ID,
          },
        },
      ],
    });

    accounts = await ethers.getSigners();

    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const alloraPriceOracleFactory = await ethers.getContractFactory("AlloraPriceOracle");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

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

    /* Deploy allora price oracle */
    priceOracle = (await alloraPriceOracleFactory.deploy(
      ALLORA_ADAPTER_ADDRESS,
      TOPIC_ID,
      18,
      USDT_ADDRESS
    )) as AlloraPriceOracle;
    await priceOracle.deployed();

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
          ["address[]", "address", "address", "uint64[]", "uint64[]"],
          [
            [WATCHES_ADDRESS],
            USDT_ADDRESS,
            priceOracle.address,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* WPUNK contract */
    nft1 = (await ethers.getContractAt("TestERC721", WATCHES_ADDRESS)) as TestERC721;

    /* USDT contract */
    tok1 = (await ethers.getContractAt("TestERC20", USDT_ADDRESS)) as TestERC20;

    /* Arrange accounts */
    accountDepositor = await ethers.getImpersonatedSigner(USDT_OWNER);
    accountBorrower = await ethers.getImpersonatedSigner(WATCHES_OWNER);
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Approve TOK1 to Pool */
    await tok1.connect(accountDepositor).approve(pool.address, ethers.constants.MaxUint256);

    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.connect(accountDepositor).transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Transfer TOK1 to borrower */
    await tok1.connect(accountDepositor).transfer(accountBorrower.address, ethers.utils.parseEther("100"));

    /* Transfer TOK1 to lender */
    await tok1.connect(accountDepositor).transfer(accountLender.address, ethers.utils.parseEther("1000"));

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
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateCollectionPool");
    });
  });

  /****************************************************************************/
  /* Tick Helpers */
  /****************************************************************************/

  function scaleTickEncode(limit: ethers.BigNumber, decimals: number) {
    return Tick.encode(limit, undefined, undefined, decimals, 1);
  }

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_RATIO_LIMITS = 6;

    let limit = ethers.BigNumber.from(4000);
    for (let i = 0; i < NUM_RATIO_LIMITS; i++) {
      await pool.connect(accountDepositor).deposit(Tick.encode(limit, 0, 0, 18, 1), FixedPoint.from("2000", 6), 0);
      limit = limit.add(ethers.BigNumber.from(1000));
    }
  }

  async function sourceLiquidity(
    amount: ethers.BigNumber,
    oracleContext?: string = "0x",
    multiplier?: number = 1,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<ethers.BigNumber[]> {
    const oraclePrice = await priceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [WATCHES_ID], [1], oracleContext);
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const normalizedNodes = [...nodes];
    const ticks = [];

    /* Sort nodes by limits */
    normalizedNodes.sort((a, b) => {
      const limitA = Tick.decode(a.tick, oraclePrice).limit;
      const limitB = Tick.decode(b.tick, oraclePrice).limit;
      return limitA.lt(limitB) ? -1 : limitA.gt(limitB) ? 1 : 0;
    });

    let taken = ethers.constants.Zero;

    for (const node of normalizedNodes) {
      const limit = Tick.decode(node.tick, oraclePrice).limit;

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

    it("correctly quotes repayment for single collateral", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(encodedNumericData), encodedNumericData]
      );

      expect(
        await pool.quote(
          FixedPoint.from("1000", 6),
          30 * 86400,
          nft1.address,
          WATCHES_ID,
          await sourceLiquidity(FixedPoint.from("1000", 6), encodedNumericData),
          oracleContext
        )
      ).to.equal(FixedPoint.from("1008.219178", 6));

      expect(
        await pool.quote(
          FixedPoint.from("2500", 6),
          30 * 86400,
          nft1.address,
          WATCHES_ID,
          await sourceLiquidity(FixedPoint.from("2500", 6), encodedNumericData),
          oracleContext
        )
      ).to.equal(FixedPoint.from("2520.547945", 6));
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(encodedNumericData), encodedNumericData]
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("2500", 6),
        30 * 86400,
        nft1.address,
        WATCHES_ID,
        await sourceLiquidity(FixedPoint.from("2500", 6), encodedNumericData),
        oracleContext
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("2500", 6),
          30 * 86400,
          nft1.address,
          WATCHES_ID,
          FixedPoint.from("2600", 6),
          await sourceLiquidity(FixedPoint.from("2500", 6), encodedNumericData),
          oracleContext
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("2500", 6),
          30 * 86400,
          nft1.address,
          WATCHES_ID,
          FixedPoint.from("2600", 6),
          await sourceLiquidity(FixedPoint.from("2500", 6), encodedNumericData),
          oracleContext
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: WATCHES_ID,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("2500", 6),
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
      expect(decodedLoanReceipt.collateralTokenId).to.equal(WATCHES_ID);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(2);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("2500", 6));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan with same principal and oracle context", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(encodedNumericData), encodedNumericData]
      );

      /* Source liquidity */
      const ticks = await sourceLiquidity(FixedPoint.from("2500", 6), encodedNumericData);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("2500", 6),
          15 * 86400,
          nft1.address,
          WATCHES_ID,
          FixedPoint.from("2600", 6),
          ticks,
          oracleContext
        );

      /* Extract loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          FixedPoint.from("2600", 6),
          ticks,
          oracleContext
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;

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
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(WATCHES_ID);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(2);
    });
  });
});
