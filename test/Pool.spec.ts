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
  TestDelegationRegistry,
  FixedInterestRateModel,
  CollectionCollateralFilter,
  ExternalCollateralLiquidator,
  ICollateralLiquidator,
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
  let collateralFilterImpl: CollectionCollateralFilter;
  let interestRateModelImpl: FixedInterestRateModel;
  let collateralLiquidatorImpl: ExternalCollateralLiquidator;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: Pool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegationRegistry: TestDelegationRegistry;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");
    const testNoteAdapterFactory = await ethers.getContractFactory("TestNoteAdapter");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const collectionCollateralFilterFactory = await ethers.getContractFactory("CollectionCollateralFilter");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const liquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    const fixedInterestRateModelFactory = await ethers.getContractFactory("FixedInterestRateModel");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");

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

    /* Deploy liquidity manager library */
    liquidityManagerLib = await liquidityManagerFactory.deploy();
    await liquidityManagerLib.deployed();

    /* Deploy collateral filter implementation */
    collateralFilterImpl = await collectionCollateralFilterFactory.deploy();
    await collateralFilterImpl.deployed();

    /* Deploy interest rate model implementation */
    interestRateModelImpl = await fixedInterestRateModelFactory.deploy();
    await interestRateModelImpl.deployed();

    /* Deploy external collateral liquidator implementation */
    collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy pool implementation */
    const poolFactory = await ethers.getContractFactory("Pool", {
      libraries: { LiquidityManager: liquidityManagerLib.address },
    });
    poolImpl = await poolFactory.deploy();
    await poolImpl.deployed();

    /* Deploy pool */
    const proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        accounts[0].address,
        nft1.address,
        tok1.address,
        30 * 86400,
        delegationRegistry.address,
        collateralFilterImpl.address,
        interestRateModelImpl.address,
        collateralLiquidatorImpl.address,
        ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
        ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.normalizeRate("0.02")]),
        ethers.utils.defaultAbiCoder.encode(["address"], [accounts[6].address]),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* Add note token to pool */
    await pool.setLoanAdapter(noteToken.address, noteAdapter.address);

    /* Attach collateral liquidator */
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      await pool.collateralLiquidator()
    )) as ExternalCollateralLiquidator;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(depositor.address, ethers.utils.parseEther("1000"));
      await tok1.connect(depositor).approve(pool.address, ethers.constants.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(accountLiquidator.address, ethers.utils.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(collateralLiquidator.address, ethers.constants.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mint(accountBorrower.address, 123);
    await nft1.mint(accountBorrower.address, 124);
    await nft1.mint(accountBorrower.address, 125);
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

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);
    /* Approve pool to tranasfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);

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
      /* Setup insolvent tick at 10 ETH */
      await setupInsolventTick();
      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"))
      ).to.be.revertedWithCustomError(liquidityManagerLib, "InsolventLiquidity");
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
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("10"));

      /* Create and sell loan */
      await createAndSellLoan(ethers.utils.parseEther("14"), ethers.utils.parseEther("15"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("10"));
      expect(deposit.redemptionPending).to.equal(ethers.utils.parseEther("5"));
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);

      /* Validate tick state */
      const node = await pool.liquidityNode(ethers.utils.parseEther("10"));
      expect(node.value).to.equal(ethers.utils.parseEther("10"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.utils.parseEther("5"));
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

    it("returns full redemption available from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(
        accountDepositors[0].address,
        ethers.utils.parseEther("10")
      );
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Repay loan */
      await lendingPlatform.connect(accountBorrower).repay(loanId);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("5"));
      expect(amount.sub(ethers.utils.parseEther("5")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
    });

    it("returns partial redemption available from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan 1 */
      const [loanId1, loanReceipt1] = await createAndSellLoan(
        ethers.utils.parseEther("2"),
        ethers.utils.parseEther("3")
      );
      /* Create and sell loan 2 */
      const [loanId2, loanReceipt2] = await createAndSellLoan(
        ethers.utils.parseEther("10"),
        ethers.utils.parseEther("11")
      );
      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("8"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(
        accountDepositors[0].address,
        ethers.utils.parseEther("10")
      );
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Repay loan 1 */
      await lendingPlatform.connect(accountBorrower).repay(loanId1);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt1);

      /* Partial redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Repay loan 2 */
      await lendingPlatform.connect(accountBorrower).repay(loanId2);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt2);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("8"));
      expect(amount.sub(ethers.utils.parseEther("8")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
    });

    it("returns written down redemption available from liquidated loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(
        accountDepositors[0].address,
        ethers.utils.parseEther("10")
      );
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);
      /* Liquidate collateral and process liquidation */
      await collateralLiquidator.connect(accountLiquidator).liquidateCollateral(loanReceipt, ethers.constants.Zero);

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("5"));
      expect(amount).to.equal(ethers.constants.Zero);
    });

    it("returns partial redemption available from subsequent deposit", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(
        accountDepositors[0].address,
        ethers.utils.parseEther("10")
      );
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("3"));

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
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

    it("withdraws fully available redemption from cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"));
      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("0.5"));

      /* Simulated withdrawal should return 0.5 ETH */
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

    it("withdraws fully available redemption from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Repay loan */
      await lendingPlatform.connect(accountBorrower).repay(loanId);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt);

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        shares: ethers.utils.parseEther("5"),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;
      expect(amount.sub(ethers.utils.parseEther("5")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("5"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
    });

    it("withdraws partially available redemption from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan 1 */
      const [loanId1, loanReceipt1] = await createAndSellLoan(
        ethers.utils.parseEther("2"),
        ethers.utils.parseEther("3")
      );
      /* Create and sell loan 2 */
      const [loanId2, loanReceipt2] = await createAndSellLoan(
        ethers.utils.parseEther("10"),
        ethers.utils.parseEther("11")
      );
      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("8"));

      /* Repay loan 1 */
      await lendingPlatform.connect(accountBorrower).repay(loanId1);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt1);

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(shares1.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount1.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Validate deposit state */
      let deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("10").sub(shares1));
      expect(deposit.redemptionPending).to.equal(ethers.utils.parseEther("8").sub(shares1));
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(shares1);

      /* Repay loan 2 */
      await lendingPlatform.connect(accountBorrower).repay(loanId2);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt2);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(shares2.sub(ethers.utils.parseEther("5")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount2.sub(ethers.utils.parseEther("5")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Validate deposit state */
      deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("2"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
    });

    it("withdraws fully written down redemption from liquidated loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);
      /* Liquidate collateral and process liquidation */
      await collateralLiquidator.connect(accountLiquidator).liquidateCollateral(loanReceipt, ethers.constants.Zero);

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
        shares: ethers.utils.parseEther("5"),
        amount: ethers.constants.Zero,
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
        value: ethers.constants.Zero,
      });

      /* Validate deposit state */
      const deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("5"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
    });

    it("withdraws partially available redemption from subsequent deposit", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("14"),
        ethers.utils.parseEther("15")
      );
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("3"));

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(shares1.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount1.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Validate deposit state */
      let deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("10").sub(shares1));
      expect(deposit.redemptionPending).to.equal(ethers.utils.parseEther("5").sub(shares1));
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(shares1);

      /* Repay loan */
      await lendingPlatform.connect(accountBorrower).repay(loanId);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(ethers.utils.parseEther("10"));

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        depth: ethers.utils.parseEther("10"),
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(shares2.sub(ethers.utils.parseEther("2")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount2.sub(ethers.utils.parseEther("2")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Validate deposit state */
      deposit = await pool.deposits(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(deposit.shares).to.equal(ethers.utils.parseEther("5"));
      expect(deposit.redemptionPending).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionIndex).to.equal(ethers.constants.Zero);
      expect(deposit.redemptionTarget).to.equal(ethers.constants.Zero);
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

  async function sourceLiquidity(amount: ethers.BigNumber): Promise<ethers.BigNumber[]> {
    const nodes = await pool.liquidityNodes(0, ethers.constants.MaxUint256);
    const depths = [];

    const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
    const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

    let taken = ethers.constants.Zero;
    for (let node of nodes) {
      const take = minBN(minBN(node.depth.sub(taken), node.available), amount.sub(taken));
      if (take.isZero()) continue;
      depths.push(node.depth);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount {amount.toString()}`);

    return depths;
  }

  async function setupInsolventTick(): Promise<void> {
    /* Create two deposits at 10 ETH and 20 ETH ticks */
    await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("5"), ethers.utils.parseEther("5"));
    await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));
    await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));

    /* Create and sell loan taking 15 ETH */
    const [loanId, loanReceipt] = await createAndSellLoan(ethers.utils.parseEther("14"), ethers.utils.parseEther("15"));

    /* Wait for loan expiration */
    const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
    const duration = (await lendingPlatform.loans(loanId)).duration;
    await elapseUntilTimestamp(startTime + duration + 1);

    /* Process expiration */
    await pool.onLoanExpired(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(loanReceipt, ethers.utils.parseEther("5"));
  }

  async function createActiveLoan(
    principal: ethers.BigNumber,
    repayment: ethers.BigNumber,
    duration?: number
  ): Promise<ethers.BigNumber> {
    const tokenId =
      (await nft1.ownerOf(123)) === accountBorrower.address
        ? 123
        : (await nft1.ownerOf(124)) === accountBorrower.address
        ? 124
        : 125;

    const lendTx = await lendingPlatform
      .connect(accountLender)
      .lend(accountBorrower.address, nft1.address, tokenId, principal, repayment, duration || 30 * 86400);
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

  async function createAndSellLoan(
    principal: ethers.BigNumber,
    repayment: ethers.BigNumber,
    duration?: number
  ): Promise<[ethers.BigNumber, string]> {
    /* Create active loan */
    const loanId = await createActiveLoan(principal, repayment, duration);

    /* Sell note */
    const sellNoteTx = await pool
      .connect(accountLender)
      .sellNote(noteToken.address, loanId, 0, await sourceLiquidity(repayment), []);
    const loanReceipt = (await extractEvent(sellNoteTx, pool, "LoanPurchased")).args.loanReceipt;

    return [loanId, loanReceipt];
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

      await expect(pool.priceNote(noteToken.address, loanId, []))
        .to.be.revertedWithCustomError(pool, "UnsupportedCollateral")
        .withArgs(0);
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
      const testProxyFactory = await ethers.getContractFactory("TestProxy");
      const proxy = await testProxyFactory.deploy(
        poolImpl.address,
        poolImpl.interface.encodeFunctionData("initialize", [
          accounts[0].address,
          nft1.address,
          tok2.address,
          30 * 86400,
          delegationRegistry.address,
          collateralFilterImpl.address,
          interestRateModelImpl.address,
          collateralLiquidatorImpl.address,
          ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
          ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.normalizeRate("0.02")]),
          ethers.utils.defaultAbiCoder.encode(["address"], [accountLiquidator.address]),
        ])
      );
      await proxy.deployed();
      const pool2 = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

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
        .sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        );

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
      expect(decodedLoanReceipt.principal).to.equal(ethers.utils.parseEther("25"));
      expect(decodedLoanReceipt.repayment).to.equal(ethers.utils.parseEther("26"));
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

    it("sells note with admin fee", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      /* Sell note */
      const sellNoteTx = await pool
        .connect(accountLender)
        .sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        );

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
      expect(decodedLoanReceipt.principal).to.equal(ethers.utils.parseEther("25"));
      expect(decodedLoanReceipt.repayment).to.equal(ethers.utils.parseEther("26"));
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

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(ethers.utils.parseEther("26").sub(purchasePrice)).div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(purchasePrice);
      expect(totalPending).to.equal(ethers.utils.parseEther("26").sub(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("fails on insufficient liquidity", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("30"), ethers.utils.parseEther("31"));
      await expect(
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
      ).to.be.revertedWithCustomError(liquidityManagerLib, "InsufficientLiquidity");
    });

    it("fails on invalid loan status (repaid)", async function () {
      const loanId = await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on invalid loan status (expired)", async function () {
      const loanId = await createExpiredLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on invalid loan status (liquidated)", async function () {
      const loanId = await createLiquidatedLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));
      await expect(
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on unsupported loan duration", async function () {
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"), 35 * 86400);
      await expect(
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
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
        pool.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
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
      const testProxyFactory = await ethers.getContractFactory("TestProxy");
      const proxy = await testProxyFactory.deploy(
        poolImpl.address,
        poolImpl.interface.encodeFunctionData("initialize", [
          accounts[0].address,
          nft1.address,
          tok2.address,
          30 * 86400,
          delegationRegistry.address,
          collateralFilterImpl.address,
          interestRateModelImpl.address,
          collateralLiquidatorImpl.address,
          ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
          ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.normalizeRate("0.02")]),
          ethers.utils.defaultAbiCoder.encode(["address"], [accountLiquidator.address]),
        ])
      );
      await proxy.deployed();
      const pool2 = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

      /* Add note token to pool */
      await pool2.setLoanAdapter(noteToken.address, noteAdapter.address);

      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(
        pool2.sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCurrencyToken");
    });
  });

  /****************************************************************************/
  /* Privileged API Tests */
  /****************************************************************************/

  describe("#setLoanAdapter", async function () {
    it("sets loan adapter", async function () {
      /* Unset loan adapter */
      const unsetLoanAdapterTx = await pool.setLoanAdapter(noteToken.address, ethers.constants.AddressZero);

      /* Validate event */
      await expectEvent(unsetLoanAdapterTx, pool, "LoanAdapterUpdated", {
        platform: noteToken.address,
        loanAdapter: ethers.constants.AddressZero,
      });

      /* Validate state */
      expect(await pool.loanAdapters(noteToken.address)).to.equal(ethers.constants.AddressZero);

      /* Set loan adpater */
      const setLoanAdapterTx = await pool.setLoanAdapter(noteToken.address, noteAdapter.address);

      /* Validate event */
      await expectEvent(setLoanAdapterTx, pool, "LoanAdapterUpdated", {
        platform: noteToken.address,
        loanAdapter: noteAdapter.address,
      });

      /* Validate state */
      expect(await pool.loanAdapters(noteToken.address)).to.equal(noteAdapter.address);
    });

    it("fails on invalid caller", async function () {
      await expect(
        pool.connect(accountDepositors[0]).setLoanAdapter(noteToken.address, noteAdapter.address)
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });
  });

  describe("#pause", async function () {
    it("pauses", async function () {
      expect(await pool.paused()).to.equal(false);

      /* Pause pool */
      await pool.pause();
      expect(await pool.paused()).to.equal(true);

      /* Unpause pool */
      await pool.unpause();
      expect(await pool.paused()).to.equal(false);
    });
    it("fails on invalid caller", async function () {
      await expect(pool.connect(accountDepositors[0]).pause()).to.be.revertedWith(
        /AccessControl: account .* is missing role .*/
      );
    });
  });

  describe("#setAdminFeeRate", async function () {
    it("sets admin fee rate successfully", async function () {
      const rate = 500;
      const tx = await pool.setAdminFeeRate(rate);

      await expectEvent(tx, pool, "AdminFeeRateUpdated", {
        rate: rate,
      });
      expect(await pool.adminFeeRate()).to.equal(rate);
    });

    it("fails on invalid value", async function () {
      await expect(pool.setAdminFeeRate(0)).to.be.revertedWithCustomError(pool, "ParameterOutOfBounds");
      await expect(pool.setAdminFeeRate(10000)).to.be.revertedWithCustomError(pool, "ParameterOutOfBounds");
    });

    it("fails on invalid caller", async function () {
      const rate = 500;

      await expect(pool.connect(accounts[1]).setAdminFeeRate(rate)).to.be.revertedWith(
        /AccessControl: account .* is missing role .*/
      );
    });
  });

  describe("#withdrawAdminFees", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("withdraws admin fees with repayment at loan maturity", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const encodedAddress = ethers.utils.defaultAbiCoder.encode(["address"], [accountBorrower.address]);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes"], [1, encodedAddress])
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(repayment.sub(ethers.utils.parseEther("25"))).div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      const startingBalance = await tok1.balanceOf(accounts[1].address);

      /* withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address, adminFee);

      /* validate events */
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accounts[1].address,
        value: adminFee,
      });

      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        account: accounts[1].address,
        amount: adminFee,
      });

      /* validate balance in account */
      expect(await tok1.balanceOf(accounts[1].address)).to.equal(startingBalance.add(adminFee));

      /* validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("withdraws admin fees with repayment after one third of loan maturity", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const encodedAddress = ethers.utils.defaultAbiCoder.encode(["address"], [accountBorrower.address]);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes"], [1, encodedAddress])
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate())
        .mul(repayment.sub(ethers.utils.parseEther("25")))
        .div(10000)
        .div(3);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.be.closeTo(adminFee, 1);

      /* withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address, adminFee.sub(1));

      /* validate events */
      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        account: accounts[1].address,
        amount: adminFee.sub(1),
      });

      /* validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("withdraws admin fees with repayment after one third of loan maturity", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const encodedAddress = ethers.utils.defaultAbiCoder.encode(["address"], [accountBorrower.address]);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes"], [1, encodedAddress])
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate())
        .mul(repayment.sub(ethers.utils.parseEther("25")))
        .div(10000)
        .div(3);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.be.closeTo(adminFee, 1);

      /* withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address, adminFee.sub(1));

      /* validate events */
      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        account: accounts[1].address,
        amount: adminFee.sub(1),
      });

      /* validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("fails on invalid caller", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(
        pool.connect(accounts[1]).withdrawAdminFees(accounts[1].address, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });

    it("fails on invalid address", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(
        pool.withdrawAdminFees(ethers.constants.AddressZero, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWithCustomError(pool, "InvalidAddress");
    });

    it("fails on parameter out of bounds", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      await createRepaidLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(
        pool.withdrawAdminFees(accounts[1].address, ethers.utils.parseEther("10"))
      ).to.be.revertedWithCustomError(pool, "ParameterOutOfBounds");
    });
  });

  /****************************************************************************/
  /* Lend Tests */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });
    it("correctly quotes repayment", async function () {
      expect(await pool.quote(ethers.utils.parseEther("10"), 30 * 86400, nft1.address, 123, [])).to.equal(
        ethers.utils.parseEther("10.016438356146880000")
      );
      expect(await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, [])).to.equal(
        ethers.utils.parseEther("25.041095890367200000")
      );
    });
    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("100"), 30 * 86400, tok1.address, 123, [])
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
    it("fails on unsupported collateral", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("25"), 30 * 86400, tok1.address, 456, [])
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          "0x"
        );

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: ethers.utils.parseEther("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(1);
      expect(decodedLoanReceipt.platform).to.equal(pool.address);
      expect(decodedLoanReceipt.loanId).to.equal(ethers.constants.Zero);
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
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
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates loan with delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes32"], [1, ethers.utils.zeroPad(accountBorrower.address, 32)])
        );

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: ethers.utils.parseEther("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: true,
      });

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(1);
      expect(decodedLoanReceipt.platform).to.equal(pool.address);
      expect(decodedLoanReceipt.loanId).to.equal(ethers.constants.Zero);
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
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
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(true);
    });

    it("originates loan with admin fee", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, []);

      /* Borrow */
      const encodedAddress = ethers.utils.defaultAbiCoder.encode(["address"], [accountBorrower.address]);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes"], [1, encodedAddress])
        );

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: ethers.utils.parseEther("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: true,
      });

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(1);
      expect(decodedLoanReceipt.platform).to.equal(pool.address);
      expect(decodedLoanReceipt.loanId).to.equal(ethers.constants.Zero);
      expect(decodedLoanReceipt.principal).to.equal(ethers.utils.parseEther("25"));
      expect(decodedLoanReceipt.repayment).to.equal(repayment);
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
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

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(repayment.sub(ethers.utils.parseEther("25"))).div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));
      expect(repayment).to.equal(totalPending.add(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(true);

      /* repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            tok1.address,
            456,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            [],
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral");
    });

    it("fails on exceeded max repayment", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            nft1.address,
            123,
            ethers.utils.parseEther("25.01"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            [],
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "RepaymentTooHigh");
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("30"),
            30 * 86400,
            nft1.address,
            123,
            ethers.utils.parseEther("31"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            [],
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on invalid borrow options encoding", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            nft1.address,
            123,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            [],
            ethers.utils.solidityPack(["uint16", "bytes"], [1, ethers.utils.zeroPad("0x12341234", 31)])
          )
      ).to.be.revertedWithCustomError(pool, "InvalidBorrowOptionsEncoding");
    });

    it("fails on delegating multiple wallets", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            nft1.address,
            123,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            [],
            ethers.utils.solidityPack(
              ["uint16", "bytes32", "uint16", "bytes32"],
              [
                1,
                ethers.utils.zeroPad(accountBorrower.address, 32),
                1,
                ethers.utils.zeroPad(accountDepositors[0].address, 32),
              ]
            )
          )
      )
        .to.be.revertedWithCustomError(pool, "InvalidBorrowOptions")
        .withArgs(1);
    });
  });

  describe("#repay", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes32"], [1, ethers.utils.zeroPad(accountBorrower.address, 32)])
        );
      loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    });

    it("repays loan at maturity", async function () {
      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment,
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: false,
      });

      /* validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(false);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      const liquidityStatistics = await pool.liquidityStatistics();
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      expect(liquidityStatistics[0]).to.equal(ethers.utils.parseEther("25").mul(16).add(totalPending.sub(totalUsed)));
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);
    });

    it("repays loan after one third of original loan duration has elasped", async function () {
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .div(3)
        .add(decodedLoanReceipt.principal);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: repayment.sub(1),
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: repayment.sub(1) /* FIXME rounding */,
      });

      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: false,
      });

      /* validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(false);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      const liquidityStatistics = await pool.liquidityStatistics();
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending.sub(nodeReceipt.used).div(3));
        expect(node.value).to.be.closeTo(value, 1);
        expect(node.available).be.closeTo(value, 1);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      expect(liquidityStatistics[0]).to.be.closeTo(
        ethers.utils.parseEther("25").mul(16).add(totalPending.sub(totalUsed).div(3)),
        1
      );
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);
    });

    it("repays loan after 8 / 9 of original loan duration has elasped", async function () {
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (30 * 86400) / 9);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .mul(8)
        .div(9)
        .add(decodedLoanReceipt.principal);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: repayment.sub(1),
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: repayment.sub(1) /* FIXME rounding */,
      });

      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: false,
      });

      /* validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(false);
      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      const liquidityStatistics = await pool.liquidityStatistics();
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending.sub(nodeReceipt.used).mul(8).div(9));
        expect(node.value).to.be.closeTo(value, 1);
        expect(node.available).to.be.closeTo(value, 1);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      expect(liquidityStatistics[0]).to.be.closeTo(
        ethers.utils.parseEther("25").mul(16).add(totalPending.sub(totalUsed).mul(8).div(9)),
        1
      );
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);
    });

    it("repays loan after 1 second loan duration has elasped", async function () {
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 30 * 86400 + 1);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .div(30 * 86400)
        .add(decodedLoanReceipt.principal);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: repayment.sub(1),
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: repayment.sub(1) /* FIXME rounding */,
      });

      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: false,
      });

      /* validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(false);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      const liquidityStatistics = await pool.liquidityStatistics();
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending.sub(nodeReceipt.used).div(30 * 86400));
        expect(node.value).to.equal(value);
        expect(node.available).equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      expect(liquidityStatistics[0]).to.be.closeTo(
        ethers.utils
          .parseEther("25")
          .mul(16)
          .add(totalPending.sub(totalUsed).div(30 * 86400)),
        1
      );
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);
    });

    it("repays with admin fee", async function () {
      await setupLiquidity();

      pool.setAdminFeeRate(500);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          124,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes32"], [1, ethers.utils.zeroPad(accountBorrower.address, 32)])
        );
      loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .add(decodedLoanReceipt.principal);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: repayment,
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: 124,
      });
      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 124,
        value: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("fails on invalid caller", async function () {
      await expect(pool.connect(accountLender).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on expired loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "LoanExpired");
    });

    it("fails on invalid loan receipt", async function () {
      await expect(
        pool.connect(accountBorrower).repay(ethers.utils.randomBytes(141 + 48 * 3))
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on liquidated loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on non-pool loan", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });
  });

  describe("#onLoanRepaid (pool loan)", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity, borrow, and repay", async function () {
      await setupLiquidity();

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          "0x"
        );
      loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    });

    it("fails on loan originated by pool", async function () {
      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#onLoanExpired (pool loan)", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          [],
          ethers.utils.solidityPack(["uint16", "bytes32"], [1, ethers.utils.zeroPad(accountBorrower.address, 32)])
        );
      loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    });

    it("liquidates expired loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      const onLoanExpiredTx = await pool.onLoanExpired(loanReceipt);

      /* Validate events */
      await expectEvent(onLoanExpiredTx, nft1, "Transfer", {
        from: pool.address,
        to: collateralLiquidator.address,
        tokenId: 123,
      });
      await expectEvent(onLoanExpiredTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      await expectEvent(onLoanExpiredTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 123,
        value: false,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);

      /* validate delegation */
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 123)
      ).to.equal(false);
    });

    it("fails on non-expired loan", async function () {
      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on repaid loan", async function () {
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  /****************************************************************************/
  /* Loan Callbacks */
  /****************************************************************************/

  describe("#onLoanRepaid", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("processes repaid loan", async function () {
      /* Create, sell, repay loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      const loanReceiptHash = await loanReceiptLib.hash(loanReceipt);
      await lendingPlatform.connect(accountBorrower).repay(loanId);

      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const purchasePrice = decodedLoanReceipt.nodeReceipts.reduce(
        (acc, node) => acc.add(node.used),
        ethers.constants.Zero
      );

      /* Process repayment */
      const onLoanRepaidTx = await pool.onLoanRepaid(loanReceipt);

      /* Validate events */
      await expectEvent(onLoanRepaidTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.utilization()).to.equal(0);
      const [total, used] = await pool.liquidityStatistics();
      expect(total).to.equal(ethers.utils.parseEther("400").add(ethers.utils.parseEther("26")).sub(purchasePrice));
      expect(used).to.equal(0);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
    });

    it("processes repaid loan with admin fee", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create loan */
      const loanId = await createActiveLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      /* Sell note */
      const sellNoteTx = await pool
        .connect(accountLender)
        .sellNote(
          noteToken.address,
          loanId,
          ethers.utils.parseEther("25"),
          await sourceLiquidity(ethers.utils.parseEther("26")),
          []
        );

      /* Extract purchase price */
      const purchasePrice = (await extractEvent(sellNoteTx, tok1, "Transfer")).args.value;

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(sellNoteTx, pool, "LoanPurchased")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(sellNoteTx, pool, "LoanPurchased")).args.loanReceipt;

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const repayment = decodedLoanReceipt.repayment;

      /* Sum used and pending totals from node receipts */
      let totalUsed = ethers.constants.Zero;
      let totalPending = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed.add(nodeReceipt.used);
        totalPending = totalPending.add(nodeReceipt.pending);
      }

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(ethers.utils.parseEther("26").sub(purchasePrice)).div(10000);

      /* Validate used and pending totals */
      expect(repayment).to.equal(ethers.utils.parseEther("26"));
      expect(totalUsed).to.equal(purchasePrice);
      expect(totalPending).to.equal(ethers.utils.parseEther("26").sub(adminFee));
      expect(repayment).to.equal(totalPending.add(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Loan repaid */
      await lendingPlatform.connect(accountBorrower).repay(loanId);

      /* Process repayment */
      const onLoanRepaidTx = await pool.onLoanRepaid(loanReceipt);

      /* Validate events */
      await expectEvent(onLoanRepaidTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* validate adminFee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("fails on invalid loan receipt (unknown)", async function () {
      /* Attempt to process unknown loan receipt */
      await expect(pool.onLoanRepaid(ethers.utils.randomBytes(141 + 48 * 3))).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on invalid loan receipt (repaid)", async function () {
      /* Create, sell, repay loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      await lendingPlatform.connect(accountBorrower).repay(loanId);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt);

      /* Attempt to process again */
      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan receipt (liquidated)", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);

      /* Attempt to process expired loan receipt */
      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan receipt (collateral liquidated)", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);
      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(loanReceipt, ethers.utils.parseEther("30"));

      /* Attempt to process collateral liquidated loan receipt */
      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan status (active)", async function () {
      /* Create and sell loan */
      const [, loanReceipt] = await createAndSellLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on invalid loan status (expired)", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);

      await expect(pool.onLoanRepaid(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });
  });

  describe("#onLoanExpired", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("processes expired loan", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      const loanReceiptHash = await loanReceiptLib.hash(loanReceipt);

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);

      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const purchasePrice = decodedLoanReceipt.nodeReceipts.reduce(
        (acc, node) => acc.add(node.used),
        ethers.constants.Zero
      );

      /* Process expiration */
      const onLoanExpiredTx = await pool.onLoanExpired(loanReceipt);

      /* Validate events */
      await expectEvent(onLoanExpiredTx, lendingPlatform, "LoanLiquidated", {
        loanId,
      });
      await expectEvent(
        onLoanExpiredTx,
        nft1,
        "Transfer",
        {
          from: lendingPlatform.address,
          to: pool.address,
          tokenId: 123,
        },
        0
      );
      await expectEvent(
        onLoanExpiredTx,
        nft1,
        "Transfer",
        {
          from: pool.address,
          to: collateralLiquidator.address,
          tokenId: 123,
        },
        1
      );
      await expectEvent(onLoanExpiredTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
      expect(await pool.utilization()).to.not.equal(0);
      const [total, used] = await pool.liquidityStatistics();
      expect(total).to.equal(ethers.utils.parseEther("400"));
      expect(used).to.equal(purchasePrice);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        expect(node.value).to.equal(ethers.utils.parseEther("25"));
        expect(node.available).to.equal(ethers.utils.parseEther("25").sub(nodeReceipt.used));
        expect(node.pending).to.equal(nodeReceipt.pending);
      }
    });

    it("fails on invalid loan receipt (invalid)", async function () {
      /* Attempt to process unknown loan receipt */
      await expect(pool.onLoanRepaid(ethers.utils.randomBytes(141 + 48 * 3))).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on invalid loan receipt (repaid)", async function () {
      /* Create, sell, repay loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      await lendingPlatform.connect(accountBorrower).repay(loanId);
      /* Process repayment */
      await pool.onLoanRepaid(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan receipt (liquidated)", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);

      /* Attempt to process again */
      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan receipt (collateral liquidated)", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);
      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);
      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);
      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(loanReceipt, ethers.utils.parseEther("30"));

      /* Attempt to process collateral liquidated loan receipt */
      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid loan status (active)", async function () {
      /* Create and sell loan */
      const [, loanReceipt] = await createAndSellLoan(ethers.utils.parseEther("25"), ethers.utils.parseEther("26"));

      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on invalid loan status (repaid)", async function () {
      /* Create, sell, and repay loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      await lendingPlatform.connect(accountBorrower).repay(loanId);

      await expect(pool.onLoanExpired(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });
  });

  describe("#onCollateralLiquidated", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("processes liquidated loan for higher proceeds", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      const loanReceiptHash = await loanReceiptLib.hash(loanReceipt);

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);

      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const purchasePrice = decodedLoanReceipt.nodeReceipts.reduce(
        (acc, node) => acc.add(node.used),
        ethers.constants.Zero
      );

      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Liquidate collateral and process liquidation */
      const onCollateralLiquidatedTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(loanReceipt, ethers.utils.parseEther("30"));

      /* Validate events */
      await expectEvent(
        onCollateralLiquidatedTx,
        tok1,
        "Transfer",
        {
          from: collateralLiquidator.address,
          to: pool.address,
          value: ethers.utils.parseEther("30"),
        },
        1
      );
      await expectEvent(onCollateralLiquidatedTx, pool, "CollateralLiquidated", {
        loanReceiptHash,
        proceeds: ethers.utils.parseEther("30"),
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);
      expect(await pool.utilization()).to.equal(0);
      const [total, used] = await pool.liquidityStatistics();
      expect(total).to.equal(ethers.utils.parseEther("400").add(ethers.utils.parseEther("30")).sub(purchasePrice));
      expect(used).to.equal(ethers.constants.Zero);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(0, -1)) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
      /* Validate upper tick gets remaining proceeds */
      const nodeReceipt = decodedLoanReceipt.nodeReceipts[decodedLoanReceipt.nodeReceipts.length - 1];
      const node = await pool.liquidityNode(nodeReceipt.depth);
      const value = ethers.utils
        .parseEther("25")
        .add(nodeReceipt.pending)
        .sub(nodeReceipt.used)
        .add(ethers.utils.parseEther("4"));
      expect(node.value).to.equal(value);
      expect(node.available).to.equal(value);
      expect(node.pending).to.equal(ethers.constants.Zero);
    });

    it("processes liquidated loan for lower proceeds", async function () {
      /* Create and sell loan */
      const [loanId, loanReceipt] = await createAndSellLoan(
        ethers.utils.parseEther("25"),
        ethers.utils.parseEther("26")
      );
      const loanReceiptHash = await loanReceiptLib.hash(loanReceipt);

      /* Wait for loan expiration */
      const startTime = (await lendingPlatform.loans(loanId)).startTime.toNumber();
      const duration = (await lendingPlatform.loans(loanId)).duration;
      await elapseUntilTimestamp(startTime + duration + 1);

      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const purchasePrice = decodedLoanReceipt.nodeReceipts.reduce(
        (acc, node) => acc.add(node.used),
        ethers.constants.Zero
      );

      /* Process expiration */
      await pool.onLoanExpired(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Liquidate collateral and process liquidation */
      const proceeds = decodedLoanReceipt.nodeReceipts[0].pending.add(decodedLoanReceipt.nodeReceipts[1].pending);
      await collateralLiquidator.connect(accountLiquidator).liquidateCollateral(loanReceipt, proceeds);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);
      expect(await pool.utilization()).to.equal(0);
      const [total, used] = await pool.liquidityStatistics();
      expect(total).to.equal(ethers.utils.parseEther("400").sub(purchasePrice).add(proceeds));
      expect(used).to.equal(ethers.constants.Zero);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(0, 2)) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").sub(nodeReceipt.used).add(nodeReceipt.pending);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(2, 0)) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        expect(node.value).to.equal(ethers.utils.parseEther("25"));
        expect(node.available).to.equal(ethers.utils.parseEther("25"));
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
    });
    /* FIXME these additional tests require a TestCollateralLiquidator, as
     * ExternalCollateralLiquidator prevents these states:
    it("fails on invalid loan receipt (invalid)", async function () {
    });
    it("fails on invalid loan receipt (active)", async function () {
    });
    it("fails on invalid loan receipt (repaid)", async function () {
    });
    it("fails on invalid loan receipt (collateral liquidated)", async function () {
    });
    */
  });

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(pool.interface.getSighash("supportsInterface"))).to.equal(true);
      /* AccessControl */
      expect(
        await pool.supportsInterface(
          ethers.utils.hexlify(
            [
              pool.interface.getSighash("hasRole"),
              pool.interface.getSighash("getRoleAdmin"),
              pool.interface.getSighash("grantRole"),
              pool.interface.getSighash("revokeRole"),
              pool.interface.getSighash("renounceRole"),
            ].reduce((acc, value) => acc.xor(ethers.BigNumber.from(value)), ethers.constants.Zero)
          )
        )
      ).to.equal(true);
      /* ERC721 */
      expect(await pool.supportsInterface(pool.interface.getSighash("onERC721Received"))).to.equal(true);
    });
    it("returns false on unsupported interfaces", async function () {
      expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
      expect(await pool.supportsInterface("0x00000000")).to.equal(false);
      expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
