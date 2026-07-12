import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatch, tmpOutDir, serveFixtureHttp } from './helpers.js';

// waitForReady (scripts/runner.mjs) exists to avoid testing a half-hydrated
// page, but its current implementation pays two costs unrelated to whether
// the DOM has actually settled: (1) it blocks DOM-stability polling behind a
// full networkidle wait (up to 5s), even on a page whose DOM finished
// changing instantly; (2) it samples on a blind fixed 600ms tick rather than
// reacting to when mutations actually happen, so staged/bursty hydration
// accumulates discretization slop on top of the real settle time.
//
// bursty-hydration-chatty-network.html exercises both: its last real DOM
// mutation lands at ~600ms and nothing ever changes again, but a harmless
// setInterval fetch every 300ms means the network never truly goes idle.
test.describe('page-readiness performance', () => {
  test('bursty-hydration-chatty-network.html: background network chatter should not stall page-ready detection', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveFixtureHttp('bursty-hydration-chatty-network.html');
    try {
      const t0 = Date.now();
      const { trace } = await runBatch({ url: fixture.url, persona: 'keyboard', outDir, maxSteps: 5 });
      const elapsed = Date.now() - t0;

      // Sanity check first: this must not pass by giving up early and
      // testing a half-built page. All four staged buttons should have
      // mounted and been reachable by the crawl.
      const texts = trace.steps.map((s) => s.text);
      expect(texts).toContain('Loaded 3');

      // The page's DOM was fully settled well under a second in; readiness
      // detection should track that, not the unrelated background network
      // chatter (which alone costs a full 5s under the current strict
      // networkidle-gated implementation).
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // A MutationObserver-based readiness check has no native way to scope
  // childList (node insertion/removal) events to a CSS selector the way
  // attributeFilter scopes attribute events -- it must filter added/removed
  // nodes itself in the callback. Without that filtering, ANY background DOM
  // churn unrelated to focusable content (a live ticker, a chat widget
  // appending messages, an ad slot refreshing) resets the quiet window
  // forever and the page is never declared ready. background-dom-churn.html
  // has two static buttons (the focusable count never changes) plus an
  // unrelated node ticker that never stops.
  test('background-dom-churn.html: unrelated background DOM churn should not stall page-ready detection', async () => {
    const outDir = tmpOutDir();
    const fixture = await serveFixtureHttp('background-dom-churn.html');
    try {
      const t0 = Date.now();
      const { trace } = await runBatch({ url: fixture.url, persona: 'keyboard', outDir, maxSteps: 5 });
      const elapsed = Date.now() - t0;

      const names = trace.steps.map((s) => s.ax_name_role_state?.name);
      expect(names).toContain('A');
      expect(names).toContain('B');

      // maxWaitMs (8s) plus ordinary Chromium/crawl overhead would put a
      // false "never settles" run comfortably over 8s; a correct
      // implementation should resolve in the low seconds.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
