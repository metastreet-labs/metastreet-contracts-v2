/* eslint-disable camelcase */
import * as dotenv from "dotenv";

import { expect } from "chai";
import { ethers, network } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import { IDirectLoanCoordinator__factory, IDirectLoan__factory, INoteAdapter } from "../../typechain";

dotenv.config();

describe("NFTfiV2NoteAdapter", async () => {
  const WETH_TOKEN = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const DIRECT_LOAN_COORDINATOR = "0x0C90C8B4aa8549656851964d5fB787F0e4F54082";
  const DIRECT_LOAN_FIXED_REDEPLOY = "0x8252Df1d8b29057d1Afe3062bf5a64D503152BC8";
  const BASIS_POINTS_DENOMINATOR = 10_000;

  /* world of women */
  const NFTFI_LOAN_ID = 24290;
  const NFTFI_NOTE_TOKEN_ID = BigNumber.from("3470274519206011530");

  /* loan data */
  let loanContract: string;

  /* nftfiv2 loan details */
  let loanPrincipalAmount: BigNumber;
  let maximumRepaymentAmount: BigNumber;
  let nftCollateralId: BigNumber;
  let loanDuration: number;
  let loanAdminFeeInBasisPoints: number;
  let loanStartTime: BigNumber;
  let nftCollateralContract: string;
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

    const nFTfiV2NoteAdapter = await ethers.getContractFactory("NFTfiV2NoteAdapter");

    noteAdapter = (await nFTfiV2NoteAdapter.deploy(DIRECT_LOAN_COORDINATOR)) as INoteAdapter;
    await noteAdapter.deployed();

    loanContract = (
      await IDirectLoanCoordinator__factory.connect(DIRECT_LOAN_COORDINATOR, ethers.provider).getLoanData(NFTFI_LOAN_ID)
    )[0] as string;

    /* get loan details from contract and assign to note adapter scoped variables */
    [
      loanPrincipalAmount,
      maximumRepaymentAmount,
      nftCollateralId,
      ,
      loanDuration,
      ,
      loanAdminFeeInBasisPoints,
      ,
      loanStartTime,
      nftCollateralContract,
      _borrower,
    ] = await IDirectLoan__factory.connect(loanContract, ethers.provider).loanIdToLoan(NFTFI_LOAN_ID);
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
      expect(await noteAdapter.name()).to.equal("NFTfi v2 Note Adapter");
    });
  });

  describe("#getAdapterType", async () => {
    it("returns correct adapter type", async () => {
      expect(await noteAdapter.getAdapterType()).to.equal(0);
    });
  });

  describe("#getLoanId", async () => {
    it("returns correct loan id", async () => {
      expect(await noteAdapter.getLoanId(NFTFI_NOTE_TOKEN_ID)).to.equal(NFTFI_LOAN_ID);
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
      ] = await noteAdapter.getLoanInfo(NFTFI_LOAN_ID, []);

      /* calculate repayment amount */
      const interest = maximumRepaymentAmount.sub(loanPrincipalAmount);
      const adminFee = interest.mul(loanAdminFeeInBasisPoints).div(BASIS_POINTS_DENOMINATOR);
      const repaymentAmount = maximumRepaymentAmount.sub(adminFee);

      expect(loanId).to.equal(NFTFI_LOAN_ID);
      expect(borrower).to.equal(_borrower);
      expect(principal).to.equal(loanPrincipalAmount);
      expect(repayment).to.equal(repaymentAmount);
      expect(maturity).to.equal(loanStartTime.toNumber() + loanDuration);
      expect(duration).to.equal(loanDuration);
      expect(currencyToken).to.equal(WETH_TOKEN);
      expect(collateralToken).to.equal(nftCollateralContract);
      expect(collateralTokenId).to.equal(nftCollateralId);

      /* test assets */
      expect(collateralToken).to.equal(assets[0].token);
      expect(collateralTokenId).to.equal(assets[0].tokenId);
      expect(0).to.equal(assets[0].assetType);
    });
  });

  describe("#getLoanStatus", async () => {
    it("returns correct status for active loan", async () => {
      expect(await noteAdapter.getLoanStatus(NFTFI_LOAN_ID, [])).to.equal(1);
    });

    it("returns correct status for repaid loan", async () => {
      expect(await noteAdapter.getLoanStatus(23983, [])).to.equal(2);
    });

    it("returns correct status for expired loan", async () => {
      await ethers.provider.send("evm_mine", [loanStartTime.toNumber() + loanDuration + 1]);
      expect(await noteAdapter.getLoanStatus(NFTFI_LOAN_ID, [])).to.equal(3);
    });

    it("returns correct status for unknown loan", async () => {
      expect(await noteAdapter.getLoanStatus(0, [])).to.equal(0);
      expect(await noteAdapter.getLoanStatus(9999999, [])).to.equal(0);
    });
  });

  describe("#getLiquidateCalldata", async () => {
    it("returns correct address and calldata", async () => {
      const ABI = ["function liquidateOverdueLoan(uint32)"];
      const iface = new ethers.utils.Interface(ABI);

      const [address, calldata] = await noteAdapter.getLiquidateCalldata(NFTFI_LOAN_ID, []);

      expect(address).to.equal(DIRECT_LOAN_FIXED_REDEPLOY);
      expect(calldata).to.equal(iface.encodeFunctionData("liquidateOverdueLoan", [NFTFI_LOAN_ID]));
    });
  });
});
