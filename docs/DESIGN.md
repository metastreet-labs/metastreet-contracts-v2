# MetaStreet Pool Design Document

## Introduction

The MetaStreet v2 Pool is a permissionless lending pool for NFT collateral with
automatic tranching. Pool is responsible for organizing lending capital with
different risk and rate profiles from depositors into fixed-duration loans for
borrowers.

## Goals

The main goals of MetaStreet v2 Pools is to improve on three shortcomings of v1
Vaults:

- **Oracleless**: Remove the dependency on a centralized price oracle for loan
  to value limits
- **Dynamic Interest Rate Model**: Replace a fixed, governance-driven interest
  rate model with a dynamic, deposit driven one
- **Permissionless**: Allow users to instantiate a lending pool for any
  collection permissionlessly

In addition, v2 Pools have refactored the debt purchasing functionality of v1
Vaults into Note Collateral Wrappers, which isolate the core protocol from
third-party lending platforms.

## Design Overview

### Permissionless Pools

Pools can be instantiated permissionlessly for any ERC721 token. After
instantiation, Pools have no external owners or privileged operations.

The Pool Factory contract is the administrator of an instantiated Pool to allow
for admin fee collection in the future. Admin fees would be accrued to the
protocol.

### User-defined Risk Deposits

Capital deposited into a Pool carries user-defined risk parameters, including a
maximum loan limit, a maximum loan duration, and an interest rate tier.

The loan limit imposes a maximum limit that the deposit funds can be used in
when the Pool originates a loan. Similarly, the maximum duration limits imposes
the maximum loan duration the deposit funds can be used for. The interest rate
tier determines the cost of borrowing the deposit funds.

### Fixed-Duration Loans

Originated loans are fixed duration with prorated repayments. Borrowers can
also choose to cash-in or cash-out refinance their loans, also with proration,
allowing them to continually extend loans beyond the Pool's maximum fixed
duration.

Overdue loans are subject to liquidation, but borrowers are afforded a grace
period to repay the loan until an external actor executes the liquidation.
Borrowers also receive a split of the liquidation surplus.

### Automatic Tranching

Loans are funded by sourcing liquidity from deposits of ascending loan limits,
which function as tranches in the loan. The higher loan limit tranches receive
greater interest, in exchange for higher default risk. The lower loan limit
tranches receive less interest, in exchange for the insurance by the higher
tranches.

In the event of a default, the highest tranches absorb any loss in descending
order, while the lowest tranches are made whole in ascending order, up to the
available liquidation proceeds.

### Liquidations

Liquidated loan collateral is handed to a collateral liquidator associated with
the Pool. Currently, the primary collateral liquidator is the English Auction
Collateral Liquidator contract, which hosts an onchain English Auction for
collateral. On completion of liquidation, proceeds are returned to the Pool to
reimburse the depositor funds used in the loan. Liquidation losses are absorbed
by the highest tranches, while surpluses are split between the highest tranch
and the borrower.

### Collateral Filters

Pools have a collateral filter that is responsible for validating the
collateral provided when originating a loan. Currently, the primary collateral
filter is the Collection Collateral Filter, which validates that the collateral
belongs to a single collection.

Future collateral filters include the Ranged Collection Collateral Filter,
which validates collateral belongs to a contiguous range of token IDs, and the
Merkle Collateral Filter, which validates that collateral belongs a sparse set
of token IDs.

### Collateral Wrappers

Pools support collateral wrappers, which are special tokens that wrap
collateral and provide an interface to enumerate the underlying collateral and
unwrap it for liquidation. The primary purpose of this feature is to implement
bundles containing multiple collateral.

When enabled, a Pool recognizes the tokens of the Bundle Collateral Wrapper as
collateral, subject to validation of the underlying collateral by the
collateral filter.

## Design Details

### Contract Organization

#### Pool, Interest Rate Model, and Collateral Filter

A concrete Pool is a monolithic contract composed of three mix-ins: the
abstract base [`Pool`](../contracts/Pool.sol), a collateral filter, and an
interest rate model. The mixins provide internal virtual overrides that allow
the Pool to validate collateral and calculate interest for a loan,
respectively. The abstract base class for collateral filters is
[`CollateralFilter`](../contracts/CollateralFilter.sol). The abstract base
class for interest rate models is
[`InterestRateModel`](../contracts/InterestRateModel.sol).

For example, the concrete [`WeightedRateCollectionPool`](../contracts/configurations/WeightedRateCollectionPool.sol) is comprised of [`Pool`](../contracts/Pool.sol), [`CollectionCollateralFilter`](../contracts/filters/CollectionCollateralFilter.sol), and [`WeightedInterestRateModel`](../contracts/rates/WeightedInterestRateModel.sol).

The [`IPool`](../contracts/interfaces/IPool.sol) interface defines the external interface to Pools.

#### Collateral Wrappers

Collateral wrappers are external token contracts that implement the
[`ICollateralWrapper`](../contracts/interfaces/ICollateralWrapper.sol) interface. They are deployed independently of
concrete Pools and are associated with a Pool at construction time. A concrete
Pool can support up to three collateral wrappers.

The main collateral wrapper is the [`BundleCollateralWrapper`](../contracts/wrappers/BundleCollateralWrapper.sol).

#### Collateral Liquidators

Collateral liquidators are external contracts that implement the
[`ICollateralLiquidator`](../contracts/interfaces/ICollateralLiquidator.sol) interface. They are deployed independently of
concrete Pools and are associated with a Pool at initialization time.

The main collateral liquidator is the
[`EnglishAuctionCollateralLiquidator`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol).

#### Pool Factory

The [`PoolFactory`](../contracts/PoolFactory.sol) is responsible for creating
pools, and in doing so, becomes the administrator of any created Pool to
support future collection of admin fees.

### Pool Parameters

Pools have two sets of parameters, those bound at a construction and those
bound at initialization. Since the Pool contract is large, it is deployed as an
implementation contract and the [`PoolFactory`](../contracts/PoolFactory.sol)
creates a proxy instance for each new Pool.

Construction parameters include up to three collateral wrappers and an optional
[delegate.cash](https://delegate.cash/) registry address (see Borrow section below for more
information on this feature). These parameters are stored as immutable
addresses, so they are bound to the implementation contract at deploy time.

Initialization parameters for a proxied pool include the collateral token, the
currency token, the collateral liquidator, a discrete set of durations, a
discrete set of rates, and interest rate model specific parameters. The role of
durations, rates, and interest rate model parameters are discussed in the
sections below.

While the Pool initialization parameters are essentially permissionless, the
frontend is still required to validate a Pool is proxied with a vetted
implementation contract and is initialized with a vetted collateral liquidator,
as these can implement malicious behavior.

### Ticks and Liquidity Routing

Ticks are unsigned, 128-bit values that encode conditions on liquidity,
including a loan limit, duration index, and rate index. The [`Tick`](../contracts/Tick.sol)
utility library is responsible for encoding and decoding ticks. Deposits are
made into specific ticks by depositors, and liquidity is sourced from specific
ticks to assemble the funds of a loan for borrowers. The ticks used in a loan
become the tranches of the loan.

```
                            Tick Bit Layout
+-----------------------------------------------------------------------+
|                                 128                                   |
+--------------------------------------|----------|----------|----------+
|                  120                 |    3     |     3    |     2    |
|                 Limit                | Dur. Idx | Rate Idx | Reserved |
+-----------------------------------------------------------------------+
```

Limit is a 120-bit value that imposes the maximum limit funds sourced from the
tick can be used in. Duration index is the maximum duration funds sourced from
the tick can be used for, and rate index is the interest rate tier associated
with the funds. Duration index and rate index are indices into predetermined,
discrete tiers that are assigned at Pool initialization.

Example of a possible configuration of durations, rates, and ticks:

```
Durations = [ 7 days, 14 days, 30 days ]
Rates     = [    10%,     30%,     50% ]

#   Tick                        Liquidity
6   (50 ETH,   7 days, 50%)     20 ETH
5   (40 ETH,   7 days, 50%)     30 ETH
4   (30 ETH,  14 days, 30%)     30 ETH
3   (15 ETH,  30 days, 30%)     50 ETH
2   (5  ETH,  30 days, 10%)     100 ETH
1   (2.5 ETH, 30 days, 10%)     150 ETH
```

To assemble a 30 day loan, ticks 1, 2, 3 can be used to create a 15 ETH loan
that is organized as follows: `[2.5 ETH from #1, 2.5 ETH from #2, 10 ETH from #3]`.
The interest for the loan would be determined by the `10%`, `10%`, and `30%`
interest rate tiers applied to amount used from each tick and loan duration.
Note that ticks 4, 5, 6 are ineligible for this loan, because the loan duration
exceeds their maximum duration.

Similarly, a 14 day loan can be assembled from ticks 1-4, and a 7 day loan from
ticks 1-6. Longer duration ticks can be used for shorter duration loans.

Note that loan limit is an upper bound on the amount of funds that can be used
from a tick, but the actual amount pulled from each tick depends on the
cumulative amount built up from previous ticks.

The [`LiquidityManager`](../contracts/LiquidityManager.sol), particularly the [`source()`](../contracts/LiquidityManager.sol#L539) function,
is responsible for sourcing liquidity from ticks and creating a record of their
usage for bookkeeping. It is also responsible for enforcing the conditions on
tick usage, like the loan limit and maximum duration.

### Offchain Ticks and Loan Receipts

Ticks are selected offchain and provided to the borrow API when originating a
loan. This avoids the gas costs associated with many storage lookups, and also
allows for complex, offchain optimization of the ticks used. It also means that
it is possible for borrowers to originate suboptimal loans, using too few ticks
or more expensive (e.g. higher interest rate tier) ticks than necessary.
However, this is not a violation of the protocol, as the protocol's guarantee
is that funds from a tick are not used beyond its loan limit or maximum
duration, and that the loan is priced according to the associated interest rate
tiers.

In order to reduce storage costs, loan metadata is stored offchain and a
commitment to it stored onchain. (Technically, the loan metadata is onchain, as
it's emitted in the [`LoanOriginated`](../contracts/interfaces/IPool.sol#L101)
event, but it's not accessible from a contract.)

The loan metadata, called Loan Receipt, contains all the relevant details of
the loan required for its repayment or liquidation, including the principal,
repayment, borrower, maturity, collateral, ticks used, etc. The
[`LoanReceipt`](../contracts/LoanReceipt.sol) utility library is responsible
for encoding and decoding loan receipts, which are tightly packed. The layout
of a loan receipt is summarized below:

```
Header (155 bytes)
    1   uint8   version                        0:1
    32  uint256 principal                      1:33
    32  uint256 repayment                      33:65
    20  address borrower                       65:85
    8   uint64  maturity                       85:93
    8   uint64  duration                       93:101
    20  address collateralToken                101:121
    32  uint256 collateralTokenId              121:153
    2   uint16  collateralWrapperContextLen    153:155

Collateral Wrapper Context Data (M bytes)      155:---

Node Receipts (48 * N bytes)
    N   NodeReceipts[] nodeReceipts
        16  uint128 tick
        16  uint128 used
        16  uint128 pending
```

The node receipts contain the amount used from each tick (`used`), and the
amount due on repayment (`pending`). Upon repayment, the `pending` amount
is restored to each tick referenced in the loan.

### Weighted Interest Rate Model

Interest rate models are responsible for two roles: determining the overall
interest rate for a loan given the ticks used, and distributing that interest
to the ticks used.

The primary interest rate model is the [`WeightedInterestRateModel`](../contracts/rates/WeightedInterestRateModel.sol). It
determines the interest rate of a loan in [`_rate()`](../contracts/rates/WeightedInterestRateModel.sol#L115) by computing the average of all tick
rates, weighted by the amount used for each tick. For example, if a `25 ETH`
loan used `5 ETH at 10%`, `10 ETH at 10%`, and `10 ETH at 30%`, the weighted
average interest rate would be `(5 * 10% + 10 * 10% + 10 * 30%)/20` or `22.5%`.

The `WeightedInterestRateModel` distributes interest in
[`_distribute()`](../contracts/rates/WeightedInterestRateModel.sol#L136) along a
negative exponential curve, to allocate greater interest to higher ticks in
compensation for their greater exposure to default risk. The negative
exponential base is configured at Pool initialization time.

For example, for an exponential base of 2, the distribution of interest to five
ticks that source equal liquidity would follow the allocation:

```
#   Allocation          Normalized
5   1/2^1 = 0.50        0.5161...
4   1/2^2 = 0.25        0.2581...
3   1/2^3 = 0.125       0.1290...
2   1/2^4 = 0.0625      0.0645...
1   1/2^5 = 0.03125     0.0323...
```

The interest rate model performs a normalization pass to ensure the allocation
sums to one.

Since liquidity might not be sourced equally from the ticks used, e.g. some
ticks may contribute more liquidity to a loan than others, the interest rate
model prorates the weight of the ideal negative exponential curve by the
liquidity used, and then normalizes the allocation across all the ticks. While
higher ticks receive higher weights, their final interest allocation is still
scaled by their overall contribution to the loan.

Ticks that contribute insignificant liquidity to a loan below a tick interest
threshold configured at Pool initialization time, also called "dust ticks",
receive no interest in a loan. This is to prevent a class of attacks where
borrowers could otherwise receive a free or significantly reduced interest
loans by borrowing from their own high loan limit ticks with little deposited
liquidity and paying interest to themselves.

### Admin Fees

Admin fees are collected from loan repayments, as a fixed percentage of the
total interest of the loan. Only successfully repaid loans contribute admin
fees. In the case of a defaulted loan, the admin fee is remitted to the ticks
to offset the liquidation losses.

The Pool administrator — the `PoolFactory` contract — can set the admin fee
rate on a Pool and withdraw admin fees from a Pool.

Admin fees are set to zero for the time being. They may be enabled and managed
through a governance process in the future to accrue fees to the protocol.

### Collection Collateral Filter

Collateral filters are responsible for validating collateral is acceptable when
originating a loan.

The primary collateral filter is the
[`CollectionCollateralFilter`](../contracts/filters/CollectionCollateralFilter.sol),
which simply checks that the collateral token address matches the one
configured with the Pool at initialization time. This allows the Pool to
originate loans for any token ID that belongs to the specified collection as
collateral.

### Deposit Interface

The deposit interface is responsible for depositing, redeeming, and withdrawing
capital into a Pool with user-defined risk parameters.

#### Deposit

```solidity
function deposit(uint128 tick, uint256 amount, uint256 minShares) external;
```

The [`deposit()`](../contracts/Pool.sol#L1133) function accepts an amount of
cash to deposit under a tick in exchange for tick shares.

Tick shares represent an ownership stake in the tick value, which will
experience appreciation with repayments and profitable liquidations, and
depreciation with liquidation losses.

The deposit price is computed with the current tick value plus 50% of pending
interest to the tick. This elevated deposit price is designed to prevent
capturing the interest of repaid loans prematurely, and to encourage longer
term deposits. The `minShares` parameter enforces a minimum on the shares
exchanged for the deposited amount.

The [`LiquidityManager`](../contracts/LiquidityManager.sol#L307) imposes a tick
limit spacing requirement on deposits, to facilitate liquidity aggregation that
ultimately minimizes the amount of ticks needed in a loan. Currently, this
spacing requirement is set to 10%, so no deposit can instantiate a new tick
with a loan limit within 10% of an existing tick loan limit.

#### Redeem

```solidity
function redeem(uint128 tick, uint256 shares) external;
```

The [`redeem()`](../contracts/Pool.sol#L1149) function redeems shares from a tick for cash.

If sufficient cash is available in the tick, the shares are immediately
redeemed at a redemption price computed from the current tick value. The
remaining, unredeemed shares are scheduled for redemption within the tick, and
converted to cash in the future as loans are repaid or liquidated. Scheduled
redemptions may be executed at various redemption share prices, as repayment
and liquidation activity affect the tick value. Redemptions are serviced in the
order they are scheduled.

Only one redemption can be outstanding in a depositor's tick position at a time.

The current cash available for a redemption can be determined with the
[`redemptionAvailable()`](../contracts/Pool.sol#L1162) getter.

#### Withdraw

```solidity
function withdraw(uint128 tick) external returns (uint256 amount);
```

The [`withdraw()`](../contracts/Pool.sol#L1188) function withdraws the cash for a redemption that is
available.

#### Rebalance

```solidity
function rebalance(
  uint128 srcTick,
  uint128 dstTick,
  uint256 minShares
) external returns (uint256 amount);
```

The [`rebalance()`](../contracts/Pool.sol#L1204) function deposits cash from a redemption that is
available into another tick, instead of withdrawing it. The `minShares`
parameter enforces a minimum on the shares received in the new tick.

### Lending Interface

The lending interface is responsible for quoting, borrowing, repaying,
refinancing, and liquidating loans with the Pool.

#### Quote

```solidity
function quote(
  uint256 principal,
  uint64 duration,
  address collateralToken,
  uint256[] calldata collateralTokenIds,
  uint128[] calldata ticks,
  bytes calldata options
) external view returns (uint256);
```

The [`quote()`](../contracts/Pool.sol#L881) function quotes a loan repayment with the specified loan
terms and liquidity ticks.

#### Borrow

```solidity
function borrow(
  uint256 principal,
  uint64 duration,
  address collateralToken,
  uint256 collateralTokenId,
  uint256 maxRepayment,
  uint128[] calldata ticks,
  bytes calldata options
) external returns (uint256);
```

The [`borrow()`](../contracts/Pool.sol#L908) function originates a loan with
the specified loan terms and liquidity ticks. The collateral may either be the
Pool's native collateral token or a collateral wrapper token.

A variety of additional options are supported by `borrow()` in the encoded
`options` parameter. These include:

- Collateral wrapper context, needed by some collateral wrappers
- An optional [delegate.cash](https://delegate.cash/) delegation address for the token
- Collateral filter context, reserved for future use

Option data is encoded with a type-length-value (TLV) system, with a 2 byte
type or tag, 2 byte length, and variable length data. See
[`_getOptionsData()`](../contracts/Pool.sol#L444) for more details.

On successful loan origination, the `borrow()` function emits a
[`LoanOriginated`](../contracts/interfaces/IPool.sol#L101) event with an encoded loan receipt. This loan receipt is used
in future repay, refinance, and liquidate operations for the loan.

#### Repay

```solidity
function repay(bytes calldata encodedLoanReceipt) external returns (uint256);
```

The [`repay()`](../contracts/Pool.sol#L948) function repays a loan, prorating the repayment with the
elapsed loan duration, and transfers the collateral back to the borrower.

#### Refinance

```solidity
function refinance(
  bytes calldata encodedLoanReceipt,
  uint256 principal,
  uint64 duration,
  uint256 maxRepayment,
  uint128[] calldata ticks
) external returns (uint256);
```

The [`refinance()`](../contracts/Pool.sol#L976) function refinances a loan with the specified loan terms and
liquidity ticks. Internally, it combines repay and borrow operations, and emits
a [`LoanOriginated`](../contracts/interfaces/IPool.sol#L101) event with a new loan receipt.

#### Liquidate

```solidity
function liquidate(bytes calldata loanReceipt) external;
```

The [`liquidate()`](../contracts/Pool.sol#L1022) function liquidates an overdue loan, transferring
the collateral to the collateral liquidator for liquidation.

Proceeds from the liquidation are transferred from the collateral liquidator to
the Pool, and are processed in the [`onCollateralLiquidated()`](../contracts/Pool.sol#L1064) callback. Any
surplus from the liquidation is remitted to the borrower.

### English Auction Collateral Liquidator

Collateral liquidators are responsible for liquidating loan collateral and
returning the proceeds to the Pool. Collateral liquidators implement the
[`ICollateralLiquidator`](../contracts/interfaces/ICollateralLiquidator.sol) interface to accept liquidations, while the
Pool implements the [`ICollateralLiquidationReceiver`](../contracts/interfaces/ICollateralLiquidationReceiver.sol) interface to
receive the proceeds of liquidations.

The primary collateral liquidator is the
[`EnglishAuctionCollateralLiquidator`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol). When a loan is liquidated with a
Pool, it transfers the collateral to the liquidator. The
[`EnglishAuctionCollateralLiquidator`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol) starts an auction for the collateral with
the first [`bid()`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol#L554) on the collateral. The auction runs for the auction
duration configured at initialization. If a higher bid appears within a time
extension window before the end of the auction, the contract extends the
auction by a time extension, both of which are also configured at
initialization. Finally, when the auction ends, the winning bidder can
[`claim()`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol#L625) the collateral, the proceeds are transferred to the Pool,
and then processed by the Pool in the [`onCollateralLiquidated()`](../contracts/Pool.sol#L1064)
callback.

### Collateral Wrappers

Collateral wrappers allow a Pool to recognize and accept collateral that exists
in a wrapped form for a loan. This facility is useful for implementing a number
of extensions to the Pool, such as bundles, airdrop receivers, and collateral
in the form of promissory notes from third-party lending platforms.

Collateral wrappers are implemented as an ERC721 token that the Pool takes
custody of instead of the native collateral token for a loan. Additionally,
collateral wrappers implement the [`ICollateralWrapper`](../contracts/interfaces/ICollateralWrapper.sol) interface,
which allows a Pool to enumerate the underlying collateral for validation and
to unwrap the underlying collateral for liquidation.

To reduce storage requirements and for gas efficiency, collateral wrappers may
use an offchain context that is provided in calldata when borrowing. This
context is forwarded to the collateral wrapper when enumerating or liquidating
the underlying collateral. The context is stored in the loan receipt to make it
available for liquidations.

#### Bundle Collateral Wrapper

The [`BundleCollateralWrapper`](../contracts/wrappers/BundleCollateralWrapper.sol) is the collateral wrapper deployed with
all Pools. It allows a borrower to wrap multiple collateral tokens into a
bundle and borrow a greater principal, multiplied by the count of collateral.

A user can mint a bundle with the [`mint()`](../contracts/wrappers/BundleCollateralWrapper.sol#L167) function, which will
transfer the specified token IDs to the bundle contract, and mint a bundle
token to the user. The minted bundle token can then be used in a loan with a
Pool that supports the underlying collateral. The bundle token is held by the
Pool during a loan, and transferred back to the borrower on repayment. A
borrower can withdraw their bundled NFTs with [`unwrap()`](../contracts/wrappers/BundleCollateralWrapper.sol#L196), which also
burns the bundle. Bundles do not support partial withdrawals.

#### Note Collateral Wrapper

The `NoteCollateralWrapper` (maintained in an separate repository), is a
permissioned collateral wrapper that wraps the promissory notes of third-party
lending platforms. This collateral wrapper allows a Pool to lend against the
underlying collateral of a third-party promissory note. Its `unwrap()`
implementation allows for liquidating an overdue note for the underlying
collateral.

## Deployment

Initial deployment of the MetaStreet v2 Pool contracts is proxied to allow for
upgrades and bug fixes. However, deployment will ultimately migrate to
immutable Pools, which is already supported in the codebase.

### Pool Factory Deployment

The [`PoolFactory`](../contracts/PoolFactory.sol) contract is deployed as an ERC1967 proxy, with a
permissioned [`upgradeToAndCall()`](../contracts/PoolFactory.sol#L194) API to facilitate upgrades.

The [`PoolFactory`](../contracts/PoolFactory.sol) will ultimately be owned by protocol governance.

### Pool Deployment

The Pool is deployed as an ERC1967 `BeaconProxy`.

Proxied pools can be created with the `PoolFactory`
[`createProxied()`](../contracts/PoolFactory.sol#L106) function, which accepts a
Pool implementation beacon and initialization parameters.

Immutable pools can be created with the `PoolFactory` [`create()`](../contracts/PoolFactory.sol#L86)
function, which accepts a Pool implementation contract and initialization
parameters. This function creates an ERC1167 minimal clone proxy.

As the Pool contract stabilizes, deployment will ultimately switch from
`createProxied()` to `create()` and use versioned Pool implementations for newly
created Pools.

### Collateral Liquidator Deployment

The [`EnglishAuctionCollateralLiquidator`](../contracts/liquidators/EnglishAuctionCollateralLiquidator.sol) contract is deployed as an
ERC1967 `BeaconProxy`.

This contract can also be deployed immutably.

### Collateral Wrapper Deployment

The [`BundleCollateralWrapper`](../contracts/wrappers/BundleCollateralWrapper.sol) contract is deployed as an ERC1967
`TransparentUpgradeableProxy`.

This contract can also be deployed immutably.
