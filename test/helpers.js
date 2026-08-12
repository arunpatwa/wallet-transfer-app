/**
 * Test harness: a real HTTP server on an ephemeral port, driven with fetch.
 *
 * Deliberately exercises the full stack -- routing, middleware, auth, the
 * transaction -- rather than calling services directly. The bugs this suite
 * exists to catch are concurrency bugs, and those only appear when requests
 * genuinely overlap.
 */
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { TREASURY_SEED_PAISE, TREASURY_USER_ID } from '../src/constants.js';
import { migrate } from '../src/db/migrate.js';
import { closePool, pool } from '../src/db/pool.js';

let server;
let baseUrl;

export async function startServer() {
  if (baseUrl) return baseUrl;
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  baseUrl = undefined;
  await closePool();
}

/** Applies migrations (idempotent), empties every table, re-seeds the treasury. */
export async function resetDatabase() {
  const client = await pool.connect();
  try {
    await migrate(client);
    await client.query('TRUNCATE ledger_entries, transfers, wallets RESTART IDENTITY CASCADE');
    await client.query('INSERT INTO wallets (user_id, balance_paise) VALUES ($1, $2)', [
      TREASURY_USER_ID,
      TREASURY_SEED_PAISE,
    ]);
  } finally {
    client.release();
  }
}

export async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    // Some responses (metrics) are not JSON; callers that care check status.
  }
  return { status: response.status, body: parsed };
}

/** A user id that has never existed before, so every test starts brand new. */
export function newUserId(prefix = 'u') {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function tokenFor(userId) {
  return signToken(userId);
}

/** Creates a brand-new user, funds it from the treasury, returns its token. */
export async function fundedUser(amountPaise) {
  const userId = newUserId();
  const token = tokenFor(userId);
  const response = await api('/dev/credit', {
    method: 'POST',
    token,
    body: { amount_paise: amountPaise, idempotency_key: `seed-${randomUUID()}` },
  });
  if (response.status !== 201) {
    throw new Error(`funding failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { userId, token };
}

export async function balanceOf(userId) {
  const { rows } = await pool.query('SELECT balance_paise FROM wallets WHERE user_id = $1', [
    userId,
  ]);
  return rows[0]?.balance_paise ?? null;
}

export async function walletRowCount(userId) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM wallets WHERE user_id = $1', [
    userId,
  ]);
  return rows[0].n;
}

export async function invariants() {
  const { rows } = await pool.query(`
    SELECT (SELECT coalesce(sum(balance_paise), 0)::bigint FROM wallets)        AS total_balance_paise,
           (SELECT coalesce(sum(amount_paise), 0)::bigint  FROM ledger_entries) AS ledger_sum_paise,
           (SELECT count(*)::int                           FROM wallets)        AS wallet_count
  `);
  return rows[0];
}

/**
 * Fires `count` requests as close to simultaneously as the runtime allows.
 *
 * Promise.all on already-started fetches is what creates the overlap: every
 * request is in flight before any response is awaited.
 */
export function fireConcurrently(count, makeRequest) {
  return Promise.all(Array.from({ length: count }, (_, index) => makeRequest(index)));
}
