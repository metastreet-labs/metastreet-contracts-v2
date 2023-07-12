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
    for (let i = 223; i < 223 + 16; i++) {
      await nft2.mint(accountBorrower.address, i);
    }

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

  /****************************************************************************/
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation version", async function () {
      expect(await bundleCollateralWrapper.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("returns correct name", async function () {
      expect(await bundleCollateralWrapper.name()).to.equal("MetaStreet Bundle Collateral Wrapper");
    });
    it("returns correct symbol", async function () {
      expect(await bundleCollateralWrapper.symbol()).to.equal("MSBCW");
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#enumerate", async function () {
    it("enumerate bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
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
      /* Mint bundle */
      await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Use different token id */
      const badTokenId = BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      /* Create context */
      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      await expect(bundleCollateralWrapper.enumerate(badTokenId, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidContext"
      );
    });
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
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Transfer token */
      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on non-existent nft", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 3])
      ).to.be.revertedWith("ERC721: invalid token ID");
    });

    it("fails on empty list of token ids", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [])
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidSize");
    });

    it("fails on more than 16 token ids", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(
          nft1.address,
          Array.from({ length: 33 }, (_, n) => n + 222) // 222 to 255 (33 token ids in total)
        )
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidSize");
    });
  });

  describe("#unwrap", async function () {
    it("unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* Validate current owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Unwrap and validate events */
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
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* Validate current owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Attempt to unwrap */
      await expect(
        bundleCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context)
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidCaller");

      await expect(bundleCollateralWrapper.unwrap(tokenId1, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidCaller"
      );
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint bundle */
      await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Use bad token id */
      const badTokenId = BigNumber.from(
        "80530570786821071483259871300278421257638987008682429097249700923201294947214"
      );

      /* Create context */
      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* Attempt to unwrap */
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).unwrap(badTokenId, context)
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidContext");
    });

    it("transferee can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accountBorrower.address);

      /* Transfer token */
      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(accountBorrower.address, accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);

      /* Create context */
      const context = ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 456, 768]]);

      /* Unwrap and validate events */
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

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(
        await bundleCollateralWrapper.supportsInterface(
          bundleCollateralWrapper.interface.getSighash("supportsInterface")
        )
      ).to.equal(true);

      /* ICollateralWrapper */
      expect(
        await bundleCollateralWrapper.supportsInterface(
          ethers.utils.hexlify(
            ethers.BigNumber.from(bundleCollateralWrapper.interface.getSighash("name"))
              .xor(ethers.BigNumber.from(bundleCollateralWrapper.interface.getSighash("unwrap")))
              .xor(ethers.BigNumber.from(bundleCollateralWrapper.interface.getSighash("enumerate")))
              .xor(ethers.BigNumber.from(bundleCollateralWrapper.interface.getSighash("validate")))
          )
        )
      ).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await bundleCollateralWrapper.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await bundleCollateralWrapper.supportsInterface("0x00000000")).to.equal(false);
        expect(await bundleCollateralWrapper.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
