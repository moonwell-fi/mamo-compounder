import { createPublicClient, http, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
	SupportedChainId,
	SigningScheme,
	OrderBookApi,
	SellTokenSource,
	BuyTokenDestination,
	generateAppDataFromDoc,
} from '@cowprotocol/cow-sdk';
import { OrderKind, OrderBalance } from '@cowprotocol/contracts';

import {
	MOONWELL_VIEW_CONTRACT,
	REWARDS_ABI,
	UNITROLLER,
	UNITROLLER_ABI,
	ERC20_ABI,
	USDC,
	TOKEN_PRICE_FEEDS,
	TOKEN_SYMBOLS,
	STRATEGY_ABI,
} from '../constants';
import { metadataApi, generateMamoAppData } from './generate-appdata';
import { getTokenSymbol, calculateTokenPriceInUsd, encodeOrderForSignature, getSwapQuote } from './cow-swap';

// Create a single instance of OrderBookApi for CoW Swap
const cowSwapOrderBookApi = new OrderBookApi({ chainId: SupportedChainId.BASE });

// Define interfaces
interface Strategy {
	logIndex: number;
	blockNumber: string;
	txHash: string;
	user: string;
	strategy: string;
	implementation: string;
}

interface Rewards {
	market: `0x${string}`;
	rewardToken: `0x${string}`;
	supplyRewardsAmount: bigint;
	borrowRewardsAmount: bigint;
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
 * Fetch rewards for a strategy
 * @param client The viem public client
 * @param strategyAddress The strategy address
 * @returns The rewards for the strategy
 */
async function fetchStrategyRewards(client: ReturnType<typeof createPublicClient>, strategyAddress: `0x${string}`): Promise<Rewards[]> {
	console.log(`    🔍 Strategy address: ${strategyAddress}`);

	// Call the contract
	let rewards = (await client.readContract({
		address: MOONWELL_VIEW_CONTRACT,
		abi: REWARDS_ABI,
		functionName: 'getUserRewards',
		args: [strategyAddress],
	})) as Rewards[];

	console.log(`  Found ${rewards.length} rewards for strategy ${strategyAddress}`);
	return rewards;
}

/**
 * Claim rewards for a strategy if they exceed the threshold
 * @param client The viem public client
 * @param baseClient The base client for waiting for transactions
 * @param strategyAddress The strategy address
 * @param reward The reward to claim
 * @param minUsdValueThreshold The minimum USD value threshold
 * @param rpcUrl The RPC URL
 * @param privateKey The private key for signing transactions
 * @returns Whether the rewards were claimed
 */
async function claimRewards(
	client: ReturnType<typeof createPublicClient>,
	baseClient: ReturnType<typeof createPublicClient>,
	strategyAddress: `0x${string}`,
	reward: Rewards,
	minUsdValueThreshold: number,
	rpcUrl: string,
	privateKey: string
): Promise<boolean> {
	// Calculate the USD value of the rewards
	const { rewardsUsdFormatted } = await calculateTokenPriceInUsd(client, reward.rewardToken, reward.supplyRewardsAmount);

	console.log(
		`  ${strategyAddress}  💰 Supply Rewards: ${reward.supplyRewardsAmount.toString()} ${getTokenSymbol(
			reward.rewardToken
		)} (≈ $${rewardsUsdFormatted} USD)`
	);

	// Parse the USD value to check against threshold
	const rewardsUsdValue = parseFloat(rewardsUsdFormatted);
	console.log(`    💵 Rewards value: $${rewardsUsdFormatted} USD`);
	console.log(`    💵 Threshold: $${minUsdValueThreshold} USD`);
	console.log(`    💵 Exceeds threshold: ${rewardsUsdValue >= minUsdValueThreshold}`);
	const exceedsThreshold = rewardsUsdValue >= minUsdValueThreshold;

	if (exceedsThreshold) {
		console.log(`    ✅ Rewards value ($${rewardsUsdFormatted}) exceeds threshold ($${minUsdValueThreshold})`);

		// Implement the wallet client to call the unitroller
		const account = privateKeyToAccount(privateKey as `0x${string}`);
		const walletClient = createWalletClient({
			chain: base,
			transport: http(rpcUrl),
			account,
		}) as any;

		const hash = await walletClient.writeContract({
			address: UNITROLLER as `0x${string}`,
			abi: UNITROLLER_ABI,
			functionName: 'claimReward',
			args: [strategyAddress],
		});

		// Wait for transaction receipt
		await baseClient.waitForTransactionReceipt({
			hash,
		});

		console.log(`    📝 Rewards claimed. Transaction hash: ${hash}`);
		return true;
	} else {
		console.log(`    ⏳ Rewards value ($${rewardsUsdFormatted}) below threshold ($${minUsdValueThreshold}), skipping claim`);
		return false;
	}
}

/**
 * Create and submit a swap order
 * @param client The viem public client
 * @param strategyAddress The strategy address
 * @param tokenAddress The token address to swap
 * @param tokenBalance The token balance to swap
 * @param minUsdValueThreshold The minimum USD value threshold
 * @param rpcUrl The RPC URL
 * @returns Whether the swap order was created and submitted
 */
async function createSwapOrder(
	client: ReturnType<typeof createPublicClient>,
	strategyAddress: `0x${string}`,
	tokenAddress: `0x${string}`,
	tokenBalance: bigint,
	minUsdValueThreshold: number,
	rpcUrl: string
): Promise<boolean> {
	// Calculate the USD value of the actual token balance
	const { rewardsUsdFormatted } = await calculateTokenPriceInUsd(client, tokenAddress, tokenBalance);

	// Parse the USD value to check against threshold
	const balanceUsdValue = parseFloat(rewardsUsdFormatted);
	console.log(`    💵 Token balance value: $${rewardsUsdFormatted} USD`);

	// Only swap if the balance is worth more than the threshold
	if (balanceUsdValue >= minUsdValueThreshold) {
		console.log(`    ✅ Token balance value ($${rewardsUsdFormatted}) exceeds threshold ($${minUsdValueThreshold})`);

		// Get a quote for swapping the reward token to USDC
		try {
			const quote = await getSwapQuote(strategyAddress, tokenAddress, tokenBalance, USDC);

			// Create the order
			try {
				// Get the compound fee and hook gas limit from the strategy contract
				console.log(`    🔍 Getting compound fee and hook gas limit from strategy contract...`);
				let compoundFee = 500n;
				let hookGasLimit = 100000n; // Default gas limit

				// Calculate fee amount
				const feeAmount = (BigInt(quote.quote.sellAmount) * compoundFee) / 10000n;
				console.log(`    💰 Fee amount: ${feeAmount} (${compoundFee} bps of ${quote.quote.sellAmount})`);

				// Generate app data with pre-hook for fee transfer
				const { appDataKeccak256: appData } = await generateMamoAppData(tokenAddress, feeAmount.toString(), hookGasLimit, strategyAddress);

				// Create the order with proper types
				const orderCreation = {
					sellToken: tokenAddress,
					buyToken: USDC,
					sellAmount: quote.quote.sellAmount,
					buyAmount: quote.quote.buyAmount,
					validTo: quote.quote.validTo,
					appData: appData,
					feeAmount: '0',
					kind: OrderKind.SELL,
					partiallyFillable: false,
					receiver: strategyAddress,
					signature: '0x' as `0x${string}`,
					from: strategyAddress,
					signingScheme: SigningScheme.EIP1271,
					sellTokenBalance: SellTokenSource.ERC20,
					buyTokenBalance: BuyTokenDestination.ERC20,
				};

				// Convert to the format expected by hashOrder
				const orderForHashing = {
					sellToken: orderCreation.sellToken,
					buyToken: orderCreation.buyToken,
					sellAmount: BigInt(orderCreation.sellAmount),
					buyAmount: BigInt(orderCreation.buyAmount),
					validTo: orderCreation.validTo,
					appData: orderCreation.appData,
					feeAmount: BigInt(orderCreation.feeAmount),
					kind: orderCreation.kind,
					partiallyFillable: orderCreation.partiallyFillable,
					receiver: orderCreation.receiver,
					sellTokenBalance: OrderBalance.ERC20,
					buyTokenBalance: OrderBalance.ERC20,
				};

				// Encode the order for signature with proper type conversion
				const orderWithStringAppData = {
					...orderForHashing,
					appData: appData as `0x${string}`,
				};

				const { encodedOrder, isValid } = await encodeOrderForSignature(orderWithStringAppData, strategyAddress, client, rpcUrl);

				if (isValid) {
					console.log(`    ✅ Order signature is valid, submitting order to CoW Swap...`);

					// Submit the order to CoW Swap with proper type conversion
					const orderToSubmit = {
						...orderCreation,
						appData: appData as `0x${string}`,
						signature: encodedOrder,
					};

					const orderResponse = await cowSwapOrderBookApi.sendOrder(orderToSubmit);

					if (typeof orderResponse === 'string') {
						const orderId = orderResponse;
						console.log(`    🎉 Order submitted successfully! Order ID: ${orderId}`);
						console.log(`    🔗 Track order: https://explorer.cow.fi/orders/${orderId}?tab=overview&chain=base`);
					} else {
						console.log(`    🎉 Order submitted successfully! Response:`, orderResponse);
					}
					return true;
				} else {
					console.error(`    ❌ Order signature is invalid, skipping order submission`);
					return false;
				}
			} catch (orderError) {
				console.error(`    ❌ Error creating or submitting order:`, orderError);
				return false;
			}
		} catch (error) {
			console.error(`    ❌ Error processing swap:`, error);
			return false;
		}
	} else {
		console.log(`    ⏳ Token balance value ($${rewardsUsdFormatted}) below threshold ($${minUsdValueThreshold}), skipping swap`);
		return false;
	}
}

/**
 * Process a single strategy
 * @param strategy The strategy to process
 * @param client The viem public client
 * @param baseClient The base client for waiting for transactions
 * @param minUsdValueThreshold The minimum USD value threshold
 * @param rpcUrl The RPC URL
 * @param privateKey The private key for signing transactions
 */
async function processStrategyCompounding(
	strategy: Strategy,
	client: ReturnType<typeof createPublicClient>,
	baseClient: ReturnType<typeof createPublicClient>,
	minUsdValueThreshold: number,
	rpcUrl: string,
	privateKey: string
): Promise<void> {
	try {
		// Convert the strategy address to a proper 0x-prefixed address
		const strategyAddress = strategy.strategy as `0x${string}`;

		// Fetch rewards for the strategy
		const rewards = await fetchStrategyRewards(client, strategyAddress);

		// Process each reward
		for (let i = 0; i < rewards.length; i++) {
			const reward = rewards[i];

			// Check if there are rewards to claim
			const hasRewards = reward.supplyRewardsAmount > 0n;
			const hasTokenPriceFeed = TOKEN_PRICE_FEEDS[reward.rewardToken.toLowerCase()] !== undefined;

			if (hasRewards && hasTokenPriceFeed) {
				console.log(`  Found ${TOKEN_SYMBOLS[reward.rewardToken.toLowerCase()]} rewards for strategy ${strategy.strategy}\n`);
				try {
					// Claim rewards if they exceed the threshold
					await claimRewards(client, baseClient, strategyAddress, reward, minUsdValueThreshold, rpcUrl, privateKey);

					// Get the actual token balance of the strategy
					const tokenBalance = await client.readContract({
						address: reward.rewardToken,
						abi: ERC20_ABI,
						functionName: 'balanceOf',
						args: [strategyAddress],
					});

					console.log(`    💰 Actual token balance: ${tokenBalance.toString()} ${getTokenSymbol(reward.rewardToken)}`);

					if (tokenBalance > 0n) {
						// Create and submit a swap order if the balance exceeds the threshold
						await createSwapOrder(client, strategyAddress, reward.rewardToken, tokenBalance, minUsdValueThreshold, rpcUrl);
					} else {
						console.log(`    ℹ️ No token balance to swap`);
					}
				} catch (error) {
					console.error(`    ❌ Error processing reward:`, error);
				}
			} else {
				if (!hasRewards) {
					console.log(`  No rewards to claim for strategy ${strategy.strategy}`);
				} else if (!hasTokenPriceFeed) {
					console.log(`  No price feed found for token ${reward.rewardToken}, skipping`);
				}
			}
		}
	} catch (error) {
		console.error(`❌ Error processing strategy ${strategy.strategy}:`, error);
	}
}

/**
 * Process the strategies by looping over them and fetching rewards for each strategy
 * @param strategies The strategies to process
 * @param rpcUrl The RPC URL
 * @param privateKey The private key for signing transactions
 * @param env The environment variables
 */
export async function compoundStrategies(strategies: Strategy[], rpcUrl: string, privateKey: string, env: any): Promise<void> {
	console.log(`Processing ${strategies.length} strategies...`);

	// Create viem client using the provided RPC URL
	const client = createClient(rpcUrl);

	// Create a base client for waiting for transactions
	const baseClient = createPublicClient({
		chain: base,
		transport: http(),
	}) as any;

	// Parse the threshold once at the start
	const minUsdValueThreshold = parseFloat(env.MIN_USD_VALUE_THRESHOLD);

	// Process each strategy
	for (const strategy of strategies) {
		await processStrategyCompounding(strategy, client, baseClient, minUsdValueThreshold, rpcUrl, privateKey);
	}
}
