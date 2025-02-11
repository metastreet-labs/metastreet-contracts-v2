import { expect } from "chai";
import { ethers, network } from "hardhat";

import { ChainlinkPriceOracle } from "../../typechain";
import { FixedPoint } from "../helpers/FixedPoint";

import * as helpers from "@nomicfoundation/hardhat-network-helpers";

describe("ChainlinkPriceOracle", function () {
  let chainlinkPriceOracle: ChainlinkPriceOracle;
  let snapshotId: string;

  /* Constants */
  const GOLD_ADDRESS = "0xa8Ad11288687Bf0B4133AD5c07AdAF2C06AeC3a2";
  const SWARM_PRICE_ORACLE_ADDRESS = "0x0a103eE32F4209926D8ba7e528AFf8a831Ed3daE";
  const USDC_PRICE_ORACLE_ADDRESS = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B";
  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  before("deploy fixture", async function () {
    // /* Skip test if no MAINNET_URL env variable */
    // if (!process.env.BASE_URL) {
    //   this.skip();
    // }

    // await network.provider.request({
    //   method: "hardhat_reset",
    //   params: [
    //     {
    //       forking: {
    //         jsonRpcUrl: process.env.BASE_URL,
    //         blockNumber: 23655232,
    //       },
    //     },
    //   ],
    // });
    await helpers.mine();

    const chainlinkPriceOracleFactory = await ethers.getContractFactory("ChainlinkPriceOracle");

    const swarmPriceOracle = await ethers.getContractAt("AggregatorV3Interface", SWARM_PRICE_ORACLE_ADDRESS);
    const quote = await swarmPriceOracle.latestRoundData();
    console.log("quote:", quote);
    const decimals = await swarmPriceOracle.decimals();
    console.log("decimals:", decimals);

    chainlinkPriceOracle = (await chainlinkPriceOracleFactory.deploy(
      SWARM_PRICE_ORACLE_ADDRESS,
      USDC_PRICE_ORACLE_ADDRESS
    )) as ChainlinkPriceOracle;
    chainlinkPriceOracle.waitForDeployment();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#price", async function () {
    it("successfully return price", async function () {
      expect(await chainlinkPriceOracle.price(GOLD_ADDRESS, USDC_ADDRESS, [], [], "0x")).to.be.equal(
        FixedPoint.from("55.25")
      );
    });
  });
});
