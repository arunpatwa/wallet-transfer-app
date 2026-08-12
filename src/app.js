import express from 'express';
import { ERROR_CODES, invalidRequest, notFound, toAppError } from './errors.js';
import { log, newCorrelationId, withRequestContext } from './logger.js';
import * as metrics from './metrics.js';
import { accountsRouter } from './routes/accounts.js';
import { dashboardRouter } from './routes/dashboard.js';
import { demoRouter } from './routes/demo.js';
import { systemRouter } from './routes/system.js';
import { transfersRouter } from './routes/transfers.js';

/**
 * Labels a finished request for metrics using the matched route pattern rather
 * than the raw path, so /transfers/<uuid> aggregates as /transfers/:id instead
 * of producing one time series per transfer.
 */
function routeLabel(req) {
  if (!req.route) return 'unmatched';
  const base = req.baseUrl ?? '';
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${base}${path}` || '/';
}

/**
 * Assigns a correlation id, makes it available to every log line emitted during
 * the request via AsyncLocalStorage, echoes it back, and records the request
 * against the metrics once it completes.
 *
 * An inbound X-Request-Id is honoured so a correlation id can span services,
 * but it is length-capped: it ends up in log fields and a response header, and
 * an unbounded client-supplied value there is an injection surface.
 */
function observability(req, res, next) {
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

      // One line per request. The events inside the transfer transaction carry
      // the same request_id, so a single transfer is reconstructable from logs.
      log().info(
        {
          event: 'http.request',
          route,
          status: res.statusCode,
          duration_ms: Math.round(durationSeconds * 1000),
        },
        'request completed',
      );
    });

    next();
  });
}

export function createApp() {
  const app = express();

  // Render terminates TLS upstream; without this, req.ip is the proxy's.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(observability);
  // Money requests are tiny. A small cap keeps a large body from becoming a
  // cheap way to consume memory.
  app.use(express.json({ limit: '16kb' }));

  app.use(dashboardRouter);
  app.use(systemRouter);
  app.use(demoRouter);
  app.use('/accounts', accountsRouter);
  app.use('/transfers', transfersRouter);

  app.use((_req, _res, next) => next(notFound('No such route')));

  // Terminal error handler. Every failure leaves through here, so the response
  // shape is uniform and no driver detail escapes.
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  app.use((err, _req, res, _next) => {
    // A body that is not valid JSON fails in express.json() before any handler.
    const appError =
      err?.type === 'entity.parse.failed'
        ? invalidRequest('Request body must be valid JSON')
        : toAppError(err);

    if (appError.code === ERROR_CODES.INTERNAL) {
      // Unexpected: log the real error, return nothing revealing.
      log().error(
        { event: 'request.unhandled_error', error: err?.message, stack: err?.stack },
        'unhandled error',
      );
    }

    res.status(appError.httpStatus).json(appError.toJSON());
  });

  return app;
}
