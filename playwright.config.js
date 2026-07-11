// @ts-check
import os from 'node:os';
import { defineConfig } from '@playwright/test';

// These tests don't use Playwright's own `page` fixture -- scripts/runner.mjs
// launches and drives its own Chromium instance per invocation. This config
// just uses @playwright/test as a well-behaved parallel test runner/reporter
// around a CLI (spawned via node:child_process) that itself drives a browser.
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  // Each test spawns at least one real headless Chromium (SwiftShader, so
  // CPU- not GPU-bound); scale local concurrency to the machine rather than
  // a fixed guess. CI stays pinned at 2 -- shared runners don't have the same
  // headroom and this hasn't been measured there.
  workers: process.env.CI ? 2 : Math.min(os.cpus().length, 8),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
});
