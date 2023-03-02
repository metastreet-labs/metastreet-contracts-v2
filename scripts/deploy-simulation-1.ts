/* eslint-disable camelcase */
import { ethers } from "hardhat";
import { extractEvent } from "../test/helpers/EventUtilities";
import { FixedPoint } from "../test/helpers/FixedPoint";
import { ERC20__factory, Pool__factory } from "../typechain";

async function main() {
  const accounts = await ethers.getSigners();

  /**************************************************************************/
  /* Libs and Implementations */
  /**************************************************************************/
  /* Deploy Liquidity Manager Lib */
  const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
  const liquidityManagerLib = await LiquidityManager.deploy();
  await liquidityManagerLib.deployed();

  /* Deploy Pool implementation */
  const Pool = await ethers.getContractFactory("Pool", {
    libraries: { LiquidityManager: liquidityManagerLib.address },
  });
  const poolImpl = await Pool.deploy();
  await poolImpl.deployed();

  /* Deploy Collection Collateral Filter Implementation */
  const CollectionCollateralFilter = await ethers.getContractFactory("CollectionCollateralFilter", accounts[9]);
  const collectionCollateralFilterImpl = await CollectionCollateralFilter.deploy();
  console.log("CollectionCollateralFilter Impl: ", collectionCollateralFilterImpl.address);

  /* Deploy Fixed Interest Rate Model Implementation */
  const FixedInterestRateModel = await ethers.getContractFactory("FixedInterestRateModel", accounts[9]);
  const fixedInterestRateModelImpl = await FixedInterestRateModel.deploy();
  console.log("FixedInterestRateModel Impl: ", fixedInterestRateModelImpl.address);

  /**************************************************************************/
  /* PoolFactory */
  /**************************************************************************/
  const PoolFactory = await ethers.getContractFactory("PoolFactory");
  const poolFactory = await PoolFactory.deploy(poolImpl.address);
  await poolFactory.deployed();
  console.log("PoolFactory: ", poolFactory.address);

  /**************************************************************************/
  /* Currency token */
  /**************************************************************************/
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const wethTokenContract = await TestERC20.deploy("Wrapped ETH", "WETH", 18, ethers.utils.parseEther("10000000"));
  await wethTokenContract.deployed();
  await wethTokenContract.transfer(accounts[0].address, ethers.utils.parseEther("10000000"));
  console.log("WETH : ", wethTokenContract.address);

  /**************************************************************************/
  /* NFT contracts */
  /**************************************************************************/
  const TestERC721 = await ethers.getContractFactory("TestERC721");
  const names = ["CryptoPunks", "Bored Ape Yacht Club", "Mutant Ape Yacht Club", "Otherdeed for Otherside", "Azuki"];
  const collateralTokens: string[] = [];
  for (const name of names) {
    const nftContract = await TestERC721.deploy(name, name, "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/");
    await nftContract.deployed();
    collateralTokens.push(nftContract.address);
    await Promise.all([
      nftContract.mint(accounts[0].address, 0),
      nftContract.mint(accounts[0].address, 1),
      nftContract.mint(accounts[0].address, 2),
    ]);
    console.log("%s: %s", name, nftContract.address);
  }

  /**************************************************************************/
  /* Pools */
  /**************************************************************************/
  for (let i = 0; i < collateralTokens.length; i++) {
    const durations = [30, 14, 7];
    for (let j = 0; j < durations.length; j++) {
      const calldata = ethers.utils.defaultAbiCoder.encode(
        ["address", "uint64", "address", "address", "address", "bytes", "bytes"],
        [
          wethTokenContract.address,
          durations[j] * 86400,
          collectionCollateralFilterImpl.address,
          fixedInterestRateModelImpl.address,
          ethers.constants.AddressZero,
          ethers.utils.defaultAbiCoder.encode(["address"], [collateralTokens[i]]),
          ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.from("0.02")]),
        ]
      );
      const createPoolTx = await poolFactory.createPool(calldata);
      const poolAddress = await (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
      const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
      const erc20Contract = ERC20__factory.connect(wethTokenContract.address, accounts[0]);
      await erc20Contract.approve(poolAddress, ethers.constants.MaxUint256);

      console.log("DEPOSITING TO: ", poolAddress);
      const maxBorrow = 20;
      let depth = maxBorrow - i - j;
      for (let k = 0; k < 3; k++) {
        await poolContract.deposit(
          ethers.utils.parseEther(`${depth}`),
          ethers.utils.parseEther(`${maxBorrow / depth}`)
        );
        depth *= 1.26;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
