import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expectEvent, extractEvent } from "../test/helpers/EventUtilities";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  ExternalCollateralLiquidator,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  Pool,
  PoolFactory,
  BundleCollateralWrapper,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("PoolFactory", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let poolFactoryImpl: PoolFactory;
  let poolFactory: PoolFactory;
  let snapshotId: string;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const erc1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const poolFactoryImplFactory = await ethers.getContractFactory("PoolFactory");
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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegateRegistryV1.address,
      delegateRegistryV2.address,
      erc20DepositTokenImpl.address,
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
      expect(await poolFactory.IMPLEMENTATION_VERSION()).to.equal("1.2");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#create", async function () {
    it("creates a pool", async function () {
      /* Add pool implementation to allowlist */
      await poolFactory.addPoolImplementation(poolImpl.address);

      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [30 * 86400, 14 * 86400, 7 * 86400],
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

    it("fails on invalid pool implementation", async function () {
      /* Remove pool implementation from allowlist */
      await poolFactory.removePoolImplementation(poolImpl.address);

      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [30 * 86400, 14 * 86400, 7 * 86400],
          [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
        ]
      );
      await expect(poolFactory.connect(accounts[5]).create(poolImpl.address, params)).to.be.revertedWithCustomError(
        poolFactory,
        "UnsupportedImplementation"
      );
    });

    it("fails on invalid params", async function () {
      /* Add pool implementation to allowlist */
      await poolFactory.addPoolImplementation(poolImpl.address);

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

    it("fails on invalid token decimals", async function () {
      /* Create token with 6 decimals */
      const testERC20Factory = await ethers.getContractFactory("TestERC20");
      const tok2 = (await testERC20Factory.deploy("Token 2", "TOK2", 6, ethers.utils.parseEther("10000"))) as TestERC20;
      await tok2.deployed();

      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok2.address,
          [30 * 86400, 14 * 86400, 7 * 86400],
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
      /* Add pool beacon to allowlist */
      await poolFactory.addPoolImplementation(poolBeacon.address);

      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [30 * 86400, 14 * 86400, 7 * 86400],
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

    it("fails on invalid pool beacon", async function () {
      /* Remove pool beacon from allowlist */
      await poolFactory.removePoolImplementation(poolBeacon.address);

      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64[]", "uint64[]"],
        [
          nft1.address,
          tok1.address,
          [30 * 86400, 14 * 86400, 7 * 86400],
          [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
        ]
      );
      await expect(
        poolFactory.connect(accounts[5]).createProxied(poolBeacon.address, params)
      ).to.be.revertedWithCustomError(poolFactory, "UnsupportedImplementation");
    });

    it("fails on invalid params", async function () {
      /* Add pool beacon to allowlist */
      await poolFactory.addPoolImplementation(poolBeacon.address);

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
        [30 * 86400, 14 * 86400, 7 * 86400],
        [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
      ]
    );
    const createTx = await poolFactory.connect(accounts[5]).create(poolImpl.address, params);
    return (await extractEvent(createTx, poolFactory, "PoolCreated")).args.pool;
  }

  describe("#isPool", async function () {
    beforeEach("add pool implementation to allowlist", async function () {
      /* Add pool implementation to allowlist */
      await poolFactory.addPoolImplementation(poolImpl.address);
    });

    it("returns true for created pools", async function () {
      const pool1 = await createPool();
      const pool2 = await createPool();

      expect(await poolFactory.isPool(pool1)).to.equal(true);
      expect(await poolFactory.isPool(pool2)).to.equal(true);
      expect(await poolFactory.isPool(collateralLiquidator.address)).to.equal(false);
    });
  });

  describe("#getPools,getPoolCount,getPoolAt", async function () {
    beforeEach("add pool implementation to allowlist", async function () {
      /* Add pool implementation to allowlist */
      await poolFactory.addPoolImplementation(poolImpl.address);
    });

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

  describe("#getPoolImplementations", async function () {
    let poolBeacon: ethers.Contract;

    beforeEach("sets up pool beacon", async function () {
      const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon");
      poolBeacon = await upgradeableBeaconFactory.deploy(poolImpl.address);
      await poolBeacon.deployed();
    });

    it("returns current implementations", async function () {
      expect(await poolFactory.getPoolImplementations()).to.deep.equal([]);

      await poolFactory.addPoolImplementation(poolImpl.address);
      await poolFactory.addPoolImplementation(poolBeacon.address);

      expect(await poolFactory.getPoolImplementations()).to.deep.equal([poolImpl.address, poolBeacon.address]);

      await poolFactory.removePoolImplementation(poolBeacon.address);

      expect(await poolFactory.getPoolImplementations()).to.deep.equal([poolImpl.address]);
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

  describe("#addPoolImplementation", async function () {
    it("adds pool implementation", async function () {
      /* Add pool implementation */
      const addPoolImplTx = await poolFactory.addPoolImplementation(poolImpl.address);

      /* Validate events */
      await expectEvent(addPoolImplTx, poolFactory, "PoolImplementationAdded", {
        implementation: poolImpl.address,
      });

      /* Validate state */
      expect(await poolFactory.getPoolImplementations()).to.deep.equal([poolImpl.address]);

      /* Subsequent add does nothing */
      const addPoolImplTx2 = await poolFactory.addPoolImplementation(poolImpl.address);
      expect((await addPoolImplTx2.wait()).logs.length).to.equal(0);

      /* Validate state */
      expect(await poolFactory.getPoolImplementations()).to.deep.equal([poolImpl.address]);
    });
    it("fails on invalid owner", async function () {
      await expect(poolFactory.connect(accounts[1]).addPoolImplementation(poolImpl.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("#removePoolImplementation", async function () {
    it("removes pool implementation", async function () {
      /* Add pool implementation */
      await poolFactory.addPoolImplementation(poolImpl.address);

      /* Remove pool implementation */
      const removePoolImplTx = await poolFactory.removePoolImplementation(poolImpl.address);

      /* Validate events */
      await expectEvent(removePoolImplTx, poolFactory, "PoolImplementationRemoved", {
        implementation: poolImpl.address,
      });

      /* Validate state */
      expect(await poolFactory.getPoolImplementations()).to.deep.equal([]);

      /* Subsequent remove does nothing */
      const removePoolImplTx2 = await poolFactory.removePoolImplementation(poolImpl.address);
      expect((await removePoolImplTx2.wait()).logs.length).to.equal(0);

      /* Validate state */
      expect(await poolFactory.getPoolImplementations()).to.deep.equal([]);
    });

    it("fails on invalid owner", async function () {
      await expect(poolFactory.connect(accounts[1]).removePoolImplementation(poolImpl.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("#setAdminFeeRate", async function () {
    let pool1: Pool;
    let pool2: Pool;

    beforeEach("add pool implementation to allowlist", async function () {
      /* Add pool implementation to allowlist */
      await poolFactory.addPoolImplementation(poolImpl.address);

      pool1 = (await ethers.getContractAt("Pool", await createPool())) as Pool;
      pool2 = (await ethers.getContractAt("Pool", await createPool())) as Pool;
    });

    it("set admin fee rate", async function () {
      /* Validate state */
      expect(await pool1.adminFeeRate()).to.equal(0);
      expect(await pool2.adminFeeRate()).to.equal(0);

      /* Set admin fee rate */
      const setAdminFeeRateTx1 = await poolFactory.setAdminFeeRate(pool1.address, 500);
      const setAdminFeeRateTx2 = await poolFactory.setAdminFeeRate(pool2.address, 700);

      /* Validate events */
      await expectEvent(setAdminFeeRateTx1, pool1, "AdminFeeRateUpdated", {
        rate: 500,
      });
      await expectEvent(setAdminFeeRateTx2, pool2, "AdminFeeRateUpdated", {
        rate: 700,
      });

      /* Validate state */
      expect(await pool1.adminFeeRate()).to.equal(500);
      expect(await pool2.adminFeeRate()).to.equal(700);

      /* Set admin fee rate */
      const setAdminFeeRateTx3 = await poolFactory.setAdminFeeRate(pool1.address, 0);

      /* Validate events */
      await expectEvent(setAdminFeeRateTx3, pool1, "AdminFeeRateUpdated", {
        rate: 0,
      });

      /* Validate state */
      expect(await pool1.adminFeeRate()).to.equal(0);
    });

    it("fails on invalid pool address", async function () {
      await expect(poolFactory.setAdminFeeRate(poolFactory.address, 700)).to.be.revertedWithCustomError(
        poolFactory,
        "InvalidPool"
      );
    });

    it("fails on invalid caller", async function () {
      await expect(poolFactory.connect(accounts[1]).setAdminFeeRate(pool2.address, 700)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });

    it("fails on invalid rate", async function () {
      await expect(poolFactory.setAdminFeeRate(pool2.address, 10000)).to.be.revertedWithCustomError(
        pool2,
        "InvalidParameters"
      );
    });
  });
});
