import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatch, fixtureUrl, tmpOutDir, serveCrossOriginIframeFixture } from './helpers.js';

test.describe('seeded-defect fixtures', () => {
  test('mixed-defects.html: keyboard + screen-reader findings detected', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('mixed-defects.html'), persona: 'all', outDir, maxSteps: 15 });
      const wcags = findings.map((f) => f.wcag);
      expect(wcags).toContain('1.1.1'); // image with no accessible name
      expect(wcags).toContain('1.3.1'); // heading skip and/or duplicate landmark
      expect(wcags).toContain('4.1.3'); // batch crawl never presses Enter -> live region never fires
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('no-focus-indicator.html: 2.4.7 (Focus Visible) fires', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('no-focus-indicator.html'), persona: 'keyboard', outDir, maxSteps: 10 });
      expect(findings.some((f) => f.wcag === '2.4.7')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('keyboard-trap.html: 2.1.2 (No Keyboard Trap) fires', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('keyboard-trap.html'), persona: 'keyboard', outDir, maxSteps: 10 });
      expect(findings.some((f) => f.wcag === '2.1.2')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('unlabeled-file-input.html: 3.3.2 (UA-default name) fires for the bare file input only', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('unlabeled-file-input.html'), persona: 'keyboard', outDir, maxSteps: 10 });
      const f = findings.find((x) => x.wcag === '3.3.2');
      expect(f, JSON.stringify(findings, null, 2)).toBeTruthy();
      // The label-wrapped file input and the labeled text input must not fire:
      // exactly one control (the bare one) backs this finding.
      expect(f.evidence.length).toBe(1);
      // The bare file input is NOT a 4.1.2 missing-name case -- ACCNAME gives
      // it the UA's own "Choose File", which is exactly why 3.3.2 exists here.
      expect(findings.some((x) => x.wcag === '4.1.2')).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('clean.html: zero AA (pass/fail) findings', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'all', outDir, maxSteps: 15 });
      // AAA findings are informative-only by this tool's own design (never a
      // scenario failure) -- only AA findings represent an actual defect here.
      const aaFindings = findings.filter((f) => f.conformance_level === 'AA');
      expect(aaFindings, JSON.stringify(aaFindings, null, 2)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('focus-within-wrapper.html: 2.4.7 does not false-positive when the indicator is on a :focus-within container', async () => {
    // Regression test: the input itself has no focus style at all -- the
    // border lives on the surrounding wrapper via :focus-within. The tool
    // used to look only at the focused element's own (padded) box, so it
    // never saw the wrapper's border and reported "not visible".
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('focus-within-wrapper.html'), persona: 'keyboard', outDir, maxSteps: 5 });
      expect(findings.some((f) => f.wcag === '2.4.7')).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('clean.html: skip link does not false-positive on 2.4.13 (Focus Appearance)', async () => {
    // Regression test: the skip link is off-canvas (left: -9999px) until
    // :focus, when it jumps on-screen with a strong 3px outline. Once focus
    // moves on it reverts off-canvas, uncovering the nav links underneath at
    // the same coordinates -- diffing against that unrelated content used to
    // corrupt the measured indicator contrast and mark it "weak".
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'keyboard', outDir, maxSteps: 15 });
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('iframe-outer.html: each control inside an iframe is tracked distinctly (same-origin)', async () => {
    // Regression test: document.activeElement in the TOP document is the
    // <iframe> element itself for as long as real focus sits somewhere inside
    // it, no matter which of its controls is actually focused. Left
    // unresolved, every inner control gets misattributed to that one
    // unmoving <iframe> selector -- which both hides their own findings and
    // reads as a keyboard trap (>=3 "focus didn't move" steps) to 2.1.2, and
    // as "no perceivable focus indicator" to 2.4.7 (the diff lands on the
    // iframe's own box, not wherever the real change rendered inside it).
    const outDir = tmpOutDir();
    try {
      const { findings, trace } = await runBatch({ url: fixtureUrl('iframe-outer.html'), persona: 'keyboard', outDir, maxSteps: 12 });
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
      const selectors = trace.steps.map((s) => s.active_element_selector);
      expect(selectors).toContain('#player >>> #play');
      expect(selectors).toContain('#player >>> #pause');
      expect(selectors).toContain('#player >>> #mute');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('iframe-outer.html: each control inside a cross-origin iframe is tracked distinctly', async () => {
    // Same regression as above, but across a genuine cross-origin boundary
    // (127.0.0.1 vs localhost, different ports) so Chrome's site isolation
    // puts the iframe's content in its own out-of-process target -- the shape
    // of a real third-party embed (e.g. a video player), not just a same-
    // origin convenience case.
    const outDir = tmpOutDir();
    const server = await serveCrossOriginIframeFixture();
    try {
      const { findings, trace } = await runBatch({ url: server.url, persona: 'keyboard', outDir, maxSteps: 12 });
      expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
      const selectors = trace.steps.map((s) => s.active_element_selector);
      expect(selectors).toContain('#player >>> #play');
      expect(selectors).toContain('#player >>> #pause');
      expect(selectors).toContain('#player >>> #mute');
    } finally {
      await server.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
