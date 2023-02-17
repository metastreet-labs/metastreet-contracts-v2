/* eslint-disable camelcase */
import * as dotenv from "dotenv";

import { expect } from "chai";
import { ethers, network } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import {
  IERC721__factory,
  ILoanCore__factory,
  INoteAdapter,
  IVaultDepositRouter__factory,
  IVaultFactory__factory,
  IVaultInventoryReporter__factory,
} from "../../typechain";

dotenv.config();

const WETH_TOKEN = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASIS_POINTS_DENOMINATOR = 10_000;

describe("ArcadeV2NoteAdapter", async () => {
  const LOAN_CORE = "0x81b2F8Fc75Bab64A6b144aa6d2fAa127B4Fa7fD9";
  const REPAYMENT_CONTROLLER = "0xb39dAB85FA05C381767FF992cCDE4c94619993d4";
  const VAULT_DEPOSIT_ROUTER = "0xFDda20a20cb4249e73e3356f468DdfdfB61483F6";

  const BORROWER_NOTE = "0x337104A4f06260Ff327d6734C555A0f5d8F863aa";

  /* loanId and note tokenId are same on Arcade */
  const ARCADE_LOAN_ID = 954;

  /* vault id */
  const ARCADE_VAULT_LOAN_ID = 949;

  /* arcade distinguishes between repaid and liquidated loans */
  const REPAID_ARCADE_LOAN_ID = 511;
  const LIQUIDATED_ARCADE_LOAN_ID = 307;

  /* arcade constant */
  const INTEREST_RATE_DENOMINATOR = 1e18;

  /* loan terms */
  type LoanTerms = {
    durationSecs: number;
    deadline: number;
    numInstallments: number;
    interestRate: BigNumber;
    principal: BigNumber;
    collateralAddress: string;
    collateralId: BigNumber;
    payableCurrency: string;
  };

  /* loan details */
  let startDate: BigNumber;
  let terms: LoanTerms;

  /* borrower */
  let _borrower: string;

  let snapshotId: string;
  let noteAdapter: INoteAdapter;

  before("fork mainnet and deploy fixture", async function () {
    /* skip test if no MAINNET_URL env variable */
    if (!process.env.MAINNET_URL) {
      this.skip();
    }

    /* block from Feb 07 2023 */
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_URL,
            blockNumber: 16575682,
          },
        },
      ],
    });

    const arcadeNoteAdapter = await ethers.getContractFactory("ArcadeV2NoteAdapter");

    noteAdapter = (await arcadeNoteAdapter.deploy(
      LOAN_CORE,
      REPAYMENT_CONTROLLER,
      VAULT_DEPOSIT_ROUTER
    )) as INoteAdapter;
    await noteAdapter.deployed();

    /* get loan details from contract and assign to note adapter scoped variables */
    [, , startDate, terms, , , ,] = await ILoanCore__factory.connect(LOAN_CORE, ethers.provider).getLoan(
      ARCADE_LOAN_ID
    );

    /* get borrower */
    _borrower = await IERC721__factory.connect(BORROWER_NOTE, ethers.provider).ownerOf(ARCADE_LOAN_ID);
  });

  after("reset network", async () => {
    await network.provider.request({ method: "hardhat_reset" });
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("#name", async () => {
    it("returns correct name", async () => {
      expect(await noteAdapter.name()).to.equal("Arcade v2 Note Adapter");
    });
  });

  describe("#getAdapterType", async () => {
    it("returns correct adapter type", async () => {
      expect(await noteAdapter.getAdapterType()).to.equal(0);
    });
  });

  describe("#getLoanId", async () => {
    it("returns correct loan id", async () => {
      expect(await noteAdapter.getLoanId(ARCADE_LOAN_ID)).to.equal(ARCADE_LOAN_ID);
    });
  });

  describe("#getLoanInfo", async () => {
    it("returns correct loan info", async () => {
      const [
        loanId,
        borrower,
        principal,
        repayment,
        maturity,
        duration,
        currencyToken,
        collateralToken,
        collateralTokenId,
        assets,
      ] = await noteAdapter.getLoanInfo(ARCADE_LOAN_ID, []);

      /* calculate repayment */
      const interest = terms.principal
        .mul(terms.interestRate)
        .div(BigNumber.from(INTEREST_RATE_DENOMINATOR.toString()))
        .div(BASIS_POINTS_DENOMINATOR);

      const repaymentAmount = principal.add(interest);

      expect(loanId).to.equal(ARCADE_LOAN_ID);
      expect(borrower).to.equal(_borrower);
      expect(principal).to.equal(terms.principal);
      expect(repayment).to.equal(repaymentAmount);
      expect(maturity).to.equal(startDate.toNumber() + terms.durationSecs);
      expect(duration).to.equal(terms.durationSecs);
      expect(currencyToken).to.equal(WETH_TOKEN);
      expect(collateralToken).to.equal(terms.collateralAddress);
      expect(collateralTokenId).to.equal(terms.collateralId);

      /* test assets */
      expect(collateralToken).to.equal(assets[0].token);
      expect(collateralTokenId).to.equal(assets[0].tokenId);
      expect(0).to.equal(assets[0].assetType);
    });

    it("returns correct loan info - vault", async () => {
      /* get loan details from contract and assign to note adapter scoped variables */
      const [, , startDate, terms, , , ,] = await ILoanCore__factory.connect(LOAN_CORE, ethers.provider).getLoan(
        ARCADE_VAULT_LOAN_ID
      );

      /* get borrower */
      const _borrower = await IERC721__factory.connect(BORROWER_NOTE, ethers.provider).ownerOf(ARCADE_VAULT_LOAN_ID);

      const [
        loanId,
        borrower,
        principal,
        repayment,
        maturity,
        duration,
        currencyToken,
        collateralToken,
        collateralTokenId,
        assets,
      ] = await noteAdapter.getLoanInfo(ARCADE_VAULT_LOAN_ID, []);

      /* get vault deposit router */
      const vaultDepositRouter = IVaultDepositRouter__factory.connect(VAULT_DEPOSIT_ROUTER, ethers.provider);

      /* get vault factory */
      const vaultFactoryAddress = await vaultDepositRouter.callStatic.factory();
      const vaultFactory = IVaultFactory__factory.connect(vaultFactoryAddress, ethers.provider);

      /* get vault inventory reporter */
      const vaultInventoryReporterAddress = await vaultDepositRouter.callStatic.reporter();
      const vaultInventoryReporter = IVaultInventoryReporter__factory.connect(
        vaultInventoryReporterAddress,
        ethers.provider
      );

      /* get vault address */
      const vaultInstanceAddress = await vaultFactory.instanceAt(collateralTokenId);

      /* get items */
      const items = await vaultInventoryReporter.enumerateOrFail(vaultInstanceAddress);

      /* calculate repayment */
      const interest = terms.principal
        .mul(terms.interestRate)
        .div(BigNumber.from(INTEREST_RATE_DENOMINATOR.toString()))
        .div(BASIS_POINTS_DENOMINATOR);

      const repaymentAmount = principal.add(interest);

      expect(loanId).to.equal(ARCADE_VAULT_LOAN_ID);
      expect(borrower).to.equal(_borrower);
      expect(principal).to.equal(terms.principal);
      expect(repayment).to.equal(repaymentAmount);
      expect(maturity).to.equal(startDate.toNumber() + terms.durationSecs);
      expect(duration).to.equal(terms.durationSecs);
      expect(currencyToken).to.equal(WETH_TOKEN);
      expect(collateralToken).to.equal(terms.collateralAddress);
      expect(collateralTokenId).to.equal(terms.collateralId);

      /* test assets */
      for (let i = 0; i < items.length; i++) {
        expect(items[i].tokenAddress).to.equal(assets[i].token);
        expect(items[i].tokenId).to.equal(assets[i].tokenId);
        expect(items[i].itemType).to.equal(assets[i].assetType);
      }
    });
  });

  describe("#getLoanStatus", async () => {
    it("returns correct status for active loan", async () => {
      expect(await noteAdapter.getLoanStatus(ARCADE_LOAN_ID, [])).to.equal(1);
      expect(await noteAdapter.getLoanStatus(ARCADE_VAULT_LOAN_ID, [])).to.equal(1);
    });

    it("returns correct status for repaid loan", async () => {
      expect(await noteAdapter.getLoanStatus(REPAID_ARCADE_LOAN_ID, [])).to.equal(2);
    });

    it("returns correct status for liquidated loan", async () => {
      expect(await noteAdapter.getLoanStatus(LIQUIDATED_ARCADE_LOAN_ID, [])).to.equal(4);
    });

    it("returns correct status for expired loan", async () => {
      await ethers.provider.send("evm_mine", [startDate.toNumber() + terms.durationSecs + 1]);
      expect(await noteAdapter.getLoanStatus(ARCADE_LOAN_ID, [])).to.equal(3);
    });

    it("returns correct status for unknown loan", async () => {
      expect(await noteAdapter.getLoanStatus(0, [])).to.equal(0);
      expect(await noteAdapter.getLoanStatus(9999999, [])).to.equal(0);
    });
  });

  describe("#getLiquidateCalldata", async () => {
    it("returns correct address and calldata", async () => {
      const ABI = ["function claim(uint256)"];
      const iface = new ethers.utils.Interface(ABI);

      const [address, calldata] = await noteAdapter.getLiquidateCalldata(ARCADE_LOAN_ID, []);

      expect(address).to.equal(REPAYMENT_CONTROLLER);
      expect(calldata).to.equal(iface.encodeFunctionData("claim", [ARCADE_LOAN_ID]));
    });
  });
});
