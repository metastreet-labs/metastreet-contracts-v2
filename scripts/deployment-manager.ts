import { ethers } from "hardhat";
import { Command, InvalidArgumentError } from "commander";
import fs from "fs";

import { BigNumber } from "@ethersproject/bignumber";
import { Network } from "@ethersproject/networks";
import { Signer } from "@ethersproject/abstract-signer";
import { LedgerSigner } from "@anders-t/ethers-ledger";

import { PoolFactory } from "../typechain";

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
  collateralFilters: string[];
  interestRateModels: string[];
  collateralLiquidators: string[];

  constructor(
    name?: string,
    chainId?: number,
    poolFactory?: string,
    collateralFilters?: string[],
    interestRateModels?: string[],
    collateralLiquidators?: string[]
  ) {
    this.name = name;
    this.chainId = chainId;
    this.poolFactory = poolFactory;
    this.collateralFilters = collateralFilters || [];
    this.interestRateModels = interestRateModels || [];
    this.collateralLiquidators = collateralLiquidators || [];
  }

  static fromFile(path: string): Deployment {
    const obj: Deployment = JSON.parse(fs.readFileSync(path, "utf-8"));
    return new Deployment(
      obj.name,
      obj.chainId,
      obj.poolFactory,
      obj.collateralFilters,
      obj.interestRateModels,
      obj.collateralLiquidators
    );
  }

  static fromScratch(network: Network): Deployment {
    return new Deployment(network.name, network.chainId);
  }

  toFile(path: string) {
    fs.writeFileSync(path, JSON.stringify(this), { encoding: "utf-8" });
  }

  dump() {
    console.log(`Network:                       ${this.name}`);
    console.log(`Chain ID:                      ${this.chainId}`);
    console.log(`Pool Factory:                  ${this.poolFactory || "Not deployed"}`);
    console.log(`Collateral Filters:            ${this.collateralFilters}`);
    console.log(`Interest Rate Models:          ${this.interestRateModels}`);
    console.log(`Collateral Liquidators:        ${this.collateralLiquidators}`);
  }
}

/******************************************************************************/
/* Commands */
/******************************************************************************/

async function poolFactoryDeploy(deployment: Deployment) {
  if (deployment.poolFactory) {
    console.error("Pool factory already deployed.");
    return;
  }

  const poolImplFactory = await ethers.getContractFactory("Pool", signer);
  const poolFactoryFactory = await ethers.getContractFactory("PoolFactory", signer);

  /* Deploy Pool implementation */
  const poolImpl = await poolImplFactory.deploy();
  await poolImpl.deployed();
  console.log(`Pool Implementation: ${poolImpl.address}`);

  /* Deploy Pool Factory */
  const poolFactory = await poolFactoryFactory.deploy(poolImpl.address);
  await poolFactory.deployed();
  console.log(`Pool Factory:        ${poolFactory.address}`);

  deployment.poolFactory = poolFactory.address;
}

async function poolFactoryUpgradeImplementation(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;

  async function getImplVersion(): Promise<string> {
    const impl = await ethers.getContractAt(
      ["function IMPLEMENTATION_VERSION() view returns (string)"],
      await poolFactory.poolImplementation()
    );
    return await impl.IMPLEMENTATION_VERSION();
  }

  console.log(`Old Pool Implementation: ${await getImplVersion()}`);

  /* Deploy new pool implementation */
  const poolImplFactory = await ethers.getContractFactory("Pool");
  const poolImpl = await poolImplFactory.deploy();
  await poolImpl.deployed();

  /* Set pool implementation */
  await poolFactory.setPoolImplementation(poolImpl.address);

  console.log(`New Pool Implementation: ${await getImplVersion()}`);
}

async function collateralFilterDeploy(deployment: Deployment, contractName: string) {
  const collateralFilterFactory = await ethers.getContractFactory(contractName, signer);

  const collateralFilter = await collateralFilterFactory.deploy();
  await collateralFilter.deployed();

  deployment.collateralFilters.push(collateralFilter.address);

  console.log(collateralFilter.address);
}

async function interestRateModelDeploy(deployment: Deployment, contractName: string) {
  const interestRateModelFactory = await ethers.getContractFactory(contractName, signer);

  const interestRateModel = await interestRateModelFactory.deploy();
  await interestRateModel.deployed();

  deployment.interestRateModels.push(interestRateModel.address);

  console.log(interestRateModel.address);
}

async function collateralLiquidatorDeploy(deployment: Deployment, contractName: string) {
  const collateralLiquidatorFactory = await ethers.getContractFactory(contractName, signer);

  const collateralLiquidator = await collateralLiquidatorFactory.deploy();
  await collateralLiquidator.deployed();

  deployment.collateralLiquidators.push(collateralLiquidator.address);

  console.log(collateralLiquidator.address);
}

async function poolFactoryList(deployment: Deployment) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;
  const pools = await poolFactory.getPools();

  for (const pool of pools) {
    console.log(pool);
  }
}

async function poolFactoryCreate(deployment: Deployment) {
  console.log("Not implemented");
}

async function poolFactoryUnregister(deployment: Deployment, pool: string) {
  if (!deployment.poolFactory) {
    console.log("Pool factory not deployed.");
    return;
  }

  const poolFactory = (await ethers.getContractAt("PoolFactory", deployment.poolFactory, signer)) as PoolFactory;
  await poolFactory.unregisterPool(pool);
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
    .command("show")
    .description("Show current deployment")
    .action(() => deployment.dump());
  program
    .command("show-address")
    .description("Show address of signer")
    .action(async () => console.log(await signer!.getAddress()));
  program
    .command("pool-factory-deploy")
    .description("Deploy Pool Factory")
    .action(() => poolFactoryDeploy(deployment));
  program
    .command("pool-factory-upgrade-implementation")
    .description("Upgrade Pool Factory Pool Implementation")
    .action(() => poolFactoryUpgradeImplementation(deployment));
  program
    .command("collateral-filter-deploy")
    .description("Deploy Collateral Filter")
    .argument("contract", "Collateral filter contract name")
    .action((contract) => collateralFilterDeploy(deployment, contract));
  program
    .command("interest-rate-model-deploy")
    .description("Deploy Interest Rate Model")
    .argument("contract", "Interest rate model contract name")
    .action((contract) => interestRateModelDeploy(deployment, contract));
  program
    .command("collateral-liquidator-deploy")
    .description("Deploy Collateral Liquidator")
    .argument("contract", "Collateral liquidator contract name")
    .action((contract) => collateralLiquidatorDeploy(deployment, contract));
  program
    .command("pool-list")
    .description("List pools")
    .action((pool) => poolFactoryList(deployment));
  program
    .command("pool-create")
    .description("Create a pool")
    .action(() => poolFactoryCreate(deployment));
  program
    .command("pool-unregister")
    .description("Unregister a pool")
    .argument("pool", "Pool address", parseAddress)
    .action((pool) => poolFactoryUnregister(deployment, pool));

  /* Parse command */
  await program.parseAsync(process.argv);

  /* Save deployment */
  deployment.toFile(deploymentPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
