import { expect } from "chai";
import { ethers, network } from "hardhat";

import { CollectionCollateralFilter } from "../../typechain";

describe("CollectionCollateralFilter", function () {
  let collateralFilter: TestCollectionCollateralFilter;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const collectionCollateralFilterFactory = await ethers.getContractFactory("TestCollectionCollateralFilter");

    collateralFilter = await collectionCollateralFilterFactory.deploy("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b");
    await collateralFilter.deployed();
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
      expect(await collateralFilter.COLLATERAL_FILTER_NAME()).to.equal("CollectionCollateralFilter");
    });
    it("matches expected implementation version", async function () {
      expect(await collateralFilter.COLLATERAL_FILTER_VERSION()).to.equal("1.0");
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("#collateralToken", async function () {
    it("matches expected collateral token", async function () {
      expect(await collateralFilter.collateralToken()).to.equal("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#collateralSupported", async function () {
    it("matches supported token", async function () {
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 123, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 456, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 123, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 456, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 123, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 456, "0x")
      ).to.equal(false);
    });
  });
});
