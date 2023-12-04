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
  ReservoirCollectionPriceOracle,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";
import { oracle } from "../typechain/contracts";

describe("Pool Reservoir Price Oracle", function () {
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
  let priceOracle: ReservoirCollectionPriceOracle;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  /* API Response for Wrapped Cryptopunks
    {
      "price": 55.25,
      "message": {
        "id": "0xa3cba788f3b64d956bbb74dad453d6aabfce23ee7a708f5e75bd7f5d1822d366",
        "payload": "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000002febf6e45e0550000",
        "timestamp": 1702585739,
        "chainId": "1",
        "signature": "0xe6d145029c51c0d96865e093081af976dec51acdf284d86c396824f34d6eca7a31f2c053bdf80da435aa32d3d517bc8325a866233a5494e48b3485647aadb9ee1b"
      },
      "data": "0x0000000000000000000000000000000000000000000000000000000000000020a3cba788f3b64d956bbb74dad453d6aabfce23ee7a708f5e75bd7f5d1822d366000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000657b658b00000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000002febf6e45e05500000000000000000000000000000000000000000000000000000000000000000041e6d145029c51c0d96865e093081af976dec51acdf284d86c396824f34d6eca7a31f2c053bdf80da435aa32d3d517bc8325a866233a5494e48b3485647aadb9ee1b00000000000000000000000000000000000000000000000000000000000000"
    }
  */
  const RESERVOIR_MESSAGE_CALLDATA =
    "0x0000000000000000000000000000000000000000000000000000000000000020a3cba788f3b64d956bbb74dad453d6aabfce23ee7a708f5e75bd7f5d1822d366000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000657b658b00000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000002febf6e45e05500000000000000000000000000000000000000000000000000000000000000000041e6d145029c51c0d96865e093081af976dec51acdf284d86c396824f34d6eca7a31f2c053bdf80da435aa32d3d517bc8325a866233a5494e48b3485647aadb9ee1b00000000000000000000000000000000000000000000000000000000000000";

  /* Constants */
  const WPUNK_ID = ethers.BigNumber.from("4322");
  const WPUNK_OWNER = "0x83D6474E18215bFE7A101E37E9e2a746570B6834";
  const WPUNKS_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const WETH_OWNER = "0x6B44ba0a126a2A1a8aa6cD1AdeeD002e141Bcd44";
  const BLOCK_ID = 18786767;

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
    const reservoirPriceOracleFactory = await ethers.getContractFactory("ReservoirCollectionPriceOracle");
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

    /* Deploy reservoir price oracle */
    priceOracle = await reservoirPriceOracleFactory.deploy(
      5 * 60, // 5 minutes
      2, // LOWER min(Spot,TWAP)
      86400, // 24 hours
      true // only non-flagged tokens
    );
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
            [WPUNKS_ADDRESS],
            WETH_ADDRESS,
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
    nft1 = (await ethers.getContractAt("TestERC721", WPUNKS_ADDRESS)) as TestERC721;

    /* WETH contract */
    tok1 = (await ethers.getContractAt("TestERC20", WETH_ADDRESS)) as TestERC20;

    /* Arrange accounts */
    accountDepositor = await ethers.getImpersonatedSigner(WETH_OWNER);
    accountBorrower = await ethers.getImpersonatedSigner(WPUNK_OWNER);
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
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_RATIO_LIMITS = 6;
    const NUM_ABSOLUTE_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_ABSOLUTE_LIMITS; i++) {
      await pool.connect(accountDepositor).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = limit.mul(TICK_LIMIT_SPACING_BASIS_POINTS.add(10000)).div(10000);
    }

    limit = ethers.BigNumber.from(4000);
    for (let i = 0; i < NUM_RATIO_LIMITS; i++) {
      await pool.connect(accountDepositor).deposit(Tick.encode(limit, 0, 0, 18, 1), FixedPoint.from("20"), 0);
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
    const oraclePrice = await priceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [], [], oracleContext);
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
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(RESERVOIR_MESSAGE_CALLDATA), RESERVOIR_MESSAGE_CALLDATA]
      );

      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          nft1.address,
          WPUNK_ID,
          await sourceLiquidity(FixedPoint.from("10"), RESERVOIR_MESSAGE_CALLDATA),
          oracleContext
        )
      ).to.equal(FixedPoint.from("10.082191780812159999"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          WPUNK_ID,
          await sourceLiquidity(FixedPoint.from("25"), RESERVOIR_MESSAGE_CALLDATA),
          oracleContext
        )
      ).to.equal(FixedPoint.from("25.205479452030399993"));
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(RESERVOIR_MESSAGE_CALLDATA), RESERVOIR_MESSAGE_CALLDATA]
      );

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        WPUNK_ID,
        await sourceLiquidity(FixedPoint.from("25"), RESERVOIR_MESSAGE_CALLDATA),
        oracleContext
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          WPUNK_ID,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), RESERVOIR_MESSAGE_CALLDATA),
          oracleContext
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          WPUNK_ID,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"), RESERVOIR_MESSAGE_CALLDATA),
          oracleContext
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: WPUNK_ID,
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
      expect(decodedLoanReceipt.collateralTokenId).to.equal(WPUNK_ID);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(17);

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
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan with same principal and oracle context", async function () {
      /* Arbitrary non-empty oracle context */
      const oracleContext = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes"],
        [5, ethers.utils.hexDataLength(RESERVOIR_MESSAGE_CALLDATA), RESERVOIR_MESSAGE_CALLDATA]
      );

      /* Source liquidity */
      const ticks = await sourceLiquidity(FixedPoint.from("25"), RESERVOIR_MESSAGE_CALLDATA);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(FixedPoint.from("25"), 15 * 86400, nft1.address, WPUNK_ID, FixedPoint.from("26"), ticks, oracleContext);

      /* Extract loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(loanReceipt, decodedLoanReceipt.principal, 15 * 86400, FixedPoint.from("26"), ticks, oracleContext);
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
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(WPUNK_ID);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(17);
    });
  });
});
