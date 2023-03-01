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
    platform: "0x8552B1f50a85ae8e5198Cb286c435bb0cb951de5",
    loanId: 123,
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

      expect(encodedLoanReceipt.length).to.equal(2 + (205 + 48 * 3) * 2);
      expect(encodedLoanReceipt).to.equal(
        "0x018552b1f50a85ae8e5198cb286c435bb0cb951de5000000000000000000000000000000000000000000000000000000000000007b00000000000000000000000000000000000000000000000029a2241af62c00000000000000000000000000000000000000000000000000002a303fe4b53000000cd36fa7d9634994231bc76fb36938d56c6fe70e00000000647825d00000000000278d007616df65742332f688e0e0b1d293a3162f0904ea00000000000000000000000000000000000000000000000000000000000001c800000000000000000de0b6b3a764000000000000000000000de0b6b3a764000000000000000000000e043da61725000000000000000000001bc16d674ec8000000000000000000000de0b6b3a764000000000000000000000e043da617250000000000000000000029a2241af62c000000000000000000000de0b6b3a764000000000000000000000e27c49886e60000"
      );
    });
  });

  describe("#hash", async function () {
    it("matches expected hash", async function () {
      expect(await loanReceiptLibrary.hash(await loanReceiptLibrary.encode(loanReceipt))).to.equal(
        "0xe5ce13a33eaf1958108055129cb340e4f1d91ddce585d10098f3238ac4445562"
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
        loanReceipt.nodeReceipts
      );

      expect(builtLoanReceipt.version).to.equal(loanReceipt.version);
      expect(builtLoanReceipt.platform).to.equal(loanReceipt.platform);
      expect(builtLoanReceipt.loanId).to.equal(loanReceipt.loanId);
      expect(builtLoanReceipt.principal).to.equal(loanReceipt.principal);
      expect(builtLoanReceipt.repayment).to.equal(loanReceipt.repayment);
      expect(builtLoanReceipt.borrower).to.equal(loanReceipt.borrower);
      expect(builtLoanReceipt.maturity).to.equal(loanReceipt.maturity);
      expect(builtLoanReceipt.duration).to.equal(loanReceipt.duration);
      expect(builtLoanReceipt.collateralToken).to.equal(loanReceipt.collateralToken);
      expect(builtLoanReceipt.collateralTokenId).to.equal(loanReceipt.collateralTokenId);
      expect(builtLoanReceipt.nodeReceipts.length).to.equal(3);
      for (let i = 0; i < loanReceipt.nodeReceipts.length; i++) {
        expect(builtLoanReceipt.nodeReceipts[i].depth).to.equal(loanReceipt.nodeReceipts[i].depth);
        expect(builtLoanReceipt.nodeReceipts[i].used).to.equal(loanReceipt.nodeReceipts[i].used);
        expect(builtLoanReceipt.nodeReceipts[i].pending).to.equal(loanReceipt.nodeReceipts[i].pending);
      }
    });
  });
});
