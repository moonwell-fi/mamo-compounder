import { parseAbi } from 'viem';
import ERC20MoonwellMorphoStrategyABI from '../abi/ERC20MoonwellMorphoStrategy.json';

// Contract addresses
export const MOONWELL_VIEW_CONTRACT = '0x6834770ABA6c2028f448E3259DDEE4BCB879d459';
export const UNITROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C';
export const WELL = '0xA88594D404727625A9437C3f886C7643872296AE';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const CHAINLINK_WELL_USD = '0xc15d9944dAefE2dB03e53bef8DDA25a56832C5fe';

// ABIs
export const REWARDS_ABI = parseAbi([
	'struct Rewards { address market; address rewardToken; uint256 supplyRewardsAmount; uint256 borrowRewardsAmount; }',
	'function getUserRewards(address user) external view returns (Rewards[] memory)',
]);

export const UNITROLLER_ABI = parseAbi(['function claimReward(address holder) public']);
export const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
export const CHAINLINK_ABI = parseAbi([
	'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

// Token mappings
export const TOKEN_PRICE_FEEDS: Record<string, string> = {
	[WELL.toLowerCase()]: CHAINLINK_WELL_USD,
	// Add more token price feeds here as needed
};

export const TOKEN_SYMBOLS: Record<string, string> = {
	[WELL.toLowerCase()]: 'WELL',
	// Add more token symbols here as needed
};

// Other constants
export const APP_DATA = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const ERC20_BALANCE = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9';
export const KIND_SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775';
export const MAGIC_VALUE = '0x1626ba7e';
export const STRATEGY_ABI = ERC20MoonwellMorphoStrategyABI;
