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

Run Slither:

```
python3 -m venv venv && source venv/bin/activate
pip3 install slither-analyzer
slither .
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
  - [`LiquidityManager.sol`](contracts/LiquidityManager.sol) - Liquidity Manager library
  - [`LoanReceipt.sol`](contracts/LoanReceipt.sol) - Loan Receipt library
  - [`CollateralFilter.sol`](contracts/CollateralFilter.sol) - Collateral Filter abstract base contract
  - [`InterestRateModel.sol`](contracts/InterestRateModel.sol) - Interest Rate Model abstract base contract
  - [`interfaces/`](contracts/interfaces) - Interfaces
    - [`IPool.sol`](contracts/interfaces/IPool.sol) - Pool interface
    - [`ILiquidity.sol`](contracts/interfaces/ILiquidity.sol) - Liquidity interface
    - [`ICollateralWrapper.sol`](contracts/interfaces/ICollateralWrapper.sol) - Collateral Wrapper interface
    - [`ICollateralLiquidator.sol`](contracts/interfaces/ICollateralLiquidator.sol) - Collateral Liquidator interface
    - [`ICollateralLiquidationReceiver.sol`](contracts/interfaces/ICollateralLiquidationReceiver.sol) - Collateral Liquidation Receiver interface
    - [`IPoolFactory.sol`](contracts/interfaces/IPoolFactory.sol) - Pool Factory interface
  - [`configurations/`](contracts/configurations) - Pool Configurations
    - [`WeightedRateCollectionPool.sol`](contracts/configurations/WeightedRateCollectionPool.sol) - Weighted Rate Collection Pool
  - [`wrappers/`](contracts/wrappers) - Collateral Wrappers
    - [`BundleCollateralWrapper.sol`](contracts/wrappers/BundleCollateralWrapper.sol) - Bundle Collateral Wrapper
  - [`filters/`](contracts/filters) - Collateral Filters
    - [`CollectionCollateralFilter.sol`](contracts/filters/CollectionCollateralFilter.sol) - Collection Collateral Filter
  - [`rates/`](contracts/rates) - Interest Rate Models
    - [`WeightedInterestRateModel.sol`](contracts/rates/WeightedInterestRateModel.sol) - Weighted Interest Rate Model
  - [`liquidators/`](contracts/liquidators) - Collateral Liquidators
    - [`ExternalCollateralLiquidator.sol`](contracts/liquidators/ExternalCollateralLiquidator.sol) - External Collateral Liquidator
    - [`EnglishAuctionCollateralLiquidator.sol`](contracts/liquidators/EnglishAuctionCollateralLiquidator.sol) - English Auction Collateral Liquidator
  - [`integrations/`](contracts/integrations) - Third-party Integrations
  - [`test/`](contracts/test/) - Testing Contracts
    - [`integrations/`](contracts/test/integrations/) - Third-Party Integrations
    - [`rates/`](contracts/test/rates/) - Test Wrappers for Interest Rate Models
    - [`filters/`](contracts/test/filters/) - Test Wrappers for Collateral Filters
    - [`tokens/`](contracts/test/tokens/) - Test Tokens
      - [`TestERC20.sol`](contracts/test/tokens/TestERC20.sol) - Test ERC20
      - [`TestERC721.sol`](contracts/test/tokens/TestERC721.sol) - Test ERC721
    - [`TestTick.sol`](contracts/test/TestTick.sol) - Test Wrapper for Tick library
    - [`TestLoanReceipt.sol`](contracts/test/TestLoanReceipt.sol) - Test Wrapper for Loan Receipt library
    - [`TestLiquidityManager.sol`](contracts/test/TestLiquidityManager.sol) - Test Wrapper for Liquidity Manager library
    - [`TestCollateralLiquidatorJig.sol`](contracts/test/TestCollateralLiquidatorJig.sol) - Test Jig for Collateral Liquidators
    - [`TestProxy.sol`](contracts/test/TestProxy.sol) - Test Proxy
- [`test/`](test/) - Unit tests
  - [`rates/`](test/rates/) - Interest Rate Model tests
    - [`WeightedInterestRateModel.spec.ts`](test/rates/WeightedInterestRateModel.spec.ts) - Weighted Interest Rate Model unit test
  - [`wrappers/`](test/wrappers/) - Collateral Wrapper tests
    - [`BundleCollateralWrapper.spec.ts`](test/wrappers/BundleCollateralWrapper.spec.ts) - Bundle Collateral Wrapper unit test
  - [`filters/`](test/filters/) - Collateral Filter tests
    - [`CollectionCollateralFilter.spec.ts`](test/filters/CollectionCollateralFilter.spec.ts) - Collection Collateral Filter unit test
  - [`liquidators/`](test/liquidators/) - Collateral Liquidators tests
    - [`ExternalCollateralLiquidator.spec.ts`](test/liquidators/ExternalCollateralLiquidator.spec.ts) - External Collateral Liquidator unit test
    - [`EnglishAuctionCollateralLiquidator.spec.ts`](test/liquidators/EnglishAuctionCollateralLiquidator.spec.ts) - English Auction Collateral Liquidator unit test
  - [`models/`](test/models/) - Integration test models
    - [`PoolModel.ts`](test/models/PoolModel.ts) - Pool model
  - [`helpers/`](test/helpers/) - Test helpers
    - [`EventUtilities.ts`](test/helpers/EventUtilities.ts) - Event utilities
    - [`FixedPoint.ts`](test/helpers/FixedPoint.ts) - Fixed Point math utility class
    - [`Tick.ts`](test/helpers/Tick.ts) - Tick utility class
  - [`Tick.spec.ts`](test/Tick.spec.ts) - Tick unit test
  - [`LoanReceipt.spec.ts`](test/LoanReceipt.spec.ts) - Loan Receipt unit test
  - [`LiquidityManager.spec.ts`](test/LiquidityManager.spec.ts) - Liquidity Manager unit test
  - [`PoolFactory.spec.ts`](test/PoolFactory.spec.ts) - Pool Factory unit test
  - [`Pool.basic.spec.ts`](test/Pool.basic.spec.ts) - Pool basic unit test
  - [`Pool.bundle.spec.ts`](test/Pool.bundle.spec.ts) - Pool bundle unit test
  - [`Pool.gas.spec.ts`](test/Pool.gas.spec.ts) - Pool gas unit test
  - [`Integration.spec.ts`](test/Integration.spec.ts) - Integration test
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
