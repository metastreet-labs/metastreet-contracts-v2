import { Address, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  Bundle as BundleEntity,
  CollateralLiquidated as CollateralLiquidatedEntity,
  CollateralToken as CollateralTokenEntity,
  Deposit as DepositEntity,
  Deposited as DepositedEntity,
  Loan as LoanEntity,
  LoanLiquidated as LoanLiquidatedEntity,
  LoanOriginated as LoanOriginatedEntity,
  LoanRepaid as LoanRepaidEntity,
  PoolDayData as PoolDayDataEntity,
  Pool as PoolEntity,
  PoolEvent as PoolEventEntity,
  Redeemed as RedeemedEntity,
  Tick as TickEntity,
  Withdrawn as WithdrawnEntity,
} from "../generated/schema";
import { ICollateralWrapper } from "../generated/templates/Pool/ICollateralWrapper";
import {
  AdminFeeRateUpdated as AdminFeeRateUpdatedEvent,
  CollateralLiquidated as CollateralLiquidatedEvent,
  Deposited as DepositedEvent,
  LoanLiquidated as LoanLiquidatedEvent,
  LoanOriginated as LoanOriginatedEvent,
  Pool__decodeLoanReceiptResultValue0Struct as LoanReceipt,
  LoanRepaid as LoanRepaidEvent,
  Pool as PoolContract,
  Redeemed as RedeemedEvent,
  Withdrawn as WithdrawnEvent,
} from "../generated/templates/Pool/Pool";
import {
  handleAuctionCreated,
  handleLiquidationStarted,
  manufactureAuctionCreatedEvent,
  manufactureLiquidationStartedEvent,
} from "./englishAuctionCollateralLiquidator";
import { FixedPoint } from "./utils/FixedPoint";
import { decodeLogData } from "./utils/decodeLogData";
import { bytesFromBigInt } from "./utils/misc";

const poolContract = PoolContract.bind(dataSource.address());
const poolAddress = dataSource.address();

/**************************************************************************/
/* constants */
/**************************************************************************/
const ZERO = BigInt.zero();
const ONE = BigInt.fromI32(1);
const TWO = BigInt.fromI32(2);

const MAX_UINT128 = TWO.pow(128).minus(ONE);

class PoolEventType {
  static LoanOriginated: string = "LoanOriginated";
  static LoanRepaid: string = "LoanRepaid";
  static LoanLiquidated: string = "LoanLiquidated";
  static CollateralLiquidated: string = "CollateralLiquidated";
  static Deposited: string = "Deposited";
  static Redeemed: string = "Redeemed";
  static Withdrawn: string = "Withdrawn";
}

class LoanStatus {
  static Active: string = "Active";
  static Liquidated: string = "Liquidated";
  static Repaid: string = "Repaid";
  static CollateralLiquidated: string = "CollateralLiquidated";
}

/**************************************************************************/
/* Tick utils */
/**************************************************************************/
class DecodedTick {
  limit: BigInt;
  durationIndex: i32;
  rateIndex: i32;

  constructor(limit: BigInt, durationIndex: i32, rateIndex: i32) {
    this.limit = limit;
    this.durationIndex = durationIndex;
    this.rateIndex = rateIndex;
  }
}

function decodeTick(encodedTick: BigInt): DecodedTick {
  const limitMask = TWO.pow(120).minus(ONE);
  const durationIndexMask = TWO.pow(3).minus(ONE);
  const rateIndexMask = TWO.pow(3).minus(ONE);

  const limit = encodedTick.rightShift(8).bitAnd(limitMask);
  const durationIndex = encodedTick.rightShift(5).bitAnd(durationIndexMask).toU32();
  const rateIndex = encodedTick.rightShift(2).bitAnd(rateIndexMask).toU32();

  return new DecodedTick(limit, durationIndex, rateIndex);
}

function getTickId(encodedTick: BigInt): Bytes {
  return poolAddress.concat(bytesFromBigInt(encodedTick));
}

/**************************************************************************/
/* Historical */
/**************************************************************************/
function updatePoolDayData(poolEntity: PoolEntity, event: ethereum.Event): void {
  const oneDayInSeconds = BigInt.fromU32(86400);
  const dayTimestamp = event.block.timestamp.div(oneDayInSeconds).times(oneDayInSeconds);
  const dayDataId = poolEntity.id.concat(bytesFromBigInt(dayTimestamp));
  let dayDataEntity = PoolDayDataEntity.load(dayDataId);
  if (!dayDataEntity) {
    dayDataEntity = new PoolDayDataEntity(dayDataId);
    dayDataEntity.timestamp = dayTimestamp;
    dayDataEntity.pool = poolEntity.id;
    dayDataEntity.totalValueLocked = poolEntity.totalValueLocked;
    dayDataEntity.totalValueUsed = poolEntity.totalValueUsed;
    dayDataEntity.totalValueAvailable = poolEntity.totalValueAvailable;
    dayDataEntity.save();
  }
}

/**************************************************************************/
/* Liquidity updaters */
/**************************************************************************/
function updatePoolEntity(event: ethereum.Event): PoolEntity {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("No Pool entity");

  const durationsCount = poolEntity.durations.length;

  const nodes = poolContract.liquidityNodes(ZERO, MAX_UINT128);

  let locked = ZERO;
  let available = ZERO;
  const maxBorrows: BigInt[] = [];
  for (let i = 0; i < durationsCount; i++) maxBorrows.push(ZERO);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const tick = decodeTick(node.tick);

    locked = locked.plus(node.value);
    available = available.plus(node.available);

    for (let durationIndex = 0; durationIndex < durationsCount; durationIndex++) {
      if (durationIndex > tick.durationIndex) continue;

      const borrowAmountNeeded = tick.limit.minus(maxBorrows[durationIndex]);

      if (borrowAmountNeeded.gt(node.available)) {
        maxBorrows[durationIndex] = maxBorrows[durationIndex].plus(node.available);
      } else {
        maxBorrows[durationIndex] = maxBorrows[durationIndex].plus(borrowAmountNeeded);
      }
    }
  }

  poolEntity.totalValueLocked = locked;
  poolEntity.totalValueAvailable = available;
  poolEntity.totalValueUsed = locked.minus(available);
  poolEntity.maxBorrows = maxBorrows;
  poolEntity.adminFeeBalance = poolContract.adminFeeBalance();

  poolEntity.save();

  updatePoolDayData(poolEntity, event);

  return poolEntity;
}

function updateTickEntity(
  encodedTick: BigInt,
  principalWeightedDurationUpdate: BigInt,
  interestWeightedMaturityUpdate: BigInt
): TickEntity {
  const node = poolContract.liquidityNode(encodedTick);
  const decodedTick = decodeTick(encodedTick);
  const tickId = getTickId(encodedTick);

  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("No Pool entity found for this tick");

  let tickEntity = TickEntity.load(tickId);
  if (!tickEntity) {
    tickEntity = new TickEntity(tickId);
    tickEntity.principalWeightedDuration = ZERO;
    tickEntity.interestWeightedMaturity = ZERO;
  }

  tickEntity.pool = poolAddress;
  tickEntity.raw = encodedTick;
  tickEntity.limit = decodedTick.limit;
  tickEntity.duration = poolEntity.durations[decodedTick.durationIndex];
  tickEntity.rate = poolEntity.rates[decodedTick.rateIndex];
  tickEntity.durationIndex = decodedTick.durationIndex;
  tickEntity.rateIndex = decodedTick.rateIndex;
  tickEntity.value = node.value;
  tickEntity.shares = node.shares;
  tickEntity.available = node.available;
  tickEntity.pending = node.pending;
  tickEntity.prev = node.prev;
  tickEntity.next = node.next;
  tickEntity.redemptionPending = node.redemptions;
  tickEntity.principalWeightedDuration = tickEntity.principalWeightedDuration.plus(principalWeightedDurationUpdate);
  tickEntity.interestWeightedMaturity = tickEntity.interestWeightedMaturity.plus(interestWeightedMaturityUpdate);

  tickEntity.save();
  return tickEntity;
}

function updateTickEntitiesFromLoanEntity(loanEntity: LoanEntity, factor: i8): void {
  for (let i = 0; i < loanEntity.ticks.length; i++) {
    const principalWeightedDurationUpdated = loanEntity.duration
      .times(loanEntity.useds[i])
      .times(BigInt.fromI32(factor));

    const interestWeightedMaturityUpdate = loanEntity.maturity
      .times(loanEntity.interests[i])
      .times(BigInt.fromI32(factor));

    updateTickEntity(loanEntity.ticks[i], principalWeightedDurationUpdated, interestWeightedMaturityUpdate);
  }
}

/**************************************************************************/
/* Other entity updaters */
/**************************************************************************/
function createPoolEventEntity(
  event: ethereum.Event,
  type: string,
  account: Bytes,
  depositEntityId: Bytes | null
): Bytes {
  const id = poolAddress.concat(event.transaction.hash).concat(bytesFromBigInt(event.logIndex));
  const eventEntity = new PoolEventEntity(id);
  eventEntity.pool = poolAddress;
  eventEntity.deposit = depositEntityId;
  eventEntity.transactionHash = event.transaction.hash;
  eventEntity.timestamp = event.block.timestamp;
  eventEntity.from = event.transaction.from;
  eventEntity.account = account;
  eventEntity.type = type;
  if (type == PoolEventType.LoanOriginated) eventEntity.loanOriginated = id;
  else if (type == PoolEventType.LoanRepaid) eventEntity.loanRepaid = id;
  else if (type == PoolEventType.LoanLiquidated) eventEntity.loanLiquidated = id;
  else if (type == PoolEventType.CollateralLiquidated) eventEntity.collateralLiquidated = id;
  else if (type == PoolEventType.Deposited) eventEntity.deposited = id;
  else if (type == PoolEventType.Redeemed) eventEntity.redeemed = id;
  else if (type == PoolEventType.Withdrawn) eventEntity.withdrawn = id;
  eventEntity.save();
  return id;
}

function updateDepositEntity(
  account: Address,
  encodedTick: BigInt,
  timestamp: BigInt,
  depositedAmountUpdate: BigInt
): Bytes {
  const depositEntityId = poolAddress.concat(account).concat(bytesFromBigInt(encodedTick));

  const deposit = poolContract.deposits(account, encodedTick);

  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("updateDepositEntity: Pool entity not found");

  let depositEntity = DepositEntity.load(depositEntityId);
  if (!depositEntity) {
    depositEntity = new DepositEntity(depositEntityId);
    depositEntity.createdAt = timestamp;
    depositEntity.depositedAmount = BigInt.zero();
  }

  depositEntity.pool = poolAddress;
  depositEntity.tick = getTickId(encodedTick);
  depositEntity.account = account;
  depositEntity.shares = deposit.shares;
  depositEntity.depositedAmount = depositEntity.depositedAmount.plus(depositedAmountUpdate);
  depositEntity.redemptionPending = deposit.redemptionPending;
  depositEntity.redemptionIndex = deposit.redemptionIndex;
  depositEntity.redemptionTarget = deposit.redemptionTarget;
  depositEntity.updatedAt = timestamp;
  depositEntity.save();
  return depositEntityId;
}

function createLoanEntity(
  poolEntity: PoolEntity,
  loanReceipt: LoanReceipt,
  encodedReceipt: Bytes,
  receiptHash: Bytes,
  event: ethereum.Event
): LoanEntity {
  const nodeReceipts = loanReceipt.nodeReceipts;

  /* Create the Loan entity */
  const loanEntity = new LoanEntity(receiptHash);

  let ticks: BigInt[] = [];
  let useds: BigInt[] = [];
  let interests: BigInt[] = [];
  let principal: BigInt = BigInt.zero();
  let repayment: BigInt = BigInt.zero();
  for (let i = 0; i < nodeReceipts.length; i++) {
    const nodeReceipt = nodeReceipts[i];
    ticks.push(nodeReceipt.tick);
    useds.push(nodeReceipt.used);
    interests.push(nodeReceipt.pending.minus(nodeReceipt.used));
    principal = principal.plus(nodeReceipt.used);
    repayment = repayment.plus(nodeReceipt.pending);
  }

  loanEntity.pool = poolAddress;
  loanEntity.status = LoanStatus.Active;
  loanEntity.transactionHash = event.transaction.hash;
  loanEntity.timestamp = event.block.timestamp;
  loanEntity.borrower = loanReceipt.borrower;
  loanEntity.maturity = loanReceipt.maturity;
  loanEntity.duration = loanReceipt.duration;
  loanEntity.collateralWrapperContext = loanReceipt.collateralWrapperContext;
  loanEntity.ticks = ticks;
  loanEntity.useds = useds;
  loanEntity.interests = interests;
  loanEntity.principal = principal;
  loanEntity.repayment = repayment;
  loanEntity.loanReceipt = encodedReceipt;
  loanEntity.collateralToken = poolEntity.collateralToken;

  const collateralTokenEntity = CollateralTokenEntity.load(poolEntity.collateralToken);
  if (!collateralTokenEntity) throw new Error("CollateralToken entity not found");

  if (loanReceipt.collateralToken.equals(collateralTokenEntity.address)) {
    loanEntity.collateralTokenIds = [loanReceipt.collateralTokenId];
  } else {
    const bundleId = loanReceipt.collateralTokenId.toString();
    const bundleEntity = BundleEntity.load(bundleId);
    if (bundleEntity) loanEntity.bundle = bundleId;

    const result = ICollateralWrapper.bind(loanReceipt.collateralToken).enumerate(
      loanReceipt.collateralTokenId,
      loanReceipt.collateralWrapperContext
    );
    loanEntity.collateralTokenIds = result.value1;
  }

  const transactionReceipt = event.receipt;
  if (transactionReceipt) {
    const DELEGATE_FOR_TOKEN_TOPIC = "0xe89c6ba1e8957285aed22618f52aa1dcb9d5bb64e1533d8b55136c72fcf5aa5d";
    for (let i = 0; i < transactionReceipt.logs.length; i++) {
      const receiptLog = transactionReceipt.logs[i];
      if (transactionReceipt.logs[i].topics[0].toHexString() == DELEGATE_FOR_TOKEN_TOPIC) {
        const logData = decodeLogData("(address,address,address,uint256,bool)", receiptLog);
        if (logData) loanEntity.delegate = logData.at(1).toAddress();
        break;
      }
    }
  }

  loanEntity.save();
  return loanEntity;
}

/**************************************************************************/
/* mappings */
/**************************************************************************/
export function handleDeposited(event: DepositedEvent): void {
  updatePoolEntity(event);
  updateTickEntity(event.params.tick, ZERO, ZERO);

  const depositEntityId = updateDepositEntity(
    event.params.account,
    event.params.tick,
    event.block.timestamp,
    event.params.amount
  );

  const poolEventId = createPoolEventEntity(event, PoolEventType.Deposited, event.params.account, depositEntityId);

  const depositedEntity = new DepositedEntity(poolEventId);
  depositedEntity.account = event.params.account;
  depositedEntity.tick = getTickId(event.params.tick);
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleRedeemed(event: RedeemedEvent): void {
  const tickId = getTickId(event.params.tick);
  const oldTickEntity = TickEntity.load(tickId);
  if (!oldTickEntity) throw new Error("Tick entity doesn't exist");

  updatePoolEntity(event);
  updateTickEntity(event.params.tick, ZERO, ZERO);

  const depositEntityId = updateDepositEntity(
    event.params.account,
    event.params.tick,
    event.block.timestamp,
    BigInt.zero()
  );

  const poolEventId = createPoolEventEntity(event, PoolEventType.Redeemed, event.params.account, depositEntityId);

  const redeemedEntity = new RedeemedEntity(poolEventId);
  redeemedEntity.account = event.params.account;
  redeemedEntity.tick = getTickId(event.params.tick);
  redeemedEntity.shares = event.params.shares;
  const tickSharePrice = FixedPoint.div(oldTickEntity.value, oldTickEntity.shares);
  redeemedEntity.estimatedAmount = FixedPoint.mul(tickSharePrice, event.params.shares);
  redeemedEntity.save();
}

export function handleWithdrawn(event: WithdrawnEvent): void {
  updatePoolEntity(event);
  updateTickEntity(event.params.tick, ZERO, ZERO);

  const depositEntityId = updateDepositEntity(
    event.params.account,
    event.params.tick,
    event.block.timestamp,
    event.params.amount.times(BigInt.fromI32(-1))
  );

  const poolEventId = createPoolEventEntity(event, PoolEventType.Withdrawn, event.params.account, depositEntityId);

  const withdrawnEntity = new WithdrawnEntity(poolEventId);
  withdrawnEntity.account = event.params.account;
  withdrawnEntity.tick = getTickId(event.params.tick);
  withdrawnEntity.amount = event.params.amount;
  withdrawnEntity.shares = event.params.shares;
  withdrawnEntity.save();
}

export function handleLoanOriginated(event: LoanOriginatedEvent): void {
  const receipt = poolContract.decodeLoanReceipt(event.params.loanReceipt);

  const poolEntity = updatePoolEntity(event);

  poolEntity.loansOriginated = poolEntity.loansOriginated.plus(ONE);
  poolEntity.loansActive = poolEntity.loansActive.plus(ONE);
  poolEntity.save();

  const loanEntity = createLoanEntity(
    poolEntity,
    receipt,
    event.params.loanReceipt,
    event.params.loanReceiptHash,
    event
  );

  updateTickEntitiesFromLoanEntity(loanEntity, 1);

  const poolEventId = createPoolEventEntity(event, PoolEventType.LoanOriginated, receipt.borrower, null);

  const loanOriginatedEntity = new LoanOriginatedEntity(poolEventId);
  loanOriginatedEntity.loan = event.params.loanReceiptHash;
  loanOriginatedEntity.save();
}

export function handleLoanRepaid(event: LoanRepaidEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash);
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.Repaid;
  loanEntity.save();

  const poolEntity = updatePoolEntity(event);
  updateTickEntitiesFromLoanEntity(loanEntity, -1);

  poolEntity.loansActive = poolEntity.loansActive.minus(ONE);
  poolEntity.loansRepaid = poolEntity.loansRepaid.plus(ONE);
  poolEntity.save();

  const poolEventId = createPoolEventEntity(event, PoolEventType.LoanRepaid, loanEntity.borrower, null);

  const loanRepaidEntity = new LoanRepaidEntity(poolEventId);
  loanRepaidEntity.loan = loanEntity.id;
  loanRepaidEntity.save();
}

export function handleLoanLiquidated(event: LoanLiquidatedEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash);
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.Liquidated;
  loanEntity.save();

  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("Pool entity not found");

  poolEntity.loansActive = poolEntity.loansActive.minus(ONE);
  poolEntity.loansLiquidated = poolEntity.loansLiquidated.plus(ONE);
  poolEntity.save();

  const poolEventId = createPoolEventEntity(event, PoolEventType.LoanLiquidated, loanEntity.borrower, null);

  const loanLiquidatedEntity = new LoanLiquidatedEntity(poolEventId);
  loanLiquidatedEntity.loan = loanEntity.id;
  loanLiquidatedEntity.save();

  const transactionReceipt = event.receipt;
  if (transactionReceipt) {
    const LIQUIDATION_STARTED_TOPIC = "0xb147b2c3b3dced11f6425f7709a14fc2fdac9121a4bc63cde3bd3d6d4d8066b0";
    const AUCTION_CREATED_TOPIC = "0x15271099786b82529b8cdd3fb785da93c0460a55d76f84d4c6dbce07f11c70e8";
    for (let i = 0; i < transactionReceipt.logs.length; i++) {
      const firstTopic = transactionReceipt.logs[i].topics[0].toHexString();
      if (firstTopic == LIQUIDATION_STARTED_TOPIC) {
        const liquidationStartedEvent = manufactureLiquidationStartedEvent(event, i);
        if (liquidationStartedEvent) handleLiquidationStarted(liquidationStartedEvent);
      } else if (firstTopic == AUCTION_CREATED_TOPIC) {
        const auctionCreatedEvent = manufactureAuctionCreatedEvent(event, i);
        if (auctionCreatedEvent) handleAuctionCreated(auctionCreatedEvent);
      }
    }
  }
}

export function handleCollateralLiquidated(event: CollateralLiquidatedEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash);
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.CollateralLiquidated;
  loanEntity.proceeds = event.params.proceeds;
  loanEntity.save();

  const poolEntity = updatePoolEntity(event);
  updateTickEntitiesFromLoanEntity(loanEntity, -1);

  poolEntity.loansLiquidated = poolEntity.loansLiquidated.minus(ONE);
  poolEntity.loansCollateralLiquidated = poolEntity.loansCollateralLiquidated.plus(ONE);
  poolEntity.save();

  const poolEventId = createPoolEventEntity(event, PoolEventType.CollateralLiquidated, loanEntity.borrower, null);

  const collateralLiquidatedEntity = new CollateralLiquidatedEntity(poolEventId);
  collateralLiquidatedEntity.loan = loanEntity.id;
  collateralLiquidatedEntity.proceeds = event.params.proceeds;
  collateralLiquidatedEntity.save();
}

export function handleAdminFeeRateUpdated(event: AdminFeeRateUpdatedEvent): void {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("Pool entity not found");

  poolEntity.adminFeeRate = event.params.rate;
  poolEntity.save();
}
