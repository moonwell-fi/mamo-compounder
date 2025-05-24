import { MoonwellService } from '../services/moonwell'

/**
 * Script to initialize MoonwellService and print USDC APYs
 */
async function main() {
  console.log('🚀 Starting Moonwell USDC APY fetcher...\n')

  try {
    // Initialize the MoonwellService
    const moonwellService = new MoonwellService()

    // Fetch data from the Moonwell API
    const { data, timestamp } = await moonwellService.getData()

    // Get USDC APY percentages
    const { market, vault } = moonwellService.getUsdcApyPercentages(data)

    // Print formatted results
    console.log('='.repeat(60))
    console.log('📊 MOONWELL USDC APY REPORT')
    console.log('='.repeat(60))
    console.log(`🕐 Timestamp: ${timestamp.toISOString()}`)
    console.log(`🕐 Local Time: ${timestamp.toLocaleString()}`)
    console.log('-'.repeat(60))

    if (market !== undefined) {
      console.log(`💰 MOONWELL_USDC Market APY: ${market.toFixed(4)}%`)
    } else {
      console.log('❌ MOONWELL_USDC Market APY: Not available')
    }

    if (vault !== undefined) {
      console.log(`🏦 mwUSDC Vault APY: ${vault.toFixed(4)}%`)
    } else {
      console.log('❌ mwUSDC Vault APY: Not available')
    }

    // Determine the best option
    if (market !== undefined && vault !== undefined) {
      console.log('-'.repeat(60))
      if (market > vault) {
        console.log(`🏆 Best Option: MOONWELL_USDC Market (${market.toFixed(4)}% > ${vault.toFixed(4)}%)`)
        console.log(`📈 APY Difference: +${(market - vault).toFixed(4)}% in favor of Market`)
      } else if (vault > market) {
        console.log(`🏆 Best Option: mwUSDC Vault (${vault.toFixed(4)}% > ${market.toFixed(4)}%)`)
        console.log(`📈 APY Difference: +${(vault - market).toFixed(4)}% in favor of Vault`)
      } else {
        console.log(`🤝 Both options have equal APY: ${market.toFixed(4)}%`)
      }

      console.log(`💎 Recommended Allocation: ${market > vault ? '100% Market' : vault > market ? '100% Vault' : '50% Market / 50% Vault'}`)
    }

    console.log('='.repeat(60))
    console.log('✅ Report completed successfully!')

  } catch (error) {
    console.error('❌ Error fetching Moonwell APY data:', error)
    process.exit(1)
  }
}

// Run the script if called directly
if (require.main === module) {
  main().catch(console.error)
}

export { main }

