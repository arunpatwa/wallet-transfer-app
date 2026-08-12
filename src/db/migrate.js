#!/usr/bin/env node
/**
 * Migration runner. Standalone -- reads the environment and opens its own
 * connection -- so it can run as a container entrypoint step or in CI without
 * booting the service.
 *
 * All pending migrations apply in one transaction (Postgres has transactional
 * DDL) under a transaction-scoped advisory lock, so concurrent boots serialise
 * and a part-way failure leaves the schema untouched. Transaction-scoped rather
 * than session-scoped because the connection may be pooled.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

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
    // Encryption required; chain not verified, as managed providers present a
    // chain the container carries no root for.
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: Number(env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    application_name: 'wallet-migrate',
  };
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  // Zero-padded numeric prefixes make lexicographic sort the apply order.
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

    const pending = (await listMigrationFiles()).filter((f) => !applied.has(f));

    if (pending.length === 0) {
      await client.query('COMMIT');
      log('up_to_date', { applied: applied.size });
      return [];
    }

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
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

// Only when invoked directly, so tests can drive migrate() on their own connection.
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
