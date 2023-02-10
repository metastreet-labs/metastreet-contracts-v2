import { expect } from "chai";
import { ethers, network } from "hardhat";

import { CollectionCollateralFilter } from "../../typechain";

describe("CollectionCollateralFilter", function () {
  let collateralFilter: CollectionCollateralFilter;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const collectionCollateralFilterFactory = await ethers.getContractFactory("CollectionCollateralFilter");

    collateralFilter = await collectionCollateralFilterFactory.deploy("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b");
    await collateralFilter.deployed();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected name", async function () {
      expect(await collateralFilter.name()).to.equal("CollectionCollateralFilter");
    });
  });

  describe("#tokens", async function () {
    it("matches expected token list", async function () {
      expect(await collateralFilter.tokens()).to.deep.equal(["0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b"]);
    });
  });

  describe("#supported", async function () {
    it("matches supported token", async function () {
      expect(await collateralFilter.supported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 123, "0x")).to.equal(true);
      expect(await collateralFilter.supported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 456, "0x")).to.equal(true);
      expect(await collateralFilter.supported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 123, "0x")).to.equal(false);
      expect(await collateralFilter.supported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 456, "0x")).to.equal(false);
      expect(await collateralFilter.supported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 123, "0x")).to.equal(false);
      expect(await collateralFilter.supported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 456, "0x")).to.equal(false);
    });
  });
});
