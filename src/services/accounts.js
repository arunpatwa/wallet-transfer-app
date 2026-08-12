import { withTransaction } from '../db/pool.js';
import { log } from '../logger.js';
import * as metrics from '../metrics.js';

/**
 * One statement, so two concurrent first calls cannot both insert. DO UPDATE
 * rather than DO NOTHING because we need the existing row back; the exclusive
 * lock is acceptable here, unlike in the transfer path, since the only
 * contenders are one user's own concurrent calls.
 *
 * xmax = 0 distinguishes an insert from a conflict in the same round trip.
 */
const UPSERT_SQL = `
  INSERT INTO wallets (user_id) VALUES ($1)
  ON CONFLICT (user_id) DO UPDATE SET user_id = wallets.user_id
  RETURNING user_id, balance_paise, (xmax = 0) AS inserted
`;

export async function getOrCreateWallet(userId) {
  const wallet = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(UPSERT_SQL, [userId]);
    return row;
  });

  if (wallet.inserted) {
    metrics.walletsCreated.inc({ via: 'accounts' });
    log().info({ event: 'wallet.created', balance_paise: wallet.balance_paise }, 'wallet created');
  } else {
    log().info({ event: 'wallet.existing' }, 'returned the existing wallet');
  }

  return { userId: wallet.user_id, balancePaise: wallet.balance_paise };
}

export async function findWallet(userId) {
  const { rows } = await withTransaction(async (client) =>
    client.query('SELECT user_id, balance_paise FROM wallets WHERE user_id = $1', [userId]),
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, balancePaise: rows[0].balance_paise };
}

/**
 * Aggregates that let conservation be checked from outside: total_balance_paise
 * must never change and ledger_sum_paise must always be zero. No per-user data.
 */
export async function readInvariants() {
  const { rows: [row] } = await withTransaction(async (client) =>
    client.query(`
      -- The ::bigint casts are load-bearing: sum() over bigint returns numeric,
      -- which falls outside the INT8 parser and would arrive as a string,
      -- making ledger_sum_paise === 0 false for a balanced ledger.
      SELECT
        (SELECT count(*)                                FROM wallets)        AS wallet_count,
        (SELECT coalesce(sum(balance_paise), 0)::bigint FROM wallets)        AS total_balance_paise,
        (SELECT coalesce(sum(amount_paise), 0)::bigint  FROM ledger_entries) AS ledger_sum_paise,
        (SELECT count(*)                                FROM ledger_entries) AS ledger_entry_count,
        (SELECT count(*) FROM transfers WHERE status = 'applied')            AS transfers_applied,
        (SELECT count(*) FROM transfers WHERE status = 'rejected')           AS transfers_rejected
    `),
  );
  return row;
}
