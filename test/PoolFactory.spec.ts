import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expectEvent, extractEvent } from "../test/helpers/EventUtilities";

import {
  TestERC20,
  TestERC721,
  CollectionCollateralFilter,
  FixedInterestRateModel,
  ExternalCollateralLiquidator,
  TestDelegationRegistry,
  Pool,
  PoolFactory,
} from "../typechain";

import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("PoolFactory", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let collateralFilterImpl: CollectionCollateralFilter;
  let interestRateModelImpl: FixedInterestRateModel;
  let collateralLiquidatorImpl: ExternalCollateralLiquidator;
  let poolFactory: PoolFactory;
  let snapshotId: string;
  let delegationRegistry: TestDelegationRegistry;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const collectionCollateralFilterFactory = await ethers.getContractFactory("CollectionCollateralFilter");
    const fixedInterestRateModelFactory = await ethers.getContractFactory("FixedInterestRateModel");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const poolImplFactory = await ethers.getContractFactory("Pool");
    const poolFactoryFactory = await ethers.getContractFactory("PoolFactory");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy collateral filter implementation */
    collateralFilterImpl = await collectionCollateralFilterFactory.deploy();
    await collateralFilterImpl.deployed();

    /* Deploy test interest rate model implementation */
    interestRateModelImpl = await fixedInterestRateModelFactory.deploy();
    await interestRateModelImpl.deployed();

    /* Deploy external collateral liquidator implementation */
    collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy pool implementation */
    const poolImpl = await poolImplFactory.deploy();
    await poolImpl.deployed();

    /* Deploy Pool Factory */
    poolFactory = await poolFactoryFactory.deploy(poolImpl.address);
    await poolFactory.deployed();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#createPool", async function () {
    it("creates a pool", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64", "address", "address", "address", "address", "bytes", "bytes", "bytes"],
        [
          nft1.address,
          tok1.address,
          30 * 86400,
          delegationRegistry.address,
          collateralFilterImpl.address,
          interestRateModelImpl.address,
          collateralLiquidatorImpl.address,
          ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
          ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.from("0.02")]),
          ethers.utils.defaultAbiCoder.encode(["address"], [accounts[5].address]),
        ]
      );
      const createPoolTx = await poolFactory.connect(accounts[5]).createPool(params);

      /* Validate events */
      await expect(createPoolTx).to.emit(poolFactory, "PoolCreated");

      /* Get pool instance */
      const poolAddress = (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
      const pool = (await ethers.getContractAt("Pool", poolAddress)) as Pool;

      /* Check account[5] is pool admin */
      expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), accounts[5].address)).to.equal(true);
    });
    it("fails on invalid params", async function () {
      /* Create a pool */
      const params = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint64", "address", "address", "address", "address", "bytes", "bytes"],
        [
          nft1.address,
          tok1.address,
          30 * 86400,
          delegationRegistry.address,
          collateralFilterImpl.address,
          interestRateModelImpl.address,
          collateralLiquidatorImpl.address,
          ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
          ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.from("0.02")]),
          /* Missing collateral liquidator params */
        ]
      );
      await expect(poolFactory.createPool(params)).to.be.reverted;
    });
  });

  /* Helper function to create a pool */
  async function createPool(): Promise<string> {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64", "address", "address", "address", "address", "bytes", "bytes", "bytes"],
      [
        nft1.address,
        tok1.address,
        30 * 86400,
        delegationRegistry.address,
        collateralFilterImpl.address,
        interestRateModelImpl.address,
        collateralLiquidatorImpl.address,
        ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
        ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.from("0.02")]),
        ethers.utils.defaultAbiCoder.encode(["address"], [accounts[5].address]),
      ]
    );
    const createPoolTx = await poolFactory.connect(accounts[5]).createPool(params);
    return (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
  }

  describe("#isPool", async function () {
    it("returns true for created pools", async function () {
      const pool1 = await createPool();
      const pool2 = await createPool();

      expect(await poolFactory.isPool(pool1)).to.equal(true);
      expect(await poolFactory.isPool(pool2)).to.equal(true);
      expect(await poolFactory.isPool(collateralFilterImpl.address)).to.equal(false);
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

  describe("#setPoolImplementation", async function () {
    it("updates pool implementation", async function () {
      /* Deploy new pool implementation */
      const poolImplFactory = await ethers.getContractFactory("Pool");
      const poolImpl = await poolImplFactory.deploy();
      await poolImpl.deployed();

      /* Update pool implementation */
      const setPoolImplementationTx = await poolFactory.setPoolImplementation(poolImpl.address);
      await expectEvent(setPoolImplementationTx, poolFactory, "PoolImplementationUpdated", {
        implementation: poolImpl.address,
      });
    });
    it("fails on invalid caller", async function () {
      await expect(poolFactory.connect(accounts[3]).setPoolImplementation(accounts[2].address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });
});
