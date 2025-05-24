import { z } from 'zod'

// Zod schemas for the API response
const TokenSchema = z.object({
  address: z.string(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number()
})

const ValueWithDecimalsSchema = z.object({
  value: z.string(),
  decimals: z.number()
})

const RewardSchema = z.object({
  token: TokenSchema,
  supplyApr: z.number(),
  borrowApr: z.number(),
  liquidStakingApr: z.number()
})

const MarketSchema = z.object({
  marketKey: z.string(),
  deprecated: z.boolean(),
  mintPaused: z.boolean(),
  borrowPaused: z.boolean(),
  seizePaused: z.boolean(),
  transferPaused: z.boolean(),
  marketToken: TokenSchema,
  underlyingToken: TokenSchema,
  collateralFactor: z.number(),
  reserveFactor: z.number(),
  exchangeRate: z.number(),
  underlyingPrice: z.number(),
  supplyCaps: ValueWithDecimalsSchema,
  supplyCapsUsd: z.number(),
  borrowCaps: ValueWithDecimalsSchema,
  borrowCapsUsd: z.number(),
  totalSupply: ValueWithDecimalsSchema,
  totalSupplyUsd: z.number(),
  totalBorrows: ValueWithDecimalsSchema,
  totalBorrowsUsd: z.number(),
  totalReserves: ValueWithDecimalsSchema,
  totalReservesUsd: z.number(),
  cash: ValueWithDecimalsSchema,
  baseSupplyApy: z.number(),
  baseBorrowApy: z.number(),
  totalSupplyApr: z.number(),
  totalBorrowApr: z.number(),
  rewards: z.array(RewardSchema)
})

const MarketRewardSchema = z.object({
  asset: TokenSchema,
  supplyApr: z.number(),
  supplyAmount: z.number(),
  borrowApr: z.number(),
  borrowAmount: z.number()
})

const MarketAllocationSchema = z.object({
  marketId: z.string(),
  allocation: z.number(),
  marketCollateral: TokenSchema,
  marketApy: z.number(),
  marketLiquidity: ValueWithDecimalsSchema,
  marketLiquidityUsd: z.number(),
  marketLoanToValue: z.number(),
  totalSupplied: ValueWithDecimalsSchema,
  totalSuppliedUsd: z.number(),
  rewards: z.array(MarketRewardSchema)
})

const VaultSchema = z.object({
  vaultKey: z.string(),
  vaultToken: TokenSchema,
  underlyingToken: TokenSchema,
  underlyingPrice: z.number(),
  baseApy: z.number(),
  totalApy: z.number(),
  rewardsApy: z.number(),
  curators: z.array(z.unknown()),
  performanceFee: z.number(),
  timelock: z.number(),
  totalLiquidity: ValueWithDecimalsSchema,
  totalLiquidityUsd: z.number(),
  totalSupply: ValueWithDecimalsSchema,
  totalSupplyUsd: z.number(),
  markets: z.array(MarketAllocationSchema),
  rewards: z.array(MarketRewardSchema)
})

export const MoonwellApiResponseSchema = z.object({
  markets: z.record(z.string(), MarketSchema),
  vaults: z.record(z.string(), VaultSchema)
})

export type MoonwellApiResponse = z.infer<typeof MoonwellApiResponseSchema>

export type Reward = z.infer<typeof RewardSchema>
export type MarketReward = z.infer<typeof MarketRewardSchema>
