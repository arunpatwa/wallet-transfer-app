/** Domain constants. Money is always an integer number of paise. */

/**
 * The only source of money. The '@' prefix is outside USER_ID_PATTERN, so no
 * well-formed request can name the treasury -- it is unaddressable rather than
 * merely guarded.
 */
export const TREASURY_USER_ID = '@treasury';

export const USER_ID_PATTERN = /^[A-Za-z0-9_.:-]{3,64}$/;

/**
 * Total money supply, in paise, fixed for the life of the database: money only
 * moves between wallets, so SUM(balance_paise) always equals this. Far below
 * Number.MAX_SAFE_INTEGER, so reading BIGINT as a JS number is lossless.
 */
export const TREASURY_SEED_PAISE = 100_000_000_000_000;

/** Per-transfer cap, keeping all arithmetic inside the safe-integer range. */
export const MAX_AMOUNT_PAISE = 1_000_000_000_000;

/**
 * PENDING exists only inside an open transaction, so a crash leaves no pending
 * rows. APPLIED and REJECTED are both terminal and both durable -- a rejection
 * is committed deliberately, so replaying its key returns it forever.
 */
export const TRANSFER_STATUS = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  REJECTED: 'rejected',
});

export const REJECT_REASON = Object.freeze({
  INSUFFICIENT_FUNDS: 'insufficient_funds',
});
