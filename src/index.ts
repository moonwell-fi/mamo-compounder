/**
 * Mamo Compounder Worker
 *
 * This worker fetches strategies from the /strategies endpoint and processes them.
 * It runs on a cron schedule defined by the CRON_FREQUENCY environment variable.
 *
 * - Run `npm run dev --test-scheduled` in your terminal to start a development server and test the scheduled job
 * - Run `npm run deploy` to publish your worker
 */

/// <reference types="@cloudflare/workers-types" />

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

export default {
	// Fetch handler for HTTP requests - provides basic information about the worker
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response('Mamo Compounder Worker. This worker runs on a schedule.', {
			headers: { 'Content-Type': 'text/plain' },
		});
	},

	// Scheduled handler for cron jobs - this is the main entry point
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		await processScheduledJob(controller, env, ctx);
	},
} satisfies ExportedHandler<Env>;

/**
 * Process the scheduled job
 */
async function processScheduledJob(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
	console.log(`Running scheduled job with frequency: ${env.CRON_FREQUENCY}`);
	console.log(`Scheduled time: ${new Date(controller.scheduledTime).toISOString()}`);

	try {
		// Fetch strategies from the endpoint
		const response = await fetch('http://localhost:8787/strategies');

		if (!response.ok) {
			throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
		}

		const strategiesResponse: StrategiesResponse = await response.json();

		// Process the strategies
		await processStrategies(strategiesResponse.strategies);

		console.log('Scheduled job completed successfully');
	} catch (error: any) {
		console.error('Error in scheduled job:', error);
	}
}

/**
 * Process the strategies by looping over them
 */
async function processStrategies(strategies: Strategy[]): Promise<void> {
	console.log(`Processing ${strategies.length} strategies...`);
	
	for (const strategy of strategies) {
		console.log(`Processing strategy: ${strategy.strategy}`);
		console.log(`  User: ${strategy.user}`);
		console.log(`  Implementation: ${strategy.implementation}`);
		console.log(`  Block Number: ${strategy.blockNumber}`);
		console.log(`  Transaction Hash: ${strategy.txHash}`);
		
		// Here you can add more logic to process each strategy
		// For example, making additional API calls, storing data, etc.
	}
	
	console.log('Finished processing strategies');
}
