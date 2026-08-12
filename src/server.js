import { createApp } from './app.js';
import { getConfig } from './config.js';
import { checkDatastore, closePool } from './db/pool.js';
import { rootLogger } from './logger.js';

const config = getConfig();
const app = createApp();

const server = app.listen(config.port, () => {
  rootLogger.info(
    {
      event: 'server.listening',
      port: config.port,
      demo_token_endpoint: config.demo.tokenEndpointEnabled,
      faucet: config.demo.faucetEnabled,
    },
    'listening',
  );
});

// Probed at boot so a broken DATABASE_URL is visible immediately. Deliberately
// not fatal: the process stays up and reports itself unready, which shows as a
// failing readiness check rather than a crash loop.
checkDatastore().then((result) => {
  rootLogger[result.ok ? 'info' : 'error'](
    { event: 'db.startup_probe', ...result },
    'datastore probe',
  );
});

async function shutdown(signal) {
  rootLogger.info({ event: 'server.shutdown_started', signal }, 'shutting down');

  // Drain in-flight requests before releasing the pool; closing the pool first
  // would fail requests that are mid-transfer.
  server.close(async () => {
    try {
      await closePool();
      rootLogger.info({ event: 'server.shutdown_complete' }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      rootLogger.error({ event: 'server.shutdown_failed', error: err.message }, 'shutdown failed');
      process.exit(1);
    }
  });

  setTimeout(() => {
    rootLogger.error({ event: 'server.shutdown_timeout' }, 'forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  rootLogger.error(
    { event: 'process.unhandled_rejection', error: reason?.message ?? String(reason) },
    'unhandled rejection',
  );
});
