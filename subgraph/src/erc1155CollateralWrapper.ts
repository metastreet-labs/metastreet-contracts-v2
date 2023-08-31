import { Address, dataSource } from "@graphprotocol/graph-ts";
import {
  BatchMinted as BatchMintedEvent,
  ERC1155CollateralWrapper as ERC1155CollateralWrapperContract,
  Transfer as TransferEvent,
} from "../generated/ERC1155CollateralWrapper/ERC1155CollateralWrapper";
import { Batch as BatchEntity } from "../generated/schema";

export function handleBatchMinted(event: BatchMintedEvent): void {
  const batchEntity = new BatchEntity(event.params.tokenId.toString());
  batchEntity.owner = event.params.account;
  batchEntity.collateralWrapperContext = event.params.encodedBatch;

  const erc1155CollateralWrapperContract = ERC1155CollateralWrapperContract.bind(dataSource.address());
  const data = erc1155CollateralWrapperContract.enumerate(event.params.tokenId, event.params.encodedBatch);
  batchEntity.underlyingCollateralTokenAddress = data.value0;
  batchEntity.underlyingCollateralTokenIds = data.value1;

  batchEntity.save();
}

export function handleTransfer(event: TransferEvent): void {
  if (event.params.from == Address.zero()) return;

  const batchEntity = BatchEntity.load(event.params.tokenId.toString());
  if (!batchEntity) return;

  batchEntity.owner = event.params.to;
  batchEntity.save();
}
