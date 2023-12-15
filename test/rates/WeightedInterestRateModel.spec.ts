import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestWeightedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint";
import { Tick } from "../helpers/Tick";

describe("WeightedInterestRateModel", function () {
  const RATES = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

  let interestRateModel: TestWeightedInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const weightedInterestRateModelFactory = await ethers.getContractFactory("TestWeightedInterestRateModel");

    interestRateModel = await weightedInterestRateModelFactory.deploy();
    await interestRateModel.deployed();
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
    it("matches expected name", async function () {
      expect(await interestRateModel.INTEREST_RATE_MODEL_NAME()).to.equal("WeightedInterestRateModel");
    });
    it("matches expected implementation version", async function () {
      expect(await interestRateModel.INTEREST_RATE_MODEL_VERSION()).to.equal("1.1");
    });
  });

  /****************************************************************************/
  /* Helpers */
  /****************************************************************************/

  const ONE_YEAR = 365 * 86400;
  const BASIS_POINT_SCALE = ethers.BigNumber.from("10000");
  const FIXED_POINT_SCALE = FixedPoint.from("1");

  function calculateDistribution(source: any, duration?: number = ONE_YEAR, adminFeeRate?: string = "0") {
    const rateIndex = Tick.decode(source.tick)["rateIndex"];

    const totalFee = source.used.mul(ethers.BigNumber.from(duration)).mul(RATES[rateIndex]).div(FIXED_POINT_SCALE);
    const adminFee = totalFee.mul(ethers.BigNumber.from(adminFeeRate)).div(BASIS_POINT_SCALE);
    const pending = source.used.add(totalFee).sub(adminFee);
    const repayment = source.used.add(totalFee);

    return [totalFee, adminFee, pending, repayment];
  }

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  const sources1 = [
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("10"),
      pending: ethers.constants.Zero,
    },
  ];

  const sources4 = [
    {
      tick: Tick.encode("1", 0, 0),
      used: FixedPoint.from("1"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("5", 0, 0),
      used: FixedPoint.from("4"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("10", 0, 0),
      used: FixedPoint.from("5"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("2"),
      pending: ethers.constants.Zero,
    },
  ];

  const sources5 = [
    {
      tick: Tick.encode("1", 0, 1),
      used: FixedPoint.from("1"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("5", 0, 2),
      used: FixedPoint.from("4"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("10", 0, 1),
      used: FixedPoint.from("5"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("12", 0, 2),
      used: ethers.BigNumber.from("10"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 1),
      used: FixedPoint.from("2"),
      pending: ethers.constants.Zero,
    },
  ];

  describe("#distribute", async function () {
    it("distributes pending to one node at 10% interest and 0% admin fee with 10 ETH used", async function () {
      const [pendings, totalRepayment, totalAdminFee] = await interestRateModel.distribute(
        ONE_YEAR,
        0,
        RATES,
        sources1
      );

      const [totalFee, adminFee, pending, repayment] = calculateDistribution(sources1[0]);

      expect(pendings.length).to.equal(1);
      expect(pendings[0]).to.equal(pending);

      /* Total repayment is 10.999999999 ETH, approx. 10% interest */
      expect(totalRepayment).to.be.equal(repayment);
      expect(adminFee).to.be.equal(0);
    });

    it("distributes pending to four node at 10% interest and 0% admin fee with 12 ETH used", async function () {
      const [pendings, totalRepayment, totalAdminFee] = await interestRateModel.distribute(
        ONE_YEAR,
        0,
        RATES,
        sources4
      );

      const [totalFee0, adminFee0, pending0, repayment0] = calculateDistribution(sources4[0]);
      const [totalFee1, adminFee1, pending1, repayment1] = calculateDistribution(sources4[1]);
      const [totalFee2, adminFee2, pending2, repayment2] = calculateDistribution(sources4[2]);
      const [totalFee3, adminFee3, pending3, repayment3] = calculateDistribution(sources4[3]);

      expect(pendings.length).to.equal(4);
      expect(pendings[0]).to.equal(pending0);
      expect(pendings[1]).to.equal(pending1);
      expect(pendings[2]).to.equal(pending2);
      expect(pendings[3]).to.equal(pending3);

      /* Total repayment is 13.199999999... ETH, approx. 10% interest */
      expect(totalRepayment).to.equal(repayment0.add(repayment1).add(repayment2).add(repayment3));
      expect(totalAdminFee).to.be.equal(0);
    });

    it("distributes pending to one node at 10% interest and 5% admin fee with 10 ETH used", async function () {
      const [pendings, totalRepayment, totalAdminFee] = await interestRateModel.distribute(
        ONE_YEAR,
        500,
        RATES,
        sources1
      );

      const [totalFee, adminFee, pending, repayment] = calculateDistribution(sources1[0], ONE_YEAR, "500");

      expect(pendings.length).to.equal(1);
      expect(pendings[0]).to.equal(pending);

      /* Total repayment is 10.999999999 ETH, approx. 10% interest */
      expect(totalRepayment).to.be.equal(repayment);
      expect(totalAdminFee).to.be.equal(adminFee);
    });

    it("distributes pending to five node at 30% and 50% interest and 0% admin fee with ~12 ETH used", async function () {
      const [pendings, totalRepayment, totalAdminFee] = await interestRateModel.distribute(
        ONE_YEAR,
        0,
        RATES,
        sources5
      );

      const [totalFee0, adminFee0, pending0, repayment0] = calculateDistribution(sources5[0]);
      const [totalFee1, adminFee1, pending1, repayment1] = calculateDistribution(sources5[1]);
      const [totalFee2, adminFee2, pending2, repayment2] = calculateDistribution(sources5[2]);
      const [totalFee3, adminFee3, pending3, repayment3] = calculateDistribution(sources5[3]);
      const [totalFee4, adminFee4, pending4, repayment4] = calculateDistribution(sources5[4]);

      expect(pendings.length).to.equal(5);
      expect(pendings[0]).to.equal(pending0);
      expect(pendings[1]).to.equal(pending1);
      expect(pendings[2]).to.equal(pending2);
      expect(pendings[3]).to.equal(pending3);
      expect(pendings[4]).to.equal(pending4);

      /* Total repayment is 16.399999999... ETH, approx. 36.6% interest */
      expect(totalRepayment).to.equal(repayment0.add(repayment1).add(repayment2).add(repayment3).add(repayment4));
      expect(totalAdminFee).to.be.equal(0);
    });
  });
});
