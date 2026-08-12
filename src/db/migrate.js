#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Deliberately standalone: it reads the environment directly and opens its own
 * connection rather than importing the application's config or pool, so it can
 * run as a container entrypoint step or in CI without booting the service.
 *
 * All pending migrations are applied inside a single transaction guarded by an
 * advisory lock, so two containers starting simultaneously cannot double-apply
 * and a failure part-way leaves the schema untouched. Postgres has
 * transactional DDL, which is what makes that possible.
 *
 * The lock is transaction-scoped (pg_advisory_xact_lock) rather than
 * session-scoped. A session lock would be wrong here: the connection may be
 * routed through a pooler, so session state cannot be assumed to survive, and
 * a transaction-scoped lock releases on COMMIT or ROLLBACK without any
 * unlock bookkeeping.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Arbitrary but fixed. Any other process using this key would serialise
 *  against us, which is exactly the intent. */
const ADVISORY_LOCK_KEY = 918_273_645_123;

function log(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', component: 'migrate', event, ...fields })}\n`,
  );
}

export function connectionConfig(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  return {
    connectionString,
    // Managed providers terminate TLS with a certificate chain the container
    // does not carry a root for. We require encryption but do not verify the
    // chain -- acceptable because the connection is to a known host over the
    // provider's network, and documented rather than silent.
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: Number(env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    application_name: 'wallet-migrate',
  };
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  // Lexicographic sort over zero-padded numeric prefixes gives apply order.
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export async function migrate(client) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = await listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      await client.query('COMMIT');
      log('up_to_date', { applied: applied.size });
      return [];
    }

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [file],
      );
      log('applied', { version: file });
    }

    await client.query('COMMIT');
    log('complete', { applied: pending.length });
    return pending;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main() {
  const client = new pg.Client(connectionConfig());
  await client.connect();
  try {
    await migrate(client);
  } finally {
    await client.end();
  }
}

// Only run when invoked directly, so tests can import migrate() and drive it
// against their own connection.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        component: 'migrate',
        event: 'failed',
        error: err.message,
      })}\n`,
    );
    process.exit(1);
  });
}
