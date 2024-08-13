import { ethers } from "ethers";
import { default as hre, artifacts } from "hardhat";
import { Command, InvalidArgumentError } from "commander";
import fs from "fs";

import { PoolFactory, UpgradeableBeacon, ITransparentUpgradeableProxy, Ownable } from "../typechain";

interface LoanReceipt {
  version: bigint;
  principal: bigint;
  repayment: bigint;
  borrower: string;
  maturity: bigint;
  duration: bigint;
  collateralToken: string;
  collateralTokenId: bigint;
  collateralWrapperContextLen: bigint;
  collateralWrapperContext: string;
  nodeReceipts: any[];
}

/******************************************************************************/
/* Global Signer */
/******************************************************************************/

let signer: ethers.Signer | undefined;

/******************************************************************************/
/* Deployment */
/******************************************************************************/

class Deployment {
  name?: string;
  chainId?: bigint;
  poolFactory?: string;
  /* Contract Name to Proxy and Beacon Addresses */
  collateralLiquidators: { [name: string]: { address: string; beacon: string } };
  /* Contract Name to Proxy Address */
  collateralWrappers: { [name: string]: string };
  /* Deployment Name to Beacon Address */
  poolBeacons: { [name: string]: string };
  /* Noop Pool Implementation Address */
  noopPoolImpl?: string;
  /* ERC20 Deposit Token Implementation Address */
  erc20DepositTokenImpl?: string;

  constructor(
    name?: string,
    chainId?: bigint,
    poolFactory?: string,
    collateralLiquidators?: { [name: string]: { address: string; beacon: string } },
    collateralWrappers?: { [name: string]: string },
    poolBeacons?: { [name: string]: string },
    noopPoolImpl?: string,
    erc20DepositTokenImpl?: string
  ) {
    this.name = name;
    this.chainId = chainId;
    this.poolFactory = poolFactory;
    this.collateralLiquidators = collateralLiquidators || {};
    this.collateralWrappers = collateralWrappers || {};
    this.poolBeacons = poolBeacons || {};
    this.noopPoolImpl = noopPoolImpl;
    this.erc20DepositTokenImpl = erc20DepositTokenImpl;
  }

  static fromFile(path: string): Deployment {
    const obj: Deployment = JSON.parse(fs.readFileSync(path, "utf-8"));
    return new Deployment(
      obj.name,
      obj.chainId ? BigInt(obj.chainId) : undefined,
      obj.poolFactory,
      obj.collateralLiquidators,
      obj.collateralWrappers,
      obj.poolBeacons,
      obj.noopPoolImpl,
      obj.erc20DepositTokenImpl
    );
  }

  static fromScratch(network: ethers.Network): Deployment {
    return new Deployment(network.name, network.chainId);
  }

  toFile(path: string) {
    fs.writeFileSync(path, JSON.stringify({ ...this, chainId: Number(this.chainId) }), { encoding: "utf-8" });
  }

  dump() {
    console.log(`Network:                   ${this.name}`);
    console.log(`Chain ID:                  ${this.chainId}`);
    console.log(`Pool Factory:              ${this.poolFactory || "Not deployed"}`);
    console.log(`Collateral Liquidators:    ${JSON.stringify(this.collateralLiquidators, null, 2)}`);
    console.log(`Collateral Wrappers:       ${JSON.stringify(this.collateralWrappers, null, 2)}`);
    console.log(`Pool Beacons:              ${JSON.stringify(this.poolBeacons, null, 2)}`);
    console.log(`Noop Pool Implementation:  ${this.noopPoolImpl || "Not deployed"}`);
    console.log(`ERC20 Implementation:      ${this.erc20DepositTokenImpl || "Not deployed"}`);
  }
}

/******************************************************************************/
/* Helper Functions */
/******************************************************************************/

async function getImplementationVersion(address: string): Promise<string> {
  const contract = await hre.ethers.getContractAt(["function IMPLEMENTATION_VERSION() view returns (string)"], address);
  return await contract.IMPLEMENTATION_VERSION();
}

async function getOwner(address: string): Promise<string> {
  const ownableContract = (await hre.ethers.getContractAt("Ownable", address)) as Ownable;
  return await ownableContract.owner();
}

async function getBeaconImplementation(address: string): Promise<string> {
  const upgradeableBeacon = (await hre.ethers.getContractAt("UpgradeableBeacon", address)) as UpgradeableBeacon;
  return await upgradeableBeacon.implementation();
}

async function getTransparentProxyImplementation(address: string): Promise<string> {
  const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationSlotData = await hre.ethers.provider.getStorage(address, implementationSlot);
  return ethers.getAddress(ethers.dataSlice(implementationSlotData, 12));
}

async function getTransparentProxyAdmin(address: string): Promise<string> {
  const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const adminSlotData = await hre.ethers.provider.getStorage(address, adminSlot);
  return ethers.getAddress(ethers.dataSlice(adminSlotData, 12));
}

async function getCollateralWrappers(address: string): Promise<string[]> {
  const contract = await hre.ethers.getContractAt(["function collateralWrappers() view returns (address[])"], address);
  return (await contract.collateralWrappers()).filter((e: string) => e !== ethers.ZeroAddress);
}

async function getCollateralWrapperName(address: string): Promise<string> {
  const contract = await hre.ethers.getContractAt(["function name() view returns (string)"], address);
  return await contract.name();
}

async function getAddressType(address: string): Promise<"EOA" | "Contract"> {
  return (await hre.ethers.provider.getCode(address)) === "0x" ? "EOA" : "Contract";
}

function decodeArgs(args: string[]): (string | string[])[] {
  /* FIXME hack to handle arrays */
  return args.map((arg) =>
    arg.startsWith("[") && arg.endsWith("]")
      ? arg
          .slice(1, -1)
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "")
      : arg
  );
}

/******************************************************************************/
/* Deployment Commands */
/******************************************************************************/

async function deploymentShow(deployment: Deployment) {
  console.log("Pool Factory");
  console.log(`  Address: ${deployment.poolFactory || "Not Deployed"}`);
  if (deployment.poolFactory) {
    const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;
    const impl = await poolFactory.getImplementation();
    const version = await getImplementationVersion(impl);
    const owner = await getOwner(await poolFactory.getAddress());
    console.log(`  Impl:    ${impl}`);
    console.log(`  Version: ${version}`);
    console.log(`  Owner:   ${owner} (${await getAddressType(owner)})`);
  } else {
    console.log(`  Impl:    N/A`);
    console.log(`  Version: N/A`);
  }

  console.log("\nCollateral Liquidators");
  for (const contractName in deployment.collateralLiquidators) {
    const collateralLiquidator = deployment.collateralLiquidators[contractName];
    const impl = await getBeaconImplementation(collateralLiquidator.beacon);
    const version = await getImplementationVersion(impl);
    const owner = await getOwner(collateralLiquidator.beacon);

    console.log(`  ${contractName}`);
    console.log(`      Address: ${collateralLiquidator.address}`);
    console.log(`      Beacon:  ${collateralLiquidator.beacon}`);
    console.log(`      Impl:    ${impl}`);
    console.log(`      Version: ${version}`);
    console.log(`      Owner:   ${owner} (${await getAddressType(owner)})`);
    console.log("");
  }

  console.log("\nCollateral Wrappers");
  for (const contractName in deployment.collateralWrappers) {
    const collateralWrapper = deployment.collateralWrappers[contractName];
    const impl = await getTransparentProxyImplementation(collateralWrapper);
    const version = await getImplementationVersion(impl);
    const owner = await getTransparentProxyAdmin(collateralWrapper);

    console.log(`  ${contractName}`);
    console.log(`      Address: ${collateralWrapper}`);
    console.log(`      Impl:    ${impl}`);
    console.log(`      Version: ${version}`);
    console.log(`      Owner:   ${owner} (${await getAddressType(owner)})`);
    console.log("");
  }

  console.log("\nPool Implementations");
  for (const name in deployment.poolBeacons) {
    const poolImplementation = deployment.poolBeacons[name];
    const impl = await getBeaconImplementation(poolImplementation);
    const version = await getImplementationVersion(impl);
    const owner = await getOwner(poolImplementation);

    console.log(`  ${name}`);
    console.log(`      Beacon:  ${poolImplementation}`);
    console.log(`      Impl:    ${impl}`);
    console.log(`      Version: ${version}`);
    console.log(`      Owner:   ${owner} (${await getAddressType(owner)})`);
    console.log(`      Collateral Wrappers:`);
    for (const collateralWrapper of await getCollateralWrappers(impl)) {
      const impl = await getTransparentProxyImplementation(collateralWrapper);
      const name = await getCollateralWrapperName(impl);
      const version = await getImplementationVersion(impl);
      console.log(`          ${collateralWrapper} (${name} - v${version})`);
    }
    console.log("");
  }

  console.log("\nNoop Pool Implementation");
  console.log(`  Address: ${deployment.noopPoolImpl || "Not Deployed"}`);
  if (deployment.noopPoolImpl) {
    console.log(`  Version: ${await getImplementationVersion(deployment.noopPoolImpl)}`);
  } else {
    console.log(`  Version: N/A`);
  }

  console.log("\nERC20 Deposit Token Implementation");
  console.log(`  Address: ${deployment.erc20DepositTokenImpl || "Not Deployed"}`);
  if (deployment.erc20DepositTokenImpl) {
    console.log(`  Version: ${await getImplementationVersion(deployment.erc20DepositTokenImpl)}`);
  } else {
    console.log(`  Version: N/A`);
  }
}

/******************************************************************************/
/* Pool Factory Commands */
/******************************************************************************/

async function poolFactoryDeploy(deployment: Deployment) {
  if (deployment.poolFactory) {
    console.error("Pool factory already deployed.");
    return;
  }

  const poolFactoryFactory = await hre.ethers.getContractFactory("PoolFactory", signer);
  const erc1967ProxyFactory = await hre.ethers.getContractFactory("ERC1967Proxy", signer);

  /* Deploy Pool Factory implementation */
  const poolFactoryImpl = await poolFactoryFactory.deploy();
  await poolFactoryImpl.waitForDeployment();

  /* Deploy Pool Factory */
  const poolFactory = await erc1967ProxyFactory.deploy(
    await poolFactoryImpl.getAddress(),
    poolFactoryImpl.interface.encodeFunctionData("initialize")
  );
  await poolFactory.waitForDeployment();
  console.log(`Pool Factory: ${await poolFactory.getAddress()}`);

  deployment.poolFactory = await poolFactory.getAddress();
}

async function poolFactoryUpgrade(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;
  const poolFactoryFactory = await hre.ethers.getContractFactory("PoolFactory", signer);

  console.log(`Old Pool Factory Implementation: ${await poolFactory.getImplementation()}`);
  console.log(
    `Old Pool Factory Version:        ${await getImplementationVersion(await poolFactory.getImplementation())}`
  );

  /* Deploy Pool Factory implementation */
  const poolFactoryImpl = await poolFactoryFactory.deploy();
  await poolFactoryImpl.waitForDeployment();

  console.log(`New Pool Factory Implementation: ${await poolFactoryImpl.getAddress()}`);
  console.log(`New Pool Factory Version:        ${await getImplementationVersion(await poolFactoryImpl.getAddress())}`);

  /* Upgrade Pool Factory implementation */
  if ((await signer!.getAddress()) === (await getOwner(await poolFactory.getAddress()))) {
    await poolFactory.upgradeToAndCall(await poolFactoryImpl.getAddress(), "0x");
  } else {
    const calldata = (await poolFactory.upgradeToAndCall.populateTransaction(await poolFactoryImpl.getAddress(), "0x"))
      .data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await poolFactory.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolFactoryList(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;

  const pools = await poolFactory.getPools();

  console.log("Pools");
  for (const pool of pools) {
    console.log(`    ${pool}`);
  }
}

async function poolFactoryListImplementations(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;

  const impls = await poolFactory.getPoolImplementations();

  console.log("Pool Implementations");
  for (const impl of impls) {
    console.log(`    ${impl}`);
  }
}

async function poolFactoryAddImplementation(deployment: Deployment, implementation: string) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  if ((await signer!.getAddress()) === (await getOwner(await poolFactory.getAddress()))) {
    await poolFactory.addPoolImplementation(implementation);
  } else {
    const calldata = (await poolFactory.addPoolImplementation.populateTransaction(implementation)).data;
    console.log(`Add Pool Implementation Calldata`);
    console.log(`  Target:   ${await poolFactory.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolFactoryRemoveImplementation(deployment: Deployment, implementation: string) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  if ((await signer!.getAddress()) === (await getOwner(await poolFactory.getAddress()))) {
    await poolFactory.removePoolImplementation(implementation);
  } else {
    const calldata = (await poolFactory.removePoolImplementation.populateTransaction(implementation)).data;
    console.log(`Remove Pool Implementation Calldata`);
    console.log(`  Target:   ${await poolFactory.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolFactorySetAdminFee(
  deployment: Deployment,
  pool: string,
  rate: number,
  feeShareRecipient: string,
  feeShareSplit: number
) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await hre.ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  if ((await signer!.getAddress()) === (await getOwner(await poolFactory.getAddress()))) {
    await poolFactory.setAdminFee(pool, rate, feeShareRecipient, feeShareSplit);
  } else {
    const calldata = (await poolFactory.setAdminFee.populateTransaction(pool, rate, feeShareRecipient, feeShareSplit))
      .data;
    console.log(`Set Admin Fee Calldata`);
    console.log(`  Target:   ${await poolFactory.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Collateral Liquidator Commands */
/******************************************************************************/

async function collateralLiquidatorDeploy(
  deployment: Deployment,
  contractName: string,
  ctorArgs: string[],
  initArgs: string[]
) {
  if (deployment.collateralLiquidators[contractName]) {
    console.error(`Collateral liquidator ${contractName} already deployed.`);
    return;
  }

  const collateralLiquidatorFactory = await hre.ethers.getContractFactory(contractName, signer);
  const upgradeableBeaconFactory = await hre.ethers.getContractFactory("UpgradeableBeacon", signer);
  const beaconProxyFactory = await hre.ethers.getContractFactory("BeaconProxy", signer);

  /* Deploy implementation contract */
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy(...decodeArgs(ctorArgs));
  await collateralLiquidatorImpl.waitForDeployment();
  console.log(`Collateral Liquidator Implementation: ${await collateralLiquidatorImpl.getAddress()}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(await collateralLiquidatorImpl.getAddress());
  await upgradeableBeacon.waitForDeployment();
  console.log(`Collateral Liquidator Beacon:         ${await upgradeableBeacon.getAddress()}`);

  /* Deploy beacon proxy */
  const beaconProxy = await beaconProxyFactory.deploy(
    await upgradeableBeacon.getAddress(),
    collateralLiquidatorImpl.interface.encodeFunctionData("initialize", decodeArgs(initArgs))
  );
  await beaconProxy.waitForDeployment();
  console.log(`Collateral Liquidator Proxy:          ${await beaconProxy.getAddress()}`);

  deployment.collateralLiquidators[contractName] = {
    address: await beaconProxy.getAddress(),
    beacon: await upgradeableBeacon.getAddress(),
  };
}

async function collateralLiquidatorUpgrade(deployment: Deployment, contractName: string, args: string[]) {
  if (!deployment.collateralLiquidators[contractName]) {
    console.error(`Collateral liquidator ${contractName} not deployed.`);
    return;
  }

  const upgradeableBeacon = (await hre.ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.collateralLiquidators[contractName].beacon,
    signer
  )) as UpgradeableBeacon;
  const collateralLiquidatorFactory = await hre.ethers.getContractFactory(contractName, signer);

  console.log(`Old Collateral Liquidator Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(
    `Old Collateral Liquidator Version:        ${await getImplementationVersion(
      await upgradeableBeacon.implementation()
    )}`
  );

  /* Deploy new implementation contract */
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy(...decodeArgs(args));
  await collateralLiquidatorImpl.waitForDeployment();

  console.log(`New Collateral Liquidator Implementation: ${await collateralLiquidatorImpl.getAddress()}`);
  console.log(
    `New Collateral Liquidator Version:        ${await getImplementationVersion(await collateralLiquidatorImpl.getAddress())}`
  );

  /* Upgrade beacon */
  if ((await signer!.getAddress()) === (await getOwner(await upgradeableBeacon.getAddress()))) {
    await upgradeableBeacon.upgradeTo(await collateralLiquidatorImpl.getAddress());
  } else {
    const calldata = (
      await upgradeableBeacon.upgradeTo.populateTransaction(await collateralLiquidatorImpl.getAddress())
    ).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await upgradeableBeacon.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Collateral Wrapper Commands */
/******************************************************************************/

async function collateralWrapperDeploy(deployment: Deployment, contractName: string, args: string[]) {
  if (deployment.collateralWrappers[contractName]) {
    console.error(`Collateral wrapper ${contractName} already deployed.`);
    return;
  }

  const collateralWrapperFactory = await hre.ethers.getContractFactory(contractName, signer);
  const transparentUpgradeableProxyFactory = await hre.ethers.getContractFactory("TransparentUpgradeableProxy", signer);

  /* Deploy implementation contract */
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...decodeArgs(args));
  await collateralWrapperImpl.waitForDeployment();
  console.log(`Collateral Wrapper Implementation: ${await collateralWrapperImpl.getAddress()}`);

  /* Deploy transparent proxy */
  const collateralWrapper = await transparentUpgradeableProxyFactory.deploy(
    await collateralWrapperImpl.getAddress(),
    await signer!.getAddress(),
    "0x"
  );
  await collateralWrapper.waitForDeployment();
  console.log(`Collateral Wrapper Proxy:          ${await collateralWrapper.getAddress()}`);

  deployment.collateralWrappers[contractName] = await collateralWrapper.getAddress();
}

async function collateralWrapperUpgrade(deployment: Deployment, contractName: string, args: string[]) {
  if (!deployment.collateralWrappers[contractName]) {
    console.error(`Collateral wrapper ${contractName} not deployed.`);
    return;
  }

  const collateralWrapperProxy = (await hre.ethers.getContractAt(
    "ITransparentUpgradeableProxy",
    deployment.collateralWrappers[contractName],
    signer
  )) as ITransparentUpgradeableProxy;
  const collateralWrapperFactory = await hre.ethers.getContractFactory(contractName, signer);

  console.log(
    `Old Collateral Wrapper Implementation: ${await getTransparentProxyImplementation(await collateralWrapperProxy.getAddress())}`
  );

  /* Deploy new implementation contract */
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...decodeArgs(args));
  await collateralWrapperImpl.waitForDeployment();

  console.log(`New Collateral Wrapper Implementation: ${await collateralWrapperImpl.getAddress()}`);

  /* Upgrade proxy */
  if ((await signer!.getAddress()) === (await getTransparentProxyAdmin(await collateralWrapperProxy.getAddress()))) {
    await collateralWrapperProxy.upgradeTo(await collateralWrapperImpl.getAddress());
  } else {
    const calldata = (
      await collateralWrapperProxy.upgradeTo.populateTransaction(await collateralWrapperImpl.getAddress())
    ).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await collateralWrapperProxy.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Pool Implementation Commands */
/******************************************************************************/

async function libraryCacheLookup(deployment: Deployment, bytecodeHash: string): Promise<string | undefined> {
  const path = `deployments/.cache/libraries-${deployment.name}-${deployment.chainId}.json`;
  const cache: { [hash: string]: string } = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf-8")) : {};

  return cache[bytecodeHash];
}

async function libraryCacheStore(deployment: Deployment, bytecodeHash: string, deployedAddress: string): Promise<void> {
  const path = `deployments/.cache/libraries-${deployment.name}-${deployment.chainId}.json`;
  const cache: { [hash: string]: string } = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf-8")) : {};

  cache[bytecodeHash] = deployedAddress;

  if (!fs.existsSync("deployments/.cache/")) fs.mkdirSync("deployments/.cache/");
  fs.writeFileSync(path, JSON.stringify(cache), { encoding: "utf-8" });
}

async function poolImplementationFactory(
  deployment: Deployment,
  contractName: string
): Promise<ethers.ContractFactory> {
  /* Lookup libraries for Pool implementation contract */
  const poolImplLinkReferences = (await artifacts.readArtifact(contractName)).linkReferences;
  const libraryEntries = Object.entries(poolImplLinkReferences).flatMap(([k, v]) =>
    Object.keys(v).map((v) => ({ fullName: `${k}:${v}`, name: `${v}` }))
  );

  /* Deploy libraries */
  const libraries: { [key: string]: string } = {};
  console.log();
  for (const libraryEntry of libraryEntries) {
    const libFactory = await hre.ethers.getContractFactory(libraryEntry.fullName, signer);
    const libBytecodeHash = ethers.keccak256(libFactory.bytecode);

    const cachedAddress = await libraryCacheLookup(deployment, libBytecodeHash);
    if (cachedAddress) {
      console.log(`Library ${libraryEntry.name}: ${cachedAddress} (cached)`);

      libraries[libraryEntry.fullName] = cachedAddress;
    } else {
      const lib = await libFactory.deploy();
      await lib.waitForDeployment();

      console.log(`Library ${libraryEntry.name}: ${await lib.getAddress()}`);

      await libraryCacheStore(deployment, libBytecodeHash, await lib.getAddress());

      libraries[libraryEntry.fullName] = await lib.getAddress();
    }
  }
  console.log();

  return await hre.ethers.getContractFactory(contractName, { libraries, signer });
}

async function poolImplementationDeploy(deployment: Deployment, name: string, contractName: string, args: string[]) {
  if (deployment.poolBeacons[name]) {
    console.error(`Pool implementation ${name} already deployed.`);
    return;
  }

  /* Deploy implementation contract */
  const poolFactory = await poolImplementationFactory(deployment, contractName);
  const poolImpl = await poolFactory.deploy(...decodeArgs(args));
  await poolImpl.waitForDeployment();
  console.log(`Pool Implementation: ${await poolImpl.getAddress()}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeaconFactory = await hre.ethers.getContractFactory("UpgradeableBeacon", signer);
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(await poolImpl.getAddress());
  await upgradeableBeacon.waitForDeployment();
  console.log(`Pool Beacon:         ${await upgradeableBeacon.getAddress()}`);

  deployment.poolBeacons[name] = await upgradeableBeacon.getAddress();
}

async function poolImplementationUpgrade(deployment: Deployment, name: string, contractName: string, args: string[]) {
  if (!deployment.poolBeacons[name]) {
    console.error(`Pool implementation ${name} not deployed.`);
    return;
  }

  const upgradeableBeacon = (await hre.ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.poolBeacons[name],
    signer
  )) as UpgradeableBeacon;

  console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

  /* Deploy new implementation contract */
  const poolFactory = await poolImplementationFactory(deployment, contractName);
  const poolImpl = await poolFactory.deploy(...decodeArgs(args));
  await poolImpl.waitForDeployment();

  /* Validate major version number of upgrade */
  const oldPoolVersion = await getImplementationVersion(await upgradeableBeacon.implementation());
  const newPoolVersion = await getImplementationVersion(await poolImpl.getAddress());
  const [oldPoolVersionMajor, newPoolVersionMajor] = [oldPoolVersion.split(".")[0], newPoolVersion.split(".")[0]];
  if (oldPoolVersionMajor !== "0" && oldPoolVersionMajor !== newPoolVersionMajor) {
    console.error(
      `Incompatible upgrade from version ${oldPoolVersion} to version ${newPoolVersion} (major number mismatch).`
    );
    return;
  }

  console.log(`New Pool Implementation: ${await poolImpl.getAddress()}`);
  console.log(`New Pool Version:        ${await getImplementationVersion(await poolImpl.getAddress())}`);

  /* Upgrade beacon */
  if ((await signer!.getAddress()) === (await getOwner(await upgradeableBeacon.getAddress()))) {
    await upgradeableBeacon.upgradeTo(await poolImpl.getAddress());
  } else {
    const calldata = (await upgradeableBeacon.upgradeTo.populateTransaction(await poolImpl.getAddress())).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await upgradeableBeacon.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolImplementationPause(deployment: Deployment, name: string) {
  if (!deployment.poolBeacons[name]) {
    console.error(`Pool implementation ${name} not deployed.`);
    return;
  }

  if (!deployment.noopPoolImpl) {
    console.error(`Noop pool implementation not deployed.`);
    return;
  }

  const upgradeableBeacon = (await hre.ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.poolBeacons[name],
    signer
  )) as UpgradeableBeacon;

  console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

  console.log(`New Pool Implementation: ${deployment.noopPoolImpl}`);
  console.log(`New Pool Version:        ${await getImplementationVersion(deployment.noopPoolImpl)}`);

  /* Upgrade beacon to noop pool */
  if ((await signer!.getAddress()) === (await getOwner(await upgradeableBeacon.getAddress()))) {
    await upgradeableBeacon.upgradeTo(deployment.noopPoolImpl);
  } else {
    const calldata = (await upgradeableBeacon.upgradeTo.populateTransaction(deployment.noopPoolImpl)).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await upgradeableBeacon.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Decode LoanReceipt */
/******************************************************************************/

async function decodeLoanReceipt(deployment: Deployment, loanReceipt: string) {
  const poolImplementation = deployment.poolBeacons["v2.x-collection"];
  const address = await getBeaconImplementation(poolImplementation);

  const contract = await hre.ethers.getContractAt("Pool", address);

  const result: LoanReceipt = await contract.decodeLoanReceipt(loanReceipt);

  console.log(`Decoded loanReceipt:`);
  console.log(result);
}

/******************************************************************************/
/* Noop Pool Commands */
/******************************************************************************/

async function noopPoolImplementationDeploy(deployment: Deployment) {
  if (deployment.noopPoolImpl) {
    console.error(`Noop Pool Implementation already deployed.`);
    return;
  }

  const noopPoolFactory = await hre.ethers.getContractFactory("NoopPool", signer);

  /* Deploy noop pool implementation */
  const noopPoolImpl = await noopPoolFactory.deploy();
  await noopPoolImpl.waitForDeployment();
  console.log(`Noop Pool Implementation: ${await noopPoolImpl.getAddress()}`);

  deployment.noopPoolImpl = await noopPoolImpl.getAddress();
}

/******************************************************************************/
/* ERC20 Deposit Token Commands */
/******************************************************************************/

async function erc20DepositTokenImplementationDeploy(deployment: Deployment) {
  const erc20DepositTokenImplFactory = await hre.ethers.getContractFactory("ERC20DepositTokenImplementation", signer);

  /* Deploy ERC20 Deposit Token Implementation */
  const erc20DepositTokenImpl = await erc20DepositTokenImplFactory.deploy();
  await erc20DepositTokenImpl.waitForDeployment();
  console.log(`ERC20 Deposit Token Implementation: ${await erc20DepositTokenImpl.getAddress()}`);

  deployment.erc20DepositTokenImpl = await erc20DepositTokenImpl.getAddress();
}

/******************************************************************************/
/* Price Oracle Commands */
/******************************************************************************/

async function priceOracleDeploy(contractName: string, args: string[]) {
  const priceOracleFactory = await hre.ethers.getContractFactory(contractName, signer);
  const transparentUpgradeableProxyFactory = await hre.ethers.getContractFactory("TransparentUpgradeableProxy", signer);

  /* Deploy implementation contract */
  const priceOracleImpl = await priceOracleFactory.deploy(...decodeArgs(args));
  await priceOracleImpl.waitForDeployment();
  console.log(`${contractName} Implementation: ${await priceOracleImpl.getAddress()}`);

  /* Deploy transparent proxy */
  const priceOracle = await transparentUpgradeableProxyFactory.deploy(
    await priceOracleImpl.getAddress(),
    await signer!.getAddress(),
    priceOracleImpl.interface.encodeFunctionData("initialize")
  );
  await priceOracle.waitForDeployment();
  console.log(`${contractName} Proxy:          ${await priceOracle.getAddress()}`);
}

async function priceOracleUpgrade(proxyAddress: string, contractName: string, args: string[]) {
  const priceOracleProxy = (await hre.ethers.getContractAt(
    "ITransparentUpgradeableProxy",
    proxyAddress,
    signer
  )) as ITransparentUpgradeableProxy;
  const priceOracleFactory = await hre.ethers.getContractFactory(contractName, signer);

  console.log(
    `Old ${contractName} Implementation: ${await getTransparentProxyImplementation(await priceOracleProxy.getAddress())}`
  );

  /* Deploy new implementation contract */
  const priceOracleImpl = await priceOracleFactory.deploy(...decodeArgs(args));
  await priceOracleImpl.waitForDeployment();

  console.log(`New ${contractName} Implementation: ${await priceOracleImpl.getAddress()}`);

  /* Upgrade proxy */
  if ((await signer!.getAddress()) === (await getTransparentProxyAdmin(await priceOracleProxy.getAddress()))) {
    await priceOracleProxy.upgradeTo(await priceOracleImpl.getAddress());
  } else {
    const calldata = (await priceOracleProxy.upgradeTo.populateTransaction(await priceOracleImpl.getAddress())).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${await priceOracleProxy.getAddress()}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Generic Contract Deploy */
/******************************************************************************/

async function contractDeploy(contractName: string, args: string[]) {
  const contractFactory = await hre.ethers.getContractFactory(contractName, signer);

  /* Deploy Contract */
  const contract = await contractFactory.deploy(...decodeArgs(args));
  await contract.waitForDeployment();
  console.log(`${contractName}: ${await contract.getAddress()}`);
}

/******************************************************************************/
/* Ownership Commands */
/******************************************************************************/

async function transferOwnership(proxy: string, account: string) {
  /* Look up owner and proxy type */
  let owner: string | undefined = undefined;
  let proxyType: "Ownable" | "Transparent";
  try {
    owner = await getOwner(proxy);
    proxyType = "Ownable";
  } catch {
    owner = await getTransparentProxyAdmin(proxy);
    proxyType = "Transparent";
  }

  /* Validate signer is owner */
  if ((await signer!.getAddress()) != owner) {
    console.error(`Current signer is not owner of proxy.`);
    return;
  }

  console.log(`Old Owner: ${owner}`);

  /* Transfer ownership */
  if (proxyType === "Ownable") {
    const proxyContract = (await hre.ethers.getContractAt("Ownable", proxy, signer)) as Ownable;
    await proxyContract.transferOwnership(account);
  } else if (proxyType === "Transparent") {
    const proxyContract = (await hre.ethers.getContractAt(
      "ITransparentUpgradeableProxy",
      proxy,
      signer
    )) as ITransparentUpgradeableProxy;
    await proxyContract.changeAdmin(account);
  }

  console.log(`New Owner: ${account}`);
}

/******************************************************************************/
/* Parsers for Arguments */
/******************************************************************************/

function parseAddress(address: string, _: string): string {
  if (!ethers.isAddress(address)) {
    throw new InvalidArgumentError("Invalid address.");
  }
  return ethers.getAddress(address);
}

function parseNumber(value: string, _: string): number {
  try {
    return parseInt(value);
  } catch (e) {
    throw new InvalidArgumentError("Invalid number: " + e);
  }
}

function parseDecimal(decimal: string, _: string): bigint {
  try {
    return ethers.parseEther(decimal);
  } catch (e) {
    throw new InvalidArgumentError("Invalid decimal: " + e);
  }
}

/******************************************************************************/
/* Entry Point */
/******************************************************************************/

async function main() {
  /* Load deployment */
  const network = await hre.ethers.provider.getNetwork();

  const deploymentPath = `deployments/${network.name}-${network.chainId}.json`;
  const deployment: Deployment = fs.existsSync(deploymentPath)
    ? Deployment.fromFile(deploymentPath)
    : Deployment.fromScratch(network);

  /* Load signer */
  signer = (await hre.ethers.getSigners())[0];

  /* Program Commands */
  const program = new Command();

  program.name("deployment-manager").description("CLI for Pool Deployment").version("0.1.0");

  program
    .command("dump")
    .description("Dump deployment")
    .action(() => deployment.dump());
  program
    .command("show")
    .description("Show current deployment")
    .action(() => deploymentShow(deployment));
  program
    .command("show-address")
    .description("Show address of signer")
    .action(async () => console.log(await signer!.getAddress()));

  /* Ownership */
  program
    .command("transfer-ownership")
    .description("Transfer proxy ownership")
    .argument("proxy", "Proxy address", parseAddress)
    .argument("account", "New owner account", parseAddress)
    .action((proxy, account) => transferOwnership(proxy, account));

  /* Pool Factory */
  program
    .command("pool-factory-deploy")
    .description("Deploy Pool Factory")
    .action(() => poolFactoryDeploy(deployment));
  program
    .command("pool-factory-upgrade")
    .description("Upgrade Pool Factory")
    .action(() => poolFactoryUpgrade(deployment));
  program
    .command("pool-factory-list")
    .description("List Pools")
    .action(() => poolFactoryList(deployment));
  program
    .command("pool-factory-list-implementations")
    .description("List Pool Implementations")
    .action(() => poolFactoryListImplementations(deployment));
  program
    .command("pool-factory-add-implementation")
    .description("Add Pool Implementation")
    .argument("implementation", "Pool Implementation Address")
    .action((implementation) => poolFactoryAddImplementation(deployment, implementation));
  program
    .command("pool-factory-remove-implementation")
    .description("Remove Pool Implementation")
    .argument("implementation", "Pool Implementation Address")
    .action((implementation) => poolFactoryRemoveImplementation(deployment, implementation));

  /* Collateral Liquidator */
  program
    .command("collateral-liquidator-deploy")
    .description("Deploy Collateral Liquidator")
    .argument("contract", "Collateral liquidator contract name")
    .option("--ctor-args <ctor_args...>", "Constructor Arguments")
    .option("--init-args <init_args...>", "Initializer Arguments")
    .action((contract, opts) => collateralLiquidatorDeploy(deployment, contract, opts.ctorArgs, opts.initArgs));
  program
    .command("collateral-liquidator-upgrade")
    .description("Upgrade Collateral Liquidator")
    .argument("contract", "Collateral liquidator contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => collateralLiquidatorUpgrade(deployment, contract, args));

  /* Collateral Wrapper */
  program
    .command("collateral-wrapper-deploy")
    .description("Deploy Collateral Wrapper")
    .argument("contract", "Collateral wrapper contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => collateralWrapperDeploy(deployment, contract, args));
  program
    .command("collateral-wrapper-upgrade")
    .description("Upgrade Collateral Wrapper")
    .argument("contract", "Collateral wrapper contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => collateralWrapperUpgrade(deployment, contract, args));

  /* Pool Implementation */
  program
    .command("pool-implementation-deploy")
    .description("Deploy Pool Implementation")
    .argument("name", "Pool deployment name")
    .argument("contract", "Pool contract name")
    .argument("[args...]", "Arguments")
    .action((name, contract, args) => poolImplementationDeploy(deployment, name, contract, args));
  program
    .command("pool-implementation-upgrade")
    .description("Upgrade Pool Implementation")
    .argument("name", "Pool deployment name")
    .argument("contract", "Pool contract name")
    .argument("[args...]", "Arguments")
    .action((name, contract, args) => poolImplementationUpgrade(deployment, name, contract, args));
  program
    .command("pool-implementation-pause")
    .description("Upgrade Pool Implementation to Noop Pool")
    .argument("name", "Pool deployment name")
    .action((name) => poolImplementationPause(deployment, name));

  /* Noop Pool */
  program
    .command("noop-pool-deploy")
    .description("Deploy Noop Pool Implementation")
    .action(() => noopPoolImplementationDeploy(deployment));

  /* ERC20 Deposit Token Implementation */
  program
    .command("erc20-deposit-token-deploy")
    .description("Deploy ERC20 Deposit Token Implementation")
    .action(() => erc20DepositTokenImplementationDeploy(deployment));

  /* Price Oracle */
  program
    .command("price-oracle-deploy")
    .description("Deploy Price Oracle")
    .argument("contract", "Price oracle contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => priceOracleDeploy(contract, args));
  program
    .command("price-oracle-upgrade")
    .description("Upgrade Price Oracle")
    .argument("instance", "Price oracle proxy address", parseAddress)
    .argument("contract", "Price oracle contract name")
    .argument("[args...]", "Arguments")
    .action((instance, contract, args) => priceOracleUpgrade(instance, contract, args));

  /* Admin Fee */
  program
    .command("pool-factory-set-admin-fee")
    .description("Set admin fee on Pool")
    .argument("pool", "Pool instance", parseAddress)
    .argument("rate", "Admin fee rate in basis points", parseNumber)
    .argument("fee_share_recipient", "Fee share recipient", parseAddress)
    .argument("fee_share_split", "Fee share split in basis points", parseNumber)
    .action((pool, rate, fee_share_recipient, fee_share_split) =>
      poolFactorySetAdminFee(deployment, pool, rate, fee_share_recipient, fee_share_split)
    );

  /* Generic Contract Deploy */
  program
    .command("contract-deploy")
    .description("Deploy contract")
    .argument("contract", "Contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => contractDeploy(contract, args));

  /* Loan Receipt */
  program
    .command("decode-loan-receipt")
    .description("Decode Loan Receipt")
    .argument("receipt", "Loan Receipt")
    .action((receipt) => decodeLoanReceipt(deployment, receipt));

  /* Parse command */
  await program.parseAsync(process.argv);

  /* Save deployment */
  deployment.toFile(deploymentPath);

  process.exit();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
