import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  AuctionBid as AuctionBidEvent,
  AuctionCreated as AuctionCreatedEvent,
  AuctionEnded as AuctionEndedEvent,
  AuctionExtended as AuctionExtendedEvent,
  AuctionStarted as AuctionStartedEvent,
  LiquidationStarted as LiquidationStartedEvent,
} from "../generated/EnglishAuctionCollateralLiquidator/EnglishAuctionCollateralLiquidator";
import {
  AuctionCreated as AuctionCreatedEventV1,
  LiquidationStarted as LiquidationStartedEventV1,
} from "../generated/EnglishAuctionCollateralLiquidatorV1/EnglishAuctionCollateralLiquidatorV1";
import {
  Auction as AuctionEntity,
  Bid,
  Bid as BidEntity,
  CurrencyToken as CurrencyTokenEntity,
  Liquidation as LiquidationEntity,
  Pool as PoolEntity,
} from "../generated/schema";
import { FixedPoint } from "./utils/FixedPoint";
import { bytesFromBigInt } from "./utils/misc";

/**************************************************************************/
/* Helpers
/**************************************************************************/
class AuctionStatus {
  static Created: string = "Created";
  static Started: string = "Started";
  static Ended: string = "Ended";
}

function getAuctionEntityId(liquidationHash: Bytes, collateralToken: Bytes, collateralTokenId: BigInt): Bytes {
  return liquidationHash.concat(collateralToken).concat(bytesFromBigInt(collateralTokenId));
}

function loadAuctionEntity(
  liquidationHash: Bytes,
  collateralToken: Bytes,
  collateralTokenId: BigInt
): AuctionEntity | null {
  const auctionEntityId = getAuctionEntityId(liquidationHash, collateralToken, collateralTokenId);
  return AuctionEntity.load(auctionEntityId);
}

function createLiquidationEntity(source: Address, liquidationHash: Bytes, liquidationContextHash: Bytes): void {
  const poolEntity = PoolEntity.load(source);
  if (!poolEntity) return;

  const liquidationEntity = new LiquidationEntity(liquidationHash);
  liquidationEntity.source = source;
  liquidationEntity.loan = liquidationContextHash;
  liquidationEntity.sourceImplementation = poolEntity.implementation;
  liquidationEntity.collateralToken = poolEntity.collateralToken;
  liquidationEntity.currencyToken = poolEntity.currencyToken;
  liquidationEntity.save();
}

function createAuctionEntity(
  liquidationHash: Bytes,
  collateralToken: Address,
  collateralTokenId: BigInt,
  quantity: BigInt
): void {
  const liquidationEntity = LiquidationEntity.load(liquidationHash);
  if (!liquidationEntity) return;

  const auctionEntity = new AuctionEntity(getAuctionEntityId(liquidationHash, collateralToken, collateralTokenId));
  auctionEntity.liquidation = liquidationEntity.id;
  auctionEntity.collateralToken = liquidationEntity.collateralToken;
  auctionEntity.currencyToken = liquidationEntity.currencyToken;
  auctionEntity.collateralTokenId = collateralTokenId;
  auctionEntity.quantity = quantity;
  auctionEntity.endTime = BigInt.fromI32(2).pow(64).minus(BigInt.fromI32(1)); // MAX_UINT64
  auctionEntity.bidsCount = 0;
  auctionEntity.status = AuctionStatus.Created;
  auctionEntity.save();
}

/**************************************************************************/
/* Event handlers
/**************************************************************************/
export function handleLiquidationStarted(event: LiquidationStartedEvent): void {
  createLiquidationEntity(event.params.source, event.params.liquidationHash, event.params.liquidationContextHash);
}

export function handleLiquidationStartedV1(event: LiquidationStartedEventV1): void {
  createLiquidationEntity(event.params.source, event.params.liquidationHash, event.params.liquidationContextHash);
}

export function handleAuctionCreated(event: AuctionCreatedEvent): void {
  createAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId,
    event.params.quantity
  );
}

export function handleAuctionCreatedV1(event: AuctionCreatedEventV1): void {
  createAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId,
    BigInt.fromU32(1)
  );
}

export function handleAuctionStarted(event: AuctionStartedEvent): void {
  const auctionEntity = loadAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId
  );
  if (!auctionEntity) return;
  auctionEntity.endTime = event.params.endTime;
  auctionEntity.status = AuctionStatus.Started;
  auctionEntity.save();
}

export function handleAuctionExtended(event: AuctionExtendedEvent): void {
  const auctionEntity = loadAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId
  );
  if (!auctionEntity) return;
  auctionEntity.endTime = event.params.endTime;
  auctionEntity.save();
}

export function handleAuctionBid(event: AuctionBidEvent): void {
  const auctionEntity = loadAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId
  );
  if (!auctionEntity) return;

  const currencyTokenEntity = CurrencyTokenEntity.load(auctionEntity.currencyToken);
  if (!currencyTokenEntity) throw new Error("CurrencyToken entity not found");

  const amount = FixedPoint.scaleUp(event.params.amount, FixedPoint.DECIMALS - (currencyTokenEntity.decimals as u8));

  const bidId = auctionEntity.id.concat(event.params.bidder).concat(bytesFromBigInt(event.params.amount));
  const bidEntity = new BidEntity(bidId);
  bidEntity.auction = auctionEntity.id;
  bidEntity.bidder = event.params.bidder;
  bidEntity.amount = amount;
  bidEntity.isHighest = true;
  bidEntity.timestamp = event.block.timestamp;
  bidEntity.transactionHash = event.transaction.hash;
  bidEntity.save();

  const oldHighestBidId = auctionEntity.highestBid;
  if (oldHighestBidId) {
    const oldBidEntity = Bid.load(oldHighestBidId);
    if (!oldBidEntity) throw new Error("Old Bid entity not found");
    oldBidEntity.isHighest = false;
    oldBidEntity.save();
  }

  auctionEntity.highestBid = bidId;
  auctionEntity.bidsCount += 1;
  auctionEntity.save();
}

export function handleAuctionEnded(event: AuctionEndedEvent): void {
  const auctionEntity = loadAuctionEntity(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId
  );
  if (!auctionEntity) return;

  auctionEntity.status = AuctionStatus.Ended;
  auctionEntity.save();
}
