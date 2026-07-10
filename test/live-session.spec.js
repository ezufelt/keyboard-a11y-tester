import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureUrl, tmpOutDir, randomPort, startServe, stopServe, runObserve, runStep, runFinish } from './helpers.js';

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
