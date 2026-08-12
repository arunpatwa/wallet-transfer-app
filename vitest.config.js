import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // Test files share one database and each resets it, so running them in
    // parallel would let one file's TRUNCATE delete another file's fixtures.
    fileParallelism: false,
    // The concurrency tests fire large bursts; the default 5s is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
