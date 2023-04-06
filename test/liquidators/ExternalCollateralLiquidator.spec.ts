import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestProxy,
  ExternalCollateralLiquidator,
  TestCollateralLiquidatorJig,
} from "../../typechain";

import { expectEvent } from "../helpers/EventUtilities";

describe("ExternalCollateralLiquidator", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLibrary: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let testCollateralLiquidatorJig: TestCollateralLiquidatorJig;
  let snapshotId: string;
  let accountLiquidator: SignerWithAddress;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const testCollateralLiquidatorJigFactory = await ethers.getContractFactory("TestCollateralLiquidatorJig");

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
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize")
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

    /* Mint NFT to testing jig to simulate default */
    await nft1.mint(testCollateralLiquidatorJig.address, 123);
    await nft1.mint(testCollateralLiquidatorJig.address, 456);

    /* Arrange accounts */
    accountLiquidator = accounts[3];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

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
    it("matches expected implementation", async function () {
      expect(await collateralLiquidator.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("matches expected name", async function () {
      expect(await collateralLiquidator.name()).to.equal("ExternalCollateralLiquidator");
    });
  });

  const loanReceiptTemplate = {
    version: 1,
    platform: "0x8552B1f50a85ae8e5198Cb286c435bb0cb951de5",
    loanId: 123,
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

  function makeLoanReceipt(collateralToken: string, collateralTokenId: number) {
    return { ...loanReceiptTemplate, collateralToken, collateralTokenId };
  }

  describe("transfer collateral", async function () {
    it("succeeds from pool", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      const collateralHash = ethers.utils.solidityKeccak256(
        ["uint256", "address", "bytes"],
        [network.config.chainId, testCollateralLiquidatorJig.address, loanReceipt]
      );

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
      await expectEvent(transferTx, collateralLiquidator, "CollateralReceived", {
        collateralHash,
        pool: testCollateralLiquidatorJig.address,
        collateralToken: nft1.address,
        collateralTokenId: 123,
      });

      /* Validate state */
      expect(await collateralLiquidator.collateralStatus(collateralHash)).to.equal(1);
    });
    it("fails on invalid token id", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      /* Transfer different token ID than in loan receipt */
      await expect(
        testCollateralLiquidatorJig.transferCollateral(collateralLiquidator.address, nft1.address, 123, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidTransfer");
    });
    it("fails on missing token transfer", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));

      /* Call onERC721Received() directly without transfer */
      await expect(
        collateralLiquidator.onERC721Received(accounts[0].address, accounts[0].address, 123, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidTransfer");
    });
    it("fails on existing collateral", async function () {
      /* Construct loan reciept */
      const loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));

      /* Transfer collateral to collateral liquidator */
      await testCollateralLiquidatorJig.transferCollateral(
        collateralLiquidator.address,
        nft1.address,
        123,
        loanReceipt
      );

      /* Call onERC721Received() directly again */
      expect(
        await collateralLiquidator.onERC721Received(accounts[0].address, accounts[0].address, 123, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidTransfer");
    });
  });

  describe("#withdrawCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("transfer collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      collateralHash = ethers.utils.solidityKeccak256(
        ["uint256", "address", "bytes"],
        [network.config.chainId, testCollateralLiquidatorJig.address, loanReceipt]
      );

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
      const withdrawTx = await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt);

      /* Validate events */
      await expectEvent(withdrawTx, nft1, "Transfer", {
        from: collateralLiquidator.address,
        to: accountLiquidator.address,
        tokenId: 123,
      });
      await expectEvent(withdrawTx, collateralLiquidator, "CollateralWithdrawn", {
        collateralHash,
        pool: testCollateralLiquidatorJig.address,
        collateralToken: nft1.address,
        collateralTokenId: 123,
      });

      /* Validate state */
      expect(await collateralLiquidator.collateralStatus(collateralHash)).to.equal(2);
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      /* Try to withdraw non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(testCollateralLiquidatorJig.address, absentLoanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on wrong pool", async function () {
      await expect(
        collateralLiquidator.connect(accountLiquidator).withdrawCollateral(accounts[5].address, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on withdrawn collateral", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt);

      /* Try to withdraw collateral again */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt)
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      await expect(
        collateralLiquidator.withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt)
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });

  describe("#liquidateCollateral", async function () {
    let loanReceipt: string;
    let collateralHash: string;

    beforeEach("transfer collateral", async function () {
      /* Construct loan reciept */
      loanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 123));
      collateralHash = ethers.utils.solidityKeccak256(
        ["uint256", "address", "bytes"],
        [network.config.chainId, testCollateralLiquidatorJig.address, loanReceipt]
      );

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
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt);

      /* Liquidate collateral for 2.5 ETH */
      const liquidateTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(testCollateralLiquidatorJig.address, loanReceipt, ethers.utils.parseEther("2.5"));

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
        collateralHash,
        pool: testCollateralLiquidatorJig.address,
        collateralToken: nft1.address,
        collateralTokenId: 123,
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
          .liquidateCollateral(testCollateralLiquidatorJig.address, loanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on non-existent collateral", async function () {
      /* Construct loan reciept */
      const absentLoanReceipt = await loanReceiptLibrary.encode(makeLoanReceipt(nft1.address, 42));

      /* Try to liquidate non-existent collateral */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(testCollateralLiquidatorJig.address, absentLoanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on wrong pool", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt);

      /* Try to liquidate collateral for wrong pool */
      await expect(
        collateralLiquidator
          .connect(accountLiquidator)
          .liquidateCollateral(accounts[5].address, loanReceipt, ethers.utils.parseEther("2.5"))
      ).to.be.revertedWithCustomError(collateralLiquidator, "InvalidCollateralState");
    });
    it("fails on invalid caller", async function () {
      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(testCollateralLiquidatorJig.address, loanReceipt);

      await expect(
        collateralLiquidator.liquidateCollateral(
          testCollateralLiquidatorJig.address,
          loanReceipt,
          ethers.utils.parseEther("2.5")
        )
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });
});
