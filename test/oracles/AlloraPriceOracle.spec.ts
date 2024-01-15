import { expect } from "chai";
import { ethers, network } from "hardhat";
import { AlloraPriceOracle } from "../../typechain";

/* Requires chain ID to be set to 11155111 for hardhat in hardhat.config.ts */
describe.skip("AlloraPriceOracle", function () {
  let alloraPriceOracle: AlloraPriceOracle;
  let snapshotId: string;

  /* API Response for Watches (NFT ID: 23) */
  const data = {
    request_id: "8557fa1c-77d2-4744-a3c5-2ffce8b4956b",
    status: true,
    data: {
      signature:
        "0x286b85a22c8f0d4340be53e9ab241357bd8fd3939ec8c72b0bf5d02cd123277569917f80f430cff697d52474703ac71dfa31d3807a65785310704f66434fef061c",
      numeric_data: {
        topic_id: "4",
        numeric_values: ["13444395688084593000000"],
        timestamp: 1709116612,
        extra_data: "0x8730b88d28d6a481b2f0db59b73b83963bc5323cd009a27cf98e8b23203cf985",
      },
    },
  };
  const ALLORA_ADAPTER_NUMERIC_DATA = [
    data.data.signature,
    [
      ethers.BigNumber.from(data.data.numeric_data.topic_id),
      ethers.BigNumber.from(data.data.numeric_data.timestamp),
      data.data.numeric_data.extra_data,
      [ethers.BigNumber.from(data.data.numeric_data.numeric_values[0])],
    ],
    "0x",
  ];

  /* Invalid timestamp */
  const ALLORA_ADAPTER_NUMERIC_DATA_INVALID_TIMESTAMP = [
    data.data.signature,
    [
      ethers.BigNumber.from(data.data.numeric_data.topic_id),
      ethers.BigNumber.from(data.data.numeric_data.timestamp - 7200),
      data.data.numeric_data.extra_data,
      [ethers.BigNumber.from(data.data.numeric_data.numeric_values[0])],
    ],
    "0x",
  ];

  /* Invalid signature */
  const ALLORA_ADAPTER_NUMERIC_DATA_INVALID_SIGNATURE = [
    "0xdc3152b069249ade16d6e98dd5078c99d88999acee56558e746ddf4a9490e1ec322584b805d1dba4c2a3979fa7faf5e7176a0e2368900a6e2ed4f358111fd4ad1b",
    [
      ethers.BigNumber.from(data.data.numeric_data.topic_id),
      ethers.BigNumber.from(data.data.numeric_data.timestamp - 7200),
      data.data.numeric_data.extra_data,
      [ethers.BigNumber.from(data.data.numeric_data.numeric_values[0])],
    ],
    "0x",
  ];

  /* Invalid topic ID */
  const ALLORA_ADAPTER_NUMERIC_DATA_INVALID_TOPIC_ID = [
    data.data.signature,
    [
      ethers.BigNumber.from("0"),
      ethers.BigNumber.from(data.data.numeric_data.timestamp),
      data.data.numeric_data.extra_data,
      [ethers.BigNumber.from(data.data.numeric_data.numeric_values[0])],
    ],
    "0x",
  ];

  /* Constants */
  const WATCHES_ID = ethers.BigNumber.from("23");
  const WATCHES_ADDRESS = "0x75F9F22D1070fDd56bD1DDF2DB4d65aB0F759431";
  const USDT_ADDRESS = "0xA1d7f71cbBb361A77820279958BAC38fC3667c1a";
  const ALLORA_ADAPTER_ADDRESS = "0xBEd9F9B7509288fCfe4d49F761C625C832e6264A";
  const TOPIC_ID = 4;
  const BLOCK_ID = 5380190;

  before("deploy fixture", async function () {
    /* Skip test if no SEPOLIA_URL env variable */
    if (!process.env.SEPOLIA_URL) {
      this.skip();
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.SEPOLIA_URL,
            blockNumber: BLOCK_ID,
          },
        },
      ],
    });

    const alloraPriceOracleFactory = await ethers.getContractFactory("AlloraPriceOracle");

    alloraPriceOracle = (await alloraPriceOracleFactory.deploy(
      ALLORA_ADAPTER_ADDRESS,
      TOPIC_ID,
      18,
      USDT_ADDRESS
    )) as AlloraPriceOracle;
    alloraPriceOracle.deployed();
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
      expect(await alloraPriceOracle.ALLORA_API_VERSION()).to.be.equal("v1");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#price", async function () {
    it("successfully return price of one watch", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      expect(
        await alloraPriceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [WATCHES_ID], [1], encodedNumericData)
      ).to.be.equal("13444395688");
    });

    it("successfully return price of two watches", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA, ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      expect(
        await alloraPriceOracle.price(
          WATCHES_ADDRESS,
          USDT_ADDRESS,
          [WATCHES_ID, WATCHES_ID],
          [1, 1],
          encodedNumericData
        )
      ).to.be.equal("13444395688");
    });

    it("fails on invalid collateral token ID", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA]]
      );

      await expect(
        alloraPriceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [1], [], encodedNumericData)
      ).to.be.revertedWithCustomError(alloraPriceOracle, "InvalidData");
    });

    it("fails on invalid timestamp", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA_INVALID_TIMESTAMP]]
      );

      await expect(alloraPriceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [WATCHES_ID], [], encodedNumericData)).to.be
        .reverted;
    });

    it("fails on invalid signature", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA_INVALID_SIGNATURE]]
      );

      await expect(alloraPriceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [WATCHES_ID], [], encodedNumericData)).to.be
        .reverted;
    });

    it("fails on invalid topic ID", async function () {
      /* Encode numeric data as a bytes array */
      const encodedNumericData = ethers.utils.defaultAbiCoder.encode(
        ["(bytes,(uint256,uint256,bytes,uint256[]),bytes)[]"],
        [[ALLORA_ADAPTER_NUMERIC_DATA_INVALID_TOPIC_ID]]
      );

      await expect(
        alloraPriceOracle.price(WATCHES_ADDRESS, USDT_ADDRESS, [WATCHES_ID], [], encodedNumericData)
      ).to.be.revertedWithCustomError(alloraPriceOracle, "InvalidData");
    });
  });
});
