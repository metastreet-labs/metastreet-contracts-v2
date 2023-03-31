import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  TestLoanReceipt,
  TestDelegationRegistry,
  ExternalCollateralLiquidator,
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
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("FixedRateSingleCollectionPool");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.deployed();

    /* Deploy external collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.deployed();

    /* Deploy collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      collateralLiquidatorImpl.address,
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize", [accounts[6].address])
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(delegationRegistry.address, [bundleCollateralWrapper.address])) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint64", "uint256", "tuple(uint64, uint64, uint64)"],
          [
            nft1.address,
            tok1.address,
            30 * 86400,
            45,
            [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")],
          ]
        ),
        collateralLiquidator.address,
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

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

    it("returns expected supported collateral wrappers", async () => {
      const collateralWrappers = await pool.collateralWrappers();
      expect(collateralWrappers.length).to.equal(1);
      expect(collateralWrappers[0]).to.equal(bundleCollateralWrapper.address);
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
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, loanReceipt, ethers.constants.Zero);

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
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, loanReceipt, ethers.constants.Zero);

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
    await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(pool.address, loanReceipt, ethers.utils.parseEther("5"));
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

    const repayment = await pool.quote(principal, duration, nft1.address, [tokenId], "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, await sourceLiquidity(principal), "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createActiveBundleLoan(
    principal: ethers.BigNumber,
    duration?: number = 30 * 86400
  ): Promise<[string, string, ethers.BigNumbe]> {
    /* Mint bundle */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);
    const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
    const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

    await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

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

    /* Extract loan receipt */
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

    return [loanReceipt, loanReceiptHash, bundleTokenId];
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
  /* Admin Fee Tests */
  /****************************************************************************/

  describe("#setAdminFeeRate", async function () {
    it("sets admin fee rate successfully", async function () {
      const rate = 500;

      /* Set admin fee rate */
      const tx = await pool.setAdminFeeRate(rate);

      /* Validate events */
      await expectEvent(tx, pool, "AdminFeeRateUpdated", {
        rate: rate,
      });

      /* Validate rate was successfully set */
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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x");

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

      /* Calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(repayment.sub(ethers.utils.parseEther("25"))).div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      const startingBalance = await tok1.balanceOf(accounts[1].address);

      /* Withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address, adminFee);

      /* Validate events */
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accounts[1].address,
        value: adminFee,
      });

      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        account: accounts[1].address,
        amount: adminFee,
      });

      /* Validate balance in account */
      expect(await tok1.balanceOf(accounts[1].address)).to.equal(startingBalance.add(adminFee));

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("withdraws admin fees with repayment after one third of loan maturity", async function () {
      /* Set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x");

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

      /* Decode loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate repayment proration */
      const repayTxTimestamp = (await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp;
      const proration = FixedPoint.from(
        repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)
      ).div(decodedLoanReceipt.duration);

      /* Calculate admin fee */
      const adminFee = (await pool.adminFeeRate())
        .mul(repayment.sub(ethers.utils.parseEther("25")))
        .div(10000)
        .mul(proration)
        .div(ethers.constants.WeiPerEther);

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      /* Withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address, adminFee);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        account: accounts[1].address,
        amount: adminFee,
      });

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("fails on invalid caller", async function () {
      /* Set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create repaid loan */
      await createRepaidLoan(ethers.utils.parseEther("25"));

      await expect(
        pool.connect(accounts[1]).withdrawAdminFees(accounts[1].address, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWith(/AccessControl: account .* is missing role .*/);
    });

    it("fails on invalid address", async function () {
      /* Set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create repaid loan */
      await createRepaidLoan(ethers.utils.parseEther("25"));

      await expect(
        pool.withdrawAdminFees(ethers.constants.AddressZero, ethers.utils.parseEther("0.00001"))
      ).to.be.revertedWithCustomError(pool, "InvalidAddress");
    });

    it("fails on parameter out of bounds", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create repaid loan */
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
      expect(await pool.quote(ethers.utils.parseEther("10"), 30 * 86400, nft1.address, [123], "0x")).to.equal(
        ethers.utils.parseEther("10.061438356146880000")
      );

      expect(await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x")).to.equal(
        ethers.utils.parseEther("25.153595890367200000")
      );
    });

    it("correctly quotes repayment for bundle", async function () {
      expect(await pool.quote(ethers.utils.parseEther("10"), 30 * 86400, nft1.address, [123, 124, 125], "0x")).to.equal(
        ethers.utils.parseEther("10.061438356146880000")
      );

      expect(await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123, 124, 125], "0x")).to.equal(
        ethers.utils.parseEther("25.153595890367200000")
      );
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("100"), 30 * 86400, nft1.address, [123], "0x")
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on insufficient liquidity for bundle", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("1000"), 30 * 86400, nft1.address, [123, 124, 125], "0x")
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool.quote(ethers.utils.parseEther("10"), 30 * 86400, tok1.address, [123], "0x")
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
    });
  });

  describe("#quoteRefinance", async function () {
    let loanReceipt: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes refinance payment and repayment at original loan maturity with same principal", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment, repayment] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("25"), 30 * 86400);

      // Validate quote
      expect(repayment).to.equal(decodedLoanReceipt.repayment);
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("25")));
    });

    it("correctly quotes refinance payment and repayment at original bundle loan maturity with same principal", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment, repayment] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("25"), 30 * 86400);

      // Validate quote
      expect(repayment).to.equal(decodedLoanReceipt.repayment);
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("25")));
    });

    it("correctly quotes refinance payment and repayment at original loan maturity with smaller principal (1 ETH less)", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment, _] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("24"), 30 * 86400);

      // Validate quote
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("24")));
    });

    it("correctly quotes refinance payment and repayment at original bundle loan maturity with smaller principal (1 ETH less)", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment, _] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("24"), 30 * 86400);

      // Validate quote
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("24")));
    });

    it("correctly quotes refinance payment and repayment at original loan maturity with bigger principal (1 ETH more)", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment, _] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("26"), 30 * 86400);

      // Validate quote
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("26")));
    });

    it("correctly quotes refinance payment and repayment at original bundle loan maturity with bigger principal (1 ETH more)", async function () {
      /* Create Loan */
      [loanReceipt] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      // Get decoded loan receipt
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      // Fast forward to maturity timestamp
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      await network.provider.send("evm_mine");

      // Get quote
      const [payment] = await pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("26"), 30 * 86400);

      // Validate quote
      expect(payment).to.equal(decodedLoanReceipt.repayment.sub(ethers.utils.parseEther("26")));
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quoteRefinance(loanReceipt, ethers.utils.parseEther("100"), 30 * 86400)
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x");

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
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Quote repayment */
      const repayment = await pool.quote(
        ethers.utils.parseEther("25"),
        30 * 86400,
        nft1.address,
        [123, 124, 125],
        "0x"
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
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x");

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
      /* Set admin fee */
      await pool.setAdminFeeRate(500);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [123], "0x");

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

      /* Calculate admin fee */
      const adminFee = (await pool.adminFeeRate()).mul(repayment.sub(ethers.utils.parseEther("25"))).div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(ethers.utils.parseEther("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));
      expect(repayment).to.equal(totalPending.add(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate total adminFee balance */
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
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      /* Set approvals */
      await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);

      /* Set length of tokenId to 31 instead of 32 */
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
      ).to.be.revertedWithCustomError(bundleCollateralWrapper, "InvalidContext");
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            ethers.utils.parseEther("25"),
            30 * 86400,
            tok1.address,
            123,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
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
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);

      /* Quote repayment */
      const repayment = await pool.quote(ethers.utils.parseEther("25"), 30 * 86400, nft1.address, [124, 125], "0x");

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

      /* Validate ticks */
      let totalDelta = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const delta = nodeReceipt.pending.sub(nodeReceipt.used);
        const node = await pool.liquidityNode(nodeReceipt.depth);
        expect(node.value).to.equal(ethers.utils.parseEther("25").add(delta));
        expect(node.available).to.equal(ethers.utils.parseEther("25").add(delta));
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalDelta = totalDelta.add(delta);
      }

      /* Validate liquidity statistics */
      const liquidityStatistics = await pool.liquidityStatistics();
      expect(liquidityStatistics[0]).to.equal(ethers.utils.parseEther("400").add(totalDelta));
      expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);

      expect(await bundleCollateralWrapper.ownerOf(bundleTokenId)).to.equal(accountBorrower.address);
    });

    for (const [description, timeElapsed] of [
      ["one third", (30 * 86400) / 3],
      ["8 / 9ths", (8 * 30 * 86400) / 9],
      ["1 second", 1],
    ]) {
      it(`repays loan after ${description} of loan duration has elasped`, async function () {
        const [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));
        const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

        /* Repay */
        elapseUntilTimestamp(decodedLoanReceipt.maturity - decodedLoanReceipt.duration + timeElapsed);
        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        /* Calculate proration */
        const repayTxTimestamp = (await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp;
        const proration = FixedPoint.from(
          repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)
        ).div(decodedLoanReceipt.duration);

        /* Calculate prorated repayment amount */
        const originationFee = decodedLoanReceipt.principal.mul(45).div(10000);
        const repayment = decodedLoanReceipt.repayment
          .sub(decodedLoanReceipt.principal)
          .sub(originationFee)
          .mul(proration)
          .div(ethers.constants.WeiPerEther)
          .add(decodedLoanReceipt.principal)
          .add(originationFee);

        /* Validate events */
        await expectEvent(repayTx, tok1, "Transfer", {
          from: accountBorrower.address,
          to: pool.address,
          value: repayment,
        });

        await expectEvent(repayTx, nft1, "Transfer", {
          from: pool.address,
          to: accountBorrower.address,
          tokenId: 123,
        });

        await expectEvent(repayTx, pool, "LoanRepaid", {
          loanReceiptHash,
          repayment,
        });

        /* Validate state */
        expect(await pool.loans(loanReceiptHash)).to.equal(2);

        /* Validate ticks */
        let totalDelta = ethers.constants.Zero;
        for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
          const delta = nodeReceipt.pending.sub(nodeReceipt.used).mul(proration).div(ethers.constants.WeiPerEther);
          const node = await pool.liquidityNode(nodeReceipt.depth);
          expect(node.value).to.equal(ethers.utils.parseEther("25").add(delta));
          expect(node.available).to.equal(ethers.utils.parseEther("25").add(delta));
          expect(node.pending).to.equal(ethers.constants.Zero);
          totalDelta = totalDelta.add(delta);
        }

        /* Validate liquidity statistics */
        const liquidityStatistics = await pool.liquidityStatistics();
        expect(liquidityStatistics[0]).to.equal(ethers.utils.parseEther("400").add(totalDelta));
        expect(liquidityStatistics[1]).to.equal(ethers.constants.Zero);
      });
    }

    it("repays with admin fee", async function () {
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
      /* Borrow */
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
    let bundleTokenId: ethers.BigNumber;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan at maturity with delegation, admin fee, and same principal as original loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
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

    it("refinance loan at maturity with delegation, admin fee and where new principal is 1 ETH less than original loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal.sub(ethers.utils.parseEther("1")),
          15 * 86400,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
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
        value: decodedLoanReceipt.repayment.sub(decodedNewLoanReceipt.principal),
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
      expect(liquidityStatistics[1]).to.equal(decodedLoanReceipt.principal.sub(ethers.utils.parseEther("1")));
    });

    it("refinance loan at maturity with delegation, admin fee and where new principal is 1 ETH more than original loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal.add(ethers.utils.parseEther("1")),
          15 * 86400,
          ethers.utils.parseEther("27"),
          await sourceLiquidity(ethers.utils.parseEther("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
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
        from: pool.address,
        to: accountBorrower.address,
        value: decodedNewLoanReceipt.principal.sub(decodedLoanReceipt.repayment),
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
      expect(liquidityStatistics[1]).to.equal(decodedLoanReceipt.principal.add(ethers.utils.parseEther("1")));
    });

    it("refinance bundle loan at maturity admin fee, and same principal as original loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() - 1);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          ethers.utils.parseEther("26"),
          await sourceLiquidity(ethers.utils.parseEther("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
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
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      // Validate inability to do both refinance() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              ethers.utils.parseEther("25"),
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              ethers.utils.parseEther("25"),
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      // Validate inability to do both refinance() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              ethers.utils.parseEther("25"),
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              ethers.utils.parseEther("25"),
              1,
              ethers.utils.parseEther("26"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      // Workaround to skip borrow() in beforeEach
      await pool.connect(accountBorrower).repay(loanReceipt);

      // Get token id
      const tokenId =
        (await nft1.ownerOf(123)) === accountBorrower.address
          ? 123
          : (await nft1.ownerOf(124)) === accountBorrower.address
          ? 124
          : 125;

      // Borrow to get loan receipt object
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("1"),
          1,
          nft1.address,
          [tokenId],
          ethers.utils.parseEther("2"),
          await sourceLiquidity(ethers.utils.parseEther("1")),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      // Use existing loan receipt with the parameters we want
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      // Mutate nft address in loan receipt and encode it
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = nft1.address;
      nodeReceipt.borrower = accountBorrower.address;
      nodeReceipt.maturity = ethers.BigNumber.from("10000000001");
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      // Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow()
      await elapseUntilTimestamp(9999999999);

      // Validate inability to do both borrow() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              ethers.utils.parseEther("1"),
              1,
              nft1.address,
              [tokenId],
              ethers.utils.parseEther("2"),
              await sourceLiquidity(ethers.utils.parseEther("25")),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              ethers.utils.parseEther("2"),
              await sourceLiquidity(ethers.utils.parseEther("1")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      // Workaround to skip borrow() in beforeEach
      await pool.connect(accountBorrower).repay(loanReceipt);

      // Borrow to get loan receipt object
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          ethers.utils.parseEther("1"),
          1,
          bundleCollateralWrapper.address,
          bundleTokenId,
          ethers.utils.parseEther("2"),
          await sourceLiquidity(ethers.utils.parseEther("1")),
          ethers.utils.solidityPack(
            ["uint16", "uint16", "address", "uint256[]"],
            [2, 20 + 32 * 3, nft1.address, [123, 124, 125]]
          )
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      // Use existing loan receipt with the parameters we want
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      // Mutate nft address in loan receipt and encode it
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = bundleCollateralWrapper.address;
      nodeReceipt.borrower = accountBorrower.address;
      nodeReceipt.maturity = ethers.BigNumber.from("10000000001");
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      // Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow()
      await elapseUntilTimestamp(9999999999);

      // Validate inability to do both borrow() and refinance() with the same loan receipt fields
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              ethers.utils.parseEther("1"),
              1,
              bundleCollateralWrapper.address,
              bundleTokenId,
              ethers.utils.parseEther("2"),
              await sourceLiquidity(ethers.utils.parseEther("1")),
              ethers.utils.solidityPack(
                ["uint16", "uint16", "address", "uint256[]"],
                [2, 20 + 32 * 3, nft1.address, [123, 124, 125]]
              ),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              ethers.utils.parseEther("2"),
              await sourceLiquidity(ethers.utils.parseEther("1")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("1"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("bundle loan fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("1"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on expired loan", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "LoanExpired");
    });

    it("bundle loan fails on expired loan", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "LoanExpired");
    });

    it("fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on repaid loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on liquidated loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Refinance */
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
            15 * 86400,
            ethers.utils.parseEther("26"),
            await sourceLiquidity(ethers.utils.parseEther("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("bundle loan fails on liquidated loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Refinance */
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            ethers.utils.parseEther("25"),
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
    let bundleTokenId: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidates expired loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

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

    it("liquidates expired bundle loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash, bundleTokenId] = await createActiveBundleLoan(ethers.utils.parseEther("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await elapseUntilTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, bundleCollateralWrapper, "Transfer", {
        from: pool.address,
        to: collateralLiquidator.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(liquidateTx, pool, "LoanLiquidated", {
        loanReceiptHash,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(3);
    });

    it("fails on non-expired loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "LoanNotExpired");
    });

    it("fails on repaid loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(ethers.utils.parseEther("25"));

      /* Repay */
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
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

      /* Liquidate collateral and process liquidation */
      const onCollateralLiquidatedTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, loanReceipt, ethers.utils.parseEther("30"));

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
      await collateralLiquidator.connect(accountLiquidator).withdrawCollateral(pool.address, loanReceipt);

      /* Liquidate collateral and process liquidation */
      const proceeds = decodedLoanReceipt.nodeReceipts[0].pending.add(decodedLoanReceipt.nodeReceipts[1].pending);
      await collateralLiquidator.connect(accountLiquidator).liquidateCollateral(pool.address, loanReceipt, proceeds);

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
