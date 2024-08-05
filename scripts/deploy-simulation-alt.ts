/* eslint-disable camelcase */
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";
import { getContractFactoryWithLibraries } from "../test/helpers/Deploy";
import { extractEvent } from "../test/helpers/EventUtilities";
import { FixedPoint } from "../test/helpers/FixedPoint";
import { MerkleTree } from "../test/helpers/MerkleTree";
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

  /* Deploy ERC1155 Collateral Wrapper */
  const ERC1155CollateralWrapper = await ethers.getContractFactory("ERC1155CollateralWrapper", accounts[9]);
  const erc1155CollateralWrapper = await ERC1155CollateralWrapper.deploy();
  console.log("ERC1155CollateralWrapper: ", erc1155CollateralWrapper.address);

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

  const ERC20DepositTokenImplementation = await ethers.getContractFactory("ERC20DepositTokenImplementation");
  const erc20DepositTokenImplementation = await ERC20DepositTokenImplementation.deploy();
  await erc20DepositTokenImplementation.deployed();

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
  const poolFactory = await ethers.getContractAt("PoolFactory", poolFactoryProxy.address, accounts[9]);
  console.log("PoolFactory: ", poolFactory.address);

  /**************************************************************************/
  /* Pool implementations */
  /**************************************************************************/

  /* Deploy Test Delegate Registry V1 */
  const TestDelegateRegistryV1 = await ethers.getContractFactory("TestDelegateRegistryV1", accounts[9]);
  const testDelegateRegistryV1 = await TestDelegateRegistryV1.deploy();
  await testDelegateRegistryV1.deployed();
  console.log("TestDelegateV1Registry: ", testDelegateRegistryV1.address);

  /* Deploy Test Delegate Registry V2 */
  const TestDelegateRegistryV2 = await ethers.getContractFactory("TestDelegateRegistryV2", accounts[9]);
  const testDelegateRegistryV2 = await TestDelegateRegistryV2.deploy();
  await testDelegateRegistryV2.deployed();
  console.log("TestDelegateV2Registry: ", testDelegateRegistryV2.address);

  /* Deploy ERC20 Deposit Token Implementation */
  const ERC20DepositTokenImplementation = await ethers.getContractFactory("ERC20DepositTokenImplementation");
  const erc20DepositTokenImplementation = await ERC20DepositTokenImplementation.deploy();
  await erc20DepositTokenImplementation.deployed();

  /* Deploy WeightedRateCollectionPool Implementation */
  const WeightedRateCollectionPool = await getContractFactoryWithLibraries(
    "WeightedRateCollectionPool",
    ["LiquidityLogic", "DepositLogic", "BorrowLogic", "ERC20DepositTokenFactory"],
    accounts[9]
  );
  const weightedRateCollectionPoolImpl = await WeightedRateCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegateRegistryV1.address,
    testDelegateRegistryV2.address,
    erc20DepositTokenImplementation.address,
    [bundleCollateralWrapper.address, erc1155CollateralWrapper.address],
    {
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateCollectionPoolImpl.deployed();
  await poolFactory.addPoolImplementation(weightedRateCollectionPoolImpl.address);

  /* Deploy WeightedRateRangedCollectionPool Implementation */
  const WeightedRateRangedCollectionPool = await getContractFactoryWithLibraries(
    "WeightedRateRangedCollectionPool",
    ["LiquidityLogic", "DepositLogic", "BorrowLogic", "ERC20DepositTokenFactory"],
    accounts[9]
  );
  const weightedRateRangedCollectionPoolImpl = await WeightedRateRangedCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegateRegistryV1.address,
    testDelegateRegistryV2.address,
    erc20DepositTokenImplementation.address,
    [bundleCollateralWrapper.address, erc1155CollateralWrapper.address],
    {
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateRangedCollectionPoolImpl.deployed();
  console.log("WeightedRateRangedCollectionPool Implementation: ", weightedRateRangedCollectionPoolImpl.address);

  /* Deploy WeightedRateSetCollectionPool Implementation */
  const WeightedRateSetCollectionPool = await getContractFactoryWithLibraries(
    "WeightedRateSetCollectionPool",
    ["LiquidityLogic", "DepositLogic", "BorrowLogic", "ERC20DepositTokenFactory"],
    accounts[9]
  );
  const weightedRateSetCollectionPoolImpl = await WeightedRateSetCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegateRegistryV1.address,
    testDelegateRegistryV2.address,
    erc20DepositTokenImplementation.address,
    [bundleCollateralWrapper.address, erc1155CollateralWrapper.address],
    {
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateSetCollectionPoolImpl.deployed();
  console.log("WeightedRateSetCollectionPool Implementation: ", weightedRateSetCollectionPoolImpl.address);

  /* Deploy WeightedRateMerkleCollectionPool Implementation */
  const WeightedRateMerkleCollectionPool = await getContractFactoryWithLibraries(
    "WeightedRateMerkleCollectionPool",
    ["LiquidityLogic", "DepositLogic", "BorrowLogic", "ERC20DepositTokenFactory"],
    accounts[9]
  );
  const weightedRateMerkleCollectionPoolImpl = await WeightedRateMerkleCollectionPool.deploy(
    englishAuctionCollateralLiquidatorProxy.address,
    testDelegateRegistryV1.address,
    testDelegateRegistryV2.address,
    erc20DepositTokenImplementation.address,
    [bundleCollateralWrapper.address, erc1155CollateralWrapper.address],
    {
      tickExponential: FixedPoint.from("1.5"),
    }
  );
  await weightedRateMerkleCollectionPoolImpl.deployed();
  console.log("WeightedRateMerkleCollectionPool Implementation: ", weightedRateMerkleCollectionPoolImpl.address);

  /**************************************************************************/
  /* Pool beacons */
  /**************************************************************************/

  const UpgradeableBeacon = await ethers.getContractFactory("UpgradeableBeacon");

  const weightedRateCollectionPoolBeacon = await UpgradeableBeacon.deploy(weightedRateCollectionPoolImpl.address);
  await weightedRateCollectionPoolBeacon.deployed();
  console.log("WeightedRateCollectionPool Beacon: ", weightedRateCollectionPoolBeacon.address);
  await poolFactory.addPoolImplementation(weightedRateCollectionPoolBeacon.address);

  const weightedRateRangedCollectionPoolBeacon = await UpgradeableBeacon.deploy(
    weightedRateRangedCollectionPoolImpl.address
  );
  await weightedRateRangedCollectionPoolBeacon.deployed();
  console.log("WeightedRateRangedCollectionPool Beacon: ", weightedRateRangedCollectionPoolBeacon.address);
  await poolFactory.addPoolImplementation(weightedRateRangedCollectionPoolBeacon.address);

  const weightedRateSetCollectionPoolBeacon = await UpgradeableBeacon.deploy(weightedRateSetCollectionPoolImpl.address);
  await weightedRateSetCollectionPoolBeacon.deployed();
  console.log("WeightedRateSetCollectionPool Beacon: ", weightedRateSetCollectionPoolBeacon.address);
  await poolFactory.addPoolImplementation(weightedRateSetCollectionPoolBeacon.address);

  const weightedRateMerkleCollectionPoolBeacon = await UpgradeableBeacon.deploy(
    weightedRateMerkleCollectionPoolImpl.address
  );
  await weightedRateMerkleCollectionPoolBeacon.deployed();
  console.log("WeightedRateMerkleCollectionPool Beacon: ", weightedRateMerkleCollectionPoolBeacon.address);
  await poolFactory.addPoolImplementation(weightedRateMerkleCollectionPoolBeacon.address);

  /**************************************************************************/
  /* Currency token */
  /**************************************************************************/

  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const wethTokenContract = await TestERC20.deploy("Wrapped ETH", "WETH", 18, ethers.parseEther("10000000"));
  await wethTokenContract.deployed();
  await wethTokenContract.transfer(accounts[0].address, ethers.parseEther("5000000"));
  await wethTokenContract.transfer(accounts[1].address, ethers.parseEther("5000000"));
  console.log("WETH : ", wethTokenContract.address);

  /**************************************************************************/
  /* Mint ERC721s */
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
  /* Mint ERC1155s */
  /**************************************************************************/

  const TestERC1155 = await ethers.getContractFactory("TestERC1155");
  const uri = "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/";
  const erc1155 = await TestERC1155.deploy(uri);
  await erc1155.deployed();
  console.log("ERC1155: ", erc1155.address);
  await erc1155.mintBatch(
    accounts[0].address,
    tokenIds,
    tokenIds.map(() => 20),
    "0x"
  );
  collateralTokens.push(erc1155.address);

  /**************************************************************************/
  /* Pools */
  /**************************************************************************/

  const pools: string[] = [];
  const poolsTicks: Record<string, BigNumber[]> = {};
  const durations = [30 * 86400, 14 * 86400, 7 * 86400];
  const rates = [FixedPoint.normalizeRate("0.10"), FixedPoint.normalizeRate("0.30"), FixedPoint.normalizeRate("0.50")];

  async function createCollectionPool(i: number) {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address[]", "address", "uint64[]", "uint64[]"],
      [[collateralTokens[i]], wethTokenContract.address, durations, rates]
    );
    const createPoolTx = await poolFactory.createProxied(weightedRateCollectionPoolBeacon.address, params);
    console.log("DEPLOYED COLLECTION POOL");
    return (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
  }

  async function createRangedCollectionPool(i: number) {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "uint256", "address", "uint64[]", "uint64[]"],
      [collateralTokens[i], 0, 2, wethTokenContract.address, durations, rates]
    );
    const createPoolTx = await poolFactory.createProxied(weightedRateRangedCollectionPoolBeacon.address, params);
    console.log("DEPLOYED RANGED POOL");
    return (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
  }

  async function createSetCollectionPool(i: number) {
    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256[]", "address", "uint64[]", "uint64[]"],
      [collateralTokens[i], tokenIds, wethTokenContract.address, durations, rates]
    );
    const createPoolTx = await poolFactory.createProxied(weightedRateSetCollectionPoolBeacon.address, params);
    console.log("DEPLOYED SET POOL");
    return (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
  }

  async function createMerkleCollectionPool(i: number) {
    const merkleTree = MerkleTree.buildTree(
      tokenIds.map((tokenId) => [tokenId]),
      ["uint256"]
    );
    const nodeCount = Math.ceil(Math.log2(tokenIds.length));
    const metadataURI = "ipfs://QmNVBJQVukFgLCurdvEpJ9HU4f9PovMSRzhFbzxzsPiCFJ/";

    const params = ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes32", "uint32", "string", "address", "uint64[]", "uint64[]"],
      [collateralTokens[i], merkleTree.root, nodeCount, metadataURI, wethTokenContract.address, durations, rates]
    );
    const createPoolTx = await poolFactory.createProxied(weightedRateMerkleCollectionPoolBeacon.address, params);
    console.log("DEPLOYED MERKLE POOL");
    return (await extractEvent(createPoolTx, poolFactory, "PoolCreated")).args.pool;
  }

  for (let i = 0; i < collateralTokens.length; i++) {
    let poolAddress: string;
    if (i === 0) poolAddress = await createRangedCollectionPool(i);
    if (i === 2) poolAddress = await createMerkleCollectionPool(i);
    else if (i === collateralTokens.length - 1) poolAddress = await createSetCollectionPool(i);
    else poolAddress = await createCollectionPool(i);

    const poolContract = Pool__factory.connect(poolAddress, accounts[0]);
    const erc20Contract = ERC20__factory.connect(wethTokenContract.address, accounts[0]);
    await erc20Contract.approve(poolAddress, ethers.constants.MaxUint256);

    console.log("DEPOSITING TO: ", poolAddress);
    const maxBorrow = 20;
    let depth = maxBorrow - i;
    const ticks: BigNumber[] = [];
    for (let k = 0; k < 3; k++) {
      const tick = Tick.encode(ethers.parseEther(`${depth}`));
      await poolContract.deposit(tick, ethers.parseEther(`${maxBorrow * depth}`), 0);
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
      ethers.parseEther("1"),
      7 * 86400,
      collateralToken,
      0,
      ethers.parseEther("99"),
      poolTicks,
      "0x"
    );

    // originate bundle loan
    {
      console.log("Originating bundle loan");
      await nftContract.setApprovalForAll(bundleCollateralWrapper.address, true);
      const mintTx = await bundleCollateralWrapper.connect(accounts[0]).mint(collateralToken, [1, 2]);
      const bundleTokenId = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.tokenId;
      const bundleData = (await extractEvent(mintTx, bundleCollateralWrapper, "BundleMinted")).args.encodedBundle;
      await bundleCollateralWrapper.connect(accounts[0]).setApprovalForAll(poolAddress, true);
      await poolContract.borrow(
        ethers.parseEther("1"),
        7 * 86400,
        bundleCollateralWrapper.address,
        bundleTokenId,
        ethers.parseEther("99"),
        poolTicks,
        ethers.utils.solidityPack(
          ["uint16", "uint16", "bytes"],
          [1, ethers.utils.hexDataLength(bundleData), bundleData]
        )
      );
    }

    // originate batch loan
    {
      console.log("Originating batch loan");
      const poolAddress = pools[pools.length - 1];
      const poolContract = Pool__factory.connect(pools[pools.length - 1], accounts[0]);
      const poolTicks = poolsTicks[poolContract.address];
      await erc1155.setApprovalForAll(erc1155CollateralWrapper.address, true);
      const mintTx = await erc1155CollateralWrapper.connect(accounts[0]).mint(
        erc1155.address,
        tokenIds,
        tokenIds.map(() => 3)
      );
      const batchTokenId = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args.tokenId;
      const batchData = (await extractEvent(mintTx, erc1155CollateralWrapper, "BatchMinted")).args.encodedBatch;
      await erc1155CollateralWrapper.connect(accounts[0]).setApprovalForAll(poolAddress, true);
      await poolContract.borrow(
        ethers.parseEther("1"),
        7 * 86400,
        erc1155CollateralWrapper.address,
        batchTokenId,
        ethers.parseEther("99"),
        poolTicks,
        ethers.utils.solidityPack(["uint16", "uint16", "bytes"], [1, ethers.utils.hexDataLength(batchData), batchData])
      );
    }
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
      ethers.parseEther("1"),
      1,
      collateralToken,
      tokenIds[i],
      ethers.parseEther("99"),
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
