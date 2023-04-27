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
- [`test/`](contracts/test/) - Testing contracts
  - [`integrations/`](contracts/test/integrations/) - Third-Party Integrations Test Contracts
  - [`rates/`](contracts/test/rates/) - Test Wrappers for Interest Rate Models
  - [`filters/`](contracts/test/filters/) - Test Wrappers for Collateral Filters
  - [`tokens/`](contracts/test/tokens/) - Test Tokens
    - [`TestERC20.sol`](contracts/test/tokens/TestERC20.sol) - Test ERC20
    - [`TestERC721.sol`](contracts/test/tokens/TestERC721.sol) - Test ERC721
  - [`TestTick.sol`](contracts/test/TestTick.sol) - Test Wrapper for Tick library
  - [`TestLoanReceipt.sol`](contracts/test/TestLoanReceipt.sol) - Test Wrapper for Loan Receipt library
  - [`TestLiquidityManager.sol`](contracts/test/TestLiquidityManager.sol) - Test Wrapper for Liquidity Manager library
  - [`TestCollateralLiquidatorJig.sol`](contracts/test/TestCollateralLiquidatorJig.sol) - Test Wrapper for Collateral Liquidators
  - [`TestProxy.sol`](contracts/test/TestProxy.sol) - Test Proxy
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

MetaStreet v2 Contracts are primary BUSL-1.1 [licensed](LICENSE). Interfaces are MIT [licensed](contracts/interfaces/LICENSE).
