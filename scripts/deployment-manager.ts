import { ethers, artifacts } from "hardhat";
import { Command, InvalidArgumentError } from "commander";
import fs from "fs";

import { ContractFactory } from "@ethersproject/contracts";
import { BigNumber } from "@ethersproject/bignumber";
import { Network } from "@ethersproject/networks";
import { Signer } from "@ethersproject/abstract-signer";
import { LedgerSigner } from "@anders-t/ethers-ledger";

import { PoolFactory, UpgradeableBeacon, ITransparentUpgradeableProxy, Ownable } from "../typechain";

interface LoanReceipt {
  version: number;
  principal: BigNumber;
  repayment: BigNumber;
  borrower: string;
  maturity: BigNumber;
  duration: BigNumber;
  collateralToken: string;
  collateralTokenId: BigNumber;
  collateralWrapperContextLen: number;
  collateralWrapperContext: string;
  nodeReceipts: any[];
}

/******************************************************************************/
/* Global Signer */
/******************************************************************************/

let signer: Signer | undefined;

/******************************************************************************/
/* Deployment */
/******************************************************************************/

class Deployment {
  name?: string;
  chainId?: number;
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
    chainId?: number,
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
      obj.chainId,
      obj.poolFactory,
      obj.collateralLiquidators,
      obj.collateralWrappers,
      obj.poolBeacons,
      obj.noopPoolImpl,
      obj.erc20DepositTokenImpl
    );
  }

  static fromScratch(network: Network): Deployment {
    return new Deployment(network.name, network.chainId);
  }

  toFile(path: string) {
    fs.writeFileSync(path, JSON.stringify(this), { encoding: "utf-8" });
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
  const contract = await ethers.getContractAt(["function IMPLEMENTATION_VERSION() view returns (string)"], address);
  return await contract.IMPLEMENTATION_VERSION();
}

async function getOwner(address: string): Promise<string> {
  const ownableContract = (await ethers.getContractAt("Ownable", address)) as Ownable;
  return await ownableContract.owner();
}

async function getBeaconImplementation(address: string): Promise<string> {
  const upgradeableBeacon = (await ethers.getContractAt("UpgradeableBeacon", address)) as UpgradeableBeacon;
  return await upgradeableBeacon.implementation();
}

async function getTransparentProxyImplementation(address: string): Promise<string> {
  const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implementationSlotData = await ethers.provider.getStorageAt(address, implementationSlot);
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(implementationSlotData, 12));
}

async function getTransparentProxyAdmin(address: string): Promise<string> {
  const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const adminSlotData = await ethers.provider.getStorageAt(address, adminSlot);
  return ethers.utils.getAddress(ethers.utils.hexDataSlice(adminSlotData, 12));
}

async function getCollateralWrappers(address: string): Promise<string[]> {
  const contract = await ethers.getContractAt(["function collateralWrappers() view returns (address[])"], address);
  return (await contract.collateralWrappers()).filter((e: string) => e !== ethers.constants.AddressZero);
}

async function getCollateralWrapperName(address: string): Promise<string> {
  const contract = await ethers.getContractAt(["function name() view returns (string)"], address);
  return await contract.name();
}

async function getAddressType(address: string): Promise<"EOA" | "Contract"> {
  return (await ethers.provider.getCode(address)) === "0x" ? "EOA" : "Contract";
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
    const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;
    const impl = await poolFactory.getImplementation();
    const version = await getImplementationVersion(impl);
    const owner = await getOwner(poolFactory.address);
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

  const poolFactoryFactory = await ethers.getContractFactory("PoolFactory", signer);
  const erc1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", signer);

  /* Deploy Pool Factory implementation */
  const poolFactoryImpl = await poolFactoryFactory.deploy();
  await poolFactoryImpl.deployed();

  /* Deploy Pool Factory */
  const poolFactory = await erc1967ProxyFactory.deploy(
    poolFactoryImpl.address,
    poolFactoryImpl.interface.encodeFunctionData("initialize")
  );
  await poolFactory.deployed();
  console.log(`Pool Factory: ${poolFactory.address}`);

  deployment.poolFactory = poolFactory.address;
}

async function poolFactoryUpgrade(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;
  const poolFactoryFactory = await ethers.getContractFactory("PoolFactory", signer);

  console.log(`Old Pool Factory Implementation: ${await poolFactory.getImplementation()}`);
  console.log(
    `Old Pool Factory Version:        ${await getImplementationVersion(await poolFactory.getImplementation())}`
  );

  /* Deploy Pool Factory implementation */
  const poolFactoryImpl = await poolFactoryFactory.deploy();
  await poolFactoryImpl.deployed();

  console.log(`New Pool Factory Implementation: ${poolFactoryImpl.address}`);
  console.log(`New Pool Factory Version:        ${await getImplementationVersion(poolFactoryImpl.address)}`);

  /* Upgrade Pool Factory implementation */
  if ((await signer!.getAddress()) === (await getOwner(poolFactory.address))) {
    await poolFactory.upgradeToAndCall(poolFactoryImpl.address, "0x");
  } else {
    const calldata = (await poolFactory.populateTransaction.upgradeToAndCall(poolFactoryImpl.address, "0x")).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${poolFactory.address}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolFactoryList(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;

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

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory)) as PoolFactory;

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

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  if ((await signer!.getAddress()) === (await getOwner(poolFactory.address))) {
    await poolFactory.addPoolImplementation(implementation);
  } else {
    const calldata = (await poolFactory.populateTransaction.addPoolImplementation(implementation)).data;
    console.log(`Add Pool Implementation Calldata`);
    console.log(`  Target:   ${poolFactory.address}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

async function poolFactoryRemoveImplementation(deployment: Deployment, implementation: string) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  if ((await signer!.getAddress()) === (await getOwner(poolFactory.address))) {
    await poolFactory.removePoolImplementation(implementation);
  } else {
    const calldata = (await poolFactory.populateTransaction.removePoolImplementation(implementation)).data;
    console.log(`Remove Pool Implementation Calldata`);
    console.log(`  Target:   ${poolFactory.address}`);
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

  const collateralLiquidatorFactory = await ethers.getContractFactory(contractName, signer);
  const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon", signer);
  const beaconProxyFactory = await ethers.getContractFactory("BeaconProxy", signer);

  /* Deploy implementation contract */
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy(...decodeArgs(ctorArgs));
  await collateralLiquidatorImpl.deployed();
  console.log(`Collateral Liquidator Implementation: ${collateralLiquidatorImpl.address}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(collateralLiquidatorImpl.address);
  await upgradeableBeacon.deployed();
  console.log(`Collateral Liquidator Beacon:         ${upgradeableBeacon.address}`);

  /* Deploy beacon proxy */
  const beaconProxy = await beaconProxyFactory.deploy(
    upgradeableBeacon.address,
    collateralLiquidatorImpl.interface.encodeFunctionData("initialize", decodeArgs(initArgs))
  );
  await beaconProxy.deployed();
  console.log(`Collateral Liquidator Proxy:          ${beaconProxy.address}`);

  deployment.collateralLiquidators[contractName] = { address: beaconProxy.address, beacon: upgradeableBeacon.address };
}

async function collateralLiquidatorUpgrade(deployment: Deployment, contractName: string, args: string[]) {
  if (!deployment.collateralLiquidators[contractName]) {
    console.error(`Collateral liquidator ${contractName} not deployed.`);
    return;
  }

  const upgradeableBeacon = (await ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.collateralLiquidators[contractName].beacon,
    signer
  )) as UpgradeableBeacon;
  const collateralLiquidatorFactory = await ethers.getContractFactory(contractName, signer);

  console.log(`Old Collateral Liquidator Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(
    `Old Collateral Liquidator Version:        ${await getImplementationVersion(
      await upgradeableBeacon.implementation()
    )}`
  );

  /* Deploy new implementation contract */
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy(...decodeArgs(args));
  await collateralLiquidatorImpl.deployed();

  console.log(`New Collateral Liquidator Implementation: ${collateralLiquidatorImpl.address}`);
  console.log(
    `New Collateral Liquidator Version:        ${await getImplementationVersion(collateralLiquidatorImpl.address)}`
  );

  /* Upgrade beacon */
  if ((await signer!.getAddress()) === (await getOwner(upgradeableBeacon.address))) {
    await upgradeableBeacon.upgradeTo(collateralLiquidatorImpl.address);
  } else {
    const calldata = (await upgradeableBeacon.populateTransaction.upgradeTo(collateralLiquidatorImpl.address)).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${upgradeableBeacon.address}`);
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

  const collateralWrapperFactory = await ethers.getContractFactory(contractName, signer);
  const transparentUpgradeableProxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy", signer);

  /* Deploy implementation contract */
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...decodeArgs(args));
  await collateralWrapperImpl.deployed();
  console.log(`Collateral Wrapper Implementation: ${collateralWrapperImpl.address}`);

  /* Deploy transparent proxy */
  const collateralWrapper = await transparentUpgradeableProxyFactory.deploy(
    collateralWrapperImpl.address,
    await signer!.getAddress(),
    "0x"
  );
  await collateralWrapper.deployed();
  console.log(`Collateral Wrapper Proxy:          ${collateralWrapper.address}`);

  deployment.collateralWrappers[contractName] = collateralWrapper.address;
}

async function collateralWrapperUpgrade(deployment: Deployment, contractName: string, args: string[]) {
  if (!deployment.collateralWrappers[contractName]) {
    console.error(`Collateral wrapper ${contractName} not deployed.`);
    return;
  }

  const collateralWrapperProxy = (await ethers.getContractAt(
    "ITransparentUpgradeableProxy",
    deployment.collateralWrappers[contractName],
    signer
  )) as ITransparentUpgradeableProxy;
  const collateralWrapperFactory = await ethers.getContractFactory(contractName, signer);

  console.log(
    `Old Collateral Wrapper Implementation: ${await getTransparentProxyImplementation(collateralWrapperProxy.address)}`
  );

  /* Deploy new implementation contract */
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...decodeArgs(args));
  await collateralWrapperImpl.deployed();

  console.log(`New Collateral Wrapper Implementation: ${collateralWrapperImpl.address}`);

  /* Upgrade proxy */
  if ((await signer!.getAddress()) === (await getTransparentProxyAdmin(collateralWrapperProxy.address))) {
    await collateralWrapperProxy.upgradeTo(collateralWrapperImpl.address);
  } else {
    const calldata = (await collateralWrapperProxy.populateTransaction.upgradeTo(collateralWrapperImpl.address)).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${collateralWrapperProxy.address}`);
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

async function poolImplementationFactory(deployment: Deployment, contractName: string): Promise<ContractFactory> {
  /* Lookup libraries for Pool implementation contract */
  const poolImplLinkReferences = (await artifacts.readArtifact(contractName)).linkReferences;
  const libraryEntries = Object.entries(poolImplLinkReferences).flatMap(([k, v]) =>
    Object.keys(v).map((v) => ({ fullName: `${k}:${v}`, name: `${v}` }))
  );

  /* Deploy libraries */
  const libraries: { [key: string]: string } = {};
  console.log();
  for (const libraryEntry of libraryEntries) {
    const libFactory = await ethers.getContractFactory(libraryEntry.fullName, signer);
    const libBytecodeHash = ethers.utils.keccak256(libFactory.bytecode);

    const cachedAddress = await libraryCacheLookup(deployment, libBytecodeHash);
    if (cachedAddress) {
      console.log(`Library ${libraryEntry.name}: ${cachedAddress} (cached)`);

      libraries[libraryEntry.fullName] = cachedAddress;
    } else {
      const lib = await libFactory.deploy();
      await lib.deployed();

      console.log(`Library ${libraryEntry.name}: ${lib.address}`);

      await libraryCacheStore(deployment, libBytecodeHash, lib.address);

      libraries[libraryEntry.fullName] = lib.address;
    }
  }
  console.log();

  return await ethers.getContractFactory(contractName, { libraries, signer });
}

async function poolImplementationDeploy(deployment: Deployment, name: string, contractName: string, args: string[]) {
  if (deployment.poolBeacons[name]) {
    console.error(`Pool implementation ${name} already deployed.`);
    return;
  }

  /* Deploy implementation contract */
  const poolFactory = await poolImplementationFactory(deployment, contractName);
  const poolImpl = await poolFactory.deploy(...decodeArgs(args));
  await poolImpl.deployed();
  console.log(`Pool Implementation: ${poolImpl.address}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon", signer);
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(poolImpl.address);
  await upgradeableBeacon.deployed();
  console.log(`Pool Beacon:         ${upgradeableBeacon.address}`);

  deployment.poolBeacons[name] = upgradeableBeacon.address;
}

async function poolImplementationUpgrade(deployment: Deployment, name: string, contractName: string, args: string[]) {
  if (!deployment.poolBeacons[name]) {
    console.error(`Pool implementation ${name} not deployed.`);
    return;
  }

  const upgradeableBeacon = (await ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.poolBeacons[name],
    signer
  )) as UpgradeableBeacon;

  console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

  /* Deploy new implementation contract */
  const poolFactory = await poolImplementationFactory(deployment, contractName);
  const poolImpl = await poolFactory.deploy(...decodeArgs(args));
  await poolImpl.deployed();

  /* Validate major version number of upgrade */
  const oldPoolVersion = await getImplementationVersion(await upgradeableBeacon.implementation());
  const newPoolVersion = await getImplementationVersion(poolImpl.address);
  const [oldPoolVersionMajor, newPoolVersionMajor] = [oldPoolVersion.split(".")[0], newPoolVersion.split(".")[0]];
  if (oldPoolVersionMajor !== "0" && oldPoolVersionMajor !== newPoolVersionMajor) {
    console.error(
      `Incompatible upgrade from version ${oldPoolVersion} to version ${newPoolVersion} (major number mismatch).`
    );
    return;
  }

  console.log(`New Pool Implementation: ${poolImpl.address}`);
  console.log(`New Pool Version:        ${await getImplementationVersion(poolImpl.address)}`);

  /* Upgrade beacon */
  if ((await signer!.getAddress()) === (await getOwner(upgradeableBeacon.address))) {
    await upgradeableBeacon.upgradeTo(poolImpl.address);
  } else {
    const calldata = (await upgradeableBeacon.populateTransaction.upgradeTo(poolImpl.address)).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${upgradeableBeacon.address}`);
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

  const upgradeableBeacon = (await ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.poolBeacons[name],
    signer
  )) as UpgradeableBeacon;

  console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

  console.log(`New Pool Implementation: ${deployment.noopPoolImpl}`);
  console.log(`New Pool Version:        ${await getImplementationVersion(deployment.noopPoolImpl)}`);

  /* Upgrade beacon to noop pool */
  if ((await signer!.getAddress()) === (await getOwner(upgradeableBeacon.address))) {
    await upgradeableBeacon.upgradeTo(deployment.noopPoolImpl);
  } else {
    const calldata = (await upgradeableBeacon.populateTransaction.upgradeTo(deployment.noopPoolImpl)).data;
    console.log(`\nUpgrade Calldata`);
    console.log(`  Target:   ${upgradeableBeacon.address}`);
    console.log(`  Calldata: ${calldata}`);
  }
}

/******************************************************************************/
/* Decode LoanReceipt */
/******************************************************************************/

async function decodeLoanReceipt(deployment: Deployment, loanReceipt: string) {
  const poolImplementation = deployment.poolBeacons["v2.x-collection"];
  const address = await getBeaconImplementation(poolImplementation);

  const contract = await ethers.getContractAt("Pool", address);

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

  const noopPoolFactory = await ethers.getContractFactory("NoopPool", signer);

  /* Deploy noop pool implementation */
  const noopPoolImpl = await noopPoolFactory.deploy();
  await noopPoolImpl.deployed();
  console.log(`Noop Pool Implementation: ${noopPoolImpl.address}`);

  deployment.noopPoolImpl = noopPoolImpl.address;
}

/******************************************************************************/
/* ERC20 Deposit Token Commands */
/******************************************************************************/

async function erc20DepositTokenImplementationDeploy(deployment: Deployment) {
  if (deployment.erc20DepositTokenImpl) {
    console.error(`ERC20 Deposit Token Implementation already deployed.`);
    return;
  }

  const erc20DepositTokenImplFactory = await ethers.getContractFactory("ERC20DepositTokenImplementation", signer);

  /* Deploy ERC20 Deposit Token Implementation */
  const erc20DepositTokenImpl = await erc20DepositTokenImplFactory.deploy();
  await erc20DepositTokenImpl.deployed();
  console.log(`ERC20 Deposit Token Implementation: ${erc20DepositTokenImpl.address}`);

  deployment.erc20DepositTokenImpl = erc20DepositTokenImpl.address;
}

/******************************************************************************/
/* Generic Contract Deploy */
/******************************************************************************/

async function contractDeploy(contractName: string, args: string[]) {
  const contractFactory = await ethers.getContractFactory(contractName, signer);

  /* Deploy Contract */
  const contract = await contractFactory.deploy(...decodeArgs(args));
  await contract.deployed();
  console.log(`${contractName}: ${contract.address}`);
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
    const proxyContract = (await ethers.getContractAt("Ownable", proxy, signer)) as Ownable;
    await proxyContract.transferOwnership(account);
  } else if (proxyType === "Transparent") {
    const proxyContract = (await ethers.getContractAt(
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
  if (!ethers.utils.isAddress(address)) {
    throw new InvalidArgumentError("Invalid address.");
  }
  return ethers.utils.getAddress(address);
}

function parseNumber(value: string, _: string): number {
  try {
    return parseInt(value);
  } catch (e) {
    throw new InvalidArgumentError("Invalid number: " + e);
  }
}

function parseDecimal(decimal: string, _: string): BigNumber {
  try {
    return ethers.utils.parseEther(decimal);
  } catch (e) {
    throw new InvalidArgumentError("Invalid decimal: " + e);
  }
}

function parseBigNumber(value: string, _: string): BigNumber {
  try {
    return ethers.BigNumber.from(value);
  } catch (e) {
    throw new InvalidArgumentError("Invalid number: " + e);
  }
}

/******************************************************************************/
/* Entry Point */
/******************************************************************************/

async function main() {
  /* Load deployment */
  const network = await ethers.provider.getNetwork();

  const deploymentPath = `deployments/${network.name}-${network.chainId}.json`;
  const deployment: Deployment = fs.existsSync(deploymentPath)
    ? Deployment.fromFile(deploymentPath)
    : Deployment.fromScratch(network);

  /* Load signer */
  if (signer === undefined) {
    if (process.env.LEDGER_DERIVATION_PATH) {
      signer = new LedgerSigner(ethers.provider, process.env.LEDGER_DERIVATION_PATH);
    } else {
      signer = (await ethers.getSigners())[0];
    }
  }

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
