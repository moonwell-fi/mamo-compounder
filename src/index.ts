import { createPublicClient, http, createWalletClient, encodeAbiParameters, decodeErrorResult } from 'viem';
import { base } from 'viem/chains';
import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';

import { processStrategies } from './utils/strategy-processor';

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

interface Rewards {
	market: `0x${string}`;
	rewardToken: `0x${string}`;
	supplyRewardsAmount: bigint;
	borrowRewardsAmount: bigint;
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

// Create a public client for the Base network
const baseClient = createPublicClient({
	chain: base,
	transport: http(),
}) as any;

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

		// Log that we're fetching strategies
		console.log('Fetching strategies from the indexer...');

		// Fetch strategies from the indexer
		const response = await fetch('https://mamo-indexer.moonwell.workers.dev/strategies');

		if (!response.ok) {
			throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
		}

		const strategiesResponse = (await response.json()) as StrategiesResponse;
		console.log(`✅ Successfully fetched ${strategiesResponse.strategies.length} strategies`);

		// Process strategies
		await processStrategies(strategiesResponse.strategies, baseRpcUrl, privateKey, {
			BASE_RPC_URL: baseRpcUrl,
			PRIVATE_KEY: privateKey,
			MIN_USD_VALUE_THRESHOLD: minUsdValueThreshold,
		});

		console.log('==========================================================');
		console.log('✅ REWARDS PROCESSING COMPLETED SUCCESSFULLY ✅');
		console.log('==========================================================');
	} catch (error) {
		console.error('❌ ERROR IN REWARDS PROCESSING:', error);
		console.error('==========================================================');
		// Don't exit the process, just log the error and continue
	}
}

// Import the processStrategies function from the new file

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

// Start the task scheduler
taskScheduler();

// Start the server
app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
	console.log(`Health check: http://localhost:${PORT}/health`);
	console.log(`Status: http://localhost:${PORT}/status`);
});
