/**
 * The transfer path: the only place money moves. One READ COMMITTED transaction.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { REJECT_REASON, TRANSFER_STATUS } from '../constants.js';
import { idempotencyKeyReuse } from '../errors.js';
import { log } from '../logger.js';
import * as metrics from '../metrics.js';

export const OUTCOME = Object.freeze({
  APPLIED: 'applied',
  REPLAYED: 'replayed',
  REJECTED: 'rejected',
});

/** A replay of a row this new was a concurrent race, not a late retry. Logging only. */
const CONCURRENT_WINDOW_MS = 2000;

/**
 * Claims the key, as the transaction's first write, so key and money commit
 * together.
 *
 * DO UPDATE, not DO NOTHING: on conflict it waits for the in-flight winner and
 * returns the committed row. DO NOTHING returns zero rows, and a follow-up
 * SELECT cannot see an uncommitted row under READ COMMITTED -- the loser then
 * either 500s or moves the money twice. The SET is a deliberate no-op.
 */
const CLAIM_KEY_SQL = `
  INSERT INTO transfers (id, from_user, to_user, amount_paise,
                         idempotency_key, request_hash, status)
  VALUES ($1, $2, $3, $4, $5, $6, '${TRANSFER_STATUS.PENDING}')
  ON CONFLICT (from_user, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING *
`;

/** Get-or-create with no SELECT-then-INSERT window; the index resolves the race. */
const UPSERT_WALLETS_SQL = `
  INSERT INTO wallets (user_id) VALUES ($1), ($2)
  ON CONFLICT DO NOTHING
  RETURNING user_id
`;

/**
 * Deterministic lock order, and not optional: DO NOTHING above takes no lasting
 * lock on an existing row, so without this the order would be debit-then-credit
 * -- the transfer's direction -- and A->B would deadlock against B->A. Ordering
 * only; affordability is still decided by DEBIT_SQL.
 */
const LOCK_WALLETS_SQL = `
  SELECT user_id FROM wallets
  WHERE user_id IN ($1, $2)
  ORDER BY user_id
  FOR UPDATE
`;

/** Check and mutation in one statement, so the balance cannot go stale between them. */
const DEBIT_SQL = `
  UPDATE wallets SET balance_paise = balance_paise - $2
  WHERE user_id = $1 AND balance_paise >= $2
  RETURNING balance_paise
`;

const CREDIT_SQL = `
  UPDATE wallets SET balance_paise = balance_paise + $2
  WHERE user_id = $1
`;

/** Two rows summing to zero, so SUM over the ledger is always zero. */
const LEDGER_SQL = `
  INSERT INTO ledger_entries (transfer_id, user_id, amount_paise)
  VALUES ($1, $2, $3), ($1, $4, $5)
`;

/**
 * Returns the outcome rather than throwing on rejection: an insufficient-funds
 * rejection must COMMIT before the HTTP layer turns it into a 422, which is
 * what makes it replayable.
 */
export async function executeTransfer({
  fromUser,
  toUser,
  amountPaise,
  idempotencyKey,
  requestHash,
  via = 'transfer',
}) {
  return withTransaction(async (client) => {
    const ourId = randomUUID();

    const claimStartedAt = process.hrtime.bigint();
    const { rows: [row] } = await client.query(CLAIM_KEY_SQL, [
      ourId,
      fromUser,
      toUser,
      amountPaise,
      idempotencyKey,
      requestHash,
    ]);
    const claimMs = Math.round(Number(process.hrtime.bigint() - claimStartedAt) / 1e6);

    // A different id means the key already belongs to another request.
    if (row.id !== ourId) {
      // Same key, different intent: refuse rather than guess. No money has moved.
      if (row.request_hash !== requestHash) {
        log().warn(
          {
            event: 'transfer.idempotency_conflict',
            idempotency_key: idempotencyKey,
            existing_transfer_id: row.id,
          },
          'idempotency key reused with a different body',
        );
        throw idempotencyKeyReuse({ transfer_id: row.id });
      }

      metrics.idempotentReplays.inc();

      const winnerAgeMs = Date.now() - new Date(row.created_at).getTime();
      if (winnerAgeMs < CONCURRENT_WINDOW_MS) {
        metrics.raceLost.inc({ kind: 'idempotency_key' });
        log().info(
          {
            event: 'transfer.race_lost',
            transfer_id: row.id,
            status: row.status,
            blocked_ms: claimMs, // time spent waiting on the winner's row lock
            winner_age_ms: winnerAgeMs,
          },
          'lost the idempotency race, replaying the winner outcome',
        );
      }

      log().info(
        { event: 'transfer.idempotent_replay', transfer_id: row.id, status: row.status },
        'replayed a recorded outcome without moving money',
      );

      return { outcome: OUTCOME.REPLAYED, transfer: row, balancePaise: row.from_balance_after };
    }

    const [first, second] = [fromUser, toUser].sort();
    const upserted = await client.query(UPSERT_WALLETS_SQL, [first, second]);
    const created = upserted.rows.map((r) => r.user_id);

    const locked = await client.query(LOCK_WALLETS_SQL, [first, second]);
    if (locked.rowCount !== 2) {
      // Unreachable, but proceeding would mean moving money with a row unlocked.
      throw Object.assign(new Error('wallet rows vanished between upsert and lock'), {
        code: '40001',
      });
    }

    if (created.length > 0) {
      metrics.walletsCreated.inc({ via }, created.length);
    }
    log().info(
      {
        event: 'wallet.getorcreate',
        created,
        already_existed: [first, second].filter((u) => !created.includes(u)),
      },
      'ensured both wallets exist',
    );

    const debit = await client.query(DEBIT_SQL, [fromUser, amountPaise]);

    if (debit.rowCount === 0) {
      // Committed, not rolled back, so this key replays this rejection forever.
      await client.query('UPDATE transfers SET status = $2, reason = $3 WHERE id = $1', [
        ourId,
        TRANSFER_STATUS.REJECTED,
        REJECT_REASON.INSUFFICIENT_FUNDS,
      ]);
      // For the error detail only; the decision was made atomically above.
      const { rows: [wallet] } = await client.query(
        'SELECT balance_paise FROM wallets WHERE user_id = $1',
        [fromUser],
      );
      const balancePaise = wallet?.balance_paise ?? 0;

      metrics.transfersRejected.inc({ reason: REJECT_REASON.INSUFFICIENT_FUNDS });
      log().info(
        {
          event: 'transfer.rejected',
          reason: REJECT_REASON.INSUFFICIENT_FUNDS,
          transfer_id: ourId,
          to_user: toUser,
          amount_paise: amountPaise,
          balance_paise: balancePaise,
        },
        'refused transfer for insufficient funds',
      );

      return {
        outcome: OUTCOME.REJECTED,
        transfer: {
          ...row,
          status: TRANSFER_STATUS.REJECTED,
          reason: REJECT_REASON.INSUFFICIENT_FUNDS,
        },
        balancePaise,
      };
    }

    const newBalance = debit.rows[0].balance_paise;

    await client.query(CREDIT_SQL, [toUser, amountPaise]);
    await client.query(LEDGER_SQL, [ourId, fromUser, -amountPaise, toUser, amountPaise]);
    await client.query(
      'UPDATE transfers SET status = $2, from_balance_after = $3 WHERE id = $1',
      [ourId, TRANSFER_STATUS.APPLIED, newBalance],
    );

    metrics.transfersApplied.inc();
    log().info(
      {
        event: 'transfer.applied',
        transfer_id: ourId,
        to_user: toUser,
        amount_paise: amountPaise,
        from_balance_after: newBalance,
      },
      'transfer applied',
    );

    return {
      outcome: OUTCOME.APPLIED,
      transfer: { ...row, status: TRANSFER_STATUS.APPLIED, from_balance_after: newBalance },
      balancePaise: newBalance,
    };
  });
}

/** Non-participants get null, so the endpoint cannot reveal which ids exist. */
export async function findTransferForParticipant(transferId, callerId) {
  const { rows } = await withTransaction(async (client) =>
    client.query(
      `SELECT id, from_user, to_user, amount_paise, idempotency_key,
              status, reason, from_balance_after, created_at
       FROM transfers
       WHERE id = $1 AND (from_user = $2 OR to_user = $2)`,
      [transferId, callerId],
    ),
  );
  return rows[0] ?? null;
}
