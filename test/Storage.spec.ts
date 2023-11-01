import { expect } from "chai";
import hre from "hardhat";

import fs from "fs";
import util from "util";

const stat = util.promisify(fs.stat);

interface SourceNames {
  [key: string]: string;
}

describe("Storage Layout", function () {
  let artifact: any;
  let sourceNames: SourceNames = {};

  const getLatestBuildInfo = async (filePaths: string[]) => {
    let latestFile;
    let latestTime = 0;

    for (const filePath of filePaths) {
      const stats = await stat(filePath);
      const mtime = new Date(util.inspect(stats.mtime));

      if (mtime.getTime() > latestTime) {
        latestTime = mtime.getTime();
        latestFile = filePath;
      }
    }

    return latestFile;
  };

  before("deploy fixture", async () => {
    /* Get all build infos */
    const buildInfos = await hre.artifacts.getBuildInfoPaths();

    if (buildInfos.length === 0) {
      throw new Error("No build info found.");
    }

    /* Get latest build info */
    const latestBuildInfo = await getLatestBuildInfo(buildInfos);

    /* Parse build info to get artifact */
    artifact = JSON.parse(fs.readFileSync(latestBuildInfo).toString());

    /* Get contract name paired with source name */
    for (const fullName of await hre.artifacts.getAllFullyQualifiedNames()) {
      const { sourceName, contractName } = await hre.artifacts.readArtifact(fullName);
      sourceNames[contractName] = sourceName;
    }
  });

  /****************************************************************************/
  /* Lookup functions */
  /****************************************************************************/

  function lookupContractStorage(contract: string) {
    const storages: Array<{ name: string; slot: string; offset: string }> = [];
    const sourceName = sourceNames[contract];
    const storage = artifact.output?.contracts?.[sourceName]?.[contract]?.storageLayout?.storage;
    if (!storage) {
      throw new Error("Invalid contract or source name");
    }
    for (const stateVariable of storage) {
      storages.push({
        name: stateVariable.label,
        slot: stateVariable.slot,
        offset: stateVariable.offset,
      });
    }

    return storages;
  }

  function lookupVariableStorage(contract: string, variable: string) {
    const sourceName = sourceNames[contract];
    const storage = artifact.output?.contracts?.[sourceName]?.[contract]?.storageLayout?.storage;
    if (!storage) {
      throw new Error("Invalid contract or source name");
    }
    for (const stateVariable of storage) {
      if (stateVariable.label === variable) {
        return {
          slot: stateVariable.slot,
          offset: stateVariable.offset,
        };
      }
    }
    throw new Error("Invalid variable provided");
  }

  /****************************************************************************/
  /* Validate storage */
  /****************************************************************************/

  describe("#filter", async function () {
    it("CollectionCollateralFilter storage layout", async function () {
      const contractName = "CollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
    });

    it("MerkleCollectionCollateralFilter storage layout", async function () {
      const contractName = "MerkleCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_proofLength")).to.be.eql({ slot: "0", offset: 20 });
      expect(lookupVariableStorage(contractName, "_root")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_metadataURI")).to.be.eql({ slot: "2", offset: 0 });
    });

    it("RangedCollectionCollateralFilter storage layout", async function () {
      const contractName = "RangedCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_startTokenId")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_endTokenId")).to.be.eql({ slot: "2", offset: 0 });
    });

    it("SetCollectionCollateralFilter storage layout", async function () {
      const contractName = "SetCollectionCollateralFilter";

      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokenIds")).to.be.eql({ slot: "1", offset: 0 });
    });
  });

  describe("#depositERC20", async function () {
    it("DepositERC20 storage layout", async function () {
      const contractName = "DepositERC20";

      expect(lookupVariableStorage(contractName, "_initialized")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_pool")).to.be.eql({ slot: "0", offset: 1 });
      expect(lookupVariableStorage(contractName, "_tick")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_currencyToken")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_allowances")).to.be.eql({ slot: "3", offset: 0 });
    });
  });

  describe("#pool", async function () {
    it("WeightedRateCollectionPool storage layout", async function () {
      const contractName = "WeightedRateCollectionPool";

      expect(lookupVariableStorage(contractName, "_status")).to.be.eql({ slot: "0", offset: 0 });
      expect(lookupVariableStorage(contractName, "_currencyToken")).to.be.eql({ slot: "1", offset: 0 });
      expect(lookupVariableStorage(contractName, "_adminFeeRate")).to.be.eql({ slot: "1", offset: 20 });
      expect(lookupVariableStorage(contractName, "_durations")).to.be.eql({ slot: "2", offset: 0 });
      expect(lookupVariableStorage(contractName, "_rates")).to.be.eql({ slot: "3", offset: 0 });
      expect(lookupVariableStorage(contractName, "_admin")).to.be.eql({ slot: "4", offset: 0 });
      expect(lookupVariableStorage(contractName, "_adminFeeBalance")).to.be.eql({ slot: "5", offset: 0 });
      expect(lookupVariableStorage(contractName, "_liquidity")).to.be.eql({ slot: "6", offset: 0 });
      expect(lookupVariableStorage(contractName, "_deposits")).to.be.eql({ slot: "7", offset: 0 });
      expect(lookupVariableStorage(contractName, "_loans")).to.be.eql({ slot: "8", offset: 0 });
      expect(lookupVariableStorage(contractName, "_token")).to.be.eql({ slot: "9", offset: 0 });
      expect(lookupVariableStorage(contractName, "_tokens")).to.be.eql({ slot: "10", offset: 0 });
      expect(lookupVariableStorage(contractName, "_initialized")).to.be.eql({ slot: "11", offset: 0 });
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
    });
  });
});
