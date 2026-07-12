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

  test('broken-aria-reference.html: 4.1.2 (broken ARIA ID reference) fires for the broken refs only', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings, census } = await runBatch({ url: fixtureUrl('broken-aria-reference.html'), persona: 'screen-reader', outDir, maxSteps: 10 });
      const f = findings.find((x) => x.id.startsWith('sr-broken-aria-reference'));
      expect(f, JSON.stringify(findings, null, 2)).toBeTruthy();
      // aria-controls="missing-panel" and aria-errormessage="missing-error" both
      // fire; the valid aria-describedby="email-hint" must not appear.
      expect(f.evidence.length).toBe(2);
      expect(f.evidence).toContain('#toggle');
      expect(f.evidence).toContain('#password');
      expect(f.evidence).not.toContain('#email');
      const page = Object.values(census.pages)[0];
      expect(page.declared_broken_aria_refs.length).toBe(2);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('focusable-hidden-from-at.html: 4.1.2 (focusable but AT-invisible) fires for the hidden control only', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('focusable-hidden-from-at.html'), persona: 'all', outDir, maxSteps: 10 });
      const f = findings.find((x) => x.id.startsWith('sr-focusable-not-exposed'));
      expect(f, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(f.evidence).toEqual(['#hidden-btn']);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('focusable-hidden-from-at.html: 4.1.2 (focusable but AT-invisible) still fires under --persona screen-reader alone', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('focusable-hidden-from-at.html'), persona: 'screen-reader', outDir, maxSteps: 10 });
      expect(findings.some((x) => x.id.startsWith('sr-focusable-not-exposed'))).toBe(true);
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

  test('detached-focus-ring.html: 2.4.7 does not false-positive when the indicator is a JS-positioned overlay unrelated by DOM structure', async () => {
    // Regression test: the input has no focus style and the ring is a
    // sibling, not an ancestor -- neither the own-box nor the ancestor-box
    // tier can see it. Only the geometric nearby-search tier
    // (findNearbyIndicatorBox) does.
    const outDir = tmpOutDir();
    try {
      const { findings, trace } = await runBatch({ url: fixtureUrl('detached-focus-ring.html'), persona: 'keyboard', outDir, maxSteps: 5 });
      expect(findings.some((f) => f.wcag === '2.4.7')).toBe(false);
      expect(trace.steps.some((s) => s.focus_visible?.indicator === 'detached')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('focus-fill-high-contrast.html: no 1.4.1 and no 2.4.13-weak when a full-box fill has >= 3:1 luminance contrast', async () => {
    // Regression test: a card/button that swaps its whole background colour
    // on focus (no ring/underline/outline) used to get misclassified as an
    // 'edge' cue -- the top/bottom edge bands are subsets of the box, so a
    // uniform fill lights them up too -- which both hid it from the 1.4.1
    // check entirely and corrupted the AAA contrast measurement (restricted
    // to a thin perimeter band instead of the real interior change).
    const outDir = tmpOutDir();
    try {
      const { findings, trace } = await runBatch({ url: fixtureUrl('focus-fill-high-contrast.html'), persona: 'keyboard', outDir, maxSteps: 5 });
      expect(findings.some((f) => f.wcag === '1.4.1')).toBe(false);
      expect(findings.some((f) => f.wcag === '2.4.13')).toBe(false);
      expect(findings.some((f) => f.wcag === '2.4.7')).toBe(false);
      const fv = trace.steps.find((s) => s.active_element_selector === '#b1')?.focus_visible;
      expect(fv?.indicator).toBe('interior-only');
      expect(fv?.color_safe).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('focus-fill-color-only.html: 1.4.1 (Use of Color) fires for an isoluminant full-box fill', async () => {
    // Same fill pattern as focus-fill-high-contrast.html, but the focused/
    // unfocused backgrounds are near-isoluminant (~1.05:1) -- the only real
    // difference is hue. With no ring/underline as a colourblind-safe
    // fallback, this must fail 1.4.1.
    const outDir = tmpOutDir();
    try {
      const { findings, trace } = await runBatch({ url: fixtureUrl('focus-fill-color-only.html'), persona: 'keyboard', outDir, maxSteps: 5 });
      const f = findings.find((x) => x.wcag === '1.4.1');
      expect(f, JSON.stringify(findings, null, 2)).toBeTruthy();
      // 2.4.7 is presence-only and does not care about colour -- the fill is
      // still a perceivable change, so it must not also fail here.
      expect(findings.some((x) => x.wcag === '2.4.7')).toBe(false);
      const fv = trace.steps.find((s) => s.active_element_selector === '#b1')?.focus_visible;
      expect(fv?.indicator).toBe('interior-only');
      expect(fv?.color_safe).toBe(false);
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
      const { findings, trace } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'keyboard', outDir, maxSteps: 15 });
      // AAA findings are informative-only; area-measurement varies by platform
      // rendering (macOS vs Linux/SwiftShader). Only AA findings are defects.
      const aaFindings = findings.filter((f) => f.conformance_level === 'AA');
      expect(aaFindings, JSON.stringify(aaFindings, null, 2)).toEqual([]);
      // Regression guard: contrast corruption on step_0001 was the original bug.
      // If it regresses the measured contrast drops below 3:1; platform-area
      // variance (which only affects the AAA area sub-check) is a separate concern.
      const skipLinkStep = trace.steps.find((s) => s.step_id === 'step_0001');
      if (skipLinkStep?.focus_appearance) {
        expect(
          skipLinkStep.focus_appearance.contrast,
          'skip link focus indicator contrast must be ≥ 3:1 (contrast-corruption regression)'
        ).toBeGreaterThanOrEqual(3.0);
      }
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
