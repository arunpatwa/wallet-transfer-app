/**
 * Prometheus metrics, exposed at GET /metrics.
 *
 * Latency is recorded twice on purpose: a histogram, which is what you need to
 * aggregate percentiles correctly across instances in Prometheus, and a summary
 * with pre-computed quantiles, so p99 is readable straight off /metrics without
 * a Prometheus server standing in front of it.
 */
import {
  Registry,
  Counter,
  Histogram,
  Summary,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'wallet_' });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled, by method, route and status. Error rate is derivable from the status label.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route', 'status'],
  // Tuned for a database-bound API: dense where a single indexed round trip
  // lands, with headroom out to the statement timeout.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const httpRequestQuantiles = new Summary({
  name: 'http_request_duration_summary_seconds',
  help: 'HTTP request latency quantiles over a sliding 10 minute window.',
  labelNames: ['route'],
  percentiles: [0.5, 0.9, 0.99],
  maxAgeSeconds: 600,
  ageBuckets: 6,
  registers: [registry],
});

export const transfersApplied = new Counter({
  name: 'transfers_applied_total',
  help: 'Transfers that moved money.',
  registers: [registry],
});

export const transfersRejected = new Counter({
  name: 'transfers_rejected_total',
  help: 'Transfers refused, by reason.',
  labelNames: ['reason'],
  registers: [registry],
});

export const idempotentReplays = new Counter({
  name: 'idempotent_replays_total',
  help: 'Requests that replayed a previously recorded outcome instead of moving money.',
  registers: [registry],
});

export const raceLost = new Counter({
  name: 'race_lost_total',
  help: 'Concurrent requests that lost a create race and deferred to the winner, by kind.',
  labelNames: ['kind'], // 'idempotency_key' | 'wallet'
  registers: [registry],
});

export const authFailures = new Counter({
  name: 'auth_failures_total',
  help: 'Rejected authentication attempts, by reason.',
  labelNames: ['reason'],
  registers: [registry],
});

export const walletsCreated = new Counter({
  name: 'wallets_created_total',
  help: 'Wallet rows created, by the path that created them.',
  labelNames: ['via'], // 'accounts' | 'transfer'
  registers: [registry],
});

export const dbTransactionRetries = new Counter({
  name: 'db_transaction_retries_total',
  help: 'Transactions retried after a serialization failure or deadlock, by SQLSTATE.',
  labelNames: ['code'],
  registers: [registry],
});

export const datastoreUp = new Gauge({
  name: 'datastore_up',
  help: '1 when the last readiness probe reached the database, 0 otherwise.',
  registers: [registry],
});

/** Records one finished HTTP request against all three request metrics. */
export function observeHttpRequest({ method, route, status, durationSeconds }) {
  const labels = { method, route, status: String(status) };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, durationSeconds);
  httpRequestQuantiles.observe({ route }, durationSeconds);
}
