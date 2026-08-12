/**
 * Edge validation. Runs before any transaction opens, so a malformed request
 * never consumes an idempotency key -- unlike an insufficient-funds rejection,
 * which is an outcome worth remembering.
 */
import { createHash } from 'node:crypto';
import { MAX_AMOUNT_PAISE, USER_ID_PATTERN } from './constants.js';
import { invalidRequest } from './errors.js';

/** Printable ASCII, so a key cannot corrupt a log line. */
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{1,255}$/;

export function assertUserId(value, field) {
  if (typeof value !== 'string') {
    throw invalidRequest(`${field} must be a string`, { field });
  }
  if (!USER_ID_PATTERN.test(value)) {
    throw invalidRequest(
      `${field} must be 3-64 characters of letters, digits, or _ . : -`,
      { field },
    );
  }
  return value;
}

/**
 * Strings are refused rather than coerced: accepting "100" invites accepting
 * "100.5", and a service that silently rounds money is worse than one that
 * refuses ambiguous input.
 */
export function assertAmountPaise(value, field = 'amount_paise') {
  if (typeof value !== 'number') {
    throw invalidRequest(`${field} must be a number of paise, not a string`, { field });
  }
  if (!Number.isInteger(value)) {
    throw invalidRequest(`${field} must be a whole number of paise`, { field });
  }
  if (value <= 0) {
    throw invalidRequest(`${field} must be greater than zero`, { field });
  }
  if (value > MAX_AMOUNT_PAISE) {
    throw invalidRequest(`${field} must not exceed ${MAX_AMOUNT_PAISE}`, { field });
  }
  return value;
}

export function assertIdempotencyKey(value, field = 'idempotency_key') {
  if (typeof value !== 'string') {
    throw invalidRequest(`${field} must be a string`, { field });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw invalidRequest(`${field} must be 1-255 printable ASCII characters`, { field });
  }
  return value;
}

/**
 * Fingerprints the request's intent, to tell an honest retry from the same key
 * reused for something else. Field order is fixed here rather than taken from
 * the incoming object, which is what makes it canonical. The key itself is
 * excluded -- it is the lookup, not the intent.
 */
export function computeRequestHash({ toUser, amountPaise }) {
  const canonical = JSON.stringify({ amount_paise: amountPaise, to_user: toUser });
  return createHash('sha256').update(canonical).digest('hex');
}

export function assertObjectBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
  return body;
}
