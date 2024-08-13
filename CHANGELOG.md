* ERC20DepositTokenImplementation v1.1 - 08/12/2024
    * Add ratio tick formatting to token name and symbol.

* Pool v2.13 - 08/12/2024
    * Fix divide-by-zero during collateral liquidation for zero interest loans
      caused by very small principals.

* PoolFactory v1.3 - 07/30/2024
    * Rename `setAdminFeeRate()` API to `setAdminFee()`.
    * Add support for setting admin fee share.
    * Add `withdrawAdminFees()` API.

* Pool v2.12 - 07/30/2024
    * Add admin fee share support.
    * Redistribute admin fee as lender surplus in collateral liquidation.

* Pool v2.11 - 06/25/2024
    * Fix sourcing from ticks of same limit and duration, but different rates.

* EnglishAuctionCollateralLiquidator v2.1 - 06/25/2024
    * Add claim delay for non-winners of auction.

* SimpleSignedPriceOracle v1.2 - 05/21/2024
    * Add initializer for proxy deployment support.

* Pool v2.10 - 05/09/2024
    * Fix oracle price scaling for sub-18 currency tokens.

* KongzBundleCollateralWrapper v1.1 - 04/16/2024
    * Fix rounding edge case in claimable amount.

* SimpleSignedPriceOracle v1.1 - 04/16/2024
    * Add check for non-zero quote price.
    * Change access control from Ownable to Ownable2Step.

* Pool v2.9 - 04/16/2024
    * Allow empty oracle context with `price()` in ExternalPriceOracle.
    * Make `price()` API public in PriceOracle.
    * Add locked shares on initial deposit in LiquidityLogic.
    * Switch to absolute spacing for ratio ticks.

* KongzBundleCollateralWrapper v1.0 - 03/27/2024
    * Initial release.

* SimpleSignedPriceOracle v1.0 - 03/27/2024
    * Initial release.

* Pool v2.8 - 03/06/2024
    * Add support for sub-18 decimal currency tokens.
    * Add support for ratio ticks and external price oracles.

* Pool v2.7 - 03/06/2024
    * Remove lender surplus from collateral liquidation.
    * Validate principal is non-zero for borrows.
    * Add support for aliases to CollectionCollateralFilter.
    * Add migration for CryptoPunks collection pools to add the Yuga Labs
      CryptoPunks 721 Wrapper as an alias.
    * Remove `_initialized` storage variable in Pool configurations and replace
      it with an equivalent check.

* Pool v2.6 - 12/21/2023
    * Refactor internal API in InterestRateModel.
    * Migrate to interest weighting based on cumulative repayment in
      WeightedInterestRateModel.

* Pool v2.5 - 12/13/2023
    * Remove tick threshold from WeightedInterestRateModel.
    * Limit number of ticks sourced for a loan in LiquidityManager.
    * Use safe cast for loan maturity in BorrowLogic.

* Pool v2.4 - 12/06/2023
    * Add support for Delegate v2.
    * Add check for invalid ticks in `tokenize()`.
    * Add `tick` parameter to TokenCreated event in ERC20 tokenization.

* EnglishAuctionCollateralLiquidator v2.0 - 11/30/2023
    * Add `collateralTokenId` parameter to `LiquidationStarted` event.
    * Add `collateralWrappers()` API.
    * Bump major version to reflect breaking API and ABI changes.

* ERC20DepositTokenImplementation v1.0 - 11/15/2023
    * Initial release.

* Pool v2.3 - 11/15/2023
    * Add ERC20 tokenization of deposit positions.
    * Add collateral wrapper support to `quote()` API.
    * Add `depositSharePrice()` and `redemptionSharePrice()` APIs to
      ILiquidity.
    * Refactor Pool logic into linked libraries.

* EnglishAuctionCollateralLiquidator v1.2 (Pre-release) - 10/27/2023
    * Add generic support for wrapped collateral.

* PunkCollateralWrapper v1.0 - 10/27/2023
    * Initial release.
* ERC1155CollateralWrapper v2.1 - 10/27/2023
    * Add implementation of new `enumerateWithQuantities()` and
      `transferCalldata()` APIs.
* BundleCollateralWrapper v2.1 - 10/27/2023
    * Add implementation of new `enumerateWithQuantities()` and
      `transferCalldata()` APIs.

* Pool v2.2 - 10/11/2023
    * Fix overflow revert from narrow casting of accruals in LiquidityManager.

* PoolFactory v1.2 - 09/20/2023
    * Add `setAdminFeeRate()` API.

* Pool v2.1 - 09/20/2023
    * Add accrual value deposit pricing.
    * Allow resetting admin fee rate to zero.

* Pool v2.0 - 08/31/2023
    * Reverse duration ordering in ticks to source from longer duration ticks
      before shorter duration ones.
    * Improve liquidation surplus distribution to ticks by allocating it
      proportionally to interest earned.
    * Add `adminFee` to loan receipt.
    * Add deposit premium rate parameter to constructor.
    * Add support for multiple concurrent redemptions with the `redeem()`,
      `withdraw()`, `rebalance()` APIs in IPool.
    * Add return of shares ahead to `redemptionAvailable()` API in IPool.
    * Add `adminFeeBalance()` API to IPool.
    * Add `count()` API to ICollateralWrapper.
* BundleCollateralWrapper v2.0 - 08/31/2023
    * Add implementation of `count()` in new ICollateralWrapper API.
* ERC1155CollateralWrapper v1.0 - 08/31/2023
    * Initial release.
* SetCollectionCollateralFilter v1.0 - 08/31/2023
    * Initial release.
* MerkleCollectionCollateralFilter v1.0 - 08/31/2023
    * Initial release.

* Pool v1.4 - 08/14/2023
    * Add redemption queue target advancement to `withdraw()`/`rebalance()` in
      Pool and redemption queue scanning limit to LiquidityManager.

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
