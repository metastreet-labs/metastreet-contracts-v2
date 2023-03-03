import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestLoanReceipt } from "../typechain";

describe("LoanReceipt", function () {
  let snapshotId: string;
  let loanReceiptLibrary: TestLoanReceipt;

  before("deploy fixture", async () => {
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.deployed();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  const loanReceipt = {
    version: 1,
    principal: ethers.BigNumber.from("3000000000000000000"),
    repayment: ethers.BigNumber.from("3040000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: "0x7616dF65742332F688e0E0b1D293a3162f0904EA",
    collateralTokenId: 456,
    nodeReceipts: [
      {
        depth: ethers.BigNumber.from("1000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        depth: ethers.BigNumber.from("2000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1010000000000000000"),
      },
      {
        depth: ethers.BigNumber.from("3000000000000000000"),
        used: ethers.BigNumber.from("1000000000000000000"),
        pending: ethers.BigNumber.from("1020000000000000000"),
      },
    ],
  };

  describe("#encode", async function () {
    it("successfully encodes loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(loanReceipt);

      expect(encodedLoanReceipt.length).to.equal(2 + (153 + 48 * 3) * 2);
      expect(encodedLoanReceipt).to.equal(
        "0x0100000000000000000000000000000000000000000000000029a2241af62c00000000000000000000000000000000000000000000000000002a303fe4b53000000cd36fa7d9634994231bc76fb36938d56c6fe70e00000000647825d00000000000278d007616df65742332f688e0e0b1d293a3162f0904ea00000000000000000000000000000000000000000000000000000000000001c800000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000e043da61725000000000000000000001bc16d674ec8000000000000000000000de0b6b3a764000000000000000000000e043da617250000000000000000000029a2241af62c000000000000000000000de0b6b3a764000000000000000000000e27c49886e60000"
      );
    });
  });

  describe("#hash", async function () {
    it("matches expected hash", async function () {
      expect(await loanReceiptLibrary.hash(await loanReceiptLibrary.encode(loanReceipt))).to.equal(
        "0x32d6f30a8bfe6d5e6d9655dc92024206644d918952f3cb1d83076b5c078fdda0"
      );
    });
  });

  describe("#decode", async function () {
    it("successfuly decodes loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(loanReceipt);
      const decodedLoanReceipt = await loanReceiptLibrary.decode(encodedLoanReceipt);

      expect(decodedLoanReceipt.version).to.equal(loanReceipt.version);
      expect(decodedLoanReceipt.principal).to.equal(loanReceipt.principal);
      expect(decodedLoanReceipt.repayment).to.equal(loanReceipt.repayment);
      expect(decodedLoanReceipt.borrower).to.equal(loanReceipt.borrower);
      expect(decodedLoanReceipt.maturity).to.equal(loanReceipt.maturity);
      expect(decodedLoanReceipt.duration).to.equal(loanReceipt.duration);
      expect(decodedLoanReceipt.collateralToken).to.equal(loanReceipt.collateralToken);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(loanReceipt.collateralTokenId);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(3);
      for (let i = 0; i < loanReceipt.nodeReceipts.length; i++) {
        expect(decodedLoanReceipt.nodeReceipts[i].depth).to.equal(loanReceipt.nodeReceipts[i].depth);
        expect(decodedLoanReceipt.nodeReceipts[i].used).to.equal(loanReceipt.nodeReceipts[i].used);
        expect(decodedLoanReceipt.nodeReceipts[i].pending).to.equal(loanReceipt.nodeReceipts[i].pending);
      }
      expect(await loanReceiptLibrary.hash(await loanReceiptLibrary.encode(decodedLoanReceipt))).to.equal(
        await loanReceiptLibrary.hash(encodedLoanReceipt)
      );
    });
    it("fails on invalid size", async function () {
      const encodedLoanReceipt = ethers.utils.arrayify(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 172))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });
    it("fails on invalid node receipts", async function () {
      const encodedLoanReceipt = ethers.utils.arrayify(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 173 + 24))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });
    it("fails on unsupported version", async function () {
      const encodedLoanReceipt = ethers.utils.arrayify(await loanReceiptLibrary.encode(loanReceipt));
      encodedLoanReceipt[0] = 2;
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt)).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "UnsupportedReceiptVersion"
      );
    });
  });
});
