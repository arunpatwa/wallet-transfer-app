/**
 * Wallet reads and get-or-create.
 */
import { withTransaction } from '../db/pool.js';
import { log } from '../logger.js';
import * as metrics from '../metrics.js';

/**
 * Get-or-create the caller's wallet, idempotently.
 *
 * The upsert is a single statement, so two concurrent first calls cannot both
 * insert -- one wins on the primary key and the other resolves through
 * ON CONFLICT. Calling twice therefore returns the same wallet, never two.
 *
 * DO UPDATE (a deliberate no-op assignment) rather than DO NOTHING, because we
 * need the existing row returned, not an empty result. Exclusive row locking is
 * acceptable here in a way it would not be in the transfer path: the only
 * contenders are the same user's own concurrent calls.
 *
 * `xmax = 0` distinguishes the row we inserted from one that already existed,
 * in the same round trip: a freshly inserted tuple has no deleting transaction
 * recorded, whereas the ON CONFLICT update path sets one.
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

/** Returns null when the caller has no wallet yet. */
export async function findWallet(userId) {
  const { rows } = await withTransaction(async (client) =>
    client.query('SELECT user_id, balance_paise FROM wallets WHERE user_id = $1', [userId]),
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, balancePaise: rows[0].balance_paise };
}

/**
 * System-wide aggregates, exposed so conservation can be checked from outside
 * rather than merely asserted.
 *
 * total_balance_paise must never change: the treasury is the only source of
 * money, so every transfer only moves it around. ledger_sum_paise must always
 * be zero, because every applied transfer writes one debit and one matching
 * credit. No per-user data is included.
 */
export async function readInvariants() {
  const { rows: [row] } = await withTransaction(async (client) =>
    client.query(`
      SELECT
        (SELECT count(*)                        FROM wallets)        AS wallet_count,
        (SELECT coalesce(sum(balance_paise), 0) FROM wallets)        AS total_balance_paise,
        (SELECT coalesce(sum(amount_paise), 0)  FROM ledger_entries) AS ledger_sum_paise,
        (SELECT count(*)                        FROM ledger_entries) AS ledger_entry_count,
        (SELECT count(*) FROM transfers WHERE status = 'applied')    AS transfers_applied,
        (SELECT count(*) FROM transfers WHERE status = 'rejected')   AS transfers_rejected
    `),
  );
  return row;
}
