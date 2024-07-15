import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ERC20 } from "../generated/PoolFactory/ERC20";
import { ERC721 } from "../generated/PoolFactory/ERC721";
import { ExternalPriceOracle } from "../generated/PoolFactory/ExternalPriceOracle";
import { MerkleCollectionCollateralFilter as MerkleCollectionCollateralFilterContract } from "../generated/PoolFactory/MerkleCollectionCollateralFilter";
import { Pool as PoolContract } from "../generated/PoolFactory/Pool";
import { PoolCreated as PoolCreatedEvent } from "../generated/PoolFactory/PoolFactory";
import { RangedCollectionCollateralFilter as RangedCollectionCollateralFilterContract } from "../generated/PoolFactory/RangedCollectionCollateralFilter";
import { SetCollectionCollateralFilter as SetCollectionCollateralFilterContract } from "../generated/PoolFactory/SetCollectionCollateralFilter";
import {
  CollateralToken as CollateralTokenEntity,
  CurrencyToken as CurrencyTokenEntity,
  Pool as PoolEntity,
} from "../generated/schema";
import { Pool as PoolTemplate, PoolV1 as PoolTemplateV1 } from "../generated/templates";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  /**************************************************************************/
  /* Create Pool entity*/
  /**************************************************************************/

  const poolAddress = event.params.pool;
  const poolContract = PoolContract.bind(poolAddress);

  const poolEntity = new PoolEntity(poolAddress);
  // Properties
  poolEntity.implementationVersionMajor = poolContract.IMPLEMENTATION_VERSION().split(".")[0];
  poolEntity.implementation = event.params.implementation;
  poolEntity.collateralToken = poolContract.collateralToken();
  poolEntity.currencyToken = poolContract.currencyToken();
  poolEntity.collateralWrappers = poolContract.collateralWrappers().map<Bytes>((x) => x);
  poolEntity.durations = poolContract.durations();
  poolEntity.rates = poolContract.rates();
  poolEntity.adminFeeRate = poolContract.adminFeeRate();
  poolEntity.adminFeeShareRecipient = Address.zero();
  poolEntity.adminFeeShareSplit = 0;
  poolEntity.collateralLiquidator = poolContract.collateralLiquidator();
  poolEntity.delegationRegistry = poolContract.delegationRegistry();
  const externalPriceOracle = ExternalPriceOracle.bind(poolAddress).try_priceOracle();
  poolEntity.externalPriceOracle = !externalPriceOracle.reverted ? externalPriceOracle.value : null;

  // Derived properties
  const maxBorrows: BigInt[] = [];
  for (let i = 0; i < poolEntity.durations.length; i++) maxBorrows.push(BigInt.fromI32(0));
  poolEntity.maxBorrows = maxBorrows;
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
  // Collateral Filter properties */
  const collateralFilterName = poolContract.COLLATERAL_FILTER_NAME();

  let tokenIdRange: BigInt[] | null = null;
  let tokenIdSet: BigInt[] | null = null;
  let tokenIdMerkleRoot: Bytes | null = null;
  let tokenIdMerkleMetadataURI: string | null = null;

  if (collateralFilterName == "RangedCollectionCollateralFilter") {
    const rangedCollectionCollateralFilterContract = RangedCollectionCollateralFilterContract.bind(poolAddress);
    const range = rangedCollectionCollateralFilterContract.collateralTokenIdRange();
    tokenIdRange = [range.value0, range.value1];
  } else if (collateralFilterName == "SetCollectionCollateralFilter") {
    const setCollectionCollateralFilterContract = SetCollectionCollateralFilterContract.bind(poolAddress);
    tokenIdSet = setCollectionCollateralFilterContract.collateralTokenIds();
  } else if (collateralFilterName == "MerkleCollectionCollateralFilter") {
    const merkleCollectionCollateralFilterContract = MerkleCollectionCollateralFilterContract.bind(poolAddress);
    tokenIdMerkleRoot = merkleCollectionCollateralFilterContract.merkleRoot();
    tokenIdMerkleMetadataURI = merkleCollectionCollateralFilterContract.metadataURI();
  }

  poolEntity.tokenIdRange = tokenIdRange;
  poolEntity.tokenIdSet = tokenIdSet;
  poolEntity.tokenIdMerkleRoot = tokenIdMerkleRoot;
  poolEntity.tokenIdMerkleMetadataURI = tokenIdMerkleMetadataURI;

  poolEntity.save();

  /**************************************************************************/
  /* Create CollateralToken entity*/
  /**************************************************************************/

  let collateralTokenEntity = CollateralTokenEntity.load(poolEntity.collateralToken);

  /* Create collateral token entity if it doesn't exist */
  if (!collateralTokenEntity) {
    collateralTokenEntity = new CollateralTokenEntity(poolEntity.collateralToken);

    const erc721Contract = ERC721.bind(Address.fromBytes(poolEntity.collateralToken));

    const tokenName = erc721Contract.try_name();
    if (tokenName.reverted) collateralTokenEntity.name = "Unknown Token";
    else collateralTokenEntity.name = tokenName.value;

    collateralTokenEntity.save();
  }

  /**************************************************************************/
  /* Create CurrencyToken entity */
  /**************************************************************************/

  let currencyTokenEntity = CurrencyTokenEntity.load(poolEntity.currencyToken);

  /* Create currency token entity if it doesn't exist */
  if (!currencyTokenEntity) {
    currencyTokenEntity = new CurrencyTokenEntity(poolEntity.currencyToken);

    const erc20Contract = ERC20.bind(Address.fromBytes(currencyTokenEntity.id));

    const tokenName = erc20Contract.try_name();
    currencyTokenEntity.name = tokenName.reverted ? "Unknown Token" : tokenName.value;

    const tokenSymbol = erc20Contract.try_symbol();
    currencyTokenEntity.symbol = tokenSymbol.reverted ? "UNK" : tokenSymbol.value;

    const tokenDecimals = erc20Contract.try_decimals();
    currencyTokenEntity.decimals = tokenDecimals.reverted ? 18 : tokenDecimals.value;

    currencyTokenEntity.save();
  }

  /**************************************************************************/
  /* Create Pool data source */
  /**************************************************************************/

  if (poolEntity.implementationVersionMajor == "1") PoolTemplateV1.create(poolAddress);
  else PoolTemplate.create(poolAddress);
}
