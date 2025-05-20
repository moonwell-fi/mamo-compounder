import * as Sentry from '@sentry/node';
import { ensureString } from './functions';

const SENTRY_DSN = ensureString(process.env.SENTRY_DSN, 'SENTRY_DSN environment variable is required');

Sentry.init({
	dsn: SENTRY_DSN,

	// Setting this option to true will send default PII data to Sentry.
	// For example, automatic IP address collection on events
	sendDefaultPii: true,
});
