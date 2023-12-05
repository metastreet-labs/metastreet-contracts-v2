import * as dotenv from "dotenv";
import fs from "fs";

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-tracer";
import "hardhat-contract-sizer";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
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
          version: "0.8.20",
          settings: {
            viaIR: true,
            optimizer: {
              enabled: true,
              runs: 400,
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
    },
    mainnet: {
      url: process.env.MAINNET_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    goerli: {
      url: process.env.GOERLI_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  typechain: {
    outDir: "typechain",
  },
  mocha: {
    timeout: 100000000,
  },
};

export default config;
