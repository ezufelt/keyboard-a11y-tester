import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  runBatch, runBatchRaw, tmpOutDir, randomPort,
  serveErrorStatusHttp, serveUaGatedHttp, serveFixtureHttp,
  REPO_ROOT, RUNNER,
} from './helpers.js';

const HEADFUL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// page.goto() only rejects on transport errors, never on HTTP status, so a
// CloudFront 403 or a 404 used to sail through as a successful navigation and
// get audited like a real page. An error body has no focusable elements, which
// a Tab-crawl reports as a keyboard trap — confident findings about a page the
// operator never asked to test.
test.describe('non-2xx navigation is refused', () => {
  for (const status of [403, 404, 500]) {
    test(`batch mode aborts on HTTP ${status} instead of auditing the error page`, async () => {
      const outDir = tmpOutDir();
      const fixture = await serveErrorStatusHttp(status);
      try {
        const { code, output } = await runBatchRaw({ url: fixture.url, outDir, maxSteps: 5 });
        expect(code).not.toBe(0);
        expect(output).toContain(`HTTP ${status}`);
        expect(output).toContain('refusing to audit an error page');
      } finally {
        await fixture.close();
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  }

  test('the aborted run writes no findings — a bogus report must not survive on disk', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveErrorStatusHttp(403);
    try {
      await runBatchRaw({ url: fixture.url, outDir, maxSteps: 5 });
      const stray = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = `${dir}/${e.name}`;
          if (e.isDirectory()) walk(p);
          else if (/findings|trace|run-summary/.test(e.name)) stray.push(p);
        }
      };
      if (fs.existsSync(outDir)) walk(outDir);
      expect(stray).toEqual([]);
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('serve aborts on a blocked start URL rather than handing the agent a live error page', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveErrorStatusHttp(403);
    let proc;
    try {
      const result = await new Promise((resolve) => {
        proc = spawn('node', [
          RUNNER, 'serve', '--url', fixture.url, '--viewport', 'desktop',
          '--persona', 'all', '--out', outDir, '--port', String(randomPort()),
        ], { cwd: REPO_ROOT });
        let out = '';
        proc.stdout.on('data', (c) => { out += c.toString(); });
        proc.stderr.on('data', (c) => { out += c.toString(); });
        proc.once('exit', (code) => resolve({ code, out }));
        setTimeout(() => resolve({ code: 'timeout', out }), 40_000);
      });
      expect(result.out).not.toContain('READY');
      expect(result.code).not.toBe(0);
      expect(result.out).toContain('HTTP 403');
    } finally {
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('a normal 200 page still runs (the guard does not block healthy sites)', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveFixtureHttp('clean.html');
    try {
      const { trace } = await runBatch({ url: fixture.url, outDir, maxSteps: 5 });
      // Assert on a control that only exists in clean.html — an error page also
      // produces steps (focus parked on body), so a bare step count would pass
      // vacuously against exactly the regression this file guards.
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Skip to main content');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// The gate below 403s any request whose UA carries the headless token, so it
// only passes if --user-agent reached the browser's real outbound headers.
test.describe('--user-agent', () => {
  test('is sent on the wire: a UA-gated origin that blocks headless Chromium becomes reachable', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveUaGatedHttp('clean.html');
    try {
      const { trace } = await runBatch({ url: fixture.url, outDir, maxSteps: 5, userAgent: HEADFUL_UA });
      // Must assert real fixture content, not a step count: the gate's 403 body
      // also yields steps, so `length > 0` passes even when the UA never
      // reached the wire (verified — it passed against the pre-fix runner).
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Skip to main content');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('without it, the same origin blocks the run (proves the gate has teeth)', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveUaGatedHttp('clean.html');
    try {
      const { code, output } = await runBatchRaw({ url: fixture.url, outDir, maxSteps: 5 });
      expect(code).not.toBe(0);
      expect(output).toContain('HTTP 403');
      expect(output).toContain('--user-agent');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
