import { Address, BigInt, Bytes, dataSource, ethereum, log, store } from "@graphprotocol/graph-ts";
import {
  CollateralToken as CollateralTokenEntity,
  Deposit as DepositEntity,
  Deposited as DepositedEntity,
  Loan as LoanEntity,
  LoanOriginated as LoanOriginatedEntity,
  LoanRepaid as LoanRepaidEntity,
  Pool as PoolEntity,
  PoolEvent,
  Redeemed as RedeemedEntity,
  Tick,
  Withdrawn as WithdrawnEntity,
} from "../generated/schema";
import {
  CollateralLiquidated,
  Deposited,
  LoanLiquidated,
  LoanOriginated,
  Pool__decodeLoanReceiptResultValue0Struct as LoanReceipt,
  LoanRepaid,
  Pool,
  Redeemed,
  Withdrawn,
} from "../generated/templates/Pool/Pool";

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
/* helper functions */
/**************************************************************************/

function createPoolEvent(event: ethereum.Event, type: string, account: Bytes): string {
  const id = `${poolAddress}-${event.transaction.hash.toHexString()}`;
  const eventEntity = new PoolEvent(id);
  eventEntity.pool = poolAddress;
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

function updatePoolEntity(): PoolEntity {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) {
    log.error("No Pool entity for this event", []);
    throw new Error("No Pool entity");
  }
  const liquidity = poolContract.liquidityStatistics();
  poolEntity.totalValueLocked = liquidity.value0;
  poolEntity.totalValueUsed = liquidity.value1;
  poolEntity.utilization = poolContract.utilization();
  poolEntity.maxBorrow = poolContract.liquidityAvailable(MAX_UINT256, BigInt.fromI32(1));
  poolEntity.save();
  return poolEntity;
}

function updateCollateralTokenEntity(id: string): void {
  const collateralTokenEntity = CollateralTokenEntity.load(id);
  if (collateralTokenEntity) {
    let tvl = BigInt.zero();
    let used = BigInt.zero();
    let maxBorrow = BigInt.zero();
    for (let i = 0; i < collateralTokenEntity.poolIds.length; i++) {
      const pool = PoolEntity.load(collateralTokenEntity.poolIds[i]);
      if (pool) {
        tvl = tvl.plus(pool.totalValueLocked);
        used = used.plus(pool.totalValueUsed);
        if (maxBorrow.lt(pool.maxBorrow)) maxBorrow = pool.maxBorrow;
      }
    }
    collateralTokenEntity.totalValueLocked = tvl;
    collateralTokenEntity.totalValueUsed = used;
    collateralTokenEntity.maxBorrow = maxBorrow;
    collateralTokenEntity.save();
  }
}

function updateTickEntity(depth: BigInt): void {
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

function updateDepositEntity(account: Address, depth: BigInt, timestamp: BigInt): void {
  const poolEntity = PoolEntity.load(poolAddress);
  if (!poolEntity) {
    log.error("No Pool entity for this event", []);
    throw new Error("createOrUpdateDepositEntity: Pool not found");
  }
  const depositEntityID = `${poolAddress}-pool-${account.toHexString()}-${depth}`;
  const deposit = poolContract.deposits(account, depth);
  if (deposit.shares.isZero()) {
    store.remove("Deposit", depositEntityID);
    return;
  }
  let depositEntity = DepositEntity.load(depositEntityID);
  if (!depositEntity) {
    const tickID = `${poolAddress}-tick-${depth}`;
    let tickEntity = Tick.load(tickID);
    if (!tickEntity) {
      log.error("No Tick entity found for this deposit", []);
      throw new Error("updateDepositEntity: Tick not found");
    }
    depositEntity = new DepositEntity(depositEntityID);
    depositEntity.sharePrice = tickEntity.value.times(BigInt.fromI32(10).pow(18)).div(tickEntity.shares);
  }
  depositEntity.pool = poolAddress;
  depositEntity.account = account;
  depositEntity.tick = `${poolAddress}-tick-${depth}`;
  depositEntity.shares = deposit.shares;
  depositEntity.redemptionPending = deposit.redemptionPending;
  depositEntity.redemptionIndex = deposit.redemptionIndex;
  depositEntity.redemptionTarget = deposit.redemptionTarget;
  depositEntity.collateralToken = Address.fromString(poolEntity.collateralToken);
  depositEntity.maxLoanDuration = poolEntity.maxLoanDuration;
  depositEntity.depth = depth;
  depositEntity.updatedAt = timestamp;
  depositEntity.save();
}

function createLoanEntity(receipt: LoanReceipt, encodedReceipt: Bytes, receiptHash: Bytes, timestamp: BigInt): void {
  const nodeReceipts = receipt.nodeReceipts;

  /* Update the Pool, CollateralToken, and Ticks */
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  for (let i = 0; i < nodeReceipts.length; i++) updateTickEntity(nodeReceipts[i].depth);

  /* Create the Loan entity */
  const loanEntity = new LoanEntity(receiptHash.toHexString());

  let principal: BigInt = BigInt.zero();
  let repayment: BigInt = BigInt.zero();
  let depths: BigInt[] = [];
  for (let i = 0; i < nodeReceipts.length; i++) {
    const nodeReceipt = nodeReceipts[i];
    principal = principal.plus(nodeReceipt.used);
    repayment = repayment.plus(nodeReceipt.pending);
    depths.push(nodeReceipt.depth);
  }

  loanEntity.loanReceipt = encodedReceipt;
  loanEntity.principal = principal;
  loanEntity.repayment = repayment;
  loanEntity.depths = depths;
  loanEntity.pool = poolAddress;
  loanEntity.timestamp = timestamp.toI32();
  loanEntity.status = LoanStatus.Active;
  loanEntity.borrower = receipt.borrower;
  loanEntity.maturity = receipt.maturity.toI32();
  loanEntity.duration = receipt.duration.toI32();
  loanEntity.collateralToken = receipt.collateralToken.toHexString();
  loanEntity.collateralTokenId = receipt.collateralTokenId;

  loanEntity.save();
}

/**************************************************************************/
/* mappings */
/**************************************************************************/

export function handleDeposited(event: Deposited): void {
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.depth);
  updateDepositEntity(event.params.account, event.params.depth, event.block.timestamp);
  const poolEventID = createPoolEvent(event, PoolEventType.Deposited, event.params.account);
  const depositedEntity = new DepositedEntity(poolEventID);
  depositedEntity.account = event.params.account;
  depositedEntity.depth = event.params.depth;
  depositedEntity.amount = event.params.amount;
  depositedEntity.shares = event.params.shares;
  depositedEntity.save();
}

export function handleRedeemed(event: Redeemed): void {
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.depth);
  updateDepositEntity(event.params.account, event.params.depth, event.block.timestamp);
  const poolEventID = createPoolEvent(event, PoolEventType.Redeemed, event.params.account);
  const redeemedEntity = new RedeemedEntity(poolEventID);
  redeemedEntity.account = event.params.account;
  redeemedEntity.depth = event.params.depth;
  redeemedEntity.shares = event.params.shares;
  redeemedEntity.save();
}

export function handleWithdrawn(event: Withdrawn): void {
  const poolEntity = updatePoolEntity();
  updateCollateralTokenEntity(poolEntity.collateralToken);
  updateTickEntity(event.params.depth);
  updateDepositEntity(event.params.account, event.params.depth, event.block.timestamp);
  const poolEventID = createPoolEvent(event, PoolEventType.Withdrawn, event.params.account);
  const withdrawnEntity = new WithdrawnEntity(poolEventID);
  withdrawnEntity.account = event.params.account;
  withdrawnEntity.depth = event.params.depth;
  withdrawnEntity.amount = event.params.amount;
  withdrawnEntity.shares = event.params.shares;
  withdrawnEntity.save();
}

export function handleLoanOriginated(event: LoanOriginated): void {
  const receipt = poolContract.decodeLoanReceipt(event.params.loanReceipt);
  createLoanEntity(receipt, event.params.loanReceipt, event.params.loanReceiptHash, event.block.timestamp);

  const poolEventID = createPoolEvent(event, PoolEventType.LoanOriginated, receipt.borrower);

  const loanOriginatedEntity = new LoanOriginatedEntity(poolEventID);
  loanOriginatedEntity.loan = event.params.loanReceiptHash.toHexString();
  loanOriginatedEntity.save();
}

export function handleLoanRepaid(event: LoanRepaid): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());

  if (loanEntity) {
    loanEntity.status = LoanStatus.Repaid;
    loanEntity.save();

    const poolEntity = updatePoolEntity();
    updateCollateralTokenEntity(poolEntity.collateralToken);
    for (let i = 0; i < loanEntity.depths.length; i++) updateTickEntity(loanEntity.depths[i]);

    const poolEventID = createPoolEvent(event, PoolEventType.LoanRepaid, loanEntity.borrower);

    const loanRepaidEntity = new LoanRepaidEntity(poolEventID);
    loanRepaidEntity.loan = loanEntity.id;
    loanRepaidEntity.save();
  }
}

export function handleLoanLiquidated(event: LoanLiquidated): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());

  if (loanEntity) {
    loanEntity.status = LoanStatus.Liquidated;
    loanEntity.save();

    const poolEventID = createPoolEvent(event, PoolEventType.LoanLiquidated, loanEntity.borrower);

    const loanLiquidatedEntity = new LoanRepaidEntity(poolEventID);
    loanLiquidatedEntity.loan = loanEntity.id;
    loanLiquidatedEntity.save();
  }
}

export function handleCollateralLiquidated(event: CollateralLiquidated): void {
  const loanEntity = LoanEntity.load(event.params.loanReceiptHash.toHexString());

  if (loanEntity) {
    loanEntity.status = LoanStatus.CollateralLiquidated;
    loanEntity.save();

    const poolEntity = updatePoolEntity();
    updateCollateralTokenEntity(poolEntity.collateralToken);
    for (let i = 0; i < loanEntity.depths.length; i++) updateTickEntity(loanEntity.depths[i]);
  }
}
