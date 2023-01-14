import { network } from "hardhat";

describe("Integration", function () {
  let snapshotId: string;

  before("deploy fixture", async () => {
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
