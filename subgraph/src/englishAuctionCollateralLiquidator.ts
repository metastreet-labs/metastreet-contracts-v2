import { BigInt, Bytes } from "@graphprotocol/graph-ts";
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
  Bid as BidEntity,
  CollateralToken as CollateralTokenEntity,
  Liquidation as LiquidationEntity,
  Pool as PoolEntity,
} from "../generated/schema";

class AuctionStatus {
  static Created: string = "Created";
  static Started: string = "Started";
  static Ended: string = "Ended";
}

function getAuctionEntityId(liquidationHash: Bytes, collateralToken: Bytes, collateralTokenId: BigInt): Bytes {
  return liquidationHash.concat(collateralToken).concat(Bytes.fromByteArray(Bytes.fromBigInt(collateralTokenId)));
}

function loadAuctionEntity(
  liquidationHash: Bytes,
  collateralToken: Bytes,
  collateralTokenId: BigInt
): AuctionEntity | null {
  const auctionEntityId = getAuctionEntityId(liquidationHash, collateralToken, collateralTokenId);
  return AuctionEntity.load(auctionEntityId);
}

function updateCollateralTokenEntityAuctionsActiveCount(collateralToken: Bytes, countUpdate: i8): void {
  const collateralTokenEntity = CollateralTokenEntity.load(collateralToken.toHexString());
  if (collateralTokenEntity) {
    collateralTokenEntity.auctionsActive = collateralTokenEntity.auctionsActive.plus(BigInt.fromI32(countUpdate));
    collateralTokenEntity.save();
  }
}

export function handleLiquidationStarted(event: LiquidationStartedEvent): void {
  const liquidationEntity = new LiquidationEntity(event.params.liquidationHash);
  liquidationEntity.source = event.params.source;
  liquidationEntity.loan = event.params.liquidationContextHash;

  const poolEntity = PoolEntity.load(event.params.source);
  if (poolEntity) liquidationEntity.sourceImplementation = poolEntity.implementation;

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
  auctionEntity.collateralToken = event.params.collateralToken.toHexString();
  auctionEntity.collateralTokenId = event.params.collateralTokenId;
  auctionEntity.endTime = BigInt.fromI32(2).pow(64).minus(BigInt.fromI32(1)); // MAX_UINT64
  auctionEntity.bidsCount = 0;
  auctionEntity.status = AuctionStatus.Created;

  auctionEntity.save();

  updateCollateralTokenEntityAuctionsActiveCount(event.params.collateralToken, 1);
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

  const bidId = auctionEntity.id
    .concat(event.params.bidder)
    .concat(Bytes.fromByteArray(Bytes.fromBigInt(event.params.amount)));
  const bid = new BidEntity(bidId);
  bid.auction = auctionEntity.id;
  bid.bidder = event.params.bidder;
  bid.amount = event.params.amount;
  bid.timestamp = event.block.timestamp;
  bid.transactionHash = event.transaction.hash;
  bid.save();

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

  updateCollateralTokenEntityAuctionsActiveCount(event.params.collateralToken, -1);
}
