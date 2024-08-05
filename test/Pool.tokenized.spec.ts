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
  const TICKLTV1000 = Tick.encode(BigInt("1000"), 0, 0, 18, 1);
  const TICKLTV1511 = Tick.encode(BigInt("1511"), 0, 0, 18, 1);
  const TICKLTV2220 = Tick.encode(BigInt("2220"), 0, 0, 18, 1);

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
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.parseEther("10000"))) as TestERC20;
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
    pool = (await ethers.getContractAt(
      "WeightedRateCollectionPool",
      await proxy.getAddress()
    )) as WeightedRateCollectionPool;

    /* Deploy malicious token */
    maliciousToken = (await maliciousTokenFactory.deploy(await pool.getAddress(), TICK10)) as TestMaliciousERC20;

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
  /* Helpers */
  /****************************************************************************/

  function hexConcat(hexStrings: string[]) {
    // Ensure all inputs are strings
    if (!Array.isArray(hexStrings)) {
      throw new TypeError("Input must be an array of hex strings.");
    }

    // Remove the '0x' prefix and concatenate
    const concatenated = hexStrings
      .map((hex) => {
        if (typeof hex !== "string") {
          throw new TypeError("Each element must be a hex string.");
        }

        // Validate the hex string format
        if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
          throw new Error(`Invalid hex string: ${hex}`);
        }

        // Remove '0x' prefix
        return hex.slice(2);
      })
      .join("");

    // Return the concatenated result with '0x' prefix
    return "0x" + concatenated;
  }

  /****************************************************************************/
  /* ERC20 Token */
  /****************************************************************************/

  const _tickToBytes = (tick: bigint) => {
    return ethers.zeroPadValue(ethers.getBytes(ethers.toBeHex(tick)), 32);
  };

  const _computeDeterministicAddress = async (tick: bigint) => {
    const ABI = ["function initialize(bytes)"];
    const iface = new ethers.Interface(ABI);

    const initData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [await pool.getAddress(), iface.encodeFunctionData("initialize", [_tickToBytes(tick)])]
    );

    const beaconProxyBytecode = (await ethers.getContractFactory("ERC20DepositTokenProxy")).bytecode;
    const creationCode = hexConcat([beaconProxyBytecode, initData]);

    return ethers.getCreate2Address(await pool.getAddress(), _tickToBytes(tick), ethers.keccak256(creationCode));
  };

  const _depositAndTokenizeMulticall = async (depositor: SignerWithAddress, tick: bigint, amount: FixedPoint) => {
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
        expect(await erc20DepositTokenImpl.getAddress()).to.equal(await pool.getERC20DepositTokenImplementation());
      });
    });

    describe("#tokenize", async function () {
      it("can tokenize after deposit", async function () {
        /* Deposit */
        const sharesMinted = await pool.connect(accountDepositors[0]).deposit.staticCall(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);
        const amount = ((await pool.liquidityNode(TICK10)).value * sharesMinted) / FixedPoint.from("1");

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
          implementation: await erc20DepositTokenImpl.getAddress(),
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
        const sharesMinted1 = await pool.connect(accountDepositors[0]).deposit.staticCall(TICK10, ONE_ETHER, 0);
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);
        const amount = ((await pool.liquidityNode(TICK10)).value * sharesMinted1) / FixedPoint.from("1");

        const sharesMinted2 = await pool.connect(accountDepositors[1]).deposit.staticCall(TICK10, ONE_ETHER, 0);
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
          implementation: await erc20DepositTokenImpl.getAddress(),
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(await erc20DepositTokenImpl.getAddress());
      });

      it("second deposit succeeds", async function () {
        /* Deposit */
        const depTx = await _depositAndTokenizeMulticall(accountDepositors[0], TICK10, ONE_ETHER);
        const tokenInstance = (await extractEvent(depTx, pool, "TokenCreated")).args.instance;
        const tokenImplementation = (await extractEvent(depTx, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress = await _computeDeterministicAddress(TICK10);

        expectEvent(depTx, pool, "TokenCreated", {
          instance: predictedDeterministicAddress,
          implementation: await erc20DepositTokenImpl.getAddress(),
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(await erc20DepositTokenImpl.getAddress());

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
          implementation: await erc20DepositTokenImpl.getAddress(),
          tick: TICK10,
        });

        expect(tokenInstance).to.equal(predictedDeterministicAddress);
        expect(tokenImplementation).to.equal(await erc20DepositTokenImpl.getAddress());

        /* Deposit TICK15 */
        const depTx2 = await _depositAndTokenizeMulticall(accountDepositors[0], TICK15, ONE_ETHER);
        const tokenInstance2 = (await extractEvent(depTx2, pool, "TokenCreated")).args.instance;
        const tokenImplementation2 = (await extractEvent(depTx2, pool, "TokenCreated")).args.implementation;

        const predictedDeterministicAddress2 = await _computeDeterministicAddress(TICK15);

        expectEvent(depTx2, pool, "TokenCreated", {
          instance: predictedDeterministicAddress2,
          implementation: await erc20DepositTokenImpl.getAddress(),
          tick: TICK15,
        });

        expect(tokenInstance2).to.equal(predictedDeterministicAddress2);
        expect(tokenImplementation2).to.equal(await erc20DepositTokenImpl.getAddress());
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
        expect(await erc20Token10.pool()).to.equal(await pool.getAddress());
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
        expect(await erc20Token10.currencyToken()).to.equal(await tok1.getAddress());
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
        const shares = await pool.connect(accountDepositors[1]).deposit.staticCall(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = (ONE_ETHER * FixedPoint.from("1")) / shares;

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
        const shares = await pool.connect(accountDepositors[1]).deposit.staticCall(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = (ONE_ETHER * FixedPoint.from("1")) / shares;

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
        const shares = await pool.connect(accountDepositors[1]).deposit.staticCall(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = (ONE_ETHER * FixedPoint.from("1")) / shares;

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
        const shares = await pool.connect(accountDepositors[1]).deposit.staticCall(TICK10, ONE_ETHER, 0);

        /* Get actual deposit price */
        const actualDepositPrice = (ONE_ETHER * FixedPoint.from("1")) / shares;

        expect(expectedDepositPrice).to.equal(actualDepositPrice);
      });
    });

    describe("#redemptionSharePrice", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let sharesMinted: bigint;

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
        const actualRedemptionPrice = (ONE_ETHER * FixedPoint.from("1")) / FixedPoint.from("1");

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
        const [shares, amount] = await pool.connect(accountDepositors[0]).withdraw.staticCall(TICK10, redemptionId);

        /* Get actual redemption price */
        const actualRedemptionPrice = (amount * FixedPoint.from("1")) / shares;

        expect(expectedRedemptionPrice).to.closeTo(actualRedemptionPrice, BigInt("2"));
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
            .onExternalTransfer(ethers.ZeroAddress, ethers.ZeroAddress, ONE_ETHER)
        ).to.be.revertedWithCustomError(erc20Token10, "InvalidCaller");
      });
    });

    describe("#totalSupply", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;
      let sharesMinted: bigint;

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
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER - sharesMinted);
      });

      it("returns correct amount of tokens - after redeem multiple times", async function () {
        await pool.connect(accountDepositors[0]).deposit(TICK10, ONE_ETHER, 0);

        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted);

        const sharesMinted2 = (await pool.deposits(accountDepositors[0].address, TICK10)).shares;
        await pool.connect(accountDepositors[0]).redeem(TICK10, sharesMinted2);

        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER * 2n - sharesMinted - sharesMinted2);
      });
    });

    describe("#balanceOf", async function () {
      let erc20Token10: ERC20DepositTokenImplementation;
      let erc20Token15: ERC20DepositTokenImplementation;
      let sharesMinted10: bigint;
      let sharesMinted15: bigint;

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
        await expect(erc20Token10.connect(accountDepositors[1]).transfer(ethers.ZeroAddress, ONE_ETHER))
          .to.be.revertedWithCustomError(erc20Token10, "ERC20InvalidReceiver")
          .withArgs(ethers.ZeroAddress);
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
        expect(await erc20Token10.allowance(accountDepositors[0].address, ethers.ZeroAddress)).to.equal(0);
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
        await erc20Token10.connect(accountDepositors[1]).approve(accountDepositors[2].address, ethers.MaxUint256);

        /* Transfer */
        await erc20Token10
          .connect(accountDepositors[2])
          .transferFrom(accountDepositors[1].address, accountDepositors[2].address, ONE_ETHER);

        /* Call allowance */
        expect(await erc20Token10.allowance(accountDepositors[1].address, accountDepositors[2].address)).to.equal(
          ethers.MaxUint256
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
          pool
            .connect(DEPOSITOR)
            .transfer(await DEPOSITOR.getAddress(), accountDepositors[1].address, TICK10, ONE_ETHER)
        ).to.be.revertedWithCustomError(pool, "InvalidCaller");
      });

      it("attempt to transfer using malicious token contract reverts", async function () {
        const DEPOSITOR = accountDepositors[0];

        /* Deposit */
        await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, ONE_ETHER);

        /* Confirm deposit state */
        const [shares] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(ONE_ETHER - BigInt("1000000"));

        const [attackerShares] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(attackerShares).to.equal(ZERO_ETHER);

        /* Attempt Transfer */
        await expect(
          maliciousToken
            .connect(accountDepositors[1])
            .transfer(accountDepositors[1].address, ONE_ETHER - BigInt("1000000"))
        ).to.be.revertedWithCustomError(pool, "InvalidCaller");

        /* Confirm deposit state */
        const [shares2] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares2).to.equal(ONE_ETHER - BigInt("1000000"));

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
        const [shares] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(ONE_ETHER - BigInt("1000000"));

        const [transfereeShares] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares).to.equal(ZERO_ETHER);

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ONE_ETHER - BigInt("1000000"));
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);

        /* Transfer */
        await erc20Token10.connect(DEPOSITOR).transfer(accountDepositors[1].address, ONE_ETHER - BigInt("1000000"));

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ONE_ETHER - BigInt("1000000"));

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(ONE_ETHER);

        /* Confirm deposit state */
        const [shares2] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares2).to.equal(ZERO_ETHER);

        const [transfereeShares2] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares2).to.equal(ONE_ETHER - BigInt("1000000"));

        /* Redeem */
        await pool.connect(accountDepositors[1]).redeem(TICK10, ONE_ETHER - BigInt("1000000"));

        /* Confirm total supply */
        expect(await erc20Token10.totalSupply()).to.equal(BigInt("1000000"));

        /* Confirm balance */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);
        expect(await erc20Token10.balanceOf(accountDepositors[1].address)).to.equal(ZERO_ETHER);

        /* Confirm deposit state */
        const [shares3] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares3).to.equal(ZERO_ETHER);

        const [transfereeShares3] = await pool.deposits(accountDepositors[1].address, TICK10);
        expect(transfereeShares3).to.equal(ZERO_ETHER);

        /* Withdraw */
        const withdrawTx = await pool.connect(accountDepositors[1]).withdraw(TICK10, 0);
        const withdrawAmt = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;

        expect(withdrawAmt).to.equal(ONE_ETHER - BigInt("1000000"));
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
          account: await DEPOSITOR.getAddress(),
          tick: TICK10,
          amount: ONE_ETHER,
          shares: ONE_ETHER,
        });

        await expectEvent(depositTx, tok1, "Transfer", {
          from: await DEPOSITOR.getAddress(),
          to: await pool.getAddress(),
          value: ONE_ETHER,
        });

        await expectEvent(depositTx, erc20Token10, "Transfer", {
          from: ethers.ZeroAddress,
          to: await DEPOSITOR.getAddress(),
          value: ONE_ETHER,
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(ONE_ETHER);
        expect(redemptionId).to.equal(0n);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ONE_ETHER);

        /* Validate redemption state */
        const redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(0n);
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);

        /* Validate token balance */
        expect(await tok1.balanceOf(await DEPOSITOR.getAddress())).to.equal(ethers.parseEther("999"));
      });

      it("successfully deposits additional and mints additional tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        /* Deposit 1 */
        await pool.connect(DEPOSITOR).deposit(TICK10, ONE_ETHER, 0);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ONE_ETHER);

        /* Deposit 2 */
        await pool.connect(DEPOSITOR).deposit(TICK10, TWO_ETHER, 0);

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(FixedPoint.from("3"));
        expect(redemptionId).to.equal(0n);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(FixedPoint.from("3"));

        /* Validate redemption state */
        const redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(0n);
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);

        /* Validate token balance */
        expect(await tok1.balanceOf(await DEPOSITOR.getAddress())).to.equal(ethers.parseEther("997"));
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
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ONE_ETHER);

        /* Redeem 1 shares */
        const redeemTx = await pool.connect(DEPOSITOR).redeem(TICK10, ONE_ETHER);

        /* Validate events */
        await expectEvent(redeemTx, pool, "Redeemed", {
          account: await DEPOSITOR.getAddress(),
          tick: TICK10,
          redemptionId: 0,
          shares: ONE_ETHER,
        });

        await expectEvent(redeemTx, erc20Token10, "Transfer", {
          from: await DEPOSITOR.getAddress(),
          to: ethers.ZeroAddress,
          value: ONE_ETHER,
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(0n);
        expect(redemptionId).to.equal(BigInt("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);

        /* Validate redemption state */
        const redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(ONE_ETHER);
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);
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
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ONE_ETHER);

        /* Redeem 0.5 shares */
        const redeemTx = await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("0.5"));

        /* Validate events */
        await expectEvent(redeemTx, pool, "Redeemed", {
          account: await DEPOSITOR.getAddress(),
          tick: TICK10,
          redemptionId: 0,
          shares: FixedPoint.from("0.5"),
        });

        await expectEvent(redeemTx, erc20Token10, "Transfer", {
          from: await DEPOSITOR.getAddress(),
          to: ethers.ZeroAddress,
          value: FixedPoint.from("0.5"),
        });

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(FixedPoint.from("0.5"));
        expect(redemptionId).to.equal(BigInt("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(FixedPoint.from("0.5"));

        /* Validate redemption state */
        const redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);
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
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000")
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("10"));

        expect(await erc20Token15.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000")
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("10"));

        /* Create loan */
        await createActiveLoan(FixedPoint.from("15"));

        /* Redeem 5 shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("5"));

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(FixedPoint.from("10") - BigInt("1000000") - FixedPoint.from("5"));
        expect(redemptionId).to.equal(BigInt("1"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000") - FixedPoint.from("5")
        );
        expect(await erc20Token10.totalSupply()).to.equal(FixedPoint.from("5"));
        expect(await erc20Token15.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000")
        );

        /* Validate redemption state */
        const redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(FixedPoint.from("5"));
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);

        /* Validate tick state */
        const node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(FixedPoint.from("10"));
        expect(node.available).to.equal(0n);
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

        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000")
        );
        expect(await erc20Token15.balanceOf(await DEPOSITOR.getAddress())).to.equal(
          FixedPoint.from("10") - BigInt("1000000")
        );

        /* Create loan */
        await createActiveLoan(FixedPoint.from("15"));

        /* Redeem 5 shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("5"));
        /* Redeem remaining shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, FixedPoint.from("10") - BigInt("1000000") - FixedPoint.from("5"));

        /* Validate deposit state */
        const [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(ZERO_ETHER);
        expect(redemptionId).to.equal(BigInt("2"));

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);

        /* Validate redemption state */
        const redemption1 = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption1.pending).to.equal(FixedPoint.from("5"));
        expect(redemption1.index).to.equal(0n);
        expect(redemption1.target).to.equal(0n);

        /* Validate redemption state */
        const redemption2 = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 1);
        expect(redemption2.pending).to.equal(FixedPoint.from("10") - BigInt("1000000") - FixedPoint.from("5"));
        expect(redemption2.index).to.equal(0n);
        expect(redemption2.target).to.equal(FixedPoint.from("5"));

        /* Validate tick state */
        const node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(FixedPoint.from("10"));
        expect(node.available).to.equal(0n);
        expect(node.redemptions).to.equal(FixedPoint.from("10") - BigInt("1000000"));
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

        const sharesMinted = ONE_ETHER - BigInt("1000000");

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(sharesMinted);

        /* Redeem all shares */
        await pool.connect(DEPOSITOR).redeem(TICK10, sharesMinted);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);

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

        const sharesMinted2 = (await pool.deposits(await DEPOSITOR.getAddress(), Tick.encode("15"))).shares;

        /* Validate events */
        await expectEvent(rebalanceTx, pool, "Withdrawn", {
          account: await DEPOSITOR.getAddress(),
          tick: TICK10,
          redemptionId: 0,
          shares: sharesMinted,
          amount: sharesMinted,
        });

        await expectEvent(rebalanceTx, pool, "Deposited", {
          account: await DEPOSITOR.getAddress(),
          tick: TICK15,
          amount: sharesMinted,
          shares: sharesMinted2,
        });

        // TODO: "no matching event"
        // await expectEvent(rebalanceTx, erc20Token15, "Transfer", {
        //   from: ethers.ZeroAddress,
        //   to: await DEPOSITOR.getAddress(),
        //   value: ONE_ETHER,
        // });

        /* Validate deposit state */
        let [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(0n);
        expect(redemptionId).to.equal(BigInt("1"));

        [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK15);
        expect(shares).to.equal(sharesMinted2);
        expect(redemptionId).to.equal(0n);

        /* Validate token state */
        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(ZERO_ETHER);
        expect(await erc20Token15.balanceOf(await DEPOSITOR.getAddress())).to.equal(sharesMinted2);

        /* Validate redemption state */
        let redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.equal(0n);
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);

        redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK15, 0);
        expect(redemption.pending).to.equal(0n);
        expect(redemption.index).to.equal(0n);
        expect(redemption.target).to.equal(0n);

        /* Validate tick state */
        let node = await pool.liquidityNode(TICK10);
        expect(node.value).to.equal(ONE_ETHER - sharesMinted);
        expect(node.available).to.equal(ONE_ETHER - sharesMinted);
        expect(node.redemptions).to.equal(0n);

        node = await pool.liquidityNode(TICK15);
        expect(node.value).to.equal(sharesMinted);
        expect(node.available).to.equal(sharesMinted);
        expect(node.redemptions).to.equal(0n);
      });

      it("rebalances a partial redemption into another tick, properly burns and mint tokens", async function () {
        const DEPOSITOR = accountDepositors[1];

        const depTx10 = await _depositAndTokenizeMulticall(DEPOSITOR, TICK10, FixedPoint.from("10"));
        const tokenInstance10 = (await extractEvent(depTx10, pool, "TokenCreated")).args.instance;
        const erc20Token10 = (await ethers.getContractAt(
          "ERC20DepositTokenImplementation",
          tokenInstance10
        )) as ERC20DepositTokenImplementation;

        const sharesMinted = FixedPoint.from("10") - BigInt("1000000");

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
          account: await DEPOSITOR.getAddress(),
          tick: TICK10,
          redemptionId: 0,
        });

        await expectEvent(rebalanceTx, pool, "Deposited", {
          account: await DEPOSITOR.getAddress(),
          tick: TICK15,
        });

        /* Validate deposit state */
        let [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK10);
        expect(shares).to.equal(0n);
        expect(redemptionId).to.equal(BigInt("1"));

        [shares, redemptionId] = await pool.deposits(await DEPOSITOR.getAddress(), TICK15);
        expect(shares).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(redemptionId).to.equal(0n);

        /* Validate token state */
        expect(await erc20Token15.balanceOf(await DEPOSITOR.getAddress())).to.be.closeTo(
          FixedPoint.from("5.0"),
          FixedPoint.from("0.01")
        );

        expect(await erc20Token10.balanceOf(await DEPOSITOR.getAddress())).to.equal(0);

        /* Validate redemption state */
        let redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK10, 0);
        expect(redemption.pending).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

        redemption = await pool.redemptions(await DEPOSITOR.getAddress(), TICK15, 0);
        expect(redemption.pending).to.equal(0n);

        /* Validate tick state */
        let node = await pool.liquidityNode(TICK10);
        expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.available).to.be.closeTo(0n, 1);
        expect(node.redemptions).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));

        node = await pool.liquidityNode(TICK15);
        expect(node.value).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.available).to.be.closeTo(FixedPoint.from("5.0"), FixedPoint.from("0.01"));
        expect(node.redemptions).to.equal(0n);
      });
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const MaxUint128 = BigInt("0xffffffffffffffffffffffffffffffff");
  const minBN = (a: bigint, b: bigint) => (a < b ? a : b);
  const maxBN = (a: bigint, b: bigint) => (a > b ? a : b);

  async function sourceLiquidity(
    amount: bigint,
    multiplier?: bigint = 1n,
    duration?: number = 0,
    rate?: number = 0
  ): Promise<bigint[]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];

    let taken = 0n;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit === 0n) continue;

      const take = minBN(minBN(limit * multiplier - taken, node.available), amount - taken);
      if (take === 0n) break;

      ticks.push(node.tick);
      taken = taken + take;
    }

    if (taken !== amount) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return ticks;
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

  /****************************************************************************/
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(ethers.id("supportsInterface(bytes4)").substring(0, 10))).to.equal(true);

      it("returns false on unsupported interfaces", async function () {
        expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
        expect(await pool.supportsInterface("0x00000000")).to.equal(false);
        expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
      });
    });
  });
});
