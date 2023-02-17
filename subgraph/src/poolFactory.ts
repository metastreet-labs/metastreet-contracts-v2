import { BigInt } from "@graphprotocol/graph-ts";
import { ERC721 } from "../generated/PoolFactory/ERC721";
import { ICollateralFilter } from "../generated/PoolFactory/ICollateralFilter";
import { IPool } from "../generated/PoolFactory/IPool";
import { PoolCreated } from "../generated/PoolFactory/IPoolFactory";
import { CollateralToken, Pool } from "../generated/schema";
import { Pool as PoolTemplate } from "../generated/templates";

export function handlePoolCreated(event: PoolCreated): void {
  const poolAddress = event.params.pool;
  const poolId = poolAddress.toHexString();
  const poolContract = IPool.bind(poolAddress);
  const collateralFilterContract = ICollateralFilter.bind(poolContract.collateralFilter());
  const collateralTokenAddress = collateralFilterContract.tokens()[0];
  const collateralTokenID = collateralTokenAddress.toHexString();
  /* create pool entity */
  const poolEntity = new Pool(poolId);
  poolEntity.currencyToken = poolContract.currencyToken();
  poolEntity.maxLoanDuration = poolContract.maxLoanDuration().toI32();
  poolEntity.collateralFilter = poolContract.collateralFilter();
  poolEntity.interestRateModel = poolContract.interestRateModel();
  poolEntity.collateralLiquidator = poolContract.collateralLiquidator();
  poolEntity.loansPurchasedCount = BigInt.zero();
  poolEntity.loansRepaidCount = BigInt.zero();
  poolEntity.loansDefaultedCount = BigInt.zero();
  poolEntity.loansLiquidatedCount = BigInt.zero();
  poolEntity.totalValueLocked = BigInt.zero();
  poolEntity.maxBorrow = BigInt.zero();
  poolEntity.collateralToken = collateralTokenID;
  poolEntity.save();

  let collateralTokenEntity = CollateralToken.load(collateralTokenID);
  if (collateralTokenEntity) {
    /* Update collateral token entity if it exists */
    const poolIds = collateralTokenEntity.poolIds;
    poolIds.push(poolId);
    collateralTokenEntity.poolIds = poolIds;
    if (collateralTokenEntity.maxLoanDuration < poolEntity.maxLoanDuration) {
      collateralTokenEntity.maxLoanDuration = poolEntity.maxLoanDuration;
    }
  } else {
    /* Create collateral token entity if it doesn't exists */
    collateralTokenEntity = new CollateralToken(collateralTokenID);
    collateralTokenEntity.poolIds = [poolId];
    collateralTokenEntity.totalValueLocked = BigInt.zero();
    collateralTokenEntity.maxLoanDuration = poolEntity.maxLoanDuration;
    collateralTokenEntity.minAPR = 0;
    const erc721Contract = ERC721.bind(collateralTokenAddress);
    const tokenName = erc721Contract.try_name();
    if (tokenName.reverted) collateralTokenEntity.name = "Unnamed Token";
    else collateralTokenEntity.name = tokenName.value;
  }
  collateralTokenEntity.save();

  /* create pool data source */
  PoolTemplate.create(event.params.pool);
}
