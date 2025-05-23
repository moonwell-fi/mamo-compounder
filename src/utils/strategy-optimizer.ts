import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { MAMO_INDEXER_API, STRATEGY_ABI } from '../constants'
import { MoonwellService } from '../services/moonwell'
import { getPosition, insertPosition, Position, updatePosition } from './database'

// Interface for APY data
interface APYData {
  marketAPY: number
  vaultAPY: number
  bestAPY: number
  bestSplit: {
    mToken: number
    vault: number
  }
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
    })) as bigint

    const splitVault = (await client.readContract({
      address: strategyAddress,
      abi: STRATEGY_ABI,
      functionName: 'splitVault',
    })) as bigint

    return {
      mToken: Number(splitMToken),
      vault: Number(splitVault),
    }
  } catch (error) {
    console.error(`❌ Error getting current split for strategy ${strategyAddress}:`, error)
    throw error
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
  console.log(`Updating strategy position for ${strategyAddress} with split ${splitMToken}/${splitVault}`)
  try {
    // Create wallet client
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    const walletClient = createWalletClient({
      chain: base,
      transport: http(rpcUrl),
      account,
    }) as any

    // Create base client for waiting for transactions
    const baseClient = createPublicClient({
      chain: base,
      transport: http(),
    }) as any

    // Call updatePosition on the strategy contract
    const hash = await walletClient.writeContract({
      address: strategyAddress,
      abi: STRATEGY_ABI,
      functionName: 'updatePosition',
      args: [splitMToken, splitVault],
    })

    // Wait for transaction receipt
    await baseClient.waitForTransactionReceipt({
      hash,
    })

    console.log(`✅ Position updated for strategy ${strategyAddress}. Transaction hash: ${hash}`)
    return hash
  } catch (error) {
    console.error(`❌ Error updating position for strategy ${strategyAddress}:`, error)
    throw error
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
    return { mToken: 10000, vault: 0 }
  }
  // If vault APY is better, allocate 100% to vault
  else if (vaultAPY > marketAPY) {
    return { mToken: 0, vault: 10000 }
  }
  // If they're equal, split 50/50
  else {
    return { mToken: 5000, vault: 5000 }
  }
}

/**
 * Fetches the USDC balance of a strategy from the indexer API
 * @param strategyAddress The address of the strategy
 * @returns The USDC balance of the strategy
 */
async function getStrategyUSDCBalance(strategyAddress: `0x${string}`): Promise<number> {
  try {
    console.log(`🔍 Fetching USDC balance for strategy ${strategyAddress}...`)

    const response = await fetch(`${MAMO_INDEXER_API}/strategy/${strategyAddress}/balance`)

    if (!response.ok) {
      throw new Error(`Failed to fetch strategy balance: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()

    // Sum up all token balances in the balance array
    const totalBalance = Array.isArray(data.balance)
      ? data.balance.reduce((sum: number, token: any) => sum + parseFloat(token.balance), 0)
      : 0

    console.log(`✅ Total balance for strategy ${strategyAddress}: ${totalBalance}`)
    return totalBalance
  } catch (error) {
    console.error(`❌ Error fetching USDC balance for strategy ${strategyAddress}:`, error)
    // If the balance check fails, we'll return 0 to skip the position update
    return 0
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
    const strategyAddress = strategy.strategy as `0x${string}`
    console.log(`\n🔍 Processing strategy optimization for ${strategyAddress}`)

    // Get the current position from the database
    const existingPosition = await getPosition(strategyAddress)

    // If the position doesn't exist in the database, get the current split from the contract and insert it
    if (!existingPosition) {
      console.log(`ℹ️ Strategy ${strategyAddress} not found in database, fetching current split from contract`)

      const currentSplit = await getCurrentSplit(client, strategyAddress)

      // Insert the position into the database
      // Determine the best split based on the APY data
      const bestSplit = determineBestSplit(apyData.marketAPY, apyData.vaultAPY)

      // Check if the current split matches the best split
      const currentSplitMatchesBest = currentSplit.mToken === bestSplit.mToken && currentSplit.vault === bestSplit.vault

      console.log(`ℹ️ Current split: ${currentSplit.mToken}/${currentSplit.vault}`)
      console.log(`ℹ️ Best split: ${bestSplit.mToken}/${bestSplit.vault}`)
      console.log(`ℹ️ Current split matches best: ${currentSplitMatchesBest ? 'Yes' : 'No'}`)

      // Create the initial position record
      const newPosition: Position = {
        strategy_address: strategyAddress,
        split_mtoken: currentSplit.mToken,
        split_vault: currentSplit.vault,
        strategy_type: 'usdc_stablecoin', // Default type as specified
        last_updated: new Date(),
        apy: currentSplit.mToken > currentSplit.vault ? apyData.marketAPY : apyData.vaultAPY,
      }

      console.log(`ℹ️ Current split needs to be updated to the optimal split`)

      // Check if the strategy has any USDC balance before updating position
      const usdcBalance = await getStrategyUSDCBalance(strategyAddress)

      if (usdcBalance > 0) {
        console.log(`ℹ️ Strategy has USDC balance (${usdcBalance}), proceeding with position update`)

        // Update the position in the contract
        await updateStrategyPosition(rpcUrl, privateKey, strategyAddress, bestSplit.mToken, bestSplit.vault)

        // Update the split in the new position record
        newPosition.split_mtoken = bestSplit.mToken
        newPosition.split_vault = bestSplit.vault
      } else {
        console.log(`ℹ️ Skipping position update for strategy ${strategyAddress} due to zero USDC balance`)
      }

      // Insert the position with the updated split
      await insertPosition(newPosition)
      console.log(
        `✅ Inserted new position for strategy ${strategyAddress} with split ${newPosition.split_mtoken}/${newPosition.split_vault}`
      )
    }
    // If the position exists, check if the APY has improved by at least 1%
    else {
      console.log(`ℹ️ Strategy ${strategyAddress} found in database`)
      // Determine the source of current APY based on split values
      const currentApySource = existingPosition.split_mtoken > existingPosition.split_vault ? 'MARKET' : 'VAULT'

      console.log(
        `ℹ️ Current split: ${existingPosition.split_mtoken}/${existingPosition.split_vault}, Current APY: ${existingPosition.apy}% (${currentApySource})`
      )

      // Determine the source of best APY
      const bestApySource = apyData.bestSplit.mToken > apyData.bestSplit.vault ? 'MARKET' : 'VAULT'
      console.log(`ℹ️ Best APY: ${apyData.bestAPY}% (${bestApySource})`)

      // Determine the best split based on the new APY data
      const bestSplit = determineBestSplit(apyData.marketAPY, apyData.vaultAPY)

      // Check if the current split already matches the best split
      const currentSplitMatchesBest =
        existingPosition.split_mtoken === bestSplit.mToken && existingPosition.split_vault === bestSplit.vault

      // Check if the new APY is at least 1% better than the stored APY
      const apyImprovement = apyData.bestAPY - existingPosition.apy
      const minImprovementThreshold = 1.0 // 1% improvement threshold
      const apyImproved = apyImprovement >= minImprovementThreshold

      console.log(
        `ℹ️ APY comparison: Current ${existingPosition.apy}% (${currentApySource}) vs New ${apyData.bestAPY}% (${bestApySource})`
      )
      console.log(`ℹ️ APY improvement: ${apyImprovement.toFixed(2)}% (threshold: ${minImprovementThreshold}%)`)
      console.log(`ℹ️ Current split: ${existingPosition.split_mtoken}/${existingPosition.split_vault}`)
      console.log(`ℹ️ Best split: ${bestSplit.mToken}/${bestSplit.vault}`)
      console.log(`ℹ️ Current split matches best: ${currentSplitMatchesBest ? 'Yes' : 'No'}`)

      // Update the database with the new APY regardless
      const updatedPosition: Position = {
        ...existingPosition,
        apy: apyData.bestAPY,
        last_updated: new Date(),
      }

      // Only update the position if:
      // 1. The APY has improved significantly AND
      // 2. The current split doesn't match the best split
      if (apyImproved && !currentSplitMatchesBest) {
        // Determine the source of APYs
        const currentApySource = existingPosition.split_mtoken > existingPosition.split_vault ? 'MARKET' : 'VAULT'
        const bestApySource = apyData.bestSplit.mToken > apyData.bestSplit.vault ? 'MARKET' : 'VAULT'

        console.log(`✅ APY improved by ${apyImprovement.toFixed(2)}% and current split needs to be updated`)
        console.log(`✅ Changing from ${existingPosition.apy}% (${currentApySource}) to ${apyData.bestAPY}% (${bestApySource})`)

        // Check if the strategy has any USDC balance before updating position
        const usdcBalance = await getStrategyUSDCBalance(strategyAddress)

        if (usdcBalance > 0) {
          if (usdcBalance < 0.5) {
            console.log(`ℹ️ Skipping position update for strategy ${strategyAddress} due to low USDC balance (${usdcBalance})`)
          } else {
            console.log(`ℹ️ Strategy has USDC balance (${usdcBalance}), proceeding with position update`)

            // Update the position in the contract
            await updateStrategyPosition(rpcUrl, privateKey, strategyAddress, bestSplit.mToken, bestSplit.vault)

            // Update the split in the database
            updatedPosition.split_mtoken = bestSplit.mToken
            updatedPosition.split_vault = bestSplit.vault
            await updatePosition(updatedPosition)
            console.log(`✅ Updated position for strategy ${strategyAddress} with APY ${apyData.bestAPY}%`)
          }
        } else {
          // Don't update the database if we don't update the position
          console.log(`ℹ️ Skipping position update for strategy ${strategyAddress} due to zero USDC balance`)
        }

      } else {
        if (!apyImproved) {
          // Determine the source of APYs
          const currentApySource = existingPosition.split_mtoken > existingPosition.split_vault ? 'MARKET' : 'VAULT'
          const bestApySource = apyData.bestSplit.mToken > apyData.bestSplit.vault ? 'MARKET' : 'VAULT'

          if (apyImprovement < 0) {
            console.log(`ℹ️ New APY is lower than current APY by ${Math.abs(apyImprovement).toFixed(2)}%, skipping position update`)
            console.log(`ℹ️ Current: ${existingPosition.apy}% (${currentApySource}) vs New: ${apyData.bestAPY}% (${bestApySource})`)
          } else {
            console.log(
              `ℹ️ APY improvement (${apyImprovement.toFixed(
                2
              )}%) is below threshold (${minImprovementThreshold}%), skipping position update`
            )
          }
        } else if (currentSplitMatchesBest) {
          console.log(
            `ℹ️ Current split (${existingPosition.split_mtoken}/${existingPosition.split_vault}) already matches best split, skipping position update`
          )
        }

        console.log(`ℹ️ No changes made to strategy ${strategyAddress} or database`)
      }
    }
  } catch (error) {
    console.error(`❌ Error processing strategy optimization for ${strategy.strategy}:`, error)
  }
}

/**
 * Get APY data from Moonwell
 * @returns The APY data
 */
export async function getAPYData(): Promise<APYData> {
  try {
    console.log('🔍 Fetching APY data from Moonwell...')


    const moonwellService = new MoonwellService()
    const { data, timestamp } = await moonwellService.getData()
    // Get USDC APY percentages
    const { market: marketAPY, vault: vaultAPY } = moonwellService.getUsdcApyPercentages(data)

    console.log(`✅ MOONWELL_USDC Market APY: ${marketAPY}% (MARKET)`)
    console.log(`✅ mwUSDC Vault APY: ${vaultAPY}% (VAULT)`)

    // Determine the best APY and split
    const bestAPY = Math.max(marketAPY, vaultAPY)
    const bestSplit = determineBestSplit(marketAPY, vaultAPY)

    // Determine the source of best APY
    const bestApySource = bestSplit.mToken > bestSplit.vault ? 'MARKET' : 'VAULT'
    console.log(`✅ Best APY: ${bestAPY}% (${bestApySource}) with split ${bestSplit.mToken}/${bestSplit.vault}`)

    return {
      marketAPY,
      vaultAPY,
      bestAPY,
      bestSplit,
    }
  } catch (error) {
    console.error('❌ Error getting APY data:', error)
    throw error
  }
}
