import { ethers } from "hardhat";

import { FixedPoint } from "../test/helpers/FixedPoint";
import { extractEvent } from "../test/helpers/EventUtilities";

async function main() {
  const accounts = await ethers.getSigners();
  console.log("Deploying from account #9 (%s)\n", accounts[9].address);

  const TestERC20 = await ethers.getContractFactory("TestERC20", accounts[9]);
  const TestERC721 = await ethers.getContractFactory("TestERC721", accounts[9]);
  const TestProxy = await ethers.getContractFactory("TestProxy", accounts[9]);
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy", accounts[9]);
  const BundleCollateralWrapper = await ethers.getContractFactory("BundleCollateralWrapper", accounts[9]);
  const ExternalCollateralLiquidator = await ethers.getContractFactory("ExternalCollateralLiquidator", accounts[9]);
  const Pool = await ethers.getContractFactory("WeightedRateCollectionPool", accounts[9]);
  const PoolFactory = await ethers.getContractFactory("PoolFactory", accounts[9]);

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

  /* Deploy Bundle Collateral Wrapper */
  const bundleCollateralWrapper = await BundleCollateralWrapper.deploy();
  console.log("Bundle Collateral Wrapper:  ", bundleCollateralWrapper.address);

  console.log("");

  /* Deploy External Collateral Liquidator Implementation */
  const externalCollateralLiquidatorImpl = await ExternalCollateralLiquidator.deploy();

  /* Deploy External Collateral Liquidator (Proxied) */
  const externalCollateralLiquidatorProxy = await TestProxy.deploy(
    externalCollateralLiquidatorImpl.address,
    externalCollateralLiquidatorImpl.interface.encodeFunctionData("initialize")
  );
  console.log("Collateral Liquidator:      ", externalCollateralLiquidatorProxy.address);

  console.log("");

  /* Deploy Pool implementation */
  const poolImpl = await Pool.deploy(ethers.constants.AddressZero, [bundleCollateralWrapper.address]);
  await poolImpl.deployed();
  console.log("Pool Implementation:        ", poolImpl.address);

  console.log("");

  /* Deploy Pool Factory implementation */
  const poolFactoryImpl = await PoolFactory.deploy();
  await poolFactoryImpl.deployed();
  console.log("Pool Factory Implementation:", poolFactoryImpl.address);

  /* Deploy Pool Factory */
  const poolFactoryProxy = await ERC1967Proxy.deploy(
    poolFactoryImpl.address,
    poolFactoryImpl.interface.encodeFunctionData("initialize")
  );
  await poolFactoryProxy.deployed();
  const poolFactory = (await ethers.getContractAt("PoolFactory", poolFactoryProxy.address)) as PoolFactory;

  console.log("Pool Factory:               ", poolFactory.address);

  console.log("");

  /* Create WETH Pool */
  const params = ethers.utils.defaultAbiCoder.encode(
    ["address", "address", "uint32", "uint64[]", "uint64[]", "tuple(uint64, uint64)"],
    [
      baycTokenContract.address,
      wethTokenContract.address,
      45,
      [7 * 86400, 14 * 86400, 30 * 86400],
      [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
      [FixedPoint.from("0.05"), FixedPoint.from("2.0")],
    ]
  );
  const wethTestPoolCreationTx = await poolFactory.create(
    poolImpl.address,
    params,
    externalCollateralLiquidatorProxy.address
  );
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
