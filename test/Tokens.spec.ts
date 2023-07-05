/* eslint-disable camelcase */
import * as dotenv from "dotenv";

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { BigNumber } from "@ethersproject/bignumber";
import { Tick } from "./helpers/Tick";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";

import {
  Pool,
  TestLoanReceipt,
  TestERC20,
  IERC721,
  EnglishAuctionCollateralLiquidator,
  ExternalCollateralLiquidator,
  TestDelegationRegistry,
  TestERC721,
} from "../typechain";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { FixedPoint } from "./helpers/FixedPoint";

dotenv.config();

describe.only("Weird Tokens", function () {
  /* Accounts */
  let nft: IERC721;
  let tok1: TestERC20;
  let accounts: SignerWithAddress[];
  let accountDepositors: SignerWithAddress[];
  let _borrower: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let accountLender: SignerWithAddress;

  /* MetaStreet contracts */
  let loanReceiptLib: TestLoanReceipt;
  let poolImpl: Pool;
  let pool: Pool;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let delegationRegistry: TestDelegationRegistry;

  /* Snapshot id */
  let snapshotId: string;

  /* Loan constants */
  const NFT_ID = BigNumber.from("24526111578964355427464788391204295010760968458116003736309517252594096961547");
  const BORROWER = "0x569bF2E3e06AFfD67Db23Fa18e04221A53Ca8334";
  const COLLATERAL_TOKEN_ADDRESS = "0xa342f5d851e866e18ff98f351f2c6637f4478db5"; /* Sandbox Assets */
  const BLOCK_ID = 17629348;

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
    duration?: number = 2,
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

  before("fork mainnet and deploy fixture", async function () {
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
            blockNumber: BLOCK_ID + 1,
          },
        },
      ],
    });

    /* Get accounts */
    accounts = await ethers.getSigners();

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);

    /* Create factories */
    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");

    nft = (await ethers.getContractAt("IERC721", COLLATERAL_TOKEN_ADDRESS)) as IERC721;

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

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

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegationRegistry.address,
      [],
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
            COLLATERAL_TOKEN_ADDRESS,
            tok1.address,
            [7 * 86400, 14 * 86400, 30 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    _borrower = await ethers.getImpersonatedSigner(BORROWER);

    /*********************/
    /* Fund and Approve */
    /*******************/

    /* Send borrower some eth */
    await accounts[0].sendTransaction({
      to: BORROWER,
      value: ethers.utils.parseEther("1"),
    });

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
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

    /* Mint token to borrower */
    await tok1.transfer(_borrower.address, ethers.utils.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft.connect(_borrower).setApprovalForAll(pool.address, true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(_borrower).approve(pool.address, ethers.constants.MaxUint256);
  });

  after("reset network", async () => {
    await network.provider.request({ method: "hardhat_reset" });
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#borrow", async function () {
    it("cannot borrow against sandbox 1155", async function () {
      await setupLiquidity();

      const borrowTx = await pool
        .connect(_borrower)
        .borrow(
          FixedPoint.from("1"),
          30 * 86400,
          COLLATERAL_TOKEN_ADDRESS,
          NFT_ID,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));
    });
  });
});
