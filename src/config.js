/**
 * 12-factor configuration. Validated once at boot, reporting every problem
 * together, so a misconfigured deploy fails loudly rather than at the first
 * request that needs the value.
 */
import { TREASURY_SEED_PAISE } from './constants.js';

function collectString(env, key, errors, { required = false, fallback } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    if (required) errors.push(`${key} is required`);
    return fallback;
  }
  return raw;
}

function collectInt(env, key, errors, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER }) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return value;
}

function collectBool(env, key, errors, { fallback }) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') {
    errors.push(`${key} must be "true" or "false", got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return raw === 'true';
}

export function loadConfig(env = process.env) {
  const errors = [];

  const nodeEnv = collectString(env, 'NODE_ENV', errors, { fallback: 'development' });
  const isProduction = nodeEnv === 'production';

  const jwtSecret = collectString(env, 'JWT_SECRET', errors, { required: true });
  // Not a style issue: HS256 with a guessable secret means anyone can mint a
  // token for any user and move their money.
  if (jwtSecret && jwtSecret.length < 32 && isProduction) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }

  const config = {
    nodeEnv,
    isProduction,
    port: collectInt(env, 'PORT', errors, { fallback: 8080, min: 1, max: 65535 }),
    logLevel: collectString(env, 'LOG_LEVEL', errors, { fallback: 'info' }),

    db: {
      connectionString: collectString(env, 'DATABASE_URL', errors, { required: true }),
      ssl: collectBool(env, 'DATABASE_SSL', errors, { fallback: false }),
      poolMax: collectInt(env, 'DB_POOL_MAX', errors, { fallback: 10, min: 1, max: 100 }),
      // Bounded so a wedged database surfaces as a fast 503, not a hang.
      // Applied per transaction with SET LOCAL (the connection may be pooled).
      statementTimeoutMs: collectInt(env, 'DB_STATEMENT_TIMEOUT_MS', errors, {
        fallback: 3000, min: 100, max: 60_000,
      }),
      lockTimeoutMs: collectInt(env, 'DB_LOCK_TIMEOUT_MS', errors, {
        fallback: 2500, min: 100, max: 60_000,
      }),
      connectTimeoutMs: collectInt(env, 'DB_CONNECT_TIMEOUT_MS', errors, {
        fallback: 5000, min: 100, max: 60_000,
      }),
    },

    jwt: {
      secret: jwtSecret,
      issuer: collectString(env, 'JWT_ISSUER', errors, { fallback: 'wallet-transfer-app' }),
      ttlSeconds: collectInt(env, 'JWT_TTL_SECONDS', errors, {
        fallback: 3600, min: 60, max: 86_400,
      }),
    },

    // Default-off, so forgetting to set them cannot expose a token mint or a
    // money faucet.
    demo: {
      tokenEndpointEnabled: collectBool(env, 'DEV_TOKEN_ENABLED', errors, { fallback: false }),
      faucetEnabled: collectBool(env, 'FAUCET_ENABLED', errors, { fallback: false }),
      faucetMaxPaise: collectInt(env, 'FAUCET_MAX_PAISE', errors, {
        fallback: 10_000_000, min: 1, max: TREASURY_SEED_PAISE,
      }),
    },

    observability: {
      logBufferSize: collectInt(env, 'LOG_BUFFER_SIZE', errors, {
        fallback: 1000, min: 10, max: 100_000,
      }),
    },
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }

  // So a stray runtime assignment fails instead of silently changing behaviour.
  for (const value of Object.values(config)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(config);
}

let cached;

/** Memoised. Tests call loadConfig() directly with a synthetic environment. */
export function getConfig(env = process.env) {
  cached ??= loadConfig(env);
  return cached;
}
