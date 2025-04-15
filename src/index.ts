/**
 * Mamo Compounder Worker
 *
 * This worker fetches strategies from the /strategies endpoint and processes them.
 * It calls the getUserRewards function for each strategy to get their rewards from the Moonwell View contract.
 * When WELL token rewards are found, it logs information about how to claim them using the UNITROLLER contract.
 *
 * - Run `npm run dev --test-scheduled` in your terminal to start a development server and test the scheduled job
 * - Run `npm run deploy` to publish your worker
 */

/// <reference types="@cloudflare/workers-types" />

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

// Define the environment variables interface
interface Env {
	BASE_RPC_URL: string;
	PRIVATE_KEY: string;
	MIN_USD_VALUE_THRESHOLD: string;
}

import {
	MOONWELL_VIEW_CONTRACT,
	REWARDS_ABI,
	UNITROLLER,
	UNITROLLER_ABI,
	ERC20_ABI,
	USDC,
	CHAINLINK_ABI,
	TOKEN_PRICE_FEEDS,
	TOKEN_SYMBOLS,
	APP_DATA,
	ERC20_BALANCE,
	KIND_SELL,
	MAGIC_VALUE,
	STRATEGY_ABI,
} from './constants';

import { createPublicClient, http, parseAbi, createWalletClient, encodeAbiParameters, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
	SupportedChainId,
	SigningScheme,
	OrderBookApi,
	OrderQuoteRequest,
	PriceQuality,
	SellTokenSource,
	BuyTokenDestination,
	OrderQuoteSideKindSell,
	OrderCreation,
	COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
} from '@cowprotocol/cow-sdk';
import { hashOrder, domain, OrderKind, OrderBalance, Order, normalizeOrder } from '@cowprotocol/contracts';

// Constants that are not moved to constants.ts since they are specific to this file
const CHAINLINK_SWAP_CHECKER_PROXY = '0x1e297b2bCFAeB73dCd5CFE37B1C91b504dc32909' as const;

// Add the contract ABI for the Chainlink Swap Checker
const CHAINLINK_SWAP_CHECKER_ABI = [
	{
		inputs: [
			{ internalType: 'uint256', name: 'amountIn', type: 'uint256' },
			{ internalType: 'address', name: 'tokenIn', type: 'address' },
			{ internalType: 'address', name: 'tokenOut', type: 'address' },
		],
		name: 'getExpectedOut',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const;

// Create a public client for the Base network
const baseClient = createPublicClient({
	chain: base,
	transport: http(),
}) as any;

// Create a single instance of OrderBookApi for CoW Swap
const cowSwapOrderBookApi = new OrderBookApi({ chainId: SupportedChainId.BASE });

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
	console.log(`⏰ Scheduled time: ${new Date(controller.scheduledTime).toISOString()}`);
	console.log('==========================================================');

	// Validate that PRIVATE_KEY is provided
	if (!env.PRIVATE_KEY) {
		throw new Error('PRIVATE_KEY environment variabFailed to fetch strategiesle is required');
	}

	try {
		const response = await fetch('https://mamo-indexer.moonwell.workers.dev/strategies');

		if (!response.ok) {
			throw new Error(`Failed to fetch strategies: ${response.status} ${response.statusText}`);
		}

		const strategiesResponse: StrategiesResponse = await response.json();
		console.log(`✅ Successfully fetched ${strategiesResponse.strategies.length} strategies`);

		// Pass env to processStrategies
		await processStrategies(strategiesResponse.strategies, env.BASE_RPC_URL, env.PRIVATE_KEY, env);

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

	// Ensure the price is positive (Chainlink can return negative values in some cases)
	const absolutePriceUsd = tokenPriceUsd < 0 ? BigInt(-tokenPriceUsd) : BigInt(tokenPriceUsd);

	// Calculate USD value of the amount
	// Assuming token has 18 decimals, price has 8 decimals
	const rewardsUsd = (amount * absolutePriceUsd) / BigInt(10n ** 18n);

	// Format USD value with 8 decimal places
	const rewardsUsdFormatted = (Number(rewardsUsd) / 10 ** 8).toFixed(8);
	const priceUsd = (Number(tokenPriceUsd) / 10 ** 8).toFixed(8);

	return {
		priceUsd,
		rewardsUsdFormatted,
	};
}

/**
 * Encode order parameters for EIP-1271 signature and call isValidSignature
 * @param params The order parameters
 * @param strategyAddress The address of the strategy contract
 * @param client The viem public client
 * @returns The encoded order parameters and validation result
 */
async function encodeOrderForSignature(
	params: Order,
	strategyAddress: `0x${string}`,
	client: ReturnType<typeof createPublicClient>,
	rpcUrl: string
): Promise<{ encodedOrder: `0x${string}`; isValid: boolean }> {
	// Get the allowed slippage from the strategy contract
	console.log(`🔍 Getting allowed slippage from strategy contract ${strategyAddress}...`);
	let allowedSlippageInBps = 30n; // Default to 0.3% if we can't get it from the contract
	try {
		const slippageResult = await client.readContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'allowedSlippageInBps',
		});
		// Ensure we have a valid bigint value
		allowedSlippageInBps = BigInt(String(slippageResult));
		// Ensure slippage is not greater than 10000 (100%)
		if (allowedSlippageInBps > 10000n) {
			console.warn(`⚠️ Slippage value ${allowedSlippageInBps} is too high, capping at 10000 (100%)`);
			allowedSlippageInBps = 10000n;
		}
		console.log(`✅ Allowed slippage: ${allowedSlippageInBps} bps`);
	} catch (error) {
		console.error(`❌ Error getting allowed slippage from contract:`, error);
		console.log(`⚠️ Using default slippage of ${allowedSlippageInBps} bps`);
	}

	// Use the hashOrder function directly to get the complete EIP-712 hash
	const domainData = domain(base.id, COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[base.id]);
	const orderDigest = hashOrder(domainData, params);

	console.log(`🔑 Order digest with domain separator: ${orderDigest}`);

	const order = {
		sellToken: params.sellToken as `0x${string}`,
		buyToken: params.buyToken as `0x${string}`,
		receiver: params.receiver as `0x${string}`,
		sellAmount: BigInt(params.sellAmount.toString()),
		buyAmount: BigInt(params.buyAmount.toString()),
		validTo: params.validTo as number,
		appData: params.appData as `0x${string}`,
		feeAmount: BigInt(params.feeAmount.toString()),
		kind: KIND_SELL as `0x${string}`,
		partiallyFillable: false,
		sellTokenBalance: ERC20_BALANCE as `0x${string}`,
		buyTokenBalance: ERC20_BALANCE as `0x${string}`,
	};

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

	try {
		const result = await client.simulateContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'isValidSignature',
			args: [orderDigest as `0x${string}`, encodedOrder],
		});

		console.log(`✅ isValidSignature result (viem fallback): ${result}`);
		const isValid = result.result === MAGIC_VALUE;
		console.log(`${isValid ? '✅ Signature is valid!' : '❌ Signature is invalid!'}`);

		return { encodedOrder, isValid };
	} catch (error: any) {
		// Try to decode the error if it has data
		if (error.cause?.data) {
			try {
				const decodedError = decodeErrorResult({
					abi: STRATEGY_ABI as any,
					data: error.cause.data,
				});
				console.error(`📝 Decoded error:`, decodedError);
			} catch (decodeError) {
				console.error(`❌ Could not decode error:`, decodeError);
			}
		}

		console.error(`❌ Error calling isValidSignature with viem fallback:`, {
			error: error.message,
			cause: error.cause?.message,
			stack: error.stack,
			contractAddress: strategyAddress,
			orderDigest,
			encodedOrder,
		});

		return { encodedOrder, isValid: false };
	}
}

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
		return cowSwapOrderBookApi.getQuote(parameters);
	} catch (error) {
		console.error(`    ❌ Error getting CoW Swap quote:`, error);
		throw error;
	}
}

/**
 * Process the strategies by looping over them and fetching rewards for each strategy
 */
async function processStrategies(strategies: Strategy[], rpcUrl: string, privateKey: string, env: Env): Promise<void> {
	console.log(`Processing ${strategies.length} strategies...`);

	// Create viem client using the provided RPC URL
	const client = createClient(rpcUrl);

	// Parse the threshold once at the start
	const minUsdValueThreshold = parseFloat(env.MIN_USD_VALUE_THRESHOLD);

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
						const exceedsThreshold = rewardsUsdValue >= minUsdValueThreshold;

						// Log the results
						console.log(`    🔄 Found ${getTokenSymbol(reward.rewardToken)} rewards for strategy ${strategy.strategy}`);

						if (exceedsThreshold) {
							console.log(`    ✅ Rewards value ($${rewardsUsdFormatted}) exceeds threshold ($${minUsdValueThreshold})`);

							console.log(`    ✅ Calling claimReward(${strategyAddress}) on the UNITROLLER contract at ${UNITROLLER}`);

							//Implement the wallet client to call the unitroller
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
							const receipt = await baseClient.waitForTransactionReceipt({
								hash,
							});

							console.log(`    📝 Transaction hash: ${hash}`);
							console.log(`    📝 Transaction receipt: ${JSON.stringify(receipt.status)}`);

							//After claiming rewards, get the actual token balance and create a CoW Swap quote
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
									const { rewardsUsdFormatted } = await calculateTokenPriceInUsd(client, reward.rewardToken, tokenBalance);

									// Parse the USD value to check against threshold
									const tokenBalanceUsdValue = parseFloat(rewardsUsdFormatted);

									console.log(`    💵 Token balance value: $${rewardsUsdFormatted} USD`);

									// Only get a quote if the balance exceeds the threshold
									if (tokenBalanceUsdValue >= minUsdValueThreshold) {
										console.log(`    🔄 Creating CoW Swap quote to swap claimed rewards to USDC...`);

										// Get a CoW Swap quote for the claimed rewards using the actual token balance
										const quoteResult = await getSwapQuote(strategyAddress, reward.rewardToken, tokenBalance, USDC);

										// Extract order parameters from the quote response
										const quoteParams = quoteResult.quote;

										// Get the allowed slippage from the strategy contract
										console.log(`🔍 Getting allowed slippage from strategy contract ${strategyAddress}...`);
										let allowedSlippageInBps = 30n; // Default to 0.3% if we can't get it from the contract
										try {
											const slippageResult = await client.readContract({
												address: strategyAddress,
												abi: STRATEGY_ABI,
												functionName: 'allowedSlippageInBps',
											});
											// Ensure we have a valid bigint value
											allowedSlippageInBps = BigInt(String(slippageResult));
											// Ensure slippage is not greater than 10000 (100%)
											if (allowedSlippageInBps > 10000n) {
												console.warn(`⚠️ Slippage value ${allowedSlippageInBps} is too high, capping at 10000 (100%)`);
												allowedSlippageInBps = 10000n;
											}
											console.log(`✅ Allowed slippage: ${allowedSlippageInBps} bps`);
										} catch (error) {
											console.error(`❌ Error getting allowed slippage from contract:`, error);
											console.log(`⚠️ Using default slippage of ${allowedSlippageInBps} bps`);
										}

										// Get the expected output from the contract
										const expectedOut = await client.readContract({
											address: CHAINLINK_SWAP_CHECKER_PROXY,
											abi: CHAINLINK_SWAP_CHECKER_ABI,
											functionName: 'getExpectedOut',
											args: [BigInt(quoteParams.sellAmount), quoteParams.sellToken, quoteParams.buyToken],
										});

										// Calculate minimum output with slippage
										const minOut = (BigInt(expectedOut.toString()) * (10000n - allowedSlippageInBps)) / 10000n;

										console.log(`📊 Expected output from Chainlink: ${expectedOut.toString()}`);
										console.log(`📊 Minimum output after slippage: ${minOut.toString()}`);

										// Create the order struct that matches the contract's expectations
										const validTo: number = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now

										// Calculate sell amount and ensure it's not negative
										const sellAmountBigInt = BigInt(quoteParams.sellAmount);
										const feeAmountBigInt = quoteParams.feeAmount ? BigInt(quoteParams.feeAmount) : 0n;

										// Ensure fee doesn't exceed sell amount to avoid negative values
										const sellAmount = feeAmountBigInt >= sellAmountBigInt ? '0' : (sellAmountBigInt - feeAmountBigInt).toString();

										// Map between different token balance types
										const sellTokenBalanceForCreation = SellTokenSource.ERC20; // For OrderCreation
										const buyTokenBalanceForCreation = BuyTokenDestination.ERC20; // For OrderCreation
										const sellTokenBalanceForOrder = OrderBalance.ERC20; // For Order
										const buyTokenBalanceForOrder = OrderBalance.ERC20; // For Order

										// Create order parameters for the CoW Protocol contract
										const orderParams: Order = {
											sellToken: quoteParams.sellToken as `0x${string}`,
											buyToken: quoteParams.buyToken as `0x${string}`,
											receiver: quoteParams.receiver as `0x${string}`,
											sellAmount: sellAmount,
											buyAmount: minOut.toString(),
											validTo: validTo,
											appData: APP_DATA,
											feeAmount: '0',
											kind: OrderKind.SELL,
											partiallyFillable: false,
											sellTokenBalance: sellTokenBalanceForOrder,
											buyTokenBalance: buyTokenBalanceForOrder,
										};

										// Log the order parameters for debugging
										console.log(`    📋 Order parameters: ${JSON.stringify(orderParams, null, 2)}`);
										// Encode the order parameters for EIP-1271 signature and validate with the strategy contract
										console.log(`    🔐 Calling isValidSignature on strategy contract ${strategyAddress}...`);
										const { encodedOrder, isValid } = await encodeOrderForSignature(orderParams, strategyAddress, client, rpcUrl);

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
											sellToken: orderParams.sellToken,
											buyToken: orderParams.buyToken,
											receiver: orderParams.receiver,
											sellAmount: orderParams.sellAmount.toString(),
											buyAmount: orderParams.buyAmount.toString(),
											validTo: orderParams.validTo as number,
											appData: orderParams.appData as `0x${string}`,
											feeAmount: orderParams.feeAmount.toString(),
											kind: orderParams.kind,
											partiallyFillable: orderParams.partiallyFillable,
											sellTokenBalance: sellTokenBalanceForCreation,
											buyTokenBalance: buyTokenBalanceForCreation,
											signingScheme: SigningScheme.EIP1271,
											signature: encodedOrder, // Use the encoded order as the signature
											from: strategyAddress,
										};

										console.log(JSON.stringify(orderCreation, null, 2));

										// Send the order to CoW Swap using direct API call
										console.log(`    🔄 Sending order to CoW Swap via direct API call...`);
										try {
											const orderUid = await cowSwapOrderBookApi.sendOrder(orderCreation);
											console.log(`    ✅ Order successfully sent to CoW Swap`);
											console.log(`    📝 Order UID: ${orderUid}`);
										} catch (sendOrderError) {
											console.error(`    ❌ Error sending order to CoW Swap:`, sendOrderError);
										}
									} else {
										console.log(
											`    ⏳ Token balance value ($${rewardsUsdFormatted}) below threshold ($${minUsdValueThreshold}), skipping CoW Swap quote`
										);
									}
								} else {
									console.log(`    ⚠️ No token balance found after claiming rewards, skipping CoW Swap quote`);
								}
							} catch (cowError) {
								console.error(`    ❌ `, cowError);
							}
						} else {
							console.log(`    ⏳ Rewards value ($${rewardsUsdFormatted}) below threshold ($${minUsdValueThreshold}), skipping claim`);
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
					} catch (error) {
						console.log(`    🔄 Found ${getTokenSymbol(reward.rewardToken)} rewards for strategy ${strategy.strategy}`);
						console.log(
							`    💡 To manually claim rewards, you would call claimReward(${strategyAddress}) on the UNITROLLER contract at ${UNITROLLER}`
						);
						console.log(`    💰 Supply Rewards: ${reward.supplyRewardsAmount.toString()} ${getTokenSymbol(reward.rewardToken)}`);
						console.error(`    ❌ Error fetching ${getTokenSymbol(reward.rewardToken)} price:`, error);
					}
				}
			}
		} catch (error) {
			console.error(`  Error fetching rewards for strategy ${strategy.strategy}:`, error);
		}
	}
}
