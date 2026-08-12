/**
 * Connection pool and the transaction helper every write goes through.
 *
 * The helper exists so that no route can accidentally run a multi-statement
 * money operation outside a transaction: there is one way to get a client, and
 * it already has BEGIN, the timeouts, ROLLBACK-on-throw and the retry policy
 * attached.
 */
import pg from 'pg';
import { getConfig } from '../config.js';
import { log } from '../logger.js';
import * as metrics from '../metrics.js';
import { databaseUnavailable, isRetryableDbError } from '../errors.js';

const config = getConfig();

/**
 * Read BIGINT (OID 20) as a JavaScript number rather than the string `pg`
 * returns by default.
 *
 * Safe because every BIGINT in this schema is bounded well below
 * Number.MAX_SAFE_INTEGER: the entire money supply is 1e14 paise and a single
 * transfer is capped at 1e12 (see constants.js). Without this, balances would
 * arrive as strings and arithmetic on them would silently concatenate.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) =>
  value === null ? null : Number(value),
);

export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  // Managed providers terminate TLS with a chain the container has no root for.
  // Encryption is required; chain verification is not performed. Stated here
  // rather than left implicit.
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: config.db.poolMax,
  connectionTimeoutMillis: config.db.connectTimeoutMs,
  idleTimeoutMillis: 30_000,
  application_name: 'wallet-transfer-app',
});

// An idle client erroring (provider restart, pooler recycling a connection) must
// not become an unhandled 'error' event and kill the process.
pool.on('error', (err) => {
  log().error({ event: 'db.pool_error', error: err.message }, 'idle client error');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` inside a single transaction.
 *
 * Timeouts are applied with SET LOCAL rather than as pool-level session
 * settings, because the connection may be routed through a pooler that does not
 * preserve session state between checkouts. SET LOCAL is scoped to this
 * transaction and unwinds with it.
 *
 * The values are interpolated rather than bound because SET LOCAL does not
 * accept bind parameters. They are integers validated at config load, so this
 * cannot carry injected SQL.
 *
 * Retries apply only to serialization failures and deadlocks. Sorted wallet
 * access should make deadlocks impossible, so a retry firing is a signal worth
 * a metric, not a routine occurrence.
 */
export async function withTransaction(fn, { attempts = 3 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      // No connection available within the bound: fail closed rather than queue.
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
      // Best effort: if the connection is already gone the ROLLBACK will fail
      // too, and the server has aborted the transaction regardless.
      await client.query('ROLLBACK').catch(() => {});

      if (isRetryableDbError(err) && attempt < attempts) {
        lastError = err;
        metrics.dbTransactionRetries.inc({ code: err.code });
        log().warn(
          { event: 'db.transaction_retry', sqlstate: err.code, attempt },
          'retrying transaction',
        );
        // Jittered backoff so retrying contenders do not re-collide in lockstep.
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

/**
 * Readiness probe. Bounded independently of statement_timeout so that a wedged
 * database surfaces as "not ready" quickly rather than holding the probe open.
 */
export async function checkDatastore({ timeoutMs = 1500 } = {}) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        // unref so a pending probe timer can never hold the process open.
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
