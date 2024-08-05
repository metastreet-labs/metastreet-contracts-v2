import { expect } from "chai";
import { ethers, network } from "hardhat";

import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { SimpleSignedPriceOracle } from "../../typechain";

describe("SimpleSignedPriceOracle", function () {
  let simpleSignedPriceOracle: SimpleSignedPriceOracle;
  let snapshotId: string;
  let accounts: SignerWithAddress[];

  /* Constants */
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const DOODLES_ADDRESS = "0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e";
  const DOODLES_ID = 1;
  const WPUNKS_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const WPUNK_ID_1 = 6887;
  const WPUNK_ID_2 = 6888;

  before("deploy fixture", async function () {
    accounts = await ethers.getSigners();

    const simpleSignedPriceOracleFactory = await ethers.getContractFactory("SimpleSignedPriceOracle");

    simpleSignedPriceOracle = (await simpleSignedPriceOracleFactory.deploy("testName")) as SimpleSignedPriceOracle;
    simpleSignedPriceOracle.waitForDeployment();
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
    it("matches price oracle implementation version", async function () {
      expect(await simpleSignedPriceOracle.IMPLEMENTATION_VERSION()).to.be.equal("1.2");
    });
  });

  /****************************************************************************/
  /* Helper functions */
  /****************************************************************************/

  const QUOTE_TYPEHASH = {
    Quote: [
      { name: "token", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "currency", type: "address" },
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint64" },
      { name: "duration", type: "uint64" },
    ],
  };

  async function createSignedQuote(
    signer: SignerWithAddress,
    token: string,
    tokenId: bigint,
    price: bigint,
    currency?: string = WETH_ADDRESS
  ) {
    const DOMAIN = {
      name: "testName" /* TBD */,
      version: "1.2" /* TBD */,
      chainId: 1,
      verifyingContract: await simpleSignedPriceOracle.getAddress(),
    };

    /* Time now */
    const timestamp = await helpers.time.latest();

    /* 5 minutes */
    const duration = 60 * 5;

    let quote = {
      token,
      tokenId,
      currency,
      price,
      timestamp,
      duration,
    };

    const signature = await signer.signTypedData(DOMAIN, QUOTE_TYPEHASH, quote);

    return [[token, tokenId, currency, price, timestamp, duration], signature];
  }

  /****************************************************************************/
  /* Admin API */
  /****************************************************************************/

  describe("#setSigner", async function () {
    it("set signer successfully", async function () {
      await simpleSignedPriceOracle.setSigner(WPUNKS_ADDRESS, accounts[0].address);
      await simpleSignedPriceOracle.setSigner(DOODLES_ADDRESS, accounts[1].address);

      expect(await simpleSignedPriceOracle.priceOracleSigner(WPUNKS_ADDRESS)).to.be.equal(accounts[0].address);
      expect(await simpleSignedPriceOracle.priceOracleSigner(DOODLES_ADDRESS)).to.be.equal(accounts[1].address);

      await simpleSignedPriceOracle.setSigner(WPUNKS_ADDRESS, ethers.ZeroAddress);
      await simpleSignedPriceOracle.setSigner(DOODLES_ADDRESS, ethers.ZeroAddress);

      expect(await simpleSignedPriceOracle.priceOracleSigner(WPUNKS_ADDRESS)).to.be.equal(ethers.ZeroAddress);
      expect(await simpleSignedPriceOracle.priceOracleSigner(DOODLES_ADDRESS)).to.be.equal(ethers.ZeroAddress);
    });

    it("fails on non-owner setting signer", async function () {
      await expect(
        simpleSignedPriceOracle.connect(accounts[1]).setSigner(WPUNKS_ADDRESS, accounts[0].address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#price", async function () {
    beforeEach("set signer for WPUNKs", async function () {
      await simpleSignedPriceOracle.setSigner(WPUNKS_ADDRESS, accounts[0].address);
    });

    it("successfully return price", async function () {
      const message_1 = await createSignedQuote(accounts[0], WPUNKS_ADDRESS, WPUNK_ID_1, ethers.parseEther("2"));
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message_1]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate for 1 collateral token ID */
      expect(
        await simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.equal(ethers.parseEther("2"));

      const message_2 = await createSignedQuote(accounts[0], WPUNKS_ADDRESS, WPUNK_ID_2, ethers.parseEther("4"));
      oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message_1, message_2]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate for 2 collateral token IDs */
      expect(
        await simpleSignedPriceOracle.price(
          WPUNKS_ADDRESS,
          WETH_ADDRESS,
          [WPUNK_ID_1, WPUNK_ID_2],
          [1, 1],
          oracleContext
        )
      ).to.be.equal(ethers.parseEther("3"));

      /* Validate for 2 collateral token IDs with quantity 2 and 3 respectively */
      expect(
        await simpleSignedPriceOracle.price(
          WPUNKS_ADDRESS,
          WETH_ADDRESS,
          [WPUNK_ID_1, WPUNK_ID_2],
          [2, 3],
          oracleContext
        )
      ).to.be.equal(ethers.parseEther("3.2"));
    });

    it("fails on invalid token", async function () {
      const message = await createSignedQuote(
        accounts[0],
        DOODLES_ADDRESS,
        WPUNK_ID_1,
        ethers.parseEther("2"),
        USDC_ADDRESS
      );
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate for invalid token */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidQuote");
    });

    it("fails on invalid token ID", async function () {
      const message = await createSignedQuote(
        accounts[0],
        WPUNKS_ADDRESS,
        WPUNK_ID_2,
        ethers.parseEther("2"),
        USDC_ADDRESS
      );
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate for invalid token ID */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidQuote");
    });

    it("fails on invalid currency", async function () {
      const message = await createSignedQuote(
        accounts[0],
        WPUNKS_ADDRESS,
        WPUNK_ID_1,
        ethers.parseEther("2"),
        USDC_ADDRESS
      );
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate for invalid currency */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidQuote");
    });

    it("fails on invalid price", async function () {
      const message = await createSignedQuote(accounts[0], WPUNKS_ADDRESS, WPUNK_ID_1, ethers.parseEther("0"));
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 6 minutes */
      await helpers.time.increase(360);

      /* Validate invalid quote */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidQuote");
    });

    it("fails on invalid timestamp", async function () {
      const message = await createSignedQuote(accounts[0], WPUNKS_ADDRESS, WPUNK_ID_1, ethers.parseEther("2"));
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 6 minutes */
      await helpers.time.increase(360);

      /* Validate invalid timestamp (expired) */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidTimestamp");
    });

    it("fails on invalid signer", async function () {
      const message_1 = await createSignedQuote(accounts[1], WPUNKS_ADDRESS, WPUNK_ID_1, ethers.parseEther("2"));
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message_1]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate invalid signature */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidSigner");

      const message_2 = await createSignedQuote(accounts[0], DOODLES_ADDRESS, DOODLES_ID, ethers.parseEther("2"));
      oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message_2]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate invalid signature */
      await expect(
        simpleSignedPriceOracle.price(DOODLES_ADDRESS, WETH_ADDRESS, [DOODLES_ID], [1], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidSigner");
    });

    it("fails on invalid length", async function () {
      const message = await createSignedQuote(accounts[0], WPUNKS_ADDRESS, WPUNK_ID_1, ethers.parseEther("2"));
      let oracleContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint256,address,uint256,uint64,uint64),bytes)[]"],
        [[message]]
      );

      /* Fast forward 30 seconds */
      await helpers.time.increase(30);

      /* Validate invalid length */
      await expect(
        simpleSignedPriceOracle.price(WPUNKS_ADDRESS, WETH_ADDRESS, [WPUNK_ID_1], [], oracleContext)
      ).to.be.revertedWithCustomError(simpleSignedPriceOracle, "InvalidLength");
    });
  });
});
