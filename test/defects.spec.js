import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runBatch, fixtureUrl, tmpOutDir, serveCrossOriginIframeFixture, serveLazyImageFixture } from './helpers.js';

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

  test('bg-image-meaning.html: 1.1.1 image-only-control checks fire for the seeded defects only', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings, pageAudit, vpDir } = await runBatch({ url: fixtureUrl('bg-image-meaning.html'), persona: 'screen-reader', outDir, maxSteps: 10 });

      // F3 — meaning conveyed only by a CSS background image, including one
      // whose glyph lives entirely on a ::before pseudo-element.
      const f3 = findings.find((x) => x.id.startsWith('bg-image-only-control'));
      expect(f3, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(f3.wcag).toBe('1.1.1');
      expect(f3.persona).toBe('screen-reader'); // perception/semantics — screen-reader profile
      // The aria-labelled twin and the decorative texture behind real text
      // must not fire. All three delivery vectors do: element background,
      // ::before background, content:url() on ::after.
      expect([...f3.evidence].sort()).toEqual(['#icon-content', '#icon-pseudo', '#icon-search']);

      // F39 — the control's only content is an image explicitly suppressed
      // from assistive tech (alt="").
      const f39 = findings.find((x) => x.id.startsWith('suppressed-image-only-control'));
      expect(f39, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(f39.wcag).toBe('1.1.1');
      expect(f39.evidence).toEqual(['#logo-link']);

      // FP guards: the properly-named patterns never back a finding.
      const allEvidence = findings.flatMap((x) => x.evidence);
      expect(allEvidence).not.toContain('#named-img-link');
      expect(allEvidence).not.toContain('#icon-btn');
      expect(allEvidence).not.toContain('#spacer');

      // The audit DATA still lists every url() background (the AI layer's
      // decorative-vs-meaningful judgment input) — but never pure gradients.
      const page = Object.values(pageAudit.pages)[0];
      const bgSelectors = page.background_images.map((b) => b.selector);
      expect(bgSelectors).toContain('#texture-section');
      expect(bgSelectors).toContain('#icon-cart');
      expect(bgSelectors).not.toContain('#grad');
      // Suppressed images are censused with their reason even when they back
      // no finding (spacer: no interactive context; icon-btn svg: named button).
      const spacer = page.suppressed_images.find((s) => s.selector === '#spacer');
      expect(spacer?.reason).toBe('empty-alt');
      expect(page.suppressed_images.some((s) => s.reason === 'aria-hidden' && s.tag === 'svg')).toBe(true);
      expect(page.suppressed_images.find((s) => s.selector === '#brand-svg')?.reason).toBe('unnamed-svg');
      // Every sizeable image entry got an evidence crop the AI layer can look at.
      const withShots = [...page.background_images, ...page.suppressed_images].filter((e) => e.screenshot);
      expect(withShots.length).toBeGreaterThan(0);
      for (const e of withShots) {
        expect(fs.existsSync(path.join(vpDir, e.screenshot))).toBe(true);
      }
      // Below-the-fold guard: the crop must come from a fullPage frame. A
      // viewport-only frame would clamp this 24px-tall region (y ≈ 1300 on an
      // 800px-tall viewport) into a sliver/1x1 stub — assert real dimensions
      // straight from the PNG's IHDR header.
      const deep = page.background_images.find((b) => b.selector === '#deep-banner');
      expect(deep?.screenshot, JSON.stringify(page.background_images, null, 2)).toBeTruthy();
      const ihdr = fs.readFileSync(path.join(vpDir, deep.screenshot));
      expect(ihdr.readUInt32BE(16)).toBeGreaterThanOrEqual(24); // width
      expect(ihdr.readUInt32BE(20)).toBeGreaterThanOrEqual(24); // height
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('fake-interactive.html: handler-without-semantics checks fire for the seeded elements only', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings, pageAudit } = await runBatch({ url: fixtureUrl('fake-interactive.html'), persona: 'all', outDir, maxSteps: 15 });

      // 2.1.1 — click-handled but neither focusable nor semantically
      // interactive: a FUNCTION failure, so it files under the keyboard profile.
      const mouseOnly = findings.find((x) => x.id.startsWith('handler-not-focusable'));
      expect(mouseOnly, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(mouseOnly.wcag).toBe('2.1.1');
      expect(mouseOnly.persona).toBe('keyboard');
      expect([...mouseOnly.evidence].sort()).toEqual(['#fake-div', '#inline-div']);

      // 4.1.2 — focusable and click-handled but generic role: reachable, so a
      // SEMANTICS failure — screen-reader profile.
      const missingRole = findings.find((x) => x.id.startsWith('handler-missing-role'));
      expect(missingRole, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(missingRole.persona).toBe('screen-reader');
      expect(missingRole.evidence).toEqual(['#focus-span']);

      // 4.1.2 — explicit role missing its ARIA-required state (semantics —
      // screen-reader profile). All three variants: aria-checked,
      // aria-expanded, aria-valuenow.
      const missingState = findings.find((x) => x.id.startsWith('role-missing-required-state'));
      expect(missingState, JSON.stringify(findings, null, 2)).toBeTruthy();
      expect(missingState.persona).toBe('screen-reader');
      expect([...missingState.evidence].sort()).toEqual(['#bad-check', '#bad-combo', '#bad-slider']);

      // FP guards: the native button, the delegation container, the
      // key-listener-only scope, the native input with role=switch (state
      // carried natively), the uncorroborated listener, the aria-hidden
      // widget, and the cursor-only lead must not back any finding.
      const allEvidence = findings.flatMap((x) => x.evidence);
      for (const guard of ['#real-btn', '#card-list', '#shortcut-scope', '#native-switch',
        '#quiet-div', '#hidden-widget', '#react-card']) {
        expect(allEvidence, `${guard} must not back any finding`).not.toContain(guard);
      }

      // ...but the excluded suspects stay visible as audit DATA, with the
      // signals the AI layer needs to probe them.
      const page = Object.values(pageAudit.pages)[0];
      const cand = (sel) => page.interactive_candidates.find((c) => c.selector === sel);
      expect(cand('#quiet-div')?.pointer_listener).toBe(true);     // listener, no corroboration
      expect(cand('#quiet-div')?.cursor_pointer).toBe(false);
      expect(cand('#hidden-widget')?.aria_hidden).toBe(true);      // excluded by aria-hidden
      expect(cand('#react-card')?.pointer_listener).toBe(false);   // framework-delegation shape
      expect(cand('#react-card')?.cursor_pointer).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('lazy-image.html: audit evidence crop contains the lazily-loaded pixels, not the unloaded placeholder', async () => {
    // Field-observed limitation: a below-fold image whose pixels only load
    // when its region nears the viewport (IntersectionObserver swapper here;
    // native loading="lazy" in the wild) produced a blank evidence crop —
    // the fullPage capture never scrolls, so the loader never fired. Served
    // over HTTP with a delayed image response (the fixture is deliberately
    // not keyboard-focusable and its real pixels arrive over the network:
    // a same-instant data-URI swap or a Tab-scroll would load it by
    // accident and pass vacuously). The crop must show the REAL image
    // (solid red), or the AI layer is judging decorative-vs-meaningful
    // against an empty rectangle.
    const outDir = tmpOutDir();
    const fixture = await serveLazyImageFixture(500);
    try {
      const { pageAudit, vpDir } = await runBatch({ url: fixture.url, persona: 'screen-reader', outDir, maxSteps: 5 });
      const page = Object.values(pageAudit.pages)[0];
      const entry = page.suppressed_images.find((s) => s.selector === '#lazy-img');
      expect(entry?.screenshot, JSON.stringify(page.suppressed_images, null, 2)).toBeTruthy();
      const png = PNG.sync.read(fs.readFileSync(path.join(vpDir, entry.screenshot)));
      let red = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i] > 150 && png.data[i + 1] < 80 && png.data[i + 2] < 80) red++;
      }
      // The 60x60 image dominates its 4px-padded crop (~68x68): well over
      // half the pixels are solid #cc0000 once actually loaded; the white
      // placeholder yields ~0.
      expect(red / (png.width * png.height), `red fraction of ${entry.screenshot}`).toBeGreaterThan(0.5);
    } finally {
      await fixture.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('fake-interactive.html: page-audit findings gate by profile (function → keyboard, semantics → screen-reader)', async () => {
    const outDir = tmpOutDir();
    try {
      // Keyboard-only: the function check fires, the semantics checks stay quiet.
      const kb = await runBatch({ url: fixtureUrl('fake-interactive.html'), persona: 'keyboard', outDir, maxSteps: 15 });
      expect(kb.findings.some((x) => x.id.startsWith('handler-not-focusable'))).toBe(true);
      expect(kb.findings.some((x) => x.id.startsWith('handler-missing-role'))).toBe(false);
      expect(kb.findings.some((x) => x.id.startsWith('role-missing-required-state'))).toBe(false);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir);
      // Screen-reader-only: the inverse.
      const sr = await runBatch({ url: fixtureUrl('fake-interactive.html'), persona: 'screen-reader', outDir, maxSteps: 15 });
      expect(sr.findings.some((x) => x.id.startsWith('handler-not-focusable'))).toBe(false);
      expect(sr.findings.some((x) => x.id.startsWith('handler-missing-role'))).toBe(true);
      expect(sr.findings.some((x) => x.id.startsWith('role-missing-required-state'))).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('clean.html: zero pass/fail (A/AA) findings', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'all', outDir, maxSteps: 15 });
      // AAA findings are informative-only by this tool's own design (never a
      // scenario failure) -- only pass/fail (A/AA) findings represent an actual defect here.
      const passFailFindings = findings.filter((f) => f.conformance_level !== 'AAA');
      expect(passFailFindings, JSON.stringify(passFailFindings, null, 2)).toEqual([]);
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
      // rendering (macOS vs Linux/SwiftShader). Only pass/fail (A/AA) findings are defects.
      const passFailFindings = findings.filter((f) => f.conformance_level !== 'AAA');
      expect(passFailFindings, JSON.stringify(passFailFindings, null, 2)).toEqual([]);
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
