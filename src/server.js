/**
 * Process entrypoint: boot, serve, and shut down without dropping a request.
 */
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

// Probed once at boot so a broken DATABASE_URL is visible in the logs
// immediately rather than on the first transfer. Deliberately not fatal: the
// process stays up and reports itself unready, which lets the platform show a
// failing readiness check instead of a crash loop.
checkDatastore().then((result) => {
  const level = result.ok ? 'info' : 'error';
  rootLogger[level]({ event: 'db.startup_probe', ...result }, 'datastore probe');
});

async function shutdown(signal) {
  rootLogger.info({ event: 'server.shutdown_started', signal }, 'shutting down');

  // Stop accepting new connections, let in-flight requests finish, then release
  // the pool. Closing the pool first would fail requests that are mid-transfer.
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

  // Backstop: never hang forever holding a container slot.
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
