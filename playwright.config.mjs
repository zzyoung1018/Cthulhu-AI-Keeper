import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.e2e.mjs',
  fullyParallel: false,
  reporter: 'list',
  timeout: 30_000,
  use: {
    headless: true,
    trace: 'retain-on-failure'
  }
});
