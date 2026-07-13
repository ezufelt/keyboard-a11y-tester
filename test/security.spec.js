// Regression tests for the local-hardening fixes (secret redaction, opt-in
// debug port, private output dirs, path-traversal sanitization). Each asserts
// on the runner's on-disk output as a black-box, matching the rest of the suite.
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {
  runBatch, startServe, stopServe, runStep,
  fixtureUrl, tmpOutDir, REPO_ROOT, RUNNER,
} from './helpers.js';

const execFileP = promisify(execFile);

test.describe('local session hardening', () => {
  // #1a: a pre-filled secret field's .value must never be persisted to the
  // trace, while ordinary (non-secret) values still are (no over-redaction).
  test('a secret field value is never written to the trace; non-secret values still are', async () => {
    const outDir = tmpOutDir();
    try {
      const { trace } = await runBatch({ url: fixtureUrl('secret-field.html'), persona: 'keyboard', outDir, maxSteps: 8 });
      const serialized = JSON.stringify(trace);
      expect(serialized).not.toContain('LAKSHMI_SECRET_PW'); // type=password .value must not reach disk
      expect(serialized).toContain('ADE_PUBLIC_USERNAME');   // a normal text input's value is still captured
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // #2: serve must not open an unauthenticated remote-debugging endpoint unless
  // the operator explicitly asks for one with --port.
  test('serve opens no CDP debug port by default (opt-in via --port only)', async () => {
    const outDir = tmpOutDir();
    let session;
    try {
      session = await startServe({ url: fixtureUrl('secret-field.html'), persona: 'keyboard', outDir }); // no port
      const sessionJson = JSON.parse(fs.readFileSync(path.join(session.sessionDir, 'session.json'), 'utf8'));
      expect(sessionJson.cdpUrl).toBeNull();
    } finally {
      if (session) await stopServe(session.sessionDir, session.proc);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // #1b: text typed via `step --type` into a secret field must be redacted from
  // steps.json (recorded as a length, never the literal secret).
  test('--type into a secret field is redacted from steps.json', async () => {
    const outDir = tmpOutDir();
    let session;
    try {
      session = await startServe({ url: fixtureUrl('secret-field.html'), persona: 'keyboard', outDir });
      await runStep(session.sessionDir, { press: 'Tab' }); // -> username
      await runStep(session.sessionDir, { press: 'Tab' }); // -> password
      await runStep(session.sessionDir, { type: 'TYPED_SECRET_XYZ' });
      const steps = fs.readFileSync(path.join(session.sessionDir, 'steps.json'), 'utf8');
      expect(steps).not.toContain('TYPED_SECRET_XYZ');
      expect(steps).toContain('redacted');
    } finally {
      if (session) await stopServe(session.sessionDir, session.proc);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // #3: the output tree (traces, screenshots, control socket) holds data from a
  // possibly-authenticated run under a world-readable temp dir, so its dirs must
  // be owner-only (no group/other bits) to stop other local users traversing in.
  test('output directories are created private (0700)', async () => {
    test.skip(process.platform === 'win32', 'POSIX permission bits only');
    const outDir = tmpOutDir();
    try {
      const { vpDir } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'keyboard', outDir, maxSteps: 4 });
      for (const dir of [vpDir, path.join(vpDir, 'screenshots')]) {
        expect(fs.statSync(dir).mode & 0o077).toBe(0);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // #4: a test-case id from operator-supplied YAML flows into output paths, so a
  // "../"-laden id must be sanitized rather than escaping the output root.
  test('a malicious test-case id cannot escape the output root', async () => {
    const outRoot = tmpOutDir();
    const marker = `${path.basename(outRoot)}-escape`;
    const escaped = path.join(outRoot, '..', marker);
    const yamlPath = path.join(outRoot, 'evil.test.yaml');
    fs.writeFileSync(yamlPath,
      `id: "../${marker}"\n` +
      `target:\n  start_url: "${fixtureUrl('clean.html')}"\n` +
      'viewports:\n  - name: desktop\n    width: 1280\n    height: 800\n');
    try {
      await execFileP('node', [RUNNER, yamlPath, '--persona', 'keyboard', '--max-steps', '3', '--out', outRoot],
        { cwd: REPO_ROOT, timeout: 55_000 });
      expect(fs.existsSync(escaped)).toBe(false);
    } finally {
      fs.rmSync(outRoot, { recursive: true, force: true });
      fs.rmSync(escaped, { recursive: true, force: true });
    }
  });
});
