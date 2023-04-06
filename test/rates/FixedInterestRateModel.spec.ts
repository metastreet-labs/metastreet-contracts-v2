import { expect } from "chai";
import { ethers, network } from "hardhat";

import { FixedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint.ts";

describe("FixedInterestRateModel", function () {
  const PARAMETERS_1 = [
    FixedPoint.normalizeRate("0.02") /* rate: 2.0 */,
    FixedPoint.from("0") /* tick threshold: 0 */,
    FixedPoint.from("2") /* tick exp base: 2.0 */,
  ];
  const PARAMETERS_2 = [
    FixedPoint.normalizeRate("0.02") /* rate: 2.0 */,
    FixedPoint.from("0.05") /* tick threshold: 0.05 */,
    FixedPoint.from("1.5") /* tick exp base: 1.5 */,
  ];

  const FIXED_INTEREST_RATE = FixedPoint.normalizeRate("0.02");

  let interestRateModel: FixedInterestRateModel;
  let interestRateModel2: FIxedInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const fixedInterestRateModelFactory = await ethers.getContractFactory("TestFixedInterestRateModel");

    interestRateModel = await fixedInterestRateModelFactory.deploy(PARAMETERS_1);
    await interestRateModel.deployed();

    interestRateModel2 = await fixedInterestRateModelFactory.deploy(PARAMETERS_2);
    await interestRateModel2.deployed();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected name", async function () {
      expect(await interestRateModel.INTEREST_RATE_MODEL_NAME()).to.equal("FixedInterestRateModel");
    });
    it("matches expected implementation version", async function () {
      expect(await interestRateModel.INTEREST_RATE_MODEL_VERSION()).to.equal("1.0");
    });
  });

  describe("rate", async function () {
    it("returns correct rate", async function () {
      expect(await interestRateModel.rate()).to.equal(FIXED_INTEREST_RATE);
    });
  });

  const sources1 = [
    {
      depth: FixedPoint.from("15"),
      available: FixedPoint.from("10"),
      used: FixedPoint.from("10"),
      pending: FixedPoint.Zero,
    },
  ];

  const sources4 = [
    {
      depth: FixedPoint.from("1"),
      available: FixedPoint.from("29"),
      used: FixedPoint.from("1"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("5"),
      available: FixedPoint.from("16"),
      used: FixedPoint.from("4"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("10"),
      available: FixedPoint.from("5"),
      used: FixedPoint.from("5"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("15"),
      available: FixedPoint.from("3"),
      used: FixedPoint.from("2"),
      pending: FixedPoint.Zero,
    },
  ];

  const sources5 = [
    {
      depth: FixedPoint.from("1"),
      available: FixedPoint.from("29"),
      used: FixedPoint.from("1"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("5"),
      available: FixedPoint.from("16"),
      used: FixedPoint.from("4"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("10"),
      available: FixedPoint.from("5"),
      used: FixedPoint.from("5"),
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("12"),
      available: FixedPoint.from("5"),
      used: 10,
      pending: FixedPoint.Zero,
    },
    {
      depth: FixedPoint.from("15"),
      available: FixedPoint.from("3"),
      used: FixedPoint.from("2"),
      pending: FixedPoint.Zero,
    },
  ];

  describe("distribute (base 2)", async function () {
    it("distributes interest to one node", async function () {
      const pending = await interestRateModel.distribute(
        FixedPoint.from("10"),
        FixedPoint.from("3"),
        sources1,
        sources1.length
      );
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(FixedPoint.from("3"));
    });
    it("distributes interest to four nodes", async function () {
      const pending = await interestRateModel.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources4,
        sources4.length
      );
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(FixedPoint.from("0.044444444444444444"));
      expect(pending[1]).to.equal(FixedPoint.from("0.355555555555555552"));
      expect(pending[2]).to.equal(FixedPoint.from("0.888888888888888890"));
      expect(pending[3]).to.equal(FixedPoint.from("0.711111111111111114"));
    });
  });

  describe("distribute (base 1.5, threshold 0.05)", async function () {
    it("distributes interest to one node", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("10"),
        FixedPoint.from("3"),
        sources1,
        sources1.length
      );
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(FixedPoint.from("3"));
    });
    it("distributes interest to four nodes", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources4,
        sources4.length
      );
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(FixedPoint.from("0.079999999999999999"));
      expect(pending[1]).to.equal(FixedPoint.from("0.479999999999999999"));
      expect(pending[2]).to.equal(FixedPoint.from("0.900000000000000003"));
      expect(pending[3]).to.equal(FixedPoint.from("0.539999999999999999"));
    });
    it("distributes interest to five nodes with one dust node", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources5,
        sources5.length
      );
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(FixedPoint.from("0.079999999999999999"));
      expect(pending[1]).to.equal(FixedPoint.from("0.479999999999999999"));
      expect(pending[2]).to.equal(FixedPoint.from("0.900000000000000003"));
      expect(pending[3]).to.equal(ethers.constants.Zero);
      expect(pending[4]).to.equal(FixedPoint.from("0.539999999999999999"));
    });
  });
});
