import { expect } from "chai";
import hre from "hardhat";

import fs from "fs";
import path from "path";

describe("Storage Layout", function () {
  let contractStorageLayout: { [key: string]: object } = {};

  before("deploy fixture", async () => {
    let buildInfos: { [key: string]: object } = {};

    /* Look up storage layout for each contract */
    for (const fullName of await hre.artifacts.getAllFullyQualifiedNames()) {
      const { sourceName, contractName } = await hre.artifacts.readArtifact(fullName);

      const artifactPath = await hre.artifacts.formArtifactPathFromFullyQualifiedName(fullName);
      const debugArtifactPath = artifactPath.replace(".json", ".dbg.json");
      const buildInfoPath = JSON.parse(fs.readFileSync(debugArtifactPath).toString()).buildInfo;

      if (!buildInfos[buildInfoPath]) {
        buildInfos[buildInfoPath] = JSON.parse(
          fs.readFileSync(path.join(path.dirname(debugArtifactPath), buildInfoPath))
        );
      }

      contractStorageLayout[contractName] =
        buildInfos[buildInfoPath].output?.contracts?.[sourceName]?.[contractName]?.storageLayout;
    }
  });

  /****************************************************************************/
  /* Lookup functions */
  /****************************************************************************/

  function lookupVariableStorage(contract: string, storageVariable: string): { slot: string; offset: number } {
    if (!contractStorageLayout[contract]) {
      throw new Error(`Missing storage layout for contract: ${contract}`);
    }

    const storage = contractStorageLayout[contract].storage;

    /* Find matching storage variable */
    for (const variable of storage) {
      if (variable.label === storageVariable) {
        return {
          slot: variable.slot,
          offset: variable.offset,
        };
      }
    }

    throw new Error(`Contract storage variable not found: ${storageVariable} for contract ${contract}`);
  }

  function lookupStructStorageLayout(
    contract: string,
    storageVariable: string
  ): { name: string; type: string; slot: string; offset: number }[] {
    if (!contractStorageLayout[contract]) {
      throw new Error(`Missing storage layout for contract: ${contract}`);
    }

    const storageLayout = contractStorageLayout[contract];

    /* Get the state variable slot to offset struct variable slot */
    const slot = storageLayout.storage?.find((variable: any) => variable.label === storageVariable)?.slot;
    if (!slot) {
      throw new Error(`Contract storage variable not found: ${storageVariable} for contract ${contract}`);
    }

    /* Get struct layout */
    const structTypeId = storageLayout.storage?.find((variable: any) => variable.label === storageVariable)?.type;
    const structDefinition = storageLayout.types[structTypeId];
    if (!structDefinition) {
      throw new Error(
        `Type definition for structure not found: type ${structTypeId}, storage variable ${storageVariable}, contract ${contract}`
      );
    }

    /* Get the struct name */
    const structName = structTypeId.match(/t_struct\((.*?)\)/);
    if (!structName || !structName[1]) {
      throw new Error(
        `Unexpected structure name for type ${structTypeId}, storage variable ${storageVariable}, contract ${contract}`
      );
    }

    let structStorageLayout: { name: string; type: string; slot: string; offset: string }[] = [];
    for (const member of structDefinition.members) {
      structStorageLayout.push({
        name: `${storageVariable}.${member.label}`,
        type: structName[1],
        slot: String(parseInt(member.slot) + parseInt(slot)),
        offset: member.offset,
      });
    }

    return structStorageLayout;
  }

  function lookupStructFieldStorage(
    contract: string,
    storageVariable: string,
    structField: string
  ): { slot: string; offset: number } {
    if (!contractStorageLayout[contract]) {
      throw new Error(`Missing storage layout for contract: ${contract}`);
    }

    const storageLayout = contractStorageLayout[contract];

    /* Get the state variable slot to offset struct variable slot */
    const slot = storageLayout.storage?.find((variable: any) => variable.label === storageVariable)?.slot;
    if (!slot) {
      throw new Error(`Contract storage variable not found: ${storageVariable} for contract ${contract}`);
    }

    /* Get struct layout */
    const structTypeId = storageLayout.storage?.find((variable: any) => variable.label === storageVariable)?.type;
    const structDefinition = storageLayout.types[structTypeId];
    if (!structDefinition) {
      throw new Error(
        `Type definition for structure not found: type ${structTypeId}, storage variable ${storageVariable}, contract ${contract}`
      );
    }

    for (const field of structDefinition.members) {
      if (field.label === structField) {
        return {
          slot: String(parseInt(field.slot) + parseInt(slot)),
          offset: field.offset,
        };
      }
    }

    throw new Error(
      `Structure field not found: field ${structField}, storage variable ${storageVariable}, contract ${contract}`
    );
  }

  function computeLinearStorageSize(contract: string): number {
    if (!contractStorageLayout[contract]) {
      throw new Error(`Missing storage layout for contract: ${contract}`);
    }

    const storage = contractStorageLayout[contract].storage;
    const types = contractStorageLayout[contract].types;

    if (storage.length == 0) {
      return 0;
    }

    const lastStorageVariable = storage[storage.length - 1];

    return (
      Number(lastStorageVariable.slot) * 32 +
      lastStorageVariable.offset +
      Number(types[lastStorageVariable.type].numberOfBytes)
    );
  }

  /****************************************************************************/
  /* Validate storage */
  /****************************************************************************/

  describe("#filter", async function () {
    it("CollectionCollateralFilter storage layout", async function () {
      const contractName = "CollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_aliases")).to.be.eql({ slot: "1", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(96);
    });

    it("MerkleCollectionCollateralFilter storage layout", async function () {
      const contractName = "MerkleCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_proofLength")).to.be.eql({ slot: "0", offset: 20 });
      expect(lookupVariableStorage(contractName, "_root")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_metadataURI")).to.be.eql({ slot: "2", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(96);
    });

    it("RangedCollectionCollateralFilter storage layout", async function () {
      const contractName = "RangedCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_startTokenId")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_endTokenId")).to.be.eql({ slot: "2", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(96);
    });

    it("SetCollectionCollateralFilter storage layout", async function () {
      const contractName = "SetCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenIds")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_tokenIds", "_inner")).to.be.eql({
        slot: "1",
        offset: 0,
      });
      expect(computeLinearStorageSize(contractName)).to.be.eql(96);
    });
  });

  describe("#erc20DepositTokenImplementation", async function () {
    it("ERC20DepositTokenImplementation storage layout", async function () {
      const contractName = "ERC20DepositTokenImplementation";

      expect(lookupVariableStorage(contractName, "_initialized")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_pool")).to.be.eql({ slot: "0", offset: 1 });
      expect(lookupVariableStorage(contractName, "_tick")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_allowances")).to.be.eql({ slot: "2", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(96);
    });
  });

  describe("#pool", async function () {
    it("WeightedRateCollectionPool storage layout", async function () {
      const contractName = "WeightedRateCollectionPool";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_storage")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "currencyToken")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeRate")).to.be.eql({ slot: "1", offset: 20 });
      expect(lookupStructFieldStorage(contractName, "_storage", "durations")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "rates")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "admin")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeBalance")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "liquidity")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "deposits")).to.be.eql({ slot: "7", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "loans")).to.be.eql({ slot: "8", offset: 0 });
      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "9", offset: 0 });
      expect(lookupVariableStorage(contractName, "_aliases")).to.be.eql({ slot: "10", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(384);
    });

    it("WeightedRateRangedCollectionPool storage layout", async function () {
      const contractName = "WeightedRateRangedCollectionPool";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_storage")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "currencyToken")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeRate")).to.be.eql({ slot: "1", offset: 20 });
      expect(lookupStructFieldStorage(contractName, "_storage", "durations")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "rates")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "admin")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeBalance")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "liquidity")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "deposits")).to.be.eql({ slot: "7", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "loans")).to.be.eql({ slot: "8", offset: 0 });
      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "9", offset: 0 });
      expect(lookupVariableStorage(contractName, "_startTokenId")).to.be.eql({ slot: "10", offset: 0 });
      expect(lookupVariableStorage(contractName, "_endTokenId")).to.be.eql({ slot: "11", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(384);
    });

    it("WeightedRateSetCollectionPool storage layout", async function () {
      const contractName = "WeightedRateSetCollectionPool";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_storage")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "currencyToken")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeRate")).to.be.eql({ slot: "1", offset: 20 });
      expect(lookupStructFieldStorage(contractName, "_storage", "durations")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "rates")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "admin")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeBalance")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "liquidity")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "deposits")).to.be.eql({ slot: "7", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "loans")).to.be.eql({ slot: "8", offset: 0 });
      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "9", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenIds")).to.be.eql({ slot: "10", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(384);
    });

    it("WeightedRateMerklePool storage layout", async function () {
      const contractName = "WeightedRateMerkleCollectionPool";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_storage")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "currencyToken")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeRate")).to.be.eql({ slot: "1", offset: 20 });
      expect(lookupStructFieldStorage(contractName, "_storage", "durations")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "rates")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "admin")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "adminFeeBalance")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "liquidity")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "deposits")).to.be.eql({ slot: "7", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_storage", "loans")).to.be.eql({ slot: "8", offset: 0 });
      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "9", offset: 0 });
      expect(lookupVariableStorage(contractName, "_proofLength")).to.be.eql({ slot: "9", offset: 20 });
      expect(lookupVariableStorage(contractName, "_root")).to.be.eql({ slot: "10", offset: 0 });
      expect(lookupVariableStorage(contractName, "_metadataURI")).to.be.eql({ slot: "11", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(384);
    });
  });

  describe("#liquidator", async function () {
    it("EnglishAuctionCollateralLiquidator storage layout", async function () {
      const contractName = "EnglishAuctionCollateralLiquidator";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_initialized")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_auctionDuration")).to.be.eql({ slot: "1", offset: 1 });
      expect(lookupVariableStorage(contractName, "_timeExtensionWindow")).to.be.eql({ slot: "1", offset: 9 });
      expect(lookupVariableStorage(contractName, "_timeExtension")).to.be.eql({ slot: "1", offset: 17 });
      expect(lookupVariableStorage(contractName, "_minimumBidBasisPoints")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_auctions")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupVariableStorage(contractName, "_liquidations")).to.be.eql({ slot: "4", offset: 0 });
    });
  });

  describe("#wrapper", async function () {
    it("BundleCollateralWrapper storage layout", async function () {
      const contractName = "BundleCollateralWrapper";

      expect(lookupVariableStorage(contractName, "_name")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_symbol")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_owners")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_balances")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenApprovals")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupVariableStorage(contractName, "_operatorApprovals")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "6", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(224);
    });

    it("ERC1155CollateralWrapper storage layout", async function () {
      const contractName = "ERC1155CollateralWrapper";

      expect(lookupVariableStorage(contractName, "_name")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_symbol")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_owners")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_balances")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenApprovals")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupVariableStorage(contractName, "_operatorApprovals")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupVariableStorage(contractName, "_nonce")).to.be.eql({ slot: "7", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(256);
    });

    it("PunkCollateralWrapper storage layout", async function () {
      const contractName = "PunkCollateralWrapper";

      expect(lookupVariableStorage(contractName, "_name")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_symbol")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_owners")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_balances")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenApprovals")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupVariableStorage(contractName, "_operatorApprovals")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "6", offset: 0 });
      expect(computeLinearStorageSize(contractName)).to.be.eql(224);
    });
  });

  describe("#poolFactory", async function () {
    it("PoolFactory storage layout", async function () {
      const contractName = "PoolFactory";

      expect(lookupVariableStorage(contractName, "_owner")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_initialized")).to.be.eql({ slot: "0", offset: 20 });
      expect(lookupVariableStorage(contractName, "_pools")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupStructFieldStorage(contractName, "_pools", "_inner")).to.be.eql({
        slot: "1",
        offset: 0,
      });
      expect(lookupVariableStorage(contractName, "_allowedImplementations")).to.be.eql({
        slot: "3",
        offset: 0,
      });
      expect(lookupStructFieldStorage(contractName, "_allowedImplementations", "_inner")).to.be.eql({
        slot: "3",
        offset: 0,
      });
      expect(computeLinearStorageSize(contractName)).to.be.eql(160);
    });
  });
});
