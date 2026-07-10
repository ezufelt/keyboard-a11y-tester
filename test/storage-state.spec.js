import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  runBatch, startServe, stopServe, runStep, runFinish,
  fixtureUrl, tmpOutDir, randomPort, serveFixtureHttp, writeStorageState,
  serveCookieGatedHttp, writeStorageStateCookie,
} from './helpers.js';

// auth-gate.html renders a different focusable control depending on whether
// localStorage has an authToken — that's the signal these tests use to prove
// --storage-state actually reached the browser context, not just that the
// flag was accepted.
test.describe('--storage-state', () => {
  test('seeds localStorage before first navigation: authenticated content is reachable', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveFixtureHttp('auth-gate.html');
    try {
      const stateFile = writeStorageState(outDir, fixture.origin, [{ name: 'authToken', value: 'abc123' }]);
      const { trace } = await runBatch({ url: fixture.url, outDir, storageState: stateFile, maxSteps: 5 });
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Secret dashboard');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('seeds a session cookie: authenticated content is reachable (most real logins use cookies, not localStorage)', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveCookieGatedHttp('session', 'tok-xyz');
    try {
      const stateFile = writeStorageStateCookie(outDir, fixture.origin, { name: 'session', value: 'tok-xyz' });
      const { trace } = await runBatch({ url: fixture.url, outDir, storageState: stateFile, maxSteps: 5 });
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Secret dashboard');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('wrong-shape (but valid JSON) storage-state file fails fast with a clear error', async () => {
    const outDir = tmpOutDir();
    try {
      const badFile = path.join(outDir, 'wrong-shape.json');
      fs.writeFileSync(badFile, JSON.stringify({ hello: 'world' }));
      let error;
      try {
        await runBatch({ url: fixtureUrl('clean.html'), outDir, storageState: badFile });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error.stderr).toContain('not a Playwright storageState export');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('without --storage-state, the same page is tested logged out', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveFixtureHttp('auth-gate.html');
    try {
      const { trace } = await runBatch({ url: fixture.url, outDir, maxSteps: 5 });
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Please log in');
      expect(names).not.toContain('Secret dashboard');
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('missing storage-state file fails fast with a clear error', async () => {
    const outDir = tmpOutDir();
    try {
      let error;
      try {
        await runBatch({ url: fixtureUrl('clean.html'), outDir, storageState: path.join(outDir, 'nope.json') });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error.stderr).toContain('Storage state file not found');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('invalid JSON storage-state file fails fast with a clear error', async () => {
    const outDir = tmpOutDir();
    try {
      const badFile = path.join(outDir, 'bad.json');
      fs.writeFileSync(badFile, '{ not valid json');
      let error;
      try {
        await runBatch({ url: fixtureUrl('clean.html'), outDir, storageState: badFile });
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error.stderr).toContain('not valid JSON');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('serve mode: loads storage state at launch and keeps it alive across steps', async () => {
    const outDir = tmpOutDir();
    const port = randomPort();
    const fixture = await serveFixtureHttp('auth-gate.html');
    let session;
    try {
      const stateFile = writeStorageState(outDir, fixture.origin, [{ name: 'authToken', value: 'abc123' }]);
      session = await startServe({ url: fixture.url, port, outDir, storageState: stateFile });

      let last;
      for (let i = 0; i < 2; i++) last = await runStep(session.sessionDir, { press: 'Tab' });
      expect(last.index).toBe(2);

      await runFinish(session.sessionDir);
      const trace = JSON.parse(fs.readFileSync(path.join(session.sessionDir, 'trace.json'), 'utf8'));
      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('Secret dashboard');
    } finally {
      if (session) await stopServe(session.sessionDir, session.proc);
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
