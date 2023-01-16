import { BigInt, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import {
  Deposited as DepositedEntity,
  Pool as PoolEntity,
  PoolEvent,
  Redeemed as RedeemedEntity,
  Withdrawn as WithdrawnEntity,
} from "../generated/schema";
import { Deposited, Pool, Redeemed, Withdrawn } from "../generated/templates/Pool/Pool";

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

function updatePoolMaxBorrow() {
  const poolAddress = dataSource.address();
  const poolContract = Pool.bind(poolAddress);
  const poolEntity = PoolEntity.load(poolAddress.toHexString());
  if (!poolEntity) {
    log.error("No Pool entity for this event", []);
    return;
  }
  const maxBorrow = poolContract.liquidityAvailable(MAX_UINT256);
  poolEntity.maxBorrow = maxBorrow;
  poolEntity.save();
}

function createPoolEvent(event: ethereum.Event, type: string) {
  const id = `${dataSource.address()}-${event.transaction.hash.toHexString()}`;
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

/**************************************************************************/
/* mappings */
/**************************************************************************/

export function handleDeposited(event: Deposited) {
  updatePoolMaxBorrow();
  const id = createPoolEvent(event, PoolEventType.Deposited);
  const depositedEntity = new DepositedEntity(id);
  // TODO: create the deposit entity and store its ID below
  depositedEntity.deposit = "";
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleRedeemed(event: Redeemed) {
  updatePoolMaxBorrow();
  const id = createPoolEvent(event, PoolEventType.Redeemed);
  const depositedEntity = new RedeemedEntity(id);
  // TODO: update the deposit entity and store its id below
  depositedEntity.deposit = "";
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleWithdrawn(event: Withdrawn) {
  updatePoolMaxBorrow();
  const id = createPoolEvent(event, PoolEventType.Withdrawn);
  const depositedEntity = new WithdrawnEntity(id);
  // TODO: update the deposit entity and store its id below
  depositedEntity.deposit = "";
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}
