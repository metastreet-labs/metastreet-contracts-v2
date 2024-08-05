import { expect } from "chai";
import { ethers, network } from "hardhat";

describe("SetCollectionCollateralFilter", function () {
  let collateralFilter: TestSetCollectionCollateralFilter;
  let snapshotId: string;

  before("deploy fixture", async () => {
    const setCollectionCollateralFilterFactory = await ethers.getContractFactory("TestSetCollectionCollateralFilter");

    collateralFilter = await setCollectionCollateralFilterFactory.deploy(
      "0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b",
      [123, 124, 125]
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
      expect(await collateralFilter.COLLATERAL_FILTER_NAME()).to.equal("SetCollectionCollateralFilter");
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

  describe("#collateralTokenIds", async function () {
    it("matches expected collateral token IDs", async function () {
      const tokenIds = await collateralFilter.collateralTokenIds();
      expect(tokenIds[0]).to.equal(123);
      expect(tokenIds[1]).to.equal(124);
      expect(tokenIds[2]).to.equal(125);
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
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 124, 1, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 125, 2, "0x")
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 122, 2, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 126, 2, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 123, 0, "0x")
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x822CB8a23b42Cf37DE879C382BCdA5E20D5764B7", 456, 0, "0x")
      ).to.equal(false);
    });
  });
});
