import { Router } from 'express';
import { checkDatastore } from '../db/pool.js';
import { recentLogs } from '../logger.js';
import { registry } from '../metrics.js';
import { readInvariants } from '../services/accounts.js';
import { asyncHandler } from './async-handler.js';

export const systemRouter = Router();

/** Liveness. Touches no dependency, so an orchestrator never kills a healthy
 *  process over a database blip. */
systemRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
});

/** Readiness. 503 when the datastore is unreachable, so the load balancer
 *  drains this instance rather than it being restarted. */
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

/** Public log view. Per-instance and lost on restart; stdout is the durable copy. */
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

/** Lets conservation be verified from outside: total_balance_paise must never
 *  change and ledger_sum_paise must always be zero. */
systemRouter.get(
  '/invariants',
  asyncHandler(async (_req, res) => {
    const invariants = await readInvariants();
    res.json({ ...invariants, ledger_balanced: invariants.ledger_sum_paise === 0 });
  }),
);
