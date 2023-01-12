import { Address, BigInt } from "@graphprotocol/graph-ts";
import { ERC721 } from "../generated/PoolFactory/ERC721";
import { ICollateralFilter } from "../generated/PoolFactory/ICollateralFilter";
import { IPool } from "../generated/PoolFactory/IPool";
import { PoolCreated } from "../generated/PoolFactory/IPoolFactory";
import { Pool } from "../generated/schema";
import { Pool as PoolTemplate } from "../generated/templates";

export function handlePoolCreated(event: PoolCreated): void {
  /* create pool entity */
  const poolContract = IPool.bind(event.params.pool);
  const collateralFilterContract = ICollateralFilter.bind(poolContract.collateralFilter());
  const poolEntity = new Pool(event.params.pool.toHexString());
  poolEntity.currencyToken = poolContract.currencyToken();
  poolEntity.maxLoanDuration = poolContract.maxLoanDuration();
  poolEntity.collateralFilter = poolContract.collateralFilter();
  poolEntity.interestRateModel = poolContract.interestRateModel();
  poolEntity.collateralLiquidator = poolContract.collateralLiquidator();
  poolEntity.loansPurchasedCount = BigInt.zero();
  poolEntity.loansRepaidCount = BigInt.zero();
  poolEntity.loansDefaultedCount = BigInt.zero();
  poolEntity.loansLiquidatedCount = BigInt.zero();
  poolEntity.totalValueLocked = BigInt.zero();
  poolEntity.collateralToken = collateralFilterContract.tokens()[0];
  const erc721Contract = ERC721.bind(Address.fromString(poolEntity.collateralToken.toHexString()));
  const tokenName = erc721Contract.try_name();
  if (tokenName.reverted) poolEntity.collateralTokenName = "Unnamed Token";
  else poolEntity.collateralTokenName = tokenName.value;
  poolEntity.save();
  /* create pool data source */
  PoolTemplate.create(event.params.pool);
}
