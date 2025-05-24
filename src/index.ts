import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';

import { compoundStrategies } from './utils/strategy-compounder';
import { initializeDatabase } from './utils/database';
import { getAPYData, processStrategyOptimization } from './utils/strategy-optimizer';
import { MAMO_INDEXER_API, STRATEGY_ABI } from './constants';

// Define interfaces
interface Strategy {
	logIndex: number;
	blockNumber: string;
	txHash: string;
	user: string;
	strategy: string;
	implementation: string;
}

interface StrategiesResponse {
	strategies: Strategy[];
	nextCursor: string | null;
}

interface IdleStrategiesResponse {
	strategies: string[];
	nextCursor: string | null;
}

interface PeriodicTask {
	interval: number;
	fn: () => Promise<void>;
	prefix: string;
	lastRun?: Date;
	running?: boolean;
}

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Store for periodic tasks
const tasks: Record<string, PeriodicTask> = {};

/**
 * Ensure a value is a string
 */
function ensureString(value: any, message: string | undefined = undefined): string {
	if (!value) {
		throw new Error(message || 'Value is undefined');
	}
	return value;
}

/**
 * Register a periodic task to run at specified intervals
 */
function periodic(options: PeriodicTask): void {
	const { interval, fn, prefix } = options;
	const id = crypto.randomUUID();

	tasks[id] = {
		interval,
		fn,
		prefix,
		lastRun: undefined,
		running: false,
	};

	console.log(`${prefix} Task registered with interval ${interval}ms`);
}

/**
 * Task scheduler that checks and runs periodic tasks
 */
async function taskScheduler(): Promise<void> {
	for (const [id, task] of Object.entries(tasks)) {
		const now = new Date();

		// Skip if task is currently running
		if (task.running) {
			continue;
		}

		// Run if it's the first time or if the interval has elapsed
		if (!task.lastRun || now.getTime() - task.lastRun.getTime() >= task.interval) {
			task.running = true;
			task.lastRun = now;

			console.log(`${task.prefix} Starting task execution at ${now.toISOString()}`);

			try {
				await task.fn();
				console.log(`${task.prefix} Task completed successfully at ${new Date().toISOString()}`);
			} catch (error) {
				console.error(`${task.prefix} Task failed:`, error);
			} finally {
				task.running = false;
			}
		}
	}

	// Schedule next check
	setTimeout(taskScheduler, 1000);
}

/**
 * Main function to run the rewards processing job
 */
async function processRewards(): Promise<void> {
	console.log('==========================================================');
	console.log('🕒 MAMO COMPOUNDER REWARDS PROCESSING STARTED 🕒');
	console.log(`⏰ Start time: ${new Date().toISOString()}`);
	console.log('==========================================================');

	try {
		// Get environment variables
		const baseRpcUrl = ensureString(process.env.BASE_RPC_URL, 'BASE_RPC_URL environment variable is required');
		const privateKey = ensureString(process.env.PRIVATE_KEY, 'PRIVATE_KEY environment variable is required');
		const minUsdValueThreshold = ensureString(
			process.env.MIN_USD_VALUE_THRESHOLD,
			'MIN_USD_VALUE_THRESHOLD environment variable is required'
		);

		// Initialize variables for pagination
		let nextCursor: string | null = null;
		let totalProcessedStrategies = 0;

		// Process all pages of strategies
		do {
			// Construct the API URL with cursor if available
			const apiUrl = nextCursor ? `${MAMO_INDEXER_API}/strategies?cursor=${nextCursor}` : `${MAMO_INDEXER_API}/strategies`;

			console.log(`Fetching strategies from: ${apiUrl}`);
			const response = await fetch(apiUrl);

			if (!response.ok) {
				throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
			}

			const strategiesResponse = (await response.json()) as StrategiesResponse;
			console.log(`✅ Successfully fetched ${strategiesResponse.strategies.length} strategies`);

			// Process strategies in this page
			await compoundStrategies(strategiesResponse.strategies, baseRpcUrl, privateKey, {
				BASE_RPC_URL: baseRpcUrl,
				PRIVATE_KEY: privateKey,
				MIN_USD_VALUE_THRESHOLD: minUsdValueThreshold,
			});

			totalProcessedStrategies += strategiesResponse.strategies.length;

			// Update the cursor for the next page
			nextCursor = strategiesResponse.nextCursor;
		} while (nextCursor !== null); // Continue until there are no more pages

		console.log('==========================================================');
		console.log('✅ REWARDS PROCESSING COMPLETED SUCCESSFULLY ✅');
		console.log(`✅ Total strategies processed: ${totalProcessedStrategies}`);
		console.log('==========================================================');
	} catch (error) {
		console.error('❌ ERROR IN REWARDS PROCESSING:', error);
		console.error('==========================================================');
		// Don't exit the process, just log the error and continue
	}
}

/**
 * Function to optimize strategy positions based on APY comparison
 */
async function optimizeStrategyPositions(): Promise<void> {
	console.log('==========================================================');
	console.log('🔍 STRATEGY POSITION OPTIMIZATION STARTED 🔍');
	console.log(`⏰ Start time: ${new Date().toISOString()}`);
	console.log('==========================================================');

	try {
		// Get environment variables
		const baseRpcUrl = ensureString(process.env.BASE_RPC_URL, 'BASE_RPC_URL environment variable is required');
		const privateKey = ensureString(process.env.PRIVATE_KEY, 'PRIVATE_KEY environment variable is required');

		// Create a client for blockchain interactions
		const client = createPublicClient({
			chain: base,
			transport: http(baseRpcUrl),
		}) as any;

		// Get APY data from Moonwell
		const apyData = await getAPYData();

		// Initialize variables for pagination
		let nextCursor: string | null = null;
		let totalProcessedStrategies = 0;

		// Process all pages of strategies
		do {
			// Construct the API URL with cursor if available
			const apiUrl = nextCursor ? `${MAMO_INDEXER_API}/strategies?cursor=${nextCursor}` : `${MAMO_INDEXER_API}/strategies`;

			console.log(`Fetching strategies from: ${apiUrl}`);
			const response = await fetch(apiUrl);

			if (!response.ok) {
				throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
			}

			const strategiesResponse = (await response.json()) as StrategiesResponse;
			console.log(`✅ Successfully fetched ${strategiesResponse.strategies.length} strategies`);

			// Process each strategy in this page
			for (const strategy of strategiesResponse.strategies) {
				await processStrategyOptimization(client, strategy, apyData, baseRpcUrl, privateKey);
			}

			totalProcessedStrategies += strategiesResponse.strategies.length;

			// Update the cursor for the next page
			nextCursor = strategiesResponse.nextCursor;
		} while (nextCursor !== null); // Continue until there are no more pages

		console.log('==========================================================');
		console.log('✅ STRATEGY POSITION OPTIMIZATION COMPLETED SUCCESSFULLY ✅');
		console.log(`✅ Total strategies processed: ${totalProcessedStrategies}`);
		console.log('==========================================================');
	} catch (error) {
		console.error('❌ ERROR IN STRATEGY POSITION OPTIMIZATION:', error);
		console.error('==========================================================');
		// Don't exit the process, just log the error and continue
	}
}

/**
 * Function to process idle strategies by calling depositIdleTokens
 */
async function processIdleStrategies(): Promise<void> {
	console.log('==========================================================');
	console.log('🔍 IDLE STRATEGIES PROCESSING STARTED 🔍');
	console.log(`⏰ Start time: ${new Date().toISOString()}`);
	console.log('==========================================================');

	try {
		// Get environment variables
		const baseRpcUrl = ensureString(process.env.BASE_RPC_URL, 'BASE_RPC_URL environment variable is required');
		const privateKey = ensureString(process.env.PRIVATE_KEY, 'PRIVATE_KEY environment variable is required');

		// Create wallet client for transactions
		const account = privateKeyToAccount(privateKey as `0x${string}`);
		const walletClient = createWalletClient({
			chain: base,
			transport: http(baseRpcUrl),
			account,
		}) as any;

		// Create public client for reading from the blockchain
		const publicClient = createPublicClient({
			chain: base,
			transport: http(baseRpcUrl),
		}) as any;

		// Initialize variables for pagination
		let nextCursor: string | null = null;
		let totalProcessedStrategies = 0;

		// Process all pages of idle strategies
		do {
			// Construct the API URL with cursor if available
			const apiUrl = nextCursor ? `${MAMO_INDEXER_API}/strategies/idle?cursor=${nextCursor}` : `${MAMO_INDEXER_API}/strategies/idle`;

			console.log(`Fetching idle strategies from: ${apiUrl}`);
			const response = await fetch(apiUrl);

			if (!response.ok) {
				throw new Error(`Failed to fetch idle strategies: ${response.status} ${response.statusText}`);
			}

			const idleStrategiesResponse = (await response.json()) as IdleStrategiesResponse;
			console.log(`✅ Successfully fetched ${idleStrategiesResponse.strategies.length} idle strategies`);

			// Process each idle strategy in this page
			for (const strategyAddress of idleStrategiesResponse.strategies) {
				console.log(`Processing idle strategy: ${strategyAddress}`);

				try {
					// Call depositIdleTokens on the strategy contract
					const hash = await walletClient.writeContract({
						address: strategyAddress as `0x${string}`,
						abi: STRATEGY_ABI,
						functionName: 'depositIdleTokens',
					});
					// Wait for transaction receipt
					await publicClient.waitForTransactionReceipt({
							hash,
						});

					console.log(`✅ Successfully processed idle strategy ${strategyAddress}. Transaction hash: ${hash}`);
					totalProcessedStrategies++;
				} catch (error) {
					console.error(`❌ Error processing idle strategy ${strategyAddress}:`, error);
					// Continue with the next strategy
				}
			}

			// Update the cursor for the next page
			nextCursor = idleStrategiesResponse.nextCursor;
		} while (nextCursor !== null); // Continue until there are no more pages

		console.log('==========================================================');
		console.log(`✅ IDLE STRATEGIES PROCESSING COMPLETED SUCCESSFULLY ✅`);
		console.log(`✅ Total strategies processed: ${totalProcessedStrategies}`);
		console.log('==========================================================');
	} catch (error) {
		console.error('❌ ERROR IN IDLE STRATEGIES PROCESSING:', error);
		console.error('==========================================================');
		// Don't exit the process, just log the error and continue
	}
}

// Set up health check endpoint
app.get('/health', (req, res) => {
	res.status(200).json({
		status: 'ok',
		uptime: process.uptime(),
		timestamp: Date.now(),
	});
});

// Set up status endpoint to show registered tasks
app.get('/status', (req, res) => {
	const taskStatus = Object.entries(tasks).map(([id, task]) => ({
		id,
		prefix: task.prefix,
		interval: task.interval,
		lastRun: task.lastRun ? task.lastRun.toISOString() : null,
		running: task.running || false,
		nextRun: task.lastRun ? new Date(task.lastRun.getTime() + task.interval).toISOString() : new Date().toISOString(),
	}));

	res.status(200).json({
		tasks: taskStatus,
		serverTime: new Date().toISOString(),
	});
});

// Register the rewards processing task
periodic({
	interval: 1000 * 60 * 5, // 5 minutes
	fn: processRewards,
	prefix: '[MAMO Compounder]',
});

// Register the strategy position optimization task
periodic({
	interval: 1000 * 60 * 5, // 5 minutes
	fn: optimizeStrategyPositions,
	prefix: '[Strategy Optimizer]',
});

// Register the idle strategies processing task
periodic({
	interval: 1000 * 60 * 5, // 5 minutes
	fn: processIdleStrategies,
	prefix: '[Idle Strategies]',
});



// Initialize the database before starting the server
initializeDatabase()
	.then(() => {
		// Start the task scheduler
		taskScheduler();

		// Start the server
		app.listen(PORT, () => {
			console.log(`Server running on port ${PORT}`);
			console.log(`Health check: http://localhost:${PORT}/health`);
			console.log(`Status: http://localhost:${PORT}/status`);
		});
	})
	.catch((error) => {
		console.error('❌ Failed to initialize database:', error);
		process.exit(1);
	});
