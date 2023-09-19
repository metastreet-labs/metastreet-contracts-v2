import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  TestLoanReceipt,
  TestDelegationRegistry,
  ExternalCollateralLiquidator,
  Pool,
} from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";

describe("Pool Basic", function () {
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

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");

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
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.deployed();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      proxy.address
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry */
    delegationRegistry = await delegationRegistryFactory.deploy();
    await delegationRegistry.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      5000,
      collateralLiquidator.address,
      delegationRegistry.address,
      [],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "address", "uint64[]", "uint64[]"],
          [
            nft1.address,
            tok1.address,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      accountLiquidator.address
    );

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

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);
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
    it("matches expected implementation name", async function () {
      expect(await pool.IMPLEMENTATION_NAME()).to.equal("WeightedRateCollectionPool");
    });
    it("matches expected implementation version", async function () {
      expect(await pool.IMPLEMENTATION_VERSION()).to.equal("2.0");
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("getters", async function () {
    it("returns expected currency token", async function () {
      expect(await pool.currencyToken()).to.equal(tok1.address);
    });
    it("returns expected admin fee rate", async function () {
      expect(await pool.adminFeeRate()).to.equal(0);
    });
    it("returns expected collateral wrappers", async function () {
      const collateralWrappers = await pool.collateralWrappers();
      expect(collateralWrappers[0]).to.equal(ethers.constants.AddressZero);
      expect(collateralWrappers[1]).to.equal(ethers.constants.AddressZero);
      expect(collateralWrappers[2]).to.equal(ethers.constants.AddressZero);
    });
    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(collateralLiquidator.address);
    });
    it("returns expected delegation registry", async function () {
      expect(await pool.delegationRegistry()).to.equal(delegationRegistry.address);
    });
  });

  /****************************************************************************/
  /* Deposit API */
  /****************************************************************************/

  describe("#deposit", async function () {
    it("successfully deposits", async function () {
      const depositTx = await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate events */
      await expectEvent(depositTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        amount: FixedPoint.from("1"),
        shares: FixedPoint.from("1"),
      });

      await expectEvent(depositTx, tok1, "Transfer", {
        from: accountDepositors[0].address,
        to: pool.address,
        value: FixedPoint.from("1"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("1"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("999"));
    });

    it("successfully deposits additional", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Deposit 2 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("3"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("997"));
    });

    it("successfully deposits at new tick after garbage collecting old tick", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Only two nodes (including head) */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);

      /* Redeem 1 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Only head node now */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(1);

      /* Deposit 1 ETH at new tick close to garbage collected one */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10.1"), FixedPoint.from("1"), 0);

      /* Two nodes again */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);
    });

    it("fails on invalid tick spacing", async function () {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10.1"), FixedPoint.from("2"), 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientTickSpacing");
    });

    it("fails on impaired tick", async function () {
      /* Setup impaired tick at 10 ETH */
      await setupImpairedTick();

      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InactiveLiquidity");
    });

    it("fails on insolvent tick", async function () {
      /* Setup insolvent tick at 10 ETH */
      await setupInsolventTick();

      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InactiveLiquidity");
    });

    it("fails on invalid tick", async function () {
      /* Zero tick */
      await expect(
        pool.connect(accountDepositors[0]).deposit(0, FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds duration */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10", 5, 0), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds rate */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10", 0, 5), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds reserved field */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10", 0, 0).add(2), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Zero limit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("0", 0, 0), FixedPoint.from("1"), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on transfer failure", async function () {
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2000"), 0)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1000 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("1"), FixedPoint.from("1000"), 0);

      /* Borrow 0.5 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      /* Revert since shares received is 0 */
      await expect(
        pool.connect(accountDepositors[1]).deposit(Tick.encode("1"), FixedPoint.from("0.000000000000000001"), 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");

      /* Revert since shares received less than min shares */
      await expect(
        pool.connect(accountDepositors[1]).deposit(Tick.encode("1"), FixedPoint.from("1"), "999995890427848045")
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });
  });

  describe("#redeem", async function () {
    it("successfully redeems entire deposit from available cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 1 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("1"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("1"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("successfully redeems partial deposit from available cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 0.5 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("0.5"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("successfully schedules redemption", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("10"), 0);

      /* Create loan */
      await createActiveLoan(FixedPoint.from("15"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate tick state */
      const node = await pool.liquidityNode(Tick.encode("10"));
      expect(node.value).to.equal(FixedPoint.from("10"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(FixedPoint.from("5"));
    });

    it("successfully schedules multiple redemptions", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("10"), 0);

      /* Create loan */
      await createActiveLoan(FixedPoint.from("15"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));
      /* Redeem another 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("2"));

      /* Validate redemption state */
      const redemption1 = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption1.pending).to.equal(FixedPoint.from("5"));
      expect(redemption1.index).to.equal(ethers.constants.Zero);
      expect(redemption1.target).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      const redemption2 = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 1);
      expect(redemption2.pending).to.equal(FixedPoint.from("5"));
      expect(redemption2.index).to.equal(ethers.constants.Zero);
      expect(redemption2.target).to.equal(FixedPoint.from("5"));

      /* Validate tick state */
      const node = await pool.liquidityNode(Tick.encode("10"));
      expect(node.value).to.equal(FixedPoint.from("10"));
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(FixedPoint.from("10"));
    });

    it("redeemed node with redemption dust is garbage collected", async function () {
      /* Deposits at 1 ETH and 2 ETH ticks */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("1"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("2"), FixedPoint.from("2"), 0);

      /* Get shares for 2 ETH tick */
      let shares = (await pool.deposits(accountDepositors[0].address, Tick.encode("2"))).shares;

      /* Borrow using both ticks */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1.999999999999999999"),
          3 * 86400,
          nft1.address,
          123,
          FixedPoint.from("2.1"),
          await sourceLiquidity(FixedPoint.from("1.999999999999999999")),
          "0x"
        );

      /* Get decoded loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Redeem all shares from 2 ETH tick */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("2"), shares);

      /* Fast forward timestamp to loan maturity */
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber());

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate 2 ETH node has dust */
      let node = await pool.liquidityNode(Tick.encode("2"));
      expect(node.available).to.equal(1);
      expect(node.shares).to.equal(ethers.constants.Zero);
      expect(node.value).to.equal(1);

      /* Validate 2 ETH node unlinked */
      let nodes = await pool.liquidityNodes(0, MaxUint128);
      expect(nodes[nodes.length - 1].tick).to.equal(Tick.encode("1"));

      /* Validate shares redeemed */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("2"), 0);
      const redeemedShares = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares;
      expect(redeemedShares).to.equal(shares);
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 1.25 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1.25"))
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });

    it("fails on zero shares", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 1.25 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), ethers.constants.Zero)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });
  });

  describe("#redemptionAvailable", async function () {
    it("returns redemption available from cash", async function () {
      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(amount).to.equal(FixedPoint.from("0.5"));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("returns full redemption available from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create active loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(amount.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("returns partial redemption available from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("3"));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("11"));

      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("8"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Partial redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Repay loan 2 */
      await pool.connect(accountBorrower).repay(loanReceipt2);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(FixedPoint.from("8"));
      expect(amount.sub(FixedPoint.from("8")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("2"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("8"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("returns written down redemption available from liquidated loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, ethers.constants.Zero);

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(amount).to.equal(ethers.constants.Zero);

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("returns partial redemption available from subsequent deposit", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("3"), 0);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("returns zero redemption available from dust cash", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("10"));

      /* Redeem 10 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("10"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("10"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Deposit from depositor #2, causing a partial redemption of depositor #1 */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("0.1"), 0);

      /* Validate partial redemption available for depositor #1 */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(shares).to.be.gt(ethers.constants.Zero);
      expect(amount).to.be.gt(ethers.constants.Zero);

      /* Validate tick has rounding dust in cash available */
      const node = await pool.liquidityNode(Tick.encode("10"));
      expect(node.available).to.equal(1);

      /* Redeem from depostior #2 */
      await pool.connect(accountDepositors[1]).redeem(Tick.encode("10"), FixedPoint.from("0.05"));

      /* Validate zero redemption available for depositor #2, despite the dust cash available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[1].address, Tick.encode("10"), 0);
      expect(shares).to.equal(ethers.constants.Zero);
      expect(amount).to.equal(ethers.constants.Zero);

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares).to.be.closeTo(FixedPoint.from("0.05"), FixedPoint.from("0.01"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[1].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.05"));
      expect(redemption.index).to.equal(ethers.BigNumber.from("1"));
      expect(redemption.target).to.be.closeTo(FixedPoint.from("10"), FixedPoint.from("0.1"));
    });

    it("correctly returns sharesAhead", async function () {
      /* Depositor 1 deposits 5 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);
      let [shares1, redemptionId1] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));

      /* Depositor 2 deposits 5 ETH */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);
      let [shares2, redemptionId2] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));

      /* Borrow 8 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(FixedPoint.from("8"), 30 * 86400, nft1.address, 123, FixedPoint.from("9"), [Tick.encode("10")], "0x");

      /* Depositor 1 redeems all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), shares1);

      /* Depositor 2 redeems all shares */
      await pool.connect(accountDepositors[1]).redeem(Tick.encode("10"), shares2);

      /* Get redemption available */
      let redemptionAvailable1 = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      let redemptionAvailable2 = await pool.redemptionAvailable(accountDepositors[1].address, Tick.encode("10"), 0);

      /* Validate sharesAhead */
      expect(redemptionAvailable1.sharesAhead).to.equal(0);
      expect(redemptionAvailable2.sharesAhead).to.equal(FixedPoint.from("3"));

      /* Depositor 2 deposits another 4 ETH */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("4"), 0);

      /* Get redemption available */
      redemptionAvailable1 = await pool.redemptionAvailable(accountDepositors[0].address, Tick.encode("10"), 0);
      redemptionAvailable2 = await pool.redemptionAvailable(accountDepositors[1].address, Tick.encode("10"), 0);

      /* Validate sharesAhead */
      expect(redemptionAvailable1.sharesAhead).to.equal(0);
      expect(redemptionAvailable2.sharesAhead).to.equal(0);
    });
  });

  describe("#withdraw", async function () {
    it("withdraws fully available redemption from cash", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      /* Simulated withdrawal should return 0.5 ETH and 500000000000000000 shares */
      const withdrawal = await pool.connect(accountDepositors[0]).callStatic.withdraw(Tick.encode("10"), 0);
      expect(withdrawal[0]).to.equal(FixedPoint.from("0.5"));
      expect(withdrawal[1]).to.equal(FixedPoint.from("0.5"));

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("0.5"),
        amount: FixedPoint.from("0.5"),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
        value: FixedPoint.from("0.5"),
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("999.5"));
    });

    it("withdraws fully available redemption from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;
      expect(amount.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("withdraws multiple fully available redemptions from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));
      /* Redeem another 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw first redemption */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(amount1.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Withdraw second redemption */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 1);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 1,
        shares: FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(amount2.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("2"));

      /* Validate redemption state */
      const redemption1 = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption1.pending).to.equal(ethers.constants.Zero);
      expect(redemption1.index).to.equal(ethers.constants.Zero);
      expect(redemption1.target).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      const redemption2 = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 1);
      expect(redemption2.pending).to.equal(ethers.constants.Zero);
      expect(redemption2.index).to.equal(ethers.constants.Zero);
      expect(redemption2.target).to.equal(ethers.constants.Zero);
    });

    it("withdraws partially available redemption from repaid loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("3"));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("11"));

      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("8"));

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(shares1.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount1.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("2"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("8").sub(shares1));
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Repay loan 2 */
      await pool.connect(accountBorrower).repay(loanReceipt2);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(shares2.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount2.sub(FixedPoint.from("5")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("2"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("withdraws fully written down redemption from liquidated loan", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, ethers.constants.Zero);

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
        amount: ethers.constants.Zero,
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("withdraws partially available redemption from subsequent deposit", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("3"), 0);

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(shares1.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount1.sub(FixedPoint.from("3")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5").sub(shares1));
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: pool.address,
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(shares2.sub(FixedPoint.from("2")).abs()).to.be.lt(FixedPoint.from("0.1"));
      expect(amount2.sub(FixedPoint.from("2")).abs()).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("advances redemption queue on withdraw", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("5"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("5"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[2]).deposit(Tick.encode("5"), FixedPoint.from("1"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("3"));

      /* Redeem shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("5"), FixedPoint.from("0.5"));
      await pool.connect(accountDepositors[1]).redeem(Tick.encode("5"), FixedPoint.from("1"));
      await pool.connect(accountDepositors[2]).redeem(Tick.encode("5"), FixedPoint.from("0.25"));

      /* Validate redemption queue */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("0"));
      redemption = await pool.redemptions(accountDepositors[1].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("0.5"));
      redemption = await pool.redemptions(accountDepositors[2].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("1.5"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(Tick.encode("5"), FixedPoint.from("0.25"), 0);

      /* Withdraw shares */
      let withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(ethers.constants.Zero);
      redemption = await pool.redemptions(accountDepositors[1].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("0.25"), FixedPoint.from("0.01"));
      redemption = await pool.redemptions(accountDepositors[2].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("1.25"), FixedPoint.from("0.01"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(Tick.encode("5"), FixedPoint.from("0.5"), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[0]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("5"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(ethers.constants.Zero);
      redemption = await pool.redemptions(accountDepositors[1].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(2);
      expect(redemption.target).to.equal(ethers.constants.Zero);
      redemption = await pool.redemptions(accountDepositors[2].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(2);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("0.75"), FixedPoint.from("0.01"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(Tick.encode("5"), FixedPoint.from("0.85"), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.75"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.10"),
        FixedPoint.from("0.01")
      );

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[1].address, Tick.encode("5"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(ethers.constants.Zero);
      redemption = await pool.redemptions(accountDepositors[2].address, Tick.encode("5"), 0);
      expect(redemption.index).to.equal(3);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(Tick.encode("5"), FixedPoint.from("0.10"), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(Tick.encode("5"), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.10"),
        FixedPoint.from("0.01")
      );

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[2].address, Tick.encode("5"), 0);
      expect(redemption.pending).to.be.closeTo(FixedPoint.from("0.05"), FixedPoint.from("0.01"));
      expect(redemption.index).to.equal(4);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("fails on no pending redemption", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Revert on withdraw */
      await expect(pool.connect(accountDepositors[0]).withdraw(Tick.encode("10"), 0)).to.be.revertedWithCustomError(
        pool,
        "InvalidRedemptionStatus"
      );
    });
  });

  describe("#rebalance", async function () {
    it("rebalances a full redemption into another tick", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Rebalances to 15 ETH tick */
      const rebalanceTx = await pool
        .connect(accountDepositors[0])
        .rebalance(Tick.encode("10"), Tick.encode("15"), 0, 0);

      /* Validate events */
      await expectEvent(rebalanceTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("1.0"),
        amount: FixedPoint.from("1.0"),
      });
      await expectEvent(rebalanceTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: Tick.encode("15"),
        amount: FixedPoint.from("1.0"),
        shares: FixedPoint.from("1.0"),
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("15"));
      expect(shares).to.equal(FixedPoint.from("1.0"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("15"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate tick state */
      let node = await pool.liquidityNode(Tick.encode("10"));
      expect(node.value).to.equal(ethers.constants.Zero);
      expect(node.available).to.equal(ethers.constants.Zero);
      expect(node.redemptions).to.equal(ethers.constants.Zero);

      node = await pool.liquidityNode(Tick.encode("15"));
      expect(node.value).to.equal(FixedPoint.from("1.0"));
      expect(node.available).to.equal(FixedPoint.from("1.0"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });

    it("rebalances a partial redemption into another tick", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("5"));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("5"));

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("10"));

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Rebalance */
      const rebalanceTx = await pool
        .connect(accountDepositors[0])
        .rebalance(Tick.encode("10"), Tick.encode("15"), 0, 0);

      /* Validate events */
      await expectEvent(rebalanceTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
      });
      await expectEvent(rebalanceTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: Tick.encode("15"),
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("15"));
      expect(shares).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

      redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("15"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);

      /* Validate tick state */
      let node = await pool.liquidityNode(Tick.encode("10"));
      expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.available).to.be.closeTo(ethers.constants.Zero, 1);
      expect(node.redemptions).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

      node = await pool.liquidityNode(Tick.encode("15"));
      expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.available).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.redemptions).to.equal(ethers.constants.Zero);
    });

    it("fails on no pending redemption", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);

      /* Revert on rebalance */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("15"), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidRedemptionStatus");
    });

    it("fails on invalid tick spacing", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem half of shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("10.1"), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientTickSpacing");
    });

    it("fails on invalid tick", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Zero limit */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), 0, 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds duration */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("15", 5, 0), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds rate */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("15", 0, 5), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds reserved field */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("15", 0, 0).add(2), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1000 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("1"), FixedPoint.from("1000"), 0);

      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("2"), FixedPoint.from("0.000000000000000001"), 0);

      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[2]).deposit(Tick.encode("2"), FixedPoint.from("1"), 0);

      /* Borrow 0.5 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      /* Redeem all shares */
      await pool.connect(accountDepositors[1]).redeem(Tick.encode("2"), FixedPoint.from("0.000000000000000001"));

      /* Revert since shares received is 0 */
      await expect(
        pool.connect(accountDepositors[1]).rebalance(Tick.encode("2"), Tick.encode("1"), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");

      /* Redeem all shares */
      await pool.connect(accountDepositors[2]).redeem(Tick.encode("2"), FixedPoint.from("1"));

      /* Revert since shares received less than min shares */
      await expect(
        pool.connect(accountDepositors[2]).rebalance(Tick.encode("2"), Tick.encode("1"), 0, "999995890427848045")
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });

    it("fails on written down redemption (insufficient shares)", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("10"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, ethers.constants.Zero);

      /* Rebalance */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(Tick.encode("10"), Tick.encode("15"), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_LIMITS = 20;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5");
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(Tick.encode(limit), FixedPoint.from("25"), 0);
      limit = limit.mul(TICK_LIMIT_SPACING_BASIS_POINTS.add(10000)).div(10000);
    }
  }

  async function amendLiquidity(ticks: ethers.BigNumber[]): Promise<ethers.BigNumber[]> {
    /* Replace four ticks with alternate duration and rates */
    ticks[3] = Tick.encode(Tick.decode(ticks[3]).limit, 2, 0);
    ticks[5] = Tick.encode(Tick.decode(ticks[5]).limit, 1, 1);
    ticks[7] = Tick.encode(Tick.decode(ticks[7]).limit, 1, 1);
    ticks[9] = Tick.encode(Tick.decode(ticks[9]).limit, 0, 2);
    await pool.connect(accountDepositors[0]).deposit(ticks[3], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[5], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[7], FixedPoint.from("25"), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[9], FixedPoint.from("25"), 0);
    return ticks;
  }

  async function sourceLiquidity(
    amount: ethers.BigNumber,
    multiplier?: number = 1,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<ethers.BigNumber[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    let taken = ethers.constants.Zero;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit.isZero()) continue;

      const take = minBN(minBN(limit.mul(multiplier).sub(taken), node.available), amount.sub(taken));
      if (take.isZero()) break;

      ticks.push(node.tick);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
  }

  async function setupImpairedTick(): Promise<void> {
    /* Create deposit at 10 ETH tick */
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);

    /* Create expired loan taking 5 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("5"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

    /* Liquidate collateral and process liquidation for 0.20 ETH */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, FixedPoint.from("0.20"));

    /* 10 ETH tick price is 0.20 ETH / 5.0 shares = 0.04 */
  }

  async function setupInsolventTick(): Promise<void> {
    /* Create deposits at 5 ETH, 10 ETH, and 15 ETH ticks */
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("5"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("5"), 0);
    await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("5"), 0);

    /* Create expired loan taking 15 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("15"));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, FixedPoint.from("5"));

    /* Ticks 10 ETH and 15 ETH are now insolvent */
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

    const ticks = await sourceLiquidity(principal);

    const repayment = await pool.quote(principal, duration, nft1.address, [tokenId], 1, ticks, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, ticks, "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createExpiredLoan(principal: ethers.BigNumber): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Wait for loan expiration */
    const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
    await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

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
  /* Lend API */
  /****************************************************************************/

  describe("#quote", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("correctly quotes repayment", async function () {
      expect(
        await pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          nft1.address,
          [123],
          1,
          await sourceLiquidity(FixedPoint.from("10")),
          "0x"
        )
      ).to.equal(FixedPoint.from("10.082191780786240000"));

      expect(
        await pool.quote(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          [123],
          1,
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        )
      ).to.equal(FixedPoint.from("25.205479451965600000"));
    });

    it("quotes repayment from various duration and rate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      expect(await pool.quote(FixedPoint.from("25"), 7 * 86400, nft1.address, [123], 1, ticks, "0x")).to.equal(
        FixedPoint.from("25.066700775725920000")
      );
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("100"),
          30 * 86400,
          nft1.address,
          [123],
          1,
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("10"),
          30 * 86400,
          tok1.address,
          [123],
          1,
          await sourceLiquidity(FixedPoint.from("10")),
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
    });

    it("fails with non-increasing tick", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      const temp = ticks[4];
      ticks[4] = ticks[5];
      ticks[5] = temp;

      await expect(
        pool.quote(FixedPoint.from("25"), 7 * 86400, nft1.address, [123], 1, ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duplicate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      ticks[4] = ticks[5];

      await expect(
        pool.quote(FixedPoint.from("35"), 7 * 86400, nft1.address, [123], 1, ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on low duration ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      await expect(
        pool.quote(FixedPoint.from("35"), 8 * 86400, nft1.address, [123], 1, ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });
  });

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates loan", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        1,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(2);
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
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment);

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates a loan from various duration and rate ticks", async function () {
      const ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      /* Borrow */
      await pool
        .connect(accountBorrower)
        .borrow(FixedPoint.from("25"), 7 * 86400, nft1.address, 123, FixedPoint.from("26"), ticks, "0x");
    });

    it("originates loan with delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        1,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [3, 20, accountBorrower.address])
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [3, 20, accountBorrower.address])
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
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
      expect(decodedLoanReceipt.version).to.equal(2);
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
      expect(totalUsed).to.equal(FixedPoint.from("25"));
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
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        1,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(2);
      expect(decodedLoanReceipt.principal).to.equal(FixedPoint.from("25"));
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
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));
      expect(repayment).to.equal(totalPending.add(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
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

    it("fails on unsupported collateral", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            tok1.address,
            123,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral", 0);
    });

    it("fails on exceeded max repayment", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            30 * 86400,
            nft1.address,
            123,
            FixedPoint.from("25.01"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "RepaymentTooHigh");
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("30"),
            30 * 86400,
            nft1.address,
            123,
            FixedPoint.from("31"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails with non-increasing tick", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      const temp = ticks[4];
      ticks[4] = ticks[5];
      ticks[5] = temp;

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 30 * 86400, nft1.address, 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duplicate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));
      ticks[4] = ticks[5];

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 30 * 86400, nft1.address, 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with low duration ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25")));

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(FixedPoint.from("25"), 8 * 86400, nft1.address, 123, FixedPoint.from("26"), ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duration equals 0", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25"),
            0,
            nft1.address,
            123,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25")),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedLoanDuration");
    });
  });

  describe("#repay", async function () {
    beforeEach("setup liquidity and borrow", async function () {
      await setupLiquidity();
    });

    it("repays loan at maturity", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
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
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }
    });

    it("repays with admin fee", async function () {
      pool.setAdminFeeRate(500);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
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
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          124,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          ethers.utils.solidityPack(["uint16", "uint16", "bytes20"], [3, 20, accountBorrower.address])
        );

      /* Validate events */
      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 124,
        value: true,
      });

      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: nft1.address,
        tokenId: 124,
        value: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 124)
      ).to.equal(false);
    });

    for (const [description, timeElapsed] of [
      ["one third", (30 * 86400) / 3],
      ["8 / 9ths", (8 * 30 * 86400) / 9],
      ["1 second", 1],
    ]) {
      it(`repays loan after ${description} of loan duration has elasped`, async function () {
        const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));
        const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

        /* Repay */
        await helpers.time.setNextBlockTimestamp(
          decodedLoanReceipt.maturity - decodedLoanReceipt.duration + timeElapsed
        );
        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        /* Calculate proration */
        const repayTxTimestamp = (await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp;
        const proration = FixedPoint.from(
          repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)
        ).div(decodedLoanReceipt.duration);

        /* Calculate prorated repayment amount */
        const repayment = decodedLoanReceipt.repayment
          .sub(decodedLoanReceipt.principal)
          .mul(proration)
          .div(ethers.constants.WeiPerEther)
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
          const node = await pool.liquidityNode(nodeReceipt.tick);
          expect(node.value).to.equal(FixedPoint.from("25").add(delta));
          expect(node.available).to.equal(FixedPoint.from("25").add(delta));
          expect(node.pending).to.equal(ethers.constants.Zero);
          totalDelta = totalDelta.add(delta);
        }
      });
    }

    it("can repay after expiration and prior to liquidation", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const repayment = decodedLoanReceipt.repayment;

      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment,
      });

      /* Validate ticks and liquidity statistics */
      let totalPending = ethers.constants.Zero;
      let totalUsed = ethers.constants.Zero;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25").add(nodeReceipt.pending).sub(nodeReceipt.used);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
        totalPending = totalPending.add(nodeReceipt.pending);
        totalUsed = totalUsed.add(nodeReceipt.used);
      }

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegationRegistry.checkDelegateForToken(accountBorrower.address, pool.address, nft1.address, 124)
      ).to.equal(false);
    });

    it("fails on invalid caller", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));
      await expect(pool.connect(accountLender).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid loan receipt", async function () {
      await expect(
        pool.connect(accountBorrower).repay(ethers.utils.randomBytes(141 + 48 * 3))
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on liquidated loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on same block repayment", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      const [loanReceipt, _] = await createActiveLoan(FixedPoint.from("25"));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Get token id */
      const tokenId =
        (await nft1.ownerOf(123)) === accountBorrower.address
          ? 123
          : (await nft1.ownerOf(124)) === accountBorrower.address
          ? 124
          : 125;

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          1,
          nft1.address,
          [tokenId],
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = nft1.address;
      nodeReceipt.borrower = accountBorrower.address;
      nodeReceipt.maturity = ethers.BigNumber.from("10000000001");
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      /* Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow() */
      await helpers.time.increaseTo(9999999999);

      /* Validate inability to do both borrow() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              FixedPoint.from("1"),
              1,
              nft1.address,
              [tokenId],
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("25")),
              "0x",
            ]),
            pool.interface.encodeFunctionData("repay", [encodedLoanReceipt]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#refinance", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance loan at maturity with admin fee and same principal", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal,
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(decodedLoanReceipt.repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
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
    });

    it("refinance loan at maturity with admin fee and smaller principal (1 ETH less)", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal.sub(FixedPoint.from("1")),
          15 * 86400,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(decodedLoanReceipt.repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(accountBorrower.address);
      expect(decodedNewLoanReceipt.maturity).to.equal(
        (await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp + 15 * 86400
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(nft1.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(15);

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
    });

    it("refinance loan at maturity with admin fee and bigger principal (1 ETH more)", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal.add(FixedPoint.from("1")),
          15 * 86400,
          FixedPoint.from("27"),
          await sourceLiquidity(FixedPoint.from("25"))
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(decodedLoanReceipt.repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
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
    });

    it("fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Validate inability to do both refinance() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25")),
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25"),
              1,
              FixedPoint.from("26"),
              await sourceLiquidity(FixedPoint.from("25")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Get token id */
      const tokenId =
        (await nft1.ownerOf(123)) === accountBorrower.address
          ? 123
          : (await nft1.ownerOf(124)) === accountBorrower.address
          ? 124
          : 125;

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1"),
          1,
          nft1.address,
          [tokenId],
          FixedPoint.from("2"),
          await sourceLiquidity(FixedPoint.from("1")),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = { ...decodedExistingLoanReceipt };
      nodeReceipt.collateralToken = nft1.address;
      nodeReceipt.borrower = accountBorrower.address;
      nodeReceipt.maturity = ethers.BigNumber.from("10000000001");
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      /* Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow() */
      await helpers.time.increaseTo(9999999999);

      /* Validate inability to do both borrow() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              FixedPoint.from("1"),
              1,
              nft1.address,
              [tokenId],
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("25")),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              FixedPoint.from("2"),
              await sourceLiquidity(FixedPoint.from("1")),
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid caller", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("1"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid loan receipt", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            ethers.utils.randomBytes(141 + 48 * 3),
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      /* setup liquidity and borrow */
      await setupLiquidity();
      pool.setAdminFeeRate(500);
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on liquidated loan", async function () {
      /* Set Admin Fee */
      pool.setAdminFeeRate(500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Refinance */
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25"),
            15 * 86400,
            FixedPoint.from("26"),
            await sourceLiquidity(FixedPoint.from("25"))
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });
  });

  describe("#liquidate", async function () {
    let loanReceipt: string;
    let loanReceiptHash: string;

    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("liquidates expired loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity.toNumber() + 1);

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
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "LoanNotExpired");
    });

    it("fails on repaid loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan after expiration", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25"));

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber() + 1);

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
      [loanReceipt, loanReceiptHash] = await createExpiredLoan(FixedPoint.from("25"));
    });

    it("processes liquidated loan for higher proceeds", async function () {
      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

      /* Liquidate collateral and process liquidation */
      const onCollateralLiquidatedTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, FixedPoint.from("30"));

      /* Compute borrower surplus and lender proceeds */
      const surplus = FixedPoint.from("30").sub(decodedLoanReceipt.repayment);
      const borrowerSurplus = surplus.mul(9500).div(10000);
      const lendersProceeds = FixedPoint.from("30").sub(borrowerSurplus);

      /* Validate events */
      await expectEvent(
        onCollateralLiquidatedTx,
        tok1,
        "Transfer",
        {
          from: collateralLiquidator.address,
          to: pool.address,
          value: FixedPoint.from("30"),
        },
        1
      );
      await expectEvent(
        onCollateralLiquidatedTx,
        tok1,
        "Transfer",
        {
          from: pool.address,
          to: decodedLoanReceipt.borrower,
          value: borrowerSurplus,
        },
        2
      );
      await expectEvent(onCollateralLiquidatedTx, pool, "CollateralLiquidated", {
        loanReceiptHash,
        proceeds: FixedPoint.from("30"),
        borrowerProceeds: borrowerSurplus,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);

      /* Compute total pending */
      const totalPending = decodedLoanReceipt.repayment.sub(decodedLoanReceipt.adminFee);

      /* Validate ticks */
      let i = 0;
      let proceedsRemaining = lendersProceeds;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const proceeds =
          i == decodedLoanReceipt.nodeReceipts.length - 1
            ? proceedsRemaining
            : lendersProceeds.mul(nodeReceipt.pending).div(totalPending);
        const value = FixedPoint.from("25").sub(nodeReceipt.used).add(proceeds);
        proceedsRemaining = proceedsRemaining.sub(proceeds);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
        i += 1;
      }
    });

    it("processes liquidated loan for lower proceeds", async function () {
      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt);

      /* Liquidate collateral and process liquidation */
      const proceeds = decodedLoanReceipt.nodeReceipts[0].pending.add(decodedLoanReceipt.nodeReceipts[1].pending);
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(pool.address, tok1.address, nft1.address, 123, "0x", loanReceipt, proceeds);

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(0, 2)) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25").sub(nodeReceipt.used).add(nodeReceipt.pending);
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(2, 0)) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        expect(node.value).to.equal(FixedPoint.from("25"));
        expect(node.available).to.equal(FixedPoint.from("25"));
        expect(node.pending).to.equal(ethers.constants.Zero);
      }
    });
  });

  /****************************************************************************/
  /* Admin Fee API */
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
      await expect(pool.setAdminFeeRate(10000)).to.be.revertedWithCustomError(pool, "InvalidParameters");
    });

    it("fails on invalid caller", async function () {
      const rate = 500;

      await expect(pool.connect(accounts[1]).setAdminFeeRate(rate)).to.be.revertedWithCustomError(
        pool,
        "InvalidCaller"
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
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        1,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
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
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(repayment.sub(FixedPoint.from("25")))
        .div(10000);

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending).to.equal(repayment.sub(adminFee));

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
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
      const repayment = await pool.quote(
        FixedPoint.from("25"),
        30 * 86400,
        nft1.address,
        [123],
        1,
        await sourceLiquidity(FixedPoint.from("25")),
        "0x"
      );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          nft1.address,
          123,
          FixedPoint.from("26"),
          await sourceLiquidity(FixedPoint.from("25")),
          "0x"
        );

      /* Decode loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber() - (2 * 30 * 86400) / 3);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate repayment proration */
      const repayTxTimestamp = (await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp;
      const proration = FixedPoint.from(
        repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)
      ).div(decodedLoanReceipt.duration);

      /* Calculate admin fee */
      const adminFee = ethers.BigNumber.from(await pool.adminFeeRate())
        .mul(repayment.sub(FixedPoint.from("25")))
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
      await createRepaidLoan(FixedPoint.from("25"));

      await expect(
        pool.connect(accounts[1]).withdrawAdminFees(accounts[1].address, FixedPoint.from("0.00001"))
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid address", async function () {
      /* Set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create repaid loan */
      await createRepaidLoan(FixedPoint.from("25"));

      await expect(
        pool.withdrawAdminFees(ethers.constants.AddressZero, FixedPoint.from("0.00001"))
      ).to.be.revertedWithCustomError(pool, "InvalidParameters");
    });

    it("fails on parameter out of bounds", async function () {
      /* set admin fee */
      await pool.setAdminFeeRate(500);

      /* Create repaid loan */
      await createRepaidLoan(FixedPoint.from("25"));

      await expect(pool.withdrawAdminFees(accounts[1].address, FixedPoint.from("10"))).to.be.revertedWithCustomError(
        pool,
        "InvalidParameters"
      );
    });
  });

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(pool.interface.getSighash("supportsInterface"))).to.equal(true);
    });

    it("returns false on unsupported interfaces", async function () {
      expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
      expect(await pool.supportsInterface("0x00000000")).to.equal(false);
      expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
