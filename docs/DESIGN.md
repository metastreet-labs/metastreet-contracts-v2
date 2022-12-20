# Pool v2 Design Document

## Goals

The main goals of MetaStreet Pool v2 is to improve on three shortcomings of v1:

* **Oracleless**: Remove the dependency on a centralized price oracle for loan to value limits
* **Dynamic Rates**: Replace a fixed, governance-driven interest rate model with a dynamic, automated one
* **Permissionless**: Allow users to instantiate a debt purchasing Pool for any collection permissionlessly

In addition, v2 includes some implementation subgoals:

* **Improved Gas Efficiency**: Reduce the cost of all operations, especially `sellNote()`, to under 200k gas
* **Lending Platform Integration**: Add support for integrating directly with lending platforms to originate loans (i.e. no promissory note required)
* **Token ID Whitelisting**: Add support for whitelisting arbitrary token IDs within a collection for loan collateral (e.g. for rare collections)

Finally, Vault has been renamed to Pool in v2.

## Design

The external API of MetaStreet Pool v2 is intended to be very similar to that of v1, with some parameter changes. However, the internal architecture has been redesigned to achieve the design goals above. The subsections below summarize the major design changes.

### Fixed Duration Loans

For simplified accounting, v2 will use a fixed duration for all loans (e.g. 30 days), which is specified at Pool instantiation time. Different Pools may provide different loan durations for the same collections.

### Liquidity Management

MetaStreet Vault v1 managed liquidity across two tranches: the senior tranche and the junior tranche. Any loan purchased by the Vault used liquidity from both tranches, proportional to their sizes. The senior tranche received a fixed rate of interest, while the junior tranche received the remaining interest from the loan, in exchange for insuring the senior tranche.

v2 replaces the concept of tranches with "loan limit ticks", which are like tranches at arbitrary loan limits. Capital from a tick can only be used for the principal (or purchase price) of a loan up to its loan limit. For example, if there is a 5 ETH tick with 100 ETH of deposits, capital drawn from that tick can only be used to fund the 0-5 ETH portion of a loan, or an intermediate portion, like 2-5 ETH, but not behind 5 ETH.

When a v2 Pool funds (or buys) a loan, it sources the capital from multiple, subsequent ticks up to the principal (or purchase price) of the loan. As an example, a v2 Pool might use five ticks at limits 10, 20, 30, 45, 60 ETH to fill a loan from 0-10, 10-20, 20-25, 25-40, 40-50 ETH. More aggressive ticks receive greater a interest rate on their capital, in exchange for insuring less aggressive ticks against default.

Enabling depositors to attach an arbitrary loan limit to their capital is what allows the v2 design to eliminate a price oracle and LTV-based parameters. Now, the maximum LTV supported by a Pool is simply the capital available up to the highest loan limit. This approach also gives depositors more flexibility with the risk they would like to take, instead of being limited to two tranches and slow, governance-driven LTV limits. However, it also requires more active position management by depositors at the higher loan limits.

In order to balance the flexibility of arbitrary loan limits with gas efficiency, the number of ticks used to fund a loan needs to be finite and limited to about 10 on L1. This is achieved by imposing a minimum spacing requirement between the ticks. When a deposit is made into a new tick, it must be at least a fixed percentage away from an adjacent tick (for example, 25%). By making the spacing requirement a relative percentage, ticks for both low and high collateral value assets can be seamlessly supported. For example, both sets of ticks below are spaced 25% apart, but are 10x apart in value:

```
>>> [1.25**i for i in range(20)]
[1.0, 1.25, 1.5625, 1.953125, 2.44140625, 3.0517578125, 3.814697265625, 4.76837158203125, 5.9604644775390625, 7.450580596923828, 9.313225746154785, 11.641532182693481, 14.551915228366852, 18.189894035458565, 22.737367544323206]
>>>
```

```
>>> [1.25**i/100 for i in range(20)]
[0.01, 0.0125, 0.015625, 0.01953125, 0.0244140625, 0.030517578125, 0.03814697265625, 0.0476837158203125, 0.059604644775390625, 0.07450580596923828, 0.09313225746154785, 0.11641532182693481, 0.14551915228366852, 0.18189894035458565, 0.22737367544323206]
>>>
```

The first set might appear for a 50 ETH floor price collateral, while the second for a 0.50 ETH floor price collateral. Note that the ticks may not necessarily fall on the boundaries above. All that is required is that a newly deposited tick is **at least** 25% away an adjacent tick, to keep the liquidity aggregated in a discrete number of ticks. On an L2, the tick spacing can be reduced to allow for finer granularity and many more ticks.

Depositing into a loan limit tick in v2 is similar to depositing into a tranche in v1. Both use share-based accounting with a `deposit()`, `redeem()`, and `withdraw()` flow, have an expected value share price for deposits, and a realized value share price for redemptions. The expected value calculation has been simplified from v1 to use all pending returns, instead of calculating the more complicated proration of pending returns. Using separate share prices for deposits and redemptions prevents users from gaming interest from loans, while still allowing for capital flexibility without the use of lock-ups or epochs.

The main difference with depositing in v2 is that there is now a loan limit attached to the deposit operation, and deposit positions are distinct entities. A user may have several deposit positions associated with different loan limits. Due to the tick spacing rule described above, deposits to new ticks must be sufficiently spaced, or otherwise must snap to the closest tick. As a consequence of distinct deposit positions and to improve gas efficiency, fungible LP tokens have been removed from v2.

### Dynamic Interest Rates

The interest rate quoted for a loan is determined dynamically, based on the current utilization of the Pool. Each Pool has a overall interest rate that is driven up or down over time by a proportional controller, depending on how close the Pool is to operating at a utilization target (e.g. 80%). If the Pool is underutilized, the overall interest rate decays with time. If the Pool is overutilized, the overall interest rate grows with time. If the Pool is within a hysteresis threshold of the utilization target, e.g. +/-5% of 80%, the overall interest rate remains unchanged.

More aggressive ticks used in the funding of a loan receive greater interest, in exchange for insuring the less aggressive ticks. In the initial implementation, ticks will receive a distribution of the interest following a negative exponential model, where the more aggressive (riskier) ticks receive a larger proportion of the the interest. This model follows the form `B^(-n)/C`, where `B` and `C` are constants for the exponential base and normalization factor, respectively, and `n` is the tick index. `C` is used to normalize the expression such that the allocation approaches one when summed across many ticks.

For example, with an exponential base of 1.8, the interest will be distributed to the first 9 ticks as shown below. The final tick receives the leftover interest to ensure the interest is fully distributed.

```
>>> [1.8**(-x)/1.25 for x in range(1, 10)]
[0.4444444444444445, 0.24691358024691357, 0.1371742112482853, 0.07620789513793629, 0.04233771952107571, 0.023520955289486507, 0.01306719738304806, 0.007259554101693366, 0.00403308561205187]
>>>
```

This interest rate model is a starting point and will be refined over time. The interest rate model is a modular component in the v2 design, allowing for the use of different interest rate models -- even user-defined ones -- for different Pools.

### Offchain Loan Metadata

The most expensive operation in the v1 Vault is `sellNote()`, which can make note arbitrage financially impractical and loan origination too expensive. Much of the cost comes from storing a copy of all the loan state onchain, including metadata like the collateral token, collateral token ID, purchase price, repayment, duration, etc. One benefit of this is that the v1 Vault can use an automated service like Chainlink Automation (formerly Keepers) to update Vault accounting on events like loan repayment, expiration, or liquidation, without requiring any external input data. In practice, this advantage is outweighed by the greater costs of storing all the loan metadata onchain, which impairs the Vault from performing its primary purpose of purchasing debt.

In the v2 Pool design, all metadata associated with the loan is stored trustlessly offchain, while only a status enum and metadata hash are stored onchain, which can both fit into a single 256-bit slot. When a loan is purchased, the associated metadata is emitted in an event. When a loan is repaid or expired, this original metadata is presented in the calldata for the loan service handler, e.g. `onLoanRepaid()` or `onLoanExpired()`, and verified against the hash onchain.

This design leads to substantial gas savings, and enables low cost storage of future metadata or other accounting details. The loan metadata can be retrieved from event logs -- or, more realistically, a subgraph. In the short term, Chainlink Automation won't be usable for Pool accounting automation and a custom solution will be required, but it's likely there will be an onchain automation service in the near future with more flexible triggers and input data.

## State

**General Notes**

Prices and amounts are stored as fixed-point integers in `uint128`. Timestamps are stored as seconds since UNIX epoch in `uint64`. Loan IDs are `uint256`.

**LiquidityNode State (Onchain, 4 slots per node)**

```
    1   uint128 value
    1   uint128 shares
    2   uint128 available
    2   uint128 pending
    3   uint128 redemptionPending
    3   uint128 redemptionIndex
    4   uint128 prev
    4   uint128 next
```

Liquidity is stored as a doubly-linked list, ordered by loan limit. `prev` and `next` are pointers to the previous and next liquidity nodes in the list.

**Deposit State (Onchain, 2 slots per deposit)**

```
    1   uint128 shares
    1   uint128 redemptionPending
    2   uint128 redemptionIndex
    2   uint128 redemptionTarget
```

**Loan State (Onchain, 1 slot per loan)**

```
    1 uint8 status (Uninitialized, Active, Repaid, Liquidated)
    1 bytes31 receiptHash
```

**LoanReceipt State (Offchain, tightly packed, 141 + 48 x N bytes per loan)**

```
    1   uint8   version
    20  address platform
    32  uint256 loanId
    20  address borrower
    8   uint64  maturity
    8   uint64  duration
    20  address collateralToken
    32  uint256 collateralTokenId
    N   LiquiditySource[] liquidityTrail
        16  uint128 depth
        16  uint128 used
        16  uint128 pending
```

**Top-level Mappings**

```
    mapping (uint128 depth => LiquidityNode)    _liquidity
    mapping (address account =>
        mapping(uint256 depth => Deposit))      _deposits
    mapping (uint256 loanId => Loan)            _loans
```

**Top-level Counters**

```
    uint256 _loanId
```

**Peripheral Contracts**

```
   ICollateralFilter                                _collateralFilter
   IInterestRateModel                               _interestRateModel
   ICollateralLiquidator                            _collateralLiquidator
   mapping (address noteToken => INoteAdapter)      _noteAdapters
   mapping (address lendPlatform => ILendAdapter)   _lendAdapters
```

## API

##### Basic Getters

```
# Get currency token
currencyToken() returns (address)
```

```
# Get max loan duration
maxLoanDuration() returns (uint64)
```

```
# Get collateral filter
collateralFilter() returns (ICollateralFilter)
```

```
# Get interest rate model
interestRateModel() returns (IInterestRateModel)
```

```
# Get collateral liquidator
collateralLiquidator() returns (ICollateralLiquidator)
```

```
# Get note adapter
noteAdapters(address noteToken) returns (INoteAdapter)
```

```
# Get supported note tokens
supportedNoteTokens() returns (address[] memory)
```

```
# Get lend adapter
lendAdapters(address lendPlatform) returns (ILendAdapter)
```

```
# Get supported lend platforms
supportedLendPlatforms() returns (address[] memory)
```

##### Liquidity API

```
# Return current utilization
utilization() returns (uint256)
```

```
# Return liquidity available at depth
liquidityAvailable(uint256 depth) returns (uint256)
```

```
# Return liquidity nodes at beginDepth <= price <= endDepth
liquidityNodes(uint256 beginDepth, uint256 endDepth) return (LiquidityNodeInfo[] memory)
```

##### Loan API

```
# Price a loan
priceLoan(address lendPlatform, uint256 principal, uint64 duration, address collateralToken, uint256 collateralTokenId, bytes[] calldata collateralTokenIdSpec) returns (uint256 repayment)
```

```
# Originate a loan
originateLoan(address lendPlatform, uint256 principal, uint64 duration, address collateralToken, uint256 collateralTokenId, uint256 maxRepayment, bytes[] calldata collateralTokenIdSpec) returns (uint256 loanId)
```

```
# Price a note
priceNote(address noteToken, uint256 noteTokenId, bytes[] calldata collateralTokenIdSpec) returns (uint256 purchasePrice)
```

```
# Sell a note
sellNote(address noteToken, uint256 noteTokenId, uint256 minPurchasePrice, bytes[] calldata collateralTokenIdSpec) returns (uint256 purchasePrice)
```

```
# Loan repaid handler
onLoanRepaid(bytes calldata loanReceipt)
```

```
# Loan expired handler
onLoanExpired(bytes calldata loanReceipt)
```

```
# Collateral liquidated handler
onCollateralLiquidated(bytes calldata loanReceipt, uint256 proceeds)
```

##### Depositor API

```
# Deposit amount at loan limit depth
deposit(uint256 depth, uint256 amount)
```

```
# Redeem a deposit
redeem(uint256 depth, uint256 shares)
```

```
# Get redemption available
redemptionAvailable(uint256 depth) returns (uint256 shares, uint256 amount)
```

```
# Withdraw a redemption
withdraw(uint256 depth) returns (uint256 amount)
```

## Outstanding Issues

* The liquidation procedure is assumed to be the same as in v1, but v2 will feature a more modular design and may possibly implement a hosted Dutch auction.

* The fixed tick spacing for deposit loan limits is not ideal for competing deposits close to the maximum LTV, where market conditions may warrant adjustments finer than 25%. This can be addressed by modifying the tick spacing rule to allow for some compression at higher loan limits, but requires the smart contract to know how close a loan limit is to the maximum LTV.

* The mechanism for token ID whitelisting is currently unspecified. There are a number of different compact approaches: merkle trees, bloom filters, simple bitmasks for smaller collections, or even a user-defined function. This will be implemented in a modular way to allow for future flexibility.

## Design Alternatives

Pool accounting can be implemented in a number of different ways. The approach described here uses share-based accounting similar to that of v1, which automatically compounds by design -- interest from loans is returned to the tick after repayment and can be reused in new loans. Some other choices include:

* Using native currency for all accounting, i.e. no shares or share pricing
* Storing accrued interest from loans separately from the capital
    * No automatic compounding
    * User has an API to withdraw interest earned or redeploy it
* Allowing more sophisticated accounting by requiring the user to synchronize their position with each processed loan
    * User would call `update()` on their position with a batch of all loans that have completed, possibly multiple times
    * Allows for accounting to be done on each position for each loan
    * More active and gas intensive to maintain a position

These design choices can enable some interesting design directions, but introduce more difficulties with handling withdrawals during active loans compared to the share-based accounting approach.
