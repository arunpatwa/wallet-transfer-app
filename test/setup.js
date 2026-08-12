/**
 * Runs before any test file is imported, which matters because config is read
 * and memoised at first import of the application modules.
 */
process.env.NODE_ENV = 'test';

// A separate database from development: these tests TRUNCATE between cases.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet_test';
process.env.DATABASE_SSL ??= 'false';

process.env.JWT_SECRET ??= 'test-only-secret-at-least-32-characters-long';
// Real level, because the tests assert on emitted events. The logger sends
// nothing to stdout under NODE_ENV=test, so this stays quiet.
process.env.LOG_LEVEL ??= 'info';

process.env.DEV_TOKEN_ENABLED = 'true';
process.env.FAUCET_ENABLED = 'true';
process.env.FAUCET_MAX_PAISE = '10000000';

// Enough headroom that a burst of 50 concurrent transfers is not serialised by
// the pool itself, which would mask a concurrency bug rather than expose it.
process.env.DB_POOL_MAX ??= '20';
