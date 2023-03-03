import { ethers } from "hardhat";

import { FixedPoint } from "../test/helpers/FixedPoint";
import { extractEvent } from "../test/helpers/EventUtilities";

async function main() {
  const accounts = await ethers.getSigners();
  console.log("Deploying from account #9 (%s)\n", accounts[9].address);

  const TestERC20 = await ethers.getContractFactory("TestERC20", accounts[9]);
  const TestERC721 = await ethers.getContractFactory("TestERC721", accounts[9]);
  const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
  const CollectionCollateralFilter = await ethers.getContractFactory("CollectionCollateralFilter", accounts[9]);
  const FixedInterestRateModel = await ethers.getContractFactory("FixedInterestRateModel", accounts[9]);
  const ExternalCollateralLiquidator = await ethers.getContractFactory("ExternalCollateralLiquidator", accounts[9]);
  const PoolFactory = await ethers.getContractFactory("PoolFactory", accounts[9]);

  /* Deploy liquidity manager library */
  const liquidityManagerLib = await LiquidityManager.deploy();
  await liquidityManagerLib.deployed();

  /* Deploy Pool implementation */
  const Pool = await ethers.getContractFactory("Pool", {
    signer: accounts[9],
    libraries: { LiquidityManager: liquidityManagerLib.address },
  });
  const poolImpl = await Pool.deploy();
  await poolImpl.deployed();
  console.log("Pool Implementation:        ", poolImpl.address);

  /* Deploy Pool Factory */
  const poolFactory = await PoolFactory.deploy(poolImpl.address);
  await poolFactory.deployed();
  console.log("Pool Factory:               ", poolFactory.address);

  console.log("");

  /* Deploy WETH */
  const wethTokenContract = await TestERC20.deploy("WETH", "WETH", 18, ethers.utils.parseEther("1000000"));
  await wethTokenContract.deployed();
  console.log("WETH ERC20 Contract:        ", wethTokenContract.address);

  /* Deploy BAYC */
  const baycTokenContract = await TestERC721.deploy(
    "BoredApeYachtClub",
    "BAYC",
    "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/"
  );
  await baycTokenContract.deployed();
  console.log("BAYC ERC721 Contract:       ", baycTokenContract.address);

  console.log("");

  /* Deploy Collection Collateral Filter Implementation */
  const collectionCollateralFilterImpl = await CollectionCollateralFilter.deploy();
  console.log("Collection Collateral Filter Impl:", collectionCollateralFilterImpl.address);

  /* Deploy Fixed Interest Rate Model Implementation */
  const fixedInterestRateModelImpl = await FixedInterestRateModel.deploy();
  console.log("Fixed Interest Rate Model Impl:", fixedInterestRateModelImpl.address);

  /* Deploy External Collateral Liquidator Implementation */
  const externalCollateralLiquidatorImpl = await ExternalCollateralLiquidator.deploy();
  console.log("External Collateral Liquidator Impl:", externalCollateralLiquidatorImpl.address);

  console.log("");

  /* Create WETH Pool */
  const calldata = ethers.utils.defaultAbiCoder.encode(
    ["address", "address", "uint64", "address", "address", "address", "address", "bytes", "bytes", "bytes"],
    [
      baycTokenContract.address,
      wethTokenContract.address,
      30 * 86400,
      ethers.constants.AddressZero,
      collectionCollateralFilterImpl.address,
      fixedInterestRateModelImpl.address,
      externalCollateralLiquidatorImpl.address,
      ethers.utils.defaultAbiCoder.encode(["address"], [baycTokenContract.address]),
      ethers.utils.defaultAbiCoder.encode(["uint256"], [FixedPoint.from("0.02")]),
      ethers.utils.defaultAbiCoder.encode(["address"], [accounts[0].address]),
    ]
  );
  const wethTestPoolCreationTx = await poolFactory.createPool(calldata);
  const wethTestPoolAddress = (await extractEvent(wethTestPoolCreationTx, poolFactory, "PoolCreated")).args.pool;
  console.log("WETH Test Pool:             ", wethTestPoolAddress);

  console.log("");

  console.log("Lender is        account #0 (%s)", accounts[0].address);
  console.log("Borrower is      account #1 (%s)", accounts[1].address);
  console.log("Depositer 1 is   account #2 (%s)", accounts[2].address);
  console.log("Depositer 2 is   account #3 (%s)", accounts[3].address);
  console.log("");

  await wethTokenContract.transfer(accounts[0].address, ethers.utils.parseEther("1000"));
  await wethTokenContract.transfer(accounts[1].address, ethers.utils.parseEther("1000"));
  await wethTokenContract.transfer(accounts[2].address, ethers.utils.parseEther("1000"));
  await wethTokenContract.transfer(accounts[3].address, ethers.utils.parseEther("1000"));
  console.log("Transferred 1000 WETH to account #0, #1, #2, #3");

  await baycTokenContract.mint(accounts[1].address, 123);
  await baycTokenContract.mint(accounts[1].address, 456);
  await baycTokenContract.mint(accounts[1].address, 768);
  console.log("Minted BAYC #123, #456, #768 to account #1");

  await baycTokenContract.connect(accounts[1]).setApprovalForAll(wethTestPoolAddress, true);
  console.log("Approved BAYC transfer for WETH Pool for account #1");

  await wethTokenContract.connect(accounts[1]).approve(wethTestPoolAddress, ethers.constants.MaxUint256);
  console.log("Approved WETH transfer for WETH Pool for account #1");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
