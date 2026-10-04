// Browser tests (Phase 10): real Chromium pages for the host, the big screen and several phones.
// Run with `npm run test:e2e` (it builds first). The server is the production build with the
// example content only (tests/e2e/server.mjs).
import { defineConfig } from '@playwright/test';

const port = '3296';
export const PASSWORD = 'e2e-admin-password'; // a test value: this server only ever has example data

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  // one game on one server: the tests run in order and share it
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  outputDir: '../../test-results',
  webServer: {
    command: 'node tests/e2e/server.mjs',
    cwd: '../..',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: { E2E_PASSWORD: PASSWORD, E2E_PORT: port },
  },
});
