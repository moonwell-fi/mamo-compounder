import express from 'express';
import nodeCron from 'node-cron';

const app = express();
const port = process.env.PORT || 3000;

// Define types for the worker
interface ScheduledController {
	scheduledTime: number;
	cron: string;
}

interface Env {
	BASE_RPC_URL: string;
	PRIVATE_KEY: string;
	MIN_USD_VALUE_THRESHOLD: string;
}

interface ExecutionContext {
	waitUntil: (promise: Promise<any>) => void;
}

// Import the worker code
let worker: any;

// Dynamically import ESM modules (since the worker is using ES modules)
async function importWorker(): Promise<void> {
  try {
		// We need to use dynamic import for ES modules
		const workerModule = await import('./src/index.js');
		worker = workerModule.default;
		console.log('Worker module loaded successfully');
	} catch (error) {
		console.error('Failed to import worker module:', error);
	}
}

// Initialize the worker
importWorker();

// Basic health check endpoint
app.get('/', async (req, res) => {
	res.send('Mamo Compounder Worker. This worker runs on a schedule.');
});

// Endpoint to manually trigger the scheduled job
app.post('/trigger-job', async (req, res) => {
	if (!worker) {
		return res.status(500).send('Worker not initialized yet');
	}

	try {
		console.log('Manually triggering scheduled job...');

		// Create a mock ScheduledController
		const mockController: ScheduledController = {
			scheduledTime: Date.now(),
			cron: process.env.CRON_SCHEDULE || '*/15 * * * *',
		};

		// Get environment variables
		const env: Env = {
			BASE_RPC_URL: process.env.BASE_RPC_URL || '',
			PRIVATE_KEY: process.env.PRIVATE_KEY || '',
			MIN_USD_VALUE_THRESHOLD: process.env.MIN_USD_VALUE_THRESHOLD || '',
		};

		// Create a mock execution context
		const ctx: ExecutionContext = {
			waitUntil: (promise) => promise,
		};

		// Run the scheduled function
		if (typeof worker.scheduled === 'function') {
			await worker.scheduled(mockController, env, ctx);
			res.send('Scheduled job triggered successfully');
		} else {
			res.status(500).send('Worker does not have a scheduled function');
		}
	} catch (error: any) {
		console.error('Error triggering scheduled job:', error);
		res.status(500).send(`Error: ${error.message}`);
	}
});

// Set up cron job to run the scheduled task
// This runs based on the CRON_SCHEDULE environment variable
nodeCron.schedule(process.env.CRON_SCHEDULE || '*/15 * * * *', async () => {
	if (!worker) {
		console.error('Worker not initialized yet, skipping scheduled run');
		return;
	}

	try {
		console.log('Running scheduled job via cron...');

		// Create a mock ScheduledController
		const mockController: ScheduledController = {
			scheduledTime: Date.now(),
			cron: process.env.CRON_SCHEDULE || '*/15 * * * *',
		};

		// Get environment variables
		const env: Env = {
			BASE_RPC_URL: process.env.BASE_RPC_URL || '',
			PRIVATE_KEY: process.env.PRIVATE_KEY || '',
			MIN_USD_VALUE_THRESHOLD: process.env.MIN_USD_VALUE_THRESHOLD || '',
		};

		// Create a mock execution context
		const ctx: ExecutionContext = {
			waitUntil: (promise) => promise,
		};

		// Run the scheduled function
		if (typeof worker.scheduled === 'function') {
			await worker.scheduled(mockController, env, ctx);
			console.log('Scheduled job completed successfully');
		} else {
			console.error('Worker does not have a scheduled function');
		}
	} catch (error) {
		console.error('Error in scheduled job:', error);
	}
});

// Start the server
app.listen(port, () => {
  console.log(`Mamo Compounder server running on port ${port}`);
});
