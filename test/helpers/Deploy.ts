import { ethers } from "hardhat";

export async function getContractFactoryWithLibraries(
  name: string,
  libraryNames: string[],
  signer?: ethers.Signer
): Promise<ethers.ContractFactory> {
  let libraries: { [key: string]: string } = {};
  for (const libraryName of libraryNames) {
    const lib = await (await ethers.getContractFactory(libraryName, signer)).deploy();
    await lib.waitForDeployment();
    libraries[libraryName] = await lib.getAddress();
  }
  return ethers.getContractFactory(name, { libraries, signer });
}
