import express from 'express';
import {
  ERROR_CODES,
  invalidRequest,
  methodNotAllowed,
  notFound,
  toAppError,
} from './errors.js';
import { log, newCorrelationId, withRequestContext } from './logger.js';
import * as metrics from './metrics.js';
import { accountsRouter } from './routes/accounts.js';
import { dashboardRouter } from './routes/dashboard.js';
import { demoRouter } from './routes/demo.js';
import { systemRouter } from './routes/system.js';
import { transfersRouter } from './routes/transfers.js';

/**
 * Methods each path accepts, so a wrong-method request gets 405 instead of 404.
 * Hand-written rather than introspected: an explicit list is easier to verify,
 * and a test pins it.
 */
const KNOWN_ROUTES = [
  { pattern: /^\/$/, methods: ['GET'] },
  { pattern: /^\/(healthz|readyz|metrics|logs|invariants)$/, methods: ['GET'] },
  { pattern: /^\/auth\/token$/, methods: ['POST'] },
  { pattern: /^\/dev\/credit$/, methods: ['POST'] },
  { pattern: /^\/accounts$/, methods: ['POST'] },
  { pattern: /^\/accounts\/me$/, methods: ['GET'] },
  { pattern: /^\/transfers$/, methods: ['POST'] },
  { pattern: /^\/transfers\/[^/]+$/, methods: ['GET'] },
];

/**
 * Not logged per request: the dashboard polls three of these every few seconds
 * and a platform health check hits another every thirty, which filled 924 of
 * 1000 ring-buffer slots and evicted every transfer event. Still counted in
 * metrics -- the buffer is scarce and human-facing, a counter is not.
 */
const UNLOGGED_ROUTES = new Set([
  '/',
  '/metrics',
  '/logs',
  '/healthz',
  '/readyz',
  '/invariants',
]);

/** Matched route pattern, so /transfers/<uuid> aggregates as /transfers/:id
 *  rather than producing one time series per transfer. */
function routeLabel(req) {
  if (!req.route) return 'unmatched';
  const base = req.baseUrl ?? '';
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${base}${path}` || '/';
}

function observability(req, res, next) {
  // An inbound id is honoured so a correlation can span services, but
  // length-capped: it lands in log fields and a response header.
  const inbound = req.get('x-request-id');
  const requestId =
    typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
      ? inbound
      : newCorrelationId();

  res.set('X-Request-Id', requestId);
  const startedAt = process.hrtime.bigint();

  withRequestContext({ requestId, method: req.method, route: req.path }, () => {
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = routeLabel(req);

      metrics.observeHttpRequest({
        method: req.method,
        route,
        status: res.statusCode,
        durationSeconds,
      });

      if (!UNLOGGED_ROUTES.has(route)) {
        log().info(
          {
            event: 'http.request',
            route,
            status: res.statusCode,
            duration_ms: Math.round(durationSeconds * 1000),
          },
          'request completed',
        );
      }
    });

    next();
  });
}

export function createApp() {
  const app = express();

  app.set('trust proxy', true); // Render terminates TLS upstream
  app.disable('x-powered-by');

  app.use(observability);
  // Money requests are tiny; a small cap stops a large body being a cheap way
  // to consume memory.
  app.use(express.json({ limit: '16kb' }));

  app.use(dashboardRouter);
  app.use(systemRouter);
  app.use(demoRouter);
  app.use('/accounts', accountsRouter);
  app.use('/transfers', transfersRouter);

  app.use((req, res, next) => {
    const known = KNOWN_ROUTES.find((route) => route.pattern.test(req.path));
    if (known && !known.methods.includes(req.method)) {
      res.set('Allow', known.methods.join(', ')); // required by RFC 9110
      return next(methodNotAllowed(known.methods));
    }
    return next(notFound('No such route'));
  });

  // Every failure leaves through here, so the shape is uniform and no driver
  // detail escapes.
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  app.use((err, _req, res, _next) => {
    const appError =
      err?.type === 'entity.parse.failed'
        ? invalidRequest('Request body must be valid JSON')
        : toAppError(err);

    if (appError.code === ERROR_CODES.INTERNAL) {
      log().error(
        { event: 'request.unhandled_error', error: err?.message, stack: err?.stack },
        'unhandled error',
      );
    }

    res.status(appError.httpStatus).json(appError.toJSON());
  });

  return app;
}
