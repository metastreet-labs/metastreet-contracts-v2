import { expect } from "chai";
import { ethers, network } from "hardhat";

import { WeightedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint";
import { Tick } from "../helpers/Tick";

describe("WeightedInterestRateModel", function () {
  const PARAMETERS_1 = [FixedPoint.from("2") /* tick exp base: 2.0 */];
  const PARAMETERS_2 = [
    FixedPoint.from("1.5") /* tick exp base: 1.5 */,
  ];
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
});
