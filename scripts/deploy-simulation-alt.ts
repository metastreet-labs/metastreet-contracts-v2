/* eslint-disable camelcase */
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";
import { extractEvent } from "../test/helpers/EventUtilities";
import { FixedPoint } from "../test/helpers/FixedPoint";
import { Tick } from "../test/helpers/Tick";
import { ERC20__factory, ERC721__factory, Pool__factory } from "../typechain";

async function main() {
  const accounts = await ethers.getSigners();

  /**************************************************************************/
  /* Misc */
  /**************************************************************************/
  /* Deploy Bundle Collateral Wrapper */
  const BundleCollateralWrapper = await ethers.getContractFactory("BundleCollateralWrapper", accounts[9]);
  const bundleCollateralWrapper = await BundleCollateralWrapper.deploy();
  console.log("BundleCollateralWrapper: ", bundleCollateralWrapper.address);
  /* Deploy English Auction Collateral Liquidator Implementation */
  const EnglishAuctionCollateralLiquidator = await ethers.getContractFactory(
    "EnglishAuctionCollateralLiquidator",
    accounts[9]
  );
  const englishAuctionCollateralLiquidatorImpl = await EnglishAuctionCollateralLiquidator.deploy([
    bundleCollateralWrapper.address,
  ]);
  /* Deploy English Auction Collateral Liquidator (Proxied) */
  const TestProxy = await ethers.getContractFactory("TestProxy", accounts[9]);
  const englishAuctionCollateralLiquidatorProxy = await TestProxy.deploy(
    englishAuctionCollateralLiquidatorImpl.address,
    englishAuctionCollateralLiquidatorImpl.interface.encodeFunctionData("initialize", [
      ethers.BigNumber.from(60 * 2),
      ethers.BigNumber.from(60),
      ethers.BigNumber.from(60 + 1),
      ethers.BigNumber.from(199),
    ])
  );
  console.log("EnglishAuctionCollateralLiquidator: ", englishAuctionCollateralLiquidatorProxy.address);
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
  /* Pool implementations */
  /**************************************************************************/
  /* Deploy Test Delegation Registry */
  const TestDelegationRegistry = await ethers.getContractFactory("TestDelegationRegistry", accounts[9]);
  const testDelegationRegistry = await TestDelegationRegistry.deploy();
  await testDelegationRegistry.deployed();
  console.log("TestDelegationRegistry: ", testDelegationRegistry.address);
  /* Deploy WeightedRateCollectionPool Implementation */
  const WeightedRateCollectionPool = await ethers.getContractFactory("WeightedRateCollectionPool", accounts[9]);
  const weightedRateCollectionPoolImpl = await WeightedRateCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegationRegistry.address,
    [bundleCollateralWrapper.address],
    {
      tickThreshold: FixedPoint.from("0.05"),
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateCollectionPoolImpl.deployed();
  console.log("WeightedRateCollectionPool Implementation: ", weightedRateCollectionPoolImpl.address);
  /* Deploy WeightedRateRangedCollectionPool Implementation */
  const WeightedRateRangedCollectionPool = await ethers.getContractFactory(
    "WeightedRateRangedCollectionPool",
    accounts[9]
  );
  const weightedRateRangedCollectionPoolImpl = await WeightedRateRangedCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegationRegistry.address,
    [bundleCollateralWrapper.address],
    {
      tickThreshold: FixedPoint.from("0.05"),
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateRangedCollectionPoolImpl.deployed();
  console.log("WeightedRateRangedCollectionPool Implementation: ", weightedRateRangedCollectionPoolImpl.address);
  /**************************************************************************/
  /* Pool beacons */
  /**************************************************************************/
  const UpgradeableBeacon = await ethers.getContractFactory("UpgradeableBeacon");

  const weightedRateCollectionPoolBeacon = await UpgradeableBeacon.deploy(weightedRateCollectionPoolImpl.address);
  await weightedRateCollectionPoolBeacon.deployed();
  console.log("WeightedRateCollectionPool Beacon: ", weightedRateCollectionPoolBeacon.address);

  const weightedRateRangedCollectionPoolBeacon = await UpgradeableBeacon.deploy(
    weightedRateRangedCollectionPoolImpl.address
  );
  await weightedRateRangedCollectionPoolBeacon.deployed();
  console.log("WeightedRateRangedCollectionPool Beacon: ", weightedRateRangedCollectionPoolBeacon.address);
  /**************************************************************************/
  /* Currency token */
  /**************************************************************************/
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const wethTokenContract = await TestERC20.deploy("Wrapped ETH", "WETH", 18, ethers.utils.parseEther("10000000"));
  await wethTokenContract.deployed();
  await wethTokenContract.transfer(accounts[0].address, ethers.utils.parseEther("5000000"));
  await wethTokenContract.transfer(accounts[1].address, ethers.utils.parseEther("5000000"));
  console.log("WETH : ", wethTokenContract.address);
  /**************************************************************************/
  /* NFT contracts */
  /**************************************************************************/
  const tokenIds = [0, 1, 2, 3];
  const TestERC721 = await ethers.getContractFactory("TestERC721");
  const collectionNames = [
    "CryptoPunks",
    "Bored Ape Yacht Club",
    "Mutant Ape Yacht Club",
    "Otherdeed for Otherside",
    "Azuki",
  ];
  const collateralTokens: string[] = [];
  for (const name of collectionNames) {
    const nftContract = await TestERC721.deploy(name, name, "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/");
    await nftContract.deployed();
    collateralTokens.push(nftContract.address);
    await Promise.all([tokenIds.map((id) => nftContract.mint(accounts[0].address, id))]);
    console.log("%s: %s", name, nftContract.address);
  }
  /**************************************************************************/
  /* Pools */
  /**************************************************************************/
  const pools: string[] = [];
  const poolsTicks: Record<string, BigNumber[]> = {};
  for (let i = 0; i < collateralTokens.length; i++) {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint64[]", "uint64[]"],
      [
        collateralTokens[i],
        wethTokenContract.address,
        [30 * 86400, 14 * 86400, 7 * 86400],
        [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")],
      ]
    );
    const createPoolTx = await poolFactory.createProxied(weightedRateCollectionPoolBeacon.address, params);
    const poolAddress = (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
    const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
    const erc20Contract = ERC20__factory.connect(wethTokenContract.address, accounts[0]);
    await erc20Contract.approve(poolAddress, ethers.constants.MaxUint256);

    console.log("DEPOSITING TO: ", poolAddress);
    const maxBorrow = 20;
    let depth = maxBorrow - i;
    const ticks: BigNumber[] = [];
    for (let k = 0; k < 3; k++) {
      const tick = Tick.encode(ethers.utils.parseEther(`${depth}`));
      await poolContract.deposit(tick, ethers.utils.parseEther(`${maxBorrow * depth}`), 0);
      ticks.push(tick);
      depth *= 1.26;
    }

    pools.push(poolAddress);
    poolsTicks[poolAddress] = ticks;
  }
  /**************************************************************************/
  /* Loans */
  /**************************************************************************/
  {
    const collateralToken = collateralTokens[0];
    const poolAddress = pools[0];
    const poolTicks = poolsTicks[poolAddress];
    const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
    const nftContract = ERC721__factory.connect(collateralToken, accounts[0]);

    // originate simple loan
    console.log("Originating single loan");
    await nftContract.setApprovalForAll(poolAddress, true);
    await poolContract.borrow(
      ethers.utils.parseEther("1"),
      7 * 86400,
      collateralToken,
      0,
      ethers.utils.parseEther("99"),
      poolTicks,
      "0x"
    );

    // originate bundle loan
    console.log("Originating bundle loan");
    await nftContract.setApprovalForAll(bundleCollateralWrapper.address, true);
    const mintTx = await bundleCollateralWrapper.connect(accounts[0]).mint(collateralToken, [1, 2]);
    const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
    const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;
    await bundleCollateralWrapper.connect(accounts[0]).setApprovalForAll(poolAddress, true);
    await poolContract.borrow(
      ethers.utils.parseEther("1"),
      7 * 86400,
      bundleCollateralWrapper.address,
      bundleTokenId,
      ethers.utils.parseEther("99"),
      poolTicks,
      ethers.utils.solidityPack(["uint16", "uint16", "bytes"], [1, ethers.utils.hexDataLength(bundleData), bundleData])
    );
  }
  /**************************************************************************/
  /* Auctions */
  /**************************************************************************/
  const collateralToken = collateralTokens[1];
  const poolAddress = pools[1];
  const poolTicks = poolsTicks[poolAddress];
  const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
  const nftContract = ERC721__factory.connect(collateralToken, accounts[0]);

  await nftContract.setApprovalForAll(poolAddress, true);

  const receipts: string[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const tx = await poolContract.borrow(
      ethers.utils.parseEther("1"),
      1,
      collateralToken,
      tokenIds[i],
      ethers.utils.parseEther("99"),
      poolTicks,
      "0x"
    );
    const loanOriginatedEvent = await extractEvent(tx, poolContract, "LoanOriginated");
    receipts.push(loanOriginatedEvent.args.loanReceipt);
  }

  for (let i = 0; i < receipts.length; i++) {
    await poolContract.liquidate(receipts[i]);
    console.log("Liquidated " + collectionNames[i] + " #" + tokenIds[i]);
  }
}

main()
  .then(() => {
    console.log("Deploy simulation succeeded");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
