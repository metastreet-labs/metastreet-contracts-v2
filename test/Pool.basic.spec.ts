import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

describe("Pool (basic)", function () {
  let accounts: SignerWithAddress[];
  let snapshotId: string;

  before("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    /* FIXME implement */
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  describe("constants", async function () {
    it("matches expected implementation", async function () {
      /* FIXME implement */
    });
  });
});
