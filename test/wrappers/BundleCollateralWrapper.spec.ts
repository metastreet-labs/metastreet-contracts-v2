import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestERC721, BundleCollateralWrapper } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";
import { BigNumber } from "ethers";

describe("BundleCollateralWrapper", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let nft2: TestERC721;
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    nft2 = (await testERC721Factory.deploy("NFT 2", "NFT2", "https://nft2.com/token/")) as TestERC721;
    await nft2.deployed();

    bundleCollateralWrapper = (await bundleCollateralWrapperFactory.deploy()) as BundleCollateralWrapper;
    await bundleCollateralWrapper.deployed();

    accountBorrower = accounts[1];

    /* Mint NFTs to borrower */
    await nft1.mint(accountBorrower.address, 123);
    await nft1.mint(accountBorrower.address, 456);
    await nft1.mint(accountBorrower.address, 768);
    await nft2.mint(accountBorrower.address, 111);
    await nft2.mint(accountBorrower.address, 222);

    /* Approve bundle token to transfer NFTs */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
    await nft2.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#mint", async function () {
    it("mints bundle", async function () {
      /* Mint two bundles */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);
      const mintTx2 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft2.address, [111, 222]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const tokenId2 = (await extractEvent(mintTx2, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate events */
      await expectEvent(mintTx1, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: tokenId1,
      });

      await expectEvent(mintTx1, bundleCollateralWrapper, "BundleMinted", {
        tokenId: tokenId1,
        encodedBundle: ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]),
        account: accountBorrower.address,
      });

      await expectEvent(mintTx2, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: tokenId2,
      });

      await expectEvent(mintTx2, bundleCollateralWrapper, "BundleMinted", {
        tokenId: tokenId2,
        encodedBundle: ethers.utils.solidityPack(["address", "uint256[]"], [nft2.address, [111, 222]]),
        account: accountBorrower.address,
      });

      /* Validate state */
      expect(await bundleCollateralWrapper.exists(tokenId1)).to.equal(true);
      expect(await bundleCollateralWrapper.exists(tokenId2)).to.equal(true);
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);
      expect(await bundleCollateralWrapper.ownerOf(tokenId2)).to.equal(accountBorrower.address);

      expect(await nft1.ownerOf(123)).to.equal(bundleCollateralWrapper.address);
      expect(await nft1.ownerOf(456)).to.equal(bundleCollateralWrapper.address);
      expect(await nft1.ownerOf(768)).to.equal(bundleCollateralWrapper.address);
    });

    it("can transfer BundleCollateralWrapperToken", async function () {
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on non-existent nft", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 3])
      ).to.be.revertedWith("ERC721: invalid token ID");
    });
  });

  describe("#enumerate", async function () {
    it("enumerate bundle", async function () {
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* Enumerate */
      const [token, tokenIds] = await bundleCollateralWrapper.enumerate(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(nft1.address);
      expect(tokenIds[0]).to.equal(123);
      expect(tokenIds[1]).to.equal(456);
      expect(tokenIds[2]).to.equal(768);
    });

    it("fails on incorrect tokenId", async function () {
      await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      const badTokenId = BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      await expect(bundleCollateralWrapper.enumerate(badTokenId, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  describe("#name", async function () {
    it("returns correct name", async function () {
      expect(await bundleCollateralWrapper.name()).to.equal("MetaStreet Bundle Collateral Wrapper");
    });
  });

  describe("#unwrap", async function () {
    it("unwrap bundle", async function () {
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* unwrap and validate events */
      await expect(bundleCollateralWrapper.connect(accountBorrower).unwrap(tokenId1, context))
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accountBorrower.address, 123)
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accountBorrower.address, 456)
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accountBorrower.address, 768)
        .to.emit(bundleCollateralWrapper, "Transfer")
        .withArgs(accountBorrower.address, ethers.constants.AddressZero, tokenId1)
        .to.emit(bundleCollateralWrapper, "BundleUnwrapped")
        .withArgs(tokenId1, accountBorrower.address);

      expect(await bundleCollateralWrapper.exists(tokenId1)).to.equal(false);

      expect(await nft1.ownerOf(123)).to.equal(accountBorrower.address);
      expect(await nft1.ownerOf(456)).to.equal(accountBorrower.address);
      expect(await nft1.ownerOf(768)).to.equal(accountBorrower.address);
    });

    it("only token holder can unwrap bundle", async function () {
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* attempt to unwrap */
      await expect(
        bundleCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context)
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidCaller");

      await expect(bundleCollateralWrapper.unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidCaller"
      );
    });

    it("fails on incorrect tokenId", async function () {
      await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      const badTokenId = BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* attempt to unwrap */
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).unwrap(badTokenId, context)
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidContext");
    });

    it("transferee can unwrap bundle", async function () {
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);

      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* unwrap and validate events */
      await expect(bundleCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context))
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accounts[2].address, 123)
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accounts[2].address, 456)
        .to.emit(nft1, "Transfer")
        .withArgs(bundleCollateralWrapper.address, accounts[2].address, 768)
        .to.emit(bundleCollateralWrapper, "Transfer")
        .withArgs(accounts[2].address, ethers.constants.AddressZero, tokenId1)
        .to.emit(bundleCollateralWrapper, "BundleUnwrapped")
        .withArgs(tokenId1, accounts[2].address);

      expect(await bundleCollateralWrapper.exists(tokenId1)).to.equal(false);

      expect(await nft1.ownerOf(123)).to.equal(accounts[2].address);
      expect(await nft1.ownerOf(456)).to.equal(accounts[2].address);
      expect(await nft1.ownerOf(768)).to.equal(accounts[2].address);
    });
  });
});
