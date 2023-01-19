import { Address, BigInt, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import {
  Deposit as DepositEntity,
  Deposited as DepositedEntity,
  Pool as PoolEntity,
  PoolEvent,
  Redeemed as RedeemedEntity,
  Tick,
  Withdrawn as WithdrawnEntity,
} from "../generated/schema";
import { Deposited, Pool, Redeemed, Withdrawn } from "../generated/templates/Pool/Pool";

const poolContract = Pool.bind(dataSource.address());
const poolAddress = dataSource.address().toHexString();

/**************************************************************************/
/* constants */
/**************************************************************************/

/*
 * MAX_UINT256 = 2**256 - 1 = 4**255 - 1
 * pow takes a u8, max u8 is 255, so we can't use .pow(256)
 * but using 4**255 - 1 throws the following error when indexing: assertion failed: 4 * 8 >= slice.len()
 * so we'll use 2*255 for now
 */
const MAX_UINT256 = BigInt.fromI32(2).pow(255).minus(BigInt.fromI32(2));

class PoolEventType {
  static LoanOriginated: string = "LoanOriginated";
  static LoanPurchased: string = "LoanPurchased";
  static LoanRepaid: string = "LoanRepaid";
  static LoanLiquidated: string = "LoanLiquidated";
  static CollateralLiquidated: string = "CollateralLiquidated";
  static Deposited: string = "Deposited";
  static Redeemed: string = "Redeemed";
  static Withdrawn: string = "Withdrawn";
}

/**************************************************************************/
/* helper functions */
/**************************************************************************/

function createPoolEvent(event: ethereum.Event, type: string, account: Address | null): string {
  const id = `${poolAddress}-${event.transaction.hash.toHexString()}`;
  const eventEntity = new PoolEvent(id);
  eventEntity.transactionHash = event.transaction.hash;
  eventEntity.timestamp = event.block.timestamp;
  eventEntity.account = account;
  eventEntity.type = type;
  if (type == PoolEventType.LoanOriginated) eventEntity.loanOriginated = id;
  else if (type == PoolEventType.LoanPurchased) eventEntity.loanPurchased = id;
  else if (type == PoolEventType.LoanRepaid) eventEntity.LoanRepaid = id;
  else if (type == PoolEventType.LoanLiquidated) eventEntity.loanLiquidated = id;
  else if (type == PoolEventType.CollateralLiquidated) eventEntity.collateralLiquidated = id;
  else if (type == PoolEventType.Deposited) eventEntity.deposited = id;
  else if (type == PoolEventType.Redeemed) eventEntity.redeemed = id;
  else if (type == PoolEventType.Withdrawn) eventEntity.withdrawn = id;
  eventEntity.save();
  return id;
}

function updatePoolEntity(): void {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) {
    log.error("No Pool entity for this event", []);
    return;
  }
  poolEntity.totalValueLocked = poolContract.liquidityTotals().value0;
  poolEntity.utilization = poolContract.utilization();
  poolEntity.maxBorrow = poolContract.liquidityAvailable(MAX_UINT256);
  poolEntity.save();
}

function createOrUpdateTickEntity(depth: BigInt): void {
  const node = poolContract.liquidityNodes(depth, depth)[0];
  const tickID = `${poolAddress}-tick-${depth}`;
  let tickEntity = Tick.load(tickID);
  if (!tickEntity) tickEntity = new Tick(tickID);
  tickEntity.pool = poolAddress;
  tickEntity.depth = depth;
  tickEntity.value = node.value;
  tickEntity.shares = node.shares;
  tickEntity.available = node.available;
  tickEntity.pending = node.pending;
  tickEntity.redemptionPending = node.redemptions;
  // TODO: redemptionIndex
  tickEntity.prev = node.prev;
  tickEntity.next = node.next;
  tickEntity.save();
}

function createOrUpdateDepositEntity(account: Address, depth: BigInt): string {
  const depositEntityID = `${poolAddress}-pool-${account}-${depth}`;
  let depositEntity = DepositEntity.load(depositEntityID);
  if (!depositEntity) depositEntity = new DepositEntity(depositEntityID);
  depositEntity.pool = poolAddress;
  depositEntity.account = account;
  depositEntity.tick = `${poolAddress}-tick-${depth}`;
  const deposit = poolContract.deposits(account, depth);
  depositEntity.shares = deposit.shares;
  depositEntity.redemptionPending = deposit.redemptionPending;
  depositEntity.redemptionIndex = deposit.redemptionIndex;
  depositEntity.redemptionTarget = deposit.redemptionTarget;
  depositEntity.save();
  return depositEntityID;
}

/**************************************************************************/
/* mappings */
/**************************************************************************/

export function handleDeposited(event: Deposited): void {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Deposited, event.params.account);
  const depositedEntity = new DepositedEntity(poolEventID);
  depositedEntity.deposit = depositEntityID;
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleRedeemed(event: Redeemed): void {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Redeemed, event.params.account);
  const redeemedEntity = new RedeemedEntity(poolEventID);
  redeemedEntity.deposit = depositEntityID;
  redeemedEntity.shares = event.params.shares;
  redeemedEntity.save();
}

export function handleWithdrawn(event: Withdrawn): void {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Withdrawn, event.params.account);
  const withdrawnEntity = new WithdrawnEntity(poolEventID);
  withdrawnEntity.deposit = depositEntityID;
  withdrawnEntity.amount = event.params.amount;
  withdrawnEntity.shares = event.params.shares;
  withdrawnEntity.save();
}
