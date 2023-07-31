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
    await tickLibrary.deployed();

    tickLibrary.validate = tickLibrary["validate(uint128,uint256,uint256,uint256,uint256,uint256)"];
    tickLibrary.validateFast = tickLibrary["validate(uint128,uint256,uint256)"];
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

  const TEST_TICK = Tick.encode(FixedPoint.from("123.3"), 3, 5);

  describe("#decode", async function () {
    it("decodes a tick", async function () {
      const [limit, duration, rate, reserved] = await tickLibrary.decode(TEST_TICK);
      expect(limit).to.equal(FixedPoint.from("123.3"));
      expect(duration).to.equal(3);
      expect(rate).to.equal(5);
      expect(reserved).to.equal(0);
    });
  });

  describe("#validate (exhaustive)", async function () {
    it("suceeds on a valid tick", async function () {
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
    it("reverts on non-zero reserved field", async function () {
      await expect(tickLibrary.validate(TEST_TICK.add(2), 0, 0, 7, 0, 7)).to.be.revertedWithCustomError(
        tickLibrary,
        "InvalidTick"
      );
    });
  });

  describe("#validate (fast)", async function () {
    it("suceeds on a valid tick", async function () {
      expect(await tickLibrary.validateFast(TEST_TICK, 0, 4)).to.equal(FixedPoint.from("123.3"));
      expect(await tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.2"), 3, 5), 4)).to.equal(
        FixedPoint.from("123.3")
      );
      expect(await tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.2"), 3, 4), 4)).to.equal(
        FixedPoint.from("123.3")
      );
    });
    it("reverts on non-strictly increasing ticks", async function () {
      await expect(
        tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.4"), 3, 5), 4)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
      await expect(
        tickLibrary.validateFast(TEST_TICK, Tick.encode(FixedPoint.from("123.3"), 3, 6), 4)
      ).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
    });
    it("reverts on out of bounds duration index", async function () {
      await expect(tickLibrary.validateFast(TEST_TICK, 0, 3)).to.be.revertedWithCustomError(tickLibrary, "InvalidTick");
    });
  });
});
