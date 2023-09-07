import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ERC20 } from "../generated/PoolFactory/ERC20";
import { ERC721 } from "../generated/PoolFactory/ERC721";
import { Pool as PoolContract } from "../generated/PoolFactory/Pool";
import { PoolCreated as PoolCreatedEvent } from "../generated/PoolFactory/PoolFactory";
import { RangedCollectionCollateralFilter as RangedCollectionCollateralFilterContract } from "../generated/PoolFactory/RangedCollectionCollateralFilter";
import { SetCollectionCollateralFilter as SetCollectionCollateralFilterContract } from "../generated/PoolFactory/SetCollectionCollateralFilter";
import { MerkleCollectionCollateralFilter as MerkleCollectionCollateralFilterContract } from "../generated/PoolFactory/MerkleCollectionCollateralFilter";
import {
  CollateralToken as CollateralTokenEntity,
  CurrencyToken as CurrencyTokenEntity,
  Pool as PoolEntity,
} from "../generated/schema";
import { Pool as PoolTemplate, PoolV1 as PoolTemplateV1 } from "../generated/templates";

export function handlePoolCreated(event: PoolCreatedEvent): void {
  const poolAddress = event.params.pool;
  const poolContract = PoolContract.bind(poolAddress);

  /**************************************************************************/
  /* Create Pool entity*/
  /**************************************************************************/
  const poolEntity = new PoolEntity(poolAddress);
  // Properties
  poolEntity.implementationVersionMajor = poolContract.IMPLEMENTATION_VERSION().split(".")[0];
  poolEntity.implementation = event.params.implementation;
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

  /**************************************************************************/
  /* Create CollateralToken entity */
  /**************************************************************************/
  const collateralTokenAddress = poolContract.collateralToken();
  const collateralFilterName = poolContract.COLLATERAL_FILTER_NAME();

  let collateralTokenEntityId: string;
  let tokenIdRange: BigInt[] | null = null;
  let tokenIdSet: BigInt[] | null = null;
  let tokenIdMerkleMetadataURI: string | null = null;
  let tokenIdMerkleRoot: Bytes | null = null;

  if (collateralFilterName == "RangedCollectionCollateralFilter") {
    const rangedCollectionCollateralFilterContract = RangedCollectionCollateralFilterContract.bind(poolAddress);
    const range = rangedCollectionCollateralFilterContract.collateralTokenIdRange();
    tokenIdRange = [range.value0, range.value1];
    collateralTokenEntityId = `${collateralTokenAddress.toHexString()}:${range.value0}:${range.value1}`;
  } else if (collateralFilterName == "SetCollectionCollateralFilter") {
    const setCollectionCollateralFilterContract = SetCollectionCollateralFilterContract.bind(poolAddress);
    tokenIdSet = setCollectionCollateralFilterContract.collateralTokenIds();
    // FIXME will collide with an existing collection collateral token
    collateralTokenEntityId = collateralTokenAddress.toHexString();
  } else if (collateralFilterName == "MerkleCollectionCollateralFilter") {
    const merkleCollectionCollateralFilterContract = MerkleCollectionCollateralFilterContract.bind(poolAddress);
    tokenIdMerkleMetadataURI = merkleCollectionCollateralFilterContract.metadataURI();
    tokenIdMerkleRoot = merkleCollectionCollateralFilterContract.merkleRoot();
    // problematic since id will collide with an existing collection collateral token
    collateralTokenEntityId = collateralTokenAddress.toHexString();
  }  else {
    collateralTokenEntityId = collateralTokenAddress.toHexString();
  }

  let collateralTokenEntity = CollateralTokenEntity.load(collateralTokenEntityId);
  if (!collateralTokenEntity) {
    /* Create collateral token entity if it doesn't exists */
    collateralTokenEntity = new CollateralTokenEntity(collateralTokenEntityId);
    collateralTokenEntity.address = collateralTokenAddress;
    collateralTokenEntity.tokenIdRange = tokenIdRange;
    collateralTokenEntity.tokenIdSet = tokenIdSet;
    collateralTokenEntity.tokenIdMerkleMetadataURI = tokenIdMerkleMetadataURI;
    collateralTokenEntity.tokenIdMerkleRoot = tokenIdMerkleRoot;
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
  /* Create Pool data source */
  /**************************************************************************/
  // save pool entity
  poolEntity.collateralToken = collateralTokenEntityId;
  poolEntity.save();

  if (poolEntity.implementationVersionMajor == "1") {
    PoolTemplateV1.create(poolAddress);
  } else {
    PoolTemplate.create(poolAddress);
  }
}
