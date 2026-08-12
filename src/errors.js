/**
 * Error taxonomy.
 *
 * Every failure a client can cause maps to exactly one code, and the code is
 * stable and machine-readable so a client can branch on it without parsing
 * prose. Anything not represented here is a bug in this service and becomes a
 * 500 with no detail leaked.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not_found',
  IDEMPOTENCY_KEY_REUSE: 'idempotency_key_reuse',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  SELF_TRANSFER_NOT_ALLOWED: 'self_transfer_not_allowed',
  DATABASE_UNAVAILABLE: 'database_unavailable',
  NOT_ENABLED: 'not_enabled',
  INTERNAL: 'internal_error',
});

export class AppError extends Error {
  /**
   * @param {number} httpStatus
   * @param {string} code      one of ERROR_CODES
   * @param {string} message   safe to return to the caller
   * @param {object} [details] extra safe-to-expose context
   */
  constructor(httpStatus, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.code = code;
    if (details) this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ?? {}) } };
  }
}

export const invalidRequest = (message, details) =>
  new AppError(400, ERROR_CODES.INVALID_REQUEST, message, details);

/**
 * The message is deliberately uniform regardless of whether the token was
 * absent, malformed, expired or forged. The specific reason is logged, never
 * returned -- telling a caller which part of their forgery failed helps only
 * the forger.
 */
export const unauthenticated = (message = 'A valid bearer token is required') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);

/**
 * Used both for genuinely unknown ids and for transfers the caller is not a
 * participant in. A 403 would confirm the id exists, which is information a
 * non-participant should not get.
 */
export const notFound = (message = 'Not found') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, message);

export const idempotencyKeyReuse = (details) =>
  new AppError(
    409,
    ERROR_CODES.IDEMPOTENCY_KEY_REUSE,
    'This idempotency key was already used for a different request',
    details,
  );

/**
 * 422 rather than 400: the request is well-formed, authenticated and
 * authorized. Rather than 402, which is effectively reserved and means "pay the
 * service". Rather than 409, which is kept for key reuse so a client can branch
 * on status alone -- 409 means fix your key, 422 means fund the wallet.
 */
export const insufficientFunds = (details) =>
  new AppError(422, ERROR_CODES.INSUFFICIENT_FUNDS, 'Insufficient funds', details);

export const selfTransferNotAllowed = () =>
  new AppError(
    422,
    ERROR_CODES.SELF_TRANSFER_NOT_ALLOWED,
    'A transfer must have a different sender and recipient',
  );

/**
 * Fail closed. Returned when the datastore is unreachable or too slow to
 * complete within the configured bounds. The caller may safely retry with the
 * same idempotency key, so refusing costs them only a retry -- whereas
 * accepting a transfer we cannot durably record is how money gets created.
 */
export const databaseUnavailable = () =>
  new AppError(
    503,
    ERROR_CODES.DATABASE_UNAVAILABLE,
    'The service cannot reach its datastore and is refusing writes',
  );

export const notEnabled = (what) =>
  new AppError(404, ERROR_CODES.NOT_ENABLED, `${what} is not enabled on this deployment`);

// --- Postgres error classification ------------------------------------------

const PG = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  QUERY_CANCELED: '57014', // statement_timeout fired
  LOCK_NOT_AVAILABLE: '55P03', // lock_timeout fired
  TOO_MANY_CONNECTIONS: '53300',
  ADMIN_SHUTDOWN: '57P01',
  CANNOT_CONNECT_NOW: '57P03',
});

/**
 * Errors worth retrying: the transaction failed for a reason that is not the
 * caller's fault and may not recur. Sorted wallet access should mean deadlocks
 * never happen, so this is defence in depth rather than the mechanism.
 */
export function isRetryableDbError(err) {
  return err?.code === PG.SERIALIZATION_FAILURE || err?.code === PG.DEADLOCK_DETECTED;
}

/**
 * Errors that mean the datastore is unavailable rather than the request being
 * wrong. `pg` surfaces socket-level failures without a SQLSTATE, hence the
 * Node error codes.
 */
export function isUnavailableDbError(err) {
  if (!err) return false;
  if (
    err.code === PG.QUERY_CANCELED ||
    err.code === PG.LOCK_NOT_AVAILABLE ||
    err.code === PG.TOO_MANY_CONNECTIONS ||
    err.code === PG.ADMIN_SHUTDOWN ||
    err.code === PG.CANNOT_CONNECT_NOW ||
    (typeof err.code === 'string' && err.code.startsWith('08'))
  ) {
    return true;
  }
  // Socket-level and pool-level failures.
  return (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNRESET' ||
    err.code === 'EAI_AGAIN' ||
    /timeout exceeded when trying to connect/i.test(err.message ?? '')
  );
}

/**
 * True when the non-negative-balance backstop fired. Reaching this means the
 * conditional debit let an overdraft through, which is an invariant breach and
 * a bug -- but no money moved, because the transaction aborted. Callers should
 * log it loudly and still answer the client truthfully with 422.
 */
export function isBalanceInvariantViolation(err) {
  return (
    err?.code === PG.CHECK_VIOLATION && err?.constraint === 'wallets_balance_non_negative'
  );
}

/**
 * Last-resort mapping for anything reaching the HTTP layer. Unrecognised errors
 * become an opaque 500: never leak a driver message or a SQL fragment to a
 * caller.
 */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (isUnavailableDbError(err)) return databaseUnavailable();
  if (isBalanceInvariantViolation(err)) return insufficientFunds();
  return new AppError(500, ERROR_CODES.INTERNAL, 'Internal error');
}
