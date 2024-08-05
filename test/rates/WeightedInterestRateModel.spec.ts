import { expect } from "chai";
import { ethers, network } from "hardhat";

import { WeightedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint";
import { Tick } from "../helpers/Tick";

describe("WeightedInterestRateModel", function () {
  const RATES = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

  let interestRateModel: WeightedInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const weightedInterestRateModelFactory = await ethers.getContractFactory("TestWeightedInterestRateModel");

    interestRateModel = await weightedInterestRateModelFactory.deploy();
    await interestRateModel.waitForDeployment();
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
      expect(await interestRateModel.INTEREST_RATE_MODEL_VERSION()).to.equal("2.0");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  const nodes1 = [
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("10"),
      pending: 0n,
    },
  ];

  const nodes4 = [
    {
      tick: Tick.encode("1", 0, 0),
      used: FixedPoint.from("1"),
      pending: 0n,
    },
    {
      tick: Tick.encode("5", 0, 0),
      used: FixedPoint.from("4"),
      pending: 0n,
    },
    {
      tick: Tick.encode("10", 0, 1),
      used: FixedPoint.from("5"),
      pending: 0n,
    },
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("2"),
      pending: 0n,
    },
  ];

  const nodes5 = [
    {
      tick: Tick.encode("1", 0, 0),
      used: FixedPoint.from("1"),
      pending: 0n,
    },
    {
      tick: Tick.encode("5", 0, 0),
      used: FixedPoint.from("4"),
      pending: 0n,
    },
    {
      tick: Tick.encode("10", 0, 1),
      used: FixedPoint.from("5"),
      pending: 0n,
    },
    {
      tick: Tick.encode("12", 0, 2),
      used: BigInt(10),
      pending: 0n,
    },
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("2"),
      pending: 0n,
    },
  ];

  const nodes6 = [
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("10"),
      pending: 0n,
    },
    {
      tick: Tick.encode("20", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: 0n,
    },
    {
      tick: Tick.encode("25", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: 0n,
    },
    {
      tick: Tick.encode("30", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: 0n,
    },
    {
      tick: Tick.encode("35", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: 0n,
    },
    {
      tick: Tick.encode("40", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: 0n,
    },
  ];

  describe("#price", async function () {
    it("prices interest to one node", async function () {
      const principal = nodes1.reduce((acc, n) => acc + n.used, 0n);
      const interest = (FixedPoint.normalizeRate("0.10") * (30n * 86400n) * principal) / ethers.WeiPerEther;

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        30 * 86400,
        nodes1,
        nodes1.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal + interest);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(nodes1[0].used + FixedPoint.from("0.082191780812160000"));
    });
    it("prices interest to four nodes", async function () {
      const principal = nodes4.reduce((acc, n) => acc + n.used, 0n);
      const interest = nodes4.reduce(
        (acc, n) => acc + (n.used * RATES[Tick.decode(n.tick).rateIndex] * (30n * 86400n)) / ethers.WeiPerEther,
        0n
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        30 * 86400,
        nodes4,
        nodes4.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal + interest);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(nodes4[0].used + FixedPoint.from("0.002533782213967835"));
      expect(pending[1]).to.equal(nodes4[1].used + FixedPoint.from("0.050675644279356660"));
      expect(pending[2]).to.equal(nodes4[2].used + FixedPoint.from("0.129804324682933386"));
      expect(pending[3]).to.equal(nodes4[3].used + FixedPoint.from("0.063561591278366119"));
    });
    it("prices interest to four nodes with admin fee", async function () {
      const principal = nodes4.reduce((acc, n) => acc + n.used, 0n);
      const interest = nodes4.reduce(
        (acc, n) => acc + (n.used * RATES[Tick.decode(n.tick).rateIndex] * (30n * 86400n)) / ethers.WeiPerEther,
        0n
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        30 * 86400,
        nodes4,
        nodes4.length,
        RATES,
        500
      );

      expect(repayment).to.equal(principal + interest);
      expect(adminFee).to.equal((interest * 500n) / 10000n);
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(nodes4[0].used + FixedPoint.from("0.002407093103269444"));
      expect(pending[1]).to.equal(nodes4[1].used + FixedPoint.from("0.048141862065388827"));
      expect(pending[2]).to.equal(nodes4[2].used + FixedPoint.from("0.123314108448786716"));
      expect(pending[3]).to.equal(nodes4[3].used + FixedPoint.from("0.060383511714447813"));
    });
    it("prices interest to five nodes with one dust node", async function () {
      const principal = nodes5.reduce((acc, n) => acc + n.used, 0n);
      const interest = nodes5.reduce(
        (acc, n) => acc + (n.used * RATES[Tick.decode(n.tick).rateIndex] * (30n * 86400n)) / ethers.WeiPerEther,
        0n
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        30 * 86400,
        nodes5,
        nodes5.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal + interest);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(nodes5[0].used + FixedPoint.from("0.002533782213967835"));
      expect(pending[1]).to.equal(nodes5[1].used + FixedPoint.from("0.050675644279356660"));
      expect(pending[2]).to.equal(nodes5[2].used + FixedPoint.from("0.129804324682933386"));
      expect(pending[3]).to.equal(nodes5[3].used);
      expect(pending[4]).to.equal(nodes5[4].used + FixedPoint.from("0.063561591278366119"));
    });
    it("prices interest to six nodes with five small deposit nodes", async function () {
      const principal = nodes6.reduce((acc, n) => acc + n.used, 0n);
      const interest = nodes6.reduce(
        (acc, n) => acc + (n.used * RATES[Tick.decode(n.tick).rateIndex] * (30n * 86400n)) / ethers.WeiPerEther,
        0n
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        30 * 86400,
        nodes6,
        nodes6.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal + interest);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(6);
      expect(pending[0]).to.equal(nodes6[0].used + FixedPoint.from("0.410943114799472367"));
      expect(pending[1]).to.equal(nodes6[1].used + FixedPoint.from("0.000003979698177924"));
      expect(pending[2]).to.equal(nodes6[2].used + FixedPoint.from("0.000003979736717786"));
      expect(pending[3]).to.equal(nodes6[3].used + FixedPoint.from("0.000003979775257648"));
      expect(pending[4]).to.equal(nodes6[4].used + FixedPoint.from("0.000003979813797509"));
      expect(pending[5]).to.equal(nodes6[5].used + FixedPoint.from("0.000003979852337371"));
    });
    it("prices interest to four nodes with admin fee and zero duration", async function () {
      const principal = nodes4.reduce((acc, n) => acc + n.used, 0n);

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        0,
        nodes4,
        nodes4.length,
        RATES,
        500
      );

      expect(repayment).to.equal(principal);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(nodes4[0].used);
      expect(pending[1]).to.equal(nodes4[1].used);
      expect(pending[2]).to.equal(nodes4[2].used);
      expect(pending[3]).to.equal(nodes4[3].used);
    });
    it("prices interest to four nodes with admin fee and zero principal", async function () {
      const [repayment, adminFee, pending] = await interestRateModel.price(0, 30 * 86400, nodes4, 0, RATES, 500);

      expect(repayment).to.equal(0n);
      expect(adminFee).to.equal(0n);
      expect(pending.length).to.equal(0);
    });
  });
});
