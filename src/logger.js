/**
 * JSON logs to stdout plus a bounded ring buffer served at GET /logs, so there
 * is a public log view that needs no login.
 *
 * Correlation ids travel through AsyncLocalStorage rather than being threaded
 * as an argument: the interesting events happen deep inside the transfer
 * transaction, where a logger parameter at every call site would obscure the
 * money logic.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getConfig } from './config.js';

const config = getConfig();

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
    for (let i = 0; i < take; i += 1) {
      out[i] = this.items[(this.writes - take + i) % this.capacity];
    }
    return out;
  }
}

const buffer = new RingBuffer(config.observability.logBufferSize);

export function recentLogs({ limit = 200, event, level } = {}) {
  let entries = buffer.toArray();
  if (event) {
    entries = entries.filter((e) => typeof e?.event === 'string' && e.event.startsWith(event));
  }
  if (level) entries = entries.filter((e) => e?.level === level);
  return entries.slice(-limit);
}

/** A pino destination is anything with write(string). Parsed here so /logs can
 *  filter; a non-JSON line is kept verbatim rather than dropped. */
const ringDestination = {
  write(line) {
    try {
      buffer.push(JSON.parse(line));
    } catch {
      buffer.push({ level: 'unknown', raw: line.trimEnd() });
    }
  },
};

export const rootLogger = pino(
  {
    level: config.logLevel,
    base: { service: 'wallet-transfer-app', env: config.nodeEnv },
    // Level as a word, not pino's numeric default: these are read by humans
    // through GET /logs.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', 'token', 'password', 'jwt'],
      censor: '[redacted]',
    },
  },
  pino.multistream(
    // Under test, buffer only: the tests assert on emitted events, but writing
    // every line to stdout would bury their output.
    config.nodeEnv === 'test'
      ? [{ stream: ringDestination, level: config.logLevel }]
      : [
          { stream: process.stdout, level: config.logLevel },
          { stream: ringDestination, level: config.logLevel },
        ],
  ),
);

const requestContext = new AsyncLocalStorage();

export function newCorrelationId() {
  return randomUUID();
}

/** Every line emitted inside `fn`, at any depth, carries the correlation id. */
export function withRequestContext({ requestId, method, route }, fn) {
  const logger = rootLogger.child({ request_id: requestId, method, route });
  return requestContext.run({ requestId, logger }, fn);
}

export function log() {
  return requestContext.getStore()?.logger ?? rootLogger;
}

export function currentRequestId() {
  return requestContext.getStore()?.requestId;
}

export function bindCaller(userId) {
  const store = requestContext.getStore();
  if (store) store.logger = store.logger.child({ caller: userId });
}
