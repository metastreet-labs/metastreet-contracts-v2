import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestERC1155,
  TestLoanReceipt,
  EnglishAuctionCollateralLiquidator,
  BundleCollateralWrapper,
  ERC1155CollateralWrapper,
  TestCollateralLiquidatorJig,
  TestCollateralLiquidatorJigTruncated,
} from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("EnglishAuctionCollateralLiquidator", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let erc1155: TestERC1155;
  let loanReceiptLibrary: TestLoanReceipt;
  let collateralLiquidator: EnglishAuctionCollateralLiquidator;
  let testCollateralLiquidatorJig: TestCollateralLiquidatorJig;
  let testCollateralLiquidatorJigRevert: TestCollateralLiquidatorJig;
  let testCollateralLiquidatorJigTruncated: TestCollateralLiquidatorJigTruncated;
  let snapshotId: string;
  let accountLiquidator: SignerWithAddress;
  let accountBidder1: SignerWithAddress;
  let accountBidder2: SignerWithAddress;
  let accountBidder3: SignerWithAddress;
  let bundleCollateralWrapper: BundleCollateralWrapper;
  let bundleCollateralWrapperFake: BundleCollateralWrapper;
  let erc1155CollateralWrapper: ERC1155CollateralWrapper;
  let bundleTokenId: bigint;
  let bundleTokenIdFake: bigint;
  let erc1155TokenId: bigint;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const englishAuctionCollateralLiquidatorFactory = await ethers.getContractFactory(
      "EnglishAuctionCollateralLiquidator"
    );
    const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");
    const testCollateralLiquidatorJigTruncatedFactory = await ethers.getContractFactory(
      "TestCollateralLiquidatorJigTruncated"
    );
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("1000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy test ERC1155 */
    erc1155 = (await testERC1155Factory.deploy("https://erc1155.com/token/")) as TestERC1155;
    await erc1155.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.waitForDeployment();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.waitForDeployment();

    /* Deploy non-approved bundle collateral wrapper */
    bundleCollateralWrapperFake = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.waitForDeployment();

    /* Deploy ERC1155 collateral wrapper */
    erc1155CollateralWrapper = (await ERC1155CollateralWrapperFactory.deploy()) as ERC1155CollateralWrapper;
    await erc1155CollateralWrapper.waitForDeployment();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await englishAuctionCollateralLiquidatorFactory.deploy([
      await bundleCollateralWrapper.getAddress(),
      await erc1155CollateralWrapper.getAddress(),
    ]);
    await collateralLiquidatorImpl.waitForDeployment();

    /* Deploy collateral liquidator */
    const proxy = await testProxyFactory.deploy(
      await collateralLiquidatorImpl.getAddress(),
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [
        BigInt(86400),
        BigInt(60 * 10),
        BigInt(60 * 20),
        BigInt(199),
      ])
    );
    await proxy.waitForDeployment();
    collateralLiquidator = (await ethers.getContractAt(
      "EnglishAuctionCollateralLiquidator",
      await proxy.getAddress()
    )) as EnglishAuctionCollateralLiquidator;

    /* Deploy collateral liquidator testing jig */
    testCollateralLiquidatorJig = await testCollateralLiquidatorJigFactory.deploy(
      await tok1.getAddress(),
      await collateralLiquidator.getAddress()
    );
    await testCollateralLiquidatorJig.waitForDeployment();

    /* Deploy collateral liquidator testing jig that reverts onCollateralLiquidate */
    testCollateralLiquidatorJigRevert = await testCollateralLiquidatorJigFactory.deploy(
      await tok1.getAddress(),
      await collateralLiquidator.getAddress()
    );
    await testCollateralLiquidatorJigRevert.waitForDeployment();

    /* Deploy collateral liquidator testing jig that does not implement onCollateralLiquidate */
    testCollateralLiquidatorJigTruncated = await testCollateralLiquidatorJigTruncatedFactory.deploy(
      await tok1.getAddress(),
      await collateralLiquidator.getAddress()
    );
    await testCollateralLiquidatorJigRevert.waitForDeployment();

    accountLiquidator = accounts[3];
    accountBidder1 = accounts[4];
    accountBidder2 = accounts[5];
    accountBidder3 = accounts[6];

    /* Mint NFT and create a bundled collateral token */
    await nft1.mint(await accountLiquidator.getAddress(), 123);
    await nft1.mint(await accountLiquidator.getAddress(), 124);
    await nft1.mint(await accountLiquidator.getAddress(), 125);
    await nft1.connect(accountLiquidator).setApprovalForAll(await bundleCollateralWrapper.getAddress(), true);
    const mintTx = await bundleCollateralWrapper
      .connect(accountLiquidator)
      .mint(await nft1.getAddress(), [123, 124, 125]);
    bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

    /* Mint NFT and create a fake bundled collateral token */
    await nft1.mint(await accountLiquidator.getAddress(), 126);
    await nft1.mint(await accountLiquidator.getAddress(), 127);
    await nft1.mint(await accountLiquidator.getAddress(), 128);
    await nft1.connect(accountLiquidator).setApprovalForAll(await bundleCollateralWrapperFake.getAddress(), true);
    const mintTxFake = await bundleCollateralWrapperFake
      .connect(accountLiquidator)
      .mint(await nft1.getAddress(), [126, 127, 128]);
    bundleTokenIdFake = (await extractEvent(mintTxFake, bundleCollateralWrapperFake, "BundleMinted")).args.tokenId;

    /* Transfer bundled collateral token to testing jig */
    await bundleCollateralWrapper
      .connect(accountLiquidator)
      .transferFrom(
        await accountLiquidator.getAddress(),
        await testCollateralLiquidatorJig.getAddress(),
        bundleTokenId
      );
    await bundleCollateralWrapperFake
      .connect(accountLiquidator)
      .transferFrom(
        await accountLiquidator.getAddress(),
        await testCollateralLiquidatorJig.getAddress(),
        bundleTokenIdFake
      );

    /* Mint NFT to testing jig to simulate default */
    await nft1.mint(await testCollateralLiquidatorJig.getAddress(), 122);
    await nft1.mint(await testCollateralLiquidatorJig.getAddress(), 456);

    /* Mint NFT to an EOA */
    await nft1.mint(await accountBidder1.getAddress(), 129);
    await nft1.connect(accountBidder1).approve(await collateralLiquidator.getAddress(), 129);

    /* Mint NFT to a testing jig that reverts onCollateralLiquidate() */
    await nft1.mint(await testCollateralLiquidatorJigRevert.getAddress(), 130);

    /* Mint NFT to a testing jig that does not implement onCollateralLiquidate() */
    await nft1.mint(await testCollateralLiquidatorJigTruncated.getAddress(), 131);

    /* Transfer token to liquidator account and bidder accounts */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("200"));
    await tok1.transfer(await accountBidder1.getAddress(), ethers.parseEther("200"));
    await tok1.transfer(await accountBidder2.getAddress(), ethers.parseEther("200"));
    await tok1.transfer(await accountBidder3.getAddress(), ethers.parseEther("200"));

    /* Approve collateral liquidator to transfer token */
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);
    await tok1.connect(accountBidder1).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);
    await tok1.connect(accountBidder2).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);
    await tok1.connect(accountBidder3).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Mint erc1155 wrapped token */
    await erc1155.mintBatch(await accountLiquidator.getAddress(), [123, 124, 125], [1, 2, 3], "0x");
    await erc1155.connect(accountLiquidator).setApprovalForAll(await erc1155CollateralWrapper.getAddress(), true);
    const mintErc1155Tx = await erc1155CollateralWrapper
      .connect(accountLiquidator)
      .mint(await erc1155.getAddress(), [123, 124, 125], [1, 2, 3]);
    erc1155TokenId = (await extractEvent(mintErc1155Tx, erc1155CollateralWrapper, "BatchMinted")).args.tokenId;

    /* Transfer erc1155 collateral token to testing jig */
    await erc1155CollateralWrapper
      .connect(accountLiquidator)
      .transferFrom(
        await accountLiquidator.getAddress(),
        await testCollateralLiquidatorJig.getAddress(),
        erc1155TokenId
      );
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
    it("matches expected implementation", async function () {
      expect(await collateralLiquidator.IMPLEMENTATION_VERSION()).to.equal("2.1");
    });
    it("matches expected name", async function () {
      expect(await collateralLiquidator.name()).to.equal("EnglishAuctionCollateralLiquidator");
    });
  });

  /****************************************************************************/
  /* Helper Functions */
  /****************************************************************************/

  const loanReceiptTemplate = {
    version: 2,
    principal: BigInt("3000000000000000000"),
    repayment: BigInt("3040000000000000000"),
    adminFee: BigInt("2000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: ethers.ZeroAddress /* To be populated */,
    collateralTokenId: 0 /* To be populated */,
    collateralWrapperContextLen: 0,
    collateralWrapperContext: "0x",
    nodeReceipts: [
      {
        tick: BigInt("1000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("2000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("3000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1020000000000000000"),
      },
    ],
  };

  function makeLoanReceipt(
    collateralToken: string,
    collateralTokenId: number,
    collateralWrapperContextLen: number,
    collateralWrapperContext: string
  ) {
    return {
      ...loanReceiptTemplate,
      collateralToken,
      collateralTokenId,
      collateralWrapperContextLen,
      collateralWrapperContext,
    };
  }

  async function getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    const block = await ethers.provider.getBlock(blockNumber);
    return block.timestamp;
  }

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("getters", async function () {
    it("returns collateral wrappers", async function () {
      const collateralWrappers = await collateralLiquidator.collateralWrappers();
      expect(collateralWrappers[0]).to.equal(await bundleCollateralWrapper.getAddress());
      expect(collateralWrappers[1]).to.equal(await erc1155CollateralWrapper.getAddress());
      expect(collateralWrappers[2]).to.equal(ethers.ZeroAddress);
      expect(collateralWrappers[3]).to.equal(ethers.ZeroAddress);
      expect(collateralWrappers[4]).to.equal(ethers.ZeroAddress);
    });
    it("returns auction duration", async function () {
      expect(await collateralLiquidator.auctionDuration()).to.equal(BigInt(86400));
    });
    it("returns time extension window", async function () {
      expect(await collateralLiquidator.timeExtensionWindow()).to.equal(BigInt(60 * 10));
    });
    it("returns time extension", async function () {
      expect(await collateralLiquidator.timeExtension()).to.equal(BigInt(60 * 20));
    });
    it("returns minimum bid basis point", async function () {
      expect(await collateralLiquidator.minimumBidBasisPoints()).to.equal(BigInt(199));
    });
  });

  /****************************************************************************/
  /* Primay API */
  /****************************************************************************/

  describe("#liquidate", async function () {
    it("succeeds starting an auction on collateral", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          1
        );
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await nft1.getAddress(), 122, 1);

      /* Validate state */
      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.proceeds).to.equal(0);
      await expect(liquidation.auctionCount).to.equal(1);
      await expect(liquidation.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation.collateralToken).to.equal(await nft1.getAddress());
      await expect(liquidation.liquidationContextHash).to.equal(loanReceiptHash);

      const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.quantity).to.equal(1);
      await expect(auction.endTime).to.equal(0);
      await expect(auction.highestBid).to.equal(0);
      await expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
    });

    it("succeeds starting an auction on bundled collateral", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [123, 124, 125];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await nft1.getAddress(), tokenIds]
      );

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          ethers.getBytes(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await nft1.getAddress(), tokenIds[0], 1)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await nft1.getAddress(), tokenIds[1], 1)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await nft1.getAddress(), tokenIds[2], 1);

      /* Validate state */
      for (const [index, tokenId] of tokenIds.entries()) {
        const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), tokenId);
        await expect(auction.endTime).to.equal(0);
        await expect(auction.highestBid).to.equal(0);
        await expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
        await expect(auction.quantity).to.equal(1);
      }
    });

    it("succeeds starting an auction on non-approved bundled collateral but does not unwrap", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [126, 127, 128];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await nft1.getAddress(), tokenIds]
      );

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await bundleCollateralWrapperFake.getAddress(),
          bundleTokenIdFake,
          ethers.getBytes(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await bundleCollateralWrapperFake.getAddress(),
          bundleTokenIdFake,
          1
        );
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await bundleCollateralWrapperFake.getAddress(), bundleTokenIdFake, 1);

      /* Validate state */
      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.proceeds).to.equal(0);
      await expect(liquidation.auctionCount).to.equal(1);
      await expect(liquidation.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation.collateralToken).to.equal(await bundleCollateralWrapperFake.getAddress());
      await expect(liquidation.liquidationContextHash).to.equal(loanReceiptHash);

      const auction = await collateralLiquidator.auctions(
        liquidationHash,
        await bundleCollateralWrapperFake.getAddress(),
        bundleTokenIdFake
      );
      await expect(auction.endTime).to.equal(0);
      await expect(auction.highestBid).to.equal(0);
      await expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
      await expect(auction.quantity).to.equal(1);
    });

    it("succeeds starting an auction on erc1155 collateral wrapper", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [123, 124, 125];
      const tokenIdQuantities = [1, 2, 3];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "uint256[]", "uint256[]"],
        [await erc1155.getAddress(), 0, 6, tokenIds, tokenIdQuantities]
      );

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await erc1155CollateralWrapper.getAddress(),
          erc1155TokenId,
          ethers.getBytes(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await erc1155CollateralWrapper.getAddress(),
          erc1155TokenId,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await erc1155.getAddress(), tokenIds[0], 1)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await erc1155.getAddress(), tokenIds[1], 2)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, await erc1155.getAddress(), tokenIds[2], 3);

      /* Validate state */
      for (const [index, tokenId] of tokenIds.entries()) {
        const auction = await collateralLiquidator.auctions(liquidationHash, await erc1155.getAddress(), tokenId);
        await expect(auction.endTime).to.equal(0);
        await expect(auction.highestBid).to.equal(0);
        await expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
        await expect(auction.quantity).to.equal(tokenIdQuantities[index]);
      }
    });

    it("fails with invalid token", async function () {
      /* Construct loan receipt */
      const loanReceipt1 = await loanReceiptLibrary.encode(makeLoanReceipt(ethers.ZeroAddress, 122, 0, "0x"));

      /* Liquidate with invalid collateral token */
      await expect(
        collateralLiquidator.liquidate(await tok1.getAddress(), ethers.ZeroAddress, 122, "0x", loanReceipt1)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");

      /* Construct loan receipt */
      const loanReceipt2 = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Liquidate with invalid currency token */
      await expect(
        collateralLiquidator
          .connect(accountBidder1)
          .liquidate(ethers.ZeroAddress, await nft1.getAddress(), 122, "0x", loanReceipt2)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");
    });
  });

  describe("#bid", async function () {
    it("3 successful bids on same auction", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("100"));
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);

      /* Validate events */
      await expectEvent(bid1Tx, tok1, "Transfer", {
        from: await accountBidder1.getAddress(),
        to: await collateralLiquidator.getAddress(),
        value: ethers.parseEther("100"),
      });

      await expectEvent(bid1Tx, collateralLiquidator, "AuctionStarted", {
        liquidationHash: liquidationHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        endTime: BigInt(transactionTime) + 86400n,
      });

      await expectEvent(bid1Tx, collateralLiquidator, "AuctionBid", {
        liquidationHash: liquidationHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        bidder: await accountBidder1.getAddress(),
        amount: ethers.parseEther("100"),
      });

      /* Validate state */
      let auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(BigInt(transactionTime) + 86400n);
      await expect(auction.highestBid).to.equal(ethers.parseEther("100"));
      await expect(auction.highestBidder).to.equal(await accountBidder1.getAddress());

      /* Bid with accountBidder2 */
      const bid2Tx = await collateralLiquidator
        .connect(accountBidder2)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("102"));

      /* Validate events */
      await expectEvent(bid2Tx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        value: ethers.parseEther("100"),
      });

      await expectEvent(
        bid2Tx,
        tok1,
        "Transfer",
        {
          from: await accountBidder2.getAddress(),
          to: await collateralLiquidator.getAddress(),
          value: ethers.parseEther("102"),
        },
        1
      );

      await expectEvent(bid2Tx, collateralLiquidator, "AuctionBid", {
        liquidationHash: liquidationHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        bidder: await accountBidder2.getAddress(),
        amount: ethers.parseEther("102"),
      });

      /* Validate state */
      auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(BigInt(transactionTime) + 86400n);
      await expect(auction.highestBid).to.equal(ethers.parseEther("102"));
      await expect(auction.highestBidder).to.equal(await accountBidder2.getAddress());
      await expect(auction.quantity).to.equal(1);

      /* Bid with accountBidder1 */
      const bid3Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("105"));

      /* Validate events */
      await expectEvent(bid3Tx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder2.getAddress(),
        value: ethers.parseEther("102"),
      });

      await expectEvent(
        bid3Tx,
        tok1,
        "Transfer",
        {
          from: await accountBidder1.getAddress(),
          to: await collateralLiquidator.getAddress(),
          value: ethers.parseEther("105"),
        },
        1
      );

      await expectEvent(bid3Tx, collateralLiquidator, "AuctionBid", {
        liquidationHash: liquidationHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        bidder: await accountBidder1.getAddress(),
        amount: ethers.parseEther("105"),
      });

      /* Validate state */
      auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(BigInt(transactionTime) + 86400n);
      await expect(auction.highestBid).to.equal(ethers.parseEther("105"));
      await expect(auction.highestBidder).to.equal(await accountBidder1.getAddress());
      await expect(auction.quantity).to.equal(1);
    });

    it("extends time on an auction within 10 minutes of end time", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("1"));

      /* Fast forward to 10 minutes before end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(BigInt(transactionTime) + 86400n - 10n * 60n);

      /* Bid with accountBidder1 */
      const bid2Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Validate events */
      const bid2TransactionTime = await getBlockTimestamp(bid2Tx.blockNumber);
      await expectEvent(bid2Tx, collateralLiquidator, "AuctionExtended", {
        liquidationHash: liquidationHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        endTime: BigInt(bid2TransactionTime) + 60n * 20n,
      });

      /* Validate state */
      let auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(BigInt(bid2TransactionTime) + 60n * 20n);
    });

    it("fails when auction does not exist", async function () {
      /* Bid with accountBidder1 */
      await expect(
        collateralLiquidator
          .connect(accountBidder1)
          .bid(
            "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            await nft1.getAddress(),
            1000,
            ethers.parseEther("1")
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidAuction");
    });

    it("fails when bid with 0 amount", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      await expect(
        collateralLiquidator
          .connect(accountBidder1)
          .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("0"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidBid");
    });

    it("fails when bid after end time", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("1"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Bid with accountBidder1 */
      await expect(
        collateralLiquidator
          .connect(accountBidder1)
          .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidBid");
    });

    it("fails when bid with same amount as previous bid", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Bid with accountBidder2 */
      await expect(
        collateralLiquidator
          .connect(accountBidder2)
          .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidBid");
    });

    it("fails when bid with amount smaller than minimum bid increment", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("100"));

      /* Bid with accountBidder2 */
      await expect(
        collateralLiquidator
          .connect(accountBidder2)
          .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("101"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidBid");
    });

    it("fails when bid with amount smaller than previous bid", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("100"));

      /* Bid with accountBidder2 */
      await expect(
        collateralLiquidator
          .connect(accountBidder2)
          .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("99"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidBid");
    });
  });

  describe("#claim", async function () {
    it("claims single collateral", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claimTx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt);

      /* Validate events */
      await expectEvent(claimTx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        tokenId: 122,
      });

      await expect(claimTx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          122,
          await accountBidder1.getAddress(),
          ethers.parseEther("2")
        );

      await expect(claimTx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("2"));

      await expect(claimTx)
        .to.emit(testCollateralLiquidatorJig, "CollateralLiquidated")
        .withArgs(ethers.parseEther("2"));

      await expectEvent(claimTx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await testCollateralLiquidatorJig.getAddress(),
        value: ethers.parseEther("2"),
      });

      /* Validate state */
      const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(0n);

      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation.proceeds).to.equal(0n);
      await expect(liquidation.auctionCount).to.equal(0n);
      await expect(liquidation.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.liquidationContextHash).to.equal(ethers.ZeroHash);
    });

    it("claims bundled collateral", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [123, 124, 125];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.solidityPacked(
        ["address", "uint256[]"],
        [await nft1.getAddress(), tokenIds]
      );

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          ethers.getBytes(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await bundleCollateralWrapper.getAddress(),
          bundleTokenId,
          3
        );

      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated", index)).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 123, ethers.parseEther("1"));

      /* Bid with accountBidder2 */
      await collateralLiquidator
        .connect(accountBidder2)
        .bid(liquidationHash, await nft1.getAddress(), 124, ethers.parseEther("2"));

      /* Bid with accountBidder3 */
      await collateralLiquidator
        .connect(accountBidder3)
        .bid(liquidationHash, await nft1.getAddress(), 125, ethers.parseEther("3"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claim1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 123, loanReceipt);

      /* Validate events */
      await expectEvent(claim1Tx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        tokenId: 123,
      });

      await expect(claim1Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          123,
          await accountBidder1.getAddress(),
          ethers.parseEther("1")
        );

      /* Validate state */
      const auction1 = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 123);
      await expect(auction1.endTime).to.equal(0n);

      const liquidation1 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation1.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation1.proceeds).to.equal(ethers.parseEther("1"));
      await expect(liquidation1.auctionCount).to.equal(2);
      await expect(liquidation1.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation1.collateralToken).to.equal(await bundleCollateralWrapper.getAddress());
      await expect(liquidation1.liquidationContextHash).to.equal(loanReceiptHash);

      /* Claim with accountBidder2 */
      const claim2Tx = await collateralLiquidator
        .connect(accountBidder2)
        .claim(liquidationHash, await nft1.getAddress(), 124, loanReceipt);

      /* Validate events */
      await expectEvent(claim2Tx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder2.getAddress(),
        tokenId: 124,
      });

      await expect(claim2Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          124,
          await accountBidder2.getAddress(),
          ethers.parseEther("2")
        );

      /* Validate state */
      const auction2 = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 124);
      await expect(auction2.endTime).to.equal(0n);

      const liquidation2 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation2.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation2.proceeds).to.equal(ethers.parseEther("3"));
      await expect(liquidation2.auctionCount).to.equal(1);
      await expect(liquidation2.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation2.collateralToken).to.equal(await bundleCollateralWrapper.getAddress());
      await expect(liquidation2.liquidationContextHash).to.equal(loanReceiptHash);

      /* Fast forward to after claim delay */
      const transactionTime2 = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(transactionTime2 + 86400 + 2 + 86400);

      /* Claim with accountBidder1 (even though winner is accountBidder3) */
      const claim3Tx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 125, loanReceipt);

      /* Validate events */
      await expectEvent(claim3Tx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder3.getAddress(),
        tokenId: 125,
      });

      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          125,
          await accountBidder3.getAddress(),
          ethers.parseEther("3")
        );

      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("6"));

      await expect(claim3Tx)
        .to.emit(testCollateralLiquidatorJig, "CollateralLiquidated")
        .withArgs(ethers.parseEther("6"));

      await expectEvent(claim3Tx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await testCollateralLiquidatorJig.getAddress(),
        value: ethers.parseEther("6"),
      });

      /* Validate state */
      const auction3 = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 125);
      await expect(auction3.endTime).to.equal(0n);

      const liquidation3 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation3.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.proceeds).to.equal(0n);
      await expect(liquidation3.auctionCount).to.equal(0);
      await expect(liquidation3.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.liquidationContextHash).to.equal(ethers.ZeroHash);
    });

    it("claims as non-winner", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time + claim delay of 24 */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1 + 86400);

      /* Claim with accountBidder2 */
      const claimTx = await collateralLiquidator
        .connect(accountBidder2)
        .claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt);

      /* Validate events */
      await expect(claimTx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          122,
          await accountBidder1.getAddress(),
          ethers.parseEther("2")
        );

      await expect(claimTx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("2"));

      await expect(claimTx)
        .to.emit(testCollateralLiquidatorJig, "CollateralLiquidated")
        .withArgs(ethers.parseEther("2"));

      await expectEvent(claimTx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await testCollateralLiquidatorJig.getAddress(),
        value: ethers.parseEther("2"),
      });

      /* Validate state */
      const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 122);
      await expect(auction.endTime).to.equal(0n);

      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation.proceeds).to.equal(0n);
      await expect(liquidation.auctionCount).to.equal(0);
      await expect(liquidation.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.liquidationContextHash).to.equal(ethers.ZeroHash);
    });

    it("claims collateral liquidated by EOA", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 129, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await collateralLiquidator
        .connect(accountBidder1)
        .liquidate(await tok1.getAddress(), await nft1.getAddress(), 129, "0x", loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 129, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claimTx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 129, loanReceipt);

      /* Validate events */
      await expectEvent(claimTx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        tokenId: 129,
      });

      await expect(claimTx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          129,
          await accountBidder1.getAddress(),
          ethers.parseEther("2")
        );

      await expect(claimTx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("2"));

      await expectEvent(claimTx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        value: ethers.parseEther("2"),
      });

      /* Validate state */
      const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 129);
      await expect(auction.endTime).to.equal(0n);

      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation.proceeds).to.equal(0n);
      await expect(liquidation.auctionCount).to.equal(0n);
      await expect(liquidation.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.liquidationContextHash).to.equal(ethers.ZeroHash);
    });

    it("partial successful claim originating from a contract that does not implement onCollateralLiquidate", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 131, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJigTruncated.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 131, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claimTx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 131, loanReceipt);

      /* Validate events */
      await expectEvent(claimTx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        tokenId: 131,
      });

      await expect(claimTx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await nft1.getAddress(),
          131,
          await accountBidder1.getAddress(),
          ethers.parseEther("2")
        );

      await expect(claimTx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("2"));

      await expectEvent(claimTx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await testCollateralLiquidatorJigTruncated.getAddress(),
        value: ethers.parseEther("2"),
      });

      /* Validate state */
      const auction = await collateralLiquidator.auctions(liquidationHash, await nft1.getAddress(), 131);
      await expect(auction.endTime).to.equal(0n);

      const liquidation = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation.proceeds).to.equal(0n);
      await expect(liquidation.auctionCount).to.equal(0n);
      await expect(liquidation.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation.liquidationContextHash).to.equal(ethers.ZeroHash);
    });

    it("claims erc155 collateral", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [123, 124, 125];
      const tokenIdQuantities = [1, 2, 3];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "uint256[]", "uint256[]"],
        [await erc1155.getAddress(), 0, 6, tokenIds, tokenIdQuantities]
      );

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await erc1155CollateralWrapper.getAddress(),
          erc1155TokenId,
          ethers.getBytes(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.solidityPackedKeccak256(
        ["bytes"],
        [ethers.solidityPacked(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          await testCollateralLiquidatorJig.getAddress(),
          loanReceiptHash,
          await tok1.getAddress(),
          await erc1155CollateralWrapper.getAddress(),
          erc1155TokenId,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated", index)).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await erc1155.getAddress(), 123, ethers.parseEther("1"));

      /* Bid with accountBidder2 */
      await collateralLiquidator
        .connect(accountBidder2)
        .bid(liquidationHash, await erc1155.getAddress(), 124, ethers.parseEther("2"));

      /* Bid with accountBidder3 */
      await collateralLiquidator
        .connect(accountBidder3)
        .bid(liquidationHash, await erc1155.getAddress(), 125, ethers.parseEther("3"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claim1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await erc1155.getAddress(), 123, loanReceipt);

      /* Validate events */
      await expectEvent(claim1Tx, erc1155, "TransferSingle", {
        operator: await collateralLiquidator.getAddress(),
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder1.getAddress(),
        id: 123,
        value: 1,
      });

      await expect(claim1Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await erc1155.getAddress(),
          123,
          await accountBidder1.getAddress(),
          ethers.parseEther("1")
        );

      /* Validate state */
      const auction1 = await collateralLiquidator.auctions(liquidationHash, await erc1155.getAddress(), 123);
      await expect(auction1.endTime).to.equal(0n);

      const liquidation1 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation1.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation1.proceeds).to.equal(ethers.parseEther("1"));
      await expect(liquidation1.auctionCount).to.equal(2);
      await expect(liquidation1.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation1.collateralToken).to.equal(await erc1155CollateralWrapper.getAddress());
      await expect(liquidation1.liquidationContextHash).to.equal(loanReceiptHash);

      const accountBidder1Balance = await erc1155.balanceOf(await accountBidder1.getAddress(), 123);
      await expect(accountBidder1Balance).to.equal(1);

      /* Claim with accountBidder2 */
      const claim2Tx = await collateralLiquidator
        .connect(accountBidder2)
        .claim(liquidationHash, await erc1155.getAddress(), 124, loanReceipt);

      /* Validate events */
      await expectEvent(claim2Tx, erc1155, "TransferSingle", {
        operator: await collateralLiquidator.getAddress(),
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder2.getAddress(),
        id: 124,
        value: 2,
      });

      await expect(claim2Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await erc1155.getAddress(),
          124,
          await accountBidder2.getAddress(),
          ethers.parseEther("2")
        );

      /* Validate state */
      const auction2 = await collateralLiquidator.auctions(liquidationHash, await erc1155.getAddress(), 124);
      await expect(auction2.endTime).to.equal(0n);

      const liquidation2 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation2.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation2.proceeds).to.equal(ethers.parseEther("3"));
      await expect(liquidation2.auctionCount).to.equal(1);
      await expect(liquidation2.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation2.collateralToken).to.equal(await erc1155CollateralWrapper.getAddress());
      await expect(liquidation2.liquidationContextHash).to.equal(loanReceiptHash);

      const accountBidder2Balance = await erc1155.balanceOf(await accountBidder2.getAddress(), 124);
      await expect(accountBidder2Balance).to.equal(2);

      /* Claim with accountBidder3 */
      const claim3Tx = await collateralLiquidator
        .connect(accountBidder3)
        .claim(liquidationHash, await erc1155.getAddress(), 125, loanReceipt);

      /* Validate events */
      await expectEvent(claim3Tx, erc1155, "TransferSingle", {
        operator: await collateralLiquidator.getAddress(),
        from: await collateralLiquidator.getAddress(),
        to: await accountBidder3.getAddress(),
        id: 125,
        value: 3,
      });

      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          await erc1155.getAddress(),
          125,
          await accountBidder3.getAddress(),
          ethers.parseEther("3")
        );

      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.parseEther("6"));

      await expect(claim3Tx)
        .to.emit(testCollateralLiquidatorJig, "CollateralLiquidated")
        .withArgs(ethers.parseEther("6"));

      await expectEvent(claim3Tx, tok1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await testCollateralLiquidatorJig.getAddress(),
        value: ethers.parseEther("6"),
      });

      /* Validate state */
      const auction3 = await collateralLiquidator.auctions(liquidationHash, await erc1155.getAddress(), 125);
      await expect(auction3.endTime).to.equal(0n);

      const liquidation3 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation3.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.proceeds).to.equal(0n);
      await expect(liquidation3.auctionCount).to.equal(0);
      await expect(liquidation3.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.liquidationContextHash).to.equal(ethers.ZeroHash);

      const accountBidder3Balance = await erc1155.balanceOf(await accountBidder3.getAddress(), 125);
      await expect(accountBidder3Balance).to.equal(3);
    });

    it("fails when liquidation source contract reverts during onCollateralLiquidated", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 130, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJigRevert.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 130, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      await expect(
        collateralLiquidator.connect(accountBidder1).claim(liquidationHash, await nft1.getAddress(), 130, loanReceipt)
      ).to.be.revertedWithCustomError(testCollateralLiquidatorJigRevert, "ForceRevert");
    });

    it("fails claim before end time", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Claim with accountBidder1 */
      await expect(
        collateralLiquidator.connect(accountBidder1).claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidClaim");
    });

    it("fails claim as non-winner before claim delay", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder2 */
      await expect(
        collateralLiquidator.connect(accountBidder2).claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidClaim");
    });

    it("fails claim before auction started", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Claim with accountBidder1 */
      await expect(
        collateralLiquidator.connect(accountBidder1).claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidClaim");
    });

    it("fails claim on invalid auction", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Claim fails with invalid auction */
      await expect(
        collateralLiquidator
          .connect(accountBidder1)
          .claim(
            "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefe",
            await nft1.getAddress(),
            122,
            loanReceipt
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidAuction");
    });

    it("fails claim on invalid liquidation context", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim fails with invalid liquidation context */
      await expect(
        collateralLiquidator.connect(accountBidder1).claim(liquidationHash, await nft1.getAddress(), 122, "0x112233")
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidClaim");
    });

    it("fails claim after successful claim before", async function () {
      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get liquidationHash */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args[0];

      /* Bid with accountBidder1 */
      const bidTx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, await nft1.getAddress(), 122, ethers.parseEther("2"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bidTx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim successfully as accountBidder1 */
      await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt);

      /* Claim with accountBidder1 */
      await expect(
        collateralLiquidator.connect(accountBidder1).claim(liquidationHash, await nft1.getAddress(), 122, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidAuction");
    });
  });
});
