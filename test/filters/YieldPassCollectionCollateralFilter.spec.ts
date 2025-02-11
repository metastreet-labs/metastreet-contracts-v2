import { expect } from "chai";
import { ethers, network } from "hardhat";

import { YieldPassCollectionCollateralFilter } from "../../typechain";

describe("YieldPassCollectionCollateralFilter", function () {
  let collateralFilter: TestYieldPassCollectionCollateralFilter;
  let snapshotId: string;

  /* Arbitrum block ID */
  const BLOCK_ID = 303003364;

  /* Arbitrum yield pass market */
  const YIELD_PASS_MARKET = "0x24147F47B916bcF7E0a8810f859bA3bf703d436d";

  /* Arbitrum node token */
  const NODE_TOKEN = "0xC227e25544EdD261A9066932C71a25F4504972f1";

  /* Arbitrum yield pass */
  const AETHIR_YIELD_PASS = "0x70c5aD55c1A3f94D62cF9c81ad065377175Beca2";

  /* Node pass */
  const NODE_PASS = "0xDe25cE21b4f73D00D65027228D87b70A4DC15b5D";

  before("fork mainnet and deploy fixture", async function () {
    /* Skip test if no ARBITRUM_URL env variable */
    if (!process.env.ARBITRUM_URL) {
      this.skip();
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ARBITRUM_URL,
            blockNumber: BLOCK_ID,
          },
        },
      ],
    });

    const yieldPassCollectionCollateralFilterFactory = await ethers.getContractFactory(
      "TestYieldPassCollectionCollateralFilter"
    );

    collateralFilter = await yieldPassCollectionCollateralFilterFactory.deploy(YIELD_PASS_MARKET, NODE_TOKEN);
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
      expect(await collateralFilter.COLLATERAL_FILTER_NAME()).to.equal("YieldPassCollectionCollateralFilter");
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
      expect(await collateralFilter.collateralToken()).to.equal(NODE_TOKEN);
    });
    it("matches expected collateral tokens", async function () {
      expect(await collateralFilter.collateralTokens()).to.be.eql([NODE_TOKEN]);
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#collateralSupported", async function () {
    it("matches supported token", async function () {
      const context = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [AETHIR_YIELD_PASS]);

      expect(await collateralFilter.collateralSupported(NODE_PASS, 123, 0, context)).to.equal(true);

      expect(await collateralFilter.collateralSupported(NODE_TOKEN, 123, 0, context)).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 123, 0, context)
      ).to.equal(false);
    });
  });
});
