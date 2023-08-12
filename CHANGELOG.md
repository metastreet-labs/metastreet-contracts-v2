* Pool v2.0 - 08/11/2023
    * Reverse duration ordering in ticks to source from longer duration ticks
      before shorter duration ones.
    * Add deposit premium rate parameter to constructor.
    * Add support for multiple concurrent redemptions in the `redeem()`,
      `withdraw()`, `rebalance()` APIs.

* ERC1155CollateralWrapper v1.0 - 08/11/2023
    * Initial release.

* Pool v1.3 - 07/25/2023
    * Validate shares are non-zero in `redeem()`.

* Pool v1.2 - 07/20/2023
    * Fix unlinking of empty nodes with leftover dust from redemption.

* Pool v1.1 - 07/14/2023
    * Optimize contract size.
    * Use `safeTransfer()` for ERC20 transfers.
    * Use safe cast for node count in LiquidityManager.
    * Add return of shares minted in `deposit()` API.
    * Add return of shares burned in `withdraw()` API.
    * Add return of shares burned and minted in `rebalance()` API.
* PoolFactory v1.1 - 07/14/2023
    * Add pool implementation allowlist.
* EnglishAuctionCollateralLiquidator v1.1 - 07/14/2023
    * Use `safeTransfer()` for ERC20 transfers.
    * Validate time extension parameters in `initialize()`.

* Pool v1.0 - 06/16/2023
    * Initial release.
* PoolFactory v1.0 - 06/16/2023
    * Initial release.
* BundleCollateralWrapper v1.0 - 06/16/2023
    * Initial release.
* EnglishAuctionCollateralLiquidator v1.0 - 06/16/2023
    * Initial release.
* WeightedInterestRateModel v1.0 - 06/16/2023
    * Initial release.
* RangedCollectionCollateralFilter v1.0 - 06/16/2023
    * Initial release.
* CollectionCollateralFilter v1.0 - 06/16/2023
    * Initial release.
