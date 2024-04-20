import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLoanReceipt,
  TestDelegateRegistryV1,
  TestDelegateRegistryV2,
  ExternalCollateralLiquidator,
  Pool,
  ERC20DepositTokenImplementation,
  TestMaliciousERC20,
  WeightedRateCollectionPool,
} from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";
import { extractEvent, expectEvent } from "./helpers/EventUtilities";
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";
import { BigNumber } from "ethers";

describe("Pool Tokenized", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: WeightedRateCollectionPool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;
  let maliciousToken: TestMaliciousERC20;

  /* CONSTANTS */
  const TICK10 = Tick.encode("10");
  const TICK15 = Tick.encode("15");
  const TICKLTV1000 = Tick.encode(ethers.BigNumber.from("1000"), 0, 0, 18, 1);
  const TICKLTV1511 = Tick.encode(ethers.BigNumber.from("1511"), 0, 0, 18, 1);
  const TICKLTV2220 = Tick.encode(ethers.BigNumber.from("2220"), 0, 0, 18, 1);

  const ZERO_ETHER = FixedPoint.from("0");
  const ONE_ETHER = FixedPoint.from("1");
  const TWO_ETHER = FixedPoint.from("2");

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
    const maliciousTokenFactory = await ethers.getContractFactory("TestMaliciousERC20");

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

    /* Deploy test delegation registry v1 */
    delegateRegistryV1 = await delegateRegistryV1Factory.deploy();
    await delegateRegistryV1.deployed();

    /* Deploy test delegation registry v2 */
    delegateRegistryV2 = await delegateRegistryV2Factory.deploy();
    await delegateRegistryV2.deployed();

    /* Deploy erc20 deposit token implementation */
    erc20DepositTokenImpl = (await erc20DepositTokenImplFactory.deploy()) as ERC20DepositTokenImplementation;
    await erc20DepositTokenImpl.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      collateralLiquidator.address,
      delegateRegistryV1.address,
      delegateRegistryV2.address,
      erc20DepositTokenImpl.address,
      []
    )) as Pool;
    await poolImpl.deployed();

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address[]", "address", "address", "uint64[]", "uint64[]"],
          [
            [nft1.address],
            tok1.address,
            ethers.constants.AddressZero,
            [30 * 86400, 14 * 86400, 7 * 86400],
            [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
          ]
        ),
      ])
    );

    await proxy.deployed();
    pool = (await ethers.getContractAt("WeightedRateCollectionPool", proxy.address)) as WeightedRateCollectionPool;

    /* Deploy malicious token */
    maliciousToken = (await maliciousTokenFactory.deploy(pool.address, TICK10)) as TestMaliciousERC20;

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
  /* ERC20 Token */
  /****************************************************************************/

  const _tickToBytes = (tick: BigNumber) => {
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(tick), 32);
  };

  const _computeDeterministicAddress = async (tick: BigNumber) => {
    const ABI = ["function initialize(bytes)"];
    const iface = new ethers.utils.Interface(ABI);

    const initData = ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes"],
      [pool.address, iface.encodeFunctionData("initialize", [_tickToBytes(tick)])]
    );

    const beaconProxyBytecode = (await ethers.getContractFactory("ERC20DepositTokenProxy")).bytecode;
    const creationCode = ethers.utils.hexConcat([beaconProxyBytecode, initData]);

    return ethers.utils.getCreate2Address(pool.address, _tickToBytes(tick), ethers.utils.keccak256(creationCode));
  };

  const _depositAndTokenizeMulticall = async (depositor: SignerWithAddress, tick: BigNumber, amount: FixedPoint) => {
    return await pool
      .connect(depositor)
      .multicall([
        pool.interface.encodeFunctionData("deposit", [tick, amount, 0]),
        pool.interface.encodeFunctionData("tokenize", [tick]),
      ]);
  };

  describe("ERC20DepositToken", async function () {
    describe("#computeAddress", async function () {
      it("returns correct deterministic address", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;

        expect(tokenInstance).to.equal(await _computeDeterministicAddress(TICK10));
      });

      it("returns correct deterministic address for another tick", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;

        expect(tokenInstance).to.equal(await _computeDeterministicAddress(TICK15));
      });
    });

    describe("#implementation", async function () {
      it("returns correct implementation address", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenImplementation = (await extractEvent(depTx, pool, "TokenCreated")).args.implementation;

        expect(tokenImplementation).to.equal(await pool.getERC20DepositTokenImplementation());
        expect(erc20DepositTokenImpl.address).to.equal(await pool.getERC20DepositTokenImplementation());
      });
    });

    describe("#tokenize", async function () {
      it("can tokenize after deposit", async function () {
        /* Deposit */
        const sharesMinted = await pool.connect(accountDepositors[0]).callStatic.deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);
        const amount = (await pool.liquidityNode(TICK10)).value.mul(sharesMinted).div(FixedPoint.from("1"));

        /* Tokenize */
        const depTx = await pool.connect(accountDepositors[0]).tokenize(TICK10);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;

        const predictedDeterministicAddress = await _computeDeterministicAddress(TICK10);

        expectEvent(depTx, pool, "TokenCreated", {
          instance: predictedDeterministicAddress,
          implementation: erc20DepositTokenImpl.address,
          tick: TICK10,
        });

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(amount);

        /* Validate pool deposit state */
        const [shares] = await pool.deposits(accountDepositors[0].address, TICK10);
        expect(shares).to.equal(sharesMinted);
      });

      it("multiple depositors can tokenize without causing revert", async function () {
        /* Deposit */
        const sharesMinted1 = await pool.connect(accountDepositors[0]).callStatic.deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);
        const amount = (await pool.liquidityNode(TICK10)).value.mul(sharesMinted1).div(FixedPoint.from("1"));

        const sharesMinted2 = await pool.connect(accountDepositors[1]).callStatic.deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Tokenize */
        const tokTx = await pool.connect(accountDepositors[0]).tokenize(TICK10);
        const tokenInstance = (await extractEvent(tokTx, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;

        /* Tokenize again */
        await pool.connect(accountDepositors[1]).tokenize(TICK10);

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(amount);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[0].address, TICK10);
        expect(shares1).to.equal(sharesMinted1);

        const [shares2] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares2).to.equal(sharesMinted2);
      });

      it("tokenizing invalid tick reverts - out of bounds duration", async function () {
        /* Tokenize invalid tick */
        const invalidTick = Tick.encode("15", 3, 0);

        await expect(pool.connect(accountDepositors[1]).tokenize(invalidTick)).to.be.revertedWithCustomError(
          pool,
          "InvalidTick"
        );
      });

      it("tokenizing invalid tick reverts - out of bounds rate", async function () {
        /* Tokenize invalid tick */
        const invalidTick = Tick.encode("15", 0, 3);

        await expect(pool.connect(accountDepositors[1]).tokenize(invalidTick)).to.be.revertedWithCustomError(
          pool,
          "InvalidTick"
        );
      });
    });

    describe("#_createDeterministicProxy", async function () {
      it("deposit into new tick creates ERC20 token contract at correct address", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        const tokenImplementation = (await extractEvent(depTx, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress = await _computeDeterministicAddress(TICK10);

        // Assertions
        expectEvent(depTx, pool, "TokenCreated", {
          instance: predictedDeterministicAddress,
          implementation: erc20DepositTokenImpl.address,
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(erc20DepositTokenImpl.address);
      });

      it("second deposit succeeds", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        const tokenImplementation = (await extractEvent(depTx, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress = await _computeDeterministicAddress(TICK10);

        expectEvent(depTx, pool, "TokenCreated", {
          instance: predictedDeterministicAddress,
          implementation: erc20DepositTokenImpl.address,
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(erc20DepositTokenImpl.address);

        await pool.connect(accountDepositors[0]).deposit(TICK10, TWO_ETHER, 0);
      });

      it("create multiple erc20 token contracts", async function () {
        /* Deposit TICK10 */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        const tokenImplementation = (await extractEvent(depTx, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress = await _computeDeterministicAddress(TICK10);

        expectEvent(depTx, pool, "TokenCreated", {
          instance: predictedDeterministicAddress,
          implementation: erc20DepositTokenImpl.address,
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(erc20DepositTokenImpl.address);

        /* Deposit TICK15 */
        const depTx2 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance2 = (await extractEvent(depTx2, pool, "TokenCreated")).args.instance;
        const tokenImplementation2 = (await extractEvent(depTx2, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress2 = await _computeDeterministicAddress(TICK15);

        expectEvent(depTx2, pool, "TokenCreated", {
          instance: predictedDeterministicAddress2,
          implementation: erc20DepositTokenImpl.address,
          tick: TICK15,
        });

        expect(tokenInstance2).to.equal(predictedDeterministicAddress2);
        expect(tokenImplementation2).to.equal(erc20DepositTokenImpl.address);
      });
    });
  });

  describe("ERC20DepositTokenImplementation", async function () {
    describe("getters", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20TokenLTV1000: ERC20DepositTokenImplementation;
      let erc20TokenLTV1511: ERC20DepositTokenImplementation;
      let erc20TokenLTV2220: ERC20DepositTokenImplementation;

      beforeEach("deposit into new tick", async () => {
        const depTx1 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance1 = (await extractEvent(depTx1, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance1
        )) as ERC20DepositTokenImplementation;

        const depTx2 = await _depositAndTokenizeMulticall(accountDepositors[0], TICKLTV1000, ONE_ETHER);
        const tokenInstance2 = (await extractEvent(depTx2, pool, "TokenCreated")).args.instance;
        erc20TokenLTV1000 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance2
        )) as ERC20DepositTokenImplementation;

        const depTx3 = await _depositAndTokenizeMulticall(accountDepositors[0], TICKLTV1511, ONE_ETHER);
        const tokenInstance3 = (await extractEvent(depTx3, pool, "TokenCreated")).args.instance;
        erc20TokenLTV1511 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance3
        )) as ERC20DepositTokenImplementation;

        const depTx4 = await _depositAndTokenizeMulticall(accountDepositors[0], TICKLTV2220, ONE_ETHER);
        const tokenInstance4 = (await extractEvent(depTx4, pool, "TokenCreated")).args.instance;
        erc20TokenLTV2220 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance4
        )) as ERC20DepositTokenImplementation;
      });

      it("returns correct name", async function () {
        expect(await erc20Token10.name()).to.equal("MetaStreet V2 Deposit: NFT1-TOK1:10");
        expect(await erc20TokenLTV1000.name()).to.equal("MetaStreet V2 Deposit: NFT1-TOK1:10%");
        expect(await erc20TokenLTV1511.name()).to.equal("MetaStreet V2 Deposit: NFT1-TOK1:15.11%");
        expect(await erc20TokenLTV2220.name()).to.equal("MetaStreet V2 Deposit: NFT1-TOK1:22.20%");
      });

      it("returns correct symbol", async function () {
        expect(await erc20Token10.symbol()).to.equal("mTOK1-NFT1:10");
        expect(await erc20TokenLTV1000.symbol()).to.equal("mTOK1-NFT1:10%");
        expect(await erc20TokenLTV1511.symbol()).to.equal("mTOK1-NFT1:15.11%");
        expect(await erc20TokenLTV2220.symbol()).to.equal("mTOK1-NFT1:22.20%");
      });

      it("returns correct decimals", async function () {
        expect(await erc20Token10.decimals()).to.equal(18);
      });

      it("returns correct pool", async function () {
        expect(await erc20Token10.pool()).to.equal(pool.address);
      });

      it("returns correct tick", async function () {
        expect(await erc20Token10.tick()).to.equal(TICK10);
      });

      it("returns correct limit", async function () {
        expect(await erc20Token10.limit()).to.equal(FixedPoint.from("10"));
      });

      it("returns correct duration", async function () {
        expect(await erc20Token10.duration()).to.equal(30 * 86400);
      });

      it("returns correct rate", async function () {
        expect(await erc20Token10.rate()).to.equal(FixedPoint.normalizeRate("0.10"));
      });

      it("returns correct currency token", async function () {
        expect(await erc20Token10.currencyToken()).to.equal(tok1.address);
      });
    });

    describe("#depositSharePrice", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;

      beforeEach("deposit into new tick", async () => {
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;
      });

      it("returns correct share price", async function () {
        expect(await erc20Token10.depositSharePrice()).to.equal(ONE_ETHER);
      });

      it("returns correct share price after borrow", async function () {
        await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedDepositPrice = await erc20Token10.depositSharePrice();

        /* Deposit */
        const shares = await pool.connect(accountDepositors[1]).callStatic.deposit(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = ONE_ETHER.mul(FixedPoint.from("1")).div(shares);

        expect(expectedDepositPrice).to.equal(actualDepositPrice);
      });

      it("returns correct share price after borrow + repayment", async function () {
        const [loanReceipt] = await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt);

        /* Cache expected deposit price */
        const expectedDepositPrice = await erc20Token10.depositSharePrice();

        /* Deposit */
        const shares = await pool.connect(accountDepositors[1]).callStatic.deposit(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = ONE_ETHER.mul(FixedPoint.from("1")).div(shares);

        expect(expectedDepositPrice).to.equal(actualDepositPrice);
      });

      it("returns correct share price after multiple deposits + borrow", async function () {
        /* Next deposit */
        pool.connect(accountDepositors[2]).deposit(TICK10, ONE_ETHER, 0);

        await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedDepositPrice = await erc20Token10.depositSharePrice();

        /* Deposit */
        const shares = await pool.connect(accountDepositors[1]).callStatic.deposit(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = ONE_ETHER.mul(FixedPoint.from("1")).div(shares);

        expect(expectedDepositPrice).to.equal(actualDepositPrice);
      });

      it("returns correct share price after multiple deposits, multiple borrows and multiple repayments", async function () {
        /* Next deposit */
        pool.connect(accountDepositors[2]).deposit(TICK10, ONE_ETHER, 0);

        const [loanReceipt1] = await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt1);

        /* Next borrow */
        const [loanReceipt2] = await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt2);

        /* Cache expected deposit price */
        const expectedDepositPrice = await erc20Token10.depositSharePrice();

        /* Deposit */
        const shares = await pool.connect(accountDepositors[1]).callStatic.deposit(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = ONE_ETHER.mul(FixedPoint.from("1")).div(shares);

        expect(expectedDepositPrice).to.equal(actualDepositPrice);
      });
    });

    describe("#redemptionSharePrice", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let sharesMinted: ethers.BigNumber;

      beforeEach("deposit into new tick", async () => {
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;
        sharesMinted = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
      });

      it("returns correct redemption share price", async function () {
        expect(await erc20Token10.redemptionSharePrice()).to.equal(ONE_ETHER);
      });

      it("returns correct redemption share price after borrow", async function () {
        await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Cache expected deposit price */
        const expectedRedemptionPrice = await erc20Token10.redemptionSharePrice();

        /* Get actual redemption price */
        const actualRedemptionPrice = ONE_ETHER.mul(FixedPoint.from("1")).div(FixedPoint.from("1"));

        expect(expectedRedemptionPrice).to.equal(actualRedemptionPrice);
      });

      it("returns correct redemption share price after borrow + repay", async function () {
        const [loanReceipt] = await createActiveLoan(ONE_ETHER);

        /* Fast forward one day */
        await helpers.time.increase(84600);

        /* Repay loan */
        await pool.connect(accountBorrower).repay(loanReceipt);

        /* Cache expected redemption price */
        const expectedRedemptionPrice = await erc20Token10.redemptionSharePrice();

        /* Redeem */
        const redemptionTx = await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted);
        const redemptionId = (await extractEvent(redemptionTx, pool, "Redeemed")).args.redemptionId;

        /* Withdraw */
        const [shares, amount] = await pool.connect(accountDepositors[0]).callStatic.withdraw(TICK10, redemptionId);

        /* Get actual redemption price */
        const actualRedemptionPrice = amount.mul(FixedPoint.from("1")).div(shares);

        expect(expectedRedemptionPrice).to.closeTo(actualRedemptionPrice, ethers.BigNumber.from("2"));
      });
    });

    describe("#onExternalTransfer", async function () {
      it("reverts when called by non-pool contract", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;

        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;

        await expect(
          erc20Token10
            .connect(accountDepositors[0])
            .onExternalTransfer(ethers.constants.AddressZero, ethers.constants.AddressZero, ONE_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "InvalidCaller");
      });
    });

    describe("#totalSupply", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;
      let sharesMinted: ethers.BigNumber;

      beforeEach("deposit into new tick", async () => {
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;
        sharesMinted = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
      });

      it("returns correct amount of tokens", async function () {
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);
      });

      it("returns correct amount of tokens - multiple depositors", async function () {
        await pool.connect(accountDepositors[1]).deposit(TICK10, TWO_ETHER, 0);
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("3"));
      });

      it("returns correct amount of tokens - multiple depositors, multiple ticks", async function () {
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, TWO_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance
        )) as ERC20DepositTokenImplementation;

        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);
        expect(await erc20Token15.totalSupply()).to.equal(TWO_ETHER);
      });

      it("returns correct amount of tokens - after redeem", async function () {
        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted);
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER.sub(sharesMinted));
      });

      it("returns correct amount of tokens - after redeem multiple times", async function () {
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);

        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted);

        const sharesMinted2 = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted2);

        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER.mul("2").sub(sharesMinted).sub(sharesMinted2));
      });
    });

    describe("#balanceOf", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;
      let sharesMinted10: ethers.BigNumber;
      let sharesMinted15: ethers.BigNumber;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;
        sharesMinted10 = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;

        const depTx15 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;
        sharesMinted15 = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
      });

      it("returns correct amount of tokens", async function () {
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(sharesMinted10);
        expect(await erc20Token15.balanceOf(accountDepositors[0].address)).to.equal(sharesMinted15);
      });

      it("returns correct amount of tokens - multiple depositors", async function () {
        await pool.connect(accountDepositors[1]).deposit(TICK10, TWO_ETHER, 0);
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(sharesMinted10);

        sharesMinted10 = (await pool.deposits(accountDepositors[1].address, TICK10)).shares;
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(sharesMinted10);
      });

      it("returns correct amount of tokens - multiple depositors, multiple ticks", async function () {
        await pool.connect(accountDepositors[1]).deposit(TICK15, TWO_ETHER, 0);
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(sharesMinted15);

        sharesMinted15 = (await pool.deposits(accountDepositors[1].address, TICK15)).shares;
        expect(await erc20Token15.balanceOf(accountDepositors[1].address)).to.equal(sharesMinted15);
      });

      it("returns correct amount of tokens - after redeem", async function () {
        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted10);
        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(ZERO_ETHER);
      });

      it("returns correct amount of tokens - after redeem multiple times", async function () {
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);

        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted10);

        const sharesMinted2 = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted2);

        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(ZERO_ETHER);
      });

      it("returns correct amount of tokens - after transfer", async function () {
        await erc20Token10.connect(accountDepositors[0]).transfer(accountDepositors[1].address, sharesMinted10);

        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(sharesMinted10);
      });

      it("returns correct amount of tokens - after transfer multiple times", async function () {
        await erc20Token10.connect(accountDepositors[0]).transfer(accountDepositors[1].address, sharesMinted10);
        await erc20Token10.connect(accountDepositors[1]).transfer(accountDepositors[2].address, sharesMinted10);

        expect(await erc20Token10.balanceOf(accountDepositors[0].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(sharesMinted10);
      });
    });

    describe("#transfer", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const depTx15 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;
      });

      it("should transfer tokens and update deposit state", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Transfer */
        const transferTx = await erc20Token10
          .connect(accountDepositors[1])
          .transfer(accountDepositors[2].address, ONE_ETHER);

        /* Validate events */
        await expectEvent(transferTx, pool, "Transferred", {
          from: accountDepositors[1].address,
          to: accountDepositors[2].address,
          tick: TICK10,
          shares: ONE_ETHER,
        });
        await expectEvent(transferTx, erc20Token10, "Transfer", {
          from: accountDepositors[1].address,
          to: accountDepositors[2].address,
          value: ONE_ETHER,
        });

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(ONE_ETHER);
      });

      it("should transfer tokens and update deposit state - multiple ticks", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[1]).deposit(TICK15, ONE_ETHER, 0);

        /* Transfer */
        await erc20Token10.connect(accountDepositors[1]).transfer(accountDepositors[2].address, ONE_ETHER);
        await erc20Token15.connect(accountDepositors[1]).transfer(accountDepositors[2].address, ONE_ETHER);

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        expect(await erc20Token15.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token15.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(ONE_ETHER);

        const [shares3] = await pool.deposits(accountDepositors[1].address, TICK15);
        expect(shares3).to.equal(ZERO_ETHER);

        const [shares4] = await pool.deposits(accountDepositors[2].address, TICK15);
        expect(shares4).to.equal(ONE_ETHER);
      });

      it("should transfer tokens and update deposit state - multiple depositors", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[2]).deposit(TICK10, ONE_ETHER, 0);

        /* Transfer */
        await erc20Token10.connect(accountDepositors[1]).transfer(accountDepositors[2].address, ONE_ETHER);

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(TWO_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(TWO_ETHER);
      });

      it("reverts when transferring more than balance", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Transfer */
        await expect(
          erc20Token10.connect(accountDepositors[1]).transfer(accountDepositors[2].address, TWO_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "ERC20InsufficientBalance");
      });

      it("reverts when transferring to zero address", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Transfer */
        await expect(erc20Token10.connect(accountDepositors[1]).transfer(ethers.constants.AddressZero, ONE_ETHER))
          .to.be.revertedWithCustomError(erc20Token10, "ERC20InvalidReceiver")
          .withArgs(ethers.constants.AddressZero);
      });
    });

    describe("#allowance", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;
      });

      it("returns zero when queried about zero address", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[0].address, ethers.constants.AddressZero)).to.equal(0);
      });

      it("returns zero when account hasn't approved", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[0].address, accountDepositors[1].address)).to.equal(0);
      });

      it("returns correct amount of tokens", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ONE_ETHER
        );
      });

      it("allowance correctly decrement after transfer", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Transfer */
        await erc20Token10
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ZERO_ETHER
        );
      });

      it("allowance does not decrement after transfer when allowance is infinite", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10
          .connect(accountDepositors[1])
          .approve(accountDepositors[2].address, ethers.constants.MaxUint256);

        /* Transfer */
        await erc20Token10
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ethers.constants.MaxUint256
        );
      });
    });

    describe("#approve", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const depTx15 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;
      });

      it("should approve tokens and update allowance state", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Validate allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ONE_ETHER
        );
      });

      it("should approve tokens and update allowance state - multiple ticks", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[1]).deposit(TICK15, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);
        await erc20Token15.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Validate allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ONE_ETHER
        );
        expect(await erc20Token15.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ONE_ETHER
        );
      });

      it("should approve tokens and update allowance state - multiple depositors", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[2]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Validate allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ONE_ETHER
        );
      });
    });

    describe("#transferFrom", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const depTx15 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;
      });

      it("should transfer tokens and update deposit state", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Transfer */
        const transferTx = await erc20Token10
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Validate events */
        await expectEvent(transferTx, pool, "Transferred", {
          from: accountDepositors[1].address,
          to: accountDepositors[2].address,
          tick: TICK10,
          shares: ONE_ETHER,
        });
        await expectEvent(transferTx, erc20Token10, "Transfer", {
          from: accountDepositors[1].address,
          to: accountDepositors[2].address,
          value: ONE_ETHER,
        });

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(ONE_ETHER);
      });

      it("should transfer tokens and update deposit state - multiple ticks", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[1]).deposit(TICK15, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);
        await erc20Token15.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Transfer */
        await erc20Token10
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        await erc20Token15
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        expect(await erc20Token15.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token15.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(ONE_ETHER);

        const [shares3] = await pool.deposits(accountDepositors[1].address, TICK15);
        expect(shares3).to.equal(ZERO_ETHER);

        const [shares4] = await pool.deposits(accountDepositors[2].address, TICK15);
        expect(shares4).to.equal(ONE_ETHER);
      });

      it("reverts when not approved", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Transfer */
        await expect(
          erc20Token10
            .connect(accountDepositors[2])
            .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "ERC20InsufficientAllowance");
      });

      it("reverts if msg.sender transfersFrom without approval", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Attempt Transfer */
        await expect(
          erc20Token10
            .connect(accountDepositors[1])
            .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "ERC20InsufficientAllowance");
      });

      it("msg.sender can approve self to transferFrom", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, ONE_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[1].address, ONE_ETHER);

        /* Transfer */
        await erc20Token10
          .connect(accountDepositors[1])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Validate token balance */
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[2].address)).to.equal(ONE_ETHER);

        /* Validate pool deposit state */
        const [shares1] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(shares1).to.equal(ZERO_ETHER);

        const [shares2] = await pool.deposits(accountDepositors[2].address, TICK10);
        expect(shares2).to.equal(ONE_ETHER);
      });

      it("reverts when insufficient allowance approved", async function () {
        /* Deposit */
        await pool.connect(accountDepositors[1]).deposit(TICK10, TWO_ETHER, 0);

        /* Approve */
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ONE_ETHER);

        /* Transfer */
        await expect(
          erc20Token10
            .connect(accountDepositors[2])
            .transferFrom(accountDepositors[1].address, accountDepositors[2].address, TWO_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "ERC20InsufficientAllowance");
      });
    });
  });

  /****************************************************************************/
  /* Pool */
  /****************************************************************************/

  describe("Pool", async function () {
    describe("#transfer", async function () {
      it("reverts if caller is EOA", async function () {
        const DEPOSITOR = accountDepositors[0];
        await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, ONE_ETHER);

        await expect(
          pool.connect(DEPOSITOR).transfer(DEPOSITOR.address, accountDepositors[1].address, TICK10, ONE_ETHER)
        ).to.be.revertedWithCustomError(pool, "InvalidCaller");
      });

      it("attempt to transfer using malicious token contract reverts", async function () {
        const DEPOSITOR = accountDepositors[0];

        /* Deposit */
        await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, ONE_ETHER);

        /* Confirm deposit state */
        const [shares] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        const [attackerShares] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(attackerShares).to.equal(ZERO_ETHER);

        /* Attempt Transfer */
        await expect(
          maliciousToken
            .connect(accountDepositors[1])
            .transfer(accountDepositors[1].address, ONE_ETHER.sub(ethers.BigNumber.from("1000000")))
        ).to.be.revertedWithCustomError(pool, "InvalidCaller");

        /* Confirm deposit state */
        const [shares2] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares2).to.equal(ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        const [attackerShares2] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(attackerShares2).to.equal(ZERO_ETHER);
      });

      it("transferee can withdraw transferred shares", async function () {
        const DEPOSITOR = accountDepositors[0];

        /* Deposit */
        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        /* Confirm deposit state */
        const [shares] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        const [transfereeShares] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares).to.equal(ZERO_ETHER);

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(
          ONE_ETHER.sub(ethers.BigNumber.from("1000000"))
        );
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);

        /* Transfer */
        await erc20Token10
          .connect(DEPOSITOR)
          .transfer(accountDepositors[1].address, ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(
          ONE_ETHER.sub(ethers.BigNumber.from("1000000"))
        );

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);

        /* Confirm deposit state */
        const [shares2] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares2).to.equal(ZERO_ETHER);

        const [transfereeShares2] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares2).to.equal(ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        /* Redeem */
        await pool.connect(accountDepositors[1]).redeem(TICK10, ONE_ETHER.sub(ethers.BigNumber.from("1000000")));

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(ethers.BigNumber.from("1000000"));

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);

        /* Confirm deposit state */
        const [shares3] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares3).to.equal(ZERO_ETHER);

        const [transfereeShares3] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares3).to.equal(ZERO_ETHER);

        /* Withdraw */
        const withdrawTx = await pool.connect(accountDepositors[1]).withdraw(TICK10, 0);
        const withdrawAmt = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;

        expect(withdrawAmt).to.equal(ONE_ETHER.sub(ethers.BigNumber.from("1000000")));
      });
    });

    describe("#deposit", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;

      beforeEach("deposit into new ticks", async () => {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;
      });

      it("successfully deposits and mints ERC-20 tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        const depositTx = await pool.connect(DEPOSITOR).deposit(TICK10, ONE_ETHER, 0);

        /* Validate events */
        await expectEvent(depositTx, pool, "Deposited", {
          account: DEPOSITOR.address,
          tick: TICK10,
          amount: ONE_ETHER,
          shares: ONE_ETHER,
        });

        await expectEvent(depositTx, tok1, "Transfer", {
          from: DEPOSITOR.address,
          to: pool.address,
          value: ONE_ETHER,
        });

        await expectEvent(depositTx, erc20Token10, "Transfer", {
          from: ethers.constants.AddressZero,
          to: DEPOSITOR.address,
          value: ONE_ETHER,
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ONE_ETHER);
        expect(redemptionId).to.equal(ethers.constants.Zero);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ONE_ETHER);

        /* Validate redemption state */
        const redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(ethers.constants.Zero);
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);

        /* Validate token balance */
        expect(await tok1.balanceOf(DEPOSITOR.address)).to.equal(ethers.utils.parseEther("999"));
      });

      it("successfully deposits additional and mints additional tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        /* Deposit 1 */
        await pool.connect(DEPOSITOR).deposit(TICK10, ONE_ETHER, 0);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ONE_ETHER);

        /* Deposit 2 */
        await pool.connect(DEPOSITOR).deposit(TICK10, TWO_ETHER, 0);

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(FixedPoint.from("3"));
        expect(redemptionId).to.equal(ethers.constants.Zero);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(FixedPoint.from("3"));

        /* Validate redemption state */
        const redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(ethers.constants.Zero);
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);

        /* Validate token balance */
        expect(await tok1.balanceOf(DEPOSITOR.address)).to.equal(ethers.utils.parseEther("997"));
      });
    });

    describe("#redeem", async function () {
      it("successfully redeems entire deposit from available cash, burns token", async function () {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const DEPOSITOR = accountDepositors[1];

        /* Deposit 1 ETH */
        await pool.connect(DEPOSITOR).deposit(TICK10, ONE_ETHER, 0);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ONE_ETHER);

        /* Redeem 1 shares */
        const redeemTx = await pool.connect(DEPOSITOR).redeem(TICK10, ONE_ETHER);

        /* Validate events */
        await expectEvent(redeemTx, pool, "Redeemed", {
          account: DEPOSITOR.address,
          tick: TICK10,
          redemptionId: 0,
          shares: ONE_ETHER,
        });

        await expectEvent(redeemTx, erc20Token10, "Transfer", {
          from: DEPOSITOR.address,
          to: ethers.constants.AddressZero,
          value: ONE_ETHER,
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ethers.constants.Zero);
        expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);

        /* Validate redemption state */
        const redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(ONE_ETHER);
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);
      });

      it("successfully redeems partial deposit from available cash, burns correct amount of tokens", async function () {
        const depTx10 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const DEPOSITOR = accountDepositors[1];

        /* Deposit 1 ETH */
        await pool.connect(DEPOSITOR).deposit(TICK10, ONE_ETHER, 0);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ONE_ETHER);

        /* Redeem 0.5 shares */
        const redeemTx = await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("0.5"));

        /* Validate events */
        await expectEvent(redeemTx, pool, "Redeemed", {
          account: DEPOSITOR.address,
          tick: TICK10,
          redemptionId: 0,
          shares: FixedPoint.from("0.5"),
        });

        await expectEvent(redeemTx, erc20Token10, "Transfer", {
          from: DEPOSITOR.address,
          to: ethers.constants.AddressZero,
          value: FixedPoint.from("0.5"),
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(FixedPoint.from("0.5"));
        expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(FixedPoint.from("0.5"));

        /* Validate redemption state */
        const redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);
      });

      it("successfully schedules redemption, burns tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        /* Deposit */
        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, FixedPoint.from("10"));
        const depTx15 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK15, FixedPoint.from("10"));

        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        const erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"))
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("10"));

        expect(await erc20Token15.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"))
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("10"));

        /* Create loan */
        await createActiveLoan(FixedPoint.from("15"));

        /* Redeem 5 shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("5"));

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(FixedPoint.from("10").sub(ethers.BigNumber.from("1000000")).sub(FixedPoint.from("5")));
        expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000")).sub(FixedPoint.from("5"))
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("5"));
        expect(await erc20Token15.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"))
        );

        /* Validate redemption state */
        const redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(FixedPoint.from("5"));
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);

        /* Validate tick state */
        const node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(FixedPoint.from("10"));
        expect(node.available).to.equal(ethers.constants.Zero);
        expect(node.redemptions).to.equal(FixedPoint.from("5"));
      });

      it("successfully schedules multiple redemptions, properly burns tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        /* Deposit */
        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, FixedPoint.from("10"));
        const depTx15 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK15, FixedPoint.from("10"));

        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const tokenInstance15 = (await extractEvent(depTx15, pool, "TokenCreated")).args.instance;
        const erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;

        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"))
        );
        expect(await erc20Token15.balanceOf(DEPOSITOR.address)).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"))
        );

        /* Create loan */
        await createActiveLoan(FixedPoint.from("15"));

        /* Redeem 5 shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("5"));
        /* Redeem remaining shares */
        await pool
          .connect(DEPOSITOR)
          .redeem(TICK10, FixedPoint.from("10").sub(ethers.BigNumber.from("1000000")).sub(FixedPoint.from("5")));

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ZERO_ETHER);
        expect(redemptionId).to.equal(ethers.BigNumber.from("2"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);

        /* Validate redemption state */
        const redemption1 = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption1.pending).to.equal(FixedPoint.from("5"));
        expect(redemption1.index).to.equal(ethers.constants.Zero);
        expect(redemption1.target).to.equal(ethers.constants.Zero);

        /* Validate redemption state */
        const redemption2 = await pool.redemptions(DEPOSITOR.address, TICK10, 1);
        expect(redemption2.pending).to.equal(
          FixedPoint.from("10").sub(ethers.BigNumber.from("1000000")).sub(FixedPoint.from("5"))
        );
        expect(redemption2.index).to.equal(ethers.constants.Zero);
        expect(redemption2.target).to.equal(FixedPoint.from("5"));

        /* Validate tick state */
        const node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(FixedPoint.from("10"));
        expect(node.available).to.equal(ethers.constants.Zero);
        expect(node.redemptions).to.equal(FixedPoint.from("10").sub(ethers.BigNumber.from("1000000")));
      });
    });

    describe("#rebalance", async function () {
      it("rebalances a full redemption into another tick, properly burns and mints tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        /* Deposit 1 ETH */
        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, ONE_ETHER);
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const sharesMinted = ONE_ETHER.sub(ethers.BigNumber.from("1000000"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(sharesMinted);

        /* Redeem all shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, sharesMinted);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);

        /* Rebalances to 15 ETH tick */
        const rebalanceTx = await pool
          .connect(DEPOSITOR)
          .multicall([
            pool.interface.encodeFunctionData("rebalance", [TICK10, TICK15, 0, 0]),
            pool.interface.encodeFunctionData("tokenize", [TICK15]),
          ]);

        const tokenInstance15 = (await extractEvent(rebalanceTx, pool, "TokenCreated")).args.instance;
        const erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;

        const sharesMinted2 = (await pool.deposits(DEPOSITOR.address, Tick.encode("15"))).shares;

        /* Validate events */
        await expectEvent(rebalanceTx, pool, "Withdrawn", {
          account: DEPOSITOR.address,
          tick: TICK10,
          redemptionId: 0,
          shares: sharesMinted,
          amount: sharesMinted,
        });

        await expectEvent(rebalanceTx, pool, "Deposited", {
          account: DEPOSITOR.address,
          tick: TICK15,
          amount: sharesMinted,
          shares: sharesMinted2,
        });

        // TODO: "no matching event"
        // await expectEvent(rebalanceTx, erc20Token15, "Transfer", {
        //   from: ethers.constants.AddressZero,
        //   to: DEPOSITOR.address,
        //   value: ONE_ETHER,
        // });

        /* Validate deposit state */
        let [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ethers.constants.Zero);
        expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

        [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK15);
        expect(shares).to.equal(sharesMinted2);
        expect(redemptionId).to.equal(ethers.constants.Zero);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(ZERO_ETHER);
        expect(await erc20Token15.balanceOf(DEPOSITOR.address)).to.equal(sharesMinted2);

        /* Validate redemption state */
        let redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.equal(ethers.constants.Zero);
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);

        redemption = await pool.redemptions(DEPOSITOR.address, TICK15, 0);
        expect(redemption.pending).to.equal(ethers.constants.Zero);
        expect(redemption.index).to.equal(ethers.constants.Zero);
        expect(redemption.target).to.equal(ethers.constants.Zero);

        /* Validate tick state */
        let node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(ONE_ETHER.sub(sharesMinted));
        expect(node.available).to.equal(ONE_ETHER.sub(sharesMinted));
        expect(node.redemptions).to.equal(ethers.constants.Zero);

        node = await pool.liquidityNode(TICK15);
        expect(node.value).to.equal(sharesMinted);
        expect(node.available).to.equal(sharesMinted);
        expect(node.redemptions).to.equal(ethers.constants.Zero);
      });

      it("rebalances a partial redemption into another tick, properly burns and mint tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, FixedPoint.from("10"));
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const sharesMinted = FixedPoint.from("10").sub(ethers.BigNumber.from("1000000"));

        /* Create loan 1 */
        const [loanReceipt1] = await createActiveLoan(FixedPoint.from("5"));

        /* Create loan 2 */
        await createActiveLoan(FixedPoint.from("5"));

        /* Redeem all shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, sharesMinted);

        /* Repay loan 1 */
        await pool.connect(accountBorrower).repay(loanReceipt1);

        /* Rebalance */
        const rebalanceTx = await pool
          .connect(DEPOSITOR)
          .multicall([
            pool.interface.encodeFunctionData("rebalance", [TICK10, TICK15, 0, 0]),
            pool.interface.encodeFunctionData("tokenize", [TICK15]),
          ]);

        /* Get new token instance */
        const tokenInstance15 = (await extractEvent(rebalanceTx, pool, "TokenCreated")).args.instance;
        const erc20Token15 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance15
        )) as ERC20DepositTokenImplementation;

        /* Validate events */
        await expectEvent(rebalanceTx, pool, "Withdrawn", {
          account: DEPOSITOR.address,
          tick: TICK10,
          redemptionId: 0,
        });

        await expectEvent(rebalanceTx, pool, "Deposited", {
          account: DEPOSITOR.address,
          tick: TICK15,
        });

        /* Validate deposit state */
        let [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK10);
        expect(shares).to.equal(ethers.constants.Zero);
        expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

        [shares, redemptionId] = await pool.deposits(DEPOSITOR.address, TICK15);
        expect(shares).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(redemptionId).to.equal(ethers.constants.Zero);

        /* Validate token state */
        expect(await erc20Token15.balanceOf(DEPOSITOR.address)).to.be.closeTo(
          FixedPoint.from("5.0"),
          FixedPoint.from("0.01")
        );

        expect(await erc20Token10.balanceOf(DEPOSITOR.address)).to.equal(0);

        /* Validate redemption state */
        let redemption = await pool.redemptions(DEPOSITOR.address, TICK10, 0);
        expect(redemption.pending).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

        redemption = await pool.redemptions(DEPOSITOR.address, TICK15, 0);
        expect(redemption.pending).to.equal(ethers.constants.Zero);

        /* Validate tick state */
        let node = await pool.liquidityNode(TICK10);
        expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.available).to.be.closeTo(ethers.constants.Zero, 1);
        expect(node.redemptions).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

        node = await pool.liquidityNode(TICK15);
        expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.available).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.redemptions).to.equal(ethers.constants.Zero);
      });
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = ethers.BigNumber.from("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.lt(b) ? a : b);
  const maxBN = (a: ethers.BigNumber, b: ethers.BigNumber) => (a.gt(b) ? a : b);

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

    const repayment = await pool.quote(principal, duration, nft1.address, tokenId, ticks, "0x");

    const borrowTx = await pool
      .connect(accountBorrower)
      .borrow(principal, duration, nft1.address, tokenId, repayment, ticks, "0x");
    const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;
    const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
    return [loanReceipt, loanReceiptHash];
  }

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(pool.interface.getSighash("supportsInterface"))).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await pool.supportsInterface("0x00000000")).to.equal(false);
        expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
