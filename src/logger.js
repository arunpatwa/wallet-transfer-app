/**
 * Structured logging.
 *
 * Two destinations, one serialisation: JSON lines to stdout (what the host's
 * log drain collects) and a bounded in-memory ring buffer (what GET /logs
 * serves, so there is a public log view that needs no login).
 *
 * Correlation ids travel through AsyncLocalStorage rather than being threaded
 * as an argument through every function. That matters here because the
 * interesting log events happen deep inside the transfer transaction, and a
 * logger parameter on every call site would be noise that obscures the money
 * logic.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getConfig } from './config.js';

const config = getConfig();

// --- ring buffer -------------------------------------------------------------

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.writes = 0;
  }

  push(item) {
    this.items[this.writes % this.capacity] = item;
    this.writes += 1;
  }

  /** Oldest first. */
  toArray(limit = this.capacity) {
    const held = Math.min(this.writes, this.capacity);
    const take = Math.min(limit, held);
    const out = new Array(take);
    // The newest entry sits at (writes - 1); walk back `take` places.
    for (let i = 0; i < take; i += 1) {
      const offset = this.writes - take + i;
      out[i] = this.items[offset % this.capacity];
    }
    return out;
  }
}

const buffer = new RingBuffer(config.observability.logBufferSize);

/** Reads the buffer for GET /logs. `limit` counts back from the newest entry. */
export function recentLogs({ limit = 200, event, level } = {}) {
  let entries = buffer.toArray();
  if (event) entries = entries.filter((e) => typeof e?.event === 'string' && e.event.startsWith(event));
  if (level) entries = entries.filter((e) => e?.level === level);
  return entries.slice(-limit);
}

/**
 * A pino destination is anything with a write(string) method. This one parses
 * the line back into an object so /logs can filter by event and level; a line
 * that somehow is not JSON is kept verbatim rather than dropped.
 */
const ringDestination = {
  write(line) {
    try {
      buffer.push(JSON.parse(line));
    } catch {
      buffer.push({ level: 'unknown', raw: line.trimEnd() });
    }
  },
};

// --- logger ------------------------------------------------------------------

export const rootLogger = pino(
  {
    level: config.logLevel,
    base: { service: 'wallet-transfer-app', env: config.nodeEnv },
    // Emit level as a word rather than pino's numeric default: these logs are
    // read by humans through GET /logs, not only by a machine.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'token',
        'password',
        'jwt',
      ],
      censor: '[redacted]',
    },
  },
  pino.multistream(
    // Under test, log only to the ring buffer. The tests assert that the
    // required events are emitted, which needs a real log level, but writing
    // every line to stdout would bury the test output.
    config.nodeEnv === 'test'
      ? [{ stream: ringDestination, level: config.logLevel }]
      : [
          { stream: process.stdout, level: config.logLevel },
          { stream: ringDestination, level: config.logLevel },
        ],
  ),
);

// --- request context ---------------------------------------------------------

const requestContext = new AsyncLocalStorage();

export function newCorrelationId() {
  return randomUUID();
}

/**
 * Runs `fn` with a request-scoped child logger. Every log line emitted anywhere
 * inside, at any stack depth, carries the correlation id automatically.
 */
export function withRequestContext({ requestId, method, route }, fn) {
  const logger = rootLogger.child({ request_id: requestId, method, route });
  return requestContext.run({ requestId, logger }, fn);
}

/** The current request's logger, or the root logger outside a request. */
export function log() {
  return requestContext.getStore()?.logger ?? rootLogger;
}

export function currentRequestId() {
  return requestContext.getStore()?.requestId;
}

/**
 * Attaches the authenticated caller to the request-scoped logger once identity
 * is known, so every subsequent line in this request is attributable.
 */
export function bindCaller(userId) {
  const store = requestContext.getStore();
  if (store) store.logger = store.logger.child({ caller: userId });
}
