#!/usr/bin/env node
// Preflight for the keyboard-a11y-tester skill.
//
// Reports — as JSON on stdout — whether the two prerequisites are satisfied:
//   deps_installed    : node_modules present (playwright resolvable)
//   browser_available : the Chromium build the runner actually launches works
//
// Uses only Node built-ins until deps are confirmed, so it runs even before
// `npm install`. The agent runs this FIRST and asks the user before installing
// anything that is missing (and does NOT ask about the browser if it's already
// available).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // scripts/.. = skill root
const depsInstalled = fs.existsSync(path.join(skillDir, 'node_modules', 'playwright', 'package.json'));

const result = {
  deps_installed: depsInstalled,
  browser_available: null,
  install_deps_cmd: 'npm install',
  install_browser_cmd: 'npx playwright install chromium',
};

if (depsInstalled) {
  // Truly verify access by launching the exact browser the runner uses.
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    await browser.close();
    result.browser_available = true;
  } catch (e) {
    result.browser_available = false;
    result.browser_error = String(e.message || e).split('\n')[0];
  }
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
