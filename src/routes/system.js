import { Router } from 'express';
import { checkDatastore } from '../db/pool.js';
import { recentLogs } from '../logger.js';
import { registry } from '../metrics.js';
import { readInvariants } from '../services/accounts.js';
import { asyncHandler } from './async-handler.js';

export const systemRouter = Router();

/**
 * Liveness. Touches no dependency on purpose: this answers "is the process
 * alive", and an orchestrator must not kill a healthy process because the
 * database blipped. Readiness is where dependency health belongs.
 */
systemRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
});

/**
 * Readiness, including the datastore. Returns 503 when the database is
 * unreachable so the load balancer drains this instance rather than killing it.
 */
systemRouter.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const datastore = await checkDatastore();
    res.status(datastore.ok ? 200 : 503).json({
      status: datastore.ok ? 'ready' : 'not_ready',
      datastore,
    });
  }),
);

systemRouter.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }),
);

/**
 * Recent structured logs, so there is a public log view that needs no login.
 * Served from a bounded in-memory ring buffer, which means it is per-instance
 * and lost on restart -- stdout remains the durable copy.
 */
systemRouter.get('/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({
    logs: recentLogs({
      limit,
      event: typeof req.query.event === 'string' ? req.query.event : undefined,
      level: typeof req.query.level === 'string' ? req.query.level : undefined,
    }),
  });
});

/**
 * System-wide aggregates so conservation can be verified from outside.
 *
 * total_balance_paise must be identical before and after any burst, and
 * ledger_sum_paise must always be zero. No per-user data is exposed.
 */
systemRouter.get(
  '/invariants',
  asyncHandler(async (_req, res) => {
    const invariants = await readInvariants();
    res.json({
      ...invariants,
      ledger_balanced: invariants.ledger_sum_paise === 0,
    });
  }),
);
