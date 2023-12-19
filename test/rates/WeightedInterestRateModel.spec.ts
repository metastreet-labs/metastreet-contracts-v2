import { expect } from "chai";
import { ethers, network } from "hardhat";

import { WeightedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint";
import { Tick } from "../helpers/Tick";

describe("WeightedInterestRateModel", function () {
  const PARAMETERS_1 = [FixedPoint.from("2") /* tick exp base: 2.0 */];
  const PARAMETERS_2 = [FixedPoint.from("1.5") /* tick exp base: 1.5 */];
  const RATES = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

  let interestRateModel1: WeightedInterestRateModel;
  let interestRateModel2: WeightedInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const weightedInterestRateModelFactory = await ethers.getContractFactory("TestWeightedInterestRateModel");

    interestRateModel1 = await weightedInterestRateModelFactory.deploy(PARAMETERS_1);
    await interestRateModel1.deployed();

    interestRateModel2 = await weightedInterestRateModelFactory.deploy(PARAMETERS_2);
    await interestRateModel2.deployed();
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
      expect(await interestRateModel1.INTEREST_RATE_MODEL_NAME()).to.equal("WeightedInterestRateModel");
    });
    it("matches expected implementation version", async function () {
      expect(await interestRateModel1.INTEREST_RATE_MODEL_VERSION()).to.equal("1.1");
    });
  });

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
      tick: Tick.encode("12", 0, 0),
      used: 10,
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("2"),
      pending: ethers.constants.Zero,
    },
  ];

  describe("#rate", async function () {
    it("returns correct rate", async function () {
      expect(
        await interestRateModel1.rate(
          FixedPoint.from("10"),
          RATES,
          [
            {
              tick: Tick.encode("5", 0, 0),
              used: FixedPoint.from("5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("10", 0, 0),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("20", 0, 0),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
          ],
          3
        )
      ).to.be.closeTo(FixedPoint.normalizeRate("0.10"), 1);

      expect(
        await interestRateModel1.rate(
          FixedPoint.from("10"),
          RATES,
          [
            {
              tick: Tick.encode("5", 0, 2),
              used: FixedPoint.from("5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("10", 0, 2),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("20", 0, 2),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
          ],
          3
        )
      ).to.be.closeTo(FixedPoint.normalizeRate("0.50"), 1);

      expect(
        await interestRateModel1.rate(
          FixedPoint.from("10"),
          RATES,
          [
            {
              tick: Tick.encode("5", 0, 0),
              used: FixedPoint.from("5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("10", 0, 1),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
            {
              tick: Tick.encode("20", 0, 2),
              used: FixedPoint.from("2.5"),
              pending: ethers.constants.Zero,
            },
          ],
          3
        )
      ).to.be.closeTo(FixedPoint.normalizeRate("0.25"), 1);
    });
  });

  describe("#distribute (base 2)", async function () {
    it("distributes interest to one node", async function () {
      const pending = await interestRateModel1.distribute(
        FixedPoint.from("10"),
        FixedPoint.from("3"),
        sources1,
        sources1.length
      );
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(sources1[0].used.add(FixedPoint.from("3")));
    });
    it("distributes interest to four nodes", async function () {
      const pending = await interestRateModel1.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources4,
        sources4.length
      );
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(sources4[0].used.add(FixedPoint.from("0.044444444444444444")));
      expect(pending[1]).to.equal(sources4[1].used.add(FixedPoint.from("0.355555555555555552")));
      expect(pending[2]).to.equal(sources4[2].used.add(FixedPoint.from("0.888888888888888890")));
      expect(pending[3]).to.equal(sources4[3].used.add(FixedPoint.from("0.711111111111111114")));
    });
  });

  describe("#distribute (base 1.5)", async function () {
    it("distributes interest to one node", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("10"),
        FixedPoint.from("3"),
        sources1,
        sources1.length
      );
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(sources1[0].used.add(FixedPoint.from("3")));
    });
    it("distributes interest to four nodes", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources4,
        sources4.length
      );
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(sources4[0].used.add(FixedPoint.from("0.079999999999999999")));
      expect(pending[1]).to.equal(sources4[1].used.add(FixedPoint.from("0.480000000000000000")));
      expect(pending[2]).to.equal(sources4[2].used.add(FixedPoint.from("0.900000000000000001")));
      expect(pending[3]).to.equal(sources4[3].used.add(FixedPoint.from("0.540000000000000000")));
    });
    it("distributes interest to five nodes with one dust node", async function () {
      const pending = await interestRateModel2.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources5,
        sources5.length
      );
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(sources5[0].used.add(FixedPoint.from("0.070484581497797354")));
      expect(pending[1]).to.equal(sources5[1].used.add(FixedPoint.from("0.422907488986784138")));
      expect(pending[2]).to.equal(sources5[2].used.add(FixedPoint.from("0.792951541850220267")));
      expect(pending[3]).to.equal(sources5[3].used);
      expect(pending[4]).to.equal(sources5[4].used.add(FixedPoint.from("0.713656387665198241")));
    });
  });

  const nodes1 = [
    {
      tick: Tick.encode("15", 0, 0),
      used: FixedPoint.from("10"),
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
      tick: Tick.encode("10", 0, 1),
      used: FixedPoint.from("5"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("2"),
      pending: ethers.constants.Zero,
    },
  ];

  const nodes5 = [
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
      tick: Tick.encode("10", 0, 1),
      used: FixedPoint.from("5"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("12", 0, 2),
      used: 10,
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("2"),
      pending: ethers.constants.Zero,
    },
  ];

  const nodes6 = [
    {
      tick: Tick.encode("15", 0, 2),
      used: FixedPoint.from("10"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("20", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("25", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("30", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("35", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: ethers.constants.Zero,
    },
    {
      tick: Tick.encode("40", 0, 0),
      used: FixedPoint.from("0.0001"),
      pending: ethers.constants.Zero,
    },
  ];

  describe("#price", async function () {
    it("prices interest to one node", async function () {
      const principal = nodes1.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = FixedPoint.normalizeRate("0.10")
        .mul(30 * 86400)
        .mul(principal)
        .div(ethers.constants.WeiPerEther);

      const [repayment, adminFee, pending] = await interestRateModel1.price(
        principal,
        30 * 86400,
        nodes1,
        nodes1.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(nodes1[0].used.add(FixedPoint.from("0.082191780812160000")));
    });
    it("prices interest to four nodes", async function () {
      const principal = nodes4.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = FixedPoint.normalizeRate("0.25")
        .mul(30 * 86400)
        .mul(principal)
        .div(ethers.constants.WeiPerEther);

      const [repayment, adminFee, pending] = await interestRateModel1.price(
        principal,
        30 * 86400,
        nodes4,
        nodes4.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(nodes4[0].used.add(FixedPoint.from("0.005479452054144012")));
      expect(pending[1]).to.equal(nodes4[1].used.add(FixedPoint.from("0.043835616433151996")));
      expect(pending[2]).to.equal(nodes4[2].used.add(FixedPoint.from("0.109589041082879996")));
      expect(pending[3]).to.equal(nodes4[3].used.add(FixedPoint.from("0.087671232866303996")));
    });
    it("prices interest to four nodes with admin fee", async function () {
      const principal = nodes4.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = FixedPoint.normalizeRate("0.25")
        .mul(30 * 86400)
        .mul(principal)
        .div(ethers.constants.WeiPerEther);

      const [repayment, adminFee, pending] = await interestRateModel1.price(
        principal,
        30 * 86400,
        nodes4,
        nodes4.length,
        RATES,
        500
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(interest.mul(500).div(10000));
      expect(pending.length).to.equal(4);
      expect(pending[0]).to.equal(nodes4[0].used.add(FixedPoint.from("0.005205479451436812")));
      expect(pending[1]).to.equal(nodes4[1].used.add(FixedPoint.from("0.041643835611494396")));
      expect(pending[2]).to.equal(nodes4[2].used.add(FixedPoint.from("0.104109589028735996")));
      expect(pending[3]).to.equal(nodes4[3].used.add(FixedPoint.from("0.083287671222988796")));
    });
    it("prices interest to five nodes with one dust node", async function () {
      const principal = nodes5.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = FixedPoint.normalizeRate("0.25")
        .mul(30 * 86400)
        .mul(principal)
        .div(ethers.constants.WeiPerEther);

      const [repayment, adminFee, pending] = await interestRateModel1.price(
        principal,
        30 * 86400,
        nodes5,
        nodes5.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(nodes5[0].used.add(FixedPoint.from("0.004042218728466903")));
      expect(pending[1]).to.equal(nodes5[1].used.add(FixedPoint.from("0.032337749827735076")));
      expect(pending[2]).to.equal(nodes5[2].used.add(FixedPoint.from("0.080844374569337699")));
      expect(pending[3]).to.equal(nodes5[3].used);
      expect(pending[4]).to.equal(nodes5[4].used.add(FixedPoint.from("0.129350999310940322")));
    });
    it("prices interest to six nodes with five dust nodes", async function () {
      const principal = nodes6.reduce((acc, n) => acc.add(n.used), ethers.constants.Zero);
      const interest = FixedPoint.normalizeRate("0.499980000944736")
        .mul(30 * 86400)
        .mul(principal)
        .div(ethers.constants.WeiPerEther);

      const [repayment, adminFee, pending] = await interestRateModel1.price(
        principal,
        30 * 86400,
        nodes6,
        nodes6.length,
        RATES,
        0
      );

      expect(repayment).to.equal(principal.add(interest));
      expect(adminFee).to.equal(ethers.constants.Zero);
      expect(pending.length).to.equal(6);
      expect(pending[0]).to.equal(nodes6[0].used.add(FixedPoint.from("0.410708374461080795")));
      expect(pending[1]).to.equal(nodes6[1].used.add(FixedPoint.from("0.000008214167489183")));
      expect(pending[2]).to.equal(nodes6[2].used.add(FixedPoint.from("0.000016428334978430")));
      expect(pending[3]).to.equal(nodes6[3].used.add(FixedPoint.from("0.000032856669956860")));
      expect(pending[4]).to.equal(nodes6[4].used.add(FixedPoint.from("0.000065713339913721")));
      expect(pending[5]).to.equal(nodes6[5].used.add(FixedPoint.from("0.000131426679827507")));
    });
  });
});
