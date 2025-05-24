import { MoonwellApiResponse, MoonwellApiResponseSchema } from './moonwell-yield-types'

export class MoonwellService {
  constructor() {
    console.log('MoonwellService initialized')
  }

  public async getData(): Promise<{ data: MoonwellApiResponse; timestamp: Date }> {
    console.log('Fetching fresh Moonwell data from API...')
    const startTime = Date.now()

    try {
      // Fetch data from the API without a timeout
      const response = await fetch('https://yield-backend.moonwell.workers.dev/')

      if (!response.ok) {
        throw new Error(`Failed to fetch Moonwell data: ${response.statusText}`)
      }

      const data = await response.json()
      const parsedData = MoonwellApiResponseSchema.parse(data)
      const timestamp = new Date()
      const requestDuration = Date.now() - startTime

      console.log('Moonwell API request completed in', requestDuration, 'ms')

      return { data: parsedData, timestamp }
    } catch (error) {
      const requestDuration = Date.now() - startTime
      console.error(`Moonwell API request failed after ${requestDuration} ms:`, error)
      throw error
    }
  }

  /**
   * Returns the USDC market and vault APY percentages from the Moonwell API response.
   * @param data MoonwellApiResponse
   * @returns { market: number, vault: number }
   */
  public getUsdcApyPercentages(data: MoonwellApiResponse): { market: number; vault: number } {
    const marketData = data.markets?.MOONWELL_USDC
    const vaultData = data.vaults?.mwUSDC

    if (!marketData || !vaultData) {
      throw new Error('Market or vault data not found')
    }

    const market = marketData.totalSupplyApr
    const vault = vaultData.totalApy

    return { market, vault }
  }
}
