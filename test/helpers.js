// Shared helpers for driving scripts/runner.mjs as a black-box CLI from tests.
// These tests never touch Playwright's own `page` fixture -- the runner
// launches and drives its own Chromium instance per invocation; we only spawn
// it as a child process and assert on its stdout/output files.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const RUNNER = path.join(REPO_ROOT, 'scripts', 'runner.mjs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

export function fixtureUrl(name) {
  return 'file://' + path.join(FIXTURES_DIR, name);
}

// storageState's localStorage injection needs a real HTTP(S) origin — Chromium
// rejects it for file:// pages ("origin 'null' is not supported"). Fixtures
// that need to prove storageState was applied must be served, not opened
// directly. Caller must call close() when done.
export function serveFixtureHttp(name) {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, url: origin + '/', close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Writes a minimal Playwright storageState file seeding localStorage for one
// origin, in outDir so it's cleaned up alongside the rest of the test's output.
export function writeStorageState(outDir, origin, localStorageEntries) {
  const file = path.join(outDir, 'storage-state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: localStorageEntries }] }));
  return file;
}

// Serves HTML that differs based on a session cookie, inspected server-side —
// real login cookies are frequently httpOnly (invisible to page JS), so this
// is the realistic shape for cookie-based auth, unlike a client-side
// localStorage check. Proves the cookie was actually sent by the browser
// (i.e. that storageState applied it), not just present in the seed file.
export function serveCookieGatedHttp(cookieName, expectedValue) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
          const i = c.indexOf('=');
          return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
        }),
      );
      const authed = cookies[cookieName] === expectedValue;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fixture: cookie-gated content</title>
<style>a:focus, button:focus { outline: 3px solid #06c; }</style></head>
<body><main id="main"><h1>Cookie-gated fixture</h1>
${authed ? '<button id="secret">Secret dashboard</button>' : '<a id="locked" href="#">Please log in</a>'}
</main></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, url: origin + '/', close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Writes a minimal Playwright storageState file seeding one cookie, in outDir
// so it's cleaned up alongside the rest of the test's output.
export function writeStorageStateCookie(outDir, origin, cookie) {
  const domain = new URL(origin).hostname;
  const file = path.join(outDir, 'storage-state-cookie.json');
  fs.writeFileSync(file, JSON.stringify({
    cookies: [{
      name: cookie.name, value: cookie.value, domain, path: '/',
      expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
    }],
    origins: [],
  }));
  return file;
}

export function tmpOutDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'katest-'));
}

export function randomPort() {
  return 9200 + Math.floor(Math.random() * 800);
}

// file:// URLs synthesize an empty case id (see synthCase() in runner.mjs), so
// output lands directly at <outDir>/<viewport> rather than
// <outDir>/<case-id>/<viewport>. Search instead of replicating that logic, so
// this helper works for both file:// fixtures and real URLs.
function findViewportDir(outDir, viewport) {
  const direct = path.join(outDir, viewport);
  if (fs.existsSync(path.join(direct, 'trace.json'))) return direct;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(outDir, entry.name, viewport);
    if (fs.existsSync(path.join(candidate, 'trace.json'))) return candidate;
  }
  throw new Error(`could not find trace.json for viewport "${viewport}" under ${outDir}`);
}

function readOutputs(outDir, viewport) {
  const vpDir = findViewportDir(outDir, viewport);
  const trace = JSON.parse(fs.readFileSync(path.join(vpDir, 'trace.json'), 'utf8'));
  const findings = JSON.parse(fs.readFileSync(path.join(vpDir, 'deterministic-findings.json'), 'utf8')).findings;
  const censusPath = path.join(vpDir, 'screen-reader-census.json');
  const census = fs.existsSync(censusPath) ? JSON.parse(fs.readFileSync(censusPath, 'utf8')) : null;
  const screenshotsDir = path.join(vpDir, 'screenshots');
  const screenshotCount = fs.existsSync(screenshotsDir) ? fs.readdirSync(screenshotsDir).length : 0;
  return { vpDir, trace, findings, census, screenshotCount };
}

// Runs the batch (blind Tab-crawl) mode to completion and returns parsed output.
export async function runBatch({ url, persona = 'all', viewport = 'desktop', outDir, maxSteps, storageState }) {
  const args = [RUNNER, '--url', url, '--viewport', viewport, '--persona', persona, '--out', outDir];
  if (maxSteps) args.push('--max-steps', String(maxSteps));
  if (storageState) args.push('--storage-state', storageState);
  const { stdout, stderr } = await execFileP('node', args, { cwd: REPO_ROOT, timeout: 55_000 });
  return { stdout, stderr, ...readOutputs(outDir, viewport) };
}

// Runs the batch mode across ALL of a test case's default viewports (desktop
// + mobile for a synthesized file:// case, since --viewport is omitted) and
// returns the top-level cross-viewport-findings.json -- the one artifact that
// needs more than one viewport's data to exist at all.
export async function runBatchAllViewports({ url, persona = 'all', outDir, maxSteps }) {
  const args = [RUNNER, '--url', url, '--persona', persona, '--out', outDir];
  if (maxSteps) args.push('--max-steps', String(maxSteps));
  const { stdout, stderr } = await execFileP('node', args, { cwd: REPO_ROOT, timeout: 90_000 });
  const crossViewportPath = path.join(outDir, 'cross-viewport-findings.json');
  const crossViewportFindings = fs.existsSync(crossViewportPath)
    ? JSON.parse(fs.readFileSync(crossViewportPath, 'utf8')).findings
    : null;
  return { stdout, stderr, crossViewportFindings };
}

// Starts a live `serve` session in the background; resolves once it prints
// READY. Callers MUST call stopServe() in a finally block -- the served
// browser stays alive (and the process keeps running) until `stop` is called.
export function startServe({ url, persona = 'all', viewport = 'desktop', port, outDir, storageState }) {
  return new Promise((resolve, reject) => {
    const args = [RUNNER, 'serve', '--url', url, '--viewport', viewport, '--persona', persona, '--port', String(port), '--out', outDir];
    if (storageState) args.push('--storage-state', storageState);
    const proc = spawn('node', args, { cwd: REPO_ROOT });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`serve did not print READY within 30s. stderr:\n${err}`));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onStdout);
      proc.off('exit', onExit);
    };
    const onStdout = (chunk) => {
      out += chunk.toString();
      const m = out.match(/READY (.+)/);
      if (m) {
        cleanup();
        resolve({ proc, sessionDir: m[1].trim() });
      }
    };
    const onExit = (code) => {
      if (!out.includes('READY')) {
        cleanup();
        reject(new Error(`serve exited (${code}) before printing READY. stderr:\n${err}`));
      }
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.once('exit', onExit);
  });
}

export async function stopServe(sessionDir, proc) {
  await execFileP('node', [RUNNER, 'stop', sessionDir], { cwd: REPO_ROOT }).catch(() => {});
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    setTimeout(resolve, 8_000); // don't hang the suite if shutdown misbehaves
  });
}

export async function runObserve(sessionDir) {
  const { stdout } = await execFileP('node', [RUNNER, 'observe', sessionDir], { cwd: REPO_ROOT, timeout: 15_000 });
  return JSON.parse(stdout);
}

export async function runStep(sessionDir, { press, type } = {}) {
  const args = [RUNNER, 'step', sessionDir];
  if (type != null) args.push('--type', type);
  else args.push('--press', press || 'Tab');
  const { stdout } = await execFileP('node', args, { cwd: REPO_ROOT, timeout: 15_000 });
  return JSON.parse(stdout);
}

export async function runFinish(sessionDir) {
  const { stdout } = await execFileP('node', [RUNNER, 'finish', sessionDir], { cwd: REPO_ROOT, timeout: 30_000 });
  return JSON.parse(stdout);
}
