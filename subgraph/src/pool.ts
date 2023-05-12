import { Address, BigInt, Bytes, dataSource, ethereum, store } from "@graphprotocol/graph-ts";
import {
  Bundle as BundleEntity,
  CollateralToken as CollateralTokenEntity,
  Deposit as DepositEntity,
  Deposited as DepositedEntity,
  Loan as LoanEntity,
  LoanOriginated as LoanOriginatedEntity,
  LoanRepaid as LoanRepaidEntity,
  Pool as PoolEntity,
  PoolEvent as PoolEventEntity,
  Redeemed as RedeemedEntity,
  Tick as TickEntity,
  Withdrawn as WithdrawnEntity,
} from "../generated/schema";
import { ICollateralWrapper } from "../generated/templates/Pool/ICollateralWrapper";
import {
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
import { FixedPoint } from "./utils/FixedPoint";

const poolContract = PoolContract.bind(dataSource.address());
const poolAddress = dataSource.address().toHexString();

/**************************************************************************/
/* constants */
/**************************************************************************/
const ZERO = BigInt.zero();
const ONE = BigInt.fromI32(1);
const TWO = BigInt.fromI32(2);

const MAX_UINT128 = TWO.pow(128).minus(ONE);

class PoolEventType {
  static LoanOriginated: string = "LoanOriginated";
  static LoanPurchased: string = "LoanPurchased";
  static LoanRepaid: string = "LoanRepaid";
  static LoanLiquidated: string = "LoanLiquidated";
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

function getTickId(encodedTick: BigInt): string {
  return `${poolAddress}-tick-${encodedTick}`;
}

/**************************************************************************/
/* Liquidity updaters */
/**************************************************************************/
function updatePoolEntity(): PoolEntity {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("No Pool entity");

  const nodes = poolContract.liquidityNodes(ZERO, MAX_UINT128);

  let locked = ZERO;
  let available = ZERO;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    locked = locked.plus(node.value);
    available = available.plus(node.available);
  }

  poolEntity.totalValueLocked = locked;
  poolEntity.totalValueAvailable = available;
  poolEntity.totalValueUsed = locked.minus(available);

  poolEntity.save();
  return poolEntity;
}

function updateCollateralTokenEntity(id: string): CollateralTokenEntity {
  const collateralTokenEntity = CollateralTokenEntity.load(id);
  if (!collateralTokenEntity) throw new Error("CollateralToken entity not found");

  let locked = BigInt.zero();
  let available = BigInt.zero();
  let used = BigInt.zero();
  let maxBorrow = BigInt.zero();

  for (let i = 0; i < collateralTokenEntity.poolIds.length; i++) {
    const pool = PoolEntity.load(collateralTokenEntity.poolIds[i]);
    if (pool) {
      locked = locked.plus(pool.totalValueLocked);
      available = available.plus(pool.totalValueAvailable);
      used = used.plus(pool.totalValueUsed);
      if (maxBorrow.lt(pool.maxBorrow)) maxBorrow = pool.maxBorrow;
    }
  }

  collateralTokenEntity.totalValueLocked = locked;
  collateralTokenEntity.totalValueAvailable = available;
  collateralTokenEntity.totalValueUsed = used;
  collateralTokenEntity.maxBorrow = maxBorrow;

  collateralTokenEntity.save();
  return collateralTokenEntity;
}

function updateTickEntity(encodedTick: BigInt, interestWeightedDurationUpdate: BigInt): TickEntity {
  const node = poolContract.liquidityNode(encodedTick);
  const decodedTick = decodeTick(encodedTick);
  const tickId = getTickId(encodedTick);

  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) throw new Error("No Pool entity found for this tick");

  let tickEntity = TickEntity.load(tickId);
  if (!tickEntity) {
    tickEntity = new TickEntity(tickId);
    tickEntity.interestWeightedDuration = ZERO;
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
  tickEntity.interestWeightedDuration = tickEntity.interestWeightedDuration.plus(interestWeightedDurationUpdate);

  tickEntity.save();
  return tickEntity;
}

function updateTickEntitiesFromLoanEntity(loanEntity: LoanEntity, factor: i8): void {
  for (let i = 0; i < loanEntity.ticks.length; i++) {
    const interestWeightedDurationUpdate = loanEntity.duration
      .times(loanEntity.interests[i])
      .times(BigInt.fromI32(factor));
    updateTickEntity(loanEntity.ticks[i], interestWeightedDurationUpdate);
  }
}

/**************************************************************************/
/* Other entity updaters */
/**************************************************************************/
function createPoolEventEntity(
  event: ethereum.Event,
  type: string,
  account: Bytes,
  depositEntityId: string | null
): string {
  const id = `${poolAddress}-${event.transaction.hash.toHexString()}`;
  const eventEntity = new PoolEventEntity(id);
  eventEntity.pool = poolAddress;
  eventEntity.deposit = depositEntityId;
  eventEntity.transactionHash = event.transaction.hash;
  eventEntity.timestamp = event.block.timestamp;
  eventEntity.account = account;
  eventEntity.type = type;
  if (type == PoolEventType.LoanOriginated) eventEntity.loanOriginated = id;
  else if (type == PoolEventType.LoanPurchased) eventEntity.loanPurchased = id;
  else if (type == PoolEventType.LoanRepaid) eventEntity.LoanRepaid = id;
  else if (type == PoolEventType.LoanLiquidated) eventEntity.loanLiquidated = id;
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
): string {
  const depositEntityId = `${poolAddress}-pool-${account.toHexString()}-${encodedTick}`;

  const deposit = poolContract.deposits(account, encodedTick);

  if (deposit.shares.isZero()) {
    store.remove("Deposit", depositEntityId);
    return depositEntityId;
  }

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
  const loanEntity = new LoanEntity(receiptHash.toHexString());

  let ticks: BigInt[] = [];
  let interests: BigInt[] = [];
  let principal: BigInt = BigInt.zero();
  let repayment: BigInt = BigInt.zero();
  for (let i = 0; i < nodeReceipts.length; i++) {
    const nodeReceipt = nodeReceipts[i];
    ticks.push(nodeReceipt.tick);
    interests.push(nodeReceipt.pending.minus(nodeReceipt.used));
    principal = principal.plus(nodeReceipt.used);
    repayment = repayment.plus(nodeReceipt.pending);
  }

  loanEntity.pool = poolAddress;
  loanEntity.status = LoanStatus.Active;
  loanEntity.timestamp = event.block.timestamp;
  loanEntity.borrower = loanReceipt.borrower;
  loanEntity.maturity = loanReceipt.maturity;
  loanEntity.duration = loanReceipt.duration;
  loanEntity.collateralWrapperContext = loanReceipt.collateralWrapperContext;
  loanEntity.ticks = ticks;
  loanEntity.interests = interests;
  loanEntity.principal = principal;
  loanEntity.repayment = repayment;
  loanEntity.loanReceipt = encodedReceipt;

  if (loanReceipt.collateralToken.toHexString() == poolEntity.collateralToken) {
    loanEntity.collateralToken = loanReceipt.collateralToken.toHexString();
    loanEntity.collateralTokenIds = [loanReceipt.collateralTokenId];
  } else {
    const bundleId = loanReceipt.collateralTokenId.toString();
    const bundleEntity = BundleEntity.load(bundleId);
    if (bundleEntity) loanEntity.bundle = bundleId;

    const result = ICollateralWrapper.bind(loanReceipt.collateralToken).enumerate(
      loanReceipt.collateralTokenId,
      loanReceipt.collateralWrapperContext
    );
    loanEntity.collateralToken = result.value0.toHexString();
    loanEntity.collateralTokenIds = result.value1;
  }

  const transactionReceipt = event.receipt;
  if (transactionReceipt) {
    const DELEGATE_FOR_TOKEN_TOPIC = "0xe89c6ba1e8957285aed22618f52aa1dcb9d5bb64e1533d8b55136c72fcf5aa5d";
    for (let i = 0; i < transactionReceipt.logs.length; i++) {
      const receiptLog = transactionReceipt.logs[i];
      if (receiptLog.topics[0].toHexString() == DELEGATE_FOR_TOKEN_TOPIC) {
        const decoded = ethereum.decode("(address,address,address,uint256,bool)", receiptLog.data);
        if (decoded) loanEntity.delegate = decoded.toTuple().at(1).toAddress();
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
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.tick, ZERO);

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

  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.tick, ZERO);

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
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.tick, ZERO);

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

  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);

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
  loanOriginatedEntity.loan = event.params.loanReceiptHash.toHexString();
  loanOriginatedEntity.save();
}

export function handleLoanRepaid(event: LoanRepaidEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.Repaid;
  loanEntity.save();

  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntitiesFromLoanEntity(loanEntity, -1);

  const poolEventId = createPoolEventEntity(event, PoolEventType.LoanRepaid, loanEntity.borrower, null);

  const loanRepaidEntity = new LoanRepaidEntity(poolEventId);
  loanRepaidEntity.loan = loanEntity.id;
  loanRepaidEntity.save();
}

export function handleLoanLiquidated(event: LoanLiquidatedEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.Liquidated;
  loanEntity.save();

  const poolEventId = createPoolEventEntity(event, PoolEventType.LoanLiquidated, loanEntity.borrower, null);

  const loanLiquidatedEntity = new LoanRepaidEntity(poolEventId);
  loanLiquidatedEntity.loan = loanEntity.id;
  loanLiquidatedEntity.save();
}

export function handleCollateralLiquidated(event: CollateralLiquidatedEvent): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());
  if (!loanEntity) throw new Error("Loan entity not found");
  loanEntity.status = LoanStatus.CollateralLiquidated;
  loanEntity.save();

  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntitiesFromLoanEntity(loanEntity, -1);
}
