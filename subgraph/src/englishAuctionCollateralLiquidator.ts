import { BigInt, Bytes, store } from "@graphprotocol/graph-ts";
import {
  AuctionBid as AuctionBidEvent,
  AuctionCreated as AuctionCreatedEvent,
  AuctionEnded as AuctionEndedEvent,
  AuctionExtended as AuctionExtendedEvent,
  AuctionStarted as AuctionStartedEvent,
} from "../generated/EnglishAuctionCollateralLiquidator/EnglishAuctionCollateralLiquidator";
import {
  Auction as AuctionEntity,
  Bid as BidEntity,
  CollateralToken as CollateralTokenEntity,
  Pool as PoolEntity,
} from "../generated/schema";

function getAuctionEntityId(collateralToken: Bytes, collateralTokenId: BigInt): Bytes {
  return collateralToken.concat(Bytes.fromByteArray(Bytes.fromBigInt(collateralTokenId)));
}

function loadAuctionEntity(collateralToken: Bytes, collateralTokenId: BigInt): AuctionEntity {
  const auctionEntityId = getAuctionEntityId(collateralToken, collateralTokenId);
  const auctionEntity = AuctionEntity.load(auctionEntityId);
  if (!auctionEntity) throw new Error("Auction entity not found");
  return auctionEntity;
}

function updateCollateralTokenEntityAuctionsActiveCount(collateralToken: Bytes, countUpdate: i8): void {
  const collateralTokenEntity = CollateralTokenEntity.load(collateralToken.toHexString());
  if (collateralTokenEntity) {
    collateralTokenEntity.auctionsActive = collateralTokenEntity.auctionsActive.plus(BigInt.fromI32(countUpdate));
    collateralTokenEntity.save();
  }
}

export function handleAuctionCreated(event: AuctionCreatedEvent): void {
  const auctionEntityId = getAuctionEntityId(event.params.collateralToken, event.params.collateralTokenId);
  let auctionEntity = AuctionEntity.load(auctionEntityId);

  if (!auctionEntity) {
    auctionEntity = new AuctionEntity(auctionEntityId);

    auctionEntity.liquidationSource = event.params.liquidationSource;
    auctionEntity.liquidationHash = event.params.liquidationHash;
    auctionEntity.collateralToken = event.params.collateralToken.toHexString();
    auctionEntity.collateralTokenId = event.params.collateralTokenId;
    auctionEntity.endTime = BigInt.fromI32(2).pow(64).minus(BigInt.fromI32(1)); // MAX_UINT64
    auctionEntity.bidsCount = 0;
    auctionEntity.bidIds = [];

    const pool = PoolEntity.load(event.params.liquidationSource.toHexString());
    if (pool) auctionEntity.liquidationSourceDeploymentHash = pool.deploymentHash;

    auctionEntity.save();

    updateCollateralTokenEntityAuctionsActiveCount(event.params.collateralToken, 1);
  }
}

export function handleAuctionStarted(event: AuctionStartedEvent): void {
  const auctionEntity = loadAuctionEntity(event.params.collateralToken, event.params.collateralTokenId);
  auctionEntity.endTime = event.params.endTime;
  auctionEntity.save();
}

export function handleAuctionExtended(event: AuctionExtendedEvent): void {
  const auctionEntity = loadAuctionEntity(event.params.collateralToken, event.params.collateralTokenId);
  auctionEntity.endTime = event.params.endTime;
  auctionEntity.save();
}

export function handleAuctionBid(event: AuctionBidEvent): void {
  const auctionEntity = loadAuctionEntity(event.params.collateralToken, event.params.collateralTokenId);

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

  const bidIds = auctionEntity.bidIds;
  bidIds.push(bidId);
  auctionEntity.bidIds = bidIds;
  auctionEntity.highestBid = bidId;
  auctionEntity.bidsCount += 1;
  auctionEntity.save();
}

export function handleAuctionEnded(event: AuctionEndedEvent): void {
  const auctionEntity = loadAuctionEntity(event.params.collateralToken, event.params.collateralTokenId);

  for (let i = 0; i < auctionEntity.bidIds.length; i++) {
    store.remove("Bid", auctionEntity.bidIds[i].toHexString());
  }
  store.remove("Auction", auctionEntity.id.toHexString());

  updateCollateralTokenEntityAuctionsActiveCount(event.params.collateralToken, -1);
}
