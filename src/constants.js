/**
 * Domain constants shared across modules.
 *
 * Money is always an integer number of paise. There is no float anywhere in
 * this service, and no value is ever coerced or rounded.
 */

/**
 * The single source of all money in the system.
 *
 * The '@' prefix is deliberate: it is outside USER_ID_PATTERN, so no
 * well-formed request can name the treasury. A token cannot be minted for it
 * and it cannot be given as a transfer counterparty. The account is reachable
 * only through server-side code paths that reference this constant, which
 * makes it structurally unaddressable rather than merely guarded.
 */
export const TREASURY_USER_ID = '@treasury';

/**
 * Grammar for a user id. Deliberately conservative: it excludes '@' (see
 * above) and anything that could confuse a URL path segment or a log field.
 */
export const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{3,64}$/;

/**
 * Treasury opening balance, in paise. 1e14 paise = Rs 1,00,000 crore.
 *
 * This is the total money supply, and it never changes: money only ever moves
 * between wallets, so SUM(balance_paise) across all wallets equals this value
 * for the lifetime of the database. That is what makes conservation checkable.
 *
 * Kept far below Number.MAX_SAFE_INTEGER (~9.007e15) so that reading BIGINT
 * columns as JavaScript numbers can never lose precision.
 */
export const TREASURY_SEED_PAISE = 100_000_000_000_000;

/**
 * Largest amount a single transfer may move, in paise (1e12 = Rs 1,000 crore).
 * Bounds all arithmetic well inside the safe-integer range and makes an
 * absurd-amount request a validation error rather than a precision hazard.
 */
export const MAX_AMOUNT_PAISE = 1_000_000_000_000;

/**
 * Transfer lifecycle.
 *
 * PENDING exists only inside an open transaction: it is written as the first
 * statement and overwritten with a terminal status before COMMIT. A crashed
 * process therefore leaves no pending rows behind, because the whole
 * transaction rolls back.
 *
 * APPLIED and REJECTED are both terminal and both durable. A rejection is
 * committed deliberately, so replaying the same idempotency key returns the
 * same rejection forever.
 */
export const TRANSFER_STATUS = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  REJECTED: 'rejected',
});

export const REJECT_REASON = Object.freeze({
  INSUFFICIENT_FUNDS: 'insufficient_funds',
});
