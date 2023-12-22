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

    cryptoPunks721CollateralWrapper = (await cryptoPunks721CollateralWrapperFactory.deploy(
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
  /* Primary API */
  /****************************************************************************/

  describe("#enumerate", async function () {
    it("enumerate punk", async function () {
      /* Mint punk */
      const mintTx1 = await cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const [token, tokenIds] = await cryptoPunks721CollateralWrapper.enumerate(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds[0]).to.equal(PUNK_ID_1);
      expect(tokenIds[1]).to.equal(PUNK_ID_2);
    });
  });

  describe("#enumerateWithQuantities", async function () {
    it("enumerate punk", async function () {
      /* Mint punk */
      const mintTx1 = await cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const [token, tokenIds, quantities] = await cryptoPunks721CollateralWrapper.enumerateWithQuantities(
        tokenId1,
        context
      );

      /* Validate return */
      expect(token).to.equal(WPUNKS_ADDRESS);
      expect(tokenIds[0]).to.equal(PUNK_ID_1);
      expect(tokenIds[1]).to.equal(PUNK_ID_2);
      expect(quantities[0]).to.equal(1);
      expect(quantities[1]).to.equal(1);
    });
  });

  describe("#count", async function () {
    it("count batch", async function () {
      /* Mint punk */
      const mintTx1 = await cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const count = await cryptoPunks721CollateralWrapper.count(tokenId1, context);

      /* Validate return */
      expect(count).to.equal(2);
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint punk */
      await cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Use different token id */
      const badTokenId = ethers.BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      await expect(cryptoPunks721CollateralWrapper.count(badTokenId, context)).to.be.revertedWithCustomError(
        cryptoPunks721CollateralWrapper,
        "InvalidContext"
      );
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

  describe("#mint", async function () {
    it("mints punk 1", async function () {
      /* Mint punk */
      const mintTx1 = await cryptoPunks721CollateralWrapper
        .connect(accountBorrower)
        .mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;
      const punkData = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.encodedBundle;
      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);
      /* Validate encoded bundle */
      expect(punkData).to.equal(context);
      /* Validate events */
      await expectEvent(mintTx1, cryptoPunks721CollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: tokenId1,
      });
      await expectEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted", {
        tokenId: tokenId1,
        account: accountBorrower.address,
      });
      /* Validate state */
      expect(await cryptoPunks721CollateralWrapper.exists(tokenId1)).to.equal(true);
      expect(await cryptoPunks721CollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);
      expect(await cryptoPunks721.ownerOf(PUNK_ID_1)).to.equal(cryptoPunks721CollateralWrapper.address);
      expect(await cryptoPunks721.ownerOf(PUNK_ID_2)).to.equal(cryptoPunks721CollateralWrapper.address);
      expect(await cryptoPunks721.ownerOf(PUNK_ID_3)).to.equal(cryptoPunks721CollateralWrapper.address);
    });

    it("can transfer CryptoPunks721CollateralWrapperToken", async function () {
      /* Mint bundle */
      const mintTx1 = await cryptoPunks721CollateralWrapper
        .connect(accountBorrower)
        .mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;

      /* Validate owner */
      expect(await cryptoPunks721CollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Transfer token */
      await cryptoPunks721CollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await cryptoPunks721CollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on not owner of nft", async function () {
      await expect(cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([2, PUNK_ID_1])).to.be.reverted;
      await expect(cryptoPunks721CollateralWrapper.connect(accounts[0]).mint([PUNK_ID_1, PUNK_ID_2])).to.be.reverted;
    });

    it("fails on minting same punks twice", async function () {
      /* Mint bundle */
      await cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      await expect(cryptoPunks721CollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3])).to
        .be.reverted;
    });
  });

  describe("#unwrap", async function () {
    it("unwrap punk", async function () {
      /* Mint punk */
      const mintTx1 = await cryptoPunks721CollateralWrapper
        .connect(accountBorrower)
        .mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;
      const punkData = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.encodedBundle;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Validate encoded bundle */
      expect(punkData).to.equal(context);

      /* Validate current owner */
      expect(await cryptoPunks721CollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Unwrap and validate events */
      await cryptoPunks721CollateralWrapper.connect(accountBorrower).unwrap(tokenId1, context);

      expect(await cryptoPunks721CollateralWrapper.exists(tokenId1)).to.equal(false);

      expect(await cryptoPunks721.ownerOf(PUNK_ID_1)).to.equal(accountBorrower.address);
      expect(await cryptoPunks721.ownerOf(PUNK_ID_2)).to.equal(accountBorrower.address);
      expect(await cryptoPunks721.ownerOf(PUNK_ID_3)).to.equal(accountBorrower.address);
    });

    it("only token holder can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await cryptoPunks721CollateralWrapper
        .connect(accountBorrower)
        .mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, cryptoPunks721CollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Validate current owner */
      expect(await cryptoPunks721CollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Attempt to unwrap */
      await expect(
        cryptoPunks721CollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context)
      ).to.be.revertedWithCustomError(cryptoPunks721CollateralWrapper, "InvalidCaller");

      await expect(cryptoPunks721CollateralWrapper.unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        cryptoPunks721CollateralWrapper,
        "InvalidCaller"
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
