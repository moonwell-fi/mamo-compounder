# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

### Development

```bash
# Install dependencies
npm install

# Run the development server
npm run dev

# Build the TypeScript code
npm run build

# Start the production server
npm run start
```

### Testing

```bash
# Run tests (using Vitest)
npx vitest run

# Run tests in watch mode
npx vitest
```

## Environment Variables

The application requires the following environment variables:

- `PORT` - The port to run the server on (default: 3000)
- `BASE_RPC_URL` - The RPC URL for the Base network
- `PRIVATE_KEY` - The private key for the wallet that will execute transactions
- `MIN_USD_VALUE_THRESHOLD` - The minimum USD value threshold for processing rewards
- `DATABASE_URL` - PostgreSQL connection string

## Architecture Overview

The MAMO Compounder is a server-based application that handles the compounding of rewards for MAMO strategies on the Base blockchain network. It runs as a long-lived server process with internal scheduling for periodic tasks.

### Core Components

1. **Express Server**: Runs on configured port and provides HTTP endpoints for health checks and status.

2. **Task Scheduler**: Manages the execution of periodic tasks (defined in `src/index.ts`).

3. **Periodic Tasks**:
   - `processRewards`: Compounds rewards for strategies by claiming rewards and swapping tokens
   - `optimizeStrategyPositions`: Updates strategy positions based on APY comparison between market and vault 
   - `processIdleStrategies`: Calls `depositIdleTokens` on strategies with idle funds

4. **Database**: PostgreSQL database used to store and track strategy positions and their optimal allocations.

### Key Files

- `src/index.ts`: Main entry point, defines periodic tasks and Express server
- `src/constants.ts`: Contains contract addresses, ABIs, and other constants
- `src/utils/strategy-compounder.ts`: Core logic for compounding strategy rewards
- `src/utils/strategy-optimizer.ts`: Logic for optimizing strategy positions
- `src/utils/database.ts`: Database interaction functions
- `src/utils/cow-swap.ts`: Functions for interacting with CoW Swap for token swaps
- `src/utils/generate-appdata.ts`: Helper functions for generating CoW Swap app data

### Data Flow

1. The application fetches strategies from the MAMO Indexer API
2. For each strategy, it:
   - Fetches rewards from the Moonwell View contract
   - Claims rewards if they exceed the configured threshold
   - Creates and submits swap orders to CoW Swap
   - Optimizes strategy positions based on APY comparison
   - Updates the database with position information

### Integration Points

- **MAMO Indexer API**: Used to fetch strategies and their balances
- **Moonwell Contracts**: Used to claim rewards and check APYs
- **CoW Swap**: Used for token swaps with optimal execution
- **PostgreSQL Database**: Used to store strategy positions and APY information

## Workflow Tips

1. Always check the logs for transaction hashes and result messages
2. The `/status` endpoint provides information about registered tasks
3. The `/health` endpoint can be used to check server health
4. When developing, use `npm run dev` for hot reloading
5. When updating strategy positions, ensure the environment variables are properly set

## Deployment

The application can be deployed using:

1. **Railway**: Uses the `railway.json` configuration and `Dockerfile`
2. **Docker**: Run the container with the appropriate environment variables
3. **Direct NodeJS**: Use `npm run build` and then `npm run start`