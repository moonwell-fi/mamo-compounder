import { MetadataApi } from '@cowprotocol/app-data';
import { generateAppDataFromDoc } from '@cowprotocol/cow-sdk';
import { keccak256, toHex } from 'viem';

// Define a type for the app data document returned by the API
type AppDataDocument = any; // Using 'any' for now since we don't know the exact structure

export const metadataApi = new MetadataApi();

/**
 * Generate a hash from an object
 * @param obj The object to hash
 * @returns The hash as a hex string
 */
function generateHash(jsonStr: string): string {
	// Convert the string to bytes
	const bytes = new TextEncoder().encode(jsonStr);
	// Hash the bytes using keccak256
	const hash = keccak256(bytes);
	// Return the hash as a hex string
	return hash;
}

/**
 * Generate the exact appData JSON string that the contract expects
 * @param callData The callData for the pre-hook
 * @param gasLimit The gas limit for the pre-hook
 * @param target The target address for the pre-hook
 * @returns The appData JSON string
 */
function generateExactAppDataJson(callData: string, gasLimit: string, target: string): string {
	// Ensure target is lowercase to match contract expectations
	const targetLower = target.toLowerCase();

	// Format exactly as the contract expects
	return `{"appCode":"Mamo","metadata":{"hooks":{"pre":[{"callData":"${callData}","gasLimit":"${gasLimit}","target":"${targetLower}"}],"version":"0.1.0"}},"version":"1.3.0"}`;
}

/**
 * Generates appData for Mamo strategy orders
 * @param sellToken The address of the token being sold
 * @param feeRecipient The address that will receive the fee
 * @param feeAmount The amount of fee to be taken (as a string)
 * @param hookGasLimit The gas limit for the pre-hook
 * @param from The address from which the transfer is made
 * @returns The generated appData document
 */
export async function generateMamoAppData(
	sellToken: string,
	feeRecipient: string,
	feeAmount: string,
	hookGasLimit: number,
	from: string
): Promise<AppDataDocument> {
	try {
		// Validate inputs
		if (!sellToken || !feeRecipient || !from) {
			throw new Error('Missing required parameters for generateMamoAppData');
		}

		// Create the transferFrom calldata for the pre-hook
		// IERC20.transferFrom selector is 0x23b872dd
		// We need to encode: transferFrom(from, feeRecipient, feeAmount)

		// Create the hooks metadata
		const hooks = {
			pre: [
				{
					// Create a placeholder for the callData that matches the format expected by the contract
					callData: createTransferFromCalldata(from, feeRecipient, feeAmount),
					gasLimit: hookGasLimit.toString(),
					target: sellToken.toLowerCase(),
				},
			],
			version: '0.1.0',
		};

		// Create the hooks metadata
		const callData = createTransferFromCalldata(from, feeRecipient, feeAmount);
		const gasLimitStr = hookGasLimit.toString();

		// Use the MetadataApi to generate the appData document in the format CoW Swap expects
		try {
			// Register the appData with CoW Swap's API
			const appDataDoc = await metadataApi.generateAppDataDoc({
				appCode: 'Mamo',
				metadata: {
					hooks,
				},
				version: '1.3.0',
			});

			// generate app data
			const appData = await generateAppDataFromDoc(appDataDoc);
			console.log('Generated appData:', appData);

			return appData.appDataKeccak256;
		} catch (error) {
			console.error('Error registering appData with CoW Swap:', error);

			// If registration fails, return a default document
			return {
				appCode: 'Mamo',
				appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
				metadata: { hooks },
				version: '1.3.0',
			};
		}
	} catch (error) {
		console.error('Error generating Mamo appData:', error);
		// Return a default appData document with a valid hash format to prevent crashes
		return {
			appCode: 'Mamo',
			appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
			metadata: { hooks: {} },
			version: '1.0.0',
		};
	}
}

/**
 * Creates a transferFrom calldata string
 * @param from The address from which the transfer is made
 * @param recipient The recipient address
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

// This file is now compatible with Cloudflare Workers environment
