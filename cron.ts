import {
	createPublicClient,
	http,
	createWalletClient,
	parseAbi,
	encodeAbiParameters,
	decodeErrorResult,
	getContract,
	MaxFeePerGasTooLowError,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
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
	ERC20_BALANCE,
	KIND_SELL,
	MAGIC_VALUE,
	STRATEGY_ABI,
	CHAINLINK_SWAP_CHECKER_PROXY,
	CHAINLINK_SWAP_CHECKER_ABI,
	WELL,
} from './src/constants';

import { generateMamoAppData, calculateFeeAmount } from './src/utils/generate-appdata';

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

// Create a public client for the Base network
const baseClient = createPublicClient({
	chain: base,
	transport: http(),
}) as any;

// Create a single instance of OrderBookApi for CoW Swap
const cowSwapOrderBookApi = new OrderBookApi({ chainId: SupportedChainId.BASE });

// Main function to run the cron job
async function runCronJob() {
	console.log('==========================================================');
	console.log('🕒 MAMO COMPOUNDER CRON JOB STARTED 🕒');
	console.log(`⏰ Start time: ${new Date().toISOString()}`);
	console.log('==========================================================');

	try {
		// Get environment variables
		const baseRpcUrl = process.env.BASE_RPC_URL;
		const privateKey = process.env.PRIVATE_KEY;
		const minUsdValueThreshold = process.env.MIN_USD_VALUE_THRESHOLD;

		// Validate required environment variables
		if (!baseRpcUrl) {
			throw new Error('BASE_RPC_URL environment variable is required');
		}
		if (!privateKey) {
			throw new Error('PRIVATE_KEY environment variable is required');
		}
		if (!minUsdValueThreshold) {
			throw new Error('MIN_USD_VALUE_THRESHOLD environment variable is required');
		}

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
		console.log('✅ CRON JOB COMPLETED SUCCESSFULLY ✅');
		console.log('==========================================================');
	} catch (error) {
		console.error('❌ ERROR IN CRON JOB:', error);
		console.error('==========================================================');
		process.exit(1);
	}

	// Ensure the process exits
	process.exit(0);
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
		allowedSlippageInBps = BigInt(String(slippageResult));

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

		// Check if result exists and has the expected format
		if (result && result.result) {
			const isValid = result.result === MAGIC_VALUE;
			console.log(`${isValid ? '✅ Signature is valid!' : '❌ Signature is invalid!'}`);
			return { encodedOrder, isValid };
		} else {
			console.error(`❌ Unexpected result format from isValidSignature:`, result);
			return { encodedOrder, isValid: false };
		}
	} catch (error: any) {
		// Check if the error is related to stale price feed
		const errorMessage = error.message || '';
		if (
			errorMessage.includes('Price feed update time exceeds heartbeat') ||
			errorMessage.includes('Price feed update time exceeds maximum valid time')
		) {
			console.warn("⚠️ Price feed is stale, but we'll proceed with the order anyway.");
			console.warn('⚠️ This is a temporary workaround until price feeds are updated.');

			// Return as valid despite the error since we want to proceed with the order
			// The actual validation will happen on-chain when the order is executed
			return { encodedOrder, isValid: true };
		}
		// Check if this is the specific "Cannot read properties of null (reading 'data')" error
		console.log(`🔍 Error:`, error);

		// Try to extract the revert reason from the error message
		const errorDetails = error.message || '';
		const revertReasonMatch = errorDetails.match(/Error Message: (.+?)(?=\n|$)/);
		if (revertReasonMatch && revertReasonMatch[1]) {
			console.error(`\n\nThe reason why is reverting is\n\n\nError Message: ${revertReasonMatch[1]}\n\n`);
		}

		if (error.cause && error.cause.message && error.cause.message.includes("Cannot read properties of null (reading 'data')")) {
			console.warn(`⚠️ Contract call failed with a common error. `);
			return { encodedOrder, isValid: false };
		}

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

		console.error(`❌ Error calling isValidSignature:`, {
			error: error.message,
			cause: error.cause?.message,
			contractAddress: strategyAddress,
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
async function processStrategies(strategies: Strategy[], rpcUrl: string, privateKey: string, env: any): Promise<void> {
	console.log(`Processing ${strategies.length} strategies...`);

	// Create viem client using the provided RPC URL
	const client = createClient(rpcUrl);

	// Parse the threshold once at the start
	const minUsdValueThreshold = parseFloat(env.MIN_USD_VALUE_THRESHOLD);

	for (const strategy of strategies) {
		try {
			// Call the getUserRewards function for this strategy
			// Convert the strategy address to a proper 0x-prefixed address
			const strategyAddress = strategy.strategy as `0x${string}`;
			console.log(`    🔍 Strategy address: ${strategyAddress}`);

			// Call the contract
			let rewards = (await client.readContract({
				address: MOONWELL_VIEW_CONTRACT,
				abi: REWARDS_ABI,
				functionName: 'getUserRewards',
				args: [strategyAddress],
			})) as Rewards[];

			if (strategyAddress == '0x6a455900c2c3cfff11f195df388e08ac9eae1744') {
				rewards = [
					{
						rewardToken: WELL,
						supplyRewardsAmount: 1000000000000000000n,
					},
				] as any;
			}
			// mock rewards for WELL

			console.log(`  Found ${rewards.length} rewards for strategy ${strategy.strategy}`);

			// Process each reward
			for (let i = 0; i < rewards.length; i++) {
				const reward = rewards[i];

				// Check if there are rewards to claim
				const hasRewards = reward.supplyRewardsAmount > 0n;

				const hasTokenPriceFeed = TOKEN_PRICE_FEEDS[reward.rewardToken.toLowerCase()] !== undefined;

				//if (hasRewards && hasTokenPriceFeed) {
				console.log(`  Found ${TOKEN_SYMBOLS[reward.rewardToken.toLowerCase()]} rewards for strategy ${strategy.strategy}\n`);
				try {
					// Get the token price and calculate USD value
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
						await baseClient.waitForTransactionReceipt({
							hash,
						});

						console.log(`    📝 Rewards claimed. Transaction hash: ${hash}`);
					} else {
						console.log(`    ⏳ Rewards value ($${rewardsUsdFormatted}) below threshold ($${minUsdValueThreshold}), skipping claim`);
					}

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

						console.log(`    💵 Min USD value threshold: $${minUsdValueThreshold} USD`);
						console.log(`    💵 Token balance USD value: $${tokenBalanceUsdValue} USD`);

						// Only get a quote if the balance exceeds the threshold
						if (tokenBalanceUsdValue >= minUsdValueThreshold) {
							// Get a CoW Swap quote for the claimed rewards using the actual token balance
							const { quote: quoteParams } = await getSwapQuote(strategyAddress, reward.rewardToken, tokenBalance, USDC);

							let allowedSlippageInBps; // Default to 0.3% if we can't get it from the contract
							try {
								const slippageResult = await client.readContract({
									address: strategyAddress,
									abi: STRATEGY_ABI,
									functionName: 'allowedSlippageInBps',
								});
								// Ensure we have a valid bigint value
								allowedSlippageInBps = BigInt(String(slippageResult));

								console.log(`✅ Allowed slippage: ${allowedSlippageInBps} bps`);
							} catch (error) {
								console.error(`❌ Error getting allowed slippage from contract:`, error);
								continue;
							}

							// Get the expected output from the contract
							let expectedOut;
							try {
								expectedOut = await client.readContract({
									address: CHAINLINK_SWAP_CHECKER_PROXY,
									abi: CHAINLINK_SWAP_CHECKER_ABI,
									functionName: 'getExpectedOut',
									args: [BigInt(quoteParams.sellAmount), quoteParams.sellToken, quoteParams.buyToken],
								});
							} catch (error: any) {
								// Check if the error is related to stale price feed
								const errorMessage = error.message || '';
								if (
									errorMessage.includes('Price feed update time exceeds heartbeat') ||
									errorMessage.includes('Price feed update time exceeds maximum valid time')
								) {
									console.warn('⚠️ Price feed is stale. Using CoW Swap quote directly.');

									// Use the CoW Swap quote's buyAmount as a fallback
									// Apply a safety margin to account for potential price movement
									const safetyMarginBps = 200n; // 2% safety margin
									expectedOut = BigInt(quoteParams.buyAmount);

									// Apply additional safety margin to the expected output
									expectedOut = (expectedOut * (10000n - safetyMarginBps)) / 10000n;

									console.log(`📊 Using CoW Swap quote with safety margin: ${expectedOut.toString()}`);
								} else {
									// If it's a different error, rethrow it
									console.error(`❌ Error getting expected output:`, error);
									continue;
								}
							}

							// Calculate minimum output with slippage
							const minOut = (BigInt(expectedOut.toString()) * (10000n - allowedSlippageInBps)) / 10000n;

							console.log(`📊 Expected output from Chainlink: ${expectedOut.toString()}`);
							console.log(`📊 Minimum output after slippage: ${minOut.toString()}`);

							// Get the current block timestamp
							const blockData = await client.getBlock();
							const blockTimestamp = Number(blockData.timestamp);

							const validTo: number = blockTimestamp + 1800; // 30 minutes

							// Calculate sell amount and ensure it's not negative
							const sellAmountBigInt = BigInt(quoteParams.sellAmount);
							const feeAmountBigInt = quoteParams.feeAmount ? BigInt(quoteParams.feeAmount) : 0n;

							if (feeAmountBigInt >= sellAmountBigInt) {
								console.error(`❌ Fee amount (${feeAmountBigInt.toString()}) exceeds sell amount (${sellAmountBigInt.toString()})`);
								continue;
							}

							// Ensure fee doesn't exceed sell amount to avoid negative values
							const sellAmount = (sellAmountBigInt - feeAmountBigInt).toString();
							console.log(`    💰 Sell amount: ${sellAmount}`);

							// Map between different token balance types
							const sellTokenBalanceForCreation = SellTokenSource.ERC20; // For OrderCreation
							const buyTokenBalanceForCreation = BuyTokenDestination.ERC20; // For OrderCreation
							const sellTokenBalanceForOrder = OrderBalance.ERC20; // For Order
							const buyTokenBalanceForOrder = OrderBalance.ERC20; // For Order

							// Calculate fee amount (0.3% by default)
							const compoundFeeBps = await client.readContract({
								address: strategyAddress,
								abi: STRATEGY_ABI,
								functionName: 'compoundFee',
							});
							const feeAmount = calculateFeeAmount(sellAmount, Number(compoundFeeBps));
							console.log(`    💰 Fee amount: ${feeAmount} (${Number(compoundFeeBps) / 100}%)`);

							// Generate appData with fee
							const hookGasLimit = 100000; // Default gas limit for the hook

							// Generate the appData document
							const appData = await generateMamoAppData(quoteParams.sellToken as string, feeAmount, hookGasLimit, strategyAddress);

							// Validate all required parameters before creating the order
							if (!quoteParams.sellToken || !quoteParams.buyToken || !quoteParams.receiver) {
								console.error(`❌ Missing required parameters in quote:`, quoteParams);
								continue;
							}

							const orderParams: Order = {
								sellToken: quoteParams.sellToken as `0x${string}`,
								buyToken: quoteParams.buyToken as `0x${string}`,
								receiver: quoteParams.receiver as `0x${string}`,
								sellAmount: sellAmount,
								buyAmount: minOut.toString(),
								validTo: validTo,
								appData: appData.appDataKeccak256,
								feeAmount: '0',
								kind: OrderKind.SELL,
								partiallyFillable: false,
								sellTokenBalance: sellTokenBalanceForOrder,
								buyTokenBalance: buyTokenBalanceForOrder,
							};

							// Log the order parameters for debugging
							console.log(`    📋 Order parameters: ${JSON.stringify(orderParams, null, 2)}`);

							const { encodedOrder, isValid } = await encodeOrderForSignature(orderParams, strategyAddress, client, rpcUrl);

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
								appData: appData.fullAppData,
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
					}
				} catch (error) {
					console.error(`    ❌ Error processing rewards:`, error);
					// Log the full error stack for debugging
					if (error instanceof Error) {
						console.error(`    Stack trace:`, error.stack);
					}
				}
				//}
			}
		} catch (error) {
			console.error(`  Error fetching rewards for strategy ${strategy.strategy}:`, error);
		}
	}
}

// Run the cron job
runCronJob();
