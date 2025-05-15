import { createPublicClient, http, createWalletClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { STRATEGY_ABI } from '../constants';
import { getPosition, insertPosition, updatePosition, Position } from './database';

// Interface for APY data
interface APYData {
	marketAPY: number;
	vaultAPY: number;
	bestAPY: number;
	bestSplit: {
		mToken: number;
		vault: number;
	};
}

/**
 * Get the current split values from a strategy contract
 * @param client The viem public client
 * @param strategyAddress The strategy address
 * @returns The current split values
 */
async function getCurrentSplit(client: any, strategyAddress: `0x${string}`): Promise<{ mToken: number; vault: number }> {
	try {
		const splitMToken = (await client.readContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'splitMToken',
		})) as bigint;

		const splitVault = (await client.readContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'splitVault',
		})) as bigint;

		return {
			mToken: Number(splitMToken),
			vault: Number(splitVault),
		};
	} catch (error) {
		console.error(`❌ Error getting current split for strategy ${strategyAddress}:`, error);
		throw error;
	}
}

/**
 * Update the position in the strategy contract
 * @param rpcUrl The RPC URL
 * @param privateKey The private key for signing transactions
 * @param strategyAddress The strategy address
 * @param splitMToken The new mToken split
 * @param splitVault The new vault split
 * @returns The transaction hash
 */
async function updateStrategyPosition(
	rpcUrl: string,
	privateKey: string,
	strategyAddress: `0x${string}`,
	splitMToken: number,
	splitVault: number
): Promise<`0x${string}`> {
	try {
		// Create wallet client
		const account = privateKeyToAccount(privateKey as `0x${string}`);
		const walletClient = createWalletClient({
			chain: base,
			transport: http(rpcUrl),
			account,
		}) as any;

		// Create base client for waiting for transactions
		const baseClient = createPublicClient({
			chain: base,
			transport: http(),
		}) as any;

		// Call updatePosition on the strategy contract
		const hash = await walletClient.writeContract({
			address: strategyAddress,
			abi: STRATEGY_ABI,
			functionName: 'updatePosition',
			args: [BigInt(splitMToken), BigInt(splitVault)],
		});

		// Wait for transaction receipt
		await baseClient.waitForTransactionReceipt({
			hash,
		});

		console.log(`✅ Position updated for strategy ${strategyAddress}. Transaction hash: ${hash}`);
		return hash;
	} catch (error) {
		console.error(`❌ Error updating position for strategy ${strategyAddress}:`, error);
		throw error;
	}
}

/**
 * Determine the best split based on APY comparison
 * @param marketAPY The market APY
 * @param vaultAPY The vault APY
 * @returns The best split values
 */
function determineBestSplit(marketAPY: number, vaultAPY: number): { mToken: number; vault: number } {
	// If market APY is better, allocate 100% to market (mToken)
	if (marketAPY > vaultAPY) {
		return { mToken: 100, vault: 0 };
	}
	// If vault APY is better, allocate 100% to vault
	else if (vaultAPY > marketAPY) {
		return { mToken: 0, vault: 100 };
	}
	// If they're equal, split 50/50
	else {
		return { mToken: 50, vault: 50 };
	}
}

/**
 * Process a strategy by checking APYs and updating position if needed
 * @param client The viem public client
 * @param strategy The strategy to process
 * @param apyData The APY data
 * @param rpcUrl The RPC URL
 * @param privateKey The private key for signing transactions
 */
export async function processStrategyOptimization(
	client: any,
	strategy: { strategy: string },
	apyData: APYData,
	rpcUrl: string,
	privateKey: string
): Promise<void> {
	try {
		const strategyAddress = strategy.strategy as `0x${string}`;
		console.log(`\n🔍 Processing strategy optimization for ${strategyAddress}`);

		// Get the current position from the database
		const existingPosition = await getPosition(strategyAddress);

		// If the position doesn't exist in the database, get the current split from the contract and insert it
		if (!existingPosition) {
			console.log(`ℹ️ Strategy ${strategyAddress} not found in database, fetching current split from contract`);

			const currentSplit = await getCurrentSplit(client, strategyAddress);

			// Insert the position into the database
			const newPosition: Position = {
				strategy_address: strategyAddress,
				split_mtoken: currentSplit.mToken,
				split_vault: currentSplit.vault,
				strategy_type: 'usdc_stablecoin', // Default type as specified
				last_updated: new Date(),
				apy: Math.max(apyData.marketAPY, apyData.vaultAPY), // Store the best APY
			};

			await insertPosition(newPosition);
			console.log(`✅ Inserted new position for strategy ${strategyAddress}`);

			// Check if the current split matches the best split
			const bestSplit = determineBestSplit(apyData.marketAPY, apyData.vaultAPY);

			if (currentSplit.mToken !== bestSplit.mToken || currentSplit.vault !== bestSplit.vault) {
				console.log(
					`ℹ️ Current split (${currentSplit.mToken}/${currentSplit.vault}) doesn't match best split (${bestSplit.mToken}/${bestSplit.vault})`
				);

				// Update the position in the contract
				await updateStrategyPosition(rpcUrl, privateKey, strategyAddress, bestSplit.mToken, bestSplit.vault);

				// Update the position in the database
				const updatedPosition: Position = {
					...newPosition,
					split_mtoken: bestSplit.mToken,
					split_vault: bestSplit.vault,
					last_updated: new Date(),
				};

				await updatePosition(updatedPosition);
				console.log(`✅ Updated position for strategy ${strategyAddress} to ${bestSplit.mToken}/${bestSplit.vault}`);
			} else {
				console.log(`✅ Current split (${currentSplit.mToken}/${currentSplit.vault}) already matches best split`);
			}
		}
		// If the position exists, check if the APY has improved by at least 1%
		else {
			console.log(`ℹ️ Strategy ${strategyAddress} found in database`);
			console.log(
				`ℹ️ Current split: ${existingPosition.split_mtoken}/${existingPosition.split_vault}, Current APY: ${existingPosition.apy}%`
			);
			console.log(`ℹ️ Best APY: ${apyData.bestAPY}%`);

			// Check if the new APY is at least 1% better than the stored APY
			const apyImprovement = apyData.bestAPY - existingPosition.apy;
			const minImprovementThreshold = 1.0; // 1% improvement threshold

			if (apyImprovement >= minImprovementThreshold) {
				console.log(
					`✅ New APY (${apyData.bestAPY}%) is better than stored APY (${existingPosition.apy}%) by ${apyImprovement.toFixed(2)}%`
				);

				// Determine the best split based on the new APY data
				const bestSplit = determineBestSplit(apyData.marketAPY, apyData.vaultAPY);

				// Check if the current split already matches the best split
				if (existingPosition.split_mtoken === bestSplit.mToken && existingPosition.split_vault === bestSplit.vault) {
					console.log(`ℹ️ Current split (${existingPosition.split_mtoken}/${existingPosition.split_vault}) already matches best split`);

					// Update only the APY in the database
					const updatedPosition: Position = {
						...existingPosition,
						apy: apyData.bestAPY,
						last_updated: new Date(),
					};

					await updatePosition(updatedPosition);
					console.log(`✅ Updated APY for strategy ${strategyAddress} to ${apyData.bestAPY}%`);
				} else {
					console.log(
						`ℹ️ Current split (${existingPosition.split_mtoken}/${existingPosition.split_vault}) doesn't match best split (${bestSplit.mToken}/${bestSplit.vault})`
					);

					// Update the position in the contract
					await updateStrategyPosition(rpcUrl, privateKey, strategyAddress, bestSplit.mToken, bestSplit.vault);

					// Update the position in the database
					const updatedPosition: Position = {
						...existingPosition,
						split_mtoken: bestSplit.mToken,
						split_vault: bestSplit.vault,
						apy: apyData.bestAPY,
						last_updated: new Date(),
					};

					await updatePosition(updatedPosition);
					console.log(
						`✅ Updated position for strategy ${strategyAddress} to ${bestSplit.mToken}/${bestSplit.vault} with APY ${apyData.bestAPY}%`
					);
				}
			} else {
				console.log(
					`ℹ️ New APY (${apyData.bestAPY}%) is not significantly better than stored APY (${
						existingPosition.apy
					}%), improvement: ${apyImprovement.toFixed(2)}%`
				);
			}
		}
	} catch (error) {
		console.error(`❌ Error processing strategy optimization for ${strategy.strategy}:`, error);
	}
}

/**
 * Get APY data from Moonwell
 * @returns The APY data
 */
export async function getAPYData(): Promise<APYData> {
	try {
		console.log('🔍 Fetching APY data from Moonwell...');

		// Fetch data from Moonwell API
		const response = await fetch('https://yield-backend.moonwell.workers.dev/');

		if (!response.ok) {
			throw new Error(`Failed to fetch Moonwell data: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();

		// Extract USDC opportunities
		const marketData = data.markets?.MOONWELL_USDC;
		const vaultData = data.vaults?.mwUSDC;

		if (!marketData || !vaultData) {
			throw new Error('Could not find USDC market or vault data');
		}

		// Extract APYs
		const marketAPY = marketData.totalSupplyApr;
		const vaultAPY = vaultData.totalApy;

		if (marketAPY === undefined || vaultAPY === undefined) {
			throw new Error('APY data is missing');
		}

		console.log(`✅ MOONWELL_USDC Market APY: ${marketAPY}%`);
		console.log(`✅ mwUSDC Vault APY: ${vaultAPY}%`);

		// Determine the best APY and split
		const bestAPY = Math.max(marketAPY, vaultAPY);
		const bestSplit = determineBestSplit(marketAPY, vaultAPY);

		console.log(`✅ Best APY: ${bestAPY}% with split ${bestSplit.mToken}/${bestSplit.vault}`);

		return {
			marketAPY,
			vaultAPY,
			bestAPY,
			bestSplit,
		};
	} catch (error) {
		console.error('❌ Error getting APY data:', error);
		throw error;
	}
}
