import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestSimpleInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint";
import { Tick } from "../helpers/Tick";

describe("SimpleInterestRateModel", function () {
  const RATES = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

  let interestRateModel: TestSimpleInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const simpleInterestRateModelFactory = await ethers.getContractFactory("TestSimpleInterestRateModel");

    interestRateModel = await simpleInterestRateModelFactory.deploy();
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
      expect(await interestRateModel.INTEREST_RATE_MODEL_NAME()).to.equal("SimpleInterestRateModel");
    });
    it("matches expected implementation version", async function () {
      expect(await interestRateModel.INTEREST_RATE_MODEL_VERSION()).to.equal("1.0");
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

  const nodes1 = [
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("10"),
      pending: ethers.constants.Zero,
    },
  ];

  const nodes2 = [
    {
      tick: Tick.encode("1", 0, 0),
      used: FixedPoint.from("1"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("14"),
      pending: ethers.constants.Zero,
    },
  ];

  const nodes4 = [
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

  const nodes5 = [
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

  describe("#price", async function () {
    it("prices interest to one node at 10% interest and 0% admin fee with 10 ETH used", async function () {
      const principal = nodes1.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = nodes1.reduce(
        (acc, n) =>
          acc.add(n.used.mul(RATES[Tick.decode(n.tick).rateIndex]).mul(ONE_YEAR).div(ethers.constants.WeiPerEther)),
        ethers.constants.Zero
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        ONE_YEAR,
        nodes1,
        nodes1.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(nodes1[0].used.add(interest));
    });

    it("prices interest to four node at 10% interest and 0% admin fee with 12 ETH used", async function () {
      const principal = nodes4.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = nodes4.reduce(
        (acc, n) =>
          acc.add(n.used.mul(RATES[Tick.decode(n.tick).rateIndex]).mul(ONE_YEAR).div(ethers.constants.WeiPerEther)),
        ethers.constants.Zero
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        ONE_YEAR,
        nodes4,
        nodes4.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(
        nodes4[0].used.add(
          nodes4[0].used
            .mul(RATES[Tick.decode(nodes4[0].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[1]).to.equal(
        nodes4[1].used.add(
          nodes4[1].used
            .mul(RATES[Tick.decode(nodes4[1].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[2]).to.equal(
        nodes4[2].used.add(
          nodes4[2].used
            .mul(RATES[Tick.decode(nodes4[2].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[3]).to.equal(
        nodes4[3].used.add(
          nodes4[3].used
            .mul(RATES[Tick.decode(nodes4[3].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
    });

    it("prices interest to one node at 10% interest and 5% admin fee with 10 ETH used", async function () {
      const principal = nodes1.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = nodes1.reduce(
        (acc, n) =>
          acc.add(n.used.mul(RATES[Tick.decode(n.tick).rateIndex]).mul(ONE_YEAR).div(ethers.constants.WeiPerEther)),
        ethers.constants.Zero
      );

      const adminFee = interest.mul(500).div(ethers.BigNumber.from("10000"));

      const [repayment, adminFee_, pending] = await interestRateModel.price(
        principal,
        ONE_YEAR,
        nodes1,
        nodes1.length,
        RATES,
        500
      );
      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee_).to.equal(adminFee);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(nodes1[0].used.add(interest.sub(adminFee)));
    });

    it("prices interest to two nodes at 10% interest and 5% admin fee with 15 ETH used", async function () {
      const principal = nodes2.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = nodes2.reduce(
        (acc, n) =>
          acc.add(n.used.mul(RATES[Tick.decode(n.tick).rateIndex]).mul(ONE_YEAR).div(ethers.constants.WeiPerEther)),
        ethers.constants.Zero
      );

      const adminFee = interest.mul(500).div(ethers.BigNumber.from("10000"));

      const [repayment, adminFee_, pending] = await interestRateModel.price(
        principal,
        ONE_YEAR,
        nodes2,
        nodes2.length,
        RATES,
        500
      );
      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee_).to.equal(adminFee);
      expect(pending.length).to.equal(2);
      expect(pending[0]).to.equal(FixedPoint.from("1.0949999999887216"));
      expect(pending[1]).to.equal(FixedPoint.from("15.3299999998421024"));
    });

    it("prices interest to five node at 30% and 50% interest and 0% admin fee with ~12 ETH used", async function () {
      const principal = nodes5.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = nodes5.reduce(
        (acc, n) =>
          acc.add(n.used.mul(RATES[Tick.decode(n.tick).rateIndex]).mul(ONE_YEAR).div(ethers.constants.WeiPerEther)),
        ethers.constants.Zero
      );

      const [repayment, adminFee, pending] = await interestRateModel.price(
        principal,
        ONE_YEAR,
        nodes5,
        nodes5.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(
        nodes5[0].used.add(
          nodes5[0].used
            .mul(RATES[Tick.decode(nodes5[0].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[1]).to.equal(
        nodes5[1].used.add(
          nodes5[1].used
            .mul(RATES[Tick.decode(nodes5[1].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[2]).to.equal(
        nodes5[2].used.add(
          nodes5[2].used
            .mul(RATES[Tick.decode(nodes5[2].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[3]).to.equal(
        nodes5[3].used.add(
          nodes5[3].used
            .mul(RATES[Tick.decode(nodes5[3].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
      expect(pending[4]).to.equal(
        nodes5[4].used.add(
          nodes5[4].used
            .mul(RATES[Tick.decode(nodes5[4].tick).rateIndex])
            .mul(ONE_YEAR)
            .div(ethers.constants.WeiPerEther)
        )
      );
    });
  });
});
