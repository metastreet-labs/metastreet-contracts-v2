import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { TestLiquidityLogic, LiquidityLogic } from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("LiquidityLogic", function () {
  let snapshotId: string;
  let liquidityLogic: TestLiquidityLogic;

  before("deploy fixture", async () => {
    const testLiquidityLogicFactory = await getContractFactoryWithLibraries("TestLiquidityLogic", ["LiquidityLogic"]);
    liquidityLogic = await testLiquidityLogicFactory.deploy();
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

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");

  describe("initial state", async function () {
    it("matches expected initial state", async function () {
      /* Validate nodes */
      let nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
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
    it("instantiates a new liquidity node with absolute limit first", async function () {
      /* Instantiate one node */
      await liquidityLogic.instantiate(Tick.encode(BigInt(4000)));

      /* Validate nodes */
      let nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(4000)));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate three additional nodes */
      await liquidityLogic.instantiate(Tick.encode(BigInt(4001), 0, 0, 18, 1));
      await liquidityLogic.instantiate(Tick.encode("50"));
      await liquidityLogic.instantiate(Tick.encode(BigInt(6000), 0, 0, 18, 1));

      /* Validate nodes */
      nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(5);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(4001), 0, 0, 18, 1));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(Tick.encode(BigInt(6000), 0, 0, 18, 1));
      expect(nodes[2].prev).to.equal(Tick.encode(BigInt(4001), 0, 0, 18, 1));
      expect(nodes[2].next).to.equal(Tick.encode(BigInt(4000)));
      expect(nodes[3].prev).to.equal(Tick.encode(BigInt(6000), 0, 0, 18, 1));
      expect(nodes[3].next).to.equal(Tick.encode("50"));
      expect(nodes[4].prev).to.equal(Tick.encode(BigInt(4000)));
      expect(nodes[4].next).to.equal(MaxUint128);
    });
    it("instantiates a new liquidity node with ratio limit first", async function () {
      /* Instantiate one node */
      await liquidityLogic.instantiate(Tick.encode(BigInt(5000), 0, 0, 18, 1));

      /* Validate nodes */
      let nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate three additional nodes */
      await liquidityLogic.instantiate(Tick.encode("50"));
      await liquidityLogic.instantiate(Tick.encode(BigInt(4000)));
      await liquidityLogic.instantiate(Tick.encode(BigInt(6000), 0, 0, 18, 1));

      /* Validate nodes */
      nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(5);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(Tick.encode(BigInt(6000), 0, 0, 18, 1));
      expect(nodes[2].prev).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[2].next).to.equal(Tick.encode(BigInt(4000)));
      expect(nodes[3].prev).to.equal(Tick.encode(BigInt(6000), 0, 0, 18, 1));
      expect(nodes[3].next).to.equal(Tick.encode("50"));
      expect(nodes[4].prev).to.equal(Tick.encode(BigInt(4000)));
      expect(nodes[4].next).to.equal(MaxUint128);
    });
    it("no-op on existing node", async function () {
      /* Instantiate one node */
      await liquidityLogic.instantiate(Tick.encode("1"));

      /* Validate nodes */
      let nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate same node again */
      await liquidityLogic.instantiate(Tick.encode("1"));

      /* Validate nodes */
      nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(2);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode("1"));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(MaxUint128);

      /* Instantiate another node */
      await liquidityLogic.instantiate(Tick.encode(BigInt(5000), 0, 0, 18, 1));

      /* Validate nodes */
      nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(3);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(Tick.encode("1"));
      expect(nodes[2].prev).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[2].next).to.equal(MaxUint128);

      /* Instantiate same node again */
      await liquidityLogic.instantiate(Tick.encode(BigInt(5000), 0, 0, 18, 1));

      /* Validate nodes */
      nodes = await liquidityLogic.liquidityNodes(0n, MaxUint128);
      expect(nodes.length).to.equal(3);
      expect(nodes[0].prev).to.equal(0);
      expect(nodes[0].next).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[1].prev).to.equal(0);
      expect(nodes[1].next).to.equal(Tick.encode("1"));
      expect(nodes[2].prev).to.equal(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(nodes[2].next).to.equal(MaxUint128);
    });
    it("fails on insufficient tick spacing", async function () {
      /* Instantiate one node with absolute limit */
      await liquidityLogic.instantiate(Tick.encode("1"));

      /* Try to instantiate another node with absolute limit that is 5% higher */
      await expect(liquidityLogic.instantiate(Tick.encode("1.05"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientTickSpacing"
      );
      /* Try to instantiate another node with absolute limit that is 5% lower */
      await expect(liquidityLogic.instantiate(Tick.encode("0.95"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientTickSpacing"
      );

      /* Instantiate another node with ltv limit */
      await liquidityLogic.instantiate(Tick.encode(BigInt(1000), 0, 0, 18, 1));

      /* Try to instantiate another node with ltv limit that is 2.5% higher */
      await expect(liquidityLogic.instantiate(Tick.encode(BigInt(1025), 0, 0, 18, 1))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientTickSpacing"
      );
      /* Try to instantiate another node with ltv limit that is 2.5% lower */
      await expect(liquidityLogic.instantiate(Tick.encode(BigInt(975), 0, 0, 18, 1))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientTickSpacing"
      );
    });
    it("fails on invalid limit type", async function () {
      /* Reverted with panic code 0x21 (Tried to convert a value into an enum */
      /* but the value was too big or negative) */
      await expect(liquidityLogic.instantiate(Tick.encode(BigInt(5000), 0, 0, 18, 2))).to.be.revertedWithPanic("0x21");
    });
  });

  describe("#deposit", async function () {
    it("deposits into active nodes", async function () {
      /* Deposit absolute limit node */
      const sharesMinted1 = await liquidityLogic.deposit.staticCall(Tick.encode("3"), FixedPoint.from("5"));
      let depositTx = await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityLogic, "Deposited", {
        shares: sharesMinted1,
      });

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("5"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Deposit ltv limit node */
      const sharesMinted2 = await liquidityLogic.deposit.staticCall(
        Tick.encode(BigInt(5000), 0, 0, 18, 1),
        FixedPoint.from("5")
      );
      depositTx = await liquidityLogic.deposit(Tick.encode(BigInt(5000), 0, 0, 18, 1), FixedPoint.from("5"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityLogic, "Deposited", {
        shares: sharesMinted2,
      });

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode(BigInt(5000), 0, 0, 18, 1));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("5"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("deposits into active node that has appreciated", async function () {
      /* Appreciate node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("6"),
        30 * 86400,
        30 * 86400
      );

      /* New share price is 6/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("3"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityLogic, "Deposited", {
        shares: FixedPoint.from("2.5"),
      });

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("9"));
      expect(node.shares).to.equal(FixedPoint.from("7.5"));
      expect(node.available).to.equal(FixedPoint.from("9"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("deposits into active node that has depreciated", async function () {
      /* Depreciate node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("4"),
        30 * 86400,
        30 * 86400
      );

      /* New share price is 4/5 = 0.8 */

      /* Deposit 2 */
      const depositTx = await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("2"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityLogic, "Deposited", {
        shares: FixedPoint.from("2.5"),
      });

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("6"));
      expect(node.shares).to.equal(FixedPoint.from("7.5"));
      expect(node.available).to.equal(FixedPoint.from("6"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("deposits into active node that has pending returns", async function () {
      /* Create node with used liquidity */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
      const useTx = await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("7"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx.blockHash!)).timestamp + 15 * 86400
      );

      /* Deposit share price is (5 + (7-5)/2)/5 = 1.2 */

      /* Deposit 2 */
      const depositTx = await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("3"));

      /* Validate shares created */
      await expectEvent(depositTx, liquidityLogic, "Deposited", {
        shares: "2500000000000326666",
      });

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("8"));
      expect(node.shares).to.closeTo(FixedPoint.from("7.5"), 1000000);
      expect(node.available).to.equal(FixedPoint.from("3"));
      expect(node.pending).to.equal(FixedPoint.from("7"));
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.closeTo(FixedPoint.from("1"), 1000000);
      expect(accrual.rate).to.closeTo(FixedPoint.from("2") / (30n * 86000n), 4000000000);
    });
    it("deposits into active node that has high pending returns", async function () {
      /* Create node with used liquidity */
      await liquidityLogic.deposit(Tick.encode("100000"), FixedPoint.from("100000"));
      const useTx = await liquidityLogic.use(
        Tick.encode("100000"),
        FixedPoint.from("100000"),
        FixedPoint.from("100500"),
        30 * 86400
      );
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx.blockHash!)).timestamp + 30 * 86400
      );

      /* Deposit 2 */
      await liquidityLogic.deposit(Tick.encode("100000"), FixedPoint.from("100000"));
    });
    it("fails on reserved node", async function () {
      await expect(liquidityLogic.deposit(0, FixedPoint.from("5"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InactiveLiquidity"
      );
      await expect(liquidityLogic.deposit(MaxUint128, FixedPoint.from("5"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InactiveLiquidity"
      );
    });
    it("fails on impaired node", async function () {
      /* Create impaired node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20"),
        30 * 86400,
        30 * 86400
      );

      /* Try to deposit into node */
      await expect(liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("1"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InactiveLiquidity"
      );
    });
    it("fails on insolvent node", async function () {
      /* Create insolvent node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        0n,
        30 * 86400,
        30 * 86400
      );

      /* Try to deposit into node */
      await expect(liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("1"))).to.be.revertedWithCustomError(
        liquidityLogic,
        "InactiveLiquidity"
      );
    });
  });

  describe("#use", async function () {
    it("uses from active node", async function () {
      /* Instantiate and deposit in node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));

      /* Use from node */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("3.2"), 30 * 86400);

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("2"));
      expect(node.pending).to.equal(FixedPoint.from("3.2"));
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(FixedPoint.from("0.2") / (30n * 86400n));
    });
  });

  describe("#restore", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
    });

    it("restores pending amount", async function () {
      /* Use */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"), 30 * 86400);
      /* Restore */
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("4"),
        30 * 86400,
        30 * 86400
      );

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("6"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("6"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("restores less than pending", async function () {
      /* Use */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"), 30 * 86400);
      /* Restore */
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("2"),
        30 * 86400,
        30 * 86400
      );

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("restores less than pending and becomes impaired", async function () {
      /* Use */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      /* Restore */
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20"),
        30 * 86400,
        30 * 86400
      );

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("0.20"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(FixedPoint.from("0.20"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Validate head node linkage */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(MaxUint128);
    });
    it("restores less than pending and becomes insolvent", async function () {
      /* Use */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);
      /* Restore 4 wei */
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        4,
        30 * 86400,
        30 * 86400
      );

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(4);
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(4);
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Validate head node linkage */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(MaxUint128);
    });
  });

  describe("#redeem", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
    });

    it("redeems from current index", async function () {
      /* Use liquidity */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("5"), 30 * 86400);

      /* Redeem */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityLogic, "RedemptionTarget", {
        index: 0n,
        target: 0n,
      });

      /* Redeem */
      const redeemTx2 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityLogic, "RedemptionTarget", {
        index: 0n,
        target: FixedPoint.from("1"),
      });

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("5"));
      expect(node.redemptions).to.equal(FixedPoint.from("2"));
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("redeems from subsequent index", async function () {
      /* Redeem */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx1, liquidityLogic, "RedemptionTarget", {
        index: 0n,
        target: 0n,
      });

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("4"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Redeem */
      const redeemTx2 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("1"));

      /* Validate return value */
      await expectEvent(redeemTx2, liquidityLogic, "RedemptionTarget", {
        index: 1,
        target: 0n,
      });

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3"));
      expect(node.shares).to.equal(FixedPoint.from("3"));
      expect(node.available).to.equal(FixedPoint.from("3"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
  });

  describe("#processRedemptions", async function () {
    beforeEach("setup liquidity", async function () {
      /* Instantiate and deposit into node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("5"));
    });

    it("processes redemption from available liquidity", async function () {
      /* Redeem twice */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const redeemTx2 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("1"));
      const [redemptionIndex1, redemptionTarget1] = (await extractEvent(redeemTx1, liquidityLogic, "RedemptionTarget"))
        .args;
      const [redemptionIndex2, redemptionTarget2] = (await extractEvent(redeemTx2, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("2")]);
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("1"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("1"), FixedPoint.from("1")]);

      /* Validate node */
      const [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("2"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("2"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("processes redemption from restored liquidity", async function () {
      /* Use */
      await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);

      /* Redeem */
      const redeemTx = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([0n, 0n]);

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("2"));

      /* Restore */
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("6"),
        30 * 86400,
        30 * 86400
      );

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("2.4")]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3.6"));
      expect(node.shares).to.equal(FixedPoint.from("3"));
      expect(node.available).to.equal(FixedPoint.from("3.6"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal("385802469135");
      expect(accrual.rate).to.equal(0n);
    });
    it("processes redemption from restored liquidity at multiple prices", async function () {
      /* Use */
      const useTx1 = await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("2"), FixedPoint.from("3"), 30 * 86400);
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 15 * 86400);
      const useTx2 = await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("3"), FixedPoint.from("4"), 30 * 86400);

      /* Redeem */
      const redeemTx = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("3"));
      const [redemptionIndex, redemptionTarget] = (await extractEvent(redeemTx, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([0n, 0n]);

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("7"));
      expect(node.redemptions).to.equal(FixedPoint.from("3"));

      /* Current share price is 1.0 */

      /* Restore first */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx1.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("2"),
        FixedPoint.from("3"),
        FixedPoint.from("3"),
        30 * 86400,
        30 * 86400
      );

      /* New share price is 6/5 = 1.2 */
      /* Amount 3 got restored, so 2.5 shares available for redemption at value of 3.0 */

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("2.5"), FixedPoint.from("3")]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3"));
      expect(node.shares).to.equal(FixedPoint.from("2.5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("4"));
      expect(node.redemptions).to.equal(FixedPoint.from("0.5"));

      /* Restore second */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx2.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("3"),
        FixedPoint.from("4"),
        FixedPoint.from("4"),
        30 * 86400,
        30 * 86400
      );

      /* New share price is 4 / 2.5 = 1.6 */
      /* Amount 4 got restored, so remaining 0.5 shares available for redemption at value of 0.8 */

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex,
          redemptionTarget
        )
      ).to.deep.equal([FixedPoint.from("3"), FixedPoint.from("3.8")]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("3.2"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("3.2"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("processes redemption from impaired liquidity", async function () {
      /* Use 5 amount */
      const useTx = await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);

      /* Redeem 3 shares */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("3"));
      const [redemptionIndex1, redemptionTarget1] = (await extractEvent(redeemTx1, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(0n);

      /* Validate redemption available is zero */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([0n, 0n]);

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("3"));

      /* Restore node to 0.20 */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        FixedPoint.from("0.20"),
        30 * 86400,
        30 * 86400
      );

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("3"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("3"), FixedPoint.from("0.12")]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("0.08"));
      expect(node.shares).to.equal(FixedPoint.from("2"));
      expect(node.available).to.equal(FixedPoint.from("0.08"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);

      /* Validate node is inactive */
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);

      /* Redeem remaining 2 shares */
      const redeemTx2 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("2"));
      const [redemptionIndex2, redemptionTarget2] = (await extractEvent(redeemTx2, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption target */
      expect(redemptionIndex2).to.equal(1);
      expect(redemptionTarget2).to.equal(0n);

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("2"), FixedPoint.from("0.08")]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(0n);
      expect(node.shares).to.equal(0n);
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);

      /* Instantiate and deposit into node */
      await liquidityLogic.deposit(Tick.encode("3"), FixedPoint.from("4"));

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("4"));
      expect(node.shares).to.equal(FixedPoint.from("4"));
      expect(node.available).to.equal(FixedPoint.from("4"));
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });
    it("processes redemption from insolvent liquidity", async function () {
      /* Use 5 amount */
      const useTx = await liquidityLogic.use(Tick.encode("3"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);

      /* Redeem 3 shares */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("2.5"));
      const [redemptionIndex1, redemptionTarget1] = (await extractEvent(redeemTx1, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(0n);

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([0n, 0n]);

      /* Validate node */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(FixedPoint.from("5"));
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(FixedPoint.from("6"));
      expect(node.redemptions).to.equal(FixedPoint.from("2.5"));

      /* Restore to 2 wei */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5"),
        FixedPoint.from("6"),
        2,
        30 * 86400,
        30 * 86400
      );

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("2.5"), 0n]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(0);
      expect(node.shares).to.equal(FixedPoint.from("2.5"));
      expect(node.available).to.equal(0);
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Validate node is inactive */
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);

      /* Redeem remaining 2.5 shares */
      const redeemTx2 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("2.5"));
      const [redemptionIndex2, redemptionTarget2] = (await extractEvent(redeemTx2, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption target */
      expect(redemptionIndex2).to.equal(1);
      expect(redemptionTarget2).to.equal(0n);

      /* Validate redemption available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("2.5"),
          redemptionIndex2,
          redemptionTarget2
        )
      ).to.deep.equal([FixedPoint.from("2.5"), 0n]);

      /* Validate node */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(0n);
      expect(node.shares).to.equal(0n);
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
    });

    it("delays redemption of insolvent node with pending interest", async function () {
      /* Use 2 and 3 amounts */
      const useTx1 = await liquidityLogic.use(
        Tick.encode("3"),
        FixedPoint.from("5") - 1n,
        FixedPoint.from("6") + 1n,
        30 * 86400
      );
      await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 15 * 86400);
      const useTx2 = await liquidityLogic.use(Tick.encode("3"), 1, 5, 30 * 86400);

      /* Redeem all shares */
      const redeemTx1 = await liquidityLogic.redeem(Tick.encode("3"), FixedPoint.from("5"));
      const [redemptionIndex1, redemptionTarget1] = (await extractEvent(redeemTx1, liquidityLogic, "RedemptionTarget"))
        .args;

      /* Validate redemption target */
      expect(redemptionIndex1).to.equal(0);
      expect(redemptionTarget1).to.equal(0n);

      /* Validate redemption is not available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([0n, 0n]);

      /* Restore first to zero, making node insolvent */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx1.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(
        Tick.encode("3"),
        FixedPoint.from("5") - 1n,
        FixedPoint.from("6") + 1n,
        0n,
        30 * 86400,
        30 * 86400
      );

      /* Validate redemption is not available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([0n, 0n]);

      /* Validate node is inactive */
      let [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(1);
      expect(node.shares).to.equal(FixedPoint.from("5"));
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(5);
      expect(node.redemptions).to.equal(FixedPoint.from("5"));
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);

      /* Restore second to 3, leaving insolvent dust */
      await helpers.time.setNextBlockTimestamp(
        (await ethers.provider.getBlock(useTx2.blockHash!)).timestamp + 30 * 86400
      );
      await liquidityLogic.restore(Tick.encode("3"), 1, 5, 3, 30 * 86400, 30 * 86400);

      /* Validate redemption is available */
      expect(
        await liquidityLogic.redemptionAvailable(
          Tick.encode("3"),
          FixedPoint.from("5"),
          redemptionIndex1,
          redemptionTarget1
        )
      ).to.deep.equal([FixedPoint.from("5"), 0n]);

      /* Validate node is inactive */
      [node, accrual] = await liquidityLogic.liquidityNodeWithAccrual(Tick.encode("3"));
      expect(node.value).to.equal(0n);
      expect(node.shares).to.equal(0n);
      expect(node.available).to.equal(0n);
      expect(node.pending).to.equal(0n);
      expect(node.redemptions).to.equal(0n);
      expect(node.prev).to.equal(0n);
      expect(node.next).to.equal(0n);
      expect(accrual.accrued).to.equal(0n);
      expect(accrual.rate).to.equal(0n);
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
          await liquidityLogic.deposit(Tick.encode(limit, duration, rate), FixedPoint.from("50"));
        }
      }
    }

    /* Setup insolvent liquidity at 50 ETH */
    await liquidityLogic.deposit(Tick.encode("50"), FixedPoint.from("5"));
    await liquidityLogic.use(Tick.encode("50"), FixedPoint.from("5"), FixedPoint.from("6"), 30 * 86400);

    await helpers.time.setNextBlockTimestamp((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400);
    await liquidityLogic.restore(
      Tick.encode("50"),
      FixedPoint.from("5"),
      FixedPoint.from("6"),
      0n,
      30 * 86400,
      30 * 86400
    );
  }

  describe("#source", async function () {
    const ticks = [Tick.encode("10"), Tick.encode("20"), Tick.encode("30"), Tick.encode("40")];

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("sources required liquidity with 1 token", async function () {
      let [nodes, count] = await liquidityLogic.source(FixedPoint.from("15"), ticks, 1, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(2);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("10"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("5"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("35"), ticks, 1, 0, 0);

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
      let [nodes, count] = await liquidityLogic.source(FixedPoint.from("15"), ticks, 3, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("15"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("35"), ticks, 3, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(2);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("30"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("5"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("120"), ticks, 3, 0, 0);

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
      let [nodes, count] = await liquidityLogic.source(FixedPoint.from("15"), ticks, 10, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("15"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("35"), ticks, 10, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(1);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("35"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("120"), ticks, 10, 0, 0);

      /* Validate nodes */
      expect(count).to.equal(3);
      expect(nodes[0].tick).to.equal(Tick.encode("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("50"));
      expect(nodes[1].tick).to.equal(Tick.encode("20"));
      expect(nodes[1].used).to.equal(FixedPoint.from("50"));
      expect(nodes[2].tick).to.equal(Tick.encode("30"));
      expect(nodes[2].used).to.equal(FixedPoint.from("20"));

      [nodes, count] = await liquidityLogic.source(FixedPoint.from("200"), ticks, 10, 0, 0);

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
      const [nodes, count] = await liquidityLogic.source(
        FixedPoint.from("35"),
        [Tick.encode("10", 2, 0), Tick.encode("20", 1, 1), Tick.encode("30", 1, 2), Tick.encode("40", 0, 2)],
        1,
        2,
        0
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
        liquidityLogic.source(FixedPoint.from("25"), ticks.slice(0, 2), 1, 0, 0)
      ).to.be.revertedWithCustomError(liquidityLogic, "InsufficientLiquidity");
      await expect(liquidityLogic.source(FixedPoint.from("45"), ticks, 1, 0, 0)).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientLiquidity"
      );
      await expect(liquidityLogic.source(FixedPoint.from("121"), ticks, 3, 0, 0)).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientLiquidity"
      );
      await expect(liquidityLogic.source(FixedPoint.from("201"), ticks, 10, 0, 0)).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientLiquidity"
      );
    });
    it("fails on non-increasing ticks", async function () {
      await expect(
        liquidityLogic.source(
          FixedPoint.from("35"),
          [Tick.encode("10"), Tick.encode("30"), Tick.encode("20"), Tick.encode("40")],
          1,
          0,
          0
        )
      ).to.be.revertedWithCustomError(liquidityLogic, "InvalidTick");
    });
    it("fails on duplicate ticks", async function () {
      await expect(
        liquidityLogic.source(
          FixedPoint.from("25"),
          [Tick.encode("10"), Tick.encode("20"), Tick.encode("20"), Tick.encode("40")],
          1,
          0,
          0
        )
      ).to.be.revertedWithCustomError(liquidityLogic, "InvalidTick");
    });
    it("fails on excessive ticks", async function () {
      const ticks2 = [];
      let limit = FixedPoint.from("60");
      for (let i = 0; i < 35; i++) {
        await liquidityLogic.deposit(Tick.encode(limit), FixedPoint.from("1"));
        ticks2.push(Tick.encode(limit));
        limit = limit * 2n;
      }

      await expect(liquidityLogic.source(FixedPoint.from("30"), ticks2, 0, 0, 0)).to.be.revertedWithCustomError(
        liquidityLogic,
        "InsufficientLiquidity"
      );
    });
    it("fails on low duration ticks", async function () {
      await expect(
        liquidityLogic.source(FixedPoint.from("15"), [Tick.encode("10", 2, 0), Tick.encode("20", 0, 1)], 1, 1, 0)
      ).to.be.revertedWithCustomError(liquidityLogic, "InvalidTick");
    });
  });
});
