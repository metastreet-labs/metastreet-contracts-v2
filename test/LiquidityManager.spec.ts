import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestLiquidityManager, LiquidityManager } from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";

describe("LiquidityManager", function () {
  let snapshotId: string;
  let liquidityManagerLib: LiquidityManager;
  let liquidityManager: TestLiquidityManager;

  before("deploy fixture", async () => {
    const liquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");

    /* Deploy liquidity manager library */
    liquidityManagerLib = await liquidityManagerFactory.deploy();
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
  /* Primary API */
  /****************************************************************************/

  const toFixedPoint = ethers.utils.parseEther;

  const NODE_END = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");

  describe("#instantiate", async function () {
    it("instantiates a new liquidity node", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(toFixedPoint("1"));

      /* Validate nodes */
      let nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, ethers.constants.MaxUint256);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(toFixedPoint("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(NODE_END);

      /* Instantiate two additional nodes */
      await liquidityManager.instantiate(toFixedPoint("10"));
      await liquidityManager.instantiate(toFixedPoint("50"));

      /* Validate nodes */
      nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, ethers.constants.MaxUint256);
      expect(nodes.length).to.equal(4);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(toFixedPoint("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(toFixedPoint("10"));
      expect(nodes[2].prev).to.equal(toFixedPoint("1"));
      expect(nodes[2].next).to.equal(toFixedPoint("50"));
      expect(nodes[3].prev).to.equal(toFixedPoint("10"));
      expect(nodes[3].next).to.equal(NODE_END);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(ethers.constants.Zero);
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(3);
    });
    it("no-op on existing node", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(toFixedPoint("1"));

      /* Validate nodes */
      let nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, ethers.constants.MaxUint256);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(toFixedPoint("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(NODE_END);

      /* Instantiate same node again */
      await liquidityManager.instantiate(toFixedPoint("1"));

      /* Validate nodes */
      nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, ethers.constants.MaxUint256);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(toFixedPoint("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(NODE_END);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(ethers.constants.Zero);
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("fails on insufficient tick spacing", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(toFixedPoint("1"));

      /* Try to instantiate another node that is 5% higher */
      await expect(liquidityManager.instantiate(toFixedPoint("1.05"))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsufficientTickSpacing"
      );
      /* Try to instantiate another node that is 5% lower */
      await expect(liquidityManager.instantiate(toFixedPoint("0.95"))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsufficientTickSpacing"
      );
    });
    it("fails on insolvent node", async function () {
      /* Create insolvent node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), ethers.constants.Zero);

      /* Try to instantiate node again */
      await expect(liquidityManager.instantiate(toFixedPoint("3"))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsolventLiquidity"
      );
    });
  });

  describe("#deposit", async function () {
    it("deposits into active node", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(toFixedPoint("3"));

      /* Deposit */
      const depositTx = await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: toFixedPoint("5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("5"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("5"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("deposits into active node that has appreciated", async function () {
      /* Appreciate node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), toFixedPoint("6"));

      /* New share price is 6/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("3"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: toFixedPoint("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("9"));
      expect(node.shares).to.equal(toFixedPoint("7.5"));
      expect(node.available).to.equal(toFixedPoint("9"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("9"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("deposits into active node that has depreciated", async function () {
      /* Depreciate node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), toFixedPoint("4"));

      /* New share price is 4/5 = 0.8 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("2"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: toFixedPoint("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("6"));
      expect(node.shares).to.equal(toFixedPoint("7.5"));
      expect(node.available).to.equal(toFixedPoint("6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("6"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("deposits into active node that has pending returns", async function () {
      /* Create node with used liquidity */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));

      /* Deposit share price is 6/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("3"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: toFixedPoint("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("8"));
      expect(node.shares).to.equal(toFixedPoint("7.5"));
      expect(node.available).to.equal(toFixedPoint("3"));
      expect(node.pending).to.equal(toFixedPoint("6"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("8"));
      expect(statistics[1]).to.equal(toFixedPoint("5"));
      expect(statistics[2]).to.equal(1);
    });
    it("fails on inactive node", async function () {
      await expect(liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InactiveLiquidity"
      );
    });
    it("fails on insolvent node", async function () {
      /* Create insolvent node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), ethers.constants.Zero);

      /* Try to deposit into node */
      await expect(liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("1"))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InactiveLiquidity"
      );
    });
  });

  describe("#use", async function () {
    it("uses from active node", async function () {
      /* Instantiate and deposit in node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));

      /* Use from node */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("3.2"));

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("2"));
      expect(node.pending).to.equal(toFixedPoint("3.2"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("5"));
      expect(statistics[1]).to.equal(toFixedPoint("3"));
      expect(statistics[2]).to.equal(1);
    });
  });

  describe("#restore", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
    });

    it("restores pending amount", async function () {
      /* Use */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"));
      /* Restore */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"), toFixedPoint("4"));

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("6"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("6"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("restores less than pending", async function () {
      /* Use */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"));
      /* Restore */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"), toFixedPoint("2"));

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("4"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("4"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("restores less than pending and becomes insolvent", async function () {
      /* Use */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));
      /* Restore */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), ethers.constants.Zero);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(ethers.constants.Zero);
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(0);

      /* Validate head node linkage */
      node = await liquidityManager.liquidityNode(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(NODE_END);
    });
  });

  describe("#redeem", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
    });

    it("redeems from current index", async function () {
      /* Redeem */
      const redeemTx1 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: ethers.constants.Zero,
      });

      /* Redeem */
      const redeemTx2 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: toFixedPoint("1"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("5"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(toFixedPoint("2"));

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("5"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("redeems from subsequent index", async function () {
      /* Redeem */
      const redeemTx1 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: ethers.constants.Zero,
      });

      /* Process redemption */
      const processRedemptionTx = await liquidityManager.processRedemptions(toFixedPoint("3"));

      /* Validate return value */
      await expectEvent(processRedemptionTx, liquidityManager, "RedemptionProcessed", {
        shares: toFixedPoint("1"),
        amount: toFixedPoint("1"),
      });

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("4"));
      expect(node.shares).to.equal(toFixedPoint("4"));
      expect(node.available).to.equal(toFixedPoint("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Redeem */
      const redeemTx2 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityManager, "RedemptionTarget", {
        index: 1,
        target: toFixedPoint("0"),
      });

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("4"));
      expect(node.shares).to.equal(toFixedPoint("4"));
      expect(node.available).to.equal(toFixedPoint("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(toFixedPoint("1"));

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("4"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
  });

  describe("#processRedemptions", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("5"));
    });

    it("processes redemption from available liquidity", async function () {
      /* Redeem twice */
      const redeemTx1 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("2"));
      const redeemTx2 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("1"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;
      const [redemptionIndex2, redemptionTarget2] = (
        await extractEvent(redeemTx2, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("2"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("1"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(toFixedPoint("5"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(toFixedPoint("3"));

      /* Process redemptions */
      const processRedemptionsTx = await liquidityManager.processRedemptions(toFixedPoint("3"));

      /* Validate return value */
      await expectEvent(processRedemptionsTx, liquidityManager, "RedemptionProcessed", {
        shares: toFixedPoint("3"),
        amount: toFixedPoint("3"),
      });

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("2"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([toFixedPoint("2"), toFixedPoint("2")]);
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("1"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([toFixedPoint("1"), toFixedPoint("1")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("2"));
      expect(node.shares).to.equal(toFixedPoint("2"));
      expect(node.available).to.equal(toFixedPoint("2"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("2"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("processes redemption from restored liquidity", async function () {
      /* Use */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));

      /* Redeem */
      const redeemTx = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("2"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityManager, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(toFixedPoint("6"));
      expect(node.redemptions).to.equal(toFixedPoint("2"));

      /* Validate statistics */
      let statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("5"));
      expect(statistics[1]).to.equal(toFixedPoint("5"));
      expect(statistics[2]).to.equal(1);

      /* Restore */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), toFixedPoint("6"));

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([toFixedPoint("2"), toFixedPoint("2.4")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("3.6"));
      expect(node.shares).to.equal(toFixedPoint("3"));
      expect(node.available).to.equal(toFixedPoint("3.6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("3.6"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("processes redemption from restored liquidity at multiple prices", async function () {
      /* Use */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("2"), toFixedPoint("3"));
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"));

      /* Redeem */
      const redeemTx = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("3"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityManager, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(toFixedPoint("7"));
      expect(node.redemptions).to.equal(toFixedPoint("3"));

      /* Current share price is 1.0 */

      /* Restore first */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("2"), toFixedPoint("3"), toFixedPoint("3"));

      /* New share price is 6/5 = 1.2 */
      /* Amount 3 got restored, so 2.5 shares available for redemption at value of 3.0 */

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([toFixedPoint("2.5"), toFixedPoint("3")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("3"));
      expect(node.shares).to.equal(toFixedPoint("2.5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(toFixedPoint("4"));
      expect(node.redemptions).to.equal(toFixedPoint("0.5"));

      /* Restore second */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("3"), toFixedPoint("4"), toFixedPoint("4"));

      /* New share price is 4 / 2.5 = 1.6 */
      /* Amount 4 got restored, so remaining 0.5 shares available for redemption at value of 0.8 */

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([toFixedPoint("3"), toFixedPoint("3.8")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("3.2"));
      expect(node.shares).to.equal(toFixedPoint("2"));
      expect(node.available).to.equal(toFixedPoint("3.2"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      const statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("3.2"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
    it("processes redemption from insolvent liquidity", async function () {
      /* Use 5 amount */
      await liquidityManager.use(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"));

      /* Redeem 3 shares */
      const redeemTx1 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("3"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(ethers.constants.Zero);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("5"));
      expect(node.shares).to.equal(toFixedPoint("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(toFixedPoint("6"));
      expect(node.redemptions).to.equal(toFixedPoint("3"));

      /* Restore to 0 */
      await liquidityManager.restore(toFixedPoint("3"), toFixedPoint("5"), toFixedPoint("6"), ethers.constants.Zero);

      /* Validate statistics */
      let statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(ethers.constants.Zero);
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(0);

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([toFixedPoint("3"), ethers.constants.Zero]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(toFixedPoint("2"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Redeem remaining shares */
      const redeemTx2 = await liquidityManager.redeem(toFixedPoint("3"), toFixedPoint("2"));
      const [redemptionIndex2, redemptionTarget2] = (
        await extractEvent(redeemTx2, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate target */
      expect(redemptionIndex2).to.equal(1);
      expect(redemptionTarget2).to.equal(ethers.constants.Zero);

      /* Process redemptions */
      const processRedemptionsTx = await liquidityManager.processRedemptions(toFixedPoint("3"));

      /* Validate return value */
      await expectEvent(processRedemptionsTx, liquidityManager, "RedemptionProcessed", {
        shares: toFixedPoint("2"),
        amount: ethers.constants.Zero,
      });

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          toFixedPoint("3"),
          toFixedPoint("2"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([toFixedPoint("2"), ethers.constants.Zero]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(ethers.constants.Zero);
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Instantiate and deposit into node */
      await liquidityManager.instantiate(toFixedPoint("3"));
      await liquidityManager.deposit(toFixedPoint("3"), toFixedPoint("4"));

      /* Validate node */
      node = await liquidityManager.liquidityNode(toFixedPoint("3"));
      expect(node.value).to.equal(toFixedPoint("4"));
      expect(node.shares).to.equal(toFixedPoint("4"));
      expect(node.available).to.equal(toFixedPoint("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate statistics */
      statistics = await liquidityManager.liquidityStatistics();
      expect(statistics[0]).to.equal(toFixedPoint("4"));
      expect(statistics[1]).to.equal(ethers.constants.Zero);
      expect(statistics[2]).to.equal(1);
    });
  });

  /****************************************************************************/
  /* API that interacts with multiple nodes */
  /****************************************************************************/

  async function setupLiquidity(): Promise<void> {
    /* Setup liquidity at 10, 20, 30, 40 ETH */
    for (const depth of [toFixedPoint("10"), toFixedPoint("20"), toFixedPoint("30"), toFixedPoint("40")]) {
      await liquidityManager.instantiate(depth);
      await liquidityManager.deposit(depth, toFixedPoint("50"));
    }

    /* Setup insolvent liquidity at 50 ETH */
    await liquidityManager.instantiate(toFixedPoint("50"));
    await liquidityManager.deposit(toFixedPoint("50"), toFixedPoint("5"));
    await liquidityManager.use(toFixedPoint("50"), toFixedPoint("5"), toFixedPoint("6"));
    await liquidityManager.restore(toFixedPoint("50"), toFixedPoint("5"), toFixedPoint("6"), ethers.constants.Zero);
  }

  describe("#source", async function () {
    const depths = [toFixedPoint("10"), toFixedPoint("20"), toFixedPoint("30"), toFixedPoint("40")];

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("sources required liquidity", async function () {
      let [nodes, count] = await liquidityManager.source(toFixedPoint("15"), depths);

      /* Validate nodes */
      expect(count).to.equal(2);
      expect(nodes[0].depth).to.equal(toFixedPoint("10"));
      expect(nodes[0].available).to.equal(toFixedPoint("40"));
      expect(nodes[0].used).to.equal(toFixedPoint("10"));
      expect(nodes[1].depth).to.equal(toFixedPoint("20"));
      expect(nodes[1].available).to.equal(toFixedPoint("45"));
      expect(nodes[1].used).to.equal(toFixedPoint("5"));

      [nodes, count] = await liquidityManager.source(toFixedPoint("35"), depths);

      /* Validate nodes */
      expect(count).to.equal(4);
      expect(nodes[0].depth).to.equal(toFixedPoint("10"));
      expect(nodes[0].available).to.equal(toFixedPoint("40"));
      expect(nodes[0].used).to.equal(toFixedPoint("10"));
      expect(nodes[1].depth).to.equal(toFixedPoint("20"));
      expect(nodes[1].available).to.equal(toFixedPoint("40"));
      expect(nodes[1].used).to.equal(toFixedPoint("10"));
      expect(nodes[2].depth).to.equal(toFixedPoint("30"));
      expect(nodes[2].available).to.equal(toFixedPoint("40"));
      expect(nodes[2].used).to.equal(toFixedPoint("10"));
      expect(nodes[3].depth).to.equal(toFixedPoint("40"));
      expect(nodes[3].available).to.equal(toFixedPoint("45"));
      expect(nodes[3].used).to.equal(toFixedPoint("5"));
    });
    it("fails on insufficient liquidity", async function () {
      await expect(liquidityManager.source(toFixedPoint("25"), depths.slice(0, 2))).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsufficientLiquidity"
      );
      await expect(liquidityManager.source(toFixedPoint("45"), depths)).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsufficientLiquidity"
      );
    });
  });

  describe("#utilization", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("returns utilization", async function () {
      /* Check utilization with no usage */
      expect(await liquidityManager.utilization()).to.equal(ethers.constants.Zero);

      /* Use from 10 and 20 ETH */
      await liquidityManager.use(toFixedPoint("10"), toFixedPoint("10"), toFixedPoint("11"));
      await liquidityManager.use(toFixedPoint("20"), toFixedPoint("15"), toFixedPoint("16"));

      /* Check utilization after usage */
      expect(await liquidityManager.utilization()).to.equal(toFixedPoint("0.125"));

      /* Deposit */
      await liquidityManager.deposit(toFixedPoint("30"), toFixedPoint("50"));

      /* Check utilization after deposit */
      expect(await liquidityManager.utilization()).to.equal(toFixedPoint("0.1"));
    });
  });

  describe("#liquidityAvailable", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("returns liquidity available", async function () {
      /* Check liquidity available with no usage */
      expect(await liquidityManager.liquidityAvailable(ethers.constants.MaxUint256)).to.equal(toFixedPoint("40"));

      /* Use from highest node (artifical) */
      await liquidityManager.use(toFixedPoint("40"), toFixedPoint("45"), toFixedPoint("46"));

      /* Check liquidity available after usage */
      expect(await liquidityManager.liquidityAvailable(ethers.constants.MaxUint256)).to.equal(toFixedPoint("35"));

      /* Deposit into lowest and highest nodes */
      await liquidityManager.deposit(toFixedPoint("10"), toFixedPoint("2"));
      await liquidityManager.deposit(toFixedPoint("40"), toFixedPoint("2"));

      /* Check liquidity available after deposit */
      expect(await liquidityManager.liquidityAvailable(ethers.constants.MaxUint256)).to.equal(toFixedPoint("37"));

      /* Check liquidity available at lower tiers */
      expect(await liquidityManager.liquidityAvailable(toFixedPoint("20"))).to.equal(toFixedPoint("20"));
      expect(await liquidityManager.liquidityAvailable(toFixedPoint("10"))).to.equal(toFixedPoint("10"));

      /* Use nearly all of the lowest node (leaving 2 ETH amount) */
      await liquidityManager.use(toFixedPoint("10"), toFixedPoint("50"), toFixedPoint("51"));

      /* Check liquidity available at lower tiers */
      expect(await liquidityManager.liquidityAvailable(toFixedPoint("10"))).to.equal(toFixedPoint("2"));
      expect(await liquidityManager.liquidityAvailable(toFixedPoint("20"))).to.equal(toFixedPoint("20"));
    });
  });
});
