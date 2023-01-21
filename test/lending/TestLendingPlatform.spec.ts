import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestERC721, TestLendingPlatform, TestNoteToken } from "../../typechain";

import { extractEvent, expectEvent } from "../helpers/EventUtilities";
import { elapseUntilTimestamp } from "../helpers/BlockchainUtilities";

describe("TestLendingPlatform", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let lendingPlatform: TestLendingPlatform;
  let noteToken: TestNoteToken;
  let accountLender: SignerWithAddress;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("2000"))) as TestERC20;
    await tok1.deployed();

    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    lendingPlatform = (await testLendingPlatformFactory.deploy(tok1.address)) as TestLendingPlatform;
    await lendingPlatform.deployed();

    noteToken = (await ethers.getContractAt(
      "TestNoteToken",
      await lendingPlatform.noteToken(),
      accounts[0]
    )) as TestNoteToken;

    accountBorrower = accounts[1];
    accountLender = accounts[2];

    /* Mint NFT to borrower */
    await nft1.mint(accountBorrower.address, 123);
    /* Mint token to borrower */
    await tok1.transfer(accountBorrower.address, ethers.utils.parseEther("100"));
    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve lending platform to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(lendingPlatform.address, true);
    /* Approve lending platform to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(lendingPlatform.address, ethers.constants.MaxUint256);
    /* Approve lending platform to transfer token */
    await tok1.connect(accountLender).approve(lendingPlatform.address, ethers.constants.MaxUint256);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#lend", async function () {
    it("creates a loan", async function () {
      /* Lend */
      const lendTx = await lendingPlatform
        .connect(accountLender)
        .lend(
          accountBorrower.address,
          nft1.address,
          123,
          ethers.utils.parseEther("100"),
          ethers.utils.parseEther("110"),
          30 * 86400
        );

      const loanId = (await extractEvent(lendTx, lendingPlatform, "LoanCreated")).args.loanId;

      /* Validate events */
      await expectEvent(lendTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: lendingPlatform.address,
        tokenId: 123,
      });
      await expectEvent(lendTx, tok1, "Transfer", {
        from: accountLender.address,
        to: accountBorrower.address,
        value: ethers.utils.parseEther("100"),
      });
      await expectEvent(lendTx, noteToken, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountLender.address,
        tokenId: loanId,
      });
      await expectEvent(lendTx, lendingPlatform, "LoanCreated", {
        loanId: loanId,
        borrower: accountBorrower.address,
        lender: accountLender.address,
      });

      /* Validate state */
      expect(await nft1.ownerOf(123)).to.equal(lendingPlatform.address);
      expect(await tok1.balanceOf(accountBorrower.address)).to.equal(ethers.utils.parseEther("200"));
      expect(await tok1.balanceOf(accountLender.address)).to.equal(ethers.utils.parseEther("900"));
      expect(await noteToken.exists(loanId)).to.equal(true);
      expect(await noteToken.ownerOf(loanId)).to.equal(accountLender.address);

      /* Validate loan details */
      const loanTerms = await lendingPlatform.loans(loanId);
      expect(loanTerms.status).to.equal(1);
      expect(loanTerms.borrower).to.equal(accountBorrower.address);
      expect(loanTerms.principal).to.equal(ethers.utils.parseEther("100"));
      expect(loanTerms.repayment).to.equal(ethers.utils.parseEther("110"));
      expect(loanTerms.startTime).to.equal((await ethers.provider.getBlock(lendTx.blockHash!)).timestamp);
      expect(loanTerms.duration).to.equal(30 * 86400);
      expect(loanTerms.collateralToken).to.equal(nft1.address);
      expect(loanTerms.collateralTokenId).to.equal(123);
    });
    it("fails on invalid repayment", async function () {
      await expect(
        lendingPlatform
          .connect(accountLender)
          .lend(
            accountBorrower.address,
            nft1.address,
            123,
            ethers.utils.parseEther("110"),
            ethers.utils.parseEther("100"),
            30 * 86400
          )
      ).to.be.revertedWithCustomError(lendingPlatform, "InvalidParameters");
    });
    it("fails on insufficient balance", async function () {
      await expect(
        lendingPlatform
          .connect(accountLender)
          .lend(
            accountBorrower.address,
            nft1.address,
            123,
            ethers.utils.parseEther("1001"),
            ethers.utils.parseEther("1002"),
            30 * 86400
          )
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });
    it("fails on non-existent nft", async function () {
      await expect(
        lendingPlatform
          .connect(accountLender)
          .lend(
            accountBorrower.address,
            nft1.address,
            234,
            ethers.utils.parseEther("100"),
            ethers.utils.parseEther("110"),
            30 * 86400
          )
      ).to.be.revertedWith("ERC721: invalid token ID");
    });
  });

  /* Helper function to create an active loan */
  async function createLoan(): Promise<ethers.BigNumber> {
    const lendTx = await lendingPlatform
      .connect(accountLender)
      .lend(
        accountBorrower.address,
        nft1.address,
        123,
        ethers.utils.parseEther("100"),
        ethers.utils.parseEther("110"),
        30 * 86400
      );
    return (await extractEvent(lendTx, lendingPlatform, "LoanCreated")).args.loanId;
  }

  describe("#repay", async function () {
    it("repays a loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Repay */
      const repayTx = await lendingPlatform.connect(accountBorrower).repay(loanId);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: accountLender.address,
        value: ethers.utils.parseEther("110"),
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: lendingPlatform.address,
        to: accountBorrower.address,
        tokenId: 123,
      });
      await expectEvent(repayTx, noteToken, "Transfer", {
        from: accountLender.address,
        to: ethers.constants.AddressZero,
        tokenId: loanId,
      });
      await expectEvent(repayTx, lendingPlatform, "LoanRepaid", { loanId: loanId });

      /* Validate state */
      expect(await nft1.ownerOf(123)).to.equal(accountBorrower.address);
      expect(await tok1.balanceOf(accountBorrower.address)).to.equal(ethers.utils.parseEther("90"));
      expect(await tok1.balanceOf(accountLender.address)).to.equal(ethers.utils.parseEther("1010"));
      expect(await noteToken.exists(loanId)).to.equal(false);

      /* Check loan is complete */
      expect((await lendingPlatform.loans(loanId)).status).to.equal(2);
    });
    it("fails on invalid caller", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Repay from lender */
      await expect(lendingPlatform.connect(accountLender).repay(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidCaller"
      );
    });
    it("fails on non-existent loan", async function () {
      /* Repay non-existent loan */
      await expect(lendingPlatform.connect(accountBorrower).repay(5)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
    it("fails on repaid loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Repay */
      await lendingPlatform.connect(accountBorrower).repay(loanId);

      /* Repay again */
      await expect(lendingPlatform.connect(accountBorrower).repay(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
    it("fails on liquidated loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Wait for loan expiration */
      const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

      /* Liquidate */
      await lendingPlatform.connect(accountLender).liquidate(loanId);

      /* Attempt to repay */
      await expect(lendingPlatform.connect(accountBorrower).repay(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
  });

  describe("#liquidate", async function () {
    it("liquidates a loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Wait for loan expiration */
      const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

      /* Liquidate */
      const liquidateTx = await lendingPlatform.connect(accountLender).liquidate(loanId);

      /* Validate events */
      await expectEvent(liquidateTx, nft1, "Transfer", {
        from: lendingPlatform.address,
        to: accountLender.address,
        tokenId: 123,
      });
      await expectEvent(liquidateTx, noteToken, "Transfer", {
        from: accountLender.address,
        to: ethers.constants.AddressZero,
        tokenId: loanId,
      });
      await expectEvent(liquidateTx, lendingPlatform, "LoanLiquidated", { loanId: loanId });

      /* Validate state */
      expect(await nft1.ownerOf(123)).to.equal(accountLender.address);
      expect(await tok1.balanceOf(accountBorrower.address)).to.equal(ethers.utils.parseEther("200"));
      expect(await tok1.balanceOf(accountLender.address)).to.equal(ethers.utils.parseEther("900"));
      expect(await noteToken.exists(loanId)).to.equal(false);

      /* Check loan is liquidated */
      expect((await lendingPlatform.loans(loanId)).status).to.equal(3);
    });
    it("fails on invalid caller", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Wait for loan expiration */
      const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

      /* Liquidate from borrower */
      await expect(lendingPlatform.connect(accountBorrower).liquidate(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidCaller"
      );
    });
    it("fails on non-existent loan", async function () {
      /* Liquidate non-existent loan */
      await expect(lendingPlatform.connect(accountLender).liquidate(5)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
    it("fails on repaid loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Wait for loan expiration */
      const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

      /* Repay */
      await lendingPlatform.connect(accountBorrower).repay(loanId);

      /* Attempt to liquidate */
      await expect(lendingPlatform.connect(accountLender).liquidate(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
    it("fails on liquidated loan", async function () {
      /* Lend */
      const loanId = await createLoan();

      /* Wait for loan expiration */
      const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

      /* Liquidate */
      await lendingPlatform.connect(accountLender).liquidate(loanId);

      /* Liquidate again */
      await expect(lendingPlatform.connect(accountLender).liquidate(loanId)).to.be.revertedWithCustomError(
        lendingPlatform,
        "InvalidLoanStatus"
      );
    });
  });

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(
        await lendingPlatform.supportsInterface(lendingPlatform.interface.getSighash("supportsInterface"))
      ).to.equal(true);
      /* ERC721 */
      expect(
        await lendingPlatform.supportsInterface(lendingPlatform.interface.getSighash("onERC721Received"))
      ).to.equal(true);
    });
    it("returns false on unsupported interfaces", async function () {
      expect(await lendingPlatform.supportsInterface("0xaabbccdd")).to.equal(false);
      expect(await lendingPlatform.supportsInterface("0x00000000")).to.equal(false);
      expect(await lendingPlatform.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
