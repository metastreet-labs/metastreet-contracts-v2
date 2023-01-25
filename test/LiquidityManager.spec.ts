import { ethers, network } from "hardhat";

import { TestLiquidityManager, LiquidityManager } from "../typechain";

describe("LiquidityManager", function () {
  let snapshotId: string;
  let liquidityManager: TestLiquidityManager;

  before("deploy fixture", async () => {
    const liquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");

    /* Deploy liquidity manager library */
    const liquidityManagerLib = await liquidityManagerFactory.deploy();
    await liquidityManagerLib.deployed();

    /* Deploy test liquidity manager */
    const testLiquidityManagerFactory = await ethers.getContractFactory("TestLiquidityManager", {
      libraries: { LiquidityManager: liquidityManagerLib.address },
    });
    liquidityManager = await testLiquidityManagerFactory.deploy();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Helper Functions */
  /****************************************************************************/

  async function setupLiquidity() {
    /* Setup liquidity at 10, 20, 30, 40 ETH */
    /* FIXME */
    /* Setup insolvent liquidity at 50 ETH */
    /* FIXME */
  }

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#forecast", async function () {
    it("forecasts required liquidity", async function () {
      /* FIXME */
    });
    it("fails on insufficient liquidity", async function () {
      /* FIXME */
    });
  });

  describe("#source", async function () {
    it("sources required liquidity", async function () {
      /* FIXME */
    });
    it("fails on insufficient liquidity", async function () {
      /* FIXME */
    });
  });

  describe("#instantiate", async function () {
    it("instantiates a new liquidity node", async function () {
      /* FIXME */
    });
    it("does nothing on existing node", async function () {
      /* FIXME */
    });
    it("fails on insufficient tick spacing", async function () {
      /* FIXME */
    });
    it("fails on insolvent node", async function () {
      /* FIXME */
    });
  });

  describe("#deposit", async function () {
    it("deposits into existing node", async function () {
      /* FIXME */
    });
    it("fails on inactive node", async function () {
      /* FIXME */
    });
    it("fails on insolvent node", async function () {
      /* FIXME */
    });
  });

  describe("#use", async function () {
    it("uses from existing node", async function () {
      /* FIXME */
    });
    it("fails on insufficient liquidity", async function () {
      /* FIXME */
    });
    it("fails on inactive node", async function () {
      /* FIXME */
    });
    it("fails on insolvent node", async function () {
      /* FIXME */
    });
  });

  describe("#restore", async function () {
    it("restores pending amount", async function () {
      /* FIXME */
    });
    it("restores less than pending", async function () {
      /* FIXME */
    });
    it("restores less than pending and becomes insolvent", async function () {
      /* FIXME */
    });
  });

  describe("#redeem", async function () {
    it("redeems from available liquidity", async function () {
      /* FIXME */
    });
    it("redeems from pending liquidity", async function () {
      /* FIXME */
    });
    it("redeems from pending liquidity at multiple prices", async function () {
      /* FIXME */
    });
    it("redeems from insolvent liquidity", async function () {
      /* FIXME */
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("#utilization", async function () {
    it("returns utilization", async function () {
      /* FIXME before loan */
      /* FIXME after loan */
      /* FIXME after deposit */
    });
  });

  describe("#liquidityAvailable", async function () {
    it("returns liquidity available", async function () {
      /* FIXME before loan */
      /* FIXME after loan */
      /* FIXME after deposit */
    });
  });

  describe("#liquidityNodes", async function () {
    it("returns liquidity nodes", async function () {
      /* FIXME */
    });
  });

  describe("#liquidityNodeIsActive", async function () {
    it("returns true for active liquidity", async function () {
      /* FIXME */
    });
    it("returns false for inactive liquidity", async function () {
      /* FIXME */
    });
  });

  describe("#liquidityNodeIsSolvent", async function () {
    it("returns true for solvent liquidity", async function () {
      /* FIXME */
    });
    it("returns true for insolvent liquidity", async function () {
      /* FIXME */
    });
  });
});
