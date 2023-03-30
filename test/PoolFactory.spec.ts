import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expectEvent, extractEvent } from "../test/helpers/EventUtilities";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  ExternalCollateralLiquidator,
  TestDelegationRegistry,
  FixedRateSingleCollectionPool,
  Pool,
  PoolFactory,
  BundleCollateralWrapper,
} from "../typechain";

import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("PoolFactory", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let poolFactory: PoolFactory;
  let snapshotId: string;
  let delegationRegistry: TestDelegationRegistry;
  let bundleCollateralWrapper: BundleCollateralWrapper;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const poolFactoryFactory = await ethers.getContractFactory("PoolFactory");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("FixedRateSingleCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy collateral liquidator */
    const proxy = await testProxyFactory.deploy(
      collateralLiquidatorImpl.address,
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [accounts[5].address])
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(delegationRegistry.address, [bundleCollateralWrapper.address])) as Pool;
    await poolImpl.deployed();

    /* Deploy Pool Factory */
    poolFactory = await poolFactoryFactory.deploy();
    await poolFactory.deployed();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#create", async function () {
    it("creates a pool", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64", "uint256", "tuple(uint64, uint64, uint64)"],
        [
          nft1.address,
          tok1.address,
          30 * 86400,
          45,
          [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")],
        ]
      );
      const createTx = await poolFactory
        .connect(accounts[5])
        .create(poolImpl.address, params, collateralLiquidator.address);

      /* Validate events */
      await expectEvent(createTx, poolFactory, "PoolCreated", {
        deploymentHash: ethers.utils.solidityKeccak256(
          ["uint256", "address", "address"],
          [network.config.chainId, poolImpl.address, collateralLiquidator.address]
        ),
      });

      /* Get pool instance */
      const poolAddress = (await extractEvent(createTx, poolFactory, "PoolCreated")).args.pool;
      const pool = (await ethers.getContractAt("Pool", poolAddress)) as Pool;

      /* Check pool factory is pool admin */
      expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), poolFactory.address)).to.equal(true);
    });
    it("fails on invalid params", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64", "uint256"],
        [
          nft1.address,
          tok1.address,
          30 * 86400,
          45,
          /* Missing interest rate model params */
        ]
      );
      await expect(poolFactory.create(poolImpl.address, params, collateralLiquidator.address)).to.be.reverted;
    });
  });

  /* Helper function to create a pool */
  async function createPool(): Promise<string> {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64", "uint256", "tuple(uint64, uint64, uint64)"],
      [
        nft1.address,
        tok1.address,
        30 * 86400,
        45,
        [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")],
      ]
    );
    const createTx = await poolFactory
      .connect(accounts[5])
      .create(poolImpl.address, params, collateralLiquidator.address);
    return (await extractEvent(createTx, poolFactory, "PoolCreated")).args.pool;
  }

  describe("#isPool", async function () {
    it("returns true for created pools", async function () {
      const pool1 = await createPool();
      const pool2 = await createPool();

      expect(await poolFactory.isPool(pool1)).to.equal(true);
      expect(await poolFactory.isPool(pool2)).to.equal(true);
      expect(await poolFactory.isPool(collateralLiquidator.address)).to.equal(false);
    });
  });

  describe("#getPools,getPoolCount,getPoolAt", async function () {
    it("returns created pools", async function () {
      expect(await poolFactory.getPools()).to.deep.equal([]);
      expect(await poolFactory.getPoolCount()).to.equal(0);

      const pool1 = await createPool();
      const pool2 = await createPool();

      expect(await poolFactory.getPools()).to.deep.equal([pool1, pool2]);
      expect(await poolFactory.getPoolCount()).to.equal(2);
      expect(await poolFactory.getPoolAt(0)).to.equal(pool1);
      expect(await poolFactory.getPoolAt(1)).to.equal(pool2);
    });
    it("fails on invalid index", async function () {
      const pool1 = await createPool();
      const pool2 = await createPool();

      await expect(poolFactory.getPoolAt(2)).to.be.reverted;
    });
  });

  describe("#unregisterPool", async function () {
    it("unregisters a pool", async function () {
      const pool1 = await createPool();
      const pool2 = await createPool();

      expect(await poolFactory.getPools()).to.deep.equal([pool1, pool2]);

      await poolFactory.unregisterPool(pool1);

      expect(await poolFactory.isPool(pool1)).to.equal(false);
      expect(await poolFactory.getPools()).to.deep.equal([pool2]);
    });
    it("fails on invalid caller", async function () {
      const pool1 = await createPool();

      await expect(poolFactory.connect(accounts[3]).unregisterPool(pool1)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });
});
