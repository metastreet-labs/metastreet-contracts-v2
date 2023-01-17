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

const MAX_UINT256 = BigInt.fromI32(2).pow(256).minus(BigInt.fromI32(1));

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

function createPoolEvent(event: ethereum.Event, type: string) {
  const id = `${poolAddress}-${event.transaction.hash.toHexString()}`;
  const eventEntity = new PoolEvent(id);
  eventEntity.transactionHash = event.transaction.hash;
  eventEntity.timestamp = event.block.timestamp;
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

function updatePoolEntity() {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) {
    log.error("No Pool entity for this event", []);
    return;
  }
  const maxBorrow = poolContract.liquidityAvailable(MAX_UINT256);
  poolEntity.maxBorrow = maxBorrow;
  poolEntity.save();
}

function createOrUpdateTickEntity(depth: BigInt) {
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

function createOrUpdateDepositEntity(account: Address, depth: BigInt) {
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

export function handleDeposited(event: Deposited) {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Deposited);
  const depositedEntity = new DepositedEntity(poolEventID);
  depositedEntity.deposit = depositEntityID;
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleRedeemed(event: Redeemed) {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Redeemed);
  const redeemedEntity = new RedeemedEntity(poolEventID);
  redeemedEntity.deposit = depositEntityID;
  redeemedEntity.shares = event.params.shares;
  redeemedEntity.save();
}

export function handleWithdrawn(event: Withdrawn) {
  updatePoolEntity();
  createOrUpdateTickEntity(event.params.depth);
  const depositEntityID = createOrUpdateDepositEntity(event.params.account, event.params.depth);
  const poolEventID = createPoolEvent(event, PoolEventType.Withdrawn);
  const withdrawnEntity = new WithdrawnEntity(poolEventID);
  withdrawnEntity.deposit = depositEntityID;
  withdrawnEntity.amount = event.params.amount;
  withdrawnEntity.shares = event.params.shares;
  withdrawnEntity.save();
}
