import * as Sentry from '@sentry/node';

const SENTRY_DSN = process.env.SENTRY_DSN;

Sentry.init({
	dsn: SENTRY_DSN,
	enabled: SENTRY_DSN !== undefined,

	// Setting this option to true will send default PII data to Sentry.
	// For example, automatic IP address collection on events
	sendDefaultPii: true,
});
