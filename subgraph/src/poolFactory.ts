import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ERC20 } from "../generated/PoolFactory/ERC20";
import { ERC721 } from "../generated/PoolFactory/ERC721";
import { Pool as PoolContract } from "../generated/PoolFactory/Pool";
import { PoolCreated as PoolCreatedEvent } from "../generated/PoolFactory/PoolFactory";
import {
  RangedCollectionCollateralFilter as RangedCollectionCollateralFilterContract,
  RangedCollectionCollateralFilter__collateralTokenIdRangeResult,
} from "../generated/PoolFactory/RangedCollectionCollateralFilter";
import {
  CollateralToken as CollateralTokenEntity,
  CurrencyToken as CurrencyTokenEntity,
  Pool as PoolEntity,
} from "../generated/schema";
import { Pool as PoolTemplate } from "../generated/templates";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  const poolAddress = event.params.pool;
  const poolContract = PoolContract.bind(poolAddress);

  const collateralFilterName = poolContract.COLLATERAL_FILTER_NAME();
  const collateralTokenAddress = poolContract.collateralToken();

  let collateralTokenEntityId: string;
  let range: RangedCollectionCollateralFilter__collateralTokenIdRangeResult | null;
  if (collateralFilterName == "CollectionCollateralFilter") {
    collateralTokenEntityId = collateralTokenAddress.toHexString();
    range = null;
  } else {
    const rangedCollectionCollateralFilterContract = RangedCollectionCollateralFilterContract.bind(poolAddress);
    range = rangedCollectionCollateralFilterContract.collateralTokenIdRange();
    collateralTokenEntityId = `${collateralTokenAddress.toHexString()}:${range.value0}:${range.value1}`;
  }

  /**************************************************************************/
  /* Create Pool entity*/
  /**************************************************************************/
  const poolEntity = new PoolEntity(poolAddress);
  // Properties
  poolEntity.implementation = event.params.implementation;
  poolEntity.collateralToken = collateralTokenEntityId;
  poolEntity.collateralWrappers = poolContract.collateralWrappers().map<Bytes>((x) => x);
  poolEntity.currencyToken = poolContract.currencyToken();
  poolEntity.durations = poolContract.durations();
  poolEntity.rates = poolContract.rates();
  poolEntity.adminFeeRate = poolContract.adminFeeRate();
  poolEntity.collateralLiquidator = poolContract.collateralLiquidator();
  poolEntity.delegationRegistry = poolContract.delegationRegistry();
  // Derived properties
  const maxBorrows: BigInt[] = [];
  for (let i = 0; i < poolEntity.durations.length; i++) maxBorrows.push(BigInt.fromI32(0));
  poolEntity.maxBorrows = maxBorrows;
  poolEntity.maxLoanDuration = poolEntity.durations[poolEntity.durations.length - 1];
  // State
  poolEntity.adminFeeBalance = BigInt.zero();
  // Statistics
  poolEntity.totalValueLocked = BigInt.zero();
  poolEntity.totalValueAvailable = BigInt.zero();
  poolEntity.totalValueUsed = BigInt.zero();
  poolEntity.loansOriginated = BigInt.zero();
  poolEntity.loansActive = BigInt.zero();
  poolEntity.loansRepaid = BigInt.zero();
  poolEntity.loansLiquidated = BigInt.zero();
  poolEntity.loansCollateralLiquidated = BigInt.zero();

  poolEntity.save();

  /**************************************************************************/
  /* Create CollateralToken entity */
  /**************************************************************************/
  let collateralTokenEntity = CollateralTokenEntity.load(collateralTokenEntityId);
  if (!collateralTokenEntity) {
    /* Create collateral token entity if it doesn't exists */
    collateralTokenEntity = new CollateralTokenEntity(collateralTokenEntityId);
    collateralTokenEntity.address = collateralTokenAddress;
    if (range) {
      collateralTokenEntity.startTokenId = range.value0;
      collateralTokenEntity.endTokenId = range.value1;
    }
    collateralTokenEntity.auctionsActive = BigInt.zero();

    const erc721Contract = ERC721.bind(collateralTokenAddress);

    const tokenName = erc721Contract.try_name();
    if (tokenName.reverted) collateralTokenEntity.name = "Unknown Token";
    else collateralTokenEntity.name = tokenName.value;

    collateralTokenEntity.save();
  }
  /**************************************************************************/
  /* Create CurrencyToken entity */
  /**************************************************************************/
  let currencyTokenEntity = CurrencyTokenEntity.load(poolEntity.currencyToken);
  if (!currencyTokenEntity) {
    currencyTokenEntity = new CurrencyTokenEntity(poolEntity.currencyToken);

    const erc20Contract = ERC20.bind(Address.fromBytes(currencyTokenEntity.id));

    const tokenName = erc20Contract.try_name();
    if (tokenName.reverted) currencyTokenEntity.name = "Unknown Token";
    else currencyTokenEntity.name = tokenName.value;

    const tokenSymbol = erc20Contract.try_symbol();
    if (tokenSymbol.reverted) currencyTokenEntity.symbol = "UNK";
    else currencyTokenEntity.symbol = tokenSymbol.value;

    currencyTokenEntity.save();
  }
  /**************************************************************************/
  /* Create Pool data source*/
  /**************************************************************************/
  PoolTemplate.create(poolAddress);
}
