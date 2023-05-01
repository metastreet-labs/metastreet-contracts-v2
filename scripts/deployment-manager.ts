import { ethers } from "hardhat";
import { Command, InvalidArgumentError } from "commander";
import fs from "fs";

import { BigNumber } from "@ethersproject/bignumber";
import { Network } from "@ethersproject/networks";
import { Signer } from "@ethersproject/abstract-signer";
import { LedgerSigner } from "@anders-t/ethers-ledger";

import { PoolFactory, UpgradeableBeacon, TransparentUpgradeableProxy } from "../typechain";

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
  /* Contract Name to Beacon Address */
  poolImplementations: { [name: string]: string };

  constructor(
    name?: string,
    chainId?: number,
    poolFactory?: string,
    collateralLiquidators?: { [name: string]: { address: string; beacon: string } },
    collateralWrappers?: { [name: string]: string },
    poolImplementations?: { [name: string]: string }
  ) {
    this.name = name;
    this.chainId = chainId;
    this.poolFactory = poolFactory;
    this.collateralLiquidators = collateralLiquidators || {};
    this.collateralWrappers = collateralWrappers || {};
    this.poolImplementations = poolImplementations || {};
  }

  static fromFile(path: string): Deployment {
    const obj: Deployment = JSON.parse(fs.readFileSync(path, "utf-8"));
    return new Deployment(
      obj.name,
      obj.chainId,
      obj.poolFactory,
      obj.collateralLiquidators,
      obj.collateralWrappers,
      obj.poolImplementations
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
    console.log(`Collateral Liquidators:    ${this.collateralLiquidators}`);
    console.log(`Collateral Wrappers:       ${this.collateralWrappers}`);
    console.log(`Pool Implementations:      ${this.poolImplementations}`);
  }
}

/******************************************************************************/
/* Helper Functions */
/******************************************************************************/

async function getImplementationVersion(address: string): Promise<string> {
  const contract = await ethers.getContractAt(["function IMPLEMENTATION_VERSION() view returns (string)"], address);
  return await contract.IMPLEMENTATION_VERSION();
}

async function getBeaconImplementation(address: string): Promise<string> {
  const upgradeableBeacon = (await ethers.getContractAt("UpgradeableBeacon", address)) as UpgradeableBeacon;
  return await upgradeableBeacon.implementation();
}

async function getTransparentProxyImplementation(address: string): Promise<string> {
  const transparentProxy = (await ethers.getContractAt(
    "TransparentUpgradeableProxy",
    address,
    signer
  )) as TransparentUpgradeableProxy;
  return await transparentProxy.callStatic.implementation();
}

/******************************************************************************/
/* Deployment Commands */
/******************************************************************************/

async function deploymentShow(deployment: Deployment) {
  console.log("Pool Factory");
  console.log(`  Address: ${deployment.poolFactory || "Not Deployed"}`);
  if (deployment.poolFactory) {
    const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;
    const impl = await poolFactory.getImplementation();
    const version = await getImplementationVersion(impl);
    console.log(`     Impl: ${impl}`);
    console.log(`  Version: ${version}`);
  } else {
    console.log(`     Impl: N/A`);
    console.log(`  Version: N/A`);
  }

  console.log("\nCollateral Liquidators");
  for (const contractName in deployment.collateralLiquidators) {
    const collateralLiquidator = deployment.collateralLiquidators[contractName];
    const impl = await getBeaconImplementation(collateralLiquidator.beacon);
    const version = await getImplementationVersion(impl);

    console.log(`  ${contractName}`);
    console.log(`      Address: ${collateralLiquidator.address}`);
    console.log(`      Beacon:  ${collateralLiquidator.beacon}`);
    console.log(`      Impl:    ${impl}`);
    console.log(`      Version: ${version}`);
    console.log("");
  }

  console.log("\nCollateral Wrappers");
  for (const contractName in deployment.collateralWrappers) {
    const collateralWrapper = deployment.collateralWrappers[contractName];

    console.log(`  ${contractName}`);
    console.log(`      Address: ${collateralWrapper}`);
    console.log(`      Impl:    ${await getTransparentProxyImplementation(collateralWrapper)}`);
    console.log("");
  }

  console.log("\nPool Implementations");
  for (const contractName in deployment.poolImplementations) {
    const poolImplementation = deployment.poolImplementations[contractName];
    const impl = await getBeaconImplementation(poolImplementation);
    const version = await getImplementationVersion(impl);

    console.log(`  ${contractName}`);
    console.log(`      Beacon:  ${poolImplementation}`);
    console.log(`      Impl:    ${impl}`);
    console.log(`      Version: ${version}`);
    console.log("");
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

  /* Upgrade Pool Factory implementation */
  await poolFactory.upgradeToAndCall(poolFactoryImpl.address, "0x");

  console.log(`New Pool Factory Implementation: ${await poolFactory.getImplementation()}`);
  console.log(
    `New Pool Factory Version:        ${await getImplementationVersion(await poolFactory.getImplementation())}`
  );
}

async function poolFactoryList(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  const pools = await poolFactory.getPools();

  console.log("Pools");
  for (const pool of pools) {
    console.log(`    ${pool}`);
  }
}

/******************************************************************************/
/* Collateral Liquidator Commands */
/******************************************************************************/

async function collateralLiquidatorDeploy(deployment: Deployment, contractName: string, args: string[]) {
  if (deployment.collateralLiquidators[contractName]) {
    console.error(`Collateral liquidator ${contractName} already deployed.`);
    return;
  }

  const collateralLiquidatorFactory = await ethers.getContractFactory(contractName, signer);
  const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon", signer);
  const beaconProxyFactory = await ethers.getContractFactory("BeaconProxy", signer);

  /* FIXME hack to handle arrays */
  const parsedArgs = args.map((arg) => (arg.startsWith("[") && arg.endsWith("]") ? arg.slice(1, -1).split(",") : arg));

  /* Deploy implementation contract */
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy();
  await collateralLiquidatorImpl.deployed();
  console.log(`Collateral Liquidator Implementation: ${collateralLiquidatorImpl.address}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(collateralLiquidatorImpl.address);
  await upgradeableBeacon.deployed();
  console.log(`Collateral Liquidator Beacon:         ${upgradeableBeacon.address}`);

  /* Deploy beacon proxy */
  const beaconProxy = await beaconProxyFactory.deploy(
    upgradeableBeacon.address,
    collateralLiquidatorImpl.interface.encodeFunctionData("initialize", parsedArgs)
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
  const collateralLiquidatorImpl = await collateralLiquidatorFactory.deploy(...args);
  await collateralLiquidatorImpl.deployed();

  /* Upgrade beacon */
  await upgradeableBeacon.upgradeTo(collateralLiquidatorImpl.address);

  console.log(`New Collateral Liquidator Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(
    `New Collateral Liquidator Version:        ${await getImplementationVersion(
      await upgradeableBeacon.implementation()
    )}`
  );
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
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...args);
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
    "TransparentUpgradeableProxy",
    deployment.collateralWrappers[contractName],
    signer
  )) as TransparentUpgradeableProxy;
  const collateralWrapperFactory = await ethers.getContractFactory(contractName, signer);

  console.log(`Old Collateral Wrapper Implementation: ${await collateralWrapperProxy.callStatic.implementation()}`);

  /* Deploy new implementation contract */
  const collateralWrapperImpl = await collateralWrapperFactory.deploy(...args);
  await collateralWrapperImpl.deployed();

  /* Upgrade proxy */
  await collateralWrapperProxy.upgradeTo(collateralWrapperImpl.address);

  console.log(`New Collateral Wrapper Implementation: ${await collateralWrapperProxy.callStatic.implementation()}`);
}

/******************************************************************************/
/* Pool Implementation Commands */
/******************************************************************************/

async function poolImplementationDeploy(deployment: Deployment, contractName: string, args: string[]) {
  if (deployment.poolImplementations[contractName]) {
    console.error(`Pool implementation ${contractName} already deployed.`);
    return;
  }

  const poolFactory = await ethers.getContractFactory(contractName, signer);
  const upgradeableBeaconFactory = await ethers.getContractFactory("UpgradeableBeacon", signer);

  /* FIXME hack to handle arrays */
  const parsedArgs = args.map((arg) => (arg.startsWith("[") && arg.endsWith("]") ? arg.slice(1, -1).split(",") : arg));

  /* Deploy implementation contract */
  const poolImpl = await poolFactory.deploy(...parsedArgs);
  await poolImpl.deployed();
  console.log(`Pool Implementation: ${poolImpl.address}`);

  /* Deploy upgradeable beacon */
  const upgradeableBeacon = await upgradeableBeaconFactory.deploy(poolImpl.address);
  await upgradeableBeacon.deployed();
  console.log(`Pool Beacon:         ${upgradeableBeacon.address}`);

  deployment.poolImplementations[contractName] = upgradeableBeacon.address;
}

async function poolImplementationUpgrade(deployment: Deployment, contractName: string, args: string[]) {
  if (!deployment.poolImplementations[contractName]) {
    console.error(`Pool implementation ${contractName} not deployed.`);
    return;
  }

  const upgradeableBeacon = (await ethers.getContractAt(
    "UpgradeableBeacon",
    deployment.poolImplementations[contractName],
    signer
  )) as UpgradeableBeacon;
  const poolFactory = await ethers.getContractFactory(contractName, signer);

  /* FIXME hack to handle arrays */
  const parsedArgs = args.map((arg) => (arg.startsWith("[") && arg.endsWith("]") ? arg.slice(1, -1).split(",") : arg));

  console.log(`Old Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`Old Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);

  /* Deploy new implementation contract */
  const poolImpl = await poolFactory.deploy(...parsedArgs);
  await poolImpl.deployed();

  /* Upgrade beacon */
  await upgradeableBeacon.upgradeTo(poolImpl.address);

  console.log(`New Pool Implementation: ${await upgradeableBeacon.implementation()}`);
  console.log(`New Pool Version:        ${await getImplementationVersion(await upgradeableBeacon.implementation())}`);
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

  /* Collateral Liquidator */
  program
    .command("collateral-liquidator-deploy")
    .description("Deploy Collateral Liquidator")
    .argument("contract", "Collateral liquidator contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => collateralLiquidatorDeploy(deployment, contract, args));
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
    .argument("contract", "Pool contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => poolImplementationDeploy(deployment, contract, args));
  program
    .command("pool-implementation-upgrade")
    .description("Upgrade Pool Implementation")
    .argument("contract", "Pool contract name")
    .argument("[args...]", "Arguments")
    .action((contract, args) => poolImplementationUpgrade(deployment, contract, args));

  /* Parse command */
  await program.parseAsync(process.argv);

  /* Save deployment */
  deployment.toFile(deploymentPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
