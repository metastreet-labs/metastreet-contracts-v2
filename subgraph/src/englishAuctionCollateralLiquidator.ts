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
  CollateralToken as CollateralTokenEntity,
  Liquidation as LiquidationEntity,
  Pool as PoolEntity,
} from "../generated/schema";
import { decodeLogData } from "./utils/decodeLogData";

/**************************************************************************/
/* External helpers
/**************************************************************************/
export function manufactureLiquidationStartedEvent(
  event: ethereum.Event,
  logIndex: u32
): LiquidationStartedEvent | null {
  const transactionReceipt = event.receipt;
  if (!transactionReceipt) return null;

  const logData = decodeLogData("(bytes32,address,bytes32,address,uint16)", transactionReceipt.logs[logIndex]);
  if (!logData) return null;

  const liquidationStartedEvent = new ethereum.Event(
    event.address,
    event.logIndex,
    event.transactionLogIndex,
    event.logType,
    event.block,
    event.transaction,
    [
      new ethereum.EventParam(
        "liquidationHash",
        new ethereum.Value(ethereum.ValueKind.BYTES, changetype<u32>(logData.at(0).toBytes()))
      ),
      new ethereum.EventParam(
        "source",
        new ethereum.Value(ethereum.ValueKind.ADDRESS, changetype<u32>(logData.at(1).toAddress()))
      ),
      new ethereum.EventParam(
        "liquidationContextHash",
        new ethereum.Value(ethereum.ValueKind.BYTES, changetype<u32>(logData.at(2).toBytes()))
      ),
      new ethereum.EventParam(
        "currencyToken",
        new ethereum.Value(ethereum.ValueKind.ADDRESS, changetype<u32>(logData.at(3).toAddress()))
      ),
      new ethereum.EventParam(
        "auctionCount",
        new ethereum.Value(ethereum.ValueKind.UINT, changetype<u32>(logData.at(4).toI32()))
      ),
    ],
    event.receipt
  );

  return changetype<LiquidationStartedEvent>(liquidationStartedEvent);
}

export function manufactureAuctionCreatedEvent(event: ethereum.Event, logIndex: u32): AuctionCreatedEvent | null {
  const transactionReceipt = event.receipt;
  if (!transactionReceipt) return null;

  const logData = decodeLogData("(bytes32,address,uint256)", transactionReceipt.logs[logIndex]);
  if (!logData) return null;

  const auctionCreatedEvent = new ethereum.Event(
    event.address,
    event.logIndex,
    event.transactionLogIndex,
    event.logType,
    event.block,
    event.transaction,
    [
      new ethereum.EventParam(
        "liquidationHash",
        new ethereum.Value(ethereum.ValueKind.BYTES, changetype<u32>(logData.at(0).toBytes()))
      ),
      new ethereum.EventParam(
        "collateralToken",
        new ethereum.Value(ethereum.ValueKind.ADDRESS, changetype<u32>(logData.at(1).toAddress()))
      ),
      new ethereum.EventParam(
        "collateralTokenId",
        new ethereum.Value(ethereum.ValueKind.UINT, changetype<u32>(logData.at(2).toBigInt()))
      ),
    ],
    event.receipt
  );

  return changetype<AuctionCreatedEvent>(auctionCreatedEvent);
}

/**************************************************************************/
/* Internal helpers
/**************************************************************************/
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

/**************************************************************************/
/* Event handlers
/**************************************************************************/
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

  updateCollateralTokenEntityAuctionsActiveCount(event.params.collateralToken, -1);
}
