/**
 * Mamo Compounder Worker
 *
 * This worker fetches strategies from the /strategies endpoint and processes them.
 * It calls the getUserRewards function for each strategy to get their rewards from the Moonwell View contract.
 * When WELL token rewards are found, it logs information about how to claim them using the UNITROLLER contract.
 * It runs on a cron schedule defined by the CRON_FREQUENCY environment variable.
 *
 * - Run `npm run dev --test-scheduled` in your terminal to start a development server and test the scheduled job
 * - Run `npm run deploy` to publish your worker
 */

/// <reference types="@cloudflare/workers-types" />

// Define the environment variables interface
interface Env {
	CRON_FREQUENCY: string;
	BASE_RPC_URL: string;
	PRIVATE_KEY: string;
}

import { createPublicClient, http, parseAbi, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// Contract addresses and ABIs
const MOONWELL_VIEW_CONTRACT = '0x6834770ABA6c2028f448E3259DDEE4BCB879d459';
const REWARDS_ABI = parseAbi([
	'struct Rewards { address market; address rewardToken; uint256 supplyRewardsAmount; uint256 borrowRewardsAmount; }',
	'function getUserRewards(address user) external view returns (Rewards[] memory)',
]);

// Unitroller contract for claiming rewards
const UNITROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const UNITROLLER_ABI = parseAbi(['function claimReward(address holder) public']);

// WELL token address
const WELL = '0xA88594D404727625A9437C3f886C7643872296AE';

// Chainlink price feeds
const CHAINLINK_WELL_USD = '0xc15d9944dAefE2dB03e53bef8DDA25a56832C5fe';
const CHAINLINK_ABI = parseAbi([
	'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

// Map of token addresses to their Chainlink price feed addresses
const TOKEN_PRICE_FEEDS: Record<string, string> = {
	[WELL.toLowerCase()]: CHAINLINK_WELL_USD,
	// Add more token price feeds here as needed
};

// Map of token addresses to their symbols
const TOKEN_SYMBOLS: Record<string, string> = {
	[WELL.toLowerCase()]: 'WELL',
	// Add more token symbols here as needed
};

// Minimum USD value threshold for claiming rewards (0.5 cents)
const MIN_USD_VALUE_THRESHOLD = 0.005;

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

interface TokenPriceResult {
	priceUsd: string;
	rewardsUsdFormatted: string;
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
	// Add prominent logging with clear markers
	console.log('==========================================================');
	console.log('🕒 SCHEDULED JOB STARTED 🕒');
	console.log(`🔄 Running with frequency: ${env.CRON_FREQUENCY}`);
	console.log(`⏰ Scheduled time: ${new Date(controller.scheduledTime).toISOString()}`);
	console.log('==========================================================');

	// Validate that PRIVATE_KEY is provided
	if (!env.PRIVATE_KEY) {
		throw new Error('PRIVATE_KEY environment variable is required');
	}

	try {
		// Fetch strategies from the endpoint
		console.log('📡 Fetching strategies from endpoint...');
		const response = await fetch('http://localhost:8787/strategies');

		if (!response.ok) {
			throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
		}

		const strategiesResponse: StrategiesResponse = await response.json();
		console.log(`✅ Successfully fetched ${strategiesResponse.strategies.length} strategies`);

		// Process the strategies with the BASE_RPC_URL and PRIVATE_KEY from environment variables
		await processStrategies(strategiesResponse.strategies, env.BASE_RPC_URL, env.PRIVATE_KEY);

		console.log('==========================================================');
		console.log('✅ SCHEDULED JOB COMPLETED SUCCESSFULLY ✅');
		console.log('==========================================================');
	} catch (error: any) {
		console.error('❌ ERROR IN SCHEDULED JOB:', error);
		console.error('==========================================================');
	}
}

/**
 * Create a viem public client
 * @param rpcUrl The RPC URL to connect to
 * @returns The public client
 */
function createClient(rpcUrl: string) {
	return createPublicClient({
		chain: base,
		transport: http(rpcUrl),
	});
}

/**
 * Get the symbol for a token address
 * @param tokenAddress The token address
 * @returns The token symbol or the shortened address if not found
 */
function getTokenSymbol(tokenAddress: string): string {
	const lowerCaseAddress = tokenAddress.toLowerCase();
	return TOKEN_SYMBOLS[lowerCaseAddress] || tokenAddress.substring(0, 6) + '...' + tokenAddress.substring(38);
}

/**
 * Calculate the USD price of a token amount
 * @param client The viem public client
 * @param tokenAddress The token address
 * @param amount The token amount (in token's native decimals)
 * @returns The price in USD and the formatted USD value of the amount
 */
async function calculateTokenPriceInUsd(
	client: ReturnType<typeof createPublicClient>,
	tokenAddress: string,
	amount: bigint
): Promise<TokenPriceResult> {
	const lowerCaseAddress = tokenAddress.toLowerCase();
	const priceFeed = TOKEN_PRICE_FEEDS[lowerCaseAddress];

	if (!priceFeed) {
		throw new Error(`No price feed found for token ${tokenAddress}`);
	}

	// Get the token price from Chainlink
	const priceData = await client.readContract({
		address: priceFeed as `0x${string}`,
		abi: CHAINLINK_ABI,
		functionName: 'latestRoundData',
	});

	// Extract the price (answer) from the response
	const tokenPriceUsd = priceData[1]; // answer is at index 1

	// Calculate USD value of the amount
	// Assuming token has 18 decimals, price has 8 decimals
	const rewardsUsd = (amount * BigInt(tokenPriceUsd)) / BigInt(10n ** 18n);

	// Format USD value with 8 decimal places
	const rewardsUsdFormatted = (Number(rewardsUsd) / 10 ** 8).toFixed(8);
	const priceUsd = (Number(tokenPriceUsd) / 10 ** 8).toFixed(8);

	return {
		priceUsd,
		rewardsUsdFormatted,
	};
}

/**
 * Process the strategies by looping over them and fetching rewards for each strategy
 */
async function processStrategies(strategies: Strategy[], rpcUrl: string, privateKey: string): Promise<void> {
	console.log(`Processing ${strategies.length} strategies...`);

	// Create viem client using the provided RPC URL
	const client = createClient(rpcUrl);

	// Private key is now mandatory
	console.log(`  ✅ Private key provided for claiming rewards`);

	for (const strategy of strategies) {
		console.log(`Processing strategy: ${strategy.strategy}`);
		console.log(`  User: ${strategy.user}`);
		console.log(`  Implementation: ${strategy.implementation}`);

		try {
			// Call the getUserRewards function for this strategy
			console.log(`  Fetching rewards for strategy: ${strategy.strategy}...`);

			// Convert the strategy address to a proper 0x-prefixed address
			const strategyAddress = strategy.strategy as `0x${string}`;

			// Call the contract
			const rewards = (await client.readContract({
				address: MOONWELL_VIEW_CONTRACT,
				abi: REWARDS_ABI,
				functionName: 'getUserRewards',
				args: [strategyAddress],
			})) as Rewards[];

			console.log(`  Found ${rewards.length} rewards for strategy ${strategy.strategy}`);

			// Process each reward
			for (let i = 0; i < rewards.length; i++) {
				const reward = rewards[i];

				// Check if there are rewards to claim
				const hasRewards = reward.supplyRewardsAmount > 0n;
				const hasTokenPriceFeed = TOKEN_PRICE_FEEDS[reward.rewardToken.toLowerCase()] !== undefined;

				if (hasRewards && hasTokenPriceFeed) {
					try {
						// Get the token price and calculate USD value
						const { priceUsd, rewardsUsdFormatted } = await calculateTokenPriceInUsd(
							client,
							reward.rewardToken,
							reward.supplyRewardsAmount
						);

						// Parse the USD value to check against threshold
						const rewardsUsdValue = parseFloat(rewardsUsdFormatted);
						const exceedsThreshold = rewardsUsdValue >= MIN_USD_VALUE_THRESHOLD;

						// Log the results
						console.log(`    🔄 Found ${getTokenSymbol(reward.rewardToken)} rewards for strategy ${strategy.strategy}`);

						if (exceedsThreshold) {
							console.log(`    🚀 Rewards value ($${rewardsUsdFormatted}) exceeds threshold ($${MIN_USD_VALUE_THRESHOLD})`);

							console.log(`    ✅ Calling claimReward(${strategyAddress}) on the UNITROLLER contract at ${UNITROLLER}`);

							// Implement the wallet client to call the unitroller
							const account = privateKeyToAccount(privateKey as `0x${string}`);
							const walletClient = createWalletClient({
								chain: base,
								transport: http(rpcUrl),
								account,
							});

							const hash = await walletClient.writeContract({
								address: UNITROLLER as `0x${string}`,
								abi: UNITROLLER_ABI,
								functionName: 'claimReward',
								args: [strategyAddress],
							});

							console.log(`    📝 Transaction hash: ${hash}`);
						} else {
							console.log(`    ⏳ Rewards value ($${rewardsUsdFormatted}) below threshold ($${MIN_USD_VALUE_THRESHOLD}), skipping claim`);
							console.log(
								`    💡 To manually claim rewards, you would call claimReward(${strategyAddress}) on the UNITROLLER contract at ${UNITROLLER}`
							);
						}

						console.log(
							`    💰 Supply Rewards: ${reward.supplyRewardsAmount.toString()} ${getTokenSymbol(
								reward.rewardToken
							)} (≈ $${rewardsUsdFormatted} USD)`
						);
						console.log(`    📈 Current ${getTokenSymbol(reward.rewardToken)} price: $${priceUsd} USD`);
					} catch (priceError) {
						// If we can't get the price, just show the token amount and don't attempt to claim
						console.log(`    🔄 Found ${getTokenSymbol(reward.rewardToken)} rewards for strategy ${strategy.strategy}`);
						console.log(`    ⚠️ Unable to determine USD value, skipping automatic claim`);
						console.log(
							`    💡 To manually claim rewards, you would call claimReward(${strategyAddress}) on the UNITROLLER contract at ${UNITROLLER}`
						);
						console.log(
							`    💰 Supply Rewards: ${reward.supplyRewardsAmount.toString()} ${getTokenSymbol(
								reward.rewardToken
							)} (USD value unavailable)`
						);
						console.error(`    ❌ Error fetching ${getTokenSymbol(reward.rewardToken)} price:`, priceError);
					}
				}
			}
		} catch (error) {
			console.error(`  Error fetching rewards for strategy ${strategy.strategy}:`, error);
		}
	}

	console.log('Finished processing strategies');
}
