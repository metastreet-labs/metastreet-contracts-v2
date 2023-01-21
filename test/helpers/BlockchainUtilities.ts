import { ethers, network } from "hardhat";

export async function getBlockTimestamp(): Promise<number> {
  return (await ethers.provider.getBlock(await ethers.provider.getBlockNumber())).timestamp;
}

export async function elapseForDuration(duration: number): Promise<void> {
  const currentTimestamp = await getBlockTimestamp();
  await network.provider.send("evm_setNextBlockTimestamp", [currentTimestamp + duration + 1]);
  await network.provider.send("evm_mine");
}

export async function elapseUntilTimestamp(timestamp: number): Promise<void> {
  await network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await network.provider.send("evm_mine");
}
