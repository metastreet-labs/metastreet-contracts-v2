import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestLoanReceipt,
  EnglishAuctionCollateralLiquidator,
  PunkCollateralWrapper,
  ICryptoPunksMarket,
  TestCollateralLiquidatorJig,
} from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("EnglishAuctionCollateralLiquidator", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let cryptoPunksMarket: ICryptoPunksMarket;
  let loanReceiptLibrary: TestLoanReceipt;
  let collateralLiquidator: EnglishAuctionCollateralLiquidator;
  let testCollateralLiquidatorJig: TestCollateralLiquidatorJig;
  let testCollateralLiquidatorJigRevert: TestCollateralLiquidatorJig;
  let snapshotId: string;
  let accountLiquidator: SignerWithAddress;
  let accountBidder1: SignerWithAddress;
  let accountBidder2: SignerWithAddress;
  let accountBidder3: SignerWithAddress;
  let punkCollateralWrapper: PunkCollateralWrapper;
  let punkTokenId: bigint;

  /* Constants */
  const PUNK_ID_1 = BigInt("117");
  const PUNK_ID_2 = BigInt("20");
  const PUNK_ID_3 = BigInt("28");
  const PUNK_OWNER = "0xA858DDc0445d8131daC4d1DE01f834ffcbA52Ef1"; /* Yuga Labs address */
  const PUNKS_ADDRESS = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
  const WPUNKS_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
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
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const englishAuctionCollateralLiquidatorFactory = await ethers.getContractFactory(
      "EnglishAuctionCollateralLiquidator"
    );
    const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");
    const punkCollateralWrapperFactory = await ethers.getContractFactory("PunkCollateralWrapper");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("1000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Get punk */
    cryptoPunksMarket = (await ethers.getContractAt("ICryptoPunksMarket", PUNKS_ADDRESS)) as ICryptoPunksMarket;

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.waitForDeployment();

    /* Deploy punk collateral wrapper */
    punkCollateralWrapper = (await punkCollateralWrapperFactory.deploy(
      PUNKS_ADDRESS,
      WPUNKS_ADDRESS
    )) as PunkCollateralWrapper;
    await punkCollateralWrapper.waitForDeployment();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await englishAuctionCollateralLiquidatorFactory.deploy([
      await punkCollateralWrapper.getAddress(),
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

    accountLiquidator = await ethers.getImpersonatedSigner(PUNK_OWNER);
    accountBidder1 = accounts[4];
    accountBidder2 = accounts[5];
    accountBidder3 = accounts[6];

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

    /* Approve token to transfer NFTs by offering punk for 0 ethers */
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_1, 0, await punkCollateralWrapper.getAddress());
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_2, 0, await punkCollateralWrapper.getAddress());
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_3, 0, await punkCollateralWrapper.getAddress());

    /* Mint punk */
    const punkMintTx = await punkCollateralWrapper.connect(accountLiquidator).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);
    punkTokenId = (await extractEvent(punkMintTx, punkCollateralWrapper, "PunkMinted")).args.tokenId;

    /* Transfer punk bundle collateral token to testing jig */
    await punkCollateralWrapper
      .connect(accountLiquidator)
      .transferFrom(await accountLiquidator.getAddress(), await testCollateralLiquidatorJig.getAddress(), punkTokenId);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
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
  /* Primay API */
  /****************************************************************************/

  describe("#liquidate", async function () {
    it("succeeds starting an auction on punks collateral wrapper", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [PUNK_ID_1, PUNK_ID_2, PUNK_ID_3];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.solidityPacked(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
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
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated")).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, tokenIds[0], 1)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, tokenIds[1], 1)
        .to.emit(collateralLiquidator, "AuctionCreated")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, tokenIds[2], 1);

      /* Validate state */
      for (const [index, tokenId] of tokenIds.entries()) {
        const auction = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, tokenId);
        await expect(auction.endTime).to.equal(0);
        await expect(auction.highestBid).to.equal(0);
        await expect(auction.highestBidder).to.equal(ethers.ZeroAddress);
        await expect(auction.quantity).to.equal(1);
      }
    });
  });

  describe("#claim", async function () {
    it("claims punk collateral", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [PUNK_ID_1, PUNK_ID_2, PUNK_ID_3];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.solidityPacked(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
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
          await punkCollateralWrapper.getAddress(),
          punkTokenId,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated", index)).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1, ethers.parseEther("1"));

      /* Bid with accountBidder2 */
      await collateralLiquidator
        .connect(accountBidder2)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2, ethers.parseEther("2"));

      /* Bid with accountBidder3 */
      await collateralLiquidator
        .connect(accountBidder3)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3, ethers.parseEther("3"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(BigInt(transactionTime) + 86400n + 1n);

      /* Claim with accountBidder1 */
      const claim1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1, loanReceipt);

      /* Validate events */
      await expect(claim1Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          WPUNKS_ADDRESS,
          PUNK_ID_1,
          await accountBidder1.getAddress(),
          ethers.parseEther("1")
        );

      /* Validate state */
      const auction1 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1);
      await expect(auction1.endTime).to.equal(0n);

      const liquidation1 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation1.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation1.proceeds).to.equal(ethers.parseEther("1"));
      await expect(liquidation1.auctionCount).to.equal(2);
      await expect(liquidation1.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation1.collateralToken).to.equal(await punkCollateralWrapper.getAddress());
      await expect(liquidation1.liquidationContextHash).to.equal(loanReceiptHash);

      const ownerOfPunk1 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_1);
      await expect(ownerOfPunk1).to.equal(await accountBidder1.getAddress());

      /* Claim with accountBidder2 */
      const claim2Tx = await collateralLiquidator
        .connect(accountBidder2)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2, loanReceipt);

      /* Validate events */
      await expect(claim2Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          WPUNKS_ADDRESS,
          PUNK_ID_2,
          await accountBidder2.getAddress(),
          ethers.parseEther("2")
        );

      /* Validate state */
      const auction2 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2);
      await expect(auction2.endTime).to.equal(0n);

      const liquidation2 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation2.source).to.equal(await testCollateralLiquidatorJig.getAddress());
      await expect(liquidation2.proceeds).to.equal(ethers.parseEther("3"));
      await expect(liquidation2.auctionCount).to.equal(1);
      await expect(liquidation2.currencyToken).to.equal(await tok1.getAddress());
      await expect(liquidation2.collateralToken).to.equal(await punkCollateralWrapper.getAddress());
      await expect(liquidation2.liquidationContextHash).to.equal(loanReceiptHash);

      const ownerOfPunk2 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_2);
      await expect(ownerOfPunk2).to.equal(await accountBidder2.getAddress());

      /* Claim with accountBidder3 */
      const claim3Tx = await collateralLiquidator
        .connect(accountBidder3)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3, loanReceipt);

      /* Validate events */
      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(
          liquidationHash,
          WPUNKS_ADDRESS,
          PUNK_ID_3,
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
      const auction3 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3);
      await expect(auction3.endTime).to.equal(0n);

      const liquidation3 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation3.source).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.proceeds).to.equal(0n);
      await expect(liquidation3.auctionCount).to.equal(0);
      await expect(liquidation3.currencyToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.collateralToken).to.equal(ethers.ZeroAddress);
      await expect(liquidation3.liquidationContextHash).to.equal(ethers.ZeroHash);

      const ownerOfPunk3 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_3);
      await expect(ownerOfPunk3).to.equal(await accountBidder3.getAddress());
    });
  });
});
