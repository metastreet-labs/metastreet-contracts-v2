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
  TestERC1155Receiver,
} from "../typechain";

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
  let pool: Pool;
  let snapshotId: string;
  let accountDepositors: SignerWithAddress[3];
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;
  let delegationRegistry: TestDelegationRegistry;
  let testERC1155ReceiverPass: TestERC1155Receiver;
  let testERC1155ReceiverFail: TestERC1155Receiver;
  let testERC1155ReceiverFailRevert: TestERC1155Receiver;
  let testERC1155ReceiverNotImplemented: TestERC20;

  before("deploy fixture", async () => {
    const RECEIVER_SINGLE_MAGIC_VALUE = "0xf23a6e61";
    const RECEIVER_BATCH_MAGIC_VALUE = "0xbc197c81";

    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateCollectionPool");
    const testERC1155ReceiverFactory = await ethers.getContractFactory("TestERC1155Receiver");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy test ERC1155 receiver */
    testERC1155ReceiverPass = (await testERC1155ReceiverFactory.deploy(
      RECEIVER_SINGLE_MAGIC_VALUE,
      false,
      RECEIVER_BATCH_MAGIC_VALUE,
      false
    )) as TestERC1155Receiver;
    await testERC1155ReceiverPass.deployed();

    /* Deploy test ERC1155 receiver - fail on bad value */
    testERC1155ReceiverFail = (await testERC1155ReceiverFactory.deploy(
      "0x00c0ffee",
      false,
      "0x00c0ffee",
      false
    )) as TestERC1155Receiver;
    await testERC1155ReceiverFail.deployed();

    /* Deploy test ERC1155 receiver - fail on Revert */
    testERC1155ReceiverFailRevert = (await testERC1155ReceiverFactory.deploy(
      RECEIVER_SINGLE_MAGIC_VALUE,
      true,
      RECEIVER_BATCH_MAGIC_VALUE,
      true
    )) as TestERC1155Receiver;
    await testERC1155ReceiverFailRevert.deployed();

    /* Deploy test ERC1155 receiver - fail on not implemented */
    testERC1155ReceiverNotImplemented = (await testERC20Factory.deploy(
      "Reciever Token Test",
      "RTT",
      18,
      ethers.utils.parseEther("10000")
    )) as TestERC20;
    await testERC1155ReceiverNotImplemented.deployed();

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
  /* Token API */
  /****************************************************************************/

  describe("#balanceOf", async function () {
    it("returns zero when queried about zero address", async function () {
      /* Create valid tick */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Call balanceOf */
      expect(await pool.balanceOf(ethers.constants.AddressZero, Tick.encode("10"))).to.equal(0);
    });

    it("returns zero when accounts haven't deposited", async function () {
      /* Create valid tick */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Call balanceOf */
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(0);
      expect(await pool.balanceOf(accountDepositors[2].address, Tick.encode("10"))).to.equal(0);
    });

    it("returns the correct amount of tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
    });

    it("returns the correct amount of tokens - multiple depositors", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Deposit 2 */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("2"));
    });

    it("returns the correct amount of tokens - multiple depositors, multiple ticks", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Deposit 2 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("2"));
    });
  });

  describe("#balanceOfBatch", async function () {
    it("reverts when input arrays don't match", async function () {
      /* Create valid tick */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Call balanceOf */
      await expect(
        pool.balanceOfBatch([accountDepositors[0].address, accountDepositors[1].address], [Tick.encode("10")])
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidArrayLength")
        .withArgs(1, 2);
    });

    it("returns zero when accounts haven't deposited", async function () {
      /* Create valid tick */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Call balanceOfBatch */
      const res = await pool.balanceOfBatch(
        [accountDepositors[1].address, accountDepositors[2].address],
        [Tick.encode("10"), Tick.encode("10")]
      );

      expect(res[0]).to.equal(0);
      expect(res[1]).to.equal(0);
    });

    it("returns the correct amount of tokens per account", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Call balanceOfBatch */
      const res = await pool.balanceOfBatch(
        [accountDepositors[0].address, accountDepositors[1].address],
        [Tick.encode("10"), Tick.encode("10")]
      );

      expect(res[0]).to.equal(FixedPoint.from("1"));
      expect(res[1]).to.equal(FixedPoint.from("2"));
    });

    it("returns the correct amount of tokens per account when using same address", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Call balanceOfBatch */
      const res = await pool.balanceOfBatch(
        [accountDepositors[0].address, accountDepositors[1].address, accountDepositors[0].address],
        [Tick.encode("10"), Tick.encode("10"), Tick.encode("10")]
      );

      expect(res[0]).to.equal(FixedPoint.from("1"));
      expect(res[1]).to.equal(FixedPoint.from("2"));
      expect(res[2]).to.equal(FixedPoint.from("1"));
    });
  });

  describe("#setApprovalForAll", async function () {
    it("successfully sets approval for all", async function () {
      /* Set approval for all */
      const tx = await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Validate events */
      await expectEvent(tx, pool, "ApprovalForAll", {
        account: accountDepositors[0].address,
        operator: accountDepositors[1].address,
        approved: true,
      });

      /* Validate state */
      expect(await pool.isApprovedForAll(accountDepositors[0].address, accountDepositors[1].address)).to.equal(true);
    });

    it("successfully unsets approval for all", async function () {
      /* Set approval for all */
      const tx = await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Validate events */
      await expectEvent(tx, pool, "ApprovalForAll", {
        account: accountDepositors[0].address,
        operator: accountDepositors[1].address,
        approved: true,
      });

      /* Validate state */
      expect(await pool.isApprovedForAll(accountDepositors[0].address, accountDepositors[1].address)).to.equal(true);

      /* Unset approval for all */
      const unsetTx = await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, false);

      /* Validate events */
      await expectEvent(unsetTx, pool, "ApprovalForAll", {
        account: accountDepositors[0].address,
        operator: accountDepositors[1].address,
        approved: false,
      });

      /* Validate state */
      expect(await pool.isApprovedForAll(accountDepositors[0].address, accountDepositors[1].address)).to.equal(false);
    });

    it("reverts if attempting to approve zero address as an operator", async function () {
      await expect(
        pool.connect(accountDepositors[0]).setApprovalForAll(ethers.constants.AddressZero, accountDepositors[0].address)
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidOperator")
        .withArgs(ethers.constants.AddressZero);
    });
  });

  describe("#safeTransferFrom", async function () {
    it("successfully transfers tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: accountDepositors[1].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("0"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));
    });

    it("successfully transfers tokens back and forth", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Transfer */
      await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Transfer back */
      await pool
        .connect(accountDepositors[1])
        .safeTransferFrom(
          accountDepositors[1].address,
          accountDepositors[0].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("0"));
    });

    it("successfully transfers tokens - multiple deposits, multiple ticks", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Deposit 2 */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: accountDepositors[1].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("15"))).to.equal(FixedPoint.from("2"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("0"));

      const [shares1a] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1a).to.equal(FixedPoint.from("1"));

      const [shares1b] = await pool.deposits(accountDepositors[1].address, Tick.encode("15"));
      expect(shares1b).to.equal(FixedPoint.from("2"));
    });

    it("successfully transfers tokens - multiple deposits", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      /* Deposit 2 */
      await pool.connect(accountDepositors[1]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: accountDepositors[1].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("3"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("0"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("3"));
    });

    it("successfully transfers partial token balance", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: accountDepositors[1].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));
    });

    it("successfully transfers tokens when called by operator", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Set approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[1])
        .safeTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[1].address,
        from: accountDepositors[0].address,
        to: accountDepositors[1].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));
    });

    it("reverts when operator not approved", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[1])
          .safeTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155MissingApprovalForAll")
        .withArgs(accountDepositors[1].address, accountDepositors[0].address);
    });

    it("reverts after unsetting approval for all", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Set approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Unset approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, false);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[1])
          .safeTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155MissingApprovalForAll")
        .withArgs(accountDepositors[1].address, accountDepositors[0].address);
    });

    it("reverts when transferring more than balance", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      await expect(
        pool
          .connect(accountDepositors[0])
          .safeTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            Tick.encode("10"),
            FixedPoint.from("2"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InsufficientBalance")
        .withArgs(accountDepositors[0].address, FixedPoint.from("1"), FixedPoint.from("2"), Tick.encode("10"));
    });

    it("reverts when transferring to zero address", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      await expect(
        pool
          .connect(accountDepositors[0])
          .safeTransferFrom(
            accountDepositors[0].address,
            ethers.constants.AddressZero,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(ethers.constants.AddressZero);
    });
  });

  describe("#safeTransferFrom - ERC1155Receiver", async function () {
    it("successfully transfers tokens to smart contract that implements ERC1155Receiver", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      const tx = await pool
        .connect(accountDepositors[0])
        .safeTransferFrom(
          accountDepositors[0].address,
          testERC1155ReceiverPass.address,
          Tick.encode("10"),
          FixedPoint.from("1"),
          "0x"
        );

      /* Validate events */
      await expectEvent(tx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: testERC1155ReceiverPass.address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(testERC1155ReceiverPass.address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(testERC1155ReceiverPass.address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));

      /* Confirm onERC1155Received called */
      expect(await testERC1155ReceiverPass.wasOnERC1155ReceivedCalled()).to.equal(true);
    });

    it("reverts when transferring to smart contract with ERC1155Receiver function that returns incorrect value", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverFail.address,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(testERC1155ReceiverFail.address);
    });

    it("reverts when transferring to smart contract with ERC1155Receiver function that reverts", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverFailRevert.address,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      ).to.be.revertedWith("TestERC1155Receiver: reverting on receive");

      expect(await testERC1155ReceiverPass.wasOnERC1155ReceivedCalled()).to.equal(false);
    });

    it("reverts when transferring to smart contract that does not implement ERC1155Receiver", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverNotImplemented.address,
            Tick.encode("10"),
            FixedPoint.from("1"),
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(testERC1155ReceiverNotImplemented.address);
    });
  });

  describe("#safeBatchTransferFrom", async function () {
    it("successfully transfers tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await pool
        .connect(accountDepositors[0])
        .safeBatchTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          [Tick.encode("10"), Tick.encode("15")],
          [FixedPoint.from("1"), FixedPoint.from("2")],
          "0x"
        );

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("0"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("15"))).to.equal(FixedPoint.from("2"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("0"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));

      const [shares2] = await pool.deposits(accountDepositors[0].address, Tick.encode("15"));
      expect(shares2).to.equal(FixedPoint.from("0"));

      const [shares3] = await pool.deposits(accountDepositors[1].address, Tick.encode("15"));
      expect(shares3).to.equal(FixedPoint.from("2"));
    });

    it("successfully batch transfers tokens when called by operator", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Set approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Transfer */
      await pool
        .connect(accountDepositors[1])
        .safeBatchTransferFrom(
          accountDepositors[0].address,
          accountDepositors[1].address,
          [Tick.encode("10"), Tick.encode("15")],
          [FixedPoint.from("1"), FixedPoint.from("1")],
          "0x"
        );

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(accountDepositors[1].address, Tick.encode("15"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(accountDepositors[1].address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));

      const [shares0b] = await pool.deposits(accountDepositors[0].address, Tick.encode("15"));
      expect(shares0b).to.equal(FixedPoint.from("1"));

      const [shares1b] = await pool.deposits(accountDepositors[1].address, Tick.encode("15"));
      expect(shares1b).to.equal(FixedPoint.from("1"));
    });

    it("reverts when operator not approved - batch", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[1])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("1")],
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155MissingApprovalForAll")
        .withArgs(accountDepositors[1].address, accountDepositors[0].address);
    });

    it("reverts after unsetting approval for all - batch", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Set approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, true);

      /* Unset approval for all */
      await pool.connect(accountDepositors[0]).setApprovalForAll(accountDepositors[1].address, false);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[1])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("1")],
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155MissingApprovalForAll")
        .withArgs(accountDepositors[1].address, accountDepositors[0].address);
    });

    it("reverts when transferring more than balance - batch", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      await expect(
        pool
          .connect(accountDepositors[0])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            accountDepositors[1].address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("2"), FixedPoint.from("1")],
            "0x"
          )
      ).to.be.revertedWithCustomError(pool, "ERC1155InsufficientBalance");
    });

    it("reverts when transferring to zero address", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      await expect(
        pool
          .connect(accountDepositors[0])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            ethers.constants.AddressZero,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("2")],
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(ethers.constants.AddressZero);
    });
  });

  describe("#safeBatchTransferFrom - ERC1155Receiver", async function () {
    it("successfully transfers tokens to smart contract that implements ERC1155Receiver - batch", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await pool
        .connect(accountDepositors[0])
        .safeBatchTransferFrom(
          accountDepositors[0].address,
          testERC1155ReceiverPass.address,
          [Tick.encode("10"), Tick.encode("15")],
          [FixedPoint.from("1"), FixedPoint.from("1")],
          "0x"
        );

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));
      expect(await pool.balanceOf(testERC1155ReceiverPass.address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate deposit state */
      const [shares0] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares0).to.equal(FixedPoint.from("1"));

      const [shares1] = await pool.deposits(testERC1155ReceiverPass.address, Tick.encode("10"));
      expect(shares1).to.equal(FixedPoint.from("1"));

      /* Confirm onERC1155Received called */
      expect(await testERC1155ReceiverPass.wasOnERC1155BatchReceivedCalled()).to.equal(true);
    });

    it("reverts when transferring to smart contract with ERC1155Receiver function that returns incorrect value", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverFail.address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("1")],
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(testERC1155ReceiverFail.address);
    });

    it("reverts when transferring to smart contract with ERC1155Receiver function that reverts - batch", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverFailRevert.address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("1")],
            "0x"
          )
      ).to.be.revertedWith("TestERC1155Receiver: reverting on batch receive");

      expect(await testERC1155ReceiverPass.wasOnERC1155ReceivedCalled()).to.equal(false);
    });

    it("reverts when transferring to smart contract that does not implement ERC1155Receiver", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("2"), 0);

      /* Transfer */
      await expect(
        pool
          .connect(accountDepositors[0])
          .safeBatchTransferFrom(
            accountDepositors[0].address,
            testERC1155ReceiverNotImplemented.address,
            [Tick.encode("10"), Tick.encode("15")],
            [FixedPoint.from("1"), FixedPoint.from("1")],
            "0x"
          )
      )
        .to.be.revertedWithCustomError(pool, "ERC1155InvalidReceiver")
        .withArgs(testERC1155ReceiverNotImplemented.address);
    });
  });

  /****************************************************************************/
  /* Deposit API */
  /****************************************************************************/

  describe("#deposit", async function () {
    it("successfully deposits and mints ERC-1155 tokens", async function () {
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

      await expectEvent(depositTx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: ethers.constants.AddressZero,
        to: accountDepositors[0].address,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("1"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("999"));
    });

    it("successfully deposits additional and mints additional tokens", async function () {
      /* Deposit 1 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Deposit 2 */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("2"), 0);

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("3"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("3"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(ethers.constants.Zero);
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);

      /* Validate token balance */
      expect(await tok1.balanceOf(accountDepositors[0].address)).to.equal(ethers.utils.parseEther("997"));
    });

    it("successfully deposits at new tick after garbage collecting old tick, properly mints and burns tokens", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Only two nodes (including head) */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);

      /* Redeem 1 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));

      /* Only head node now */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(1);

      /* Deposit 1 ETH at new tick close to garbage collected one */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10.1"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10.1"))).to.equal(FixedPoint.from("1"));

      /* Two nodes again */
      expect((await pool.liquidityNodes(0, MaxUint128)).length).to.equal(2);
    });
  });

  describe("#redeem", async function () {
    it("successfully redeems entire deposit from available cash, burns token", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Redeem 1 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("1"),
      });

      await expectEvent(redeemTx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: ethers.constants.AddressZero,
        id: Tick.encode("10"),
        value: FixedPoint.from("1"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("1"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("successfully redeems partial deposit from available cash, burns correct amount of tokens", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Redeem 0.5 shares */
      const redeemTx = await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("0.5"));

      /* Validate events */
      await expectEvent(redeemTx, pool, "Redeemed", {
        account: accountDepositors[0].address,
        tick: Tick.encode("10"),
        redemptionId: 0,
        shares: FixedPoint.from("0.5"),
      });

      await expectEvent(redeemTx, pool, "TransferSingle", {
        operator: accountDepositors[0].address,
        from: accountDepositors[0].address,
        to: ethers.constants.AddressZero,
        id: Tick.encode("10"),
        value: FixedPoint.from("0.5"),
      });

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("0.5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0.5"));

      /* Validate redemption state */
      const redemption = await pool.redemptions(accountDepositors[0].address, Tick.encode("10"), 0);
      expect(redemption.pending).to.equal(FixedPoint.from("0.5"));
      expect(redemption.index).to.equal(ethers.constants.Zero);
      expect(redemption.target).to.equal(ethers.constants.Zero);
    });

    it("successfully schedules redemption, burns tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("10"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("10"));
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("10"));

      /* Create loan */
      await createActiveLoan(FixedPoint.from("15"));

      /* Redeem 5 shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("5"));

      /* Validate deposit state */
      const [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(FixedPoint.from("5"));
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("5"));

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

    it("successfully schedules multiple redemptions, properly burns tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("15"), FixedPoint.from("10"), 0);

      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("10"));
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("10"));

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

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));

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
  });

  describe("#rebalance", async function () {
    it("rebalances a full redemption into another tick, properly burns and mints tokens", async function () {
      /* Deposit 1 ETH */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("1"), 0);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("1"));

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("1"));

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(FixedPoint.from("0"));

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

      // await expectEvent(rebalanceTx, pool, "TransferSingle", {
      //   operator: accountDepositors[0].address,
      //   from: ethers.constants.AddressZero,
      //   to: accountDepositors[0].address,
      //   id: Tick.encode("15"),
      //   value: FixedPoint.from("1"),
      // });

      /* Validate deposit state */
      let [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("10"));
      expect(shares).to.equal(ethers.constants.Zero);
      expect(redemptionId).to.equal(ethers.BigNumber.from("1"));

      [shares, redemptionId] = await pool.deposits(accountDepositors[0].address, Tick.encode("15"));
      expect(shares).to.equal(FixedPoint.from("1.0"));
      expect(redemptionId).to.equal(ethers.constants.Zero);

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.equal(FixedPoint.from("1"));

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

    it("rebalances a partial redemption into another tick, properly burns and mint tokens", async function () {
      /* Deposit */
      await pool.connect(accountDepositors[0]).deposit(Tick.encode("10"), FixedPoint.from("10"), 0);

      /* Create loan 1 */
      const [loanReceipt1] = await createActiveLoan(FixedPoint.from("5"));

      /* Create loan 2 */
      const [loanReceipt2] = await createActiveLoan(FixedPoint.from("5"));

      /* Redeem all shares */
      await pool.connect(accountDepositors[0]).redeem(Tick.encode("10"), FixedPoint.from("10"));

      /* Repay loan 1 */
      const repaymentTx = await pool.connect(accountBorrower).repay(loanReceipt1);

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

      /* Validate token state */
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("15"))).to.be.closeTo(
        FixedPoint.from("5.0"),
        FixedPoint.from("0.01")
      );
      expect(await pool.balanceOf(accountDepositors[0].address, Tick.encode("10"))).to.equal(0);

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
  /* ERC165 Interface */
  /****************************************************************************/

  describe("#supportsInterface", async function () {
    it("returns true on supported interfaces", async function () {
      /* ERC165 */
      expect(await pool.supportsInterface(pool.interface.getSighash("supportsInterface"))).to.equal(true);

      /* IERC1155 */
      expect(
        await pool.supportsInterface(
          ethers.utils.hexlify(
            ethers.BigNumber.from(pool.interface.getSighash("balanceOf"))
              .xor(ethers.BigNumber.from(pool.interface.getSighash("balanceOfBatch")))
              .xor(ethers.BigNumber.from(pool.interface.getSighash("setApprovalForAll")))
              .xor(ethers.BigNumber.from(pool.interface.getSighash("isApprovedForAll")))
              .xor(ethers.BigNumber.from(pool.interface.getSighash("safeTransferFrom")))
              .xor(ethers.BigNumber.from(pool.interface.getSighash("safeBatchTransferFrom")))
          )
        )
      ).to.equal(true);
    });

    it("returns false on unsupported interfaces", async function () {
      expect(await pool.supportsInterface("0xaabbccdd")).to.equal(false);
      expect(await pool.supportsInterface("0x00000000")).to.equal(false);
      expect(await pool.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
