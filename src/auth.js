/**
 * Token-based identity.
 *
 * The caller is whoever the verified token says they are, and nothing else.
 * There is no code path anywhere in this service that derives a caller identity
 * from a header, a query parameter, or a body field -- so a request cannot spend
 * another user's money by claiming to be them.
 */
import jwt from 'jsonwebtoken';
import { getConfig } from './config.js';
import { USER_ID_PATTERN } from './constants.js';
import { unauthenticated } from './errors.js';
import { bindCaller, log } from './logger.js';
import * as metrics from './metrics.js';

const config = getConfig();

export function signToken(userId) {
  return jwt.sign({}, config.jwt.secret, {
    algorithm: 'HS256',
    subject: userId,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.ttlSeconds,
  });
}

function reject(reason) {
  metrics.authFailures.inc({ reason });
  log().warn({ event: 'auth.failed', reason }, 'authentication rejected');
  // The reason is logged, never returned: telling a caller which part of their
  // forgery failed helps only the forger.
  return unauthenticated();
}

/**
 * Express middleware. Sets req.caller to the verified subject.
 */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization');
  if (!header) return next(reject('missing_authorization_header'));

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(reject('malformed_authorization_header'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      // Pinning the algorithm is essential, not cosmetic. Without it a token
      // declaring alg:"none" would skip signature verification entirely, and one
      // declaring alg:"RS256" could be verified with our secret as a public key.
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
    });
  } catch (err) {
    // jsonwebtoken distinguishes expiry from a bad signature; both are logged
    // separately and both return the same opaque 401.
    return next(reject(err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token'));
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || !USER_ID_PATTERN.test(subject)) {
    // A token whose subject is not a well-formed user id cannot be honoured --
    // including one naming the treasury, which the pattern excludes.
    return next(reject('invalid_subject'));
  }

  req.caller = subject;
  bindCaller(subject);
  return next();
}
