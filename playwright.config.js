// @ts-check
import { defineConfig } from '@playwright/test';

// These tests don't use Playwright's own `page` fixture -- scripts/runner.mjs
// launches and drives its own Chromium instance per invocation. This config
// just uses @playwright/test as a well-behaved parallel test runner/reporter
// around a CLI (spawned via node:child_process) that itself drives a browser.
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  // Each test spawns at least one real headless Chromium; cap concurrency so
  // CI (and modest local machines) aren't launching a dozen browsers at once.
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
});
