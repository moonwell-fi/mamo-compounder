/**
 * Ensure a value is a string
 */
export function ensureString(value: any, message: string | undefined = undefined): string {
	if (!value) {
		throw new Error(message || 'Value is undefined');
	}
	return value;
}
