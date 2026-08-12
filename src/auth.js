/**
 * The caller is whoever the verified token says they are. No code path derives
 * identity from a header, query or body field.
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
  return unauthenticated();
}

export function requireAuth(req, _res, next) {
  const header = req.get('authorization');
  if (!header) return next(reject('missing_authorization_header'));

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(reject('malformed_authorization_header'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      // Pinning the algorithm is essential: without it, alg:"none" skips
      // signature verification and alg:"RS256" could be verified with our
      // secret treated as a public key.
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
    });
  } catch (err) {
    return next(reject(err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token'));
  }

  const subject = payload.sub;
  // The pattern excludes '@', so a token naming the treasury cannot be honoured.
  if (typeof subject !== 'string' || !USER_ID_PATTERN.test(subject)) {
    return next(reject('invalid_subject'));
  }

  req.caller = subject;
  bindCaller(subject);
  return next();
}
