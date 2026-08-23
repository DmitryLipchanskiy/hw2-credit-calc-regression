import { defineConfig } from '@playwright/test';

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
  ],
});
