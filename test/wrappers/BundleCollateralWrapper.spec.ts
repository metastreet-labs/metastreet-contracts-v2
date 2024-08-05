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

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("1000"))) as TestERC20;
    await tok1.waitForDeployment();

    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    nft2 = (await testERC721Factory.deploy("NFT 2", "NFT2", "https://nft2.com/token/")) as TestERC721;
    await nft2.waitForDeployment();

    bundleCollateralWrapper = (await bundleCollateralWrapperFactory.deploy()) as BundleCollateralWrapper;
    await bundleCollateralWrapper.waitForDeployment();

    accountBorrower = accounts[1];

    /* Mint NFTs to borrower */
    await nft1.mint(await accountBorrower.getAddress(), 123);
    await nft1.mint(await accountBorrower.getAddress(), 456);
    await nft1.mint(await accountBorrower.getAddress(), 768);
    await nft2.mint(await accountBorrower.getAddress(), 111);
    await nft2.mint(await accountBorrower.getAddress(), 222);
    for (let i = 223; i < 223 + 16; i++) {
      await nft2.mint(await accountBorrower.getAddress(), i);
    }

    /* Approve bundle token to transfer NFTs */
    await nft1.connect(accountBorrower).setApprovalForAll(await bundleCollateralWrapper.getAddress(), true);
    await nft2.connect(accountBorrower).setApprovalForAll(await bundleCollateralWrapper.getAddress(), true);
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
      expect(await bundleCollateralWrapper.IMPLEMENTATION_VERSION()).to.equal("2.1");
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
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Enumerate */
      const [token, tokenIds] = await bundleCollateralWrapper.enumerate(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(await nft1.getAddress());
      expect(tokenIds[0]).to.equal(123);
      expect(tokenIds[1]).to.equal(456);
      expect(tokenIds[2]).to.equal(768);
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint bundle */
      await bundleCollateralWrapper.connect(accountBorrower).mint(await nft1.getAddress(), [123, 456, 768]);

      /* Use different token id */
      const badTokenId = BigInt("80530570786821071483259871300278421257638987008682429097249700923201294947214");

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      await expect(bundleCollateralWrapper.enumerate(badTokenId, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  describe("#enumerateWithQuantities", async function () {
    it("enumerate bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Enumerate */
      const [token, tokenIds, quantities] = await bundleCollateralWrapper.enumerateWithQuantities(tokenId1, context);

      /* Validate return */
      expect(token).to.equal(await nft1.getAddress());
      expect(tokenIds[0]).to.equal(123);
      expect(tokenIds[1]).to.equal(456);
      expect(tokenIds[2]).to.equal(768);
      expect(quantities[0]).to.equal(1);
      expect(quantities[1]).to.equal(1);
      expect(quantities[2]).to.equal(1);
    });
  });

  describe("#count", async function () {
    it("count bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Enumerate */
      const count = await bundleCollateralWrapper.count(tokenId1, context);

      /* Validate return */
      expect(count).to.equal(3);
    });

    it("fails on incorrect tokenId", async function () {
      /* Mint bundle */
      await bundleCollateralWrapper.connect(accountBorrower).mint(await nft1.getAddress(), [123, 456, 768]);

      /* Use different token id */
      const badTokenId = BigInt("80530570786821071483259871300278421257638987008682429097249700923201294947214");

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      await expect(bundleCollateralWrapper.count(badTokenId, context)).to.be.revertedWithCustomError(
        bundleCollateralWrapper,
        "InvalidContext"
      );
    });
  });

  describe("#transferCalldata", async function () {
    it("transfer calldata", async function () {
      /* Get transferCalldata */
      const [target, calldata] = await bundleCollateralWrapper.transferCalldata(
        await nft1.getAddress(),
        await accountBorrower.getAddress(),
        accounts[0].address,
        123,
        0
      );

      const tx = {
        to: target,
        data: calldata,
      };

      await accountBorrower.sendTransaction(tx);

      /* Validate balance */
      const balance = await nft1.balanceOf(accounts[0].address);
      expect(balance).to.equal(1);
    });
  });

  describe("#mint", async function () {
    it("mints bundle", async function () {
      /* Mint two bundles */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);
      const mintTx2 = await bundleCollateralWrapper.connect(accountBorrower).mint(await nft2.getAddress(), [111, 222]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const tokenId2 = (await extractEvent(mintTx2, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate events */
      await expectEvent(mintTx1, bundleCollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: tokenId1,
      });

      await expectEvent(mintTx1, bundleCollateralWrapper, "BundleMinted", {
        tokenId: tokenId1,
        encodedBundle: ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]),
        account: await accountBorrower.getAddress(),
      });

      await expectEvent(mintTx2, bundleCollateralWrapper, "Transfer", {
        from: ethers.ZeroAddress,
        to: await accountBorrower.getAddress(),
        tokenId: tokenId2,
      });

      await expectEvent(mintTx2, bundleCollateralWrapper, "BundleMinted", {
        tokenId: tokenId2,
        encodedBundle: ethers.solidityPacked(["address", "uint256[]"], [await nft2.getAddress(), [111, 222]]),
        account: await accountBorrower.getAddress(),
      });

      /* Validate state */
      expect(await bundleCollateralWrapper.exists(tokenId1)).to.equal(true);
      expect(await bundleCollateralWrapper.exists(tokenId2)).to.equal(true);
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());
      expect(await bundleCollateralWrapper.ownerOf(tokenId2)).to.equal(await accountBorrower.getAddress());

      expect(await nft1.ownerOf(123)).to.equal(await bundleCollateralWrapper.getAddress());
      expect(await nft1.ownerOf(456)).to.equal(await bundleCollateralWrapper.getAddress());
      expect(await nft1.ownerOf(768)).to.equal(await bundleCollateralWrapper.getAddress());
    });

    it("can transfer BundleCollateralWrapperToken", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      /* Transfer token */
      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(await accountBorrower.getAddress(), accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);
    });

    it("fails on non-existent nft", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(await nft1.getAddress(), [123, 456, 3])
      ).to.be.revertedWith("ERC721: invalid token ID");
    });

    it("fails on empty list of token ids", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(await nft1.getAddress(), [])
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidSize");
    });

    it("fails on more than 16 token ids", async function () {
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).mint(
          await nft1.getAddress(),
          Array.from({ length: 33 }, (_, n) => n + 222) // 222 to 255 (33 token ids in total)
        )
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidSize");
    });
  });

  describe("#unwrap", async function () {
    it("unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Validate current owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      /* Unwrap and validate events */
      await expect(bundleCollateralWrapper.connect(accountBorrower).unwrap(tokenId1, context))
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), await accountBorrower.getAddress(), 123)
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), await accountBorrower.getAddress(), 456)
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), await accountBorrower.getAddress(), 768)
        .to.emit(bundleCollateralWrapper, "Transfer")
        .withArgs(await accountBorrower.getAddress(), ethers.ZeroAddress, tokenId1)
        .to.emit(bundleCollateralWrapper, "BundleUnwrapped")
        .withArgs(tokenId1, await accountBorrower.getAddress());

      expect(await bundleCollateralWrapper.exists(tokenId1)).to.equal(false);

      expect(await nft1.ownerOf(123)).to.equal(await accountBorrower.getAddress());
      expect(await nft1.ownerOf(456)).to.equal(await accountBorrower.getAddress());
      expect(await nft1.ownerOf(768)).to.equal(await accountBorrower.getAddress());
    });

    it("only token holder can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Validate current owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

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
      await bundleCollateralWrapper.connect(accountBorrower).mint(await nft1.getAddress(), [123, 456, 768]);

      /* Use bad token id */
      const badTokenId = BigInt("80530570786821071483259871300278421257638987008682429097249700923201294947214");

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Attempt to unwrap */
      await expect(
        bundleCollateralWrapper.connect(accountBorrower).unwrap(badTokenId, context)
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidContext");
    });

    it("transferee can unwrap bundle", async function () {
      /* Mint bundle */
      const mintTx1 = await bundleCollateralWrapper
        .connect(accountBorrower)
        .mint(await nft1.getAddress(), [123, 456, 768]);

      /* Get token id */
      const tokenId1 = (await extractEvent(mintTx1, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(await accountBorrower.getAddress());

      /* Transfer token */
      await bundleCollateralWrapper
        .connect(accountBorrower)
        .transferFrom(await accountBorrower.getAddress(), accounts[2].address, tokenId1);

      /* Validate owner */
      expect(await bundleCollateralWrapper.ownerOf(tokenId1)).to.equal(accounts[2].address);

      /* Create context */
      const context = ethers.solidityPacked(["address", "uint256[]"], [await nft1.getAddress(), [123, 456, 768]]);

      /* Unwrap and validate events */
      await expect(bundleCollateralWrapper.connect(accounts[2]).unwrap(tokenId1, context))
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), accounts[2].address, 123)
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), accounts[2].address, 456)
        .to.emit(nft1, "Transfer")
        .withArgs(await bundleCollateralWrapper.getAddress(), accounts[2].address, 768)
        .to.emit(bundleCollateralWrapper, "Transfer")
        .withArgs(accounts[2].address, ethers.ZeroAddress, tokenId1)
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
        await bundleCollateralWrapper.supportsInterface(ethers.id("supportsInterface(bytes4)").substring(0, 10))
      ).to.equal(true);

      /* ICollateralWrapper */
      expect(
        await bundleCollateralWrapper.supportsInterface(
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
        expect(await bundleCollateralWrapper.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await bundleCollateralWrapper.supportsInterface("0x00000000")).to.equal(false);
        expect(await bundleCollateralWrapper.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
