import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  ExternalCollateralLiquidator,
  TestCollateralLiquidatorJig,
  TestCollateralLiquidatorJigTruncated,
} from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";

describe("ExternalCollateralLiquidator", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLibrary: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let testCollateralLiquidatorJig: TestCollateralLiquidatorJig;
  let testCollateralLiquidatorJigRevert: TestCollateralLiquidatorJig;
  let testCollateralLiquidatorJigTruncated: TestCollateralLiquidatorJigTruncated;
  let snapshotId: string;
  let accountLiquidator: SignerWithAddress;
  let accountEOA: SignerWithAddress;
  let bundleTokenId: ethers.BigNumber;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");
    const testCollateralLiquidatorJigTruncatedFactory = await ethers.getContractFactory(
      "TestCollateralLiquidatorJigTruncated"
    );

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.deployed();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy collateral liquidator */
    const proxy = await testProxyFactory.deploy(
      collateralLiquidatorImpl.address,
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [])
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

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

    /* Deploy collateral liquidator testing jig that does not implement onCollateralLiquidate */
    testCollateralLiquidatorJigTruncated = await testCollateralLiquidatorJigTruncatedFactory.deploy(
      tok1.address,
      collateralLiquidator.address
    );
    await testCollateralLiquidatorJigRevert.deployed();

    accountLiquidator = accounts[0];
    accountEOA = accounts[1];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

    /* Mint NFT to testing jig to simulate default */
    await nft1.mint(testCollateralLiquidatorJig.address, 122);

    /* Mint NFT to an EOA */
    await nft1.mint(accountEOA.address, 129);
    await nft1.connect(accountEOA).approve(collateralLiquidator.address, 129);

    /* Mint NFT to a testing jig that reverts onCollateralLiquidate() */
    await nft1.mint(testCollateralLiquidatorJigRevert.address, 130);

    /* Mint NFT to a testing jig that does not implement onCollateralLiquidate() */
    await nft1.mint(testCollateralLiquidatorJigTruncated.address, 131);

    /* Transfer token to liquidator account and EOA account */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.transfer(accountEOA.address, ethers.utils.parseEther("100"));

    /* Approve collateral liquidator to transfer token */
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
    await tok1.connect(accountEOA).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
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
      expect(await collateralLiquidator.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("matches expected name", async function () {
      expect(await collateralLiquidator.name()).to.equal("ExternalCollateralLiquidator");
    });
  });

  /****************************************************************************/
  /* Helper Functions */
  /****************************************************************************/

  const loanReceiptTemplate = {
    version: 1,
    principal: ethers.BigNumber.from("3000000000000000000"),
    repayment: ethers.BigNumber.from("3040000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: ethers.constants.AddressZero /* To be populated */,
    collateralTokenId: 0 /* To be populated */,
    collateralContextLength: 0,
    collateralContextData: "0x",
    nodeReceipts: [
      {
        depth: ethers.BigNumber.from("1000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        depth: ethers.BigNumber.from("2000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        depth: ethers.BigNumber.from("3000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1020000000000000000"),
      },
    ],
  };

  function makeLoanReceipt(
    collateralToken: string,
    collateralTokenId: number,
    collateralContextLength: number,
    collateralContextData: string
  ) {
    return {
      ...loanReceiptTemplate,
      collateralToken,
      collateralTokenId,
      collateralContextLength,
      collateralContextData,
    };
  }

  /****************************************************************************/
  /* Primay API */
  /****************************************************************************/

  describe("#liquidate", async function () {
    it("succeeds calling liquidate on collateral", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Validate events */
      const collateralHash = (await extractEvent(liquidateTx, collateralLiquidator, "CollateralReceived")).args[0];

      /* Validate state */
      const collateralStatus = await collateralLiquidator.collateralStatus(collateralHash);
      await expect(collateralStatus).to.equal(1);
    });

    it("fails with invalid token", async function () {
      /* Construct loan reciept */
      const loanReceipt1 = await loanReceiptLibrary.encode(makeLoanReceipt(ethers.constants.AddressZero, 122, 0, "0x"));

      /* Liquidate with invalid collateral token */
      await expect(
        collateralLiquidator.liquidate(tok1.address, ethers.constants.AddressZero, 122, "0x", loanReceipt1)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");

      /* Construct loan reciept */
      const loanReceipt2 = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 122, 0, "0x"));

      /* Liquidate with invalid currency token */
      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .liquidate(ethers.constants.AddressZero, nft1.address, 122, "0x", loanReceipt2)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");
    });
  });

  describe("#withdrawCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("liquidate collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get collateral hash */
      collateralHash = (await extractEvent(liquidateTx, collateralLiquidator, "CollateralReceived")).args[0];
    });

    it("succeeds on present collateral", async function () {
      /* Withdraw collateral */
      const withdrawTx = await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt);

      /* Validate events */
      await expectEvent(withdrawTx, nft1, "Transfer", {
        from: collateralLiquidator.address,
        to: accountLiquidator.address,
        tokenId: 122,
      });
      await expectEvent(withdrawTx, collateralLiquidator, "CollateralWithdrawn", {
        collateralHash,
        source: testCollateralLiquidatorJig.address,
        collateralToken: nft1.address,
        collateralTokenId: 122,
      });

      /* Validate state */
      expect(await collateralLiquidator.collateralStatus(collateralHash)).to.equal(2);
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 1, 0, "0x"));

      /* Try to withdraw non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(
            testCollateralLiquidatorJig.address,
            tok1.address,
            nft1.address,
            1,
            "0x",
            absentLoanReceipt
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });

    it("fails on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt);

      /* Try to withdraw collateral again */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt)
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });

  describe("#liquidateCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("liquidate collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get collateral hash */
      collateralHash = (await extractEvent(liquidateTx, collateralLiquidator, "CollateralReceived")).args[0];
    });

    it("succeeds on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt);

      /* Liquidate collateral for 2.5 ETH */
      const liquidateTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          testCollateralLiquidatorJig.address,
          tok1.address,
          nft1.address,
          122,
          "0x",
          loanReceipt,
          ethers.utils.parseEther("2.5")
        );

      /* Validate events */
      await expectEvent(
        liquidateTx,
        tok1,
        "Transfer",
        {
          from: accountLiquidator.address,
          to: collateralLiquidator.address,
          value: ethers.utils.parseEther("2.5"),
        },
        0
      );
      await expectEvent(
        liquidateTx,
        tok1,
        "Transfer",
        {
          from: collateralLiquidator.address,
          to: testCollateralLiquidatorJig.address,
          value: ethers.utils.parseEther("2.5"),
        },
        1
      );

      await expectEvent(liquidateTx, collateralLiquidator, "CollateralLiquidated", {
        collateralHash,
        collateralToken: nft1.address,
        collateralTokenId: 122,
        proceeds: ethers.utils.parseEther("2.5"),
      });

      /* Valiate state */
      expect(await collateralLiquidator.collateralStatus(collateralHash)).to.equal(0);
    });
    it("fails on present collateral", async function () {
      /* Try to liquidate present collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(
            testCollateralLiquidatorJig.address,
            tok1.address,
            nft1.address,
            122,
            "0x",
            loanReceipt,
            ethers.utils.parseEther("2.5")
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 1, 0, "0x"));

      /* Try to liquidate non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(
            testCollateralLiquidatorJig.address,
            tok1.address,
            nft1.address,
            1,
            "0x",
            loanReceipt,
            ethers.utils.parseEther("2.5")
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });

    it("fails on invalid caller", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, tok1.address, nft1.address, 122, "0x", loanReceipt);

      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .liquidateCollateral(
            testCollateralLiquidatorJig.address,
            tok1.address,
            nft1.address,
            122,
            "0x",
            loanReceipt,
            ethers.utils.parseEther("2.5")
          )
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });
});
