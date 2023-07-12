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
  Pool,
  PoolFactory,
  BundleCollateralWrapper,
} from "../typechain";

import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("PoolFactory", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let tok2: TestERC20;
  let nft1: TestERC721;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let poolFactoryImpl: PoolFactory;
  let poolFactory: PoolFactory;
  let snapshotId: string;
  let delegationRegistry: TestDelegationRegistry;
  let bundleCollateralWrapper: BundleCollateralWrapper;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const erc1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const poolFactoryImplFactory = await ethers.getContractFactory("PoolFactory");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    tok2 = (await testERC20Factory.deploy("Token 2", "TOK2", 6, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok2.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy collateral liquidator implementation */
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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegationRegistry.address,
      [bundleCollateralWrapper.address],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool factory implementation */
    poolFactoryImpl = await poolFactoryImplFactory.deploy();
    await poolFactoryImpl.deployed();

    /* Deploy pool factory */
    proxy = await erc1967ProxyFactory.deploy(
      poolFactoryImpl.address,
      poolFactoryImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.deployed();
    poolFactory = (await ethers.getContractAt("PoolFactory", proxy.address)) as PoolFactory;
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
    it("matches expected implementation", async function () {
      expect(await poolFactory.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#create", async function () {
    it("creates a pool", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [7 * 86400, 14 * 86400, 30 * 86400],
          [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
        ]
      );
      const createTx = await poolFactory.connect(accounts[5]).create(poolImpl.address, params);

      /* Validate events */
      await expectEvent(createTx, poolFactory, "PoolCreated", {
        implementation: poolImpl.address,
      });

      /* Get pool instance */
      const poolAddress = (await extractEvent(createTx, poolFactory, "PoolCreated")).args.pool;
      const pool = (await ethers.getContractAt("Pool", poolAddress)) as Pool;

      /* Check pool factory is admin */
      expect(await pool.admin()).to.equal(poolFactory.address);
    });

    it("fails on invalid params", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address"],
        [
          nft1.address,
          tok1.address,
          /* Missing duration and rate params */
        ]
      );
      await expect(poolFactory.create(poolImpl.address, params)).to.be.reverted;
    });

    it("fails on invalid token decimal", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok2.address,
          [7 * 86400, 14 * 86400, 30 * 86400],
          [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
        ]
      );
      await expect(poolFactory.create(poolImpl.address, params)).to.be.reverted;
    });
  });

  describe("#createProxied", async function () {
    let poolBeacon: ethers.Contract;

    beforeEach("sets up pool beacon", async function () {
      const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon");
      poolBeacon = await upgradeableBeaconFactory.deploy(poolImpl.address);
      await poolBeacon.deployed();
    });

    it("creates a proxied pool", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [7 * 86400, 14 * 86400, 30 * 86400],
          [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
        ]
      );
      const createTx = await poolFactory.connect(accounts[5]).createProxied(poolBeacon.address, params);

      /* Validate events */
      await expectEvent(createTx, poolFactory, "PoolCreated", {
        implementation: poolBeacon.address,
      });

      /* Get pool instance */
      const poolAddress = (await extractEvent(createTx, poolFactory, "PoolCreated")).args.pool;
      const pool = (await ethers.getContractAt("Pool", poolAddress)) as Pool;

      /* Check pool factory is admin */
      expect(await pool.admin()).to.equal(poolFactory.address);
    });

    it("fails on invalid params", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64"],
        [
          nft1.address,
          tok1.address,
          30 * 86400,
          /* Missing interest rate model params */
        ]
      );
      await expect(poolFactory.create(poolBeacon.address, params)).to.be.reverted;
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  /* Helper function to create a pool */
  async function createPool(): Promise<string> {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64[]", "uint64[]"],
      [
        nft1.address,
        tok1.address,
        [7 * 86400, 14 * 86400, 30 * 86400],
        [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
      ]
    );
    const createTx = await poolFactory.connect(accounts[5]).create(poolImpl.address, params);
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

  /****************************************************************************/
  /* Admin API */
  /****************************************************************************/

  describe("#getImplementation", async function () {
    it("returns correct implementation", async function () {
      expect(await poolFactory.getImplementation()).to.equal(poolFactoryImpl.address);
    });
  });

  describe("#upgradeToAndCall", async function () {
    it("upgrades to new implementation contract", async function () {
      const poolFactoryImplFactory = await ethers.getContractFactory("PoolFactory");
      const newPoolFactoryImpl = await poolFactoryImplFactory.deploy();
      await newPoolFactoryImpl.deployed();

      const upgradeToAndCallTx = await poolFactory.upgradeToAndCall(newPoolFactoryImpl.address, "0x");

      /* Validate events */
      await expectEvent(upgradeToAndCallTx, poolFactory, "Upgraded", {
        implementation: newPoolFactoryImpl.address,
      });

      /* Validate state */
      expect(await poolFactory.getImplementation()).to.equal(newPoolFactoryImpl.address);
    });
    it("fails on invalid owner", async function () {
      await expect(poolFactory.connect(accounts[1]).upgradeToAndCall(tok1.address, "0x")).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });
});
