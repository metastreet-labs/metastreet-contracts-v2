# MetaStreet v2 Contracts

## Usage

Install:

```
npm install
```

Compile contracts:

```
npm run build
```

Run unit tests:

```
npm test
```

Start hardhat network:

```
npm run node
```

## Additional Targets

- Format contracts, tests, and scripts (prettier): `npm run format`
- Lint contracts, tests, and scripts (solhint + eslint): `npm run lint`
- Run static analyzer (slither, requires external installation): `npm run analyze`

## File Structure

- [`contracts/`](contracts/) - Smart Contracts
  - [`Pool.sol`](contracts/Pool.sol) - Pool base contract
  - [`PoolFactory.sol`](contracts/PoolFactory.sol) - Pool Factory
  - [`Tick.sol`](contracts/Tick.sol) - Tick library
  - [`LoanReceipt.sol`](contracts/LoanReceipt.sol) - Loan Receipt library
  - [`DepositLogic.sol`](contracts/DepositLogic.sol) - Deposit logic library
  - [`BorrowLogic.sol`](contracts/BorrowLogic.sol) - Borrow logic library
  - [`LiquidityLogic.sol`](contracts/LiquidityLogic.sol) - Liquidity logic library
  - [`interfaces/`](contracts/interfaces) - Interfaces
    - [`IPool.sol`](contracts/interfaces/IPool.sol) - Pool interface
    - [`ILiquidity.sol`](contracts/interfaces/ILiquidity.sol) - Liquidity interface
    - [`ICollateralWrapper.sol`](contracts/interfaces/ICollateralWrapper.sol) - Collateral Wrapper interface
    - [`ICollateralLiquidator.sol`](contracts/interfaces/ICollateralLiquidator.sol) - Collateral Liquidator interface
    - [`ICollateralLiquidationReceiver.sol`](contracts/interfaces/ICollateralLiquidationReceiver.sol) - Collateral Liquidation Receiver interface
    - [`IPoolFactory.sol`](contracts/interfaces/IPoolFactory.sol) - Pool Factory interface
  - [`configurations/`](contracts/configurations) - Pool Configurations
    - [`WeightedRateCollectionPool.sol`](contracts/configurations/WeightedRateCollectionPool.sol) - Weighted Rate Collection Pool
    - [`WeightedRateRangedCollectionPool.sol`](contracts/configurations/WeightedRateRangedCollectionPool.sol) - Weighted Rate Ranged Collection Pool
    - [`WeightedRateSetCollectionPool.sol`](contracts/configurations/WeightedRateSetCollectionPool.sol) - Weighted Rate Set Collection Pool
    - [`WeightedRateMerkleCollectionPool.sol`](contracts/configurations/WeightedRateMerkleCollectionPool.sol) - Weighted Rate Merkle Collection Pool
    - [`NoopPool.sol`](contracts/configurations/NoopPool.sol) - Noop Pool
  - [`wrappers/`](contracts/wrappers) - Collateral Wrappers
    - [`BundleCollateralWrapper.sol`](contracts/wrappers/BundleCollateralWrapper.sol) - Bundle Collateral Wrapper
    - [`ERC1155CollateralWrapper.sol`](contracts/wrappers/ERC1155CollateralWrapper.sol) - ERC155 Collateral Wrapper
    - [`PunkCollateralWrapper.sol`](contracts/wrappers/PunkCollateralWrapper.sol) - CryptoPunks Collateral Wrapper
    - [`KongzBundleCollateralWrapper.sol`](contracts/wrappers/KongzBundleCollateralWrapper.sol) - CyberKongz Bundle Collateral Wrapper
  - [`filters/`](contracts/filters) - Collateral Filters
    - [`CollateralFilter.sol`](contracts/filters/CollateralFilter.sol) - Collateral Filter abstract base contract
    - [`CollectionCollateralFilter.sol`](contracts/filters/CollectionCollateralFilter.sol) - Collection Collateral Filter
    - [`RangedCollectionCollateralFilter.sol`](contracts/filters/RangedCollectionCollateralFilter.sol) - Ranged Collection Collateral Filter
    - [`SetCollectionCollateralFilter.sol`](contracts/filters/SetCollectionCollateralFilter.sol) - Set Collection Collateral Filter
    - [`MerkleCollectionCollateralFilter.sol`](contracts/filters/MerkleCollectionCollateralFilter.sol) - Merkle Collection Collateral Filter
  - [`rates/`](contracts/rates) - Interest Rate Models
    - [`InterestRateModel.sol`](contracts/rates/InterestRateModel.sol) - Interest Rate Model abstract base contract
    - [`WeightedInterestRateModel.sol`](contracts/rates/WeightedInterestRateModel.sol) - Weighted Interest Rate Model
  - [`tokenization/`](contracts/tokenization) - Tokenization
    - [`DepositToken.sol`](contracts/tokenization/DepositToken.sol) - Deposit Token abstract base contract
    - [`ERC20DepositToken.sol`](contracts/tokenization/ERC20DepositToken.sol) - ERC20 Deposit Token contract
    - [`ERC20DepositTokenImplementation.sol`](contracts/tokenization/ERC20DepositTokenImplementation.sol) - ERC20 Deposit Token implementation contract
    - [`ERC20DepositTokenProxy.sol`](contracts/tokenization/ERC20DepositTokenProxy.sol) - ERC20 Deposit Token proxy contract
    - [`ERC20DepositTokenFactory.sol`](contracts/tokenization/ERC20DepositTokenFactory.sol) - ERC20 Deposit Token factory library contract
  - [`oracle/`](contracts/oracle) - Price Oracle Support
    - [`PriceOracle.sol`](contracts/oracle/PriceOracle.sol) - Price Oracle abstract base contract
    - [`ExternalPriceOracle.sol`](contracts/oracle/ExternalPriceOracle.sol) - External Price Oracle contract
    - [`SimpleSignedPriceOracle.sol`](contracts/oracle/SimpleSignedPriceOracle.sol) - (External) Simple Signed Price Oracle implementation contract
    - [`ReservoirPriceOracle.sol`](contracts/oracle/ReservoirPriceOracle.sol) - (External) Reservoir Price Oracle implementation contract
    - [`ChainlinkPriceOracle.sol`](contracts/oracle/ChainlinkPriceOracle.sol) - (External) Chainlink Price Oracle implementation contract
  - [`liquidators/`](contracts/liquidators) - Collateral Liquidators
    - [`EnglishAuctionCollateralLiquidator.sol`](contracts/liquidators/EnglishAuctionCollateralLiquidator.sol) - English Auction Collateral Liquidator
  - [`integrations/`](contracts/integrations) - Third-party Integrations
  - [`test/`](contracts/test/) - Testing Contracts
    - [`integrations/`](contracts/test/integrations/) - Third-Party Integrations
    - [`rates/`](contracts/test/rates/) - Test Wrappers for Interest Rate Models
    - [`filters/`](contracts/test/filters/) - Test Wrappers for Collateral Filters
    - [`tokens/`](contracts/test/tokens/) - Test Tokens
      - [`TestERC20.sol`](contracts/test/tokens/TestERC20.sol) - Test ERC20
      - [`TestERC721.sol`](contracts/test/tokens/TestERC721.sol) - Test ERC721
      - [`TestERC1155.sol`](contracts/test/tokens/TestERC1155.sol) - Test ERC71155
      - [`TestMaliciousERC20.sol`](contracts/test/tokens/TestMaliciousERC20.sol) - Test Malicious ERC20
    - [`TestTick.sol`](contracts/test/TestTick.sol) - Test Wrapper for Tick library
    - [`TestLoanReceipt.sol`](contracts/test/TestLoanReceipt.sol) - Test Wrapper for Loan Receipt library
    - [`TestLiquidityLogic.sol`](contracts/test/TestLiquidityLogic.sol) - Test Wrapper for Liquidity logic library
    - [`TestCollateralLiquidatorJig.sol`](contracts/test/TestCollateralLiquidatorJig.sol) - Test Jig for Collateral Liquidators
    - [`TestCollateralLiquidatorJigTruncated.sol`](contracts/test/TestCollateralLiquidatorJigTruncated.sol) - Truncated Test Jig for Collateral Liquidators
    - [`TestProxy.sol`](contracts/test/TestProxy.sol) - Test Proxy
    - [`ExternalCollateralLiquidator.sol`](contracts/test/ExternalCollateralLiquidator.sol) - External Collateral Liquidator
- [`test/`](test/) - Unit tests
  - [`rates/`](test/rates/) - Interest Rate Model tests
    - [`WeightedInterestRateModel.spec.ts`](test/rates/WeightedInterestRateModel.spec.ts) - Weighted Interest Rate Model unit test
  - [`filters/`](test/filters/) - Collateral Filter tests
    - [`CollectionCollateralFilter.spec.ts`](test/filters/CollectionCollateralFilter.spec.ts) - Collection Collateral Filter unit test
    - [`RangedCollectionCollateralFilter.spec.ts`](test/filters/RangedCollectionCollateralFilter.spec.ts) - Ranged Collection Collateral Filter unit test
    - [`SetCollectionCollateralFilter.spec.ts`](test/filters/SetCollectionCollateralFilter.spec.ts) - Set Collection Collateral Filter unit test
    - [`MerkleCollectionCollateralFilter.spec.ts`](test/filters/MerkleCollectionCollateralFilter.spec.ts) - Merkle Collection Collateral Filter unit test
  - [`wrappers/`](test/wrappers/) - Collateral Wrapper tests
    - [`BundleCollateralWrapper.spec.ts`](test/wrappers/BundleCollateralWrapper.spec.ts) - Bundle Collateral Wrapper unit test
    - [`ERC1155CollateralWrapper.spec.ts`](test/wrappers/ERC1155CollateralWrapper.spec.ts) - ERC1155 Collateral Wrapper unit test
  - [`liquidators/`](test/liquidators/) - Collateral Liquidators tests
    - [`ExternalCollateralLiquidator.spec.ts`](test/liquidators/ExternalCollateralLiquidator.spec.ts) - External Collateral Liquidator unit test
    - [`EnglishAuctionCollateralLiquidator.spec.ts`](test/liquidators/EnglishAuctionCollateralLiquidator.spec.ts) - English Auction Collateral Liquidator unit test
  - [`models/`](test/models/) - Integration test models
    - [`PoolModel.ts`](test/models/PoolModel.ts) - Pool model
  - [`helpers/`](test/helpers/) - Test helpers
    - [`Deploy.ts`](test/helpers/Deploy.ts) - Deploy with libraries helper
    - [`EventUtilities.ts`](test/helpers/EventUtilities.ts) - Event utilities
    - [`FixedPoint.ts`](test/helpers/FixedPoint.ts) - Fixed Point math utility class
    - [`Tick.ts`](test/helpers/Tick.ts) - Tick utility class
    - [`MerkleTree.ts`](test/helpers/MerkleTree.ts) - Merkle tree utility class
  - [`Tick.spec.ts`](test/Tick.spec.ts) - Tick unit test
  - [`LoanReceipt.spec.ts`](test/LoanReceipt.spec.ts) - Loan Receipt unit test
  - [`LiquidityLogic.spec.ts`](test/LiquidityLogic.spec.ts) - Liquidity logic unit test
  - [`PoolFactory.spec.ts`](test/PoolFactory.spec.ts) - Pool Factory unit test
  - [`Pool.basic.spec.ts`](test/Pool.basic.spec.ts) - Pool basic unit test
  - [`Pool.bundle.spec.ts`](test/Pool.bundle.spec.ts) - Pool bundle unit test
  - [`Pool.gas.spec.ts`](test/Pool.gas.spec.ts) - Pool gas unit test
  - [`Integration.spec.ts`](test/Integration.spec.ts) - Integration test
  - [`Storage.spec.ts`](test/Storage.spec.ts) - Storage layout test
- [`scripts/`](scripts/) - Scripts
  - [`deploy-simulation.ts`](scripts/deploy-simulation.ts) - Simulation deployment
  - [`deployment-manager.ts`](scripts/deployment-manager.ts) - Deployment manager
- [`deployments/`](deployments/) - Deployments
- [`docs/`](docs/) - Documentation
- [`hardhat.config.ts`](hardhat.config.ts) - Hardhat configuration
- [`tsconfig.json`](tsconfig.json) - TypeScript configuration
- [`package.json`](package.json) - npm package metadata
- [`package-lock.json`](package-lock.json) - npm package lock
- [`README.md`](README.md) - This README

## License

MetaStreet v2 Contracts are primarily BUSL-1.1 [licensed](LICENSE). Interfaces are MIT [licensed](contracts/interfaces/LICENSE).
