/**
 * Error taxonomy. Every client-caused failure maps to one stable code so a
 * client can branch without parsing prose; anything else becomes an opaque 500.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  IDEMPOTENCY_KEY_REUSE: 'idempotency_key_reuse',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  SELF_TRANSFER_NOT_ALLOWED: 'self_transfer_not_allowed',
  DATABASE_UNAVAILABLE: 'database_unavailable',
  NOT_ENABLED: 'not_enabled',
  INTERNAL: 'internal_error',
});

export class AppError extends Error {
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

/** Uniform whether the token was absent, expired or forged: the specific reason
 *  is logged, never returned, since it helps only a forger. */
export const unauthenticated = (message = 'A valid bearer token is required') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);

/** Also used for transfers the caller isn't party to: a 403 would confirm the
 *  id exists. */
export const notFound = (message = 'Not found') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, message);

/** Distinct from 404: "not here" and "here but asked for wrongly" are different
 *  answers, and a browser GET to a POST-only route is the common case. */
export const methodNotAllowed = (allowed) =>
  new AppError(405, ERROR_CODES.METHOD_NOT_ALLOWED, `This endpoint accepts ${allowed.join(', ')}`, {
    allowed,
  });

export const idempotencyKeyReuse = (details) =>
  new AppError(
    409,
    ERROR_CODES.IDEMPOTENCY_KEY_REUSE,
    'This idempotency key was already used for a different request',
    details,
  );

/** 422 not 400 (the request is well-formed and authorized), not 402 (reserved,
 *  means "pay the service"), not 409 (kept for key reuse so clients can branch
 *  on status alone: 409 means fix your key, 422 means fund the wallet). */
export const insufficientFunds = (details) =>
  new AppError(422, ERROR_CODES.INSUFFICIENT_FUNDS, 'Insufficient funds', details);

export const selfTransferNotAllowed = () =>
  new AppError(
    422,
    ERROR_CODES.SELF_TRANSFER_NOT_ALLOWED,
    'A transfer must have a different sender and recipient',
  );

/** Fail closed. The caller may retry with the same key, so refusing costs a
 *  retry -- where accepting what we cannot durably record creates money. */
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
  QUERY_CANCELED: '57014', // statement_timeout
  LOCK_NOT_AVAILABLE: '55P03', // lock_timeout
  TOO_MANY_CONNECTIONS: '53300',
  ADMIN_SHUTDOWN: '57P01',
  CANNOT_CONNECT_NOW: '57P03',
});

/** Sorted wallet access should make these unreachable; retrying is defence in
 *  depth, and a firing retry is worth a metric. */
export function isRetryableDbError(err) {
  return err?.code === PG.SERIALIZATION_FAILURE || err?.code === PG.DEADLOCK_DETECTED;
}

/** The datastore is unavailable rather than the request being wrong. Socket
 *  failures arrive without a SQLSTATE, hence the Node codes. */
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
  return (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNRESET' ||
    err.code === 'EAI_AGAIN' ||
    /timeout exceeded when trying to connect/i.test(err.message ?? '')
  );
}

/** The non-negative-balance backstop fired: an invariant breach and a bug, but
 *  no money moved, so answer the client truthfully with 422 and log loudly. */
export function isBalanceInvariantViolation(err) {
  return err?.code === PG.CHECK_VIOLATION && err?.constraint === 'wallets_balance_non_negative';
}

export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (isUnavailableDbError(err)) return databaseUnavailable();
  if (isBalanceInvariantViolation(err)) return insufficientFunds();
  return new AppError(500, ERROR_CODES.INTERNAL, 'Internal error');
}
