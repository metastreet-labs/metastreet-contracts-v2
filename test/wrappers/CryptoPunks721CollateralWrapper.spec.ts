import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, ICryptoPunksMarket, CryptoPunks721CollateralWrapper, ICryptoPunks721 } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";
import { FixedPoint } from "../helpers/FixedPoint";

describe("CryptoPunks721CollateralWrapper", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let cryptoPunksMarket: ICryptoPunksMarket;
  let cryptoPunks721: ICryptoPunks721;
  let cryptoPunks721CollateralWrapper: CryptoPunks721CollateralWrapper;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;
  let pool: SignerWithAddress;
  let liquidator: SignerWithAddress;

  /* Constants */
  const PUNK_ID_1 = ethers.BigNumber.from("241");
  const PUNK_ID_2 = ethers.BigNumber.from("344");
  const PUNK_ID_3 = ethers.BigNumber.from("706");
  const PUNK_OWNER = "0x31a5Ff62A1B2C0f030AeE1661eAB6513ae676e23";
  const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
  const WPUNKS_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const CRYPTOPUNKS721_ADDRESS = "0x00000000000000343662D3FAD10D154530C0d4F1";
  const BLOCK_ID = 18835886;

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
    const cryptoPunks721CollateralWrapperFactory = await ethers.getContractFactory("CryptoPunks721CollateralWrapper");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    cryptoPunksMarket = (await ethers.getContractAt("ICryptoPunksMarket", PUNKS_ADDRESS)) as ICryptoPunksMarket;

    cryptoPunks721 = (await ethers.getContractAt("ICryptoPunks721", CRYPTOPUNKS721_ADDRESS)) as ICryptoPunks721;

    pool = accounts[1];
    liquidator = accounts[2];

    cryptoPunks721CollateralWrapper = (await cryptoPunks721CollateralWrapperFactory.deploy(
      pool.address,
      liquidator.address,
      CRYPTOPUNKS721_ADDRESS,
      WPUNKS_ADDRESS
    )) as CryptoPunks721CollateralWrapper;
    await cryptoPunks721CollateralWrapper.deployed();

    accountBorrower = await ethers.getImpersonatedSigner(PUNK_OWNER);

    /* Get borrower's stash address */
    const borrowerStash = await cryptoPunks721.punkProxyForUser(accountBorrower.address);

    /* Transfer some ether to account borrower */
    const transaction = {
      to: accountBorrower.address,
      value: FixedPoint.from("2"),
    };
    await accounts[0].sendTransaction(transaction);

    /* Transfer NFTs to stash */
    await cryptoPunksMarket.connect(accountBorrower).transferPunk(borrowerStash, PUNK_ID_1);
    await cryptoPunksMarket.connect(accountBorrower).transferPunk(borrowerStash, PUNK_ID_2);
    await cryptoPunksMarket.connect(accountBorrower).transferPunk(borrowerStash, PUNK_ID_3);

    /* Set approval */
    await cryptoPunks721.connect(accountBorrower).setApprovalForAll(cryptoPunks721CollateralWrapper.address, true);

    /* Wrap punks */
    await cryptoPunks721.connect(accountBorrower).wrapPunkBatch([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);
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
      expect(await cryptoPunks721CollateralWrapper.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("returns correct name", async function () {
      expect(await cryptoPunks721CollateralWrapper.name()).to.equal("MetaStreet CryptoPunks721 Collateral Wrapper");
    });
    it("returns correct symbol", async function () {
      expect(await cryptoPunks721CollateralWrapper.symbol()).to.equal("MSCP721CW");
    });
  });

  /****************************************************************************/
  /* Helper API */
  /****************************************************************************/

  function encodeTokenId(tokenIds: ethers.BigNumber[]) {
    if (tokenIds.length > 16) {
      throw new Error("Maximum 16 token IDs");
    }

    /* Create padding */
    const padding = new Array(16 - tokenIds.length).fill(ethers.BigNumber.from("65535"));

    /* Prepend with type(uint16).max */
    tokenIds = tokenIds.concat(padding);

    /* Reverse token IDs */
    tokenIds.reverse();

    let types = new Array(16).fill("uint16");

    return ethers.utils.solidityPack(types, tokenIds);
  }

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#enumerate", async function () {
    it("enumerate punk", async function () {
      const encodedTokenId = encodeTokenId([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      /* Enumerate */
      const [token, tokenIds] = await cryptoPunks721CollateralWrapper.enumerate(encodedTokenId, "0x");

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds.length).to.equal(16);
      for (let i = 0; i < 16; i++) {
        expect(tokenIds[i]).to.equal(i);
      }
    });

    it("enumerate punk with one invalid token ID at the end", async function () {
      /* With invalid token ID: 10000 */
      const encodedTokenId = encodeTokenId([0, 1, 2, 10000]);

      /* Enumerate */
      const [token, tokenIds] = await cryptoPunks721CollateralWrapper.enumerate(encodedTokenId, "0x");

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds.length).to.equal(3);
      for (let i = 0; i < 3; i++) {
        expect(tokenIds[i]).to.equal(i);
      }
    });

    it("enumerate punk with one invalid token ID at the start", async function () {
      /* With invalid token ID: 10000 */
      const encodedTokenId = encodeTokenId([10000, 0, 1, 2]);

      /* Enumerate */
      const [token, tokenIds] = await cryptoPunks721CollateralWrapper.enumerate(encodedTokenId, "0x");

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds.length).to.equal(0);
    });
  });

  describe("#enumerateWithQuantities", async function () {
    it("enumerate punk with quantities", async function () {
      const encodedTokenId = encodeTokenId([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      /* Enumerate */
      const [token, tokenIds, quantities] = await cryptoPunks721CollateralWrapper.enumerateWithQuantities(
        encodedTokenId,
        "0x"
      );

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds.length).to.equal(16);
      for (let i = 0; i < 16; i++) {
        expect(tokenIds[i]).to.equal(i);
        expect(quantities[i]).to.equal(1);
      }
    });
  });

  describe("#count", async function () {
    it("count batch", async function () {
      const encodedTokenId = encodeTokenId([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      /* Count */
      const count = await cryptoPunks721CollateralWrapper.count(encodedTokenId, "0x");

      /* Validate return */
      expect(count).to.equal(16);
    });
  });

  describe("#transferCalldata", async function () {
    it("transfer calldata", async function () {
      /* Get transferCalldata */
      const [target, calldata] = await cryptoPunks721CollateralWrapper.transferCalldata(
        WPUNKS_ADDRESS,
        accountBorrower.address,
        accounts[0].address,
        PUNK_ID_1,
        0
      );

      const tx = {
        to: target,
        data: calldata,
      };

      await accountBorrower.sendTransaction(tx);

      /* Validate return */
      const owner = await cryptoPunks721.ownerOf(PUNK_ID_1);
      expect(owner).to.equal(accounts[0].address);
    });
  });

  describe("#transferFrom", async function () {
    it("transfer from for 2 punks called from pool", async function () {
      const encodedTokenId = encodeTokenId([PUNK_ID_1, PUNK_ID_2]);

      /* Get transferCalldata */
      const transferFromTx = await cryptoPunks721CollateralWrapper
        .connect(pool)
        .transferFrom(accountBorrower.address, pool.address, encodedTokenId);

      await expectEvent(
        transferFromTx,
        cryptoPunks721,
        "Transfer",
        {
          from: accountBorrower.address,
          to: cryptoPunks721CollateralWrapper.address,
          tokenId: PUNK_ID_1,
        },
        0
      );

      await expectEvent(
        transferFromTx,
        cryptoPunks721,
        "Transfer",
        {
          from: accountBorrower.address,
          to: cryptoPunks721CollateralWrapper.address,
          tokenId: PUNK_ID_2,
        },
        1
      );

      /* Validate return */
      const owner1 = await cryptoPunks721.ownerOf(PUNK_ID_1);
      const owner2 = await cryptoPunks721.ownerOf(PUNK_ID_2);
      expect(owner1).to.equal(cryptoPunks721CollateralWrapper.address);
      expect(owner2).to.equal(cryptoPunks721CollateralWrapper.address);
    });

    it("transfer from for 2 punks called from liquidator", async function () {
      const encodedTokenId = encodeTokenId([PUNK_ID_1, PUNK_ID_2]);

      /* Get transferCalldata */
      const transferFromTx = await cryptoPunks721CollateralWrapper
        .connect(liquidator)
        .transferFrom(accountBorrower.address, liquidator.address, encodedTokenId);

      await expectEvent(
        transferFromTx,
        cryptoPunks721,
        "Transfer",
        {
          from: accountBorrower.address,
          to: liquidator.address,
          tokenId: PUNK_ID_1,
        },
        0
      );

      await expectEvent(
        transferFromTx,
        cryptoPunks721,
        "Transfer",
        {
          from: accountBorrower.address,
          to: liquidator.address,
          tokenId: PUNK_ID_2,
        },
        1
      );

      /* Validate return */
      const owner1 = await cryptoPunks721.ownerOf(PUNK_ID_1);
      const owner2 = await cryptoPunks721.ownerOf(PUNK_ID_2);
      expect(owner1).to.equal(liquidator.address);
      expect(owner2).to.equal(liquidator.address);
    });

    it("transfer from for 2 punks with invalid token ID at the end", async function () {
      const encodedTokenId = encodeTokenId([PUNK_ID_1, 10000]);

      /* Get transferCalldata */
      const transferFromTx = await cryptoPunks721CollateralWrapper
        .connect(pool)
        .transferFrom(accountBorrower.address, pool.address, encodedTokenId);

      await expectEvent(
        transferFromTx,
        cryptoPunks721,
        "Transfer",
        {
          from: accountBorrower.address,
          to: cryptoPunks721CollateralWrapper.address,
          tokenId: PUNK_ID_1,
        },
        0
      );

      /* Validate return */
      const owner1 = await cryptoPunks721.ownerOf(PUNK_ID_1);
      expect(owner1).to.equal(cryptoPunks721CollateralWrapper.address);
    });

    it("transfer from for 2 punks with 1 invalid token IDs at the start", async function () {
      const encodedTokenId = encodeTokenId([10000, PUNK_ID_2]);

      await expect(
        cryptoPunks721CollateralWrapper
          .connect(pool)
          .transferFrom(accountBorrower.address, pool.address, encodedTokenId)
      ).to.be.revertedWithCustomError(cryptoPunks721CollateralWrapper, "InvalidEncoding");
    });

    it("fails on unapproved punk", async function () {
      const encodedTokenId = encodeTokenId([10]);

      await expect(
        cryptoPunks721CollateralWrapper
          .connect(pool)
          .transferFrom(accountBorrower.address, pool.address, encodedTokenId)
      ).to.be.reverted;
    });

    it("fails on called by neither pool nor liquidator", async function () {
      const encodedTokenId = encodeTokenId([PUNK_ID_1, PUNK_ID_2]);

      await expect(
        cryptoPunks721CollateralWrapper.transferFrom(accountBorrower.address, pool.address, encodedTokenId)
      ).to.be.revertedWithCustomError(cryptoPunks721CollateralWrapper, "InvalidCaller");
    });
  });

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(
        await cryptoPunks721CollateralWrapper.supportsInterface(
          cryptoPunks721CollateralWrapper.interface.getSighash("supportsInterface")
        )
      ).to.equal(true);

      /* ICollateralWrapper */
      expect(
        await cryptoPunks721CollateralWrapper.supportsInterface(
          ethers.utils.hexlify(
            ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("name"))
              .xor(ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("unwrap")))
              .xor(ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("enumerate")))
              .xor(ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("count")))
              .xor(
                ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("enumerateWithQuantities"))
              )
              .xor(ethers.BigNumber.from(cryptoPunks721CollateralWrapper.interface.getSighash("transferCalldata")))
          )
        )
      ).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await cryptoPunks721CollateralWrapper.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await cryptoPunks721CollateralWrapper.supportsInterface("0x00000000")).to.equal(false);
        expect(await cryptoPunks721CollateralWrapper.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
