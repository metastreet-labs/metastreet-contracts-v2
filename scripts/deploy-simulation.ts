import { ethers } from "hardhat";

async function main() {
  const accounts = await ethers.getSigners();
  console.log("Deploying from account #9 (%s)\n", accounts[9].address);

  const TestERC20 = await ethers.getContractFactory("TestERC20", accounts[9]);
  const TestERC721 = await ethers.getContractFactory("TestERC721", accounts[9]);
  const AllowCollateralFilter = await ethers.getContractFactory("AllowCollateralFilter", accounts[9]);
  const TestInterestRateModel = await ethers.getContractFactory("TestInterestRateModel", accounts[9]);
  const PoolFactory = await ethers.getContractFactory("PoolFactory", accounts[9]);

  /* Deploy Pool Factory */
  const poolFactory = await PoolFactory.deploy();
  console.log("PoolFactory:             ", poolFactory.address);

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

  /* Deploy Test Collateral Filter */
  const allowCollateralFilter = await AllowCollateralFilter.deploy([baycTokenContract.address]);
  console.log("Allow Collateral Filter:   ", allowCollateralFilter.address);

  /* Deploy Test Interest Rate Model */
  const testInterestRateModel = await TestInterestRateModel.deploy(ethers.utils.parseEther("0.02"));
  console.log("Test Interest Rate Model:   ", testInterestRateModel.address);

  /* Create WETH Pool */
  const calldata = ethers.utils.defaultAbiCoder.encode(
    ["address", "uint64", "address", "address", "address"],
    [
      wethTokenContract.address,
      30 * 86400,
      allowCollateralFilter.address,
      testInterestRateModel.address,
      ethers.constants.AddressZero,
    ]
  );
  const wethTestPoolCreationTx = await poolFactory.createPool(calldata);
  const wethTestPoolCreationReceipt = await wethTestPoolCreationTx.wait();
  const wethTestPoolAddress = wethTestPoolCreationReceipt.events?.[0].args?.[0] as string;
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
