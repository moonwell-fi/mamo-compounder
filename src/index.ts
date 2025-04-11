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
	COW_APP_CODE: string;
}

import { createPublicClient, http, parseAbi, createWalletClient, encodeAbiParameters, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { keccak256, concat } from 'viem/utils';
import {
	SupportedChainId,
	OrderKind,
	SigningScheme,
	OrderBookApi,
	OrderQuoteRequest,
	PriceQuality,
	SellTokenSource,
	BuyTokenDestination,
	OrderQuoteSideKindSell,
	OrderCreation,
} from '@cowprotocol/cow-sdk';

// Contract addresses and ABIs
const MOONWELL_VIEW_CONTRACT = '0x6834770ABA6c2028f448E3259DDEE4BCB879d459';
const REWARDS_ABI = parseAbi([
	'struct Rewards { address market; address rewardToken; uint256 supplyRewardsAmount; uint256 borrowRewardsAmount; }',
	'function getUserRewards(address user) external view returns (Rewards[] memory)',
]);

// Unitroller contract for claiming rewards
const UNITROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
const UNITROLLER_ABI = parseAbi(['function claimReward(address holder) public']);

// ERC20 ABI for token balance
const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

// WELL token address
const WELL = '0xA88594D404727625A9437C3f886C7643872296AE';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
const MIN_USD_VALUE_THRESHOLD = 0n;

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

// Define the order parameters interface
interface OrderParams {
	sellToken: string;
	buyToken: string;
	receiver: string;
	sellAmount: string;
	buyAmount: string;
	validTo: number;
	appData: string;
	feeAmount: string;
	kind: OrderKind;
	partiallyFillable: boolean;
	sellTokenBalance: SellTokenSource;
	buyTokenBalance: BuyTokenDestination;
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

		// Process the strategies with all environment variables
		await processStrategies(strategiesResponse.strategies, env.BASE_RPC_URL, env.PRIVATE_KEY, env.COW_APP_CODE);

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
	}) as any; // Type assertion to avoid compatibility issues
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

// Constants for CoW Swap orders
// Domain separator for CoW Swap on Base network
const DOMAIN_SEPARATOR = '0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943';

// GPv2Order TYPE_HASH for EIP-712 hash calculation
const TYPE_HASH = '0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489';

// App data (always zero)
const APP_DATA = '0x0000000000000000000000000000000000000000000000000000000000000000';

// ERC20 balance identifier
const ERC20_BALANCE = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9';

// KIND_SELL identifier
const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775';

// Magic value that should be returned by isValidSignature
const MAGIC_VALUE = '0x1626ba7e';

// ABI for the strategy contract functions
const STRATEGY_ABI = parseAbi([
	'function isValidSignature(bytes32 orderDigest, bytes calldata encodedOrder) external view returns (bytes4)',
	'function hash(bytes32 domainSeparator) external pure returns (bytes32)',
	'function allowedSlippageInBps() external view returns (uint256)',
]);

/**
 * Encode order parameters for EIP-1271 signature and call isValidSignature
 * @param params The order parameters
 * @param strategyAddress The address of the strategy contract
 * @param client The viem public client
 * @returns The encoded order parameters and validation result
 */
async function encodeOrderForSignature(
	params: OrderParams,
	strategyAddress: `0x${string}`,
	client: ReturnType<typeof createPublicClient>
): Promise<{ orderDigest: `0x${string}`; encodedOrder: `0x${string}`; isValid: boolean }> {
	console.log('🔍 Encoding order for signature with parameters:');
	console.log(`  - sellToken: ${params.sellToken}`);
	console.log(`  - buyToken: ${params.buyToken}`);
	console.log(`  - receiver: ${params.receiver}`);
	console.log(`  - sellAmount: ${params.sellAmount}`);
	console.log(`  - buyAmount: ${params.buyAmount}`);
	console.log(`  - validTo: ${params.validTo}`);
	console.log(`  - appData: ${params.appData}`);
	console.log(`  - feeAmount: ${params.feeAmount}`);
	console.log(`  - kind: ${params.kind}`);
	console.log(`  - partiallyFillable: ${params.partiallyFillable}`);
	console.log(`  - sellTokenBalance: ${params.sellTokenBalance}`);
	console.log(`  - buyTokenBalance: ${params.buyTokenBalance}`);

	console.log('🔧 Using constants:');
	console.log(`  - APP_DATA: ${APP_DATA}`);
	console.log(`  - ERC20_BALANCE: ${ERC20_BALANCE}`);
	console.log(`  - KIND_SELL: ${KIND_SELL}`);
	console.log(`  - DOMAIN_SEPARATOR: ${DOMAIN_SEPARATOR}`);

	// Get the allowed slippage from the strategy contract
	console.log(`🔍 Getting allowed slippage from strategy contract ${strategyAddress}...`);
	let allowedSlippageInBps = 30n; // Default to 0.3% if we can't get it from the contract
	try {
		allowedSlippageInBps = await client.readContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'allowedSlippageInBps',
		});
		console.log(`✅ Allowed slippage: ${allowedSlippageInBps} bps`);
	} catch (error) {
		console.error(`❌ Error getting allowed slippage from contract:`, error);
		console.log(`⚠️ Using default slippage of ${allowedSlippageInBps} bps`);
	}

	// Create the order struct that matches the contract's expectations
	// Use a shorter expiration time to avoid "Order expires too far in the future" error
	const order = {
		sellToken: params.sellToken as `0x${string}`,
		buyToken: params.buyToken as `0x${string}`,
		receiver: params.receiver as `0x${string}`,
		sellAmount: BigInt(params.sellAmount),
		buyAmount: BigInt(params.buyAmount),
		validTo: params.validTo,
		appData: params.appData as `0x${string}`,
		feeAmount: BigInt(0),
		kind: KIND_SELL as `0x${string}`,
		partiallyFillable: false, // partially_fillable = false in Rust
		sellTokenBalance: ERC20_BALANCE as `0x${string}`,
		buyTokenBalance: ERC20_BALANCE as `0x${string}`,
	};

	// First, hash the order struct using the TYPE_HASH
	// This is an attempt to replicate the assembly code in the contract
	// The contract uses assembly to compute the hash by first storing the TYPE_HASH at the start of the data,
	// then hashing 416 bytes (which is (1 + 12) * 32 bytes, where 12 is the number of fields in the order struct)
	const encodedOrderData = encodeAbiParameters(
		[
			{ name: 'sellToken', type: 'address' },
			{ name: 'buyToken', type: 'address' },
			{ name: 'receiver', type: 'address' },
			{ name: 'sellAmount', type: 'uint256' },
			{ name: 'buyAmount', type: 'uint256' },
			{ name: 'validTo', type: 'uint32' },
			{ name: 'appData', type: 'bytes32' },
			{ name: 'feeAmount', type: 'uint256' },
			{ name: 'kind', type: 'bytes32' },
			{ name: 'partiallyFillable', type: 'bool' },
			{ name: 'sellTokenBalance', type: 'bytes32' },
			{ name: 'buyTokenBalance', type: 'bytes32' },
		],
		[
			order.sellToken,
			order.buyToken,
			order.receiver,
			order.sellAmount,
			order.buyAmount,
			order.validTo,
			order.appData,
			order.feeAmount,
			order.kind,
			order.partiallyFillable,
			order.sellTokenBalance,
			order.buyTokenBalance,
		]
	);

	// Calculate the struct hash using the TYPE_HASH
	const orderStructHash = keccak256(
		concat([
			TYPE_HASH as `0x${string}`,
			encodedOrderData.slice(2) as `0x${string}`, // Remove the '0x' prefix
		])
	);

	console.log(`📝 Order struct hash: ${orderStructHash}`);

	// Then, create the EIP-712 digest using the domain separator
	const orderDigest = keccak256(
		concat([
			'0x1901', // EIP-712 prefix
			DOMAIN_SEPARATOR as `0x${string}`,
			orderStructHash,
		])
	);

	console.log(`🔑 Order digest with domain separator: ${orderDigest}`);

	// Encode the order data for the isValidSignature call
	// According to GPv2Order.Data struct:
	// struct Data {
	//     IERC20 sellToken;
	//     IERC20 buyToken;
	//     address receiver;
	//     uint256 sellAmount;
	//     uint256 buyAmount;
	//     uint32 validTo;
	//     bytes32 appData;
	//     uint256 feeAmount;
	//     bytes32 kind;
	//     bool partiallyFillable;
	//     bytes32 sellTokenBalance;
	//     bytes32 buyTokenBalance;
	// }
	const encodedOrder = encodeAbiParameters(
		[
			{
				type: 'tuple',
				components: [
					{ name: 'sellToken', type: 'address' },
					{ name: 'buyToken', type: 'address' },
					{ name: 'receiver', type: 'address' },
					{ name: 'sellAmount', type: 'uint256' },
					{ name: 'buyAmount', type: 'uint256' },
					{ name: 'validTo', type: 'uint32' },
					{ name: 'appData', type: 'bytes32' },
					{ name: 'feeAmount', type: 'uint256' },
					{ name: 'kind', type: 'bytes32' },
					{ name: 'partiallyFillable', type: 'bool' },
					{ name: 'sellTokenBalance', type: 'bytes32' },
					{ name: 'buyTokenBalance', type: 'bytes32' },
				],
			},
		],
		[order]
	);

	console.log(`📦 Encoded order data: ${encodedOrder}`);

	// Call isValidSignature on the strategy contract
	console.log(`🔐 Calling isValidSignature on strategy contract ${strategyAddress}...`);
	try {
		const result = await client.readContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'isValidSignature',
			args: [orderDigest, encodedOrder],
		});

		console.log(`✅ isValidSignature result: ${result}`);
		const isValid = result === MAGIC_VALUE;
		console.log(`${isValid ? '✅ Signature is valid!' : '❌ Signature is invalid!'}`);

		return { orderDigest, encodedOrder, isValid };
	} catch (error) {
		console.error(`❌ Error calling isValidSignature:`, error);
		return { orderDigest, encodedOrder, isValid: false };
	}
}

// Create a public client for the Base network
const baseClient = createPublicClient({
	chain: base,
	transport: http(),
}) as any; // Type assertion to avoid compatibility issues

// Create a single instance of OrderBookApi for CoW Swap
const cowSwapOrderBookApi = new OrderBookApi({ chainId: SupportedChainId.BASE });

/**
 * Get a CoW Swap quote for swapping tokens
 * @param strategy The strategy address
 * @param sellToken The token to sell (reward token)
 * @param sellAmount The amount to sell
 * @param buyToken The token to buy (e.g., USDC)
 * @returns The quote information
 */
async function getSwapQuote(strategy: string, sellToken: string, sellAmount: bigint, buyToken: string): Promise<any> {
	console.log(
		`    🐮 Getting CoW Swap quote to swap ${sellAmount.toString()} of ${getTokenSymbol(sellToken)} to ${getTokenSymbol(buyToken)}`
	);

	// We use SELL order kind to sell the exact amount of reward tokens
	const parameters: OrderQuoteRequest = {
		sellToken: sellToken,
		buyToken: buyToken,
		from: strategy,
		receiver: strategy,
		signingScheme: SigningScheme.EIP1271,
		priceQuality: PriceQuality.OPTIMAL,
		onchainOrder: true,
		sellTokenBalance: SellTokenSource.ERC20,
		buyTokenBalance: BuyTokenDestination.ERC20,
		sellAmountBeforeFee: sellAmount.toString(),
		kind: OrderQuoteSideKindSell.SELL,
	};

	try {
		// Get a quote instead of posting an order
		const quoteAndPost = await cowSwapOrderBookApi.getQuote(parameters);

		// Log the quote information
		console.log(`    ✅ CoW Swap quote received`);
		console.log(`      - Quote details: ${JSON.stringify(quoteAndPost, null, 2)}`);

		return quoteAndPost;
	} catch (error) {
		console.error(`    ❌ Error getting CoW Swap quote:`, error);
		throw error;
	}
}

/**
 * Process the strategies by looping over them and fetching rewards for each strategy
 */
async function processStrategies(strategies: Strategy[], rpcUrl: string, privateKey: string, cowAppCode?: string): Promise<void> {
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
							}) as any; // Type assertion to avoid compatibility issues

							//		const hash = await walletClient.writeContract({
							//			address: UNITROLLER as `0x${string}`,
							//			abi: UNITROLLER_ABI,
							//			functionName: 'claimReward',
							//			args: [strategyAddress],
							//		});

							//		// Wait for transaction receipt
							//		const receipt = await baseClient.waitForTransactionReceipt({
							//			hash,
							//		});

							//	console.log(`    📝 Transaction hash: ${hash}`);
							//	console.log(`    📝 Transaction receipt: ${JSON.stringify(receipt.status)}`);

							// After claiming rewards, get the actual token balance and create a CoW Swap quote
							try {
								console.log(`    🔄 Getting actual token balance after claiming rewards...`);

								// Get the actual token balance of the strategy
								const tokenBalance = await client.readContract({
									address: reward.rewardToken,
									abi: ERC20_ABI,
									functionName: 'balanceOf',
									args: [strategyAddress],
								});

								console.log(`    💰 Actual token balance: ${tokenBalance.toString()} ${getTokenSymbol(reward.rewardToken)}`);

								if (tokenBalance > 0n) {
									// Calculate the USD value of the actual token balance
									const { priceUsd, rewardsUsdFormatted } = await calculateTokenPriceInUsd(client, reward.rewardToken, tokenBalance);

									// Parse the USD value to check against threshold
									const tokenBalanceUsdValue = parseFloat(rewardsUsdFormatted);

									console.log(`    💵 Token balance value: $${rewardsUsdFormatted} USD`);

									// Only get a quote if the balance exceeds the threshold
									if (tokenBalanceUsdValue >= MIN_USD_VALUE_THRESHOLD) {
										console.log(`    🔄 Creating CoW Swap quote to swap claimed rewards to USDC...`);

										// Get a CoW Swap quote for the claimed rewards using the actual token balance
										const quoteResult = await getSwapQuote(strategyAddress, reward.rewardToken, tokenBalance, USDC);

										console.log(`    🎉 Successfully got CoW Swap quote for the claimed rewards`);

										// Extract order parameters from the quote response
										const quoteParams = quoteResult.quote;

										// Create an order object with the parameters from the quote
										console.log(`    🔄 Encoding order using EIP-1271...`);

										// Get the allowed slippage from the strategy contract
										console.log(`🔍 Getting allowed slippage from strategy contract ${strategyAddress}...`);
										let allowedSlippageInBps = 30n; // Default to 0.3% if we can't get it from the contract
										try {
											allowedSlippageInBps = await client.readContract({
												address: strategyAddress,
												abi: STRATEGY_ABI,
												functionName: 'allowedSlippageInBps',
											});
											console.log(`✅ Allowed slippage: ${allowedSlippageInBps} bps`);
										} catch (error) {
											console.error(`❌ Error getting allowed slippage from contract:`, error);
											console.log(`⚠️ Using default slippage of ${allowedSlippageInBps} bps`);
										}

										// Calculate the buy amount after slippage
										const buyAmountAfterSlippage = (BigInt(quoteParams.buyAmount) * (10000n - allowedSlippageInBps)) / 10000n;
										console.log(`📊 Buy amount after slippage: ${buyAmountAfterSlippage.toString()}`);

										// Create the order struct that matches the contract's expectations
										// Use a shorter expiration time to avoid "Order expires too far in the future" error
										const orderParams: OrderParams = {
											sellToken: quoteParams.sellToken,
											buyToken: quoteParams.buyToken,
											receiver: quoteParams.receiver,
											sellAmount: (
												BigInt(quoteParams.sellAmount) - (quoteParams.feeAmount ? BigInt(quoteParams.feeAmount) : 0n)
											).toString(),
											buyAmount: buyAmountAfterSlippage.toString(),
											validTo: Math.floor(Date.now() / 1000) + 600, // 10 minutes from now
											appData: APP_DATA,
											feeAmount: '0', // Ensure feeAmount is a string
											kind: OrderKind.SELL,
											partiallyFillable: false, // partially_fillable = false in Rust
											sellTokenBalance: SellTokenSource.ERC20,
											buyTokenBalance: BuyTokenDestination.ERC20,
										};
										// Encode the order parameters for EIP-1271 signature and validate with the strategy contract
										console.log(`    🔐 Calling isValidSignature on strategy contract ${strategyAddress}...`);
										const { orderDigest, encodedOrder, isValid } = await encodeOrderForSignature(orderParams, strategyAddress, client);

										console.log(`    📝 Encoded order digest: ${orderDigest}`);
										console.log(`    📦 Encoded order data: ${encodedOrder}`);
										console.log(`    ${isValid ? '✅ Signature is valid!' : '❌ Signature is invalid!'}`);

										if (!isValid) {
											console.error(`    ❌ Order signature validation failed. Cannot proceed with sending order.`);
											continue;
										}

										// Create the order creation object
										// For EIP-1271 signatures, we need to provide the encoded order as the signature
										// This is because the CoW API will call isValidSignature(orderDigest, signature)
										// where signature is expected to be the encoded order
										const orderCreation: OrderCreation = {
											...orderParams,
											signingScheme: SigningScheme.EIP1271,
											signature: encodedOrder, // Use the encoded order as the signature
											from: strategyAddress,
											quoteId: quoteResult.id,
										};

										// Send the order to CoW Swap
										console.log(`    🔄 Sending order to CoW Swap...`);
										try {
											const orderUid = await cowSwapOrderBookApi.sendOrder(orderCreation);
											console.log(`    ✅ Order successfully sent to CoW Swap`);
											console.log(`    📝 Order UID: ${orderUid}`);
										} catch (sendOrderError) {
											console.error(`    ❌ Error sending order to CoW Swap:`, sendOrderError);
										}
									} else {
										console.log(
											`    ⏳ Token balance value ($${rewardsUsdFormatted}) below threshold ($${MIN_USD_VALUE_THRESHOLD}), skipping CoW Swap quote`
										);
									}
								} else {
									console.log(`    ⚠️ No token balance found after claiming rewards, skipping CoW Swap quote`);
								}
							} catch (cowError) {
								console.error(`    ❌ Error getting token balance or CoW Swap quote:`, cowError);
							}
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
