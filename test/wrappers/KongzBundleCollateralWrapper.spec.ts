import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestKongzBundleCollateralWrapper, KongzBundleCollateralWrapper } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("KongzBundleCollateralWrapper", function () {
  let accounts: SignerWithAddress[];
  let banana: TestERC20;
  let kongz: IKongz;
  let kongzBundleCollateralWrapper: KongzBundleCollateralWrapper;
  let testKongzBundleCollateralWrapper: TestKongzBundleCollateralWrapper;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  /* Constants */
  const KONGZ_ID_1 = BigInt("327");
  const KONGZ_ID_2 = BigInt("90");
  const KONGZ_ID_3 = BigInt("96");
  const KONGZ_ID_4 = BigInt("46");
  const KONGZ_ID_5 = BigInt("176");
  const KONGZ_ID_6 = BigInt("850");
  const NON_OG_KONGZ_ID = BigInt("2371");
  const KONGZ_OWNER_1 = "0x6c8ee01f1f8b62e987b3d18f6f28b22a0ada755f"; /* Holder of 18 OG KONGZ */
  const KONGZ_ADDRESS = "0x57a204AA1042f6E66DD7730813f4024114d74f37";
  const KONGZ_GENESIS_MAX_TOKEN_ID = 1000;
  const YIELDHUB_ADDRESS = "0x86CC33dBE3d2fb95bc6734e1E5920D287695215F";
  const BANANA_ADDRESS = "0x94e496474F1725f1c1824cB5BDb92d7691A4F03a";
  const BLOCK_ID = 17965920;

  before("fork mainnet and deploy fixture", async function () {
    /* Skip test if no MAINNET_URL env variable */
    if (!process.env.MAINNET_URL) {
      this.skip();
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_URL,
            blockNumber: BLOCK_ID,
          },
        },
      ],
    });

    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const kongzBundleCollateralWrapperFactory = await ethers.getContractFactory("KongzBundleCollateralWrapper");
    const testKongzBundleCollateralWrapperFactory = await ethers.getContractFactory("TestKongzBundleCollateralWrapper");

    banana = (await ethers.getContractAt("TestERC20", BANANA_ADDRESS)) as TestERC20;
    kongz = (await ethers.getContractAt("IKongz", KONGZ_ADDRESS)) as IKongz;

    kongzBundleCollateralWrapper = (await kongzBundleCollateralWrapperFactory.deploy(
      KONGZ_ADDRESS,
      BANANA_ADDRESS,
      YIELDHUB_ADDRESS,
      KONGZ_GENESIS_MAX_TOKEN_ID
    )) as KongzBundleCollateralWrapper;
    await kongzBundleCollateralWrapper.waitForDeployment();

    testKongzBundleCollateralWrapper = (await testKongzBundleCollateralWrapperFactory.deploy(
      await kongzBundleCollateralWrapper.getAddress(),
      KONGZ_ADDRESS,
      BANANA_ADDRESS,
      YIELDHUB_ADDRESS
    )) as TestKongzBundleCollateralWrapper;
    await testKongzBundleCollateralWrapper.waitForDeployment();

    accountBorrower = await ethers.getImpersonatedSigner(KONGZ_OWNER_1);

    /* Approve kongz for collateral wrapper */
    await kongz.connect(accountBorrower).setApprovalForAll(await kongzBundleCollateralWrapper.getAddress(), true);
    await kongz.connect(accountBorrower).setApprovalForAll(await testKongzBundleCollateralWrapper.getAddress(), true);
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
    it("matches expected implementation version", async function () {
      expect(await kongzBundleCollateralWrapper.IMPLEMENTATION_VERSION()).to.equal("1.1");
    });
    it("returns correct name", async function () {
      expect(await kongzBundleCollateralWrapper.name()).to.equal("MetaStreet CyberKongz Bundle Collateral Wrapper");
    });
    it("returns correct symbol", async function () {
      expect(await kongzBundleCollateralWrapper.symbol()).to.equal("MSCKBCW");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#enumerate", async function () {
    it("enumerate kongz ", async function () {
      /* Mint kongz */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_1, KONGZ_ID_2]]
      );

      /* Enumerate */
      const [token, tokenIds] = await kongzBundleCollateralWrapper.enumerate(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(KONGZ_ADDRESS);
      expect(tokenIds[0]).to.equal(KONGZ_ID_1);
      expect(tokenIds[1]).to.equal(KONGZ_ID_2);
    });
  });

  describe("#enumerateWithQuantities", async function () {
    it("enumerate kongz ", async function () {
      /* Mint kongz */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_1, KONGZ_ID_2]]
      );

      /* Enumerate */
      const [token, tokenIds, quantities] = await kongzBundleCollateralWrapper.enumerateWithQuantities(
        tokenId1,
        context
      );

      /* Validate return */
      expect(token).to.equal(KONGZ_ADDRESS);
      expect(tokenIds[0]).to.equal(KONGZ_ID_1);
      expect(tokenIds[1]).to.equal(KONGZ_ID_2);
      expect(quantities[0]).to.equal(1);
      expect(quantities[1]).to.equal(1);
    });
  });

  describe("#count", async function () {
    it("count batch", async function () {
      /* Mint kongz */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_1, KONGZ_ID_2]]
      );

      /* Enumerate */
      const count = await kongzBundleCollateralWrapper.count(tokenId1, context);

      /* Validate return */
      expect(count).to.equal(2);
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint kongz */
      await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2]);

      /* Use different token id */
      const badTokenId = BigInt("80530570786821071483259871300278421257638987008682429097249700923201294947214");

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_1, KONGZ_ID_2]]
      );

      await expect(kongzBundleCollateralWrapper.count(badTokenId, context)).to.be.revertedWithCustomError(
        kongzBundleCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  describe("#transferCalldata", async function () {
    it("transfer calldata", async function () {
      /* Get transferCalldata */
      const [target, calldata] = await kongzBundleCollateralWrapper.transferCalldata(
        KONGZ_ADDRESS,
        await accountBorrower.getAddress(),
        accounts[0].address,
        KONGZ_ID_1,
        0
      );

      const tx = {
        to: target,
        data: calldata,
      };

      await accountBorrower.sendTransaction(tx);

      /* Validate return */
      const owner = await kongz.ownerOf(KONGZ_ID_1);
      expect(owner).to.equal(accounts[0].address);
    });
  });

  describe("#mint", async function () {
    it("mints kongz ", async function () {
      /* Mint kongz */
      const mintTx1 = await kongzBundleCollateralWrapper
        .connect(accountBorrower)
        .mint([KONGZ_ID_1, KONGZ_ID_2, KONGZ_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const kongzData = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_1, KONGZ_ID_2, KONGZ_ID_3]]
      );

      /* Validate encoded bundle */
      expect(kongzData).to.equal(context);

      /* Validate events */
      await expectEvent(mintTx1, kongzBundleCollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: tokenId1,
      });

      await expectEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted", {
        tokenId: tokenId1,
        account: await accountBorrower.getAddress(),
      });

      /* Validate state */
      expect(await kongzBundleCollateralWrapper.exists(tokenId1)).to.equal(true);
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      expect(await kongz.ownerOf(KONGZ_ID_1)).to.equal(await kongzBundleCollateralWrapper.getAddress());
      expect(await kongz.ownerOf(KONGZ_ID_2)).to.equal(await kongzBundleCollateralWrapper.getAddress());
      expect(await kongz.ownerOf(KONGZ_ID_3)).to.equal(await kongzBundleCollateralWrapper.getAddress());
    });

    it("can transfer KongzBundleCollateralWrapperToken", async function () {
      /* Mint bundle */
      const mintTx1 = await kongzBundleCollateralWrapper
        .connect(accountBorrower)
        .mint([KONGZ_ID_1, KONGZ_ID_2, KONGZ_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate owner */
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      /* Transfer token */
      await kongzBundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(await accountBorrower.getAddress(), accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on not owner of nft", async function () {
      await expect(kongzBundleCollateralWrapper.connect(accountBorrower).mint([2, KONGZ_ID_1])).to.be.reverted;
      await expect(kongzBundleCollateralWrapper.connect(accounts[0]).mint([KONGZ_ID_1, KONGZ_ID_2])).to.be.reverted;
    });

    it("fails on minting same kongz twice", async function () {
      /* Mint bundle */
      await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2, KONGZ_ID_3]);

      await expect(kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, KONGZ_ID_2, KONGZ_ID_3])).to
        .be.reverted;
    });

    it("fails on ineligible token ID", async function () {
      await expect(
        kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_1, NON_OG_KONGZ_ID])
      ).to.be.revertedWithCustomError(kongzBundleCollateralWrapper, "InvalidTokenId");
      await expect(
        kongzBundleCollateralWrapper.connect(accountBorrower).mint([NON_OG_KONGZ_ID])
      ).to.be.revertedWithCustomError(kongzBundleCollateralWrapper, "InvalidTokenId");
    });
  });

  describe("#unwrap", async function () {
    let context: string;
    let tokenId: bigint;
    let kongzData: string;

    beforeEach("transfer control token IDs and mint bundle", async function () {
      const mintTx = await testKongzBundleCollateralWrapper
        .connect(accountBorrower)
        .mint([KONGZ_ID_1, KONGZ_ID_2] /* Control */, [KONGZ_ID_3, KONGZ_ID_4] /* To mint bundle */);

      /* Get token id and data */
      tokenId = (await extractEvent(mintTx, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;
      kongzData = (await extractEvent(mintTx, kongzBundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

      /* Create context */
      context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await testKongzBundleCollateralWrapper.getAddress(), [KONGZ_ID_3, KONGZ_ID_4]]
      );
    });

    it("unwrap kongz after 1 seconds", async function () {
      /* Validate encoded bundle */
      expect(kongzData).to.equal(context);

      /* Validate current owner */
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId)).to.equal(
        await testKongzBundleCollateralWrapper.getAddress()
      );

      /* Fast forward one second */
      await helpers.time.increase(1);

      /* Unwrap and validate events */
      await testKongzBundleCollateralWrapper.unwrap(tokenId, context);

      expect(await kongzBundleCollateralWrapper.exists(tokenId)).to.equal(false);

      expect(await kongz.ownerOf(KONGZ_ID_1)).to.equal(await testKongzBundleCollateralWrapper.getAddress());
      expect(await kongz.ownerOf(KONGZ_ID_2)).to.equal(await testKongzBundleCollateralWrapper.getAddress());
    });

    it("unwrap kongz after 3 years", async function () {
      /* Validate encoded bundle */
      expect(kongzData).to.equal(context);

      /* Validate current owner */
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId)).to.equal(
        await testKongzBundleCollateralWrapper.getAddress()
      );

      /* Fast forward 1095 days */
      await helpers.time.increase(1095 * 24 * 60 * 60);

      /* Unwrap and validate events */
      await testKongzBundleCollateralWrapper.unwrap(tokenId, context);

      expect(await kongzBundleCollateralWrapper.exists(tokenId)).to.equal(false);

      expect(await kongz.ownerOf(KONGZ_ID_1)).to.equal(await testKongzBundleCollateralWrapper.getAddress());
      expect(await kongz.ownerOf(KONGZ_ID_2)).to.equal(await testKongzBundleCollateralWrapper.getAddress());
    });

    it("only token holder can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5, KONGZ_ID_6]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_5, KONGZ_ID_6]]
      );

      /* Validate current owner */
      expect(await kongzBundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      /* Attempt to unwrap */
      await expect(
        kongzBundleCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context)
      ).to.be.revertedWithCustomError(kongzBundleCollateralWrapper, "InvalidCaller");

      await expect(kongzBundleCollateralWrapper.unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        kongzBundleCollateralWrapper,
        "InvalidCaller"
      );
    });

    it("rewards go to minter after collateral token is transfered and unwrapped", async function () {
      /* Mint bundle */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5, KONGZ_ID_6]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_5, KONGZ_ID_6]]
      );

      /* Transfer bundle collateral token */
      await kongzBundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(await accountBorrower.getAddress(), accounts[0].address, tokenId1);

      /* Fast forward 12 hours */
      await helpers.time.increase(12 * 60 * 60);

      /* Get balance before */
      const balanceOfMinterBefore = await banana.balanceOf(await accountBorrower.getAddress());

      await kongzBundleCollateralWrapper.connect(accounts[0]).unwrap(tokenId1, context);

      /* Get balance after */
      const balanceOfMinterAfter = await banana.balanceOf(await accountBorrower.getAddress());
      const balanceOfOwnerAfter = await banana.balanceOf(accounts[0].address);

      /* Validate balances */
      expect(balanceOfMinterAfter - balanceOfMinterBefore).to.not.equal(0);
      expect(balanceOfOwnerAfter).to.equal(0);
    });
  });

  describe("#claim and claimable", async function () {
    let context: string;
    let tokenId: bigint;

    beforeEach("transfer control token IDs and mint bundle", async function () {
      const mintTx = await testKongzBundleCollateralWrapper
        .connect(accountBorrower)
        .mint([KONGZ_ID_1, KONGZ_ID_2] /* Control */, [KONGZ_ID_3, KONGZ_ID_4] /* To mint bundle */);

      /* Get token id */
      tokenId = (await extractEvent(mintTx, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await testKongzBundleCollateralWrapper.getAddress(), [KONGZ_ID_3, KONGZ_ID_4]]
      );
    });

    it("claim bananas after one second", async function () {
      /* Fast forward one second */
      await helpers.time.increase(1);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 12 hours", async function () {
      /* Fast forward 12 hours */
      await helpers.time.increase(12 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 1 day", async function () {
      /* Fast forward 1 day */
      await helpers.time.increase(24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 30 days", async function () {
      /* Fast forward 30 days */
      await helpers.time.increase(30 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 3 years", async function () {
      /* Fast forward 1095 days */
      await helpers.time.increase(1095 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after transfer bundle token", async function () {
      /* Mint bundle */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5, KONGZ_ID_6]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_5, KONGZ_ID_6]]
      );

      await kongzBundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(await accountBorrower.getAddress(), accounts[0].address, tokenId1);

      /* Fast forward 1095 days */
      await helpers.time.increase(1095 * 24 * 60 * 60);

      await kongzBundleCollateralWrapper.claim(tokenId1, context);
    });

    it("claim bananas after 1 day and 30 days", async function () {
      /* Fast forward 1 day */
      await helpers.time.increase(24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);

      /* Fast forward 29 days */
      await helpers.time.increase(29 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 15 days and 30 days", async function () {
      /* Fast forward 15 days */
      await helpers.time.increase(15 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);

      /* Fast forward 15 days */
      await helpers.time.increase(15 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 1 day and 30 days with new mints in between", async function () {
      /* Fast forward 1 day */
      await helpers.time.increase(24 * 60 * 60);

      /* New mint */
      await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5]);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);

      /* New mint */
      await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_6]);

      /* Fast forward 29 days */
      await helpers.time.increase(29 * 24 * 60 * 60);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 1 day and 30 days with new mints and separate claims in between", async function () {
      /* Fast forward 1 day */
      await helpers.time.increase(24 * 60 * 60);

      /* New mint */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5]);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context1 = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_5]]
      );

      /* Separate claim */
      await kongzBundleCollateralWrapper.connect(accountBorrower).claim(tokenId1, context1);

      /* New mint */
      const mintTx2 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_6]);

      /* Fast forward 29 days */
      await helpers.time.increase(29 * 24 * 60 * 60);

      /* Get token id */
      const tokenId2 = (await extractEvent(mintTx2, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context2 = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_6]]
      );

      /* Separate claim */
      await kongzBundleCollateralWrapper.connect(accountBorrower).claim(tokenId1, context1);
      await kongzBundleCollateralWrapper.connect(accountBorrower).claim(tokenId2, context2);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim bananas after 1 day and 30 days with new mints and separate unwraps in between", async function () {
      /* Fast forward 1 day */
      await helpers.time.increase(24 * 60 * 60);

      /* New mint */
      const mintTx1 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_5]);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context1 = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_5]]
      );

      /* New mint */
      const mintTx2 = await kongzBundleCollateralWrapper.connect(accountBorrower).mint([KONGZ_ID_6]);

      /* Fast forward 29 days */
      await helpers.time.increase(29 * 24 * 60 * 60);

      /* Get token id */
      const tokenId2 = (await extractEvent(mintTx2, kongzBundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context2 = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await accountBorrower.getAddress(), [KONGZ_ID_6]]
      );

      /* Separate unwraps */
      await kongzBundleCollateralWrapper.connect(accountBorrower).unwrap(tokenId1, context1);
      await kongzBundleCollateralWrapper.connect(accountBorrower).unwrap(tokenId2, context2);

      await testKongzBundleCollateralWrapper.claim(tokenId, context);
    });

    it("claim fails after unwrap", async function () {
      /* Unwrap and validate events */
      await testKongzBundleCollateralWrapper.unwrap(tokenId, context);

      /* Token does not exists */
      await expect(kongzBundleCollateralWrapper.claim(tokenId, context)).to.be.revertedWithCustomError(
        kongzBundleCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(
        await kongzBundleCollateralWrapper.supportsInterface(ethers.id("supportsInterface(bytes4)").substring(0, 10))
      ).to.equal(true);

      /* ICollateralWrapper */
      expect(
        await kongzBundleCollateralWrapper.supportsInterface(
          ethers.toBeHex(
            BigInt(ethers.id("name()").substring(0, 10)) ^
              BigInt(ethers.id("unwrap(uint256,bytes)").substring(0, 10)) ^
              BigInt(ethers.id("enumerate(uint256,bytes)").substring(0, 10)) ^
              BigInt(ethers.id("count(uint256,bytes)").substring(0, 10)) ^
              BigInt(ethers.id("enumerateWithQuantities(uint256,bytes)").substring(0, 10)) ^
              BigInt(ethers.id("transferCalldata(address,address,address,uint256,uint256)").substring(0, 10))
          )
        )
      ).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await kongzBundleCollateralWrapper.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await kongzBundleCollateralWrapper.supportsInterface("0x00000000")).to.equal(false);
        expect(await kongzBundleCollateralWrapper.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
