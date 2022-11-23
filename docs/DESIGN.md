# Vault v2 Design Document

## Goals

The main goals of MetaStreet Vault v2 is to improve on three shortcomings of v1:

* **Oracleless**: Remove the dependency on a centralized price oracle for loan to value limits
* **Dynamic Rates**: Replace a fixed, governance-driven interest rate model with a dynamic, automated one
* **Permissionless**: Allow users to instantiate a debt purchasing Vault for any collection permissionlessly

In addition, v2 includes some implementation subgoals:

* **Improved Gas Efficiency**: Reduce the cost of all operations, especially `sellNote()`, to under 200k gas
* **Lending Platform Integration**: Add support for integrating directly with lending platforms to originate loans (i.e. no promissory note required)
* **Token ID Whitelisting**: Add support for whitelisting arbitrary token IDs within a collection for loan collateral (e.g. for rare collections)

## Design

The external API of MetaStreet Vault v2 is intended to be very similar to that of v1, with a few parameter changes. However, the internal architecture has been redesigned to achieve the design goals above. The subsections below summarize the major design changes.

### Fixed Duration Loans

For simplified accounting, v2 will use a fixed duration for all loans (e.g. 30 days), which is specified at Vault instantiation time. Different Vaults may provide different loan durations for the same collections.

### Liquidity Management

MetaStreet Vault v1 managed liquidity across two tranches: the senior tranche and the junior tranche. Any loan purchased by the Vault used liquidity from both tranches, proportional to their sizes. The senior tranche received a fixed rate of interest, while the junior tranche received the remaining interest from the loan, in exchange for insuring the senior tranche.

v2 replaces the concept of tranches with "loan limit ticks", which are like tranches at arbitrary loan limits. Capital from a tick can only be used for the principal (or purchase price) of a loan up to its loan limit. For example, if there is a 5 ETH tick with 100 ETH of deposits, capital drawn from that tick can only be used to fund the 0-5 ETH portion of a loan, or an intermediate portion, like 2-5 ETH.

When a v2 Vault funds (or buys) a loan, it sources the capital from multiple, subsequent ticks up to the principal (or purchase price) of the loan. As an example, a v2 Vault might use five ticks at limits 10, 20, 30, 45, 60 ETH to fill a loan from 0-10, 10-20, 20-25, 25-40, 40-50 ETH. More aggressive ticks receive greater a interest rate on their capital, in exchange for insuring less aggressive ticks against default.

Enabling depositors to attach an arbitrary loan limit to their capital is what allows the v2 design to eliminate a price oracle and LTV-based parameters. Now, the maximum LTV supported by a Vault is simply the capital available up to the highest loan limit. This approach also gives depositors more flexibility with the risk they would like to take, instead of being limited to two tranches and slow, governance-driven LTV limits. However, it also requires more active position management by depositors at the higher loan limits.

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

The first set might appear for a 50 ETH floor price collateral, while the second for a 0.50 ETH floor price collateral. Note that the ticks may not necessarily fall on the boundaries above. All that is required is that a newly deposited tick is **at least** 25% away an adjacent tick, to keep the liquidity aggregated in a discrete number of ticks. On an L2, the tick spacing can be further reduced to allow for finer granularity and many more ticks.

Depositing into a loan limit tick in v2 is similar to depositing to a tranche in v1. Both use share-based accounting with a `deposit()`, `redeem()`, and `withdraw()` flow, have an expected value share price for deposits, and a realized value share price for redemptions. The expected value calculation has been simplified from v1 to use all pending returns, instead of calculating the more complicated proration of pending returns. The separate share prices still prevent users from gaming interest from loans, while allowing for capital flexibility without lock ups or epochs.

The main difference with depositing in v2 is that there is now a loan limit attached to the deposit operation, and deposit positions are distinct entities. A user may have several deposit positions associated with different loan limits. Due to the tick spacing rule described above, deposits to new ticks must be sufficiently spaced, or otherwise must snap to the closest tick.

### Dynamic Interest Rates

More aggressive ticks used in the funding of a loan receive higher interest rates, in exchange for insuring the less aggressive ticks. The actual interest rates assigned to ticks follows a dynamic interest rate model, based on the overall utilization of the Vault. Each Vault has a "base interest rate" that is driven up or down over time by a proportional controller, depending on how close the Vault is to achieving a utilization target (e.g. 80%). If the Vault is underutilized, the base interest rate decays. If the Vault is overutilized, the base interest rate grows. If the Vault is within a hysteresis threshold of the utilization target, e.g. +/-10% of 80%, the base interest rate remains unchanged.

In the preliminary implementation, the first tick will receive the base interest rate, while subsequent ticks will receive a fixed multiplier of the base interest rate. For example, if the dynamic base interest rate is 0.5%, and the tick multiplier is 1.5x, then the interest rates for 10 ticks are:

```
>>> [0.5*1.5**x for x in range(10)]
[0.5, 0.75, 1.125, 1.6875, 2.53125, 3.796875, 5.6953125, 8.54296875, 12.814453125, 19.2216796875]
>>>
```

This interest rate model is a starting point and will likely be refined over time. The interest rate model will be a modular component in the v2 design, so there is the possibility for allowing the use of different interest rate models -- potentially even user-defined ones -- for different Vaults.

### Offchain Loan Metadata

The most expensive operation in the v1 Vault is `sellNote()`, which can make note arbitrage financially impractical and loan origination too expensive. Much of the cost comes from storing a copy of all the loan state onchain, including metadata like the collateral token, collateral token ID, purchase price, repayment, duration, etc. One benefit of this is that the v1 Vault can use an automated service like Chainlink Automation (formerly Keepers) to update Vault accounting on events like loan repayment, expiration, or liquidation, without requiring any external input data. In practice, this advantage is outweighed by the greater costs of storing all the loan metadata onchain, which impairs the Vault from performing its primary purpose of purchasing debt.

In the v2 Vault design, all metadata associated with the loan is stored trustlessly offchain, while only a status enum and metadata hash are stored onchain, which can both fit into a single 256-bit slot. When a loan is purchased, the associated metadata is emitted in an event. When a loan is repaid or expired, this original metadata is presented in the calldata for the loan service handler, e.g. `onLoanRepaid()` or `onLoanExpired()`, and verified against the hash onchain.

This leads to substantial gas savings, and enables low cost storage of additional metadata or other accounting details. The loan metadata can be retrieved from event logs -- or, more realistically, a subgraph. In the short term, Chainlink Automation won't be usable for Vault accounting automation and a custom solution will be required, but it's likely there will be an onchain automation service in the near future with more flexible triggers and input data.

## State

**General Notes**

Prices and amounts are stored as `uint128`. Timestamps are stored as `uint64`.

**LiquidityNode State (Onchain, 4 slots per node)**

```
    1   uint128 amount
    1   uint128 shares
    2   uint128 available
    2   uint128 pending
    3   uint128 redemptionPending
    3   uint128 redemptionProcessed
    4   uint128 prev
    4   uint128 next
```

Liquidity is stored as a doubly-linked list, ordered by loan limit. `prev` and `next` are pointers to the previous and next liquidity nodes in the list.

**Deposit State (Onchain, 3 slots per deposit)**

```
    1   address owner
    1   uint96  reserved
    2   uint128 depth
    2   uint128 shares
    3   uint128 redemptionTarget
    3   uint128 redemptionAmount
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
    8   uint64  timestamp
    8   uint64  duration
    20  address collateralToken
    32  uint256 collateralTokenId
    N   LiquiditySource[] liquidityTrail
        16  uint128 depth
        16  uint128 amount
        16  uint128 pending
```

**Top-level Mappings**

```
    mapping (uint128 price => LiquidityNode)    _liquidity
    mapping (uint64 depositId => Deposit)       _deposits
    mapping (uint64 loanId => Loan)             _loans
```

**Top-level Counters**

```
    uint256 _depositId
    uint256 _loanId
```

**Peripheral Contracts**

```
   mapping (address noteToken => INoteAdapter)  _noteAdapters
   IInterestRateModel                           _interestRateModel
   ILiquidationStrategy                         _liquidationStrategy
```

## API

##### Basic Getters

```
# Get currency token
currencyToken() returns (address)
```

```
# Get max loan duration
maxLoanDuration() returns (uint256 duration)
```

```
# Get collateral token
collateralToken() returns (address)
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
# Get liquidation strategy
liquidationStrategy() returns (ILiquidationStrategy)
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
# Return current liquidity utilization
utilization() returns (uint256)
```

```
# Return cumulative liquidity up to and including depth
liquidityAmountAtDepth(uint256 depth) returns (uint256 amount)
```

```
# Return first liquidity node at price >= depth
liquidityNodeAtDepth(uint256 depth) returns (LiquidityNode memory)
```

```
# Return liquidity nodes at beginDepth <= price <= endDepth
liquidityNodes(uint256 beginDepth, uint256 endDepth) return (LiquidityNode[] memory)
```

##### Loan API

```
# Price a loan
priceLoan(uint256 principal, uint256 duration, address collateralToken, uint256 collateralTokenId, bytes calldata collateralTokenIdSpec) returns (uint256 repayment)
```

```
# Create a loan
createLoan(uint256 principal, uint256 duration, address collateralToken, uint256 collateralTokenId, uint256 maxRepayment, bytes calldata collateralTokenIdSpec) returns (uint256 loanId)
```

```
# Price a note
priceNote(address noteToken, uint256 noteTokenId, bytes calldata collateralTokenIdSpec) returns (uint256 purchasePrice)
```

```
# Sell a note
sellNote(address noteToken, uint256 noteTokenId, uint256 minPurchasePrice, bytes calldata collateralTokenIdSpec) returns (uint256 purchasePrice)
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
onCollateralLiquidated(bytes calldata loanReceipt)
```

##### Depositor API

```
# Deposit amount at loan limit depth
deposit(uint256 depth, uint256 amount) returns (uint256 depositId)
```

```
# Redeem a deposit
redeem(uint256 depositId, uint256 shares) returns (uint256 amount)
```

```
# Get withdrawal available
withdrawalAvailable(uint256 depositId) returns (uint256 amount)
```

```
# Withdraw a deposit
withdraw(uint256 depositId, uint256 maxAmount) returns (uint256 amount)
```

## Outstanding Issues

* The liquidation procedure is assumed to be the same as in v1, but v2 may feature a more modular design and may possibly implement a hosted Dutch auction.

* The fixed tick spacing for deposit loan limits is not ideal for competing deposits close to the maximum LTV, where market conditions may warrant adjustments finer than 25%. This can be addressed by modifying the tick spacing rule to allow for some compression at higher loan limits, but requires the smart contract to know whether a loan limit is near the maximum LTV.

* The mechanism for token ID whitelisting is currently unspecified. There are a number of different compact approaches: merkle trees, bloom filters, simple bitmasks for smaller collections, or even a user-defined function. This may be implemented in a modular way to allow for some future flexibility.

## Design Alternatives

Vault accounting can be implemented in a number of different ways. The approach described here uses share-based accounting similar to that of v1, which automatically compounds by design -- interest from loans is returned to the tick after repayment and can be reused in new loans. Some other choices include:

* Using native currency for all accounting, i.e. no shares or share pricing
* Storing accrued interest from loans separately from the capital
    * No automatic compounding
    * User has an API to withdraw interest earned or redeploy it
* Allowing more sophisticated accounting by requiring the user to synchronize their position with each processed loan
    * User would call `update()` on their position with a batch of all loans that have completed, possibly multiple times
    * Allows for accounting to be done on each position for each loan
    * More active and gas intensive to maintain a position

These design choices can enable some interesting design directions, but introduce more difficulties with handling withdrawals during active loans compared to the share-based accounting approach.
