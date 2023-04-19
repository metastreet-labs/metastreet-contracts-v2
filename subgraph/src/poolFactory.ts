import { BigInt } from "@graphprotocol/graph-ts";
import { ERC721 } from "../generated/PoolFactory/ERC721";

import { CollectionCollateralFilter as CollectionCollateralFilterContract } from "../generated/PoolFactory/CollectionCollateralFilter";
import { Pool as PoolContract } from "../generated/PoolFactory/Pool";
import { PoolCreated as PoolCreatedEvent } from "../generated/PoolFactory/PoolFactory";
import { CollateralToken as CollateralTokenEntity, Pool as PoolEntity } from "../generated/schema";
import { Pool as PoolTemplate } from "../generated/templates";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  const poolAddress = event.params.pool;
  const poolId = poolAddress.toHexString();
  const poolContract = PoolContract.bind(poolAddress);
  const collectionCollateralFilterContract = CollectionCollateralFilterContract.bind(poolAddress);
  const collateralTokenAddress = collectionCollateralFilterContract.collateralToken();
  const collateralTokenId = collateralTokenAddress.toHexString();

  /**************************************************************************/
  /* Create Pool entity*/
  /**************************************************************************/
  const poolEntity = new PoolEntity(poolId);
  poolEntity.currencyToken = poolContract.currencyToken();
  poolEntity.totalValueLocked = BigInt.zero();
  poolEntity.totalValueAvailable = BigInt.zero();
  poolEntity.totalValueUsed = BigInt.zero();
  poolEntity.maxBorrow = BigInt.zero();
  poolEntity.collateralToken = collateralTokenId;
  poolEntity.delegationRegistry = poolContract.delegationRegistry();

  const durationsBigInt = poolContract.durations();
  const durationsNumber = new Array<i32>(0);
  for (let i = 0; i < durationsBigInt.length; i++) durationsNumber.push(durationsBigInt[i].toI32());
  poolEntity.durations = durationsNumber;

  poolEntity.rates = poolContract.rates();

  poolEntity.maxLoanDuration = poolEntity.durations[poolEntity.durations.length - 1];

  poolEntity.save();

  /**************************************************************************/
  /* Create or update CollateralToken entity*/
  /**************************************************************************/
  let collateralTokenEntity = CollateralTokenEntity.load(collateralTokenId);
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
    collateralTokenEntity = new CollateralTokenEntity(collateralTokenId);
    collateralTokenEntity.poolIds = [poolId];
    collateralTokenEntity.totalValueLocked = BigInt.zero();
    collateralTokenEntity.totalValueUsed = BigInt.zero();
    collateralTokenEntity.maxBorrow = BigInt.zero();
    collateralTokenEntity.maxLoanDuration = poolEntity.maxLoanDuration;
    collateralTokenEntity.minAPR = 0;
    const erc721Contract = ERC721.bind(collateralTokenAddress);
    const tokenName = erc721Contract.try_name();
    if (tokenName.reverted) collateralTokenEntity.name = "Unnamed Token";
    else collateralTokenEntity.name = tokenName.value;
  }
  collateralTokenEntity.save();

  /**************************************************************************/
  /* Create Pool data source*/
  /**************************************************************************/
  PoolTemplate.create(event.params.pool);
}
