import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  LoanReceipt,
  TestCollateralLiquidatorJig,
  ExternalCollateralLiquidator,
} from "../../typechain";

import { expectEvent } from "../helpers/EventUtilities";

describe("ExternalCollateralLiquidator", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLibrary: TestLoanReceipt;
  let testCollateralLiquidatorJig: TestCollateralLiquidatorJig;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let snapshotId: string;
  let accountLiquidator: SignerWithAddress;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("1000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.deployed();

    /* Deploy collateral liquidator testing jig */
    testCollateralLiquidatorJig = await testCollateralLiquidatorJigFactory.deploy(tok1.address);
    await testCollateralLiquidatorJig.deployed();

    /* Deploy external collateral liquidator */
    collateralLiquidator = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidator.deployed();

    /* Add testing jig as approved pool to collateral liquidator */
    await collateralLiquidator.addPool(testCollateralLiquidatorJig.address);

    /* Mint NFT to testing jig to simulate default */
    await nft1.mint(testCollateralLiquidatorJig.address, 123);
    await nft1.mint(testCollateralLiquidatorJig.address, 456);

    accountLiquidator = accounts[3];

    /* Transfer ownership to liquidator */
    await collateralLiquidator.transferOwnership(accountLiquidator.address);

    /* Transfer token to liquidator account */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));

    /* Approve collateral liquidator to transfer token */
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected name", async function () {
      expect(await collateralLiquidator.name()).to.equal("ExternalCollateralLiquidator");
    });
  });

  const loanReceiptTemplate: LoanReceipt = {
    version: 1,
    platform: "0x8552B1f50a85ae8e5198Cb286c435bb0cb951de5",
    loanId: 123,
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: ethers.constants.AddressZero /* To be populated */,
    collateralTokenId: 0 /* To be populated */,
    liquidityTrail: [
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

  function makeLoanReceipt(collateralToken: string, collateralTokenId: number): LoanReceipt {
    return { ...loanReceiptTemplate, collateralToken, collateralTokenId };
  }

  describe("transfer collateral", async function () {
    it("succeeds from approved pool", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      const loanReceiptHash = await loanReceiptLibrary["hash(bytes)"](loanReceipt);

      /* Transfer collateral to collateral liquidator */
      const transferTx = await testCollateralLiquidatorJig.transferCollateral(
        collateralLiquidator.address,
        nft1.address,
        123,
        loanReceipt
      );

      /* Validate events */
      await expectEvent(transferTx, nft1, "Transfer", {
        from: testCollateralLiquidatorJig.address,
        to: collateralLiquidator.address,
        tokenId: 123,
      });

      /* Validate state */
      const collateralTracker = await collateralLiquidator.collateralTracker(loanReceiptHash);
      expect(collateralTracker.status).to.equal(1);
      expect(collateralTracker.pool).to.equal(testCollateralLiquidatorJig.address);
    });
    it("fails on invalid token id", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      await expect(
        testCollateralLiquidatorJig.transferCollateral(collateralLiquidator.address, nft1.address, 42, loanReceipt)
      ).to.be.revertedWith("ERC721: invalid token ID");
    });
    it("fails from unapproved pool", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));

      /* Remove pool */
      await collateralLiquidator.connect(accountLiquidator).removePool(testCollateralLiquidatorJig.address);

      /* Try to transfer collateral */
      await expect(
        testCollateralLiquidatorJig.transferCollateral(collateralLiquidator.address, nft1.address, 123, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCaller");
    });
  });

  describe("#withdrawCollateral", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("transfer collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      loanReceiptHash = await loanReceiptLibrary["hash(bytes)"](loanReceipt);

      /* Transfer collateral to collateral liquidator */
      await testCollateralLiquidatorJig.transferCollateral(
        collateralLiquidator.address,
        nft1.address,
        123,
        loanReceipt
      );
    });

    it("succeeds on present collateral", async function () {
      /* Withdraw collateral */
      const withdrawTx = await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Validate events */
      await expectEvent(withdrawTx, nft1, "Transfer", {
        from: collateralLiquidator.address,
        to: accountLiquidator.address,
        tokenId: 123,
      });
      await expectEvent(withdrawTx, collateralLiquidator, "CollateralWithdrawn", {
        account: accountLiquidator.address,
        collateralToken: nft1.address,
        collateralTokenId: 123,
        loanReceiptHash,
      });

      /* Validate state */
      expect((await collateralLiquidator.collateralTracker(loanReceiptHash)).status).to.equal(2);
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      /* Try to withdraw non-existent collateral */
      await expect(
        collateralLiquidator.connect(accountLiquidator).withdrawCollateral(absentLoanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Try to withdraw collateral again */
      await expect(
        collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      await expect(collateralLiquidator.withdrawCollateral(loanReceipt)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("#liquidateCollateral", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("transfer collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      loanReceiptHash = await loanReceiptLibrary["hash(bytes)"](loanReceipt);

      /* Transfer collateral to collateral liquidator */
      await testCollateralLiquidatorJig.transferCollateral(
        collateralLiquidator.address,
        nft1.address,
        123,
        loanReceipt
      );
    });

    it("succeeds on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Liquidate collateral for 2.5 ETH */
      const liquidateTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(loanReceipt, ethers.utils.parseEther("2.5"));

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
      await expectEvent(liquidateTx, testCollateralLiquidatorJig, "CollateralLiquidated", {
        proceeds: ethers.utils.parseEther("2.5"),
      });
      await expectEvent(liquidateTx, collateralLiquidator, "CollateralLiquidated", {
        account: accountLiquidator.address,
        collateralToken: nft1.address,
        collateralTokenId: 123,
        loanReceiptHash,
        proceeds: ethers.utils.parseEther("2.5"),
      });

      /* Valiate state */
      const collateralTracker = await collateralLiquidator.collateralTracker(loanReceiptHash);
      expect(collateralTracker.status).to.equal(0);
      expect(collateralTracker.pool).to.equal(ethers.constants.Zero);
    });
    it("fails on present collateral", async function () {
      /* Try to liquidate present collateral */
      await expect(
        collateralLiquidator.connect(accountLiquidator).liquidateCollateral(loanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      /* Try to liquidate non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(absentLoanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      await expect(
        collateralLiquidator.liquidateCollateral(loanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("#addPool", async function () {
    it("successfully adds pool", async function () {
      /* Create new pool */
      const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");
      const pool = await testCollateralLiquidatorJigFactory.deploy(tok1.address);
      await pool.deployed();

      /* Validate state */
      expect(await collateralLiquidator.isApprovedPool(testCollateralLiquidatorJig.address)).to.equal(true);
      expect(await collateralLiquidator.isApprovedPool(pool.address)).to.equal(false);

      /* Add pool */
      const addPoolTx = await collateralLiquidator.connect(accountLiquidator).addPool(pool.address);

      /* Validate events */
      await expectEvent(addPoolTx, tok1, "Approval", {
        owner: collateralLiquidator.address,
        spender: pool.address,
        value: ethers.constants.MaxUint256,
      });

      /* Validate state */
      expect(await collateralLiquidator.isApprovedPool(testCollateralLiquidatorJig.address)).to.equal(true);
      expect(await collateralLiquidator.isApprovedPool(pool.address)).to.equal(true);
    });
    it("fails on invalid caller", async function () {
      await expect(collateralLiquidator.addPool(testCollateralLiquidatorJig.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });

  describe("#removePool", async function () {
    it("successfully removes pool", async function () {
      /* Validate state */
      expect(await collateralLiquidator.isApprovedPool(testCollateralLiquidatorJig.address)).to.equal(true);

      /* Remove pool */
      const removePoolTx = await collateralLiquidator
        .connect(accountLiquidator)
        .removePool(testCollateralLiquidatorJig.address);

      /* Validate events */
      await expectEvent(removePoolTx, tok1, "Approval", {
        owner: collateralLiquidator.address,
        spender: testCollateralLiquidatorJig.address,
        value: ethers.constants.Zero,
      });

      /* Validate state */
      expect(await collateralLiquidator.isApprovedPool(testCollateralLiquidatorJig.address)).to.equal(false);
    });
    it("fails on invalid caller", async function () {
      await expect(collateralLiquidator.removePool(testCollateralLiquidatorJig.address)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    });
  });
});
