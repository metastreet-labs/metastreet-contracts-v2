import * as dotenv from "dotenv";
import fs from "fs";

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-ledger";
import "hardhat-tracer";
import "hardhat-contract-sizer";

dotenv.config();

const accountsConfig = {
  accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : undefined,
  ledgerAccounts: [process.env.LEDGER_ADDRESS].filter((x) => x !== undefined),
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.25",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 800,
          },
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["storageLayout"] } },
        },
      },
    ],
    overrides: Object.fromEntries(
      fs.readdirSync("contracts/configurations").map((filename) => [
        `contracts/configurations/${filename}`,
        {
          version: "0.8.25",
          settings: {
            viaIR: true,
            optimizer: {
              enabled: true,
              runs: 100,
            },
            evmVersion: "shanghai",
            outputSelection: { "*": { "*": ["storageLayout"] } },
          },
        },
      ])
    ),
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      chainId: 1,
    },
    mainnet: {
      url: process.env.MAINNET_URL || "",
      ...accountsConfig,
    },
    goerli: {
      url: process.env.GOERLI_URL || "",
      ...accountsConfig,
    },
    sepolia: {
      url: process.env.SEPOLIA_URL || "",
      ...accountsConfig,
    },
    blast: {
      url: process.env.BLAST_URL || "",
      ...accountsConfig,
    },
    base: {
      url: process.env.BASE_URL || "",
      ...accountsConfig,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
    customChains: [
      {
        network: "blast",
        chainId: 81457,
        urls: {
          apiURL: "https://api.blastscan.io/api",
          browserURL: "https://blastscan.io",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  typechain: {
    outDir: "typechain",
  },
  mocha: {
    timeout: 100000000,
  },
};

export default config;
