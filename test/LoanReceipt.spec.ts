import { expect } from "chai";
import { ethers, network } from "hardhat";

import { TestLoanReceipt, LoanReceipt } from "../typechain";

describe("LoanReceipt", function () {
  let snapshotId: string;
  let loanReceiptLibrary: TestLoanReceipt;

  before("deploy fixture", async () => {
    const testLoanReceiptFactory = await ethers.getContractFactory("TestLoanReceipt");

    loanReceiptLibrary = await testLoanReceiptFactory.deploy();
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  const loanReceipt: LoanReceipt = {
    version: 1,
    platform: "0x8552B1f50a85ae8e5198Cb286c435bb0cb951de5",
    loanId: 123,
    borrower: "0x0CD36Fa7D9634994231Bc76Fb36938D56C6FE70E",
    maturity: 1685595600,
    duration: 2592000,
    collateralToken: "0x7616dF65742332F688e0E0b1D293a3162f0904EA",
    collateralTokenId: 456,
    liquidityTrail: [
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
      expect(encodedLoanReceipt.length).to.equal(2 + (141 + 48 * 3) * 2);
      expect(encodedLoanReceipt).to.equal(
        "0x018552b1f50a85ae8e5198cb286c435bb0cb951de5000000000000000000000000000000000000000000000000000000000000007b0cd36fa7d9634994231bc76fb36938d56c6fe70e00000000647825d00000000000278d007616df65742332f688e0e0b1d293a3162f0904ea00000000000000000000000000000000000000000000000000000000000001c800000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000e043da61725000000000000000000001bc16d674ec8000000000000000000000de0b6b3a764000000000000000000000e043da617250000000000000000000029a2241af62c000000000000000000000de0b6b3a764000000000000000000000e27c49886e60000"
      );
    });
  });

  describe("#hash", async function () {
    it("matches expected hash", async function () {
      expect(await loanReceiptLibrary.hash(loanReceipt)).to.equal(
        "0xd89e16dd1faedd436522205914b556d10df2a2ffdcc2839ebb8f3bece33265e9"
      );
    });
  });

  describe("#decode", async function () {
    it("successfuly decodes loan receipt", async function () {
      const encodedLoanReceipt = await loanReceiptLibrary.encode(loanReceipt);
      const decodedLoanReceipt = await loanReceiptLibrary.decode(encodedLoanReceipt);

      expect(decodedLoanReceipt.version).to.equal(loanReceipt.version);
      expect(decodedLoanReceipt.platform).to.equal(loanReceipt.platform);
      expect(decodedLoanReceipt.loanId).to.equal(loanReceipt.loanId);
      expect(decodedLoanReceipt.borrower).to.equal(loanReceipt.borrower);
      expect(decodedLoanReceipt.maturity).to.equal(loanReceipt.maturity);
      expect(decodedLoanReceipt.duration).to.equal(loanReceipt.duration);
      expect(decodedLoanReceipt.collateralToken).to.equal(loanReceipt.collateralToken);
      expect(decodedLoanReceipt.collateralTokenId).to.equal(loanReceipt.collateralTokenId);
      expect(decodedLoanReceipt.liquidityTrail.length).to.equal(3);
      for (let i = 0; i < loanReceipt.liquidityTrail.length; i++) {
        expect(decodedLoanReceipt.liquidityTrail[i].depth).to.equal(loanReceipt.liquidityTrail[i].depth);
        expect(decodedLoanReceipt.liquidityTrail[i].used).to.equal(loanReceipt.liquidityTrail[i].used);
        expect(decodedLoanReceipt.liquidityTrail[i].pending).to.equal(loanReceipt.liquidityTrail[i].pending);
      }
      expect(await loanReceiptLibrary.hash(decodedLoanReceipt)).to.equal(await loanReceiptLibrary.hash(loanReceipt));
    });
    it("fails on invalid size", async function () {
      const encodedLoanReceipt = ethers.utils.arrayify(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 140))).to.be.revertedWithCustomError(
        loanReceiptLibrary,
        "InvalidReceiptEncoding"
      );
    });
    it("fails on invalid liquidity trail", async function () {
      const encodedLoanReceipt = ethers.utils.arrayify(await loanReceiptLibrary.encode(loanReceipt));
      await expect(loanReceiptLibrary.decode(encodedLoanReceipt.slice(0, 141 + 24))).to.be.revertedWithCustomError(
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

  describe("#fromLoanInfo", async function () {
    it("successfully creates loan receipt from loan info", async function () {
      const loanInfo = {
        loanId: loanReceipt.loanId,
        borrower: loanReceipt.borrower,
        principal: ethers.BigNumber.from("3000000000000000000"),
        repayment: ethers.BigNumber.from("3040000000000000000"),
        maturity: loanReceipt.maturity,
        duration: loanReceipt.duration,
        currencyToken: "0x453C08F8B0D34B3b08406B5C11B459AcC401fBE4",
        collateralToken: loanReceipt.collateralToken,
        collateralTokenId: loanReceipt.collateralTokenId,
        assets: [],
      };
      const builtLoanReceipt = await loanReceiptLibrary.fromLoanInfo(
        loanReceipt.platform,
        loanInfo,
        loanReceipt.liquidityTrail
      );

      expect(builtLoanReceipt.version).to.equal(loanReceipt.version);
      expect(builtLoanReceipt.platform).to.equal(loanReceipt.platform);
      expect(builtLoanReceipt.loanId).to.equal(loanReceipt.loanId);
      expect(builtLoanReceipt.borrower).to.equal(loanReceipt.borrower);
      expect(builtLoanReceipt.maturity).to.equal(loanReceipt.maturity);
      expect(builtLoanReceipt.duration).to.equal(loanReceipt.duration);
      expect(builtLoanReceipt.collateralToken).to.equal(loanReceipt.collateralToken);
      expect(builtLoanReceipt.collateralTokenId).to.equal(loanReceipt.collateralTokenId);
      expect(builtLoanReceipt.liquidityTrail.length).to.equal(3);
      for (let i = 0; i < loanReceipt.liquidityTrail.length; i++) {
        expect(builtLoanReceipt.liquidityTrail[i].depth).to.equal(loanReceipt.liquidityTrail[i].depth);
        expect(builtLoanReceipt.liquidityTrail[i].used).to.equal(loanReceipt.liquidityTrail[i].used);
        expect(builtLoanReceipt.liquidityTrail[i].pending).to.equal(loanReceipt.liquidityTrail[i].pending);
      }
    });
  });
});
