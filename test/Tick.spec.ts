import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";

import { TestTick } from "../typechain";

import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Tick", function () {
  let snapshotId: string;
  let tickLibrary: TestTick;

  before("deploy fixture", async () => {
    const testTickFactory = await ethers.getContractFactory("TestTick");

    /* Deploy tick library */
    tickLibrary = await testTickFactory.deploy();
    await tickLibrary.waitForDeployment();

    tickLibrary.validate = tickLibrary["validate(uint128,uint256,uint256,uint256,uint256,uint256)"];
    tickLibrary.validateFast = tickLibrary["validate(uint128,uint128,uint256,uint256)"];
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

  const TEST_TICK = Tick.encode(FixedPoint.from("123.3"), 3, 5, 18);
  const TEST_TICK_2 = Tick.encode(BigInt(5000), 3, 5, 18, 1);
  const TEST_TICK_3 = Tick.encode(BigInt(10001), 3, 5, 18, 1);
  const TEST_TICK_4 = Tick.encode(BigInt(10001), 3, 6, 18, 1);

  describe("#decode", async function () {
    it("decodes a tick with absolute limit", async function () {
      const [limit, duration, rate, type] = await tickLibrary.decode(TEST_TICK, 10000n);
      expect(limit).to.equal(FixedPoint.from("123.3"));
      expect(duration).to.equal(3);
      expect(rate).to.equal(5);
      expect(type).to.equal(0);
    });
    it("decodes a tick with ratio limit", async function () {
      const [limit, duration, rate, type] = await tickLibrary.decode(TEST_TICK_2, 10000n);
      expect(limit).to.equal((BigInt(5000) * BigInt(10000)) / BigInt(10000));
      expect(duration).to.equal(3);
      expect(rate).to.equal(5);
      expect(type).to.equal(1);
    });
    it("decodes sentinel tick has absolute type", async function () {
      const [limit, duration, rate, type] = await tickLibrary.decode(
        BigInt("340282366920938463463374607431768211455"),
        10000
      );
      expect(type).to.equal(0);
    });
  });

  describe("#validate (exhaustive)", async function () {
    it("succeeds on a valid tick", async function () {
      await tickLibrary.validate(TEST_TICK, 0, 0, 7, 0, 7);
    });
    it("reverts on out of bounds limit", async function () {
      await expect(tickLibrary.validate(TEST_TICK, FixedPoint.from("150"), 0, 7, 0, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
    it("reverts on out of bounds duration index", async function () {
      await expect(tickLibrary.validate(TEST_TICK, 0, 4, 7, 0, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
      await expect(tickLibrary.validate(TEST_TICK, 0, 0, 2, 0, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
    it("reverts on out of bounds rate index", async function () {
      await expect(tickLibrary.validate(TEST_TICK, 0, 0, 7, 6, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
      await expect(tickLibrary.validate(TEST_TICK, 0, 0, 7, 0, 3)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
    it("reverts on out of scope limit type field", async function () {
      await expect(tickLibrary.validate(TEST_TICK + 2n, 0, 0, 7, 0, 7)).to.be.revertedWithPanic("0x21");
    });
    it("reverts on out of scope ratio limit", async function () {
      await expect(tickLibrary.validate(TEST_TICK_3, 0, 0, 7, 0, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
  });

  describe("#validate (fast)", async function () {
    it("succeeds on a valid tick", async function () {
      expect(await tickLibrary.validateFast(TEST_TICK, 0, 4, 10000n)).to.equal(FixedPoint.from("123.3"));
      expect(
        await tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.2"), 3, 5), 3, 10000n)
      ).to.equal(FixedPoint.from("123.3"));
      expect(
        await tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.2"), 3, 4), 5, 10000n)
      ).to.equal(FixedPoint.from("123.3"));
      expect(await tickLibrary.validateFast(TEST_TICK_4, TEST_TICK_3, 5, 10000n)).to.equal(BigInt(10001));
    });
    it("reverts on non-strictly increasing ticks", async function () {
      await expect(
        tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.4"), 3, 5), 4, 10000n)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
      await expect(
        tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.3"), 3, 6), 4, 10000n)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
      await expect(
        tickLibrary.validateFast(TEST_TICK_2, Tick.encode(BigInt(5001), 3, 5, 18, 1), 4, 10000n)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
      await expect(
        tickLibrary.validateFast(TEST_TICK_2, Tick.encode(BigInt(5000), 3, 5, 18, 0), 4, 10000n)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
      await expect(
        tickLibrary.validateFast(TEST_TICK_2, Tick.encode(BigInt(5000), 3, 5, 18, 0), 4, 10000n)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
    });
    it("reverts on out of bounds duration index", async function () {
      await expect(tickLibrary.validateFast(TEST_TICK, 0, 2, 10000n)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
  });
});
