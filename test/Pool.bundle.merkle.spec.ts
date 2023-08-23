import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
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
import { FixedPoint } from "./helpers/FixedPoint";
import { Tick } from "./helpers/Tick";
import { MerkleTree } from "./helpers/MerkleTree";

describe("Pool Bundle Merkle", function () {
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
  let bundleData: any;
  let bundleTokenId: ethers.BigNumber;
  let merkleTree: StandardMerkleTree<any>;
  let nodeCount: number;
  let rates: ethers.BigNumber[];

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");
    const testProxyFactory = await ethers.getContractFactory("TestProxy");
    const externalCollateralLiquidatorFactory = await ethers.getContractFactory("ExternalCollateralLiquidator");
    const delegationRegistryFactory = await ethers.getContractFactory("TestDelegationRegistry");
    const bundleCollateralWrapperFactory = await ethers.getContractFactory("BundleCollateralWrapper");
    const poolImplFactory = await ethers.getContractFactory("WeightedRateMerkleCollectionPool");

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

    /* Deploy bundle collateral wrapper */
    bundleCollateralWrapper = await bundleCollateralWrapperFactory.deploy();
    await bundleCollateralWrapper.deployed();

    /* Deploy pool implementation */
    poolImpl = (await poolImplFactory.deploy(
      5000,
      collateralLiquidator.address,
      delegationRegistry.address,
      [bundleCollateralWrapper.address],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")]
    )) as Pool;
    await poolImpl.deployed();

    /* Arrange accounts */
    accountDepositors = accounts.slice(1, 4);
    accountBorrower = accounts[4];
    accountLender = accounts[5];
    accountLiquidator = accounts[6];

    /* Mint NFT to borrower */
    await nft1.mint(accountBorrower.address, 123);
    await nft1.mint(accountBorrower.address, 124);
    await nft1.mint(accountBorrower.address, 125);

    /* Approve bundle to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(bundleCollateralWrapper.address, true);

    /* Mint bundle */
    const mintTx = await bundleCollateralWrapper.connect(accountBorrower).mint(nft1.address, [123, 124, 125]);
    bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
    bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;

    /* Build merkle tree */
    merkleTree = MerkleTree.buildTree([["123"], ["124"], ["125"]], ["uint256"]);

    nodeCount = Math.ceil(Math.log2(3));

    /* Assign rates */
    rates = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

    /* Deploy pool */
    proxy = await testProxyFactory.deploy(
      poolImpl.address,
      poolImpl.interface.encodeFunctionData("initialize", [
        ethers.utils.defaultAbiCoder.encode(
          ["address", "bytes32", "uint32", "string", "address", "uint64[]", "uint64[]"],
          [
            nft1.address,
            merkleTree.root /* Merkle root */,
            nodeCount,
            "https://api.example.com/v2/",
            tok1.address,
            [30 * 86400, 14 * 86400, 7 * 86400],
            rates,
          ]
        ),
      ])
    );
    await proxy.deployed();
    pool = (await ethers.getContractAt("Pool", proxy.address)) as Pool;

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

    /* Mint token to borrower */
    await tok1.transfer(accountBorrower.address, ethers.utils.parseEther("100"));

    /* Mint token to lender */
    await tok1.transfer(accountLender.address, ethers.utils.parseEther("1000"));

    /* Approve pool to transfer token (for repayment) */
    await tok1.connect(accountBorrower).approve(pool.address, ethers.constants.MaxUint256);

    /* Approve pool to transfer bundle NFT */
    await bundleCollateralWrapper.connect(accountBorrower).setApprovalForAll(pool.address, true);
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
    it("matches expected implementation", async function () {
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
      expect(collateralWrappers.length).to.equal(3);
      expect(collateralWrappers[0]).to.equal(bundleCollateralWrapper.address);
    });
    it("returns expected collateral liquidator", async function () {
      expect(await pool.collateralLiquidator()).to.equal(collateralLiquidator.address);
    });
    it("returns expected delegation registry", async function () {
      expect(await pool.delegationRegistry()).to.equal(delegationRegistry.address);
    });
  });

  /****************************************************************************/
  /* Liquidity and Loan Helper functions */
  /****************************************************************************/

  const FixedPointScale = ethers.utils.parseEther("1");
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

  async function sourceLiquidity(
    amount: ethers.BigNumber,
    multiplier?: number = 1,
    duration?: number = 2,
    rate?: number = 0
  ): Promise<[ethers.BigNumber[], ethers.BigNumber[]]> {
    const nodes = await pool.liquidityNodes(0, MaxUint128);
    const ticks = [];
    const used = [];

    let taken = ethers.constants.Zero;
    for (const node of nodes) {
      const limit = Tick.decode(node.tick).limit;
      if (limit.isZero()) continue;

      const take = minBN(minBN(limit.mul(multiplier).sub(taken), node.available), amount.sub(taken));
      if (take.isZero()) break;

      ticks.push(node.tick);
      used.push(take);
      taken = taken.add(take);
    }

    if (!taken.eq(amount)) throw new Error(`Insufficient liquidity for amount ${amount.toString()}`);

    return [ticks, used];
  }

  function quote(
    amount: ethers.BigNumber,
    duration: number,
    ticks: ethers.BigNumber[],
    used: ethers.BigNumber[],
    rates: ethers.BigNumber[]
  ): ethers.BigNumber {
    /* Accumulate weighted rate */
    let weightedRate = ethers.constants.Zero;
    for (let i = 0; i < ticks.length; i++) {
      const rateIndex = Tick.decode(ticks[i]).rateIndex;
      weightedRate = weightedRate.add(used[i].mul(rates[rateIndex]).div(FixedPointScale));
    }

    /* Normalize weighted rate by amount */
    weightedRate = weightedRate.mul(FixedPointScale).div(amount);

    /* Calculate repayment */
    const repayment = amount
      .mul(FixedPointScale.add(weightedRate.mul(ethers.BigNumber.from(duration))))
      .div(FixedPointScale);

    return repayment;
  }

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#borrow", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("originates bundle loan with merkle filter", async function () {
      /* Compute merkle proofs */
      const merkleProofs = MerkleTree.buildProofs(["123", "124", "125"], nodeCount, merkleTree);

      /* Compute borrow options */
      const borrowOptions = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
        [
          1,
          ethers.utils.hexDataLength(bundleData),
          bundleData,
          2,
          ethers.utils.hexDataLength(merkleProofs),
          merkleProofs,
        ]
      );

      /* Source liquidity */
      const [ticks, used] = await sourceLiquidity(FixedPoint.from("25"), 3);

      /* Quote repayment */
      const repayment = quote(FixedPoint.from("25"), 30 * 86400, ticks, used, rates);

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          ticks,
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          ticks,
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(4);

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

    it("originates bundle loan with delegation and merkle filter", async function () {
      /* Compute merkle proofs */
      const merkleProofs = MerkleTree.buildProofs(["123", "124", "125"], nodeCount, merkleTree);

      /* Compute borrow options */
      const borrowOptions = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes", "uint16", "uint16", "bytes20"],
        [
          1,
          ethers.utils.hexDataLength(bundleData),
          bundleData,
          2,
          ethers.utils.hexDataLength(merkleProofs),
          merkleProofs,
          3,
          20,
          accountBorrower.address,
        ]
      );

      /* Source liquidity */
      const [ticks, used] = await sourceLiquidity(FixedPoint.from("25"), 3);

      /* Quote repayment */
      const repayment = quote(FixedPoint.from("25"), 30 * 86400, ticks, used, rates);

      /* Simulate borrow */
      const simulatedRepayment = await pool
        .connect(accountBorrower)
        .callStatic.borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          ticks,
          borrowOptions
        );

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          ticks,
          borrowOptions
        );

      /* Validate return value from borrow() */
      expect(simulatedRepayment).to.equal(repayment);

      /* Validate events */
      await expectEvent(borrowTx, bundleCollateralWrapper, "Transfer", {
        from: accountBorrower.address,
        to: pool.address,
        tokenId: bundleTokenId,
      });

      await expectEvent(borrowTx, tok1, "Transfer", {
        from: pool.address,
        to: accountBorrower.address,
        value: FixedPoint.from("25"),
      });

      await expectEvent(borrowTx, delegationRegistry, "DelegateForToken", {
        vault: pool.address,
        delegate: accountBorrower.address,
        contract_: bundleCollateralWrapper.address,
        tokenId: bundleTokenId,
        value: true,
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
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(ethers.utils.hexDataLength(bundleData));
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleData);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(4);

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
  });

  describe("#refinance", async function () {
    beforeEach("setup liquidity", async function () {
      await setupLiquidity();
    });

    it("refinance bundle loan at maturity with same principal", async function () {
      /* Compute merkle proofs */
      const merkleProofs = MerkleTree.buildProofs(["123", "124", "125"], nodeCount, merkleTree);

      /* Compute borrow options */
      const borrowOptions = ethers.utils.solidityPack(
        ["uint16", "uint16", "bytes", "uint16", "uint16", "bytes"],
        [
          1,
          ethers.utils.hexDataLength(bundleData),
          bundleData,
          2,
          ethers.utils.hexDataLength(merkleProofs),
          merkleProofs,
        ]
      );

      /* Source liquidity */
      const [ticks, used] = await sourceLiquidity(FixedPoint.from("25"), 3);

      /* Borrow */
      const borrowTx = await pool
        .connect(accountBorrower)
        .borrow(
          FixedPoint.from("25"),
          30 * 86400,
          bundleCollateralWrapper.address,
          bundleTokenId,
          FixedPoint.from("26"),
          ticks,
          borrowOptions
        );

      /* Extract loan receipt */
      const loanReceiptHash = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceiptHash;
      const loanReceipt = (await extractEvent(borrowTx, pool, "LoanOriginated")).args.loanReceipt;

      /* Get decoded receipt */
      const decodedLoanReceipt = await loanReceiptLib.decode(loanReceipt);

      /* Refinance */
      await helpers.time.setNextBlockTimestamp(decodedLoanReceipt.maturity.toNumber());
      const refinanceTx = await pool
        .connect(accountBorrower)
        .refinance(loanReceipt, decodedLoanReceipt.principal, 15 * 86400, FixedPoint.from("26"), ticks);
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
      expect(decodedNewLoanReceipt.collateralToken).to.equal(bundleCollateralWrapper.address);
      expect(decodedNewLoanReceipt.collateralTokenId).to.equal(bundleTokenId);
      expect(decodedNewLoanReceipt.nodeReceipts.length).to.equal(4);

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
  });
});
