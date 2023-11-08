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
  let punkTokenId: ethers.BigNumber;

  /* Constants */
  const PUNK_ID_1 = ethers.BigNumber.from("117");
  const PUNK_ID_2 = ethers.BigNumber.from("20");
  const PUNK_ID_3 = ethers.BigNumber.from("28");
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
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    /* Get punk */
    cryptoPunksMarket = (await ethers.getContractAt("ICryptoPunksMarket", PUNKS_ADDRESS)) as ICryptoPunksMarket;

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.deployed();

    /* Deploy punk collateral wrapper */
    punkCollateralWrapper = (await punkCollateralWrapperFactory.deploy(
      PUNKS_ADDRESS,
      WPUNKS_ADDRESS
    )) as PunkCollateralWrapper;
    await punkCollateralWrapper.deployed();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await englishAuctionCollateralLiquidatorFactory.deploy([
      punkCollateralWrapper.address,
    ]);
    await collateralLiquidatorImpl.deployed();

    /* Deploy collateral liquidator */
    const proxy = await testProxyFactory.deploy(
      collateralLiquidatorImpl.address,
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [
        ethers.BigNumber.from(86400),
        ethers.BigNumber.from(60 * 10),
        ethers.BigNumber.from(60 * 20),
        ethers.BigNumber.from(199),
      ])
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "EnglishAuctionCollateralLiquidator",
      proxy.address
    )) as EnglishAuctionCollateralLiquidator;

    /* Deploy collateral liquidator testing jig */
    testCollateralLiquidatorJig = await testCollateralLiquidatorJigFactory.deploy(
      tok1.address,
      collateralLiquidator.address
    );
    await testCollateralLiquidatorJig.deployed();

    /* Deploy collateral liquidator testing jig that reverts onCollateralLiquidate */
    testCollateralLiquidatorJigRevert = await testCollateralLiquidatorJigFactory.deploy(
      tok1.address,
      collateralLiquidator.address
    );
    await testCollateralLiquidatorJigRevert.deployed();

    accountLiquidator = await ethers.getImpersonatedSigner(PUNK_OWNER);
    accountBidder1 = accounts[4];
    accountBidder2 = accounts[5];
    accountBidder3 = accounts[6];

    /* Transfer token to liquidator account and bidder accounts */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("200"));
    await tok1.transfer(accountBidder1.address, ethers.utils.parseEther("200"));
    await tok1.transfer(accountBidder2.address, ethers.utils.parseEther("200"));
    await tok1.transfer(accountBidder3.address, ethers.utils.parseEther("200"));

    /* Approve collateral liquidator to transfer token */
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
    await tok1.connect(accountBidder1).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
    await tok1.connect(accountBidder2).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
    await tok1.connect(accountBidder3).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Approve token to transfer NFTs by offering punk for 0 ethers */
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_1, 0, punkCollateralWrapper.address);
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_2, 0, punkCollateralWrapper.address);
    await cryptoPunksMarket
      .connect(accountLiquidator)
      .offerPunkForSaleToAddress(PUNK_ID_3, 0, punkCollateralWrapper.address);

    /* Mint punk */
    const punkMintTx = await punkCollateralWrapper.connect(accountLiquidator).mint([PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]);
    punkTokenId = (await extractEvent(punkMintTx, punkCollateralWrapper, "PunkMinted")).args.tokenId;

    /* Transfer punk bundle collateral token to testing jig */
    await punkCollateralWrapper
      .connect(accountLiquidator)
      .transferFrom(accountLiquidator.address, testCollateralLiquidatorJig.address, punkTokenId);
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
    principal: ethers.BigNumber.from("3000000000000000000"),
    repayment: ethers.BigNumber.from("3040000000000000000"),
    adminFee: ethers.BigNumber.from("2000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: ethers.constants.AddressZero /* To be populated */,
    collateralTokenId: 0 /* To be populated */,
    collateralWrapperContextLen: 0,
    collateralWrapperContext: "0x",
    nodeReceipts: [
      {
        tick: ethers.BigNumber.from("1000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        tick: ethers.BigNumber.from("2000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        tick: ethers.BigNumber.from("3000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1020000000000000000"),
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

  async function getBlockTimestamp(blockNumber: ethers.BigNumber): Promise<ethers.BigNumber> {
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
      const collateralWrapperContext = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          punkCollateralWrapper.address,
          punkTokenId,
          ethers.utils.arrayify(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.utils.solidityKeccak256(
        ["bytes"],
        [ethers.utils.solidityPack(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          testCollateralLiquidatorJig.address,
          loanReceiptHash,
          tok1.address,
          punkCollateralWrapper.address,
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
        await expect(auction.highestBidder).to.equal(ethers.constants.AddressZero);
        await expect(auction.quantity).to.equal(1);
      }
    });
  });

  describe("#claim", async function () {
    it("claims punk collateral", async function () {
      /* Underlying collateral token IDs */
      const tokenIds = [PUNK_ID_1, PUNK_ID_2, PUNK_ID_3];

      /* Construct collateral wrapper context */
      const collateralWrapperContext = ethers.utils.solidityPack(["uint256[]"], [[PUNK_ID_1, PUNK_ID_2, PUNK_ID_3]]);

      /* Construct loan receipt */
      const loanReceipt = await loanReceiptLibrary.encode(
        makeLoanReceipt(
          punkCollateralWrapper.address,
          punkTokenId,
          ethers.utils.arrayify(collateralWrapperContext).length,
          collateralWrapperContext
        )
      );

      /* Construct loan receipt hash */
      const loanReceiptHash = ethers.utils.solidityKeccak256(
        ["bytes"],
        [ethers.utils.solidityPack(["uint256", "bytes"], [network.config.chainId, loanReceipt])]
      );

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const liquidationHash = (await extractEvent(liquidateTx, collateralLiquidator, "LiquidationStarted")).args[0];
      await expect(liquidateTx)
        .to.emit(collateralLiquidator, "LiquidationStarted")
        .withArgs(
          liquidationHash,
          testCollateralLiquidatorJig.address,
          loanReceiptHash,
          tok1.address,
          punkCollateralWrapper.address,
          3
        );
      for (const [index, tokenId] of tokenIds.entries()) {
        const eventArgs = (await extractEvent(liquidateTx, collateralLiquidator, "AuctionCreated", index)).args;
        await expect(eventArgs[0]).to.equal(liquidationHash);
      }

      /* Bid with accountBidder1 */
      const bid1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1, ethers.utils.parseEther("1"));

      /* Bid with accountBidder2 */
      await collateralLiquidator
        .connect(accountBidder2)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2, ethers.utils.parseEther("2"));

      /* Bid with accountBidder3 */
      await collateralLiquidator
        .connect(accountBidder3)
        .bid(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3, ethers.utils.parseEther("3"));

      /* Fast forward to 1 second after end time */
      const transactionTime = await getBlockTimestamp(bid1Tx.blockNumber);
      await helpers.time.increaseTo(transactionTime + 86400 + 1);

      /* Claim with accountBidder1 */
      const claim1Tx = await collateralLiquidator
        .connect(accountBidder1)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1, loanReceipt);

      /* Validate events */
      await expect(claim1Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1, accountBidder1.address, ethers.utils.parseEther("1"));

      /* Validate state */
      const auction1 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_1);
      await expect(auction1.endTime).to.equal(ethers.constants.Zero);

      const liquidation1 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation1.source).to.equal(testCollateralLiquidatorJig.address);
      await expect(liquidation1.proceeds).to.equal(ethers.utils.parseEther("1"));
      await expect(liquidation1.auctionCount).to.equal(2);
      await expect(liquidation1.currencyToken).to.equal(tok1.address);
      await expect(liquidation1.collateralToken).to.equal(punkCollateralWrapper.address);
      await expect(liquidation1.liquidationContextHash).to.equal(loanReceiptHash);

      const ownerOfPunk1 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_1);
      await expect(ownerOfPunk1).to.equal(accountBidder1.address);

      /* Claim with accountBidder2 */
      const claim2Tx = await collateralLiquidator
        .connect(accountBidder2)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2, loanReceipt);

      /* Validate events */
      await expect(claim2Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2, accountBidder2.address, ethers.utils.parseEther("2"));

      /* Validate state */
      const auction2 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_2);
      await expect(auction2.endTime).to.equal(ethers.constants.Zero);

      const liquidation2 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation2.source).to.equal(testCollateralLiquidatorJig.address);
      await expect(liquidation2.proceeds).to.equal(ethers.utils.parseEther("3"));
      await expect(liquidation2.auctionCount).to.equal(1);
      await expect(liquidation2.currencyToken).to.equal(tok1.address);
      await expect(liquidation2.collateralToken).to.equal(punkCollateralWrapper.address);
      await expect(liquidation2.liquidationContextHash).to.equal(loanReceiptHash);

      const ownerOfPunk2 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_2);
      await expect(ownerOfPunk2).to.equal(accountBidder2.address);

      /* Claim with accountBidder3 */
      const claim3Tx = await collateralLiquidator
        .connect(accountBidder3)
        .claim(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3, loanReceipt);

      /* Validate events */
      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "AuctionEnded")
        .withArgs(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3, accountBidder3.address, ethers.utils.parseEther("3"));

      await expect(claim3Tx)
        .to.emit(collateralLiquidator, "LiquidationEnded")
        .withArgs(liquidationHash, ethers.utils.parseEther("6"));

      await expect(claim3Tx)
        .to.emit(testCollateralLiquidatorJig, "CollateralLiquidated")
        .withArgs(ethers.utils.parseEther("6"));

      await expectEvent(claim3Tx, tok1, "Transfer", {
        from: collateralLiquidator.address,
        to: testCollateralLiquidatorJig.address,
        value: ethers.utils.parseEther("6"),
      });

      /* Validate state */
      const auction3 = await collateralLiquidator.auctions(liquidationHash, WPUNKS_ADDRESS, PUNK_ID_3);
      await expect(auction3.endTime).to.equal(ethers.constants.Zero);

      const liquidation3 = await collateralLiquidator.liquidations(liquidationHash);
      await expect(liquidation3.source).to.equal(ethers.constants.AddressZero);
      await expect(liquidation3.proceeds).to.equal(ethers.constants.Zero);
      await expect(liquidation3.auctionCount).to.equal(0);
      await expect(liquidation3.currencyToken).to.equal(ethers.constants.AddressZero);
      await expect(liquidation3.collateralToken).to.equal(ethers.constants.AddressZero);
      await expect(liquidation3.liquidationContextHash).to.equal(ethers.constants.HashZero);

      const ownerOfPunk3 = await cryptoPunksMarket.punkIndexToAddress(PUNK_ID_3);
      await expect(ownerOfPunk3).to.equal(accountBidder3.address);
    });
  });
});
