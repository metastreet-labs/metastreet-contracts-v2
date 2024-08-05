import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestProxy,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { BigIntMath } from "./helpers/Math";
import { Tick } from "./helpers/Tick";

describe("Pool Basic (6 Decimals)", function () {
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
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

  const SCALE = 10n ** 12n;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegateRegistryV1Factory = await ethers.getContractFactory("TestDelegateRegistryV1");
    const delegateRegistryV2Factory = await ethers.getContractFactory("TestDelegateRegistryV2");
    const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation");
    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 6, ethers.parseEther("10000"))) as TestERC20;
    await tok1.waitForDeployment();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.waitForDeployment();

    /* Deploy loan receipt library */
    loanReceiptLib = await testLoanReceiptFactory.deploy();
    await loanReceiptLib.waitForDeployment();

    /* Deploy external collateral liquidator implementation */
    const collateralLiquidatorImpl = await externalCollateralLiquidatorFactory.deploy();
    await collateralLiquidatorImpl.waitForDeployment();

    /* Deploy collateral liquidator */
    let proxy = await testProxyFactory.deploy(
      await collateralLiquidatorImpl.getAddress(),
      collateralLiquidatorImpl.interface.encodeFunctionData("initialize")
    );
    await proxy.waitForDeployment();
    collateralLiquidator = (await ethers.getContractAt(
      "ExternalCollateralLiquidator",
      await proxy.getAddress()
    )) as ExternalCollateralLiquidator;

    /* Deploy test delegation registry v1 */
    delegateRegistryV1 = await delegateRegistryV1Factory.deploy();
    await delegateRegistryV1.waitForDeployment();

    /* Deploy test delegation registry v2 */
    delegateRegistryV2 = await delegateRegistryV2Factory.deploy();
    await delegateRegistryV2.waitForDeployment();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.waitForDeployment();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      await collateralLiquidator.getAddress(),
      await delegateRegistryV1.getAddress(),
      await delegateRegistryV2.getAddress(),
      await erc20DepositTokenImpl.getAddress(),
      []
    )) as Pool;
    await poolImpl.waitForDeployment();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      await poolImpl.getAddress(),
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address[]", "address", "address", "uint64[]", "uint64[]"],
          [
            [await nft1.getAddress()],
            await tok1.getAddress(),
            ethers.ZeroAddress,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );
    await proxy.waitForDeployment();
    pool = (await ethers.getContractAt("Pool", await proxy.getAddress())) as Pool;

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Grant liquidator role to liquidator account */
    await collateralLiquidator.grantRole(
      await collateralLiquidator.COLLATERAL_LIQUIDATOR_ROLE(),
      await accountLiquidator.getAddress()
    );

    /* Transfer TOK1 to depositors and approve Pool */
    for (const depositor of accountDepositors) {
      await tok1.transfer(await depositor.getAddress(), ethers.parseEther("1000"));
      await tok1.connect(depositor).approve(await pool.getAddress(), ethers.MaxUint256);
    }
    /* Transfer TOK1 to liquidator and approve collateral liquidator */
    await tok1.transfer(await accountLiquidator.getAddress(), ethers.parseEther("100"));
    await tok1.connect(accountLiquidator).approve(await collateralLiquidator.getAddress(), ethers.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mint(await accountBorrower.getAddress(), 123);
    await nft1.mint(await accountBorrower.getAddress(), 124);
    await nft1.mint(await accountBorrower.getAddress(), 125);

    /* Mint token to borrower */
    await tok1.transfer(await accountBorrower.getAddress(), ethers.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(await accountLender.getAddress(), ethers.parseEther("1000"));

    /* Approve pool to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(await pool.getAddress(), true);

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(await pool.getAddress(), ethers.MaxUint256);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Tick Helpers */
  /****************************************************************************/

  function scaleTickEncode(limit: bigint, decimals: number) {
    return Tick.encode(limit, undefined, undefined, decimals);
  }

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("getters", async function () {
    it("returns expected currency token", async function () {
      expect(await pool.currencyToken()).to.equal(await tok1.getAddress());
    });

    it("returns expected admin fee rate", async function () {
      expect(await pool.adminFeeRate()).to.equal(0);
    });

    it("returns expected collateral wrappers", async function () {
      const collateralWrappers = await pool.collateralWrappers();
      expect(collateralWrappers[0]).to.equal(ethers.ZeroAddress);
      expect(collateralWrappers[1]).to.equal(ethers.ZeroAddress);
      expect(collateralWrappers[2]).to.equal(ethers.ZeroAddress);
    });

    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(await collateralLiquidator.getAddress());
    });

    it("returns expected delegation registry v1", async function () {
      expect(await pool.delegationRegistry()).to.equal(await delegateRegistryV1.getAddress());
    });

    it("returns expected delegation registry v2", async function () {
      expect(await pool.delegationRegistryV2()).to.equal(await delegateRegistryV2.getAddress());
    });

    describe("#depositSharePrice", async function () {
      it("returns correct share price", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        expect(await pool.depositSharePrice(scaleTickEncode("1", 6))).to.equal(FixedPoint.from("1", 6));
      });

      it("returns correct share price after borrow", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedDepositPrice = await pool.depositSharePrice(scaleTickEncode("1", 6));

        /* Deposit */
        const shares = await pool
          .connect(accountDepositors[1])
          .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Get actual deposit price */
        const actualDepositPrice = (FixedPoint.from("1", 6) * FixedPoint.from("1", 18)) / shares;

        expect(expectedDepositPrice).to.be.closeTo(actualDepositPrice, "1");
      });

      it("returns correct share price after borrow + repayment", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        const [loanReceipt] = await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt);

        /* Cache expected deposit price */
        const expectedDepositPrice = await pool.depositSharePrice(scaleTickEncode("1", 6));

        /* Deposit */
        const shares = await pool
          .connect(accountDepositors[1])
          .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Get actual deposit price */
        const actualDepositPrice = (FixedPoint.from("1", 6) * FixedPoint.from("1", 18)) / shares;

        expect(expectedDepositPrice).to.closeTo(actualDepositPrice, "1");
      });

      it("returns correct share price after multiple deposits + borrow", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Next deposit */
        pool.connect(accountDepositors[2]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedDepositPrice = await pool.depositSharePrice(scaleTickEncode("1", 6));

        /* Deposit */
        const shares = await pool
          .connect(accountDepositors[1])
          .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Get actual deposit price */
        const actualDepositPrice = (FixedPoint.from("1", 6) * FixedPoint.from("1", 18)) / shares;

        expect(expectedDepositPrice).to.closeTo(actualDepositPrice, "1");
      });

      it("returns correct share price after multiple deposits, multiple borrows and multiple repayments", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Next deposit */
        pool.connect(accountDepositors[2]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        const [loanReceipt1] = await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt1);

        /* Next borrow */
        const [loanReceipt2] = await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt2);

        /* Cache expected deposit price */
        const expectedDepositPrice = await pool.depositSharePrice(scaleTickEncode("1", 6));

        /* Deposit */
        const shares = await pool
          .connect(accountDepositors[1])
          .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

        /* Get actual deposit price */
        const actualDepositPrice = (FixedPoint.from("1", 6) * FixedPoint.from("1", 18)) / shares;

        expect(expectedDepositPrice).to.closeTo(actualDepositPrice, "1");
      });
    });

    describe("#redemptionSharePrice", async function () {
      it("returns correct redemption share price", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        expect(await pool.redemptionSharePrice(scaleTickEncode("1", 6))).to.equal(FixedPoint.from("1", 6));
      });

      it("returns correct redemption share price after borrow", async function () {
        const sharesMinted = await pool
          .connect(accountDepositors[0])
          .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedRedemptionPrice = await pool.redemptionSharePrice(scaleTickEncode("1", 6));

        /* Deposit */
        const redemptionTx = await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted);
        const redemptionShares = (await extractEvent(redemptionTx, pool, "Redeemed")).args.shares;

        /* Get actual redemption price */
        const actualRedemptionPrice = (FixedPoint.from("1", 6) * FixedPoint.from("1")) / redemptionShares;

        expect(expectedRedemptionPrice).to.equal(actualRedemptionPrice);
      });

      it("returns correct redemption share price after borrow + repay", async function () {
        await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
        const [loanReceipt] = await createActiveLoan(FixedPoint.from("1", 6));

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt);

        /* Cache expected deposit price */
        const expectedRedemptionPrice = await pool.redemptionSharePrice(scaleTickEncode("1", 6));

        /* Get actual redemption price */
        const node = await pool.liquidityNode(scaleTickEncode("1", 6));
        const actualRedemptionPrice = (node.value * FixedPoint.from("1")) / node.shares / FixedPoint.from("1", 12);

        expect(expectedRedemptionPrice).to.closeTo(actualRedemptionPrice, "1");
      });
    });
  });

  /****************************************************************************/
  /* Deposit API */
  /****************************************************************************/

  describe("#deposit", async function () {
    it("successfully deposits", async function () {
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      const depositTx = await pool
        .connect(accountDepositors[0])
        .deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Validate events */
      await expectEvent(depositTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        amount: FixedPoint.from("1", 6),
        shares: sharesMinted,
      });

      await expectEvent(depositTx, tok1, "Transfer", {
        from: accountDepositors[0].address,
        to: await pool.getAddress(),
        value: FixedPoint.from("1", 6),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted);
      expect(redemptionId).to.equal(0n);

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(
        ethers.parseEther("1000") - FixedPoint.from("1", 6)
      );
    });

    it("successfully deposits additional", async function () {
      /* Deposit 1 */
      const sharesMinted1 = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Deposit 2 */
      const sharesMinted2 = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("2", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("2", 6), 0);

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted1 + sharesMinted2);
      expect(redemptionId).to.equal(0n);

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(
        ethers.parseEther("1000") - FixedPoint.from("3", 6)
      );
    });

    it("successfully deposits at new tick after garbage collecting old tick", async function () {
      /* Deposit 1 ETH */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Only two nodes (including head) */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);

      /* Redeem 1 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted);

      /* Only head node now */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(1);

      /* Deposit 1 ETH at new tick close to garbage collected one */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("1.1"), FixedPoint.from("1", 6), 0);

      /* Two nodes again */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);
    });

    it("fails on invalid tick spacing", async function () {
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await expect(
        pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1.09", 6), FixedPoint.from("2", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientTickSpacing");
    });

    it("fails on impaired tick", async function () {
      /* Setup impaired tick at 10 ETH */
      await setupImpairedTick();

      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InactiveLiquidity");
    });

    it("fails on insolvent tick", async function () {
      /* Setup insolvent tick at 10,000000 wei */
      await setupInsolventTick();

      /* Attempt to deposit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(scaleTickEncode("10", 6), FixedPoint.from("10", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InactiveLiquidity");
    });

    it("fails on invalid tick", async function () {
      /* Zero tick */
      await expect(
        pool.connect(accountDepositors[0]).deposit(0, FixedPoint.from("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds duration */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("1", 5, 0), FixedPoint.from("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds rate */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("1", 0, 5), FixedPoint.from("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Zero limit */
      await expect(
        pool.connect(accountDepositors[0]).deposit(Tick.encode("0", 0, 0), FixedPoint.from("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on transfer failure", async function () {
      await expect(
        pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("2000"), 0)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1000000 wei */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Borrow 0.5 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("2", 6),
          await sourceLiquidity(FixedPoint.from("1", 6)),
          "0x"
        );

      /* Revert since shares received less than min shares */
      await expect(
        pool
          .connect(accountDepositors[1])
          .deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), FixedPoint.from("1"))
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });
  });

  describe("#redeem", async function () {
    it("successfully redeems entire deposit from available cash", async function () {
      /* Deposit 1 ETH */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 1 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted);

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: sharesMinted,
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(0n);
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(sharesMinted);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("successfully redeems partial deposit from available cash", async function () {
      /* Deposit 1 ETH */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 0.5 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("0.5"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: FixedPoint.from("0.5"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("successfully schedules redemption", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("10", 6), 0);

      /* Create loan */
      await createActiveLoan(FixedPoint.from("15", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Validate tick state */
      const node = await pool.liquidityNode(scaleTickEncode("1", 6));
      expect(node.value).to.equal(FixedPoint.from("10"));
      expect(node.available).to.equal(0n);
      expect(node.redemptions).to.equal(FixedPoint.from("5"));
    });

    it("successfully schedules multiple redemptions", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("10", 6), 0);

      /* Create loan */
      await createActiveLoan(FixedPoint.from("15", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));
      /* Redeem remaining shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted - FixedPoint.from("5"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(FixedPoint.from("0"));
      expect(redemptionId).to.equal(BigInt("2"));

      /* Validate redemption state */
      const redemption1 = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption1.pending).to.equal(FixedPoint.from("5"));
      expect(redemption1.index).to.equal(0n);
      expect(redemption1.target).to.equal(0n);

      /* Validate redemption state */
      const redemption2 = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 1);
      expect(redemption2.pending).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemption2.index).to.equal(0n);
      expect(redemption2.target).to.equal(FixedPoint.from("5"));

      /* Validate tick state */
      const node = await pool.liquidityNode(scaleTickEncode("1", 6));
      expect(node.value).to.equal(FixedPoint.from("10"));
      expect(node.available).to.equal(0n);
      expect(node.redemptions).to.equals(sharesMinted);
    });

    it("redeemed node with redemption dust is garbage collected", async function () {
      /* Deposits at 1 ETH and 2 ETH ticks */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("2", 6), FixedPoint.from("2", 6), 0);

      /* Get shares for 2 ETH tick */
      let shares = (await pool.deposits(accountDepositors[0].address, scaleTickEncode("2", 6))).shares;

      /* Borrow using both ticks */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1.999999999999999999", 6),
          3 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("2.1", 6),
          await sourceLiquidity(FixedPoint.from("1.999999999999999999", 6)),
          "0x"
        );

      /* Get decoded loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Redeem all shares from 2 ETH tick */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("2", 6), shares);

      /* Fast forward timestamp to loan maturity */
      await helpers.time.increaseTo(decodedLoanReceipt.maturity);

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate 2 ETH node has dust */
      let node = await pool.liquidityNode(scaleTickEncode("2", 6));
      expect(node.available).to.equal("1001097");
      expect(node.shares).to.equal(FixedPoint.from("2") - shares);
      expect(node.value).to.equal("1001097");

      /* Validate 2 ETH node unlinked */
      let nodes = await pool.liquidityNodes(0, MaxUint128);
      expect(nodes[nodes.length - 1].tick).to.equal(scaleTickEncode("1", 6));

      /* Validate shares redeemed */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("2", 6), 0);
      const redeemedShares = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares;
      expect(redeemedShares).to.equal(shares);
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 1.25 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("1.25"))
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });

    it("fails on zero shares", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 1.25 shares */
      await expect(
        pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), 0n)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });
  });

  describe("#redemptionAvailable", async function () {
    it("returns redemption available from cash", async function () {
      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Deposit 1 ETH */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("0.5"));

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(amount).to.equal(FixedPoint.from("0.5", 6));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("returns full redemption available from repaid loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create active loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(BigIntMath.abs(amount - FixedPoint.from("5", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("returns partial redemption available from repaid loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("3", 6));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("11", 6));

      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("8"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Partial redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(BigIntMath.abs(shares - FixedPoint.from("3"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount - FixedPoint.from("3", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Repay loan 2 */
      await pool.connect(accountBorrower).repay(loanReceipt2);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(FixedPoint.from("8"));
      expect(BigIntMath.abs(amount - FixedPoint.from("8", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("8"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("8"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("returns written down redemption available from liquidated loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt,
          0n
        );

      /* Redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(amount).to.equal(0n);

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("returns partial redemption available from subsequent deposit", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("1", 6), FixedPoint.from("3", 6), 0);

      /* Full redemption should be available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(BigIntMath.abs(shares - FixedPoint.from("3"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount - FixedPoint.from("3", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5"));
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("returns zero redemption available from dust cash", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("1", 6));

      /* Redeem 10 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted);

      /* No redemption available */
      let [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Validate deposit state */
      let redemptionId;
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(0n);
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(sharesMinted);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Deposit from depositor #2, causing a partial redemption of depositor #1 */
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("1", 6), FixedPoint.from("0.01", 6), 0);

      /* Validate partial redemption available for depositor #1 */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.be.gt(0n);
      expect(amount).to.be.gt(0n);

      /* Validate tick has rounding dust in cash available */
      const node = await pool.liquidityNode(scaleTickEncode("1", 6));
      expect(node.available).to.equal(1);

      /* Redeem from depositor #2 */
      await pool.connect(accountDepositors[1]).redeem(scaleTickEncode("1", 6), FixedPoint.from("0.005"));

      /* Validate zero redemption available for depositor #2, despite the dust cash available */
      [shares, amount] = await pool.redemptionAvailable(accountDepositors[1].address, scaleTickEncode("1", 6), 0);
      expect(shares).to.equal(0n);
      expect(amount).to.equal(0n);

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[1].address, scaleTickEncode("1", 6));
      expect(shares).to.be.closeTo(FixedPoint.from("0.005"), FixedPoint.from("0.001"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[1].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.005"));
      expect(redemption.index).to.equal(BigInt("1"));
      expect(redemption.target).to.be.closeTo(sharesMinted, FixedPoint.from("0.01"));
    });

    it("correctly returns sharesAhead", async function () {
      /* Depositor 1 deposits 5 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("5", 6), 0);
      let [shares1, redemptionId1] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));

      /* Depositor 2 deposits 5 ETH */
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("1", 6), FixedPoint.from("5", 6), 0);
      let [shares2, redemptionId2] = await pool.deposits(accountDepositors[1].address, scaleTickEncode("1", 6));

      /* Borrow 8 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("8", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("9", 6),
          [scaleTickEncode("1", 6)],
          "0x"
        );

      /* Depositor 1 redeems all shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), shares1);

      /* Depositor 2 redeems all shares */
      await pool.connect(accountDepositors[1]).redeem(scaleTickEncode("1", 6), shares2);

      /* Get redemption available */
      let redemptionAvailable1 = await pool.redemptionAvailable(
        accountDepositors[0].address,
        scaleTickEncode("1", 6),
        0
      );
      let redemptionAvailable2 = await pool.redemptionAvailable(
        accountDepositors[1].address,
        scaleTickEncode("1", 6),
        0
      );

      /* Validate sharesAhead */
      expect(redemptionAvailable1[2]).to.equal(0);
      expect(redemptionAvailable2[2]).to.equal(shares1 - FixedPoint.from("2"));

      /* Depositor 2 deposits another 4 ETH */
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("1", 6), FixedPoint.from("4", 6), 0);

      /* Get redemption available */
      redemptionAvailable1 = await pool.redemptionAvailable(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      redemptionAvailable2 = await pool.redemptionAvailable(accountDepositors[1].address, scaleTickEncode("1", 6), 0);

      /* Validate sharesAhead */
      expect(redemptionAvailable1[2]).to.equal(0);
      expect(redemptionAvailable2[2]).to.equal(0);
    });
  });

  describe("#withdraw", async function () {
    it("withdraws fully available redemption from cash", async function () {
      /* Deposit 1 ETH */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem 0.5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("0.5"));

      /* Simulated withdrawal should return 0.5 ETH and 500000000000000000 shares */
      const withdrawal = await pool.connect(accountDepositors[0]).withdraw.staticCall(scaleTickEncode("1", 6), 0);
      expect(withdrawal[0]).to.equal(FixedPoint.from("0.5"));
      expect(withdrawal[1]).to.equal(FixedPoint.from("0.5", 6));

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: FixedPoint.from("0.5"),
        amount: FixedPoint.from("0.5", 6),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
        value: FixedPoint.from("0.5", 6),
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(
        ethers.parseEther("1000") - FixedPoint.from("0.5", 6)
      );
    });

    it("withdraws fully available redemption from repaid loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(amount - FixedPoint.from("5", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("withdraws multiple fully available redemptions from repaid loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));
      /* Redeem remaining shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted - FixedPoint.from("5"));

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw first redemption */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(amount1 - FixedPoint.from("5", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Withdraw second redemption */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 1);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 1,
        shares: sharesMinted - FixedPoint.from("5"),
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate amount approximately */
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(amount2 - FixedPoint.from("5", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(FixedPoint.from("0"));
      expect(redemptionId).to.equal(BigInt("2"));

      /* Validate redemption state */
      const redemption1 = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption1.pending).to.equal(0n);
      expect(redemption1.index).to.equal(0n);
      expect(redemption1.target).to.equal(0n);

      /* Validate redemption state */
      const redemption2 = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 1);
      expect(redemption2.pending).to.equal(0n);
      expect(redemption2.index).to.equal(0n);
      expect(redemption2.target).to.equal(0n);
    });

    it("withdraws partially available redemption from repaid loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("3", 6));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("11", 6));

      /* Redeem 8 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("8"));

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(shares1 - FixedPoint.from("3"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount1 - FixedPoint.from("3", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("8"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("8") - shares1);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(0n);

      /* Repay loan 2 */
      await pool.connect(accountBorrower).repay(loanReceipt2);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(shares2 - FixedPoint.from("5"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount2 - FixedPoint.from("5", 6))).to.be.lt(FixedPoint.from("0.1", 6));

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("8"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("withdraws fully written down redemption from liquidated loan", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt,
          0n
        );

      /* Withdraw */
      const withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: FixedPoint.from("5"),
        amount: 0n,
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("withdraws partially available redemption from subsequent deposit", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("14", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* Subsequent deposit */
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("1", 6), FixedPoint.from("3", 6), 0);

      /* Withdraw */
      const withdrawTx1 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx1, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx1, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.shares;
      const amount1 = (await extractEvent(withdrawTx1, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(shares1 - FixedPoint.from("3"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount1 - FixedPoint.from("3", 6))).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("5") - shares1);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(0n);

      /* Repay loan */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Withdraw again */
      const withdrawTx2 = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0);

      /* Validate events */
      await expectEvent(withdrawTx2, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
      });
      await expectEvent(withdrawTx2, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accountDepositors[0].address,
      });

      /* Validate shares and amount approximately */
      const shares2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.shares;
      const amount2 = (await extractEvent(withdrawTx2, pool, "Withdrawn")).args.amount;
      expect(BigIntMath.abs(shares2 - FixedPoint.from("2"))).to.be.lt(FixedPoint.from("0.1"));
      expect(BigIntMath.abs(amount2 - FixedPoint.from("2", 6))).to.be.lt(FixedPoint.from("0.1"));

      /* Validate deposit state */
      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(sharesMinted - FixedPoint.from("5"));
      expect(redemptionId).to.equal(BigInt("1"));

      /* Validate redemption state */
      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);
    });

    it("advances redemption queue on withdraw", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("5", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[1]).deposit(scaleTickEncode("5", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[2]).deposit(scaleTickEncode("5", 6), FixedPoint.from("1", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("3", 6));

      /* Redeem shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("5", 6), FixedPoint.from("0.5"));
      await pool.connect(accountDepositors[1]).redeem(scaleTickEncode("5", 6), FixedPoint.from("1"));
      await pool.connect(accountDepositors[2]).redeem(scaleTickEncode("5", 6), FixedPoint.from("0.25"));

      /* Validate redemption queue */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("0", 6));
      redemption = await pool.redemptions(accountDepositors[1].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("0.5"));
      redemption = await pool.redemptions(accountDepositors[2].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(FixedPoint.from("1.5"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(scaleTickEncode("5", 6), FixedPoint.from("0.25", 6), 0);

      /* Withdraw shares */
      let withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.equal(0n);
      redemption = await pool.redemptions(accountDepositors[1].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("0.25"), FixedPoint.from("0.01"));
      redemption = await pool.redemptions(accountDepositors[2].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(1);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("1.25"), FixedPoint.from("0.01"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(scaleTickEncode("5", 6), FixedPoint.from("0.5", 6), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.25"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.equal(FixedPoint.from("0"));

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("5", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(0n);
      redemption = await pool.redemptions(accountDepositors[1].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(2);
      expect(redemption.target).to.equal(0n);
      redemption = await pool.redemptions(accountDepositors[2].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(2);
      expect(redemption.target).to.be.closeTo(FixedPoint.from("0.75"), FixedPoint.from("0.01"));

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(scaleTickEncode("5", 6), FixedPoint.from("0.85", 6), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[1]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.75"),
        FixedPoint.from("0.01")
      );
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.10"),
        FixedPoint.from("0.01")
      );

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[1].address, scaleTickEncode("5", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0);
      expect(redemption.target).to.equal(0n);
      redemption = await pool.redemptions(accountDepositors[2].address, scaleTickEncode("5", 6), 0);
      expect(redemption.index).to.equal(3);
      expect(redemption.target).to.equal(0n);

      /* Deposit cash */
      await pool.connect(accountBorrower).deposit(scaleTickEncode("5", 6), FixedPoint.from("0.10", 6), 0);

      /* Withdraw shares */
      withdrawTx = await pool.connect(accountDepositors[2]).withdraw(scaleTickEncode("5", 6), 0);
      expect((await extractEvent(withdrawTx, pool, "Withdrawn")).args.shares).to.be.closeTo(
        FixedPoint.from("0.10"),
        FixedPoint.from("0.01")
      );

      /* Validate redemption queue */
      redemption = await pool.redemptions(accountDepositors[2].address, scaleTickEncode("5", 6), 0);
      expect(redemption.pending).to.be.closeTo(FixedPoint.from("0.05"), FixedPoint.from("0.01"));
      expect(redemption.index).to.equal(4);
      expect(redemption.target).to.equal(0n);
    });

    it("fails on no pending redemption", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Revert on withdraw */
      await expect(
        pool.connect(accountDepositors[0]).withdraw(scaleTickEncode("1", 6), 0)
      ).to.be.revertedWithCustomError(pool, "InvalidRedemptionStatus");
    });
  });

  describe("#rebalance", async function () {
    it("rebalances a full redemption into another tick", async function () {
      /* Deposit 1 ETH */
      const sharesMinted1 = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);
      const amount1 =
        ((await pool.liquidityNode(scaleTickEncode("1", 6))).value * sharesMinted1) / FixedPoint.from("1");

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted1);

      /* Rebalances to 15 ETH tick */
      const rebalanceTx = await pool
        .connect(accountDepositors[0])
        .rebalance(scaleTickEncode("1", 6), scaleTickEncode("15", 6), 0, 0);

      const sharesMinted2 = (await pool.deposits(accountDepositors[0].address, scaleTickEncode("15", 6))).shares;

      /* Validate events */
      await expectEvent(rebalanceTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
        shares: sharesMinted1,
        amount: amount1 / FixedPoint.from("1", 12),
      });
      await expectEvent(rebalanceTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("15", 6),
        amount: amount1 / FixedPoint.from("1", 12),
        shares: sharesMinted2,
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(0n);
      expect(redemptionId).to.equal(BigInt("1"));

      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("15", 6));
      expect(shares).to.equal(sharesMinted2);
      expect(redemptionId).to.equal(0n);

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("15", 6), 0);
      expect(redemption.pending).to.equal(0n);
      expect(redemption.index).to.equal(0n);
      expect(redemption.target).to.equal(0n);

      /* Validate tick state */
      let node = await pool.liquidityNode(scaleTickEncode("1", 6));
      expect(node.value).to.equal(FixedPoint.from("1") - amount1);
      expect(node.available).to.equal(FixedPoint.from("1") - amount1);
      expect(node.redemptions).to.equal(0n);

      node = await pool.liquidityNode(scaleTickEncode("15", 6));
      expect(node.value).to.equal(amount1);
      expect(node.available).to.equal(amount1);
      expect(node.redemptions).to.equal(0n);
    });

    it("rebalances a partial redemption into another tick", async function () {
      /* Deposit */
      const sharesMinted = await pool
        .connect(accountDepositors[0])
        .deposit.staticCall(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("5", 6));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("5", 6));

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), sharesMinted);

      /* Repay loan 1 */
      await pool.connect(accountBorrower).repay(loanReceipt1);

      /* Rebalance */
      const rebalanceTx = await pool
        .connect(accountDepositors[0])
        .rebalance(scaleTickEncode("1", 6), scaleTickEncode("15", 6), 0, 0);

      /* Validate events */
      await expectEvent(rebalanceTx, pool, "Withdrawn", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("1", 6),
        redemptionId: 0,
      });
      await expectEvent(rebalanceTx, pool, "Deposited", {
        account: accountDepositors[0].address,
        tick: scaleTickEncode("15", 6),
      });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("1", 6));
      expect(shares).to.equal(0n);
      expect(redemptionId).to.equal(BigInt("1"));

      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, scaleTickEncode("15", 6));
      expect(shares).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(redemptionId).to.equal(0n);

      /* Validate redemption state */
      let redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("1", 6), 0);
      expect(redemption.pending).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

      redemption = await pool.redemptions(accountDepositors[0].address, scaleTickEncode("15", 6), 0);
      expect(redemption.pending).to.equal(0n);

      /* Validate tick state */
      let node = await pool.liquidityNode(scaleTickEncode("1", 6));
      expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.available).to.be.closeTo(0n, 1);
      expect(node.redemptions).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

      node = await pool.liquidityNode(scaleTickEncode("15", 6));
      expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.available).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
      expect(node.redemptions).to.equal(0n);
    });

    it("fails on no pending redemption", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);

      /* Revert on rebalance */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), scaleTickEncode("15", 6), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidRedemptionStatus");
    });

    it("fails on invalid tick spacing", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem half of shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("0.5"));

      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), scaleTickEncode("1.09", 6), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientTickSpacing");
    });

    it("fails on invalid tick", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1", 6), 0);

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("1", 6));

      /* Zero limit */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), 0, 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds duration */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), Tick.encode("15", 5, 0), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");

      /* Out of bounds rate */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), Tick.encode("15", 0, 5), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on insufficient shares", async function () {
      /* Deposit 1000 ETH */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("1000", 6), 0);

      /* Deposit 1 ETH */
      await pool
        .connect(accountDepositors[1])
        .deposit(scaleTickEncode("2", 6), FixedPoint.from("0.000000000000000001"), 0);

      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[2]).deposit(scaleTickEncode("2", 6), FixedPoint.from("1", 6), 0);

      /* Borrow 0.5 ETH */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("2", 6),
          await sourceLiquidity(FixedPoint.from("1", 6)),
          "0x"
        );

      /* Redeem all shares */
      await pool.connect(accountDepositors[1]).redeem(scaleTickEncode("2", 6), FixedPoint.from("0.000000000000000001"));

      /* Revert since shares received is 0 */
      await expect(
        pool.connect(accountDepositors[1]).rebalance(scaleTickEncode("2", 6), scaleTickEncode("1", 6), 0, 0)
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");

      /* Redeem all shares */
      await pool.connect(accountDepositors[2]).redeem(scaleTickEncode("2", 6), FixedPoint.from("1", 6));

      /* Revert since shares received less than min shares */
      await expect(
        pool
          .connect(accountDepositors[2])
          .rebalance(scaleTickEncode("2", 6), scaleTickEncode("1", 6), 0, scaleTickEncode("1", 6))
      ).to.be.revertedWithCustomError(pool, "InsufficientShares");
    });

    it("fails on written down redemption (insufficient shares)", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("10", 6), 0);

      /* Create loan */
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("10", 6));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(scaleTickEncode("1", 6), FixedPoint.from("5"));

      /* Wait for loan expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral and process liquidation */
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt,
          0n
        );

      /* Rebalance */
      await expect(
        pool.connect(accountDepositors[0]).rebalance(scaleTickEncode("1", 6), scaleTickEncode("15", 6), 0, 0)
      ).to.be.revertedWith;
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function setupLiquidity(): Promise<void> {
    const NUM_LIMITS = 35;
    const TICK_LIMIT_SPACING_BASIS_POINTS = await pool.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS();

    let limit = FixedPoint.from("6.5", 6);
    for (let i = 0; i < NUM_LIMITS; i++) {
      await pool.connect(accountDepositors[0]).deposit(scaleTickEncode(limit, 6), FixedPoint.from("25", 6), 0);
      limit = (limit * (TICK_LIMIT_SPACING_BASIS_POINTS + 10001n)) / 10000n;
    }
  }

  async function amendLiquidity(ticks: bigint[]): Promise<bigint[]> {
    /* Replace four ticks with alternate duration and rates */
    ticks[3] = Tick.encode(Tick.decode(ticks[3]).limit, 2, 0);
    ticks[5] = Tick.encode(Tick.decode(ticks[5]).limit, 1, 1);
    ticks[7] = Tick.encode(Tick.decode(ticks[7]).limit, 1, 1);
    ticks[9] = Tick.encode(Tick.decode(ticks[9]).limit, 0, 2);
    await pool.connect(accountDepositors[0]).deposit(ticks[3], FixedPoint.from("25", 6), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[5], FixedPoint.from("25", 6), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[7], FixedPoint.from("25", 6), 0);
    await pool.connect(accountDepositors[0]).deposit(ticks[9], FixedPoint.from("25", 6), 0);
    return ticks;
  }

  async function sourceLiquidity(
    amount: bigint,
    multiplier?: bigint = 1n,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<bigint[]> {
    const normalizedAmount = amount * SCALE;
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    let taken = 0n;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit === 0n) continue;

      const take = minBN(minBN(limit * multiplier - taken, node.available), normalizedAmount - taken);

      if (take === 0n) break;

      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== normalizedAmount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
  }

  async function setupImpairedTick(): Promise<void> {
    /* Create deposit at 10 ETH tick */
    await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("1", 6), FixedPoint.from("5", 6), 0);

    /* Create expired loan taking 5 ETH */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("5", 6));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt
      );

    /* Liquidate collateral and process liquidation for 0.20 ETH */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt,
        FixedPoint.from("0.20", 6)
      );

    /* 10 ETH tick price is 0.20 ETH / 5.0 shares = 0.04 */
  }

  async function setupInsolventTick(): Promise<void> {
    /* Create deposits */
    await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("5", 6), FixedPoint.from("5", 6), 0);
    await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("10", 6), FixedPoint.from("5", 6), 0);
    await pool.connect(accountDepositors[0]).deposit(scaleTickEncode("15", 6), FixedPoint.from("5", 6), 0);

    /* Create expired loan */
    const [loanReceipt] = await createExpiredLoan(FixedPoint.from("15", 6));

    /* Process expiration */
    await pool.liquidate(loanReceipt);

    /* Withdraw collateral */
    await collateralLiquidator
      .connect(accountLiquidator)
      .withdrawCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt
      );

    /* Liquidate collateral and process liquidation */
    await collateralLiquidator
      .connect(accountLiquidator)
      .liquidateCollateral(
        await pool.getAddress(),
        await tok1.getAddress(),
        await nft1.getAddress(),
        123,
        "0x",
        loanReceipt,
        FixedPoint.from("5", 6)
      );

    /* Ticks 10 ETH and 15 ETH are now insolvent */
  }

  async function createActiveLoan(principal: bigint, duration?: number = 30 * 86400): Promise<[string, string]> {
    const tokenId =
      (await nft1.ownerOf(123)) === (await accountBorrower.getAddress())
        ? 123
        : (await nft1.ownerOf(124)) === (await accountBorrower.getAddress())
          ? 124
          : 125;
    const ticks = await sourceLiquidity(principal);
    const repayment = await pool.quote(principal, duration, await nft1.getAddress(), tokenId, ticks, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, await nft1.getAddress(), tokenId, repayment, ticks, "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  async function createExpiredLoan(principal: bigint): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Wait for loan expiration */
    const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
    await helpers.time.increaseTo(decodedLoanReceipt.maturity);

    return [loanReceipt, loanReceiptHash];
  }

  async function createRepaidLoan(principal: bigint): Promise<[string, string]> {
    /* Create active loan */
    const [loanReceipt, loanReceiptHash] = await createActiveLoan(principal);

    /* Repay */
    await pool.connect(accountBorrower).repay(loanReceipt);

    return [loanReceipt, loanReceiptHash];
  }

  async function createLiquidatedLoan(principal: bigint): Promise<bigint> {
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
          FixedPoint.from("10", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("10", 6)),
          "0x"
        )
      ).to.equal(FixedPoint.from("10.082192", 6));

      expect(
        await pool.quote(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        )
      ).to.equal(FixedPoint.from("25.205480", 6));
    });

    it("quotes repayment from various duration and rate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));

      expect(await pool.quote(FixedPoint.from("25", 6), 7 * 86400, await nft1.getAddress(), 123, ticks, "0x")).to.equal(
        FixedPoint.from("25.066732", 6)
      );
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("100", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool.quote(
          FixedPoint.from("10", 6),
          30 * 86400,
          await tok1.getAddress(),
          123,
          await sourceLiquidity(FixedPoint.from("10", 6)),
          "0x"
        )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral");
    });

    it("fails with non-increasing tick", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));
      const temp = ticks[4];
      ticks[4] = ticks[5];
      ticks[5] = temp;

      await expect(
        pool.quote(FixedPoint.from("25", 6), 7 * 86400, await nft1.getAddress(), 123, ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duplicate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));
      ticks[4] = ticks[5];

      await expect(
        pool.quote(FixedPoint.from("35", 6), 7 * 86400, await nft1.getAddress(), 123, ticks, "0x")
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails on low duration ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));

      await expect(
        pool.quote(FixedPoint.from("35", 6), 8 * 86400, await nft1.getAddress(), 123, ticks, "0x")
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
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25", 6),
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
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending / SCALE).to.closeTo(repayment, "1");

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);
    });

    it("originates a loan from various duration and rate ticks", async function () {
      const ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));

      /* Borrow */
      await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          7 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          ticks,
          "0x"
        );
    });

    it("originates loan with v1 delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25", 6),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
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
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending / SCALE).to.closeTo(repayment, "1");

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Validate delegation */
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          123
        )
      ).to.equal(true);
    });

    it("originates loan with v2 delegation", async function () {
      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25", 6),
      });

      await expect(borrowTx).to.emit(pool, "LoanOriginated");

      await expectEvent(borrowTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 123,
        rights: ethers.ZeroHash,
        enable: true,
      });

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      expect(decodedLoanReceipt.version).to.equal(2);
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending / SCALE).to.closeTo(repayment, "1");

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Validate delegation */
      expect(
        await delegateRegistryV2.checkDelegateForERC721(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          123,
          ethers.ZeroHash
        )
      ).to.equal(true);
    });

    it("originates loan with admin fee", async function () {
      /* Set admin fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .borrow.staticCall(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, nft1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        tokenId: 123,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: FixedPoint.from("25", 6),
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
      expect(decodedLoanReceipt.repayment / SCALE + 1n).to.equal(repayment);
      expect(decodedLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(borrowTx.blockHash!)).timestamp) + 30n * 86400n
      );
      expect(decodedLoanReceipt.duration).to.equal(30 * 86400);
      expect(decodedLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Calculate admin fee */
      const adminFee = (BigInt(await pool.adminFeeRate()) * (repayment - FixedPoint.from("25", 6))) / 10000n;

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending / SCALE).to.closeTo(repayment - adminFee, "1");

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.closeTo((adminFee * 9500n) / 10000n, "1");

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment / SCALE + 1n,
      });

      await expectEvent(repayTx, pool, "AdminFeeShareTransferred", {
        feeShareRecipient: accounts[2].address,
        feeShareAmount: (adminFee * 500n) / 10000n,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("fails on unsupported collateral", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            30 * 86400,
            await tok1.getAddress(),
            123,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "UnsupportedCollateral");
    });

    it("fails on exceeded max repayment", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("25.01", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "RepaymentTooHigh");
    });

    it("fails on insufficient liquidity", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("30", 6),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("31", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails with non-increasing tick", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));
      const temp = ticks[4];
      ticks[4] = ticks[5];
      ticks[5] = temp;

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26", 6),
            ticks,
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duplicate ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));
      ticks[4] = ticks[5];

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26", 6),
            ticks,
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with excessive ticks", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("150", 6),
            30 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("151", 6),
            await sourceLiquidity(FixedPoint.from("150", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("fails with low duration ticks", async function () {
      let ticks = await amendLiquidity(await sourceLiquidity(FixedPoint.from("25", 6)));

      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            8 * 86400,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26", 6),
            ticks,
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidTick");
    });

    it("fails with duration equals 0", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .borrow(
            FixedPoint.from("25", 6),
            0,
            await nft1.getAddress(),
            123,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
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
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: decodedLoanReceipt.repayment / SCALE + 1n,
      });
      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 123,
      });
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment / SCALE + 1n,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);

      /* Validate ticks and liquidity statistics */
      let totalPending = 0n;
      let totalUsed = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
        totalPending = totalPending + nodeReceipt.pending;
        totalUsed = totalUsed + nodeReceipt.used;
      }
    });

    it("repays with admin fee", async function () {
      /* set admin fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment;

      /* Validate events */
      await expectEvent(repayTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: repayment / SCALE + 1n,
      });

      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 124,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("repays with admin fee and fee share", async function () {
      /* set admin fee */
      await pool.setAdminFee(4400, accounts[2].address, 5000);

      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate prorated repayment amount */
      const repayment = decodedLoanReceipt.repayment;

      /* Calculate fee share */
      const feeShare = await pool.adminFeeBalance();

      /* Validate events */
      await expectEvent(
        repayTx,
        tok1,
        "Transfer",
        {
          from: await accountBorrower.getAddress(),
          to: await pool.getAddress(),
          value: repayment / SCALE + 1n,
        },
        0
      );

      await expectEvent(
        repayTx,
        tok1,
        "Transfer",
        {
          from: await pool.getAddress(),
          to: accounts[2].address,
          value: feeShare,
        },
        1
      );

      await expectEvent(repayTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        tokenId: 124,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
    });

    it("repays removes v1 delegation", async function () {
      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [3, 20, await accountBorrower.getAddress()])
        );

      /* Validate events */
      await expectEvent(borrowTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        value: true,
      });

      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, delegateRegistryV1, "DelegateForToken", {
        vault: await pool.getAddress(),
        delegate: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        value: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124
        )
      ).to.equal(false);
    });

    it("repays removes v2 delegation", async function () {
      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          124,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          ethers.solidityPacked(["uint16", "uint16", "bytes20"], [4, 20, await accountBorrower.getAddress()])
        );

      /* Validate events */
      await expectEvent(borrowTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        rights: ethers.ZeroHash,
        enable: true,
      });

      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, delegateRegistryV2, "DelegateERC721", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        contract_: await nft1.getAddress(),
        tokenId: 124,
        rights: ethers.ZeroHash,
        enable: false,
      });

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV2.checkDelegateForERC721(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124,
          ethers.ZeroHash
        )
      ).to.equal(false);
    });

    for (const [description, timeElapsed] of [
      ["one third", (30 * 86400) / 3],
      ["8 / 9ths", (8 * 30 * 86400) / 9],
      ["1 second", 1],
    ]) {
      it(`repays loan after ${description} of loan duration has elasped`, async function () {
        const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));
        const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

        /* Repay */
        await helpers.time.setNextBlockTimestamp(
          decodedLoanReceipt.maturity - decodedLoanReceipt.duration + BigInt(timeElapsed)
        );
        const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

        /* Calculate proration */
        const repayTxTimestamp = BigInt((await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp);
        const proration =
          FixedPoint.from(repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)) /
          decodedLoanReceipt.duration;

        /* Calculate prorated repayment amount */
        const repayment =
          ((decodedLoanReceipt.repayment - decodedLoanReceipt.principal) * proration) / ethers.WeiPerEther +
          decodedLoanReceipt.principal;

        /* Validate events */
        await expectEvent(repayTx, tok1, "Transfer", {
          from: await accountBorrower.getAddress(),
          to: await pool.getAddress(),
          value: repayment / SCALE + 1n,
        });

        await expectEvent(repayTx, nft1, "Transfer", {
          from: await pool.getAddress(),
          to: await accountBorrower.getAddress(),
          tokenId: 123,
        });

        await expectEvent(repayTx, pool, "LoanRepaid", {
          loanReceiptHash,
          repayment: repayment / SCALE + 1n,
        });

        /* Validate state */
        expect(await pool.loans(loanReceiptHash)).to.equal(2);

        /* Validate ticks */
        let totalDelta = 0n;
        for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
          const delta = ((nodeReceipt.pending - nodeReceipt.used) * proration) / ethers.WeiPerEther;
          const node = await pool.liquidityNode(nodeReceipt.tick);
          expect(node.value).to.equal(FixedPoint.from("25") + delta);
          expect(node.available).to.equal(FixedPoint.from("25") + delta);
          expect(node.pending).to.equal(0n);
          totalDelta = totalDelta + delta;
        }
      });
    }

    it("can repay after expiration and prior to liquidation", async function () {
      const [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      const repayment = decodedLoanReceipt.repayment;

      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate events */
      await expectEvent(repayTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: repayment / SCALE + 1n,
      });

      /* Validate ticks and liquidity statistics */
      let totalPending = 0n;
      let totalUsed = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") + nodeReceipt.pending - nodeReceipt.used;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
        totalPending = totalPending + nodeReceipt.pending;
        totalUsed = totalUsed + nodeReceipt.used;
      }

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(
        await delegateRegistryV1.checkDelegateForToken(
          await accountBorrower.getAddress(),
          await pool.getAddress(),
          await nft1.getAddress(),
          124
        )
      ).to.equal(false);
    });

    it("fails on invalid caller", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25", 6));
      await expect(pool.connect(accountLender).repay(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid loan receipt", async function () {
      await expect(
        pool
          .connect(accountBorrower)
          .repay("0xa9059cbb0000000000000000000000001f9090aae28b8a3dceadf281b0f12828e676c326")
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25", 6));
      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on liquidated loan", async function () {
      const [loanReceipt] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      await expect(pool.connect(accountBorrower).repay(loanReceipt)).to.be.revertedWithCustomError(
        pool,
        "InvalidLoanReceipt"
      );
    });

    it("fails on same block repayment", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      const [loanReceipt, _] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Get token id */
      const tokenId =
        (await nft1.ownerOf(123)) === (await accountBorrower.getAddress())
          ? 123
          : (await nft1.ownerOf(124)) === (await accountBorrower.getAddress())
            ? 124
            : 125;

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1", 6),
          1,
          await nft1.getAddress(),
          tokenId,
          FixedPoint.from("2", 6),
          await sourceLiquidity(FixedPoint.from("1", 6)),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = {
        version: decodedExistingLoanReceipt.version,
        principal: decodedExistingLoanReceipt.principal,
        repayment: decodedExistingLoanReceipt.repayment,
        adminFee: decodedExistingLoanReceipt.adminFee,
        borrower: decodedExistingLoanReceipt.borrower,
        maturity: BigInt("10000000001"),
        duration: decodedExistingLoanReceipt.duration,
        collateralToken: decodedExistingLoanReceipt.collateralToken,
        collateralTokenId: decodedExistingLoanReceipt.collateralTokenId,
        collateralWrapperContextLen: decodedExistingLoanReceipt.collateralWrapperContextLen,
        collateralWrapperContext: decodedExistingLoanReceipt.collateralWrapperContext,
        nodeReceipts: [
          {
            tick: decodedExistingLoanReceipt.nodeReceipts[0].tick,
            used: decodedExistingLoanReceipt.nodeReceipts[0].used,
            pending: decodedExistingLoanReceipt.nodeReceipts[0].pending,
          },
        ],
      };
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      /* Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow() */
      await helpers.time.increaseTo(9999999999);

      /* Validate inability to do both borrow() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              FixedPoint.from("1", 6),
              1,
              await nft1.getAddress(),
              tokenId,
              FixedPoint.from("2", 6),
              await sourceLiquidity(FixedPoint.from("25", 6)),
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
      await pool.setAdminFee(4400, accounts[2].address, 5000);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          decodedLoanReceipt.principal / SCALE,
          15 * 86400,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: (decodedLoanReceipt.repayment - decodedLoanReceipt.principal) / SCALE + 1n,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment / SCALE + 1n,
      });

      await expectEvent(refinanceTx, pool, "AdminFeeShareTransferred", {
        feeShareRecipient: accounts[2].address,
        feeShareAmount: adminFee / SCALE / 2n,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.closeTo(adminFee / SCALE / 2n, "1");
    });

    it("refinance loan at maturity with admin fee and smaller principal (1,000,000 wei less)", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          (decodedLoanReceipt.principal - FixedPoint.from("1")) / SCALE,
          15 * 86400,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(15);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await accountBorrower.getAddress(),
        to: await pool.getAddress(),
        value: (decodedLoanReceipt.repayment - decodedNewLoanReceipt.principal) / SCALE + 1n,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment / SCALE + 1n,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.closeTo(adminFee / SCALE, "1");
    });

    it("refinance loan at maturity with admin fee and bigger principal (1,000,000 wei more)", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(
          loanReceipt,
          (decodedLoanReceipt.principal + FixedPoint.from("1")) / SCALE,
          15 * 86400,
          FixedPoint.from("27", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );
      const newLoanReceipt = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceipt;
      const newLoanReceiptHash = (await extractEvent(refinanceTx, pool, "LoanOriginated")).args.loanReceiptHash;

      /* Calculate admin fee */
      const adminFee =
        (BigInt(await pool.adminFeeRate()) * (decodedLoanReceipt.repayment - FixedPoint.from("25"))) / 10000n;

      /* Validate hash */
      expect(loanReceiptHash).to.equal(await loanReceiptLib.hash(loanReceipt));

      /* Validate loan receipt */
      const decodedNewLoanReceipt = await loanReceiptLib.decode(newLoanReceipt);
      expect(decodedNewLoanReceipt.version).to.equal(2);
      expect(decodedNewLoanReceipt.borrower).to.equal(await accountBorrower.getAddress());
      expect(decodedNewLoanReceipt.maturity).to.equal(
        BigInt((await ethers.provider.getBlock(refinanceTx.blockHash!)).timestamp) + 15n * 86400n
      );
      expect(decodedNewLoanReceipt.duration).to.equal(15 * 86400);
      expect(decodedNewLoanReceipt.collateralToken).to.equal(await nft1.getAddress());
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(123);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(16);

      /* Validate events */
      await expectEvent(refinanceTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: await accountBorrower.getAddress(),
        value: (decodedNewLoanReceipt.principal - decodedLoanReceipt.repayment) / SCALE,
      });

      await expectEvent(refinanceTx, pool, "LoanRepaid", {
        loanReceiptHash,
        repayment: decodedLoanReceipt.repayment / SCALE + 1n,
      });

      await expect(refinanceTx).to.emit(pool, "LoanOriginated");

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(2);
      expect(await pool.loans(newLoanReceiptHash)).to.equal(1);
      expect(await pool.adminFeeBalance()).to.closeTo(adminFee / SCALE, "1");
    });

    it("fails on refinance and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Validate inability to do both refinance() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25", 6),
              1,
              FixedPoint.from("26", 6),
              await sourceLiquidity(FixedPoint.from("25", 6)),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              loanReceipt,
              FixedPoint.from("25", 6),
              1,
              FixedPoint.from("26", 6),
              await sourceLiquidity(FixedPoint.from("25", 6)),
              "0x",
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on borrow and refinance in same block with same loan receipt fields", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Workaround to skip borrow() in beforeEach */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Get token id */
      const tokenId =
        (await nft1.ownerOf(123)) === (await accountBorrower.getAddress())
          ? 123
          : (await nft1.ownerOf(124)) === (await accountBorrower.getAddress())
            ? 124
            : 125;

      /* Borrow to get loan receipt object */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("1", 6),
          1,
          await nft1.getAddress(),
          tokenId,
          FixedPoint.from("2", 6),
          await sourceLiquidity(FixedPoint.from("1", 6)),
          "0x"
        );

      let encodedLoanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      await pool.connect(accountBorrower).repay(encodedLoanReceipt);

      /* Use existing loan receipt with the parameters we want */
      const decodedExistingLoanReceipt = await loanReceiptLib.decode(encodedLoanReceipt);

      /* Mutate NFT address in loan receipt and encode it */
      const nodeReceipt = {
        version: decodedExistingLoanReceipt.version,
        principal: decodedExistingLoanReceipt.principal,
        repayment: decodedExistingLoanReceipt.repayment,
        adminFee: decodedExistingLoanReceipt.adminFee,
        borrower: decodedExistingLoanReceipt.borrower,
        maturity: BigInt("10000000001"),
        duration: decodedExistingLoanReceipt.duration,
        collateralToken: decodedExistingLoanReceipt.collateralToken,
        collateralTokenId: decodedExistingLoanReceipt.collateralTokenId,
        collateralWrapperContextLen: decodedExistingLoanReceipt.collateralWrapperContextLen,
        collateralWrapperContext: decodedExistingLoanReceipt.collateralWrapperContext,
        nodeReceipts: [
          {
            tick: decodedExistingLoanReceipt.nodeReceipts[0].tick,
            used: decodedExistingLoanReceipt.nodeReceipts[0].used,
            pending: decodedExistingLoanReceipt.nodeReceipts[0].pending,
          },
        ],
      };
      encodedLoanReceipt = await loanReceiptLib.encode(nodeReceipt);

      /* Force timestamp so maturity timestamp is constant and give us the same loanReceipt from borrow() */
      await helpers.time.increaseTo(9999999999);

      /* Validate inability to do both borrow() and refinance() with the same loan receipt fields */
      await expect(
        pool
          .connect(accountBorrower)
          .multicall([
            pool.interface.encodeFunctionData("borrow", [
              FixedPoint.from("1", 6),
              1,
              await nft1.getAddress(),
              tokenId,
              FixedPoint.from("2", 6),
              await sourceLiquidity(FixedPoint.from("25", 6)),
              "0x",
            ]),
            pool.interface.encodeFunctionData("refinance", [
              encodedLoanReceipt,
              nodeReceipt.principal,
              1,
              FixedPoint.from("2", 6),
              await sourceLiquidity(FixedPoint.from("1", 6)),
              "0x",
            ]),
          ])
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on invalid caller", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      await expect(
        pool
          .connect(accountLender)
          .refinance(
            loanReceipt,
            FixedPoint.from("25", 6),
            15 * 86400,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("1", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidCaller");
    });

    it("fails on invalid loan receipt", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            "0xa9059cbb0000000000000000000000001f9090aae28b8a3dceadf281b0f12828e676c326",
            FixedPoint.from("25", 6),
            15 * 86400,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      await pool.connect(accountBorrower).repay(loanReceipt);
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25", 6),
            15 * 86400,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on liquidated loan", async function () {
      /* Set Admin Fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Refinance */
      await expect(
        pool
          .connect(accountBorrower)
          .refinance(
            loanReceipt,
            FixedPoint.from("25", 6),
            15 * 86400,
            FixedPoint.from("26", 6),
            await sourceLiquidity(FixedPoint.from("25", 6)),
            "0x"
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
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Wait for expiration */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.increaseTo(decodedLoanReceipt.maturity + 1n);

      /* Process expiration */
      const liquidateTx = await pool.liquidate(loanReceipt);

      /* Validate events */
      await expectEvent(liquidateTx, nft1, "Transfer", {
        from: await pool.getAddress(),
        to: await collateralLiquidator.getAddress(),
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
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "LoanNotExpired");
    });

    it("fails on repaid loan", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      /* Repay */
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Attempt to process repaid loan receipt */
      await expect(pool.liquidate(loanReceipt)).to.be.revertedWithCustomError(pool, "InvalidLoanReceipt");
    });

    it("fails on repaid loan after expiration", async function () {
      /* Create Loan */
      [loanReceipt, loanReceiptHash] = await createActiveLoan(FixedPoint.from("25", 6));

      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity + 1n);

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
      [loanReceipt, loanReceiptHash] = await createExpiredLoan(FixedPoint.from("25", 6));
    });

    it("processes liquidated loan for higher proceeds", async function () {
      /* Decode loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Process expiration */
      await pool.liquidate(loanReceipt);

      /* Withdraw collateral */
      await collateralLiquidator
        .connect(accountLiquidator)
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral and process liquidation */
      const onCollateralLiquidatedTx = await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt,
          FixedPoint.from("30", 6)
        );

      /* Compute borrower surplus and lender proceeds */
      const borrowerSurplus = FixedPoint.from("30") - decodedLoanReceipt.repayment;
      const lendersProceeds = FixedPoint.from("30") - borrowerSurplus;

      /* Validate events */
      await expectEvent(
        onCollateralLiquidatedTx,
        tok1,
        "Transfer",
        {
          from: await collateralLiquidator.getAddress(),
          to: await pool.getAddress(),
          value: FixedPoint.from("30", 6),
        },
        1
      );
      await expectEvent(
        onCollateralLiquidatedTx,
        tok1,
        "Transfer",
        {
          from: await pool.getAddress(),
          to: decodedLoanReceipt.borrower,
          value: borrowerSurplus / SCALE,
        },
        2
      );
      await expectEvent(onCollateralLiquidatedTx, pool, "CollateralLiquidated", {
        loanReceiptHash,
        proceeds: FixedPoint.from("30", 6),
        borrowerProceeds: borrowerSurplus / SCALE,
      });

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);

      /* Compute total pending */
      const totalPending = decodedLoanReceipt.repayment - decodedLoanReceipt.adminFee;

      /* Validate ticks */
      let i = 0;
      let proceedsRemaining = lendersProceeds;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const proceeds =
          i == decodedLoanReceipt.nodeReceipts.length - 1
            ? proceedsRemaining
            : (lendersProceeds * nodeReceipt.pending) / totalPending;
        const value = FixedPoint.from("25") - nodeReceipt.used + proceeds;
        proceedsRemaining = proceedsRemaining - proceeds;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
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
        .withdrawCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt
        );

      /* Liquidate collateral and process liquidation */
      const proceeds =
        decodedLoanReceipt.nodeReceipts[0].pending + decodedLoanReceipt.nodeReceipts[1].pending / SCALE + 1n;
      await collateralLiquidator
        .connect(accountLiquidator)
        .liquidateCollateral(
          await pool.getAddress(),
          await tok1.getAddress(),
          await nft1.getAddress(),
          123,
          "0x",
          loanReceipt,
          proceeds
        );

      /* Validate state */
      expect(await pool.loans(loanReceiptHash)).to.equal(4);

      /* Validate ticks */
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(0, 2)) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        const value = FixedPoint.from("25") - nodeReceipt.used + nodeReceipt.pending;
        expect(node.value).to.equal(value);
        expect(node.available).to.equal(value);
        expect(node.pending).to.equal(0n);
      }
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts.slice(2, 0)) {
        const node = await pool.liquidityNode(nodeReceipt.tick);
        expect(node.value).to.equal(FixedPoint.from("25"));
        expect(node.available).to.equal(FixedPoint.from("25"));
        expect(node.pending).to.equal(0n);
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
      const tx = await pool.setAdminFee(rate, accounts[2].address, 500);

      /* Validate events */
      await expectEvent(tx, pool, "AdminFeeUpdated", {
        rate: rate,
        feeShareRecipient: accounts[2].address,
        feeShareSplit: 500,
      });

      /* Validate rate was successfully set */
      expect(await pool.adminFeeRate()).to.equal(rate);
    });

    it("fails on invalid value", async function () {
      await expect(pool.setAdminFee(10000n, accounts[2].address, 500)).to.be.revertedWithCustomError(
        pool,
        "InvalidParameters"
      );
    });

    it("fails on invalid caller", async function () {
      const rate = 500;

      await expect(pool.connect(accounts[1]).setAdminFee(rate, accounts[2].address, 500)).to.be.revertedWithCustomError(
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
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Validate loan receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Sum used and pending totals from node receipts */
      let totalUsed = 0n;
      let totalPending = 0n;
      for (const nodeReceipt of decodedLoanReceipt.nodeReceipts) {
        totalUsed = totalUsed + nodeReceipt.used;
        totalPending = totalPending + nodeReceipt.pending;
      }

      /* Calculate approx admin fee */
      let adminFee = (BigInt(await pool.adminFeeRate()) * (repayment - FixedPoint.from("25", 6))) / 10000n;

      /* Validate used and pending totals */
      expect(totalUsed).to.equal(FixedPoint.from("25"));
      expect(totalPending / SCALE).to.closeTo(repayment - adminFee, "1");

      /* Validate loan state */
      expect(await pool.loans(loanReceiptHash)).to.equal(1);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity);
      await pool.connect(accountBorrower).repay(loanReceipt);

      /* Validate total adminFee balance */
      expect(await pool.adminFeeBalance()).to.closeTo(adminFee, "1");

      /* Use exact admin fee to withdraw */
      adminFee = await pool.adminFeeBalance();

      const startingBalance = await tok1.balanceOf(accounts[1].address);

      /* Withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address);

      /* Validate events */
      await expectEvent(withdrawTx, tok1, "Transfer", {
        from: await pool.getAddress(),
        to: accounts[1].address,
        value: adminFee,
      });

      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        recipient: accounts[1].address,
        amount: adminFee,
      });

      /* Validate balance in account */
      expect(await tok1.balanceOf(accounts[1].address)).to.equal(startingBalance + adminFee);

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("withdraws admin fees with repayment after one third of loan maturity", async function () {
      /* Set admin fee */
      await pool.setAdminFee(500, ethers.ZeroAddress, 0);

      /* Quote repayment */
      const repayment = await pool.quote(
        FixedPoint.from("25", 6),
        30 * 86400,
        await nft1.getAddress(),
        123,
        await sourceLiquidity(FixedPoint.from("25", 6)),
        "0x"
      );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25", 6),
          30 * 86400,
          await nft1.getAddress(),
          123,
          FixedPoint.from("26", 6),
          await sourceLiquidity(FixedPoint.from("25", 6)),
          "0x"
        );

      /* Decode loan receipt */
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Repay */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity - (2n * 30n * 86400n) / 3n);
      const repayTx = await pool.connect(accountBorrower).repay(loanReceipt);

      /* Calculate repayment proration */
      const repayTxTimestamp = BigInt((await ethers.provider.getBlock((await repayTx.wait()).blockNumber)).timestamp);
      const proration =
        FixedPoint.from(repayTxTimestamp - (decodedLoanReceipt.maturity - decodedLoanReceipt.duration)) /
        decodedLoanReceipt.duration;

      /* Calculate admin fee */
      const adminFee =
        (((BigInt(await pool.adminFeeRate()) * (repayment - FixedPoint.from("25", 6))) / 10000n) * proration) /
        ethers.WeiPerEther;

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(adminFee);

      /* Withdraw */
      const withdrawTx = await pool.withdrawAdminFees(accounts[1].address);

      /* Validate events */
      await expectEvent(withdrawTx, pool, "AdminFeesWithdrawn", {
        recipient: accounts[1].address,
        amount: adminFee,
      });

      /* Validate total admin fee balance */
      expect(await pool.adminFeeBalance()).to.equal(0);
    });

    it("fails on invalid caller", async function () {
      /* Set admin fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create repaid loan */
      await createRepaidLoan(FixedPoint.from("25", 6));

      await expect(pool.connect(accounts[1]).withdrawAdminFees(accounts[1].address)).to.be.revertedWithCustomError(
        pool,
        "InvalidCaller"
      );
    });

    it("fails on invalid address", async function () {
      /* Set admin fee */
      await pool.setAdminFee(500, accounts[2].address, 500);

      /* Create repaid loan */
      await createRepaidLoan(FixedPoint.from("25", 6));

      await expect(pool.withdrawAdminFees(ethers.ZeroAddress)).to.be.revertedWithCustomError(pool, "InvalidParameters");
    });
  });

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(ethers.id("supportsInterface(bytes4)").substring(0, 10))).to.equal(true);
    });

    it("returns false on unsupported interfaces", async function () {
      expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
      expect(await pool.supportsInterface("0x00000000")).to.equal(false);
      expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
