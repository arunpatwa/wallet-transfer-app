/**
 * The pool and the transaction helper every write goes through, so no route can
 * run a multi-statement money operation outside a transaction.
 */
import pg from 'pg';
import { getConfig } from '../config.js';
import { log } from '../logger.js';
import * as metrics from '../metrics.js';
import { databaseUnavailable, isRetryableDbError } from '../errors.js';

const config = getConfig();

/**
 * BIGINT as a number, not the string pg returns by default -- otherwise
 * balances arrive as strings and arithmetic silently concatenates. Safe because
 * the whole supply is 1e14 and a transfer is capped at 1e12 (see constants.js).
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) =>
  value === null ? null : Number(value),
);

export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  // Encryption required; chain not verified, because managed providers present
  // a chain the container carries no root for.
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: config.db.poolMax,
  connectionTimeoutMillis: config.db.connectTimeoutMs,
  idleTimeoutMillis: 30_000,
  application_name: 'wallet-transfer-app',
});

// An idle client erroring must not become an unhandled event and kill the process.
pool.on('error', (err) => {
  log().error({ event: 'db.pool_error', error: err.message }, 'idle client error');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` in one transaction.
 *
 * Timeouts use SET LOCAL rather than session settings, because the connection
 * may be pooled and must not be assumed to carry session state. The values are
 * interpolated because SET LOCAL takes no bind parameters; they are integers
 * validated at config load, so no SQL can ride in on them.
 */
export async function withTransaction(fn, { attempts = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      log().error({ event: 'db.connect_failed', error: err.message }, 'cannot acquire connection');
      throw databaseUnavailable();
    }

    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${config.db.statementTimeoutMs}`);
      await client.query(`SET LOCAL lock_timeout = ${config.db.lockTimeoutMs}`);

      const result = await fn(client);

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      if (isRetryableDbError(err) && attempt < attempts) {
        lastError = err;
        metrics.dbTransactionRetries.inc({ code: err.code });
        log().warn(
          { event: 'db.transaction_retry', sqlstate: err.code, attempt },
          'retrying transaction',
        );
        // Jittered, so retrying contenders do not re-collide in lockstep.
        await sleep(Math.floor(Math.random() * 20) + attempt * 10);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/** Bounded independently of statement_timeout, so a wedged database surfaces as
 *  "not ready" quickly rather than holding the probe open. */
export async function checkDatastore({ timeoutMs = 1500 } = {}) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('readiness probe timed out')), timeoutMs).unref();
      }),
    ]);
    metrics.datastoreUp.set(1);
    return { ok: true, latencyMs: Math.round(elapsedMs()) };
  } catch (err) {
    metrics.datastoreUp.set(0);
    return { ok: false, latencyMs: Math.round(elapsedMs()), error: err.message };
  }
}

export async function closePool() {
  await pool.end();
}
