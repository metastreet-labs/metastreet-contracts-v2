import { expect } from "chai";
import { ethers, network } from "hardhat";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import { Pool, PoolFactory, UpgradeableBeacon, Ownable } from "../typechain";

import { getContractFactoryWithLibraries } from "./helpers/Deploy";

describe("Pool Filter Migration", function () {
  let accounts: SignerWithAddress[];
  let poolImpl: Pool;
  let wpunkPool: Pool;
  let autoglyphPool: Pool;
  let snapshotId: string;
  let poolFactoryAdmin: SignerWithAddress;
  let poolFactory: PoolFactory;
  let adminAccount: SignerWithAddress;

  const WPUNK_ADDRESS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
  const CRYPTO_PUNK_721_ADDRESS = "0x00000000000000343662D3FAD10D154530C0d4F1";
  const AUTOGLYPH_ADDRESS = "0xd4e4078ca3495DE5B1d4dB434BEbc5a986197782";
  const WPUNK_POOL = "0xb6c1078f6fd3e682f3c69f8f6e616476765749a7";
  const AUTOGLYPH_POOL = "0xc3acc8d730c95b0cd148ae389197552ae555631f";
  const POOL_FACTORY = "0x1c91c822F6C5e117A2abe2B33B0E64b850e67095";
  const UPGRADEABLE_BEACON = "0x599F3b4973881f8170fA71444c4BE3fa72A6086a";
  const COLLATERAL_LIQUIDATOR = "0xE0194F47040E2424b8a65cB5F7112a5DBE1F93Bf";
  const DELEGATE_REGISTRY_V1 = "0x00000000000076A84feF008CDAbe6409d2FE638B";
  const DELEGATE_REGISTRY_V2 = "0x00000000000000447e69651d841bD8D104Bed493";
  const ERC20_DEPOSIT_TOKEN_IMPL = "0x23b915eb10caFb2C5194e10D68932d7c6cC9AFF3";
  const ADMIN_ACCOUNT = "0x4Fe130BaB0CC799C8c497D3e4aA51c1F1FE2028b";

  before("deploy fixture", async function () {
    /* Skip test if no MAINNET_URL env variable */
    if (!process.env.MAINNET_URL) {
      this.skip();
    }

    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_URL,
          },
        },
      ],
    });

    accounts = await ethers.getSigners();

    /* Impersonate account with ether */
    adminAccount = await ethers.getImpersonatedSigner(ADMIN_ACCOUNT);

    /* Get gnosis safe */
    const gnosisSafe = await getOwner(POOL_FACTORY);

    /* Send gnosis safe 1 ether */
    const tx = {
      to: gnosisSafe,
      value: ethers.utils.parseEther("1"),
    };
    await adminAccount.sendTransaction(tx);

    /* Impersonate gnosis safe */
    poolFactoryAdmin = await ethers.getImpersonatedSigner(gnosisSafe);

    /* Pool factory contract */
    poolFactory = (await ethers.getContractAt("IPoolFactory", POOL_FACTORY)) as PoolFactory;

    const poolImplFactory = await getContractFactoryWithLibraries("WeightedRateCollectionPool", [
      "LiquidityLogic",
      "DepositLogic",
      "BorrowLogic",
      "ERC20DepositTokenFactory",
    ]);

    const upgradeableBeacon = (await ethers.getContractAt(
      "UpgradeableBeacon",
      UPGRADEABLE_BEACON
    )) as UpgradeableBeacon;

    console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
    console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

    /* Deploy new WeightedRateCollectionPool */
    poolImpl = (await poolImplFactory.deploy(
      COLLATERAL_LIQUIDATOR,
      DELEGATE_REGISTRY_V1,
      DELEGATE_REGISTRY_V2,
      ERC20_DEPOSIT_TOKEN_IMPL,
      []
    )) as Pool;
    await poolImpl.deployed();

    /* Upgrade beacon */
    await upgradeableBeacon.connect(poolFactoryAdmin).upgradeTo(poolImpl.address);

    console.log(`New Pool Implementation: ${await upgradeableBeacon.implementation()}`);
    console.log(`New Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

    wpunkPool = (await ethers.getContractAt("WeightedRateCollectionPool", WPUNK_POOL)) as Pool;
    autoglyphPool = (await ethers.getContractAt("WeightedRateCollectionPool", AUTOGLYPH_POOL)) as Pool;
  });

  beforeEach("snapshot blockchain", async () => {
    snapshotId = await network.provider.send("evm_snapshot", []);
  });

  afterEach("restore blockchain snapshot", async () => {
    await network.provider.send("evm_revert", [snapshotId]);
  });

  /****************************************************************************/
  /* Helper */
  /****************************************************************************/

  async function getImplementationVersion(address: string): Promise<string> {
    const contract = await ethers.getContractAt(["function IMPLEMENTATION_VERSION() view returns (string)"], address);
    return await contract.IMPLEMENTATION_VERSION();
  }

  async function getOwner(address: string): Promise<string> {
    const ownableContract = (await ethers.getContractAt("Ownable", address)) as Ownable;
    return await ownableContract.owner();
  }

  /****************************************************************************/
  /* Constants */
  /****************************************************************************/

  describe("constants", async function () {
    it("matches expected pool implementation name", async function () {
      expect(await wpunkPool.IMPLEMENTATION_NAME()).to.equal("WeightedRateCollectionPool");
    });
    it("matches expected collateral filter implementation name", async function () {
      expect(await wpunkPool.COLLATERAL_FILTER_NAME()).to.equal("CollectionCollateralFilter");
    });
  });

  /****************************************************************************/
  /* Storage */
  /****************************************************************************/

  describe("migration", async function () {
    it("migrate WPUNKS pool", async function () {
      let collateralTokens = await wpunkPool.collateralTokens();

      expect(collateralTokens[0]).to.equal(WPUNK_ADDRESS);
      expect(collateralTokens.length).to.equal(1);

      const contract = await ethers.getContractAt(["function migrate()"], WPUNK_POOL);
      await contract.migrate();

      collateralTokens = await wpunkPool.collateralTokens();

      expect(collateralTokens[0]).to.equal(WPUNK_ADDRESS);
      expect(collateralTokens[1]).to.equal(CRYPTO_PUNK_721_ADDRESS);
      expect(collateralTokens.length).to.equal(2);
    });

    it("migrate Autoglyphs pool", async function () {
      let collateralTokens = await autoglyphPool.collateralTokens();

      expect(collateralTokens[0]).to.equal(AUTOGLYPH_ADDRESS);
      expect(collateralTokens.length).to.equal(1);

      const contract = await ethers.getContractAt(["function migrate()"], AUTOGLYPH_POOL);
      await contract.migrate();

      collateralTokens = await autoglyphPool.collateralTokens();

      expect(collateralTokens[0]).to.equal(AUTOGLYPH_ADDRESS);
      expect(collateralTokens.length).to.equal(1);
    });

    it("fails on calling migrate a second time", async function () {
      const contract = await ethers.getContractAt(["function migrate()"], WPUNK_POOL);
      await contract.migrate();

      await expect(contract.migrate()).to.be.reverted;
    });
  });
});
