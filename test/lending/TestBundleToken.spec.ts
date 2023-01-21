import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestERC721, TestLendingPlatform, TestBundleToken } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("TestLendingPlatform", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let nft2: TestERC721;
  let lendingPlatform: TestLendingPlatform;
  let bundleToken: TestBundleToken;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    nft2 = (await testERC721Factory.deploy("NFT 2", "NFT2", "https://nft2.com/token/")) as TestERC721;
    await nft2.deployed();

    lendingPlatform = (await testLendingPlatformFactory.deploy(tok1.address)) as TestLendingPlatform;
    await lendingPlatform.deployed();

    bundleToken = (await ethers.getContractAt(
      "TestBundleToken",
      await lendingPlatform.bundleToken(),
      accounts[0]
    )) as TestBundleToken;

    accountBorrower = accounts[1];

    /* Mint NFTs to borrower */
    await nft1.mint(accountBorrower.address, 123);
    await nft1.mint(accountBorrower.address, 456);
    await nft1.mint(accountBorrower.address, 768);
    await nft2.mint(accountBorrower.address, 111);
    await nft2.mint(accountBorrower.address, 222);

    /* Approve bundle token to transfer NFTs */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleToken.address, true);
    await nft2.connect(accountBorrower).setApprovalForAll(bundleToken.address, true);
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
      const mintTx1 = await bundleToken.connect(accountBorrower).mint();
      const mintTx2 = await bundleToken.connect(accounts[2]).mint();
      const bundleId1 = (await extractEvent(mintTx1, bundleToken, "BundleMinted")).args.bundleId;
      const bundleId2 = (await extractEvent(mintTx2, bundleToken, "BundleMinted")).args.bundleId;

      /* Validate events */
      await expectEvent(mintTx1, bundleToken, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: bundleId1,
      });
      await expectEvent(mintTx1, bundleToken, "BundleMinted", {
        bundleId: bundleId1,
        account: accountBorrower.address,
      });
      await expectEvent(mintTx2, bundleToken, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accounts[2].address,
        tokenId: bundleId2,
      });
      await expectEvent(mintTx2, bundleToken, "BundleMinted", {
        bundleId: bundleId2,
        account: accounts[2].address,
      });

      /* Validate state */
      expect(await bundleToken.exists(bundleId1)).to.equal(true);
      expect(await bundleToken.exists(bundleId2)).to.equal(true);
      expect(await bundleToken.ownerOf(bundleId1)).to.equal(accountBorrower.address);
      expect(await bundleToken.ownerOf(bundleId2)).to.equal(accounts[2].address);
      expect(await bundleToken.contents(bundleId1)).to.deep.equal([]);
      expect(await bundleToken.contents(bundleId2)).to.deep.equal([]);
    });
  });

  describe("#deposit", async function () {
    it("deposits multiple nfts into bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleToken.connect(accountBorrower).mint();
      const bundleId = (await extractEvent(mintTx, bundleToken, "BundleMinted")).args.bundleId;

      /* Deposit */
      const depositTx = await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 123);

      /* Validate events */
      await expectEvent(depositTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: bundleToken.address,
        tokenId: 123,
      });
      await expectEvent(depositTx, bundleToken, "BundleDeposited", {
        bundleId,
        account: accountBorrower.address,
        token: nft1.address,
        tokenId: 123,
      });

      /* Validate token ownership */
      expect(await nft1.ownerOf(123)).to.equal(bundleToken.address);

      /* Validate contents */
      let contents = await bundleToken.contents(bundleId);
      expect(contents.length).to.equal(1);
      expect(contents[0].token).to.equal(nft1.address);
      expect(contents[0].tokenId).to.equal(123);

      /* Deposit remaining */
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft2.address, 111);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 456);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft2.address, 222);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 768);

      /* Validate token ownership */
      expect(await nft1.ownerOf(123)).to.equal(bundleToken.address);
      expect(await nft1.ownerOf(456)).to.equal(bundleToken.address);
      expect(await nft1.ownerOf(768)).to.equal(bundleToken.address);
      expect(await nft2.ownerOf(111)).to.equal(bundleToken.address);
      expect(await nft2.ownerOf(222)).to.equal(bundleToken.address);

      /* Validate contents */
      contents = await bundleToken.contents(bundleId);
      expect(contents.length).to.equal(5);
      expect(contents[0].token).to.equal(nft1.address);
      expect(contents[0].tokenId).to.equal(123);
      expect(contents[1].token).to.equal(nft2.address);
      expect(contents[1].tokenId).to.equal(111);
      expect(contents[2].token).to.equal(nft1.address);
      expect(contents[2].tokenId).to.equal(456);
      expect(contents[3].token).to.equal(nft2.address);
      expect(contents[3].tokenId).to.equal(222);
      expect(contents[4].token).to.equal(nft1.address);
      expect(contents[4].tokenId).to.equal(768);
    });
    it("fails on invalid caller", async function () {
      /* Mint bundle */
      const mintTx = await bundleToken.connect(accountBorrower).mint();
      const bundleId = (await extractEvent(mintTx, bundleToken, "BundleMinted")).args.bundleId;

      /* Deposit from another account */
      await expect(bundleToken.connect(accounts[2]).deposit(bundleId, nft1.address, 123)).to.be.revertedWithCustomError(
        bundleToken,
        "InvalidCaller"
      );
    });
    it("fails on non-existent nft", async function () {
      /* Mint bundle */
      const mintTx = await bundleToken.connect(accountBorrower).mint();
      const bundleId = (await extractEvent(mintTx, bundleToken, "BundleMinted")).args.bundleId;

      /* Deposit non-existent token */
      await expect(bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 5)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });

  describe("#withdraw", async function () {
    it("withdraws all nfts from bundle", async function () {
      /* Mint bundle */
      const mintTx = await bundleToken.connect(accountBorrower).mint();
      const bundleId = (await extractEvent(mintTx, bundleToken, "BundleMinted")).args.bundleId;

      /* Deposit five tokens */
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 123);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft2.address, 111);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 456);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft2.address, 222);
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 768);

      /* Withdraw */
      const withdrawTx = await bundleToken.connect(accountBorrower).withdraw(bundleId);
      await expectEvent(
        withdrawTx,
        nft1,
        "Transfer",
        {
          from: bundleToken.address,
          to: accountBorrower.address,
          tokenId: 123,
        },
        0
      );
      await expectEvent(
        withdrawTx,
        nft1,
        "Transfer",
        {
          from: bundleToken.address,
          to: accountBorrower.address,
          tokenId: 456,
        },
        1
      );
      await expectEvent(
        withdrawTx,
        nft1,
        "Transfer",
        {
          from: bundleToken.address,
          to: accountBorrower.address,
          tokenId: 768,
        },
        2
      );
      await expectEvent(
        withdrawTx,
        nft2,
        "Transfer",
        {
          from: bundleToken.address,
          to: accountBorrower.address,
          tokenId: 111,
        },
        0
      );
      await expectEvent(
        withdrawTx,
        nft2,
        "Transfer",
        {
          from: bundleToken.address,
          to: accountBorrower.address,
          tokenId: 222,
        },
        1
      );
      await expectEvent(withdrawTx, bundleToken, "BundleWithdrawn", {
        bundleId,
        account: accountBorrower.address,
      });

      /* Validate token ownership and contents */
      expect(await bundleToken.exists(bundleId)).to.equal(false);
      expect(await bundleToken.contents(bundleId)).to.deep.equal([]);
      expect(await nft1.ownerOf(123)).to.equal(accountBorrower.address);
      expect(await nft1.ownerOf(456)).to.equal(accountBorrower.address);
      expect(await nft1.ownerOf(768)).to.equal(accountBorrower.address);
      expect(await nft2.ownerOf(111)).to.equal(accountBorrower.address);
      expect(await nft2.ownerOf(222)).to.equal(accountBorrower.address);
    });
    it("fails on invalid caller", async function () {
      /* Mint bundle */
      const mintTx = await bundleToken.connect(accountBorrower).mint();
      const bundleId = (await extractEvent(mintTx, bundleToken, "BundleMinted")).args.bundleId;

      /* Deposit one token */
      await bundleToken.connect(accountBorrower).deposit(bundleId, nft1.address, 123);

      /* Withdraw from another account */
      await expect(bundleToken.connect(accounts[2]).withdraw(bundleId)).to.be.revertedWithCustomError(
        bundleToken,
        "InvalidCaller"
      );
    });
  });
});
