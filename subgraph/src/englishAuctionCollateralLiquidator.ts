import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  AuctionBid as AuctionBidEvent,
  AuctionCreated as AuctionCreatedEvent,
  AuctionEnded as AuctionEndedEvent,
  AuctionExtended as AuctionExtendedEvent,
  AuctionStarted as AuctionStartedEvent,
  LiquidationStarted as LiquidationStartedEvent,
} from "../generated/EnglishAuctionCollateralLiquidator/EnglishAuctionCollateralLiquidator";
import {
  Auction as AuctionEntity,
  Bid,
  Bid as BidEntity,
  Liquidation as LiquidationEntity,
  Pool as PoolEntity,
} from "../generated/schema";
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

/**************************************************************************/
/* Event handlers
/**************************************************************************/
export function handleLiquidationStarted(event: LiquidationStartedEvent): void {
  const poolEntity = PoolEntity.load(event.params.source);
  if (!poolEntity) return;

  const liquidationEntity = new LiquidationEntity(event.params.liquidationHash);
  liquidationEntity.source = event.params.source;
  liquidationEntity.loan = event.params.liquidationContextHash;
  liquidationEntity.sourceImplementation = poolEntity.implementation;
  liquidationEntity.collateralToken = poolEntity.collateralToken;
  liquidationEntity.currencyToken = poolEntity.currencyToken;

  liquidationEntity.save();
}

export function handleAuctionCreated(event: AuctionCreatedEvent): void {
  const liquidationEntity = LiquidationEntity.load(event.params.liquidationHash);
  // return if liquidation entity doesn't exist
  if (!liquidationEntity) return;

  const auctionEntityId = getAuctionEntityId(
    event.params.liquidationHash,
    event.params.collateralToken,
    event.params.collateralTokenId
  );
  let auctionEntity = AuctionEntity.load(auctionEntityId);
  // return if auction entity already exists
  if (auctionEntity) return;

  auctionEntity = new AuctionEntity(auctionEntityId);
  auctionEntity.liquidation = liquidationEntity.id;
  auctionEntity.collateralToken = liquidationEntity.collateralToken;
  auctionEntity.currencyToken = liquidationEntity.currencyToken;
  auctionEntity.collateralTokenId = event.params.collateralTokenId;
  auctionEntity.endTime = BigInt.fromI32(2).pow(64).minus(BigInt.fromI32(1)); // MAX_UINT64
  auctionEntity.bidsCount = 0;
  auctionEntity.status = AuctionStatus.Created;

  auctionEntity.save();
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

  const bidId = auctionEntity.id.concat(event.params.bidder).concat(bytesFromBigInt(event.params.amount));
  const bidEntity = new BidEntity(bidId);
  bidEntity.auction = auctionEntity.id;
  bidEntity.bidder = event.params.bidder;
  bidEntity.amount = event.params.amount;
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
