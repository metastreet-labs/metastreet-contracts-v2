import { Address, dataSource } from "@graphprotocol/graph-ts";
import {
  BundleCollateralWrapper as BundleCollateralWrapperContract,
  BundleMinted as BundleMintedEvent,
  Transfer as TransferEvent,
} from "../generated/BundleCollateralWrapper/BundleCollateralWrapper";
import { Bundle as BundleEntity } from "../generated/schema";

export function handleBundleMinted(event: BundleMintedEvent): void {
  const bundleEntity = new BundleEntity(event.params.tokenId.toString());
  bundleEntity.owner = event.params.account;
  bundleEntity.collateralContextData = event.params.encodedBundle;

  const bundleCollateralWrapperContract = BundleCollateralWrapperContract.bind(dataSource.address());
  const result = bundleCollateralWrapperContract.enumerate(event.params.tokenId, event.params.encodedBundle);
  bundleEntity.underlyingCollateralToken = result.value0;
  bundleEntity.underlyingCollateralTokenIds = result.value1;

  bundleEntity.save();
}

export function handleTransfer(event: TransferEvent): void {
  if (event.params.from == Address.zero()) return;

  const bundleEntity = BundleEntity.load(event.params.tokenId.toHexString());
  if (!bundleEntity) return;

  bundleEntity.owner = event.params.to;
  bundleEntity.save();
}
