import { MetadataApi } from '@cowprotocol/app-data';
import { AppDataInfo, generateAppDataFromDoc } from '@cowprotocol/cow-sdk';
import { FEE_RECIPIENT } from '../constants';

export const metadataApi = new MetadataApi();

/**
 * Generates appData for Mamo strategy orders
 * @param sellToken The address of the token being sold
 * @param feeRecipient The address that will receive the fee (this parameter is ignored, using FEE_RECIPIENT constant instead)
 * @param feeAmount The amount of fee to be taken (as a string)
 * @param hookGasLimit The gas limit for the pre-hook
 * @param from The address from which the transfer is made
 * @returns The generated appData document
 */
export async function generateMamoAppData(
	sellToken: string,
	feeAmount: string,
	hookGasLimit: BigInt,
	from: string
): Promise<Pick<AppDataInfo, 'fullAppData' | 'appDataKeccak256'>> {
	// Create the hooks metadata
	const hooks = {
		pre: [
			{
				// Create a placeholder for the callData that matches the format expected by the contract
				// Use FEE_RECIPIENT constant instead of the feeRecipient parameter
				callData: createTransferFromCalldata(from, FEE_RECIPIENT, feeAmount),
				gasLimit: hookGasLimit.toString(),
				target: sellToken.toLowerCase(),
			},
		],
		version: '0.1.0',
	};

	// Use the MetadataApi to generate the appData document in the format CoW Swap expects
	// Register the appData with CoW Swap's API
	const appDataDoc = await metadataApi.generateAppDataDoc({
		appCode: 'Mamo',
		metadata: {
			hooks,
		},
	});

	// generate app data
	const appData = await generateAppDataFromDoc(appDataDoc);
	console.log('Generated appData:', appData);

	return appData;
}

/**
 * Creates a transferFrom calldata string
 * @param from The address from which the transfer is made
 * @param recipient The address that will receive the fee
 * @param feeAmount The amount to transfer as fee
 * @returns The calldata as a hex string
 */
function createTransferFromCalldata(from: string, recipient: string, feeAmount: string): string {
	// IERC20.transferFrom selector is 0x23b872dd
	// We need to encode: transferFrom(from, recipient, amount)

	// Pad addresses to 32 bytes (64 hex chars)
	const paddedFrom = padAddress(from);
	const paddedTo = padAddress(recipient);

	// Convert amount to hex and pad to 32 bytes
	const paddedAmount = padUint256(feeAmount);

	// Combine the parts
	const calldata = '0x23b872dd' + paddedFrom + paddedTo + paddedAmount;

	console.log('Generated calldata:', calldata);

	return calldata;
}

/**
 * Pads an address to 32 bytes (64 hex chars)
 * @param addr The address to pad
 * @returns The padded address
 */
function padAddress(addr: string): string {
	// Remove '0x' prefix if present
	const cleanAddress = addr.startsWith('0x') ? addr.slice(2) : addr;

	// Pad to 64 characters (32 bytes)
	return '0'.repeat(64 - cleanAddress.length) + cleanAddress;
}

/**
 * Pads a uint256 to 32 bytes (64 hex chars)
 * @param value The value to pad
 * @returns The padded value
 */
function padUint256(value: string): string {
	// Convert to hex
	const hexValue = BigInt(value).toString(16);
	// Pad to 64 characters (32 bytes)
	return '0'.repeat(64 - hexValue.length) + hexValue;
}

/**
 * Calculate fee amount based on sell amount and compound fee
 * @param sellAmount The amount being sold
 * @param compoundFeeBps The compound fee in basis points (e.g., 100 = 1%)
 * @returns The fee amount as a string
 */
export function calculateFeeAmount(sellAmount: string, compoundFeeBps: number): string {
	return ((BigInt(sellAmount) * BigInt(compoundFeeBps)) / BigInt(10000)).toString();
}
