import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { TestERC20, TestERC1155, TestLoanReceipt, Pool, ERC1155CollateralWrapper, Test } from "../typechain";

import { extractEvent, expectEvent } from "./helpers/EventUtilities";

describe("Pool ERC1155", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC1155;
  let loanReceiptLib: TestLoanReceipt;
  let pool: Pool;
  let snapshotId: string;
  let accountBorrower: SignerWithAddress;
  let ERC1155CollateralWrapper: ERC1155CollateralWrapper;
  let test: Test;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC1155Factory = await ethers.getContractFactory("TestERC1155");
    const ERC1155CollateralWrapperFactory = await ethers.getContractFactory("ERC1155CollateralWrapper");
    const testFactory = await ethers.getContractFactory("Test");

    /* Deploy test currency token */
    tok1 = (await testERC20Factory.deploy("Token 1", "TOK1", 18, ethers.utils.parseEther("10000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC1155Factory.deploy("https://nft1.com/token/")) as TestERC1155;
    await nft1.deployed();

    /* Deploy ERC1155 collateral wrapper */
    ERC1155CollateralWrapper = await ERC1155CollateralWrapperFactory.deploy();
    await ERC1155CollateralWrapper.deployed();

    /* Deploy ERC1155 collateral wrapper */
    test = await testFactory.deploy();
    await test.deployed();

    /* Arrange accounts */
    accountBorrower = accounts[4];

    /* Mint NFT to borrower */
    await nft1.mintBatch(accountBorrower.address, [123, 124, 125], [1, 2, 3], "0x");

    /* Approve ERC1155Wrapper to transfer NFT */
    await nft1.connect(accountBorrower).setApprovalForAll(ERC1155CollateralWrapper.address, true);
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Lend API */
  /****************************************************************************/

  describe("#test", async function () {
    it("test greg", async function () {
      /* Mint ERC1155 Wrapper */
      const mintTx = await ERC1155CollateralWrapper.connect(accountBorrower).mint(
        nft1.address,
        [123, 124, 125],
        [1, 2, 2]
      );
      const ERC1155WrapperTokenId = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const ERC1155WrapperData = (await extractEvent(mintTx, ERC1155CollateralWrapper, "BatchMinted")).args
        .encodedBatch;

      const testReturn = await test
        .connect(accountBorrower)
        .callStatic.test(ERC1155CollateralWrapper.address, ERC1155WrapperTokenId, ERC1155WrapperData);
      console.log("testReturn:", testReturn);

      const testTx = await test
        .connect(accountBorrower)
        .test(ERC1155CollateralWrapper.address, ERC1155WrapperTokenId, ERC1155WrapperData);
      console.log("testTx:", testTx);
    });
  });
});
