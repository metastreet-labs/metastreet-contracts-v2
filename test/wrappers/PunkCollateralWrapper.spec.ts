import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, ICryptoPunksMarket, PunkCollateralWrapper } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("PunkCollateralWrapper", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let cryptoPunksMarket: ICryptoPunksMarket;
  let punkCollateralWrapper: PunkCollateralWrapper;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  /* Constants */
  const PUNK_ID_1 = ethers.BigNumber.from("117");
  const PUNK_ID_2 = ethers.BigNumber.from("20");
  const PUNK_ID_3 = ethers.BigNumber.from("28");
  const PUNK_ID_4 = ethers.BigNumber.from("35");
  const PUNK_ID_5 = ethers.BigNumber.from("50");
  const PUNK_OWNER = "0xA858DDc0445d8131daC4d1DE01f834ffcbA52Ef1"; /* Yuga Labs address */
  const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
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
    const punkCollateralWrapperFactory = await ethers.getContractFactory("PunkCollateralWrapper");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    cryptoPunksMarket = (await ethers.getContractAt("ICryptoPunksMarket", PUNKS_ADDRESS)) as ICryptoPunksMarket;

    punkCollateralWrapper = (await punkCollateralWrapperFactory.deploy()) as PunkCollateralWrapper;
    await punkCollateralWrapper.deployed();

    accountBorrower = await ethers.getImpersonatedSigner(PUNK_OWNER);

    /* Approve token to transfer NFTs by offering punk for 0 ethers */
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_1, 0, punkCollateralWrapper.address);
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_2, 0, punkCollateralWrapper.address);
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_3, 0, punkCollateralWrapper.address);

    /* Approve token to transfer NFTs by offering punk for 1 ethers */
    await cryptoPunksMarket
      .connect(accountBorrower)
      .offerPunkForSaleToAddress(PUNK_ID_4, 1, punkCollateralWrapper.address);
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
      expect(await punkCollateralWrapper.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("returns correct name", async function () {
      expect(await punkCollateralWrapper.name()).to.equal("MetaStreet Punk Collateral Wrapper");
    });
    it("returns correct symbol", async function () {
      expect(await punkCollateralWrapper.symbol()).to.equal("MSPCW");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#enumerate", async function () {
    it("enumerate punk", async function () {
      /* Mint punk */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const [token, tokenIds] = await punkCollateralWrapper.enumerate(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(cryptoPunksMarket.address);
      expect(tokenIds[0]).to.equal(PUNK_ID_1);
      expect(tokenIds[1]).to.equal(PUNK_ID_2);
    });
  });

  describe("#enumerateWithQuantities", async function () {
    it("enumerate punk", async function () {
      /* Mint punk */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const [token, tokenIds, quantities] = await punkCollateralWrapper.enumerateWithQuantities(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(cryptoPunksMarket.address);
      expect(tokenIds[0]).to.equal(PUNK_ID_1);
      expect(tokenIds[1]).to.equal(PUNK_ID_2);
      expect(quantities[0]).to.equal(1);
      expect(quantities[1]).to.equal(1);
    });
  });

  describe("#count", async function () {
    it("count batch", async function () {
      /* Mint punk */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      /* Enumerate */
      const count = await punkCollateralWrapper.count(tokenId1, context);

      /* Validate return */
      expect(count).to.equal(2);
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint punk */
      await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2]);

      /* Use different token id */
      const badTokenId = ethers.BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2]]);

      await expect(punkCollateralWrapper.count(badTokenId, context)).to.be.revertedWithCustomError(
        punkCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  describe("#transferCalldata", async function () {
    it("transfer calldata", async function () {
      /* Get transferCalldata */
      const calldata = await punkCollateralWrapper.transferCalldata(
        accountBorrower.address,
        accounts[0].address,
        PUNK_ID_1,
        0
      );

      const tx = {
        to: cryptoPunksMarket.address,
        data: calldata,
      };

      await accountBorrower.sendTransaction(tx);

      /* Validate return */
      const owner = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_1);
      expect(owner).to.equal(accounts[0].address);
    });
  });

  describe("#mint", async function () {
    it("mints punk", async function () {
      /* Mint punk */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;
      const punkData = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.encodedBundle;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Validate encoded bundle */
      expect(punkData).to.equal(context);

      /* Validate events */
      await expectEvent(mintTx1, punkCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: tokenId1,
      });

      await expectEvent(mintTx1, punkCollateralWrapper, "PunkMinted", {
        tokenId: tokenId1,
        account: accountBorrower.address,
      });

      /* Validate state */
      expect(await punkCollateralWrapper.exists(tokenId1)).to.equal(true);
      expect(await punkCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_1)).to.equal(punkCollateralWrapper.address);
      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_2)).to.equal(punkCollateralWrapper.address);
      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_3)).to.equal(punkCollateralWrapper.address);
    });

    it("can transfer PunkCollateralWrapperToken", async function () {
      /* Mint bundle */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;

      /* Validate owner */
      expect(await punkCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Transfer token */
      await punkCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await punkCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on not owner of nft", async function () {
      await expect(punkCollateralWrapper.connect(accountBorrower).mint([2, PUNK_ID_1])).to.be.revertedWithCustomError(
        punkCollateralWrapper,
        "InvalidCaller"
      );
      await expect(
        punkCollateralWrapper.connect(accounts[0]).mint([PUNK_ID_1, PUNK_ID_2])
      ).to.be.revertedWithCustomError(punkCollateralWrapper, "InvalidCaller");
    });

    it("fails on offered for sale for non-zero amount", async function () {
      await expect(
        punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_4])
      ).to.be.revertedWithoutReason();
    });

    it("fails on not offered for sale", async function () {
      await expect(
        punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_5])
      ).to.be.revertedWithoutReason();
    });

    it("fails on minting same punks twice", async function () {
      /* Mint bundle */
      await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      await expect(
        punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3])
      ).to.be.revertedWithCustomError(punkCollateralWrapper, "InvalidCaller");
    });

    it("fails on offering for sale after wrapping", async function () {
      /* Mint bundle */
      await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      await expect(
        cryptoPunksMarket
          .connect(accountBorrower)
          .offerPunkForSaleToAddress(PUNK_ID_3, 0, punkCollateralWrapper.address)
      ).to.be.revertedWithoutReason();
    });
  });

  describe("#unwrap", async function () {
    it("unwrap punk", async function () {
      /* Mint punk */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;
      const punkData = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.encodedBundle;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Validate encoded bundle */
      expect(punkData).to.equal(context);

      /* Validate current owner */
      expect(await punkCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Unwrap and validate events */
      await punkCollateralWrapper.connect(accountBorrower).unwrap(tokenId1, context);

      expect(await punkCollateralWrapper.exists(tokenId1)).to.equal(false);

      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_1)).to.equal(accountBorrower.address);
      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_2)).to.equal(accountBorrower.address);
      expect(await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_3)).to.equal(accountBorrower.address);
    });

    it("only token holder can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await punkCollateralWrapper.connect(accountBorrower).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, punkCollateralWrapper, "PunkMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Validate current owner */
      expect(await punkCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Attempt to unwrap */
      await expect(punkCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        punkCollateralWrapper,
        "InvalidCaller"
      );

      await expect(punkCollateralWrapper.unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        punkCollateralWrapper,
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
        await punkCollateralWrapper.supportsInterface(punkCollateralWrapper.interface.getSighash("supportsInterface"))
      ).to.equal(true);

      /* ICollateralWrapper */
      expect(
        await punkCollateralWrapper.supportsInterface(
          ethers.utils.hexlify(
            ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("name"))
              .xor(ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("unwrap")))
              .xor(ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("enumerate")))
              .xor(ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("count")))
              .xor(ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("enumerateWithQuantities")))
              .xor(ethers.BigNumber.from(punkCollateralWrapper.interface.getSighash("transferCalldata")))
          )
        )
      ).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await punkCollateralWrapper.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await punkCollateralWrapper.supportsInterface("0x00000000")).to.equal(false);
        expect(await punkCollateralWrapper.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
