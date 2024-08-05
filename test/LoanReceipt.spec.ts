import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";

import { TestLoanReceipt } from "../typechain";

describe("LoanReceipt", function () {
  let snapshotId: string;
  let loanReceiptLibrary: TestLoanReceipt;

  before("deploy fixture", async () => {
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");

    /* Deploy loan receipt library */
    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
    await loanReceiptLibrary.waitForDeployment();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Loan Reciept Test Vectors */
  /****************************************************************************/

  const loanReceipt = {
    version: 2,
    principal: BigInt("3000000000000000000"),
    repayment: BigInt("3040000000000000000"),
    adminFee: BigInt("2000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: "0x7616dF65742332F688e0E0b1D293a3162f0904EA",
    collateralTokenId: 456,
    collateralWrapperContextLen: 0,
    collateralWrapperContext: "0x",
    nodeReceipts: [
      {
        tick: BigInt("1000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("2000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("3000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1020000000000000000"),
      },
    ],
  };

  const bundleLoanReceipt = {
    version: 2,
    principal: BigInt("3000000000000000000"),
    repayment: BigInt("3040000000000000000"),
    adminFee: BigInt("2000000000000000"),
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
    collateralTokenId: BigInt("44527239254935349275158812996110366328027393789522367573114992166380918873022"),
    collateralWrapperContextLen: 84,
    collateralWrapperContext:
      "0xb7f8bc63bbcad18155201308c8f3540b07f84f5e00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
    nodeReceipts: [
      {
        tick: BigInt("1000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("2000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1010000000000000000"),
      },
      {
        tick: BigInt("3000000000000000000"),
        used: BigInt("1000000000000000000"),
        pending: BigInt("1020000000000000000"),
      },
    ],
  };

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#hash", async function () {
    it("matches expected hash", async function () {
      expect(await loanReceiptLibrary.hash(await loanReceiptLibrary.encode(loanReceipt))).to.equal(
        "0xf362e216e56f126f29871b85ccdb42ed7e0248527820b9e565933ed9a0434086"
      );
    });

    it("matches expected hash - bundle loan", async function () {
      expect(await loanReceiptLibrary.hash(await loanReceiptLibrary.encode(bundleLoanReceipt))).to.equal(
        "0x1a6523d7bd51c729e4db4777ef6da844492df918a1406a8cd077df1bbeec4c1a"
      );
    });
  });

  describe("#encode", async function () {
    it("successfully encodes loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(loanReceipt);
      expect(encodedLoanReceipt.length).to.equal(2 + (187 + 48 * 3) * 2);
      expect(encodedLoanReceipt).to.equal(
        "0x0200000000000000000000000000000000000000000000000029a2241af62c00000000000000000000000000000000000000000000000000002a303fe4b530000000000000000000000000000000000000000000000000000000071afd498d00000cd36fa7d9634994231bc76fb36938d56c6fe70e00000000647825d00000000000278d007616df65742332f688e0e0b1d293a3162f0904ea00000000000000000000000000000000000000000000000000000000000001c8000000000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000e043da61725000000000000000000001bc16d674ec8000000000000000000000de0b6b3a764000000000000000000000e043da617250000000000000000000029a2241af62c000000000000000000000de0b6b3a764000000000000000000000e27c49886e60000"
      );
    });

    it("successfully encodes bundled loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(bundleLoanReceipt);
      expect(encodedLoanReceipt.length).to.equal(2 + (187 + 20 + 32 * 2 + 48 * 3) * 2);
      expect(encodedLoanReceipt).to.equal(
        "0x0200000000000000000000000000000000000000000000000029a2241af62c00000000000000000000000000000000000000000000000000002a303fe4b530000000000000000000000000000000000000000000000000000000071afd498d00000cd36fa7d9634994231bc76fb36938d56c6fe70e00000000647825d00000000000278d000dcd1bf9a1b36ce34237eeafef220932846bcd82627186392ce4c7e6bbeefb220f87587bf7b64195606e45cc778cced10a691bbe0054b7f8bc63bbcad18155201308c8f3540b07f84f5e0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000e043da61725000000000000000000001bc16d674ec8000000000000000000000de0b6b3a764000000000000000000000e043da617250000000000000000000029a2241af62c000000000000000000000de0b6b3a764000000000000000000000e27c49886e60000"
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
      expect(decodedLoanReceipt.adminFee).to.equal(loanReceipt.adminFee);
      expect(decodedLoanReceipt.borrower).to.equal(loanReceipt.borrower);
      expect(decodedLoanReceipt.maturity).to.equal(loanReceipt.maturity);
      expect(decodedLoanReceipt.duration).to.equal(loanReceipt.duration);
      expect(decodedLoanReceipt.collateralToken).to.equal(loanReceipt.collateralToken);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(loanReceipt.collateralTokenId);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(3);
      for (let i = 0; i < loanReceipt.nodeReceipts.length; i++) {
        expect(decodedLoanReceipt.nodeReceipts[i].tick).to.equal(loanReceipt.nodeReceipts[i].tick);
        expect(decodedLoanReceipt.nodeReceipts[i].used).to.equal(loanReceipt.nodeReceipts[i].used);
        expect(decodedLoanReceipt.nodeReceipts[i].pending).to.equal(loanReceipt.nodeReceipts[i].pending);
      }
    });

    it("successfuly decodes bundle loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(bundleLoanReceipt);
      const decodedLoanReceipt = await loanReceiptLibrary.decode(encodedLoanReceipt);

      expect(decodedLoanReceipt.version).to.equal(bundleLoanReceipt.version);
      expect(decodedLoanReceipt.principal).to.equal(bundleLoanReceipt.principal);
      expect(decodedLoanReceipt.repayment).to.equal(bundleLoanReceipt.repayment);
      expect(decodedLoanReceipt.adminFee).to.equal(loanReceipt.adminFee);
      expect(decodedLoanReceipt.borrower).to.equal(bundleLoanReceipt.borrower);
      expect(decodedLoanReceipt.maturity).to.equal(bundleLoanReceipt.maturity);
      expect(decodedLoanReceipt.duration).to.equal(bundleLoanReceipt.duration);
      expect(decodedLoanReceipt.collateralToken).to.equal(bundleLoanReceipt.collateralToken);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(bundleLoanReceipt.collateralTokenId);
      expect(decodedLoanReceipt.collateralWrapperContextLen).to.equal(bundleLoanReceipt.collateralWrapperContextLen);
      expect(decodedLoanReceipt.collateralWrapperContext).to.equal(bundleLoanReceipt.collateralWrapperContext);
      expect(decodedLoanReceipt.nodeReceipts.length).to.equal(3);
      for (let i = 0; i < bundleLoanReceipt.nodeReceipts.length; i++) {
        expect(decodedLoanReceipt.nodeReceipts[i].tick).to.equal(bundleLoanReceipt.nodeReceipts[i].tick);
        expect(decodedLoanReceipt.nodeReceipts[i].used).to.equal(bundleLoanReceipt.nodeReceipts[i].used);
        expect(decodedLoanReceipt.nodeReceipts[i].pending).to.equal(bundleLoanReceipt.nodeReceipts[i].pending);
      }
    });

    it("fails on invalid size", async function () {
      const encodedLoanReceipt = ethers.getBytes(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 172))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });

    it("bundle fails on invalid size", async function () {
      const encodedLoanReceipt = ethers.getBytes(await loanReceiptLibrary.encode(bundleLoanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 256))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });

    it("fails on invalid node receipts", async function () {
      const encodedLoanReceipt = ethers.getBytes(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 173 + 24))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });

    it("fails on unsupported version", async function () {
      const encodedLoanReceipt = ethers.getBytes(await loanReceiptLibrary.encode(loanReceipt));
      encodedLoanReceipt[0] = 1;
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt)).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });
  });
});
