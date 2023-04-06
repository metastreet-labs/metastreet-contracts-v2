/* eslint-disable camelcase */
import { ethers } from "hardhat";
import { extractEvent } from "../test/helpers/EventUtilities";
import { FixedPoint } from "../test/helpers/FixedPoint";
import { ERC20__factory, Pool__factory } from "../typechain";

async function main() {
  const accounts = await ethers.getSigners();

  /**************************************************************************/
  /* Misc */
  /**************************************************************************/
  /* Deploy Bundle Collateral Wrapper */
  const BundleCollateralWrapper = await ethers.getContractFactory("BundleCollateralWrapper", accounts[9]);
  const bundleCollateralWrapper = await BundleCollateralWrapper.deploy();
  /* Deploy External Collateral Liquidator Implementation */
  const ExternalCollateralLiquidator = await ethers.getContractFactory("ExternalCollateralLiquidator", accounts[9]);
  const externalCollateralLiquidatorImpl = await ExternalCollateralLiquidator.deploy();
  /* Deploy External Collateral Liquidator (Proxied) */
  const TestProxy = await ethers.getContractFactory("TestProxy", accounts[9]);
  const externalCollateralLiquidatorProxy = await TestProxy.deploy(
    externalCollateralLiquidatorImpl.address,
    externalCollateralLiquidatorImpl.interface.encodeFunctionData("initialize", [accounts[0].address])
  );
  /**************************************************************************/
  /* PoolFactory */
  /**************************************************************************/
  /* Deploy Pool Factory implementation */
  const PoolFactory = await ethers.getContractFactory("PoolFactory");
  const poolFactoryImpl = await PoolFactory.deploy();
  await poolFactoryImpl.deployed();
  /* Deploy Pool Factory */
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy", accounts[9]);
  const poolFactoryProxy = await ERC1967Proxy.deploy(
    poolFactoryImpl.address,
    poolFactoryImpl.interface.encodeFunctionData("initialize")
  );
  await poolFactoryProxy.deployed();
  const poolFactory = await ethers.getContractAt("PoolFactory", poolFactoryProxy.address);
  console.log("PoolFactory: ", poolFactory.address);
  /**************************************************************************/
  /* Pool implementation */
  /**************************************************************************/
  const Pool = await ethers.getContractFactory("FixedRateSingleCollectionPool", accounts[9]);
  const poolImpl = await Pool.deploy(ethers.constants.AddressZero, [bundleCollateralWrapper.address]);
  await poolImpl.deployed();
  console.log("Pool Implementation: ", poolImpl.address);
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
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64", "uint256", "address[]", "tuple(uint64, uint64, uint64)"],
      [
        collateralTokens[i],
        wethTokenContract.address,
        7 * 86400,
        45,
        [bundleCollateralWrapper.address],
        [FixedPoint.normalizeRate("0.02"), FixedPoint.from("0.05"), FixedPoint.from("2.0")],
      ]
    );
    const createPoolTx = await poolFactory.create(poolImpl.address, params, externalCollateralLiquidatorProxy.address);
    const poolAddress = (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
    const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
    const erc20Contract = ERC20__factory.connect(wethTokenContract.address, accounts[0]);
    await erc20Contract.approve(poolAddress, ethers.constants.MaxUint256);

    console.log("DEPOSITING TO: ", poolAddress);
    const maxBorrow = 20;
    let depth = maxBorrow - i;
    for (let k = 0; k < 3; k++) {
      await poolContract.deposit(ethers.utils.parseEther(`${depth}`), ethers.utils.parseEther(`${maxBorrow / depth}`));
      depth *= 1.26;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
