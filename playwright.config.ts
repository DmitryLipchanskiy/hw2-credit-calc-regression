import { defineConfig } from '@playwright/test';

/** Origin the `e2e` project talks to; serve.mjs listens here (override with PORT). */
const E2E_ORIGIN = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    // Machine-readable totals for scripts/ci-summary.mjs: a green job must prove
    // it actually ran tests, not merely that nothing failed.
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'core',
      testDir: './tests/core',
    },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      use: { baseURL: E2E_ORIGIN },
    },
  ],

  // The calculator page loads app.js as an ES module, and a browser blocks module
  // imports over file:// — the page would come up blank with nothing in the console
  // pointing at the real cause. serve.mjs compiles src/ui and serves it over http;
  // see the comment at the top of that file.
  //
  // The command keeps forward slashes on purpose: it is a command line handed to node,
  // not a path built in JS, and node accepts '/' on Windows too. @types/node is not a
  // dependency of this project, so `process.env.CI` cannot be read here — hence
  // reuseExistingServer is unconditional rather than CI-aware.
  webServer: {
    command: 'node src/ui/serve.mjs',
    url: `${E2E_ORIGIN}/`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
