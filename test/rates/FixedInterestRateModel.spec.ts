import { expect } from "chai";
import { ethers, network } from "hardhat";

import { FixedInterestRateModel } from "../../typechain";

import { FixedPoint } from "../helpers/FixedPoint.ts";

describe("FixedInterestRateModel", function () {
  const FIXED_INTEREST_RATE = FixedPoint.normalizeRate("0.02");

  let interestRateModel: FixedInterestRateModel;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const fixedInterestRateModelFactory = await ethers.getContractFactory("FixedInterestRateModel");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");

    const interestRateModelImpl = await fixedInterestRateModelFactory.deploy();
    await interestRateModelImpl.deployed();

    const proxy = await testProxyFactory.deploy(
      interestRateModelImpl.address,
      interestRateModelImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(["uint256"], [FIXED_INTEREST_RATE]),
      ])
    );
    await proxy.deployed();

    interestRateModel = (await ethers.getContractAt("FixedInterestRateModel", proxy.address)) as FixedInterestRateModel;
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected name", async function () {
      expect(await interestRateModel.name()).to.equal("FixedInterestRateModel");
    });
    it("matches expected fixed interest rate", async function () {
      expect(await interestRateModel.fixedInterestRate()).to.equal(FIXED_INTEREST_RATE);
    });
  });

  describe("price", async function () {
    it("returns correct rate", async function () {
      expect(await interestRateModel.price(1, 16)).to.equal(FIXED_INTEREST_RATE);
      expect(await interestRateModel.price(16, 16)).to.equal(FIXED_INTEREST_RATE);
    });
  });

  describe("distribute", async function () {
    it("distributes interest", async function () {
      /* Distribute to one node */
      let sources = [
        {
          depth: FixedPoint.from("15"),
          available: FixedPoint.from("20"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
      ];
      let [nodes, count] = await interestRateModel.distribute(
        FixedPoint.from("10"),
        FixedPoint.from("1"),
        sources,
        sources.length
      );
      expect(count).to.equal(1);
      expect(nodes[0].depth).to.equal(FixedPoint.from("15"));
      expect(nodes[0].available).to.equal(FixedPoint.from("10"));
      expect(nodes[0].used).to.equal(FixedPoint.from("10"));
      expect(nodes[0].pending).to.equal(FixedPoint.from("11"));

      /* Distribute to four nodes */
      sources = [
        {
          depth: FixedPoint.from("1"),
          available: FixedPoint.from("30"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("5"),
          available: FixedPoint.from("20"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("10"),
          available: FixedPoint.from("10"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("15"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
      ];
      [nodes, count] = await interestRateModel.distribute(
        ethers.utils.parseEther("12"),
        ethers.utils.parseEther("2"),
        sources,
        sources.length
      );
      expect(count).to.equal(4);
      expect(nodes[0].depth).to.equal(FixedPoint.from("1"));
      expect(nodes[0].available).to.equal(FixedPoint.from("29"));
      expect(nodes[0].used).to.equal(FixedPoint.from("1"));
      expect(nodes[0].pending).to.equal(FixedPoint.from("1.5"));
      expect(nodes[1].depth).to.equal(FixedPoint.from("5"));
      expect(nodes[1].available).to.equal(FixedPoint.from("16"));
      expect(nodes[1].used).to.equal(FixedPoint.from("4"));
      expect(nodes[1].pending).to.equal(FixedPoint.from("4.5"));
      expect(nodes[2].depth).to.equal(FixedPoint.from("10"));
      expect(nodes[2].available).to.equal(FixedPoint.from("5"));
      expect(nodes[2].used).to.equal(FixedPoint.from("5"));
      expect(nodes[2].pending).to.equal(FixedPoint.from("5.5"));
      expect(nodes[3].depth).to.equal(FixedPoint.from("15"));
      expect(nodes[3].available).to.equal(FixedPoint.from("3"));
      expect(nodes[3].used).to.equal(FixedPoint.from("2"));
      expect(nodes[3].pending).to.equal(FixedPoint.from("2.5"));

      /* Distribute to seven nodes out of nine provided */
      sources = [
        {
          depth: FixedPoint.from("1"),
          available: FixedPoint.from("30"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("5"),
          available: FixedPoint.from("20"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("10"),
          available: FixedPoint.from("10"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("15"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("20"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("25"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("30"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("35"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
        {
          depth: FixedPoint.from("40"),
          available: FixedPoint.from("5"),
          used: FixedPoint.Zero,
          pending: FixedPoint.Zero,
        },
      ];
      [nodes, count] = await interestRateModel.distribute(
        ethers.utils.parseEther("28"),
        ethers.utils.parseEther("9"),
        sources,
        sources.length
      );
      expect(count).to.equal(7);
      expect(nodes[0].depth).to.equal(FixedPoint.from("1"));
      expect(nodes[0].available).to.equal(FixedPoint.from("29"));
      expect(nodes[0].used).to.equal(FixedPoint.from("1"));
      expect(nodes[0].pending).to.equal(FixedPoint.from("2"));
      expect(nodes[1].depth).to.equal(FixedPoint.from("5"));
      expect(nodes[1].available).to.equal(FixedPoint.from("16"));
      expect(nodes[1].used).to.equal(FixedPoint.from("4"));
      expect(nodes[1].pending).to.equal(FixedPoint.from("5"));
      expect(nodes[2].depth).to.equal(FixedPoint.from("10"));
      expect(nodes[2].available).to.equal(FixedPoint.from("5"));
      expect(nodes[2].used).to.equal(FixedPoint.from("5"));
      expect(nodes[2].pending).to.equal(FixedPoint.from("6"));
      expect(nodes[3].depth).to.equal(FixedPoint.from("15"));
      expect(nodes[3].available).to.equal(FixedPoint.from("0"));
      expect(nodes[3].used).to.equal(FixedPoint.from("5"));
      expect(nodes[3].pending).to.equal(FixedPoint.from("6"));
      expect(nodes[4].depth).to.equal(FixedPoint.from("20"));
      expect(nodes[4].available).to.equal(FixedPoint.from("0"));
      expect(nodes[4].used).to.equal(FixedPoint.from("5"));
      expect(nodes[4].pending).to.equal(FixedPoint.from("6"));
      expect(nodes[5].depth).to.equal(FixedPoint.from("25"));
      expect(nodes[5].available).to.equal(FixedPoint.from("0"));
      expect(nodes[5].used).to.equal(FixedPoint.from("5"));
      expect(nodes[5].pending).to.equal(FixedPoint.from("6"));
      expect(nodes[6].depth).to.equal(FixedPoint.from("30"));
      expect(nodes[6].available).to.equal(FixedPoint.from("2"));
      expect(nodes[6].used).to.equal(FixedPoint.from("3"));
      expect(nodes[6].pending).to.equal(FixedPoint.from("6"));
    });
  });
});
