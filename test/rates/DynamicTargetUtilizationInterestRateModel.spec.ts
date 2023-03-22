import { expect } from "chai";
import { ethers, network } from "hardhat";

import { DynamicTargetUtilizationInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint.ts";
import { getBlockTimestamp, elapseForDuration } from "../helpers/BlockchainUtilities.ts";

describe("DynamicTargetUtilizationInterestRateModel", function () {
  const PARAMETERS = [
    {
      margin: ethers.BigNumber.from((0.05 * 2 ** 56).toString()) /* 5% */,
      gain: ethers.BigNumber.from(
        Math.floor((1 / (0.4 * 86400)) * 2 ** 56).toString()
      ) /* Change by 1.0 for error of 0.40 for every 86400 seconds */,
      min: ethers.BigNumber.from((1 * 2 ** 56).toString()) /* 1.0 */,
      max: ethers.BigNumber.from((100 * 2 ** 56).toString()) /* 100.0 */,
    },
    ethers.BigNumber.from((0.8 * 2 ** 56).toString()) /* target: 80% */,
    ethers.BigNumber.from((20 * 2 ** 56).toString()) /* initial rate: 20.0 */,
    FixedPoint.from("0.05") /* tick threshold: 0.05 */,
    FixedPoint.from("2") /* tick exp base: 2.0 */,
  ];

  let accounts: SignerWithAddress[];
  let interestRateModel: DynamicTargetUtilizationInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const fixedInterestRateModelFactory = await ethers.getContractFactory("DynamicTargetUtilizationInterestRateModel");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");

    const interestRateModelImpl = await fixedInterestRateModelFactory.deploy();
    await interestRateModelImpl.deployed();

    const proxy = await testProxyFactory.deploy(
      interestRateModelImpl.address,
      interestRateModelImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["tuple(uint64 margin, uint64 gain, uint64 min, uint64 max)", "uint64", "uint64", "uint64", "uint64"],
          PARAMETERS
        ),
      ])
    );
    await proxy.deployed();

    interestRateModel = (await ethers.getContractAt(
      "DynamicTargetUtilizationInterestRateModel",
      proxy.address
    )) as DynamicTargetUtilizationInterestRateModel;
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected name", async function () {
      expect(await interestRateModel.name()).to.equal("DynamicTargetUtilizationInterestRateModel");
    });
  });

  describe("initial state", async function () {
    it("matches parameters", async function () {
      const parameters = await interestRateModel.getParameters();
      expect(parameters.margin).to.equal(PARAMETERS[0].margin);
      expect(parameters.gain).to.equal(PARAMETERS[0].gain);
      expect(parameters.min).to.equal(PARAMETERS[0].min);
      expect(parameters.max).to.equal(PARAMETERS[0].max);
    });

    it("matches initial state", async function () {
      const state = await interestRateModel.getState();
      expect(state.target).to.equal(PARAMETERS[1]);
      expect(state.utilization).to.equal(0);
      expect(state.rate).to.equal(PARAMETERS[2]);
      expect(state.timestamp).to.be.gt(0);
    });
  });

  function expectApproxEqual(
    a: ethers.BigNumber,
    b: ethers.BigNumber,
    epsilon?: ethers.BigNumber = ethers.utils.parseEther("0.000000000001")
  ): void {
    expect(a.sub(b).abs()).to.be.lt(epsilon);
  }

  async function rateAfterDuration(duration: number): Promise<ethers.BigNumber> {
    await elapseForDuration(duration);
    return await interestRateModel.rate();
  }

  describe("#rate()", async function () {
    it("returns initial rate", async function () {
      expectApproxEqual(await interestRateModel.rate(), FixedPoint.from("20"));
    });
    it("returns decaying rate", async function () {
      /* Rate: 20, Target: 0.80, Utilization: 0.00, Error: -0.80 */
      /* Adjustment for 86400: -2 */
      expectApproxEqual(await rateAfterDuration(86400), FixedPoint.from("18"));
    });
    it("returns saturated min rate", async function () {
      /* Rate: 20, Target: 0.80, Utilization: 0.00, Error: -0.80 */
      /* Adjustment for 86400: -2, Adjustment for 10*86400: -20 */
      expectApproxEqual(await rateAfterDuration(15 * 86400), FixedPoint.from("1"));
    });
    it("returns growing rate", async function () {
      await interestRateModel.onUtilizationUpdated(FixedPoint.from("0.90"));

      /* Rate: 20, Target: 0.80, Utilization: 0.90, Error: +0.10, Adjustment: +0.25 */
      expectApproxEqual(await rateAfterDuration(86400), FixedPoint.from("20.25"), FixedPoint.from("0.0001"));
    });
    it("return saturated max rate", async function () {
      await interestRateModel.onUtilizationUpdated(FixedPoint.from("0.90"));

      /* Rate: 20, Target: 0.80, Utilization: 0.90, Error: +0.10 */
      /* Adjustment for 86400: +0.25, Adjustment for 320*86400: +80  */
      expectApproxEqual(await rateAfterDuration(325 * 86400), FixedPoint.from("100"));
    });
    it("returns steady rate within error margin", async function () {
      /* Within -5 of target */
      await interestRateModel.onUtilizationUpdated(FixedPoint.from("0.76"));
      expectApproxEqual(await interestRateModel.rate(), FixedPoint.from("20"), FixedPoint.from("0.0001"));
      expect(await interestRateModel.rate()).to.equal(await rateAfterDuration(10 * 86400));

      /* Within +5 of target */
      await interestRateModel.onUtilizationUpdated(FixedPoint.from("0.84"));
      expectApproxEqual(await interestRateModel.rate(), FixedPoint.from("20"), FixedPoint.from("0.0001"));
      expect(await interestRateModel.rate()).to.equal(await rateAfterDuration(10 * 86400));
    });
  });

  describe("#distribute() (base 2, threshold 0.05)", async function () {
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

    it("distributes interest to five nodes with one dust node", async function () {
      const pending = await interestRateModel.distribute(
        FixedPoint.from("12"),
        FixedPoint.from("2"),
        sources5,
        sources5.length
      );
      expect(pending.length).to.equal(5);
      expect(pending[0]).to.equal(FixedPoint.from("0.032786885245901633"));
      expect(pending[1]).to.equal(FixedPoint.from("0.262295081967213113"));
      expect(pending[2]).to.equal(FixedPoint.from("0.655737704918032789"));
      expect(pending[3]).to.equal(ethers.constants.Zero);
      expect(pending[4]).to.equal(FixedPoint.from("1.049180327868852465"));
    });
  });

  describe("#onUtilizationUpdated", async function () {
    it("fails on invalid caller", async function () {
      await expect(
        interestRateModel.connect(accounts[1]).onUtilizationUpdated(FixedPoint.from("0.50"))
      ).to.be.revertedWith("Invalid caller");
    });
  });
});