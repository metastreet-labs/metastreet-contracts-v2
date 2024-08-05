import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestExternalPriceOracle } from "../../typechain";

describe("ExternalPriceOracle", function () {
  let externalPriceOracle1: TestExternalPriceOracle;
  let externalPriceOracle2: TestExternalPriceOracle;
  let snapshotId: string;

  const COLLATERAL_TOKEN = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const CURRENCY_TOKEN = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const PRICE_ORACLE_ADDR = "0xb6c1078F6FD3E682F3C69f8f6e616476765749a7";

  before("deploy fixture", async () => {
    const externalPriceOracleFactory = await ethers.getContractFactory("TestExternalPriceOracle");

    externalPriceOracle1 = (await externalPriceOracleFactory.deploy(PRICE_ORACLE_ADDR)) as TestExternalPriceOracle;
    await externalPriceOracle1.waitForDeployment();

    externalPriceOracle2 = (await externalPriceOracleFactory.deploy(ethers.ZeroAddress)) as TestExternalPriceOracle;
    await externalPriceOracle2.waitForDeployment();
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
    it("matches price oracle storage fields", async function () {
      expect(await externalPriceOracle1.priceOracle()).to.be.equal(PRICE_ORACLE_ADDR);
      expect(await externalPriceOracle2.priceOracle()).to.be.equal(ethers.ZeroAddress);
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#price", async function () {
    it("returns 0 if price oracle address is 0", async function () {
      expect(
        await externalPriceOracle2["price(address,address,uint256[],uint256[],bytes,bytes)"](
          COLLATERAL_TOKEN,
          CURRENCY_TOKEN,
          [],
          [],
          "0x11",
          "0x"
        )
      ).to.be.equal(0);
    });
  });
});
