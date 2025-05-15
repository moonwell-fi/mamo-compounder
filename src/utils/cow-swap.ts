import { createPublicClient, http, encodeAbiParameters, decodeErrorResult } from 'viem';
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
	COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
} from '@cowprotocol/cow-sdk';
import { hashOrder, domain, Order } from '@cowprotocol/contracts';

import { CHAINLINK_ABI, TOKEN_PRICE_FEEDS, TOKEN_SYMBOLS, ERC20_BALANCE, KIND_SELL, MAGIC_VALUE, STRATEGY_ABI } from '../constants';

// Create a single instance of OrderBookApi for CoW Swap
const cowSwapOrderBookApi = new OrderBookApi({ chainId: SupportedChainId.BASE });

/**
 * Get the symbol for a token address
 * @param tokenAddress The token address
 * @returns The token symbol or the shortened address if not found
 */
export function getTokenSymbol(tokenAddress: string): string {
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
export async function calculateTokenPriceInUsd(
	client: ReturnType<typeof createPublicClient>,
	tokenAddress: string,
	amount: bigint
): Promise<{ priceUsd: string; rewardsUsdFormatted: string }> {
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
export async function encodeOrderForSignature(
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
export async function getSwapQuote(strategy: string, sellToken: string, sellAmount: bigint, buyToken: string): Promise<any> {
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
 * Submit an order to CoW Swap
 * @param orderCreation The order creation parameters
 * @param encodedOrder The encoded order for signature
 * @returns The order response
 */
export async function submitOrderToCowSwap(orderCreation: any, encodedOrder: `0x${string}`): Promise<any> {
	try {
		const orderResponse = await cowSwapOrderBookApi.sendOrder({
			...orderCreation,
			signature: encodedOrder,
		});

		return orderResponse;
	} catch (error) {
		console.error(`    ❌ Error submitting order to CoW Swap:`, error);
		throw error;
	}
}
