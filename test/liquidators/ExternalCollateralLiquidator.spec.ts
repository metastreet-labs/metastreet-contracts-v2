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
  let bundleTokenId: bigint;

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
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("1000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.waitForDeployment();

    /* Deploy collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.waitForDeployment();

    /* Deploy collateral liquidator */
    const proxy = await testProxyFactory.deploy(
      await collateralLiquidatorImpl.getAddress(),
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [])
    );
    await proxy.waitForDeployment();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      await proxy.getAddress()
    )) as ExternalCollateralLiquidator;

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

    accountLiquidator = accounts[0];
    accountEOA = accounts[1];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Mint NFT to testing jig to simulate default */
    await nft1.mint(await testCollateralLiquidatorJig.getAddress(), 122);

    /* Mint NFT to an EOA */
    await nft1.mint(await accountEOA.getAddress(), 129);
    await nft1.connect(accountEOA).approve(await collateralLiquidator.getAddress(), 129);

    /* Mint NFT to a testing jig that reverts onCollateralLiquidate() */
    await nft1.mint(await testCollateralLiquidatorJigRevert.getAddress(), 130);

    /* Mint NFT to a testing jig that does not implement onCollateralLiquidate() */
    await nft1.mint(await testCollateralLiquidatorJigTruncated.getAddress(), 131);

    /* Transfer token to liquidator account and EOA account */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100"));
    await tok1.transfer(await accountEOA.getAddress(), ethers.parseEther("100"));

    /* Approve collateral liquidator to transfer token */
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);
    await tok1.connect(accountEOA).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);
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

  /****************************************************************************/
  /* Primay API */
  /****************************************************************************/

  describe("#liquidate", async function () {
    it("succeeds calling liquidate on collateral", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

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
      const loanReceipt1 = await loanReceiptLibrary.encode(makeLoanReceipt(ethers.ZeroAddress, 122, 0, "0x"));

      /* Liquidate with invalid collateral token */
      await expect(
        collateralLiquidator.liquidate(await tok1.getAddress(), ethers.ZeroAddress, 122, "0x", loanReceipt1)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");

      /* Construct loan reciept */
      const loanReceipt2 = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Liquidate with invalid currency token */
      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .liquidate(ethers.ZeroAddress, await nft1.getAddress(), 122, "0x", loanReceipt2)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidToken");
    });
  });

  describe("#withdrawCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("liquidate collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get collateral hash */
      collateralHash = (await extractEvent(liquidateTx, collateralLiquidator, "CollateralReceived")).args[0];
    });

    it("succeeds on present collateral", async function () {
      /* Withdraw collateral */
      const withdrawTx = await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await testCollateralLiquidatorJig.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          "0x",
          loanReceipt
        );

      /* Validate events */
      await expectEvent(withdrawTx, nft1, "Transfer", {
        from: await collateralLiquidator.getAddress(),
        to: await accountLiquidator.getAddress(),
        tokenId: 122,
      });
      await expectEvent(withdrawTx, collateralLiquidator, "CollateralWithdrawn", {
        collateralHash,
        source: await testCollateralLiquidatorJig.getAddress(),
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
      });

      /* Validate state */
      expect(await collateralLiquidator.collateralStatus(collateralHash)).to.equal(2);
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 1, 0, "0x"));

      /* Try to withdraw non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
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
        .withdrawCollateral(
          await testCollateralLiquidatorJig.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          "0x",
          loanReceipt
        );

      /* Try to withdraw collateral again */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
            122,
            "0x",
            loanReceipt
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .withdrawCollateral(
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
            122,
            "0x",
            loanReceipt
          )
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });

  describe("#liquidateCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("liquidate collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 122, 0, "0x"));

      /* Calling liquidate() */
      const liquidateTx = await testCollateralLiquidatorJig.liquidate(loanReceipt);

      /* Get collateral hash */
      collateralHash = (await extractEvent(liquidateTx, collateralLiquidator, "CollateralReceived")).args[0];
    });

    it("succeeds on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await testCollateralLiquidatorJig.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral for 2.5 ETH */
      const liquidateTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await testCollateralLiquidatorJig.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          "0x",
          loanReceipt,
          ethers.parseEther("2.5")
        );

      /* Validate events */
      await expectEvent(
        liquidateTx,
        tok1,
        "Transfer",
        {
          from: await accountLiquidator.getAddress(),
          to: await collateralLiquidator.getAddress(),
          value: ethers.parseEther("2.5"),
        },
        0
      );
      await expectEvent(
        liquidateTx,
        tok1,
        "Transfer",
        {
          from: await collateralLiquidator.getAddress(),
          to: await testCollateralLiquidatorJig.getAddress(),
          value: ethers.parseEther("2.5"),
        },
        1
      );

      await expectEvent(liquidateTx, collateralLiquidator, "CollateralLiquidated", {
        collateralHash,
        collateralToken: await nft1.getAddress(),
        collateralTokenId: 122,
        proceeds: ethers.parseEther("2.5"),
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
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
            122,
            "0x",
            loanReceipt,
            ethers.parseEther("2.5")
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(await nft1.getAddress(), 1, 0, "0x"));

      /* Try to liquidate non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
            1,
            "0x",
            loanReceipt,
            ethers.parseEther("2.5")
          )
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });

    it("fails on invalid caller", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await testCollateralLiquidatorJig.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          122,
          "0x",
          loanReceipt
        );

      await expect(
        collateralLiquidator
          .connect(accountEOA)
          .liquidateCollateral(
            await testCollateralLiquidatorJig.getAddress(),
            await tok1.getAddress(),
            await nft1.getAddress(),
            122,
            "0x",
            loanReceipt,
            ethers.parseEther("2.5")
          )
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });
});
