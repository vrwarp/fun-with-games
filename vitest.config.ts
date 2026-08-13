import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Playwright owns tests/e2e; vitest must not try to run those.
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Only the headless, deterministic layers are unit-testable in Node.
      // The Babylon render layer is covered by Playwright e2e instead.
      include: ['src/sim/**/*.ts', 'src/net/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        // Browser-only transports: they need WebRTC / BroadcastChannel and are
        // covered by the Playwright suite instead.
        'src/net/transports/trystero.ts',
        'src/net/transports/broadcast.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
