/**
 * The transfer path. This is the only place money moves.
 *
 * Everything happens in one READ COMMITTED transaction with no explicit
 * locking. Three SQL primitives carry the correctness:
 *
 *   1. INSERT ... ON CONFLICT DO UPDATE on (from_user, idempotency_key)
 *      claims the key and, when it loses, blocks until the winner commits and
 *      then returns the winner's committed row.
 *   2. INSERT ... ON CONFLICT DO NOTHING creates both wallets with no
 *      SELECT-then-INSERT window, in sorted order so concurrent opposite-
 *      direction transfers cannot deadlock.
 *   3. UPDATE ... WHERE balance_paise >= amount decides affordability and
 *      applies the debit in one atomic statement, so the check cannot go stale.
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

/**
 * A replay whose winning row was written this recently is treated as a lost
 * concurrency race rather than an ordinary client retry. Both are handled
 * identically; the distinction exists only so the logs show which is which.
 */
const CONCURRENT_WINDOW_MS = 2000;

/**
 * Claims the idempotency key. The first write of the transaction, before any
 * balance changes, so the key and the money commit or roll back together.
 *
 * DO UPDATE rather than DO NOTHING is the crux. On conflict with an in-flight
 * transaction, DO UPDATE waits for that transaction and then returns the
 * committed row. DO NOTHING would return zero rows, and a follow-up SELECT
 * under READ COMMITTED could not see the winner's uncommitted row -- which is
 * the classic find-or-create failure: the loser either errors on a missing row
 * or proceeds and moves the money twice.
 *
 * The SET is a deliberate no-op: we want the conflict handling, not a change.
 */
const CLAIM_KEY_SQL = `
  INSERT INTO transfers (id, from_user, to_user, amount_paise,
                         idempotency_key, request_hash, status)
  VALUES ($1, $2, $3, $4, $5, $6, '${TRANSFER_STATUS.PENDING}')
  ON CONFLICT (from_user, idempotency_key)
    DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING *
`;

/**
 * Get-or-create both wallets. Race-free because there is no window between
 * looking and inserting -- the conflict is resolved by the index itself.
 *
 * $1 and $2 are the two user ids sorted, which gives every caller in the system
 * the same row-lock acquisition order. Without that, A->B and B->A running
 * concurrently could each hold one row and wait for the other.
 */
const UPSERT_WALLETS_SQL = `
  INSERT INTO wallets (user_id) VALUES ($1), ($2)
  ON CONFLICT DO NOTHING
  RETURNING user_id
`;

/**
 * Conditional debit: affordability check and mutation in one statement against
 * the locked row. Zero rows affected means insufficient funds.
 *
 * There is deliberately no SELECT of the balance anywhere in this path --
 * read-then-write is exactly how concurrent transfers overdraw an account.
 */
const DEBIT_SQL = `
  UPDATE wallets SET balance_paise = balance_paise - $2
  WHERE user_id = $1 AND balance_paise >= $2
  RETURNING balance_paise
`;

const CREDIT_SQL = `
  UPDATE wallets SET balance_paise = balance_paise + $2
  WHERE user_id = $1
`;

/** Two rows summing to zero, so SUM over the whole ledger is always zero. */
const LEDGER_SQL = `
  INSERT INTO ledger_entries (transfer_id, user_id, amount_paise)
  VALUES ($1, $2, $3), ($1, $4, $5)
`;

/**
 * Moves `amountPaise` from `fromUser` to `toUser`, creating either wallet if
 * absent, exactly once, and applying at most once per idempotency key.
 *
 * Returns the outcome rather than throwing for a business rejection, because an
 * insufficient-funds rejection must be COMMITTED before the caller turns it
 * into a 422. The HTTP layer maps outcome to status code.
 *
 * @returns {Promise<{outcome: string, transfer: object, balancePaise: number|null}>}
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

    // A different id came back: this key already belongs to another request.
    if (row.id !== ourId) {
      // Same key, different intent. Refuse rather than guess which one was
      // meant -- and note that no money has moved, since this is still the
      // first statement of the transaction.
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

      // Whether we blocked on an in-flight winner or simply arrived late is
      // decided by how old the winning row is. Both replay identically; the
      // distinction is for the operator reading the logs.
      const winnerAgeMs = Date.now() - new Date(row.created_at).getTime();
      if (winnerAgeMs < CONCURRENT_WINDOW_MS) {
        metrics.raceLost.inc({ kind: 'idempotency_key' });
        log().info(
          {
            event: 'transfer.race_lost',
            transfer_id: row.id,
            status: row.status,
            // Time spent waiting on the winner's row lock: evidence that this
            // request genuinely blocked rather than merely arriving second.
            blocked_ms: claimMs,
            winner_age_ms: winnerAgeMs,
          },
          'lost the idempotency race, replaying the winner outcome',
        );
      }

      log().info(
        { event: 'transfer.idempotent_replay', transfer_id: row.id, status: row.status },
        'replayed a recorded outcome without moving money',
      );

      return {
        outcome: OUTCOME.REPLAYED,
        transfer: row,
        balancePaise: row.from_balance_after,
      };
    }

    // Sorted, so every transaction in the system takes these rows in the same
    // order. This is what makes bidirectional concurrency deadlock-free.
    const [first, second] = [fromUser, toUser].sort();
    const upserted = await client.query(UPSERT_WALLETS_SQL, [first, second]);
    const created = upserted.rows.map((r) => r.user_id);

    if (created.length > 0) {
      metrics.walletsCreated.inc({ via }, created.length);
    }
    const alreadyExisted = [first, second].filter((u) => !created.includes(u));
    log().info(
      { event: 'wallet.getorcreate', created, already_existed: alreadyExisted },
      'ensured both wallets exist',
    );

    const debit = await client.query(DEBIT_SQL, [fromUser, amountPaise]);

    if (debit.rowCount === 0) {
      // Rejection is recorded and COMMITTED, so replaying this key returns this
      // same rejection forever -- one key names one attempt with one answer.
      await client.query(
        'UPDATE transfers SET status = $2, reason = $3 WHERE id = $1',
        [ourId, TRANSFER_STATUS.REJECTED, REJECT_REASON.INSUFFICIENT_FUNDS],
      );
      // Read only for the error detail and the log; the decision was already
      // made atomically by the UPDATE above.
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
      transfer: {
        ...row,
        status: TRANSFER_STATUS.APPLIED,
        from_balance_after: newBalance,
      },
      balancePaise: newBalance,
    };
  });
}

/**
 * Reads a transfer, but only for a participant. A non-participant gets the same
 * answer as a caller asking about an id that does not exist, so the endpoint
 * cannot be used to discover which ids are real.
 */
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
