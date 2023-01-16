import { BigInt, dataSource, log } from "@graphprotocol/graph-ts";
import { Pool as PoolEntity } from "../generated/schema";
import { Deposited, Pool, Redeemed, Withdrawn } from "../generated/templates/Pool/Pool";

const MAX_UINT256 = BigInt.fromI32(2).pow(256).minus(BigInt.fromI32(1));

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

export function handleDeposited(event: Deposited) {
  updatePoolMaxBorrow();
  // TODO: create event entity
}

export function handleRedeemed(event: Redeemed) {
  updatePoolMaxBorrow();
  // TODO: create event entity
}

export function handleWithdrawn(event: Withdrawn) {
  updatePoolMaxBorrow();
  // TODO: create event entity
}
