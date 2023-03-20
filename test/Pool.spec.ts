import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegationRegistry,
  FixedInterestRateModel,
  CollectionCollateralFilter,
  ExternalCollateralLiquidator,
  ICollateralLiquidator,
  Pool,
  BundleCollateralWrapper,
} from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { elapseUntilTimestamp } from "./helpers/BlockchainUtilities";
import { FixedPoint } from "./helpers/FixedPoint.ts";

describe("Pool", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
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
  let bundleCollateralWrapper: BundleCollateralWrapper;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testNoteAdapterFactory = await ethers.getContractFactory("TestNoteAdapter");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const collectionCollateralFilterFactory = await ethers.getContractFactory("CollectionCollateralFilter");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const fixedInterestRateModelFactory = await ethers.getContractFactory("FixedInterestRateModel");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    const poolFactory = await ethers.getContractFactory("Pool");
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
        45,
        delegationRegistry.address,
        bundleCollateralWrapper.address,
        collateralFilterImpl.address,
        interestRateModelImpl.address,
        collateralLiquidatorImpl.address,
        ethers.utils.defaultAbiCoder.encode(["address"], [nft1.address]),
        ethers.utils.defaultAbiCoder.encode(
          ["uint64", "uint64", "uint64"],
          [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")]
        ),
        ethers.utils.defaultAbiCoder.encode(["address"], [accounts[6].address]),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

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

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(pool.address, true);
    /* Approve pool to tranasfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);
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
      ).to.be.revertedWithCustomError(pool, "InsufficientTickSpacing");
    });

    it("fails on insolvent tick", async function () {
      /* Setup insolvent tick at 10 ETH */
      await setupInsolventTick();
      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("1"))
      ).to.be.revertedWithCustomError(pool, "InsolventLiquidity");
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

      /* Create loan */
      await createActiveLoan(ethers.utils.parseEther("15"));

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

      /* Create active loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));

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
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("5"));
      expect(amount.sub(ethers.utils.parseEther("5")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
    });

    it("returns partial redemption available from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));
      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(ethers.utils.parseEther("3"));
      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(ethers.utils.parseEther("11"));
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
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Partial redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
      expect(amount.sub(ethers.utils.parseEther("3")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));

      /* Repay loan 2 */
      await pool.connect(accountBorrower).repay(loanReceipt2);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, ethers.utils.parseEther("10"));
      expect(shares).to.equal(ethers.utils.parseEther("8"));
      expect(amount.sub(ethers.utils.parseEther("8")).abs()).to.be.lt(ethers.utils.parseEther("0.1"));
    });

    it("returns written down redemption available from liquidated loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("10"), ethers.utils.parseEther("10"));
      await pool.connect(accountDepositors[0]).deposit(ethers.utils.parseEther("15"), ethers.utils.parseEther("5"));

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));

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
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);
      /* Process expiration */
      await pool.liquidate(loanReceipt);
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

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));

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

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

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

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(ethers.utils.parseEther("3"));
      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(ethers.utils.parseEther("11"));

      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("8"));

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

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
      await pool.connect(accountBorrower).repay(loanReceipt2);

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

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));
      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(ethers.utils.parseEther("10"), ethers.utils.parseEther("5"));

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);
      /* Process expiration */
      await pool.liquidate(loanReceipt);
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

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("14"));

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
      await pool.connect(accountBorrower).repay(loanReceipt);

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
    const TICK_SPACING_BASIS_POINTS = await pool.TICK_SPACING_BASIS_POINTS();

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
    for (const node of nodes) {
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

    /* Create expired loan taking 15 ETH */
    const [loanReceipt] = await createExpiredLoan(ethers.utils.parseEther("15"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(loanReceipt, ethers.utils.parseEther("5"));
  }

  async function createActiveLoan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string]> {
    const tokenId =
      (await nft1.ownerOf(123)) === accountBorrower.address
        ? 123
        : (await nft1.ownerOf(124)) === accountBorrower.address
        ? 124
        : 125;
    const repayment = await pool.quote(principal, duration, nft1.address, tokenId, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, await sourceLiquidity(principal), "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createExpiredLoan(principal: ethers.BigNumber): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Wait for loan expiration */
    const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
    await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

    return [loanReceipt, loanReceiptHash];
  }

  async function createRepaidLoan(principal: ethers.BigNumber): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Repay */
    await pool.connect(accountBorrower).repay(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  async function createLiquidatedLoan(principal: ethers.BigNumber): Promise<ethers.BigNumber> {
    /* Create expired loan */
    const [loanReceipt, loanReceiptHash] = await createExpiredLoan(principal);

    /* Liquidate */
    await pool.connect(accountLender).liquidate(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  /****************************************************************************/
  /* Privileged API Tests */
  /****************************************************************************/

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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x");

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          "0x"
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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x");

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          "0x"
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

      await createRepaidLoan(ethers.utils.parseEther("25"));

      await expect(
        pool.connect(accounts[1]).withdrawAdminFees(accounts[1].address, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });

    it("fails on invalid address", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      await createRepaidLoan(ethers.utils.parseEther("25"));

      await expect(
        pool.withdrawAdminFees(ethers.constants.AddressZero, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWithCustomError(pool, "InvalidAddress");
    });

    it("fails on parameter out of bounds", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      await createRepaidLoan(ethers.utils.parseEther("25"));

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
      expect(await pool.quote(ethers.utils.parseEther("10"), 30 * 86400, nft1.address, 123, "0x")).to.equal(
        ethers.utils.parseEther("10.061438356146880000")
      );
      expect(await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x")).to.equal(
        ethers.utils.parseEther("25.153595890367200000")
      );
    });
    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("100"), 30 * 86400, nft1.address, 123, "0x")
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
    it("fails on unsupported collateral", async function () {
      /* FIXME implement */
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x");

      /* Simulate borrow */
      const returnVal = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          "0x"
        );

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
          "0x"
        );

      /* Validate return value from borrow() */
      expect(returnVal).to.equal(repayment);

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

    it("originates bundle loan", async function () {
      /* Mint bundle */
      await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleCollateralWrapperTokenMinted"))
        .args.tokenId;

      /* Quote repayment */
      const repayment = await pool.quote(
        ethers.utils.parseEther("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        ethers.utils.solidityPack(
          ["uint16", "uint16", "address", "uint256[]"],
          [2, 20 + 32 * 3, nft1.address, [123, 124, 125]]
        )
      );

      await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

      /* Simulate borrow */
      const returnVal = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "address", "uint256[]"],
            [2, 20 + 32 * 3, nft1.address, [123, 124, 125]]
          )
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "address", "uint256[]"],
            [2, 20 + 32 * 3, nft1.address, [123, 124, 125]]
          )
        );

      /* Validate return value from borrow() */
      expect(returnVal).to.equal(repayment);

      /* Validate events */
      await expectEvent(mintTx, bundleCollateralWrapper, "Transfer", {
        from: ethers.constants.AddressZero,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
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
      expect(decodedLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp + 30 * 86400
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralContextLength).to.equal(20 + 32 * 3);
      expect(decodedLoanReceipt.collateralContextData).to.equal(
        ethers.utils.solidityPack(["address", "uint256[]"], [nft1.address, [123, 124, 125]])
      );
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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x");

      /* Simulate borrow */
      const returnVal = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [1, 20, accountBorrower.address])
        );

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
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [1, 20, accountBorrower.address])
        );

      /* Validate return value from borrow() */
      expect(returnVal).to.equal(repayment);

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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, 123, "0x");

      /* Simulate borrow */
      const returnVal = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          123,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          "0x"
        );

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
          "0x"
        );

      /* Validate return value from borrow() */
      expect(returnVal).to.equal(repayment);

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

    it("fails on bundle with invalid option encoding", async function () {
      /* Mint bundle */
      await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleCollateralWrapperTokenMinted"))
        .args.tokenId;

      await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

      /* set length of tokenId to 31 instead of 32 */
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            bundleCollateralWrapper.address,
            bundleTokenId,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            ethers.utils.solidityPack(
              ["uint16", "uint16", "address", "uint256[]"],
              [2, 20 + 31 * 3, nft1.address, [123, 124, 125]]
            )
          )
      ).to.be.revertedWithCustomError(pool, "InvalidBorrowOptionsEncoding");
    });

    it("fails on single asset loan with collateral context data", async function () {
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
            ethers.utils.solidityPack(
              ["uint16", "uint16", "address", "uint256[]"],
              [2, 20 + 31 * 3, nft1.address, [123, 124, 125]]
            )
          )
      ).to.be.revertedWithCustomError(pool, "InvalidBorrowOptionsEncoding");
    });

    it("fails on unsupported collateral", async function () {
      /* FIXME implement */
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
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays loan at maturity", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
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

    it("repays bundle loan at maturity", async function () {
      await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
      const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [124, 125]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleCollateralWrapperTokenMinted"))
        .args.tokenId;

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);

      /* Quote repayment */
      const repayment = await pool.quote(
        ethers.utils.parseEther("25"),
        30 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        ethers.utils.solidityPack(
          ["uint16", "uint16", "address", "uint256[]"],
          [2, 20 + 32 * 2, nft1.address, [124, 125]]
        )
      );

      await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          repayment,
          await sourceLiquidity(ethers.utils.parseEther("25")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "address", "uint256[]"],
            [2, 20 + 32 * 2, nft1.address, [124, 125]]
          )
        );

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(pool.address);

      const bundleLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const bundleLoanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(bundleLoanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(bundleLoanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment,
      });

      await expectEvent(repayTx, bundleCollateralWrapper, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash: bundleLoanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      /* Validate state */
      expect(await pool.loans(bundleLoanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      const liquidityStatistics = await pool.liquidityStatistics();
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.depth);
        const value = ethers.utils.parseEther("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        // expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        // expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      expect(liquidityStatistics[0]).to.equal(ethers.utils.parseEther("25").mul(16).add(totalPending.sub(totalUsed)));
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);
    });

    it("repays loan after one third of original loan duration has elasped", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const originationFee = decodedLoanReceipt.principal.mul(45).div(10000);
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .sub(originationFee)
        .div(3)
        .add(decodedLoanReceipt.principal)
        .add(originationFee);

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
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (30 * 86400) / 9);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const originationFee = decodedLoanReceipt.principal.mul(45).div(10000);
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .sub(originationFee)
        .mul(8)
        .div(9)
        .add(decodedLoanReceipt.principal)
        .add(originationFee);

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
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 30 * 86400 + 1);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const originationFee = decodedLoanReceipt.principal.mul(45).div(10000);
      const repayment = decodedLoanReceipt.repayment
        .sub(decodedLoanReceipt.principal)
        .sub(originationFee)
        .div(30 * 86400)
        .add(decodedLoanReceipt.principal)
        .add(originationFee);

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
        repayment: repayment.sub(1),
      });

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
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

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

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("repays removes delegation", async function () {
      await setupLiquidity();

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("25"),
          30 * 86400,
          nft1.address,
          124,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [1, 20, accountBorrower.address])
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 124,
        value: true,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 124)
      ).to.equal(false);
    });

    it("fails on invalid caller", async function () {
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));
      await expect(pool.connect(accountLender).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on expired loan", async function () {
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));
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
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on liquidated loan", async function () {
      const [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
    });

    it("refinance loan at maturity with admin fee", async function () {
      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          15 * 86400,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* calculate admin fee */
      const adminFee = (await pool.adminFeeRate())
        .mul(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("25")))
        .div(10000);

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(1);
      expect(decodedNewLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedNewLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp + 15 * 86400
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        value: decodedLoanReceipt.repayment.sub(decodedLoanReceipt.principal),
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);

      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      /* Validate liquidity statistics */
      const liquidityStatistics = await pool.liquidityStatistics();
      expect(liquidityStatistics[0]).to.equal(
        ethers.utils
          .parseEther("25")
          .mul(16)
          .add(decodedLoanReceipt.repayment.sub(decodedLoanReceipt.principal).sub(adminFee))
      );
      expect(liquidityStatistics[1]).to.equal(decodedLoanReceipt.principal);
    });

    it("fails on refinance and refinance in same block with same loan receipt fields", async function () {
      // Validate inability to do both refinance() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on borrow and refinance in same block with same loan receipt fields", async function () {
      // Workaround to skip borrow() in beforeEach
      await pool.connect(accountBorrower).repay(loanReceipt);

      // Get token id
      const tokenId =
        (await nft1.ownerOf(123)) === accountBorrower.address
          ? 123
          : (await nft1.ownerOf(124)) === accountBorrower.address
          ? 124
          : 125;

      // Precompute repayment for the borrow() later with a simulation
      const repayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          ethers.utils.parseEther("25"),
          1,
          nft1.address,
          tokenId,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25")),
          "0x"
        );

      // Use existing loan receipt with the parameters we want
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(
        "0x010000000000000000000000000000000000000000000000015af1d78b58c400000000000000000000000000000000000000000000000000015c8185b67305c36715d34aaf54267db7d7c367839aaf71a00a2c6a6500000002540be4010000000000000001e7f1725e7734ce288f8367e1bb143e90bb3f0512000000000000000000000000000000000000000000000000000000000000007b00000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000df871d7d0264e0000000000000000001158e460913d0000000000000000000003782dace9d900000000000000000000038fe8d1129b4e00000000000000000015af1d78b58c4000000000000000000004563918244f40000000000000000000046df43c4d118e0000000000000000001b1ae4d6e2ef50000000000000000000056bc75e2d63100000000000000000000583828256255e00000000000000000021e19e0c9bab2400000000000000000006c6b935b8bbd400000000000000000006de7459e17e220000000000000000002a5a058fc295ed0000000000000000000878678326eac9000000000000000000089022a74fad1700000000000000000034f086f3b33b684000000000000000000a968163f0a57b4000000000000000000aae3c881967c9400000000000000000422ca8b0a00a425000000000000000000d3c21bcecceda1000000000000000000d53dce115912810000000000000000052b7d2dcc80cd2e40000000000000000108b2a2c28029094000000000000000010a2e55050c4de9400000000000000006765c793fa10079d000000000000000014adf4b7320334b9000000000000000014c5afdb5ac582b90000000000000000813f3978f8940984000000000000000019d971e4fe8401e7000000000000000019f12d0927464fe70000000000000000a18f07d736b90be50000000000000000204fce5e3e25026100000000000000002067898266e750610000000000000000c9f2c9cd04674ede00000000000000002863c1f5cdae42f90000000000000000287b7d19f67090f90000000000000000fc6f7c40458122950000000000000000327cb2734119d3b7000000000000000032946d9769dc21b700000000000000013b8b5b5056e16b3a00000000000000003f1bdf10116048a500000000000000003f339a343a2296a500000000000000018a6e32246c99c60800000000000000001f667c3b01e294c600000000000000001f7e375f2aa4e2cf"
      );

      // Mutate nft address in loan receipt and encode it
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = nft1.address;
      const encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      // Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow()
      await elapseUntilTimestamp(9999999999);

      // Validate inability to do both borrow() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              ethers.utils.parseEther("25"),
              1,
              nft1.address,
              tokenId,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on invalid caller", async function () {
      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on expired loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "LoanExpired");
    });

    it("fails on invalid loan receipt", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on liquidated loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#liquidate", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();

      /* Borrow */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
    });

    it("liquidates expired loan", async function () {
      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, nft1, "Transfer", {
        from: pool.address,
        to: collateralLiquidator.address,
        tokenId: 123,
      });
      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });

    it("fails on non-expired loan", async function () {
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanStatus");
    });

    it("fails on repaid loan", async function () {
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  /****************************************************************************/
  /* Callbacks */
  /****************************************************************************/

  describe("#onCollateralLiquidated", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();

      /* Borrow */
      [loanReceipt, loanReceiptHash] = await createExpiredLoan(ethers.utils.parseEther("25"));
    });

    it("processes liquidated loan for higher proceeds", async function () {
      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

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
      expect(total).to.equal(
        ethers.utils.parseEther("400").add(ethers.utils.parseEther("30")).sub(decodedLoanReceipt.principal)
      );
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
        .add(ethers.utils.parseEther("30").sub(decodedLoanReceipt.repayment));
      expect(node.value).to.equal(value);
      expect(node.available).to.equal(value);
      expect(node.pending).to.equal(ethers.constants.Zero);
    });

    it("processes liquidated loan for lower proceeds", async function () {
      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(loanReceipt);

      /* Liquidate collateral and process liquidation */
      const proceeds = decodedLoanReceipt.nodeReceipts[0].pending.add(decodedLoanReceipt.nodeReceipts[1].pending);
      await collateralLiquidator.connect(accountLiquidator).liquidateCollateral(loanReceipt, proceeds);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);
      expect(await pool.utilization()).to.equal(0);
      const [total, used] = await pool.liquidityStatistics();
      expect(total).to.equal(ethers.utils.parseEther("400").sub(decodedLoanReceipt.principal).add(proceeds));
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
