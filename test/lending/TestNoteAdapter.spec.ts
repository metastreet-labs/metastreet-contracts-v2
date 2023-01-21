import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestERC721, TestLendingPlatform, TestNoteAdapter } from "../../typechain";

import { extractEvent } from "../helpers/EventUtilities";
import { elapseUntilTimestamp } from "../helpers/BlockchainUtilities";

describe("TestNoteAdapter", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let lendingPlatform: TestLendingPlatform;
  let noteAdapter: TestNoteAdapter;
  let accountLender: SignerWithAddress;
  let accountBorrower: SignerWithAddress;
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");
    const testNoteAdapterFactory = await ethers.getContractFactory("TestNoteAdapter");

    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("2000"))) as TestERC20;
    await tok1.deployed();

    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    lendingPlatform = (await testLendingPlatformFactory.deploy(tok1.address)) as TestLendingPlatform;
    await lendingPlatform.deployed();

    noteAdapter = (await testNoteAdapterFactory.deploy(lendingPlatform.address)) as TestNoteAdapter;
    await noteAdapter.deployed();

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

  /****************************************************************************/
  /* Loan helper functions */
  /****************************************************************************/

  async function createActiveLoan(): Promise<ethers.BigNumber> {
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

  async function createExpiredLoan(): Promise<ethers.BigNumber> {
    /* Create active loan */
    const loanId = await createActiveLoan();

    /* Wait for loan expiration */
    const lendTimestamp = (await lendingPlatform.loans(loanId)).startTime.toNumber();
    await elapseUntilTimestamp(lendTimestamp + 30 * 86400 + 1);

    return loanId;
  }

  async function createRepaidLoan(): Promise<ethers.BigNumber> {
    /* Create active loan */
    const loanId = await createActiveLoan();

    /* Repay */
    await lendingPlatform.connect(accountBorrower).repay(loanId);

    return loanId;
  }

  async function createLiquidatedLoan(): Promise<ethers.BigNumber> {
    /* Create expired loan */
    const loanId = await createExpiredLoan();

    /* Liquidate */
    await lendingPlatform.connect(accountLender).liquidate(loanId);

    return loanId;
  }

  /****************************************************************************/
  /* Tests */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected implementation", async function () {
      expect(await noteAdapter.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
    it("matches expected name", async function () {
      expect(await noteAdapter.name()).to.equal("TestNoteAdapter");
    });
    it("matches expected adapter type", async function () {
      expect(await noteAdapter.getAdapterType()).to.equal(0);
    });
  });

  describe("#getLoanId", async function () {
    it("returns loan id", async function () {
      expect(await noteAdapter.getLoanId(0)).to.equal(0);
      expect(await noteAdapter.getLoanId(1)).to.equal(1);
      expect(await noteAdapter.getLoanId(2)).to.equal(2);
    });
  });

  describe("#getLoanInfo", async function () {
    it("returns loan info", async function () {
      /* Create active loan */
      const loanId = await createActiveLoan();

      /* Validate loan info */
      const loanInfo = await noteAdapter.getLoanInfo(loanId, "0x");
      expect(loanInfo.loanId).to.equal(loanId);
      expect(loanInfo.borrower).to.equal(accountBorrower.address);
      expect(loanInfo.principal).to.equal(ethers.utils.parseEther("100"));
      expect(loanInfo.repayment).to.equal(ethers.utils.parseEther("110"));
      expect(loanInfo.maturity).to.equal((await lendingPlatform.loans(loanId)).startTime.add(30 * 86400));
      expect(loanInfo.duration).to.equal(30 * 86400);
      expect(loanInfo.currencyToken).to.equal(tok1.address);
      expect(loanInfo.collateralToken).to.equal(nft1.address);
      expect(loanInfo.collateralTokenId).to.equal(123);
      expect(loanInfo.assets.length).to.equal(1);
      expect(loanInfo.assets[0].assetType).to.equal(0);
      expect(loanInfo.assets[0].token).to.equal(nft1.address);
      expect(loanInfo.assets[0].tokenId).to.equal(123);
    });
  });

  describe("#getLoanStatus", async function () {
    it("returns active on active loan", async function () {
      const loanId = await createActiveLoan();
      expect(await noteAdapter.getLoanStatus(loanId, "0x")).to.equal(1);
    });
    it("returns repaid on repaid loan", async function () {
      const loanId = await createRepaidLoan();
      expect(await noteAdapter.getLoanStatus(loanId, "0x")).to.equal(2);
    });
    it("returns expired on expired loan", async function () {
      const loanId = await createExpiredLoan();
      expect(await noteAdapter.getLoanStatus(loanId, "0x")).to.equal(3);
    });
    it("returns liquidated on liquidated loan", async function () {
      const loanId = await createLiquidatedLoan();
      expect(await noteAdapter.getLoanStatus(loanId, "0x")).to.equal(4);
    });
    it("returns unknown on unknown loan", async function () {
      expect(await noteAdapter.getLoanStatus(5, "0x")).to.equal(0);
    });
  });

  describe("#getLiquidateCalldata", async function () {
    it("returns liquidation calldata", async function () {
      const [target, data] = await noteAdapter.getLiquidateCalldata(5, "0x");
      expect(target).to.equal(lendingPlatform.address);
      expect(data).to.equal(lendingPlatform.interface.encodeFunctionData("liquidate", [5]));
    });
  });
});
