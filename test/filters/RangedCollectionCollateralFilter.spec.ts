import { expect } from "chai";
import { ethers, network } from "hardhat";

import { CollectionCollateralFilter } from "../../typechain";

describe("RangedCollectionCollateralFilter", function () {
  let collateralFilter: TestCollectionCollateralFilter;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const rangedCollectionCollateralFilterFactory = await ethers.getContractFactory(
      "TestRangedCollectionCollateralFilter"
    );

    collateralFilter = await rangedCollectionCollateralFilterFactory.deploy(
      "0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b",
      123,
      125
    );
    await collateralFilter.waitForDeployment();
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
      expect(await collateralFilter.COLLATERAL_FILTER_NAME()).to.equal("RangedCollectionCollateralFilter");
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
    it("matches expected collateral tokens", async function () {
      expect(await collateralFilter.collateralTokens()).to.be.eql(["0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b"]);
    });
  });

  describe("#collateralTokenIdRange", async function () {
    it("matches expected collateral token ID range", async function () {
      const range = await collateralFilter.collateralTokenIdRange();
      expect(range[0]).to.equal(123);
      expect(range[1]).to.equal(125);
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#collateralSupported", async function () {
    it("matches supported token", async function () {
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 123, 0, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 124, 0, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 125, 0, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 122, 0, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 126, 0, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 123, 0, "0x")
      ).to.equal(false);
    });
  });
});
