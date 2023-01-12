import { BigInt } from "@graphprotocol/graph-ts";
import { ERC721 } from "../../subgraph/generated/PoolFactory/ERC721";
import { ICollateralFilter } from "../../subgraph/generated/PoolFactory/ICollateralFilter";
import { IPool } from "../../subgraph/generated/PoolFactory/IPool";
import { PoolCreated } from "../../subgraph/generated/PoolFactory/IPoolFactory";
import { Pool } from "../../subgraph/generated/schema";

export function handlePoolCreated(event: PoolCreated) {
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
  const erc721Contract = ERC721.bind(poolEntity.collateralToken);
  poolEntity.collateralTokenName = erc721Contract.name();
  poolEntity.save();
}
