import { ethers, network } from "hardhat";

import { TestLiquidityManager, LiquidityManager } from "../typechain";

describe("LiquidityManager", function () {
  let snapshotId: string;
  let liquidityManager: TestLiquidityManager;

  before("deploy fixture", async () => {
    const testLiquidityManagerFactory = await ethers.getContractFactory("TestLiquidityManager");

    liquidityManager = await testLiquidityManagerFactory.deploy();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#utilization", async function () {});

  describe("#liquidityAvailable", async function () {});

  describe("#liquidityNodes", async function () {});

  describe("#source", async function () {});

  describe("#instantiate", async function () {});

  describe("#deposit", async function () {});

  describe("#use,restore", async function () {});

  describe("#redeem", async function () {});
});
