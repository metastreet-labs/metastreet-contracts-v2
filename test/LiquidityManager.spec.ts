import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestLiquidityManager, LiquidityManager } from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

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

  /****************************************************************************/
  /* Initial State */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");

  describe("initial state", async function () {
    it("matches expected initial state", async function () {
      /* Validate nodes */
      let nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, MaxUint128);
      expect(nodes.length).to.equal(1);
      expect(nodes[0].tick).to.equal(0);
      expect(nodes[0].value).to.equal(0);
      expect(nodes[0].shares).to.equal(0);
      expect(nodes[0].available).to.equal(0);
      expect(nodes[0].pending).to.equal(0);
      expect(nodes[0].redemptions).to.equal(0);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(MaxUint128);
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#instantiate", async function () {
    it("instantiates a new liquidity node", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(Tick.encode("1"));

      /* Validate nodes */
      let nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate two additional nodes */
      await liquidityManager.instantiate(Tick.encode("10"));
      await liquidityManager.instantiate(Tick.encode("50"));

      /* Validate nodes */
      nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, MaxUint128);
      expect(nodes.length).to.equal(4);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(Tick.encode("10"));
      expect(nodes[2].prev).to.equal(Tick.encode("1"));
      expect(nodes[2].next).to.equal(Tick.encode("50"));
      expect(nodes[3].prev).to.equal(Tick.encode("10"));
      expect(nodes[3].next).to.equal(MaxUint128);
    });
    it("no-op on existing node", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(Tick.encode("1"));

      /* Validate nodes */
      let nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate same node again */
      await liquidityManager.instantiate(Tick.encode("1"));

      /* Validate nodes */
      nodes = await liquidityManager.liquidityNodes(ethers.constants.Zero, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);
    });
    it("fails on insufficient tick spacing", async function () {
      /* Instantiate one node */
      await liquidityManager.instantiate(Tick.encode("1"));

      /* Try to instantiate another node that is 5% higher */
      await expect(liquidityManager.instantiate(Tick.encode("1.05"))).to.be.revertedWithCustomError(
        liquidityManager,
        "InsufficientTickSpacing"
      );
      /* Try to instantiate another node that is 5% lower */
      await expect(liquidityManager.instantiate(Tick.encode("0.95"))).to.be.revertedWithCustomError(
        liquidityManager,
        "InsufficientTickSpacing"
      );
    });
  });

  describe("#deposit", async function () {
    it("deposits into active node", async function () {
      /* Deposit */
      const depositTx = await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: FixedPoint.from("5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("5"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("deposits into active node that has appreciated", async function () {
      /* Appreciate node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("6")
      );

      /* New share price is 6/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("3"), 5000);

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: FixedPoint.from("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("9"));
      expect(node.shares).to.equal(FixedPoint.from("7.5"));
      expect(node.available).to.equal(FixedPoint.from("9"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("deposits into active node that has depreciated", async function () {
      /* Depreciate node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("4")
      );

      /* New share price is 4/5 = 0.8 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("2"), 5000);

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: FixedPoint.from("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("6"));
      expect(node.shares).to.equal(FixedPoint.from("7.5"));
      expect(node.available).to.equal(FixedPoint.from("6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("deposits into active node that has pending returns", async function () {
      /* Create node with used liquidity */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("7"));

      /* Deposit share price is (5 + (7-5)/2)/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("3"), 5000);

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: FixedPoint.from("2.5"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("8"));
      expect(node.shares).to.equal(FixedPoint.from("7.5"));
      expect(node.available).to.equal(FixedPoint.from("3"));
      expect(node.pending).to.equal(FixedPoint.from("7"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("deposits into active node that has pending returns at 100% deposit premium rate", async function () {
      /* Create node with used liquidity */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 10000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("7"));

      /* Deposit share price is (5 + (7-5))/5 = 1.4 */

      /* Deposit 2 */
      const depositTx = await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("3"), 10000);

      /* Validate shares created */
      await expectEvent(depositTx, liquidityManager, "Deposited", {
        shares: FixedPoint.from("2.142857142857142857"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("8"));
      expect(node.shares).to.equal(FixedPoint.from("7.142857142857142857"));
      expect(node.available).to.equal(FixedPoint.from("3"));
      expect(node.pending).to.equal(FixedPoint.from("7"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("fails on reserved node", async function () {
      await expect(liquidityManager.deposit(0, FixedPoint.from("5"), 5000)).to.be.revertedWithCustomError(
        liquidityManager,
        "InactiveLiquidity"
      );
      await expect(liquidityManager.deposit(MaxUint128, FixedPoint.from("5"), 5000)).to.be.revertedWithCustomError(
        liquidityManager,
        "InactiveLiquidity"
      );
    });
    it("fails on impaired node", async function () {
      /* Create impaired node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20")
      );

      /* Try to deposit into node */
      await expect(
        liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("1"), 5000)
      ).to.be.revertedWithCustomError(liquidityManager, "InactiveLiquidity");
    });
    it("fails on insolvent node", async function () {
      /* Create insolvent node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        ethers.constants.Zero
      );

      /* Try to deposit into node */
      await expect(
        liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("1"), 5000)
      ).to.be.revertedWithCustomError(liquidityManager, "InactiveLiquidity");
    });
  });

  describe("#use", async function () {
    it("uses from active node", async function () {
      /* Instantiate and deposit in node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);

      /* Use from node */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("3.2"));

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("2"));
      expect(node.pending).to.equal(FixedPoint.from("3.2"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
  });

  describe("#restore", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
    });

    it("restores pending amount", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"));
      /* Restore */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("4")
      );

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("6"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("restores less than pending", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"));
      /* Restore */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("2")
      );

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("restores less than pending and becomes impaired", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      /* Restore */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20")
      );

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("0.20"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("0.20"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Validate head node linkage */
      node = await liquidityManager.liquidityNode(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(MaxUint128);
    });
    it("restores less than pending and becomes insolvent", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));
      /* Restore 4 wei */
      await liquidityManager.restore(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 4);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(4);
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(4);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Validate head node linkage */
      node = await liquidityManager.liquidityNode(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(MaxUint128);
    });
  });

  describe("#redeem", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
    });

    it("redeems from current index", async function () {
      /* Use liquidity */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("5"));

      /* Redeem */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: ethers.constants.Zero,
      });

      /* Redeem */
      const redeemTx2 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: FixedPoint.from("1"),
      });

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("5"));
      expect(node.redemptions).to.equal(FixedPoint.from("2"));
    });
    it("redeems from subsequent index", async function () {
      /* Redeem */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityManager, "RedemptionTarget", {
        index: ethers.constants.Zero,
        target: ethers.constants.Zero,
      });

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("4"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Redeem */
      const redeemTx2 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityManager, "RedemptionTarget", {
        index: 1,
        target: ethers.constants.Zero,
      });

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3"));
      expect(node.shares).to.equal(FixedPoint.from("3"));
      expect(node.available).to.equal(FixedPoint.from("3"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
  });

  describe("#processRedemptions", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("5"), 5000);
    });

    it("processes redemption from available liquidity", async function () {
      /* Redeem twice */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const redeemTx2 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("1"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;
      const [redemptionIndex2, redemptionTarget2] = (
        await extractEvent(redeemTx2, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("2")]);
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("1"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("1"), FixedPoint.from("1")]);

      /* Validate node */
      const node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("2"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("2"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("processes redemption from restored liquidity", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));

      /* Redeem */
      const redeemTx = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityManager, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("2"));

      /* Restore */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("6")
      );

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("2.4")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3.6"));
      expect(node.shares).to.equal(FixedPoint.from("3"));
      expect(node.available).to.equal(FixedPoint.from("3.6"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("processes redemption from restored liquidity at multiple prices", async function () {
      /* Use */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("2"), FixedPoint.from("3"));
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"));

      /* Redeem */
      const redeemTx = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("3"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityManager, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("7"));
      expect(node.redemptions).to.equal(FixedPoint.from("3"));

      /* Current share price is 1.0 */

      /* Restore first */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("2"),
        FixedPoint.from("3"),
        FixedPoint.from("3")
      );

      /* New share price is 6/5 = 1.2 */
      /* Amount 3 got restored, so 2.5 shares available for redemption at value of 3.0 */

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("2.5"), FixedPoint.from("3")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3"));
      expect(node.shares).to.equal(FixedPoint.from("2.5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("4"));
      expect(node.redemptions).to.equal(FixedPoint.from("0.5"));

      /* Restore second */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("4")
      );

      /* New share price is 4 / 2.5 = 1.6 */
      /* Amount 4 got restored, so remaining 0.5 shares available for redemption at value of 0.8 */

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("3"), FixedPoint.from("3.8")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3.2"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("3.2"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("processes redemption from impaired liquidity", async function () {
      /* Use 5 amount */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));

      /* Redeem 3 shares */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("3"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(ethers.constants.Zero);

      /* Validate redemption available is zero */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("3"));

      /* Restore node to 0.20 */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20")
      );

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("3"), FixedPoint.from("0.12")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("0.08"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("0.08"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate node is inactive */
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Redeem remaining 2 shares */
      const redeemTx2 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const [redemptionIndex2, redemptionTarget2] = (
        await extractEvent(redeemTx2, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption target */
      expect(redemptionIndex2).to.equal(1);
      expect(redemptionTarget2).to.equal(ethers.constants.Zero);

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("0.08")]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(ethers.constants.Zero);
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Instantiate and deposit into node */
      await liquidityManager.deposit(Tick.encode("3"), FixedPoint.from("4"), 5000);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("4"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });
    it("processes redemption from insolvent liquidity", async function () {
      /* Use 5 amount */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"));

      /* Redeem 3 shares */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("2.5"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(ethers.constants.Zero);

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("2.5"));

      /* Restore to 2 wei */
      await liquidityManager.restore(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 2);

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("2.5"), ethers.constants.Zero]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(0);
      expect(node.shares).to.equal(FixedPoint.from("2.5"));
      expect(node.available).to.equal(0);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      /* Validate node is inactive */
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Redeem remaining 2.5 shares */
      const redeemTx2 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("2.5"));
      const [redemptionIndex2, redemptionTarget2] = (
        await extractEvent(redeemTx2, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption target */
      expect(redemptionIndex2).to.equal(1);
      expect(redemptionTarget2).to.equal(ethers.constants.Zero);

      /* Validate redemption available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("2.5"), ethers.constants.Zero]);

      /* Validate node */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(ethers.constants.Zero);
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);
    });

    it("delays redemption of insolvent node with pending interest", async function () {
      /* Use 2 and 3 amounts */
      await liquidityManager.use(Tick.encode("3"), FixedPoint.from("5").sub(1), FixedPoint.from("6"));
      await liquidityManager.use(Tick.encode("3"), 1, 5);

      /* Redeem all shares */
      const redeemTx1 = await liquidityManager.redeem(Tick.encode("3"), FixedPoint.from("5"));
      const [redemptionIndex1, redemptionTarget1] = (
        await extractEvent(redeemTx1, liquidityManager, "RedemptionTarget")
      ).args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(ethers.constants.Zero);

      /* Validate redemption is not available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Restore first to zero, making node insolvent */
      await liquidityManager.restore(
        Tick.encode("3"),
        FixedPoint.from("5").sub(1),
        FixedPoint.from("6"),
        ethers.constants.Zero
      );

      /* Validate redemption is not available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([ethers.constants.Zero, ethers.constants.Zero]);

      /* Validate node is inactive */
      let node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(1);
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(5);
      expect(node.redemptions).to.equal(FixedPoint.from("5"));
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);

      /* Restore second to 3, leaving insolvent dust */
      await liquidityManager.restore(Tick.encode("3"), 1, 5, 3);

      /* Validate redemption is available */
      expect(
        await liquidityManager.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("5"), ethers.constants.Zero]);

      /* Validate node is inactive */
      node = await liquidityManager.liquidityNode(Tick.encode("3"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.shares).to.equal(ethers.constants.Zero);
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.pending).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);
      expect(node.prev).to.equal(ethers.constants.Zero);
      expect(node.next).to.equal(ethers.constants.Zero);
    });
  });

  /****************************************************************************/
  /* Source API */
  /****************************************************************************/

  async function setupLiquidity(): Promise<void> {
    /* Setup liquidity at 10, 20, 30, 40 ETH at three durations and three rates */
    for (const limit of [FixedPoint.from("10"), FixedPoint.from("20"), FixedPoint.from("30"), FixedPoint.from("40")]) {
      for (const duration of [0, 1, 2]) {
        for (const rate of [0, 1, 2]) {
          await liquidityManager.deposit(Tick.encode(limit, duration, rate), FixedPoint.from("50"), 5000);
        }
      }
    }

    /* Setup insolvent liquidity at 50 ETH */
    await liquidityManager.deposit(Tick.encode("50"), FixedPoint.from("5"), 5000);
    await liquidityManager.use(Tick.encode("50"), FixedPoint.from("5"), FixedPoint.from("6"));
    await liquidityManager.restore(
      Tick.encode("50"),
      FixedPoint.from("5"),
      FixedPoint.from("6"),
      ethers.constants.Zero
    );
  }

  describe("#source", async function () {
    const ticks = [Tick.encode("10"), Tick.encode("20"), Tick.encode("30"), Tick.encode("40")];

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("sources required liquidity with 1 token", async function () {
      let [nodes, count] = await liquidityManager.source(FixedPoint.from("15"), ticks, 1, 0);

      /* Validate nodes */
      expect(count).to.equal(2);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("10"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("5"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("35"), ticks, 1, 0);

      /* Validate nodes */
      expect(count).to.equal(4);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("10"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("10"));
      expect(nodes[2].tick).to.equal(Tick.encode("30"));
      expect(nodes[2].used).to.equal(FixedPoint.from("10"));
      expect(nodes[3].tick).to.equal(Tick.encode("40"));
      expect(nodes[3].used).to.equal(FixedPoint.from("5"));
    });
    it("sources required liquidity with 3 tokens", async function () {
      let [nodes, count] = await liquidityManager.source(FixedPoint.from("15"), ticks, 3, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("15"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("35"), ticks, 3, 0);

      /* Validate nodes */
      expect(count).to.equal(2);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("30"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("5"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("120"), ticks, 3, 0);

      /* Validate nodes */
      expect(count).to.equal(4);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("30"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("30"));
      expect(nodes[2].tick).to.equal(Tick.encode("30"));
      expect(nodes[2].used).to.equal(FixedPoint.from("30"));
      expect(nodes[3].tick).to.equal(Tick.encode("40"));
      expect(nodes[3].used).to.equal(FixedPoint.from("30"));
    });
    it("sources required liquidity with 10 tokens", async function () {
      let [nodes, count] = await liquidityManager.source(FixedPoint.from("15"), ticks, 10, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("15"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("35"), ticks, 10, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("35"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("120"), ticks, 10, 0);

      /* Validate nodes */
      expect(count).to.equal(3);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("50"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("50"));
      expect(nodes[2].tick).to.equal(Tick.encode("30"));
      expect(nodes[2].used).to.equal(FixedPoint.from("20"));

      [nodes, count] = await liquidityManager.source(FixedPoint.from("200"), ticks, 10, 0);

      /* Validate nodes */
      expect(count).to.equal(4);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("50"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("50"));
      expect(nodes[2].tick).to.equal(Tick.encode("30"));
      expect(nodes[2].used).to.equal(FixedPoint.from("50"));
      expect(nodes[3].tick).to.equal(Tick.encode("40"));
      expect(nodes[3].used).to.equal(FixedPoint.from("50"));
    });
    it("sources required liquidity from various durations and rates", async function () {
      const [nodes, count] = await liquidityManager.source(
        FixedPoint.from("35"),
        [Tick.encode("10", 2, 0), Tick.encode("20", 1, 1), Tick.encode("30", 1, 2), Tick.encode("40", 0, 2)],
        1,
        2
      );

      /* Validate nodes */
      expect(count).to.equal(4);
      expect(nodes[0].tick).to.equal(Tick.encode("10", 2, 0));
      expect(nodes[0].used).to.equal(FixedPoint.from("10"));
      expect(nodes[1].tick).to.equal(Tick.encode("20", 1, 1));
      expect(nodes[1].used).to.equal(FixedPoint.from("10"));
      expect(nodes[2].tick).to.equal(Tick.encode("30", 1, 2));
      expect(nodes[2].used).to.equal(FixedPoint.from("10"));
      expect(nodes[3].tick).to.equal(Tick.encode("40", 0, 2));
      expect(nodes[3].used).to.equal(FixedPoint.from("5"));
    });
    it("fails on insufficient liquidity", async function () {
      await expect(
        liquidityManager.source(FixedPoint.from("25"), ticks.slice(0, 2), 1, 0)
      ).to.be.revertedWithCustomError(liquidityManager, "InsufficientLiquidity");
      await expect(liquidityManager.source(FixedPoint.from("45"), ticks, 1, 0)).to.be.revertedWithCustomError(
        liquidityManager,
        "InsufficientLiquidity"
      );
      await expect(liquidityManager.source(FixedPoint.from("121"), ticks, 3, 0)).to.be.revertedWithCustomError(
        liquidityManager,
        "InsufficientLiquidity"
      );
      await expect(liquidityManager.source(FixedPoint.from("201"), ticks, 10, 0)).to.be.revertedWithCustomError(
        liquidityManager,
        "InsufficientLiquidity"
      );
    });
    it("fails on non-increasing ticks", async function () {
      await expect(
        liquidityManager.source(
          FixedPoint.from("35"),
          [Tick.encode("10"), Tick.encode("30"), Tick.encode("20"), Tick.encode("40")],
          1,
          0
        )
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTick");
    });
    it("fails on duplicate ticks", async function () {
      await expect(
        liquidityManager.source(
          FixedPoint.from("25"),
          [Tick.encode("10"), Tick.encode("20"), Tick.encode("20"), Tick.encode("40")],
          1,
          0
        )
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTick");
    });
    it("fails on low duration ticks", async function () {
      await expect(
        liquidityManager.source(FixedPoint.from("15"), [Tick.encode("10", 2, 0), Tick.encode("20", 0, 1)], 1, 1)
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTick");
    });
  });
});
