/* eslint-disable camelcase */
import * as dotenv from "dotenv";

import { expect } from "chai";
import { ethers, network } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import { IAddressProvider__factory, IERC721__factory, INoteAdapter, IXY3__factory } from "../../typechain";

dotenv.config();

describe("XY3NoteAdapter", async () => {
  const WETH_TOKEN = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const XY3_ADDRESS = "0xFa4D5258804D7723eb6A934c11b1bd423bC31623";

  /* notes */
  let borrowerNote: string;

  /* moon bird */
  const XY3_LOAN_ID = 10476;
  const XY3_NOTE_TOKEN_ID = BigNumber.from("1955385066090783700");

  /* xy3 loan details */
  let borrowAmount: BigNumber;
  let repayAmount: BigNumber;
  let nftTokenId: BigNumber;
  let loanDuration: number;
  let loanStart: BigNumber;
  let nftAsset: string;
  let _borrower: string; /* borrower */

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

    const ixy3 = IXY3__factory.connect(XY3_ADDRESS, ethers.provider);
    const addressProvider = await ixy3.getAddressProvider();

    borrowerNote = await IAddressProvider__factory.connect(addressProvider, ethers.provider).getBorrowerNote();

    /* deploy test noteAdapter */
    const x2y2NoteAdapter = await ethers.getContractFactory("XY3NoteAdapter");

    noteAdapter = (await x2y2NoteAdapter.deploy(XY3_ADDRESS)) as INoteAdapter;
    await noteAdapter.deployed();

    /* get loan details from contract and assign to note adapter scoped variables */
    [borrowAmount, repayAmount, nftTokenId, , loanDuration, , loanStart, nftAsset, ,] = await ixy3.loanDetails(
      XY3_LOAN_ID
    );

    /* get borrower details from contract */
    _borrower = await IERC721__factory.connect(borrowerNote, ethers.provider).ownerOf(XY3_NOTE_TOKEN_ID);
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
      expect(await noteAdapter.name()).to.equal("XY3 Note Adapter");
    });
  });

  describe("#getAdapterType", async () => {
    it("returns correct adapter type", async () => {
      expect(await noteAdapter.getAdapterType()).to.equal(0);
    });
  });

  describe("#getLoanId", async () => {
    it("returns correct loan id", async () => {
      expect(await noteAdapter.getLoanId(XY3_NOTE_TOKEN_ID)).to.equal(XY3_LOAN_ID);
    });
  });

  describe("#getLoanInfo", async () => {
    it("returns correct loan info", async () => {
      /* use note adapter to get loan details */
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
      ] = await noteAdapter.getLoanInfo(XY3_LOAN_ID, []);

      /* test against values returned by contract */
      expect(loanId).to.equal(XY3_LOAN_ID);
      expect(borrower).to.equal(_borrower);
      expect(principal).to.equal(borrowAmount);
      expect(repayment).to.equal(repayAmount);
      expect(maturity).to.equal(loanStart.toNumber() + loanDuration);
      expect(duration).to.equal(loanDuration);
      expect(currencyToken).to.equal(WETH_TOKEN);
      expect(collateralToken).to.equal(nftAsset);
      expect(collateralTokenId).to.equal(nftTokenId);

      /* test assets */
      expect(collateralToken).to.equal(assets[0].token);
      expect(collateralTokenId).to.equal(assets[0].tokenId);
      expect(0).to.equal(assets[0].assetType);
    });
  });

  describe("#getLoanStatus", async () => {
    it("returns correct status for active loan", async () => {
      expect(await noteAdapter.getLoanStatus(XY3_LOAN_ID, [])).to.equal(1);
    });

    it("returns correct status for repaid loan", async () => {
      expect(await noteAdapter.getLoanStatus(10322, [])).to.equal(2);
    });

    it("returns correct status for expired loan", async () => {
      await ethers.provider.send("evm_mine", [loanStart.toNumber() + loanDuration + 1]);
      expect(await noteAdapter.getLoanStatus(XY3_LOAN_ID, [])).to.equal(3);
    });

    it("returns correct status for unknown loan", async () => {
      expect(await noteAdapter.getLoanStatus(0, [])).to.equal(0);
      expect(await noteAdapter.getLoanStatus(9999, [])).to.equal(0);
    });
  });

  describe("#getLiquidateCalldata", async () => {
    it("returns correct address and calldata", async () => {
      const ABI = ["function liquidate(uint32)"];
      const iface = new ethers.utils.Interface(ABI);

      const [address, calldata] = await noteAdapter.getLiquidateCalldata(XY3_LOAN_ID, []);

      expect(address).to.equal(XY3_ADDRESS);
      expect(calldata).to.equal(iface.encodeFunctionData("liquidate", [XY3_LOAN_ID]));
    });
  });
});
