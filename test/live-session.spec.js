import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureUrl, tmpOutDir, deepOutDir, randomPort, startServe, stopServe, runObserve, runStep, runFinish } from './helpers.js';

// Exercises the live serve -> observe/step -> finish -> stop flow, which is a
// genuinely different code path from the batch crawl (CDP session persistence
// via a remote-debugging port, steps.json/session.json accumulation across
// separate process invocations) and isn't covered by anything else here.
test('serve -> observe -> step -> finish -> stop round trip', async () => {
  const outDir = tmpOutDir();
  const port = randomPort();
  let session;
  try {
    session = await startServe({ url: fixtureUrl('mixed-defects.html'), persona: 'all', viewport: 'desktop', port, outDir });

    const obs = await runObserve(session.sessionDir);
    expect(obs.note).toContain('no keystroke');
    expect(obs).toHaveProperty('sr_last_spoken_phrase');

    let last;
    for (let i = 0; i < 5; i++) {
      last = await runStep(session.sessionDir, { press: 'Tab' });
    }
    expect(last.index).toBe(5);
    expect(last).toHaveProperty('sr_announcement');

    const result = await runFinish(session.sessionDir);
    expect(result.steps).toBe(5);
    expect(Array.isArray(result.findings)).toBe(true);

    const trace = JSON.parse(fs.readFileSync(path.join(session.sessionDir, 'trace.json'), 'utf8'));
    expect(trace.mode).toBe('driven-live');
    expect(trace.steps.length).toBe(5);
    expect(fs.existsSync(path.join(session.sessionDir, 'screen-reader-census.json'))).toBe(true);
  } finally {
    if (session) await stopServe(session.sessionDir, session.proc);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// AF_UNIX addresses cap the socket path at 104 bytes on macOS (108 on Linux),
// and `serve` used to bind unconditionally at <session-dir>/control.sock. The
// default macOS TMPDIR is long enough that any real site slug overflowed it,
// so `serve` died with a bare `listen EINVAL` — batch mode was unaffected
// (it binds no socket), which made this look like a site problem rather than
// a tool one. deepOutDir() reproduces the overflow on any platform.
test('serve works when the session dir is too long for an AF_UNIX socket path', async () => {
  const outDir = deepOutDir();
  const port = randomPort();
  let session;
  try {
    session = await startServe({ url: fixtureUrl('clean.html'), persona: 'keyboard', viewport: 'desktop', port, outDir });

    // The socket had to move out of the session dir to fit...
    expect(fs.existsSync(path.join(session.sessionDir, 'control.sock'))).toBe(false);
    // ...and the control channel must still work end to end: observe and step
    // run as separate processes that re-derive the socket path from the
    // session dir, so this fails if serve and the clients disagree about it.
    const obs = await runObserve(session.sessionDir);
    expect(obs.note).toContain('no keystroke');
    const step = await runStep(session.sessionDir, { press: 'Tab' });
    expect(step.index).toBe(1);

    const result = await runFinish(session.sessionDir);
    expect(result.steps).toBe(1);
  } finally {
    if (session) await stopServe(session.sessionDir, session.proc);
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
