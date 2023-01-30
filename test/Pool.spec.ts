import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLendingPlatform,
  TestNoteToken,
  TestNoteAdapter,
  TestLoanReceipt,
  FixedInterestRateModel,
  AllowCollateralFilter,
  LiquidityManager,
  Pool,
} from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { elapseUntilTimestamp } from "./helpers/BlockchainUtilities";
import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("Pool", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let lendingPlatform: TestLendingPlatform;
  let noteToken: TestNoteToken;
  let noteAdapter: TestNoteAdapter;
  let loanReceiptLib: TestLoanReceipt;
  let liquidityManagerLib: LiquidityManager;
  let interestRateModel: FixedInterestRateModel;
  let allowCollateralFilter: AllowCollateralFilter;
  let pool: Pool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");
    const testNoteAdapterFactory = await ethers.getContractFactory("TestNoteAdapter");
    const allowCollateralFilterFactory = await ethers.getContractFactory("AllowCollateralFilter");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const liquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    const fixedInterestRateModelFactory = await ethers.getContractFactory("FixedInterestRateModel");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy test lending platform */
    lendingPlatform = (await testLendingPlatformFactory.deploy(tok1.address)) as TestLendingPlatform;
    await lendingPlatform.deployed();

    /* Get test note token */
    noteToken = (await ethers.getContractAt(
      "TestNoteToken",
      await lendingPlatform.noteToken(),
      accounts[0]
    )) as TestNoteToken;

    /* Deploy test note adapter */
    noteAdapter = (await testNoteAdapterFactory.deploy(lendingPlatform.address)) as TestNoteAdapter;
    await noteAdapter.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

    /* Deploy allow collateral filter */
    allowCollateralFilter = await allowCollateralFilterFactory.deploy([nft1.address]);
    await allowCollateralFilter.deployed();

    /* Deploy liquidity manager library */
    liquidityManagerLib = await liquidityManagerFactory.deploy();
    await liquidityManagerLib.deployed();

    /* Deploy test interest rate model */
    interestRateModel = await fixedInterestRateModelFactory.deploy(FixedPoint.normalizeRate("0.02"));

    /* Deploy pool */
    const poolFactory = await ethers.getContractFactory("Pool", {
      libraries: { LiquidityManager: liquidityManagerLib.address },
    });
    pool = await poolFactory.deploy(
      tok1.address,
      30 * 86400,
      allowCollateralFilter.address,
      interestRateModel.address,
      ethers.constants.AddressZero
    );
    await pool.deployed();

    /* Add note token to pool */
    await pool.setLoanAdapter(noteToken.address, noteAdapter.address);

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("1000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }

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

    /* Approve pool to transfer note token */
    await noteToken.connect(accountLender).setApprovalForAll(pool.address, true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected implementation", async function () {
      expect(await pool.IMPLEMENTATION_VERSION()).to.equal("1.0");
    });
  });

  describe("#deposit", async function () {
    it("successfully deposits", async function () {
      const depositTx = await pool
        .connect(accountDepositors[0])
        .deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));

      /* Validate events */
      await expectEvent(depositTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        amount: ethers.utils.parseEther("1"),
        shares: ethers.utils.parseEther("1"),
      });
      await expectEvent(depositTx, tok1, "Transfer", {
        from: accountDepositors[0].address,
        to: pool.address,
        value: ethers.utils.parseEther("1"),
      });

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("1"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("999"));
    });
    it("successfully deposits additional", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Deposit 2 */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("2"));

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("3"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("997"));
    });
    it("fails on invalid tick spacing", async function () {
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      await expect(
        pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10.1"), ethers.utils.parseEther("2"))
      ).to.be.revertedWithCustomError(liquidityManagerLib, "InsufficientTickSpacing");
    });
    it("fails on insolvent tick", async function () {
      /* FIXME */
    });
    it("fails on transfer failure", async function () {
      await expect(
        pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("2000"))
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });
  });

  describe("#redeem", async function () {
    it("successfully redeems entire deposit from available cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));

      /* Redeem 1 shares */
      const redeemTx = await pool
        .connect(accountDepositors[0])
        .redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        shares: ethers.utils.parseEther("1"),
      });

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("1"));
      expect(deposit.redemptionPending).to.equal(ethers.utils.parseEther("1"));
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
    });
    it("successfully redeems partial deposit from available cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));

      /* Redeem 0.5 shares */
      const redeemTx = await pool
        .connect(accountDepositors[0])
        .redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        shares: ethers.utils.parseEther("0.5"),
      });

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("1"));
      expect(deposit.redemptionPending).to.equal(ethers.utils.parseEther("0.5"));
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
    });
    it("successfully schedules redemption", async function () {
      /* FIXME */
    });
    it("fails on invalid shares", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Redeem 1.25 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("1.25"))
      ).to.be.revertedWithCustomError(pool, "InvalidShares");
    });
    it("fails on redemption in progress", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"));
      /* Redeem 0.5 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"))
      ).to.be.revertedWithCustomError(pool, "RedemptionInProgress");
    });
  });

  describe("#redemptionAvailable", async function () {
    it("returns redemption available from cash", async function () {
      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(
        accountDepositors[0].address,
        ethers.utils.parseEther("10")
      );
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"));

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("0.5"));
      expect(amount).to.equal(ethers.utils.parseEther("0.5"));
    });
  });

  describe("#withdraw", async function () {
    it("withdraws nothing on no pending redemption", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));

      /* Simulate withdrawal should return 0 */
      expect(await pool.connect(accountDepositors[0]).callStatic.withdraw(ethers.utils.parseEther("10"))).to.equal(
        ethers.constants.Zero
      );

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));
      /* Withdraw tx should have no events */
      expect((await withdrawTx.wait()).logs.length).to.equal(0);
    });
    it("withdraws fully available redemption", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"));

      /* Simulate withdrawal should return 0.5 ETH */
      expect(await pool.connect(accountDepositors[0]).callStatic.withdraw(ethers.utils.parseEther("10"))).to.equal(
        ethers.utils.parseEther("0.5")
      );

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        shares: ethers.utils.parseEther("0.5"),
        amount: ethers.utils.parseEther("0.5"),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
        value: ethers.utils.parseEther("0.5"),
      });

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("0.5"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("999.5"));
    });
    it("withdraws partially available redemption", async function () {
      /* FIXME */
    });
  });

  /****************************************************************************/
  /* Helper functions */
  /****************************************************************************/

  async function setupLiquidity(): Promise<void> {
    const NUM_TICKS = 16;
    const TICK_SPACING_BASIS_POINTS = await liquidityManagerLib.TICK_SPACING_BASIS_POINTS();

    let depth = ethers.utils.parseEther("1.0");
    for (let i = 0; i < NUM_TICKS; i++) {
      await pool.connect(accountDepositors[0]).deposit(depth, ethers.utils.parseEther("25"));
      depth = depth.mul(TICK_SPACING_BASIS_POINTS).div(10000);
    }
  }

  async function createActiveLoan(
    principal: ethers.BigNumber,
    repayment: ethers.BigNumber,
    duration?: number
  ): Promise<ethers.BigNumber> {
    const lendTx = await lendingPlatform
      .connect(accountLender)
      .lend(accountBorrower.address, nft1.address, 123, principal, repayment, duration || 30 * 86400);
    return (await extractEvent(lendTx, lendingPlatform, "LoanCreated")).args.loanId;
  }

  async function createExpiredLoan(
    principal: ethers.BigNumber,
    repayment: ethers.BigNumber
  ): Promise<ethers.BigNumber> {
    /* Create active loan */
    const loanId = await createActiveLoan(principal, repayment);

    /* Wait for loan expiration */
    const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
    const duration = (await lendingPlatform.loans(loanId)).duration;
    await elapseUntilTimestamp(startTime + duration + 1);

    return loanId;
  }

  async function createRepaidLoan(principal: ethers.BigNumber, repayment: ethers.BigNumber): Promise<ethers.BigNumber> {
    /* Create active loan */
    const loanId = await createActiveLoan(principal, repayment);

    /* Repay */
    await lendingPlatform.connect(accountBorrower).repay(loanId);

    return loanId;
  }

  async function createLiquidatedLoan(
    principal: ethers.BigNumber,
    repayment: ethers.BigNumber
  ): Promise<ethers.BigNumber> {
    /* Create expired loan */
    const loanId = await createExpiredLoan(principal, repayment);

    /* Liquidate */
    await lendingPlatform.connect(accountLender).liquidate(loanId);

    return loanId;
  }

  /****************************************************************************/
  /* Note Tests */
  /****************************************************************************/

  describe("#priceNote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("prices note", async function () {
      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      /* Price note */
      const purchasePrice = await pool.priceNote(noteToken.address, loanId, []);
      expect(purchasePrice.sub(ethers.utils.parseEther("25.95733041")).abs()).to.be.lt(
        ethers.utils.parseEther("0.0000001")
      );
    });
    it("fails on insufficient liquidity", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("30"), ethers.utils.parseEther("31"));
      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        liquidityManagerLib,
        "InsufficientLiquidity"
      );
    });
    it("fails on invalid loan status (repaid)", async function () {
      const loanId = await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanStatus"
      );
    });
    it("fails on invalid loan status (expired)", async function () {
      const loanId = await createExpiredLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanStatus"
      );
    });
    it("fails on invalid loan status (liquidated)", async function () {
      const loanId = await createLiquidatedLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanStatus"
      );
    });
    it("fails on unsupported loan duration", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"), 35 * 86400);
      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "UnsupportedLoanDuration"
      );
    });
    it("fails on unsupported collateral", async function () {
      /* Create NFT 2 */
      const testERC721Factory = await ethers.getContractFactory("TestERC721");
      const nft2 = (await testERC721Factory.deploy("NFT 2", "NFT2", "https://nft2.com/token/")) as TestERC721;
      await nft2.deployed();

      /* Mint NFT 2 to borrower */
      await nft2.mint(accountBorrower.address, 123);
      /* Approve lending platform to transfer NFT */
      await nft2.connect(accountBorrower).setApprovalForAll(lendingPlatform.address, true);

      /* Create loan */
      const lendTx = await lendingPlatform
        .connect(accountLender)
        .lend(
          accountBorrower.address,
          nft2.address,
          123,
          ethers.utils.parseEther("25"),
          ethers.utils.parseEther("26"),
          30 * 86400
        );
      const loanId = (await extractEvent(lendTx, lendingPlatform, "LoanCreated")).args.loanId;

      await expect(pool.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "UnsupportedCollateral",
        0
      );
    });
    it("fails on unsupported currency token", async function () {
      /* Create Token 2 */
      const testERC20Factory = await ethers.getContractFactory("TestERC20");
      const tok2 = (await testERC20Factory.deploy(
        "Token 2",
        "TOK2",
        18,
        ethers.utils.parseEther("10000")
      )) as TestERC20;
      await tok2.deployed();

      /* Deploy second pool */
      const poolFactory = await ethers.getContractFactory("Pool", {
        libraries: { LiquidityManager: liquidityManagerLib.address },
      });
      const pool2 = await poolFactory.deploy(
        tok2.address,
        30 * 86400,
        allowCollateralFilter.address,
        interestRateModel.address,
        ethers.constants.AddressZero
      );
      await pool2.deployed();

      /* Add note token to pool */
      await pool2.setLoanAdapter(noteToken.address, noteAdapter.address);

      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(pool2.priceNote(noteToken.address, loanId, [])).to.be.revertedWithCustomError(
        pool,
        "UnsupportedCurrencyToken"
      );
    });
  });

  describe("#sellNote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("sells note", async function () {
      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      /* Sell note */
      const sellNoteTx = await pool
        .connect(accountLender)
        .sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), []);
      await expectEvent(sellNoteTx, noteToken, "Transfer", {
        from: accountLender.address,
        to: pool.address,
        tokenId: loanId,
      });
      await expectEvent(sellNoteTx, tok1, "Transfer", {
        from: pool.address,
        to: accountLender.address,
      });
      await expect(sellNoteTx).to.emit(pool, "LoanPurchased");

      /* Extract purchase price */
      const purchasePrice = (await extractEvent(sellNoteTx, tok1, "Transfer")).args.value;

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(sellNoteTx, pool, "LoanPurchased")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(sellNoteTx, pool, "LoanPurchased")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(1);
      expect(decodedLoanReceipt.platform).to.equal(noteToken.address);
      expect(decodedLoanReceipt.loanId).to.equal(loanId);
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await lendingPlatform.loans(loanId)).startTime.toNumber() + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(purchasePrice);
      expect(totalPending).to.equal(ethers.utils.parseEther("26"));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });
    it("fails on insufficient liquidity", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("30"), ethers.utils.parseEther("31"));
      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(liquidityManagerLib, "InsufficientLiquidity");
    });
    it("fails on invalid loan status (repaid)", async function () {
      const loanId = await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });
    it("fails on invalid loan status (expired)", async function () {
      const loanId = await createExpiredLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });
    it("fails on invalid loan status (liquidated)", async function () {
      const loanId = await createLiquidatedLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });
    it("fails on unsupported loan duration", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"), 35 * 86400);
      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "UnsupportedLoanDuration");
    });
    it("fails on unsupported collateral", async function () {
      /* Create NFT 2 */
      const testERC721Factory = await ethers.getContractFactory("TestERC721");
      const nft2 = (await testERC721Factory.deploy("NFT 2", "NFT2", "https://nft2.com/token/")) as TestERC721;
      await nft2.deployed();

      /* Mint NFT 2 to borrower */
      await nft2.mint(accountBorrower.address, 123);
      /* Approve lending platform to transfer NFT */
      await nft2.connect(accountBorrower).setApprovalForAll(lendingPlatform.address, true);

      /* Create loan */
      const lendTx = await lendingPlatform
        .connect(accountLender)
        .lend(
          accountBorrower.address,
          nft2.address,
          123,
          ethers.utils.parseEther("25"),
          ethers.utils.parseEther("26"),
          30 * 86400
        );
      const loanId = (await extractEvent(lendTx, lendingPlatform, "LoanCreated")).args.loanId;

      await expect(
        pool.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
    });
    it("fails on unsupported currency token", async function () {
      /* Create Token 2 */
      const testERC20Factory = await ethers.getContractFactory("TestERC20");
      const tok2 = (await testERC20Factory.deploy(
        "Token 2",
        "TOK2",
        18,
        ethers.utils.parseEther("10000")
      )) as TestERC20;
      await tok2.deployed();

      /* Deploy second pool */
      const poolFactory = await ethers.getContractFactory("Pool", {
        libraries: { LiquidityManager: liquidityManagerLib.address },
      });
      const pool2 = await poolFactory.deploy(
        tok2.address,
        30 * 86400,
        allowCollateralFilter.address,
        interestRateModel.address,
        ethers.constants.AddressZero
      );
      await pool2.deployed();

      /* Add note token to pool */
      await pool2.setLoanAdapter(noteToken.address, noteAdapter.address);

      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(
        pool2.sellNote(noteToken.address, loanId, ethers.utils.parseEther("25"), [])
      ).to.be.revertedWithCustomError(pool, "UnsupportedCurrencyToken");
    });
  });
});
