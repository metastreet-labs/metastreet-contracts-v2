import { expect } from "chai";
import { ethers, network } from "hardhat";

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import { MerkleCollectionCollateralFilter } from "../../typechain";

import { MerkleTree } from "../helpers/MerkleTree";

describe("MerkleCollectionCollateralFilter", function () {
  let collateralFilter: TestMerkleCollectionCollateralFilter;
  let snapshotId: string;
  let merkleTree: StandardMerkleTree<any>;
  let nodeCount: number;
  let metadataURI: string;

  before("deploy fixture", async () => {
    const merkleCollectionCollateralFilterFactory = await ethers.getContractFactory(
      "TestMerkleCollectionCollateralFilter"
    );

    /* Build merkle tree */
    merkleTree = MerkleTree.buildTree([["123"], ["124"], ["125"]], ["uint256"]);

    nodeCount = Math.ceil(Math.log2(3));

    metadataURI = "https://api.example.com/v2/";

    collateralFilter = await merkleCollectionCollateralFilterFactory.deploy(
      "0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b",
      merkleTree.root,
      nodeCount,
      metadataURI
    );
    await collateralFilter.waitForDeployment();
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
    it("matches expected name", async function () {
      expect(await collateralFilter.COLLATERAL_FILTER_NAME()).to.equal("MerkleCollectionCollateralFilter");
    });
    it("matches expected implementation version", async function () {
      expect(await collateralFilter.COLLATERAL_FILTER_VERSION()).to.equal("1.0");
    });
  });

  /****************************************************************************/
  /* Getters */
  /****************************************************************************/

  describe("#collateralToken", async function () {
    it("matches expected collateral token", async function () {
      expect(await collateralFilter.collateralToken()).to.equal("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b");
    });
    it("matches expected collateral tokens", async function () {
      expect(await collateralFilter.collateralTokens()).to.be.eql(["0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b"]);
    });
  });

  describe("#merkleRoot", async function () {
    it("matches expected merkle root", async function () {
      expect(await collateralFilter.merkleRoot()).to.equal(merkleTree.root);
    });
  });

  describe("#metadataURI", async function () {
    it("matches expected metadataURI", async function () {
      expect(await collateralFilter.metadataURI()).to.equal(metadataURI);
    });
  });

  /****************************************************************************/
  /* Primary API */
  /****************************************************************************/

  describe("#collateralSupported", async function () {
    it("matches supported token", async function () {
      /* Compute merkle proofs */
      const merkleProofs = MerkleTree.buildProofs(["123", "124", "125"], nodeCount, merkleTree);

      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 123, 0, merkleProofs)
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 124, 1, merkleProofs)
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 125, 2, merkleProofs)
      ).to.equal(true);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 123, 2, merkleProofs)
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 126, 0, merkleProofs)
      ).to.equal(false);
      expect(
        await collateralFilter.collateralSupported("0x4b1B53c6E31997f8954DaEA7A2bC0dD8fEF652Cc", 123, 0, merkleProofs)
      ).to.equal(false);
    });

    it("fail due to invalid context", async function () {
      /* Compute merkle proofs */
      const merkleProofs = MerkleTree.buildProofs(["123", "124", "125"], nodeCount, merkleTree);

      await expect(
        collateralFilter.collateralSupported(
          "0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b",
          125,
          2,
          merkleProofs.slice(0, merkleProofs.length - 2)
        )
      ).to.be.revertedWithCustomError(collateralFilter, "InvalidContext");

      await expect(
        collateralFilter.collateralSupported("0x9c0A02FF645DD52C7FA64d41638E7E7980E9703b", 125, 3, merkleProofs)
      ).to.be.revertedWithCustomError(collateralFilter, "InvalidContext");
    });
  });
});
