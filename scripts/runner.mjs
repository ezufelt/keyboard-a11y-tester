#!/usr/bin/env node
// Keyboard-only accessibility testing tool.
//
// Drives a page keyboard-only (Playwright + raw CDP), captures a per-step trace
// with focused-region screenshots, and emits deterministic WCAG findings.
//
// I/O contract (stable — do not break):
//   input : a --url or a test-case YAML (see test-cases/*.test.yaml)
//   output: <out>/<testcase-id>/<viewport>/{trace.json, deterministic-findings.json, screenshots/}
//
// The deterministic layer produces 2.1.1 / 2.1.2 / 2.4.3 / 2.4.7 (+ a 3.2.1 probe).
// The AI-judgment layer (the `ai:` checks) is out of scope for the runner: the
// invoking agent reads the trace and writes those findings.

import { chromium } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default output root: a per-user temp directory, so the tool never writes into
// the project/skill directory. Override with --out.
const DEFAULT_OUT_ROOT = path.join(os.tmpdir(), 'keyboard-a11y-tester');
const outRootFrom = (arg) => (arg ? path.resolve(arg) : DEFAULT_OUT_ROOT);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], out: null, viewport: null, maxSteps: 150, press: null, type: null, port: null, storageState: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--viewport') args.viewport = argv[++i];
    else if (a === '--max-steps') args.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--press') args.press = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--goal') args.goal = argv[++i];
    else if (a === '--storage-state') args.storageState = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

// Resolves --storage-state to an absolute path, failing fast if it is missing or
// not valid JSON: a silently-ignored auth file would make the whole run test the
// logged-out site while claiming to test the logged-in one.
function resolveStorageState(arg) {
  if (!arg) return null;
  const p = path.resolve(arg);
  if (!fs.existsSync(p)) { log(`Storage state file not found: ${p}`); process.exit(1); }
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log(`Storage state file is not valid JSON: ${p}\n  ${err.message}`);
    process.exit(1);
  }
  return p;
}

const USAGE = `
keyboard-a11y-runner — keyboard-only accessibility runner

Output goes to a per-user temp dir by default (\${TMPDIR}/keyboard-a11y-tester); override
with --out <dir>. Nothing is written into the project/skill directory.

Authenticated runs: pass a Playwright storageState JSON file with --storage-state <file>
to start the browser with its cookies and localStorage (e.g. an already-logged-in session).
Generate one with \`context.storageState({ path: 'auth.json' })\` or \`npx playwright codegen
--save-storage=auth.json <url>\`.

Batch (blind Tab-crawl over the start page, per viewport):
  node scripts/runner.mjs (--url <url> [--goal "<task>"] | <test-case.yaml>) [--out <dir>] [--viewport <name>] [--max-steps <n>] [--storage-state <file>]

Live agentic session (the agent observes and decides each keystroke):
  node scripts/runner.mjs serve  (--url <url> [--goal "<task>"] | <test-case.yaml>) [--viewport <name>] [--out <dir>] [--port <n>] [--storage-state <file>]
       → launches a persistent browser, navigates, prints the session dir. Keep running.
       → --url runs against any site ad-hoc (no YAML); --viewport desktop|mobile (default desktop).
       → --storage-state applies once at launch; the session browser keeps the state alive
         for every subsequent \`step\`.
  node scripts/runner.mjs observe <session-dir>
       → capture current focus state without a keystroke (initial observation).
  node scripts/runner.mjs step   <session-dir> (--press <Key> | --type <text>)
       → perform ONE keystroke, print the resulting observation (focus name/role/URL/
         style/screenshot path). The agent reads this, then decides the next step.
  node scripts/runner.mjs finish <session-dir>
       → compute focus-visible + deterministic findings over the driven trace.
  node scripts/runner.mjs stop   <session-dir>
       → close the browser / end the session.

  Keys: Tab Shift+Tab Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight Home End
`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(4, '0');
const stepId = (n) => `step_${pad(n)}`;
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

function log(...m) {
  process.stderr.write(m.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// In-page collectors (serialized to the browser). Kept as strings so they run
// via CDP Runtime.callFunctionOn against document.activeElement.
// ---------------------------------------------------------------------------

// Computes a reasonably stable CSS selector + geometry for a given element.
// Runs in page context; `this` is the element.
const COLLECT_ACTIVE = /* js */ `
function () {
  const el = this;
  if (!el || el === document.body || el === document.documentElement) {
    return {
      isBody: true,
      selector: el === document.documentElement ? ':root' : 'body',
      tag: el ? el.tagName.toLowerCase() : null,
      tabindex: null, bbox: null, domOrderIndex: -1, url: location.href,
      text: '', hasHref: false
    };
  }
  function cssPath(node) {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      return '#' + CSS.escape(node.id);
    }
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const parent = cur.parentNode;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }
  // Document-order index across all elements (basis for 2.4.3 focus-order check).
  const all = document.querySelectorAll('*');
  let domOrderIndex = -1;
  for (let i = 0; i < all.length; i++) { if (all[i] === el) { domOrderIndex = i; break; } }
  const r = el.getBoundingClientRect();
  const tabindexAttr = el.getAttribute('tabindex');
  // Computed focus appearance — ground truth for 2.4.7 PRESENCE (the element is
  // focused right now, so :focus-visible rules are reflected here). This is the
  // proof a focus style exists, independent of how faint it renders in pixels.
  const cs = getComputedStyle(el);
  const focusStyle = {
    outline_style: cs.outlineStyle,
    outline_width: cs.outlineWidth,
    outline_color: cs.outlineColor,
    outline_offset: cs.outlineOffset,
    box_shadow: cs.boxShadow === 'none' ? null : cs.boxShadow,
    has_outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
    has_shadow: cs.boxShadow !== 'none' && cs.boxShadow !== '',
  };
  // Human locator: the nearest landmark region and the nearest preceding heading
  // so a reviewer can find the control on the page ("the carousel under <h2>").
  const LANDMARKS = 'main,nav,header,footer,aside,form,section,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=region],[role=search],[role=form]';
  var landmark = null;
  var lm = el.closest(LANDMARKS);
  if (lm) {
    var lbId = lm.getAttribute('aria-labelledby');
    var lbEl = lbId ? document.getElementById(lbId) : null;
    var label = lm.getAttribute('aria-label') || (lbEl ? lbEl.innerText : '') || '';
    var role = lm.getAttribute('role') || lm.tagName.toLowerCase();
    landmark = (role + (label ? ' "' + label.trim().slice(0, 40) + '"' : '')).trim();
  }
  var heading = null;
  var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (var hi = 0; hi < hs.length; hi++) {
    if (hs[hi].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      heading = (hs[hi].innerText || '').trim().slice(0, 60);
    }
  }
  var region = { landmark: landmark, heading: heading };
  return {
    isBody: false,
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    tabindex: tabindexAttr === null ? null : parseInt(tabindexAttr, 10),
    bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
    domOrderIndex,
    url: location.href,
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
    hasHref: el.tagName.toLowerCase() === 'a' && !!el.getAttribute('href'),
    focusStyle,
    region
  };
}`;

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

// Returns { objectId } for document.activeElement (or null if body/none).
async function activeElementObjectId(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.activeElement',
    returnByValue: false,
  });
  return result && result.objectId ? result.objectId : null;
}

// Ground-truth accessible name / role / states from the accessibility tree.
async function axForBackendNode(cdp, backendNodeId) {
  try {
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: false,
    });
    if (!nodes || !nodes.length) return null;
    // The requested node is the last in the returned partial tree.
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) || nodes[nodes.length - 1];
    const states = {};
    for (const p of node.properties || []) {
      states[p.name] = p.value && 'value' in p.value ? p.value.value : p.value;
    }
    return {
      role: node.role?.value ?? null,
      name: node.name?.value ?? null,
      ignored: !!node.ignored,
      states,
    };
  } catch {
    return null;
  }
}

// Collects selector/geometry + AX for whatever currently has focus.
async function captureFocused(cdp) {
  const objectId = await activeElementObjectId(cdp);
  if (!objectId) {
    return { isBody: true, selector: 'body', ax: null };
  }
  let geom;
  try {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: COLLECT_ACTIVE,
      returnByValue: true,
    });
    geom = result.value;
  } catch {
    geom = { isBody: false, selector: '(unknown)', bbox: null, domOrderIndex: -1 };
  }
  let ax = null;
  try {
    const { node } = await cdp.send('DOM.describeNode', { objectId });
    if (node && node.backendNodeId) ax = await axForBackendNode(cdp, node.backendNodeId);
  } catch {
    /* AX best-effort */
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
  return { ...geom, ax };
}

// ---------------------------------------------------------------------------
// Screenshots & focus-visible pixel diff
// ---------------------------------------------------------------------------

// Focus indicators (outline/box-shadow rings) render OUTSIDE the element's
// border box and are excluded from getBoundingClientRect(). Inflate the region
// before cropping so the ring is inside the compared/saved area.
const FOCUS_PAD = 8;
function inflate(box, pad = FOCUS_PAD) {
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

// Crops a region out of a decoded PNG, fully clamped so the source rect can
// never read outside the image (elements can sit partly/fully off the viewport,
// e.g. an off-canvas mobile menu). Returns a 1x1 stub if there is no overlap.
function cropPng(png, box) {
  const x = Math.min(Math.max(0, Math.floor(box.x)), Math.max(0, png.width - 1));
  const y = Math.min(Math.max(0, Math.floor(box.y)), Math.max(0, png.height - 1));
  const w = Math.max(1, Math.min(Math.ceil(box.width), png.width - x));
  const h = Math.max(1, Math.min(Math.ceil(box.height), png.height - y));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

// Count of pixels that differ between two same-region crops.
function changedPixels(focusedPng, baselinePng, region) {
  const a = cropPng(focusedPng, region);
  const b = cropPng(baselinePng, region);
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  if (w < 1 || h < 1) return null;
  const A = w === a.width && h === a.height ? a : cropPng(a, { x: 0, y: 0, width: w, height: h });
  const B = w === b.width && h === b.height ? b : cropPng(b, { x: 0, y: 0, width: w, height: h });
  const diff = new PNG({ width: w, height: h });
  return { changed: pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.1 }), area: w * h };
}

// Ring presence is measured over thin annular slices at increasing offset from
// the border box, taking the max. A thin band keeps a 1px outline a large
// fraction of its slice (so thin outlines register), while several slices cover
// rings drawn with an outline-offset (which a single close band would miss).
const RING_SLICES = [0, 3, 6, 9];

// WCAG relative luminance of an 8-bit sRGB colour (for 2.4.13 contrast).
function relLum(r, g, b) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Focus-indicator metrics, computed by diffing the focused frame against a
// scroll-aligned unfocused baseline (never touches focus programmatically).
//
//   AA  (2.4.7 Focus Visible): PRESENCE only — is there *any* perceivable change
//        on focus? No size/contrast bar (2.4.7 sets none). Measured across a thin
//        border band, the interior, and top/bottom edge strips so outlines,
//        fills, and underlines all register regardless of thickness.
//   AAA (2.4.13 Focus Appearance, INFORMATIVE): the objective bar — the changed
//        area is at least a 2px-thick perimeter of the component AND the changed
//        pixels have >= 3:1 luminance contrast between focused/unfocused states.
function focusMetrics(focusedPng, baselinePng, box) {
  if (!box || box.width < 1 || box.height < 1) return null;
  const inner = changedPixels(focusedPng, baselinePng, box);
  if (!inner) return null;
  // Changed pixels within each cumulative padded region, then per-slice fraction.
  const cum = RING_SLICES.map((p) => (p === 0 ? inner : changedPixels(focusedPng, baselinePng, inflate(box, p))));
  let borderBand = 0;
  for (let k = 1; k < cum.length; k++) {
    if (!cum[k] || !cum[k - 1]) continue;
    const sliceArea = cum[k].area - cum[k - 1].area;
    if (sliceArea < 1) continue;
    const frac = Math.max(0, cum[k].changed - cum[k - 1].changed) / sliceArea;
    if (frac > borderBand) borderBand = frac;
  }
  const interior = inner.area >= 1 ? inner.changed / inner.area : 0;
  const bandH = Math.max(1, box.height * 0.3);
  const top = changedPixels(focusedPng, baselinePng, { x: box.x, y: box.y, width: box.width, height: bandH });
  const bot = changedPixels(focusedPng, baselinePng, { x: box.x, y: box.y + box.height - bandH, width: box.width, height: bandH });
  const edge = Math.max(
    top && top.area >= 1 ? top.changed / top.area : 0,
    bot && bot.area >= 1 ? bot.changed / bot.area : 0
  );
  const visible =
    borderBand >= PRESENCE_FLOOR || interior >= PRESENCE_FLOOR || edge >= PRESENCE_FLOOR;

  // AAA (2.4.13): count changed pixels and their focused/unfocused luminance
  // over the indicator region, then compare to the 2px-perimeter reference.
  const region = inflate(box, 4);
  const A = cropPng(focusedPng, region);
  const B = cropPng(baselinePng, region);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  let changedArea = 0, fLum = 0, bLum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const iA = (y * A.width + x) * 4;
      const iB = (y * B.width + x) * 4;
      const d = Math.max(
        Math.abs(A.data[iA] - B.data[iB]),
        Math.abs(A.data[iA + 1] - B.data[iB + 1]),
        Math.abs(A.data[iA + 2] - B.data[iB + 2])
      );
      if (d > 32) {
        changedArea++;
        fLum += relLum(A.data[iA], A.data[iA + 1], A.data[iA + 2]);
        bLum += relLum(B.data[iB], B.data[iB + 1], B.data[iB + 2]);
      }
    }
  }
  const refArea = Math.round(2 * 2 * (box.width + box.height)); // ~2px-thick perimeter
  let contrast = null, contrastPass = null;
  if (changedArea > 0) {
    const hi = Math.max(fLum, bLum) / changedArea;
    const lo = Math.min(fLum, bLum) / changedArea;
    contrast = (hi + 0.05) / (lo + 0.05);
    contrastPass = contrast >= 3;
  }
  return {
    borderBand, interior, edge, visible,
    aaa: {
      changed_area: changedArea,
      ref_area_2px_perimeter: refArea,
      area_pass: changedArea >= refArea,
      contrast: contrast === null ? null : Number(contrast.toFixed(2)),
      contrast_pass: contrastPass,
    },
  };
}

// ---------------------------------------------------------------------------
// Step capture (shared by the blind Tab-crawl and the AI-driven mode)
// ---------------------------------------------------------------------------

// Captures one step AFTER the caller has performed a keystroke. Records the
// focused element, its AX name/role/state, geometry, computed focus style,
// locator region, and a focused-region screenshot; appends the full frame for
// the focus-visible neighbour diff. Returns { step, contextChange }.
async function recordStep(page, cdp, { keystroke, index, screenshotsDir, prevStep, startUrl, fullFrames }) {
  const focused = await captureFocused(cdp);
  const focusMoved = !prevStep || prevStep.active_element_selector !== focused.selector;
  let contextChange = null;
  if (focused.url && focused.url !== startUrl) {
    contextChange = { step: index, from: startUrl, to: focused.url };
  }

  const framePng = PNG.sync.read(await page.screenshot());
  fullFrames.push(framePng);

  let shotRel = null;
  if (focused.bbox && focused.bbox.width >= 1 && focused.bbox.height >= 1) {
    const crop = cropPng(framePng, inflate(focused.bbox));
    shotRel = path.join('screenshots', `${stepId(index)}.png`);
    fs.writeFileSync(path.join(screenshotsDir, `${stepId(index)}.png`), PNG.sync.write(crop));
  }

  const step = {
    step_id: stepId(index),
    index,
    keystroke_sent: keystroke,
    active_element_selector: focused.selector,
    tag: focused.tag ?? null,
    tabindex: focused.tabindex ?? null,
    dom_order_index: focused.domOrderIndex ?? -1,
    ax_name_role_state: focused.ax
      ? { name: focused.ax.name, role: focused.ax.role, states: focused.ax.states }
      : null,
    focus_moved: focusMoved,
    bounding_box: focused.bbox ?? null,
    url: focused.url ?? startUrl,
    text: focused.text ?? '',
    is_body: !!focused.isBody,
    computed_focus_style: focused.focusStyle ?? null,
    region: focused.region ?? null,
    focused_region_screenshot: shotRel,
    focus_visible: null, // filled in post-process
  };
  return { step, contextChange };
}

// ---------------------------------------------------------------------------
// The blind Tab-crawl (mechanical capture; scenario navigation is driven mode)
// ---------------------------------------------------------------------------

async function crawl(page, cdp, { maxSteps, screenshotsDir }) {
  const steps = [];
  const fullFrames = []; // decoded PNG per step, for focus-visible neighbour diff
  ensureDir(screenshotsDir);

  const restPng = PNG.sync.read(await page.screenshot()); // baseline: nothing focused
  const startUrl = page.url();
  let firstSelector = null;
  let contextChangeOnFocus = null; // 3.2.1 probe

  for (let i = 1; i <= maxSteps; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30); // let auto-scroll / focus settle
    const { step, contextChange } = await recordStep(page, cdp, {
      keystroke: 'Tab', index: i, screenshotsDir, prevStep: steps[steps.length - 1], startUrl, fullFrames,
    });
    if (contextChange && !contextChangeOnFocus) contextChangeOnFocus = contextChange;
    steps.push(step);

    if (!step.is_body && firstSelector === null) firstSelector = step.active_element_selector;
    if (firstSelector && step.active_element_selector === firstSelector && i > 1) {
      step.cycle_closed = true; // full forward cycle → tab order closed
      break;
    }
  }

  finalizeFocusVisible(steps, fullFrames, restPng);
  return { steps, startUrl, contextChangeOnFocus };
}

// ---------------------------------------------------------------------------
// Focus-visible post-process (2.4.7 AA presence + 2.4.13 AAA), shared.
// Baseline for step N = frame N+1, where N is no longer focused (falls back to
// the rest baseline for the final step). Never touches focus programmatically.
// ---------------------------------------------------------------------------

function finalizeFocusVisible(steps, fullFrames, restPng) {
  for (let n = 0; n < steps.length; n++) {
    const s = steps[n];
    if (!s.bounding_box || s.is_body) continue;
    const baseline = fullFrames[n + 1] || restPng;
    const m = focusMetrics(fullFrames[n], baseline, s.bounding_box);
    if (m === null) {
      s.focus_visible = { visible: null, note: 'region too small / indeterminate' };
      s.focus_appearance = null;
    } else {
      // 2.4.7 PRESENCE (AA) combines two independent signals so a faint-but-real
      // indicator is not missed: (a) the computed focus style declares an outline
      // or box-shadow, and (b) pixels actually change on focus. Either counts as
      // present; a declared style that renders too faintly to diff still passes
      // AA (it exists) and is caught as weak by the AAA measure below.
      const cfs = s.computed_focus_style;
      const styleCue = !!(cfs && (cfs.has_outline || cfs.has_shadow));
      const pixelCue = m.visible;
      const visible = styleCue || pixelCue;
      // 1.4.1 classification: a shape cue (outline/shadow/underline/border) is
      // colourblind-safe; interior-only may be a safe fill OR colour-only.
      const shapeCue = styleCue || m.borderBand >= PRESENCE_FLOOR || m.edge >= PRESENCE_FLOOR;
      let indicator = 'none';
      if (styleCue) indicator = cfs.has_outline ? 'outline' : 'shadow';
      else if (m.borderBand >= PRESENCE_FLOOR) indicator = 'ring';
      else if (m.edge >= PRESENCE_FLOOR) indicator = 'edge';
      else if (m.interior >= PRESENCE_FLOOR) indicator = 'interior-only';
      s.focus_visible = {
        border_band: Number(m.borderBand.toFixed(4)),
        interior: Number(m.interior.toFixed(4)),
        edge: Number(m.edge.toFixed(4)),
        style_cue: styleCue,     // computed outline/box-shadow present
        pixel_cue: pixelCue,     // pixels changed on focus
        visible,                 // AA (2.4.7): present if either cue
        shape_cue: shapeCue,
        indicator,
      };
      // AAA (2.4.13) is only meaningful when an indicator is present. Informative.
      s.focus_appearance = visible
        ? { ...m.aaa, aaa_pass: m.aaa.area_pass && m.aaa.contrast_pass === true }
        : null;
    }
  }
}

// Minimum change in any focus zone to count as a *present* indicator (2.4.7 AA
// is presence-only — no size/contrast bar). Well above the ~0.02-0.04 AA/edge
// noise floor; a real 1px outline fills ~0.3 of the thin border band.
const PRESENCE_FLOOR = 0.10;

// Persona-allowed keys. Text entry is handled separately.
const ALLOWED_KEYS = new Set([
  'Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
]);

// ---------------------------------------------------------------------------
// Deterministic findings from the trace
// ---------------------------------------------------------------------------

function severityFor(wcag) {
  // Rough default severities; AI layer may refine.
  return {
    '2.1.1': 'blocker',
    '2.1.2': 'blocker',
    '1.4.1': 'moderate',
    '2.4.1': 'moderate',
    '2.4.3': 'moderate',
    '2.4.7': 'serious',
    '2.4.13': 'minor',
    '3.2.1': 'serious',
    '4.1.2': 'serious',
  }[wcag] || 'moderate';
}

// conformance_level: 'AA' findings are pass/fail; 'AAA' findings are INFORMATIVE
// (advisory) — never a scenario failure on their own.
function makeFinding({ id, wcag, confidence, viewport, goalId, summary, impact, evidence, severity, level, url, locations }) {
  return {
    id,
    wcag,
    source: 'deterministic',
    conformance_level: level || 'AA',
    confidence,
    severity: severity || severityFor(wcag),
    viewport,
    goal_id: goalId || null,
    url: url || null,               // page the evidence was observed on
    locations: locations || [],     // human locators (landmark / heading) on that page
    summary,
    persona_impact: impact,
    evidence: evidence || [],
  };
}

// Human locator for a focus stop: "<landmark>, under heading “…”".
function locationOf(s) {
  const r = s.region || {};
  const parts = [];
  if (r.landmark) parts.push(r.landmark);
  if (r.heading) parts.push(`under heading “${r.heading}”`);
  return parts.join(', ') || null;
}

// Derive { url, locations } for a finding from the stops that back it.
function locate(stops, fallbackUrl) {
  const url = stops.find((s) => s.url)?.url || fallbackUrl || null;
  const locations = [...new Set(stops.map(locationOf).filter(Boolean))].slice(0, 5);
  return { url, locations };
}

// Scenario testing, not exhaustive: every check below is evaluated PER focus
// stop the persona actually visits, never against a whole-page census. The
// scenario-level verdicts — "was every control *needed to complete the goal*
// keyboard-reachable" (2.1.1) and "no trap *on the path*" (2.1.2 in full) —
// require knowing the goal path and belong to the AI-driven layer.
function deriveFindings({ steps, startUrl, contextChangeOnFocus }, { viewport, goalId }) {
  const findings = [];
  const focusStops = steps.filter((s) => !s.is_body);

  // --- 2.4.7 Focus Visible (AA, pass/fail): PRESENCE of any indicator ------
  const notVisible = focusStops.filter((s) => s.focus_visible && s.focus_visible.visible === false);
  if (notVisible.length) {
    findings.push(
      makeFinding({
        id: `focus-not-visible-${viewport}`,
        wcag: '2.4.7',
        confidence: 0.6,
        viewport,
        goalId,
        ...locate(notVisible, startUrl),
        summary: `${notVisible.length} focus stop(s) showed no perceivable focus indicator at all ` +
          `(no outline, ring, fill, or underline change on focus). e.g. ${notVisible.slice(0, 5).map((s) => s.active_element_selector).join(', ')}`,
        impact: 'A keyboard user cannot tell which control currently has focus.',
        evidence: notVisible.slice(0, 10).map((s) => s.step_id),
      })
    );
  }

  // --- 2.4.13 Focus Appearance (AAA, INFORMATIVE): indicator present but ---
  // below the objective bar (2px-perimeter area and/or 3:1 contrast). Advisory
  // only — never a scenario failure.
  const weak = focusStops.filter(
    (s) => s.focus_appearance && s.focus_appearance.aaa_pass === false
  );
  if (weak.length) {
    findings.push(
      makeFinding({
        id: `focus-appearance-weak-${viewport}`,
        wcag: '2.4.13',
        level: 'AAA',
        confidence: 0.5,
        viewport,
        goalId,
        ...locate(weak, startUrl),
        summary: `${weak.length} focus stop(s) have a visible indicator that does not meet the AAA Focus ` +
          `Appearance bar (>= 2px-perimeter area and >= 3:1 contrast). Informative only. ` +
          `e.g. ${weak.slice(0, 5).map((s) => `${s.active_element_selector} (contrast ${s.focus_appearance.contrast ?? 'n/a'})`).join(', ')}`,
        impact: 'The focus indicator is present but may be hard to perceive for low-vision users.',
        evidence: weak.slice(0, 10).map((s) => s.step_id),
      })
    );
  }

  // --- 1.4.1 Use of Color: focus indicator appears to be interior-only ----
  // Visible on focus, but the change is inside the box with no shape cue
  // (ring/underline/border). That may be a colourblind-safe luminance fill OR
  // a colour-only change that fails 1.4.1. Deterministic layer can't tell hue
  // from luminance — flagged low-confidence for the AI layer to judge.
  const colourOnly = focusStops.filter(
    (s) => s.focus_visible && s.focus_visible.visible === true && s.focus_visible.shape_cue === false
  );
  if (colourOnly.length) {
    findings.push(
      makeFinding({
        id: `focus-indicator-color-only-${viewport}`,
        wcag: '1.4.1',
        confidence: 0.3,
        viewport,
        goalId,
        ...locate(colourOnly, startUrl),
        summary: `${colourOnly.length} focus stop(s) show only an interior change with no shape cue ` +
          `(no outline/underline/border). Needs AI review: a colour-only indicator fails 1.4.1 for users ` +
          `who cannot perceive the hue difference. e.g. ${colourOnly.slice(0, 5).map((s) => s.active_element_selector).join(', ')}`,
        impact: 'A keyboard user with colour blindness may not perceive which control has focus if the only ' +
          'change is colour.',
        evidence: colourOnly.slice(0, 10).map((s) => s.step_id),
      })
    );
  }

  // --- 2.4.3 Focus Order: positive tabindex + order vs DOM ----------------
  const positiveTabindex = focusStops.filter((s) => typeof s.tabindex === 'number' && s.tabindex > 0);
  if (positiveTabindex.length) {
    findings.push(
      makeFinding({
        id: `positive-tabindex-${viewport}`,
        wcag: '2.4.3',
        confidence: 0.9,
        viewport,
        goalId,
        ...locate(positiveTabindex, startUrl),
        summary: `${positiveTabindex.length} element(s) use a positive tabindex, forcing a manual tab order: ` +
          positiveTabindex.slice(0, 5).map((s) => `${s.active_element_selector}[tabindex=${s.tabindex}]`).join(', '),
        impact: 'Positive tabindex overrides natural order and commonly makes focus jump around unpredictably.',
        evidence: positiveTabindex.slice(0, 10).map((s) => s.step_id),
      })
    );
  }
  // (Removed: DOM-order regression heuristic. DOM order legitimately differs
  // from tab/visual order and it fired even on clean pages — logical-order
  // judgement is an AI check against visual layout, not a deterministic one.)

  // --- 2.1.2 No Keyboard Trap (per-stop): focus stalls while tabbing ------
  // A genuine trap shows as focus not advancing for several consecutive Tab
  // presses. (Removed the "did not cycle within budget" check — that only
  // reflected the step cap on long pages, not a trap.)
  let maxStall = 0, stall = 0, stallAt = null;
  for (const s of focusStops) {
    if (!s.focus_moved) { stall++; if (stall > maxStall) { maxStall = stall; stallAt = s; } }
    else stall = 0;
  }
  if (maxStall >= 3) {
    findings.push(
      makeFinding({
        id: `keyboard-trap-stall-${viewport}`,
        wcag: '2.1.2',
        confidence: 0.7,
        viewport,
        goalId,
        ...locate(stallAt ? [stallAt] : [], startUrl),
        summary: `Focus did not advance for ${maxStall} consecutive Tab presses around ` +
          `${stallAt?.active_element_selector} — likely a keyboard trap.`,
        impact: 'A keyboard user gets stuck: Tab no longer moves focus and they cannot proceed.',
        evidence: stallAt ? [stallAt.step_id] : [],
      })
    );
  }

  // --- 3.2.1 On Focus: context change from focus alone --------------------
  if (contextChangeOnFocus) {
    const evStep = steps.find((s) => s.index === contextChangeOnFocus.step);
    findings.push(
      makeFinding({
        id: `context-change-on-focus-${viewport}`,
        wcag: '3.2.1',
        confidence: 0.8,
        viewport,
        goalId,
        ...locate(evStep ? [evStep] : [], startUrl),
        summary: `Tabbing alone changed context (navigated ${contextChangeOnFocus.from} → ${contextChangeOnFocus.to}).`,
        impact: 'Receiving focus unexpectedly navigates the user away, disorienting keyboard users.',
        evidence: evStep ? [evStep.step_id] : [],
      })
    );
  }

  // --- 4.1.2 Name, Role, Value: focusable control with no accessible name -
  // Directly supports the keyboard+speech persona (W3C "Ade"): speech control
  // targets a control by its accessible name, so an unnamed control cannot be
  // operated by voice even when it is keyboard-reachable.
  const unnamed = focusStops.filter((s) => {
    const nm = s.ax_name_role_state?.name;
    return s.ax_name_role_state && (!nm || !String(nm).trim());
  });
  if (unnamed.length) {
    const where = locate(unnamed, startUrl);
    findings.push(
      makeFinding({
        id: `missing-accessible-name-${viewport}`,
        wcag: '4.1.2',
        confidence: 0.7,
        viewport,
        goalId,
        ...where,
        summary: `${unnamed.length} focusable control(s) have no accessible name` +
          (where.locations.length ? ` (${where.locations.join('; ')})` : '') + `: ` +
          unnamed.slice(0, 6).map((s) => `${s.ax_name_role_state?.role || s.tag} at ${s.active_element_selector}`).join(', ') +
          (unnamed.length > 6 ? ' …' : ''),
        impact: 'A keyboard user who relies on speech recognition cannot target these controls by voice, ' +
          'and their purpose is not conveyed programmatically.',
        evidence: unnamed.slice(0, 10).map((s) => s.step_id),
      })
    );
  }

  // --- 2.4.1 Bypass Blocks: no skip link near the top of the tab order -----
  // A motor-fatigue need: without a skip link, reaching main content means
  // tabbing through the entire nav on every page.
  const SKIP_RE = /skip( to| link|nav|-)|jump to (main|content)|to main content|to content/i;
  const head = focusStops.slice(0, 5);
  const hasSkip = head.some((s) =>
    SKIP_RE.test(`${s.text || ''} ${s.ax_name_role_state?.name || ''}`)
  );
  if (!hasSkip && focusStops.length >= 8) {
    findings.push(
      makeFinding({
        id: `no-skip-link-${viewport}`,
        wcag: '2.4.1',
        confidence: 0.55,
        viewport,
        goalId,
        ...locate(head, startUrl),
        summary: 'No "skip to main content" style link was found among the first focus stops.',
        impact: 'A keyboard user must Tab through the entire header/nav to reach main content on ' +
          'every page — painful for users with limited stamina or motor control.',
        evidence: head.map((s) => s.step_id),
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Runtime setup + startup self-check
// ---------------------------------------------------------------------------

// CSS injected at document start to make layout / pixel diffs deterministic.
const DETERMINISM_CSS = `
*, *::before, *::after {
  animation-duration: 0.001s !important;
  animation-delay: 0s !important;
  transition-duration: 0.001s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

async function makeContext(browser, viewport, disableAnimations, storageState) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    isMobile: viewport.name === 'mobile',
    hasTouch: viewport.name === 'mobile',
    ...(storageState ? { storageState } : {}),
    // Keyboard-only persona: no real mouse should ever be used. We simply never
    // call pointer APIs; there is no Playwright switch to hard-disable the mouse.
  });
  if (disableAnimations) {
    await context.addInitScript((css) => {
      const style = document.createElement('style');
      style.textContent = css;
      const add = () => (document.head || document.documentElement).appendChild(style);
      if (document.head) add();
      else document.addEventListener('DOMContentLoaded', add);
    }, DETERMINISM_CSS);
  }
  return context;
}

// Spec §2.2: :focus-visible MUST fire on CDP-driven key events, else every
// focus-indicator check is invalid. Verify on a controlled local page. Throws
// on failure (fail fast).
async function verifyFocusVisibleModality(context) {
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>
      button { outline: none; }
      button:focus-visible { outline: 3px solid #f0f; }
      #probe::after { content: ''; }
    </style></head><body>
      <button id="a">A</button><button id="b">B</button>
      <script>
        window.__fv = { matched: false };
        document.addEventListener('focusin', (e) => {
          if (e.target.matches(':focus-visible')) window.__fv.matched = true;
        });
      </script>
    </body></html>`);
    await page.keyboard.press('Tab'); // keyboard modality → should be focus-visible
    await page.waitForTimeout(30);
    const matched = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(window.__fv.matched || (el && el.matches && el.matches(':focus-visible')));
    });
    if (!matched) {
      throw new Error(
        ':focus-visible did NOT fire on a CDP/Playwright-driven Tab. ' +
        'Focus-indicator (2.4.7) checks would be invalid — aborting.'
      );
    }
    return true;
  } finally {
    await page.close();
  }
}

// Wait for the page to reach a stable state before testing. Testing too early
// (at domcontentloaded) on a hydrating SPA captures a half-built DOM. There is
// no perfect "fully loaded" signal on sites with continuous network chatter, so
// we combine a best-effort network-settle with DOM stability: keep sampling the
// focusable-element count until it stops changing (hydration/lazy content done).
async function waitForReady(page, { quietMs = 600, maxWaitMs = 8000 } = {}) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const countFocusable = () =>
    page.evaluate(() =>
      document.querySelectorAll(
        'a[href],button,input:not([type=hidden]),select,textarea,[tabindex],summary,[contenteditable]'
      ).length
    );
  const start = Date.now();
  let prev = await countFocusable();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(quietMs);
    const now = await countFocusable();
    if (now === prev) break; // DOM settled
    prev = now;
  }
}

// CAPTCHA compatibility (human-approved, page-scoped). CAPTCHAs (reCAPTCHA,
// hCaptcha) detect `navigator.webdriver` and refuse to run under automation,
// which makes a CAPTCHA-gated step untestable. ONLY when a CAPTCHA is actually
// present on the page do we suppress that one automation signal and reload so
// the CAPTCHA initializes and its keyboard operability can be tested. Every
// page without a CAPTCHA keeps the honest `navigator.webdriver = true`.
const CAPTCHA_SELECTOR =
  'iframe[src*="recaptcha"],iframe[title*="reCAPTCHA" i],iframe[src*="hcaptcha"],.g-recaptcha,[data-sitekey]';

async function hasCaptcha(page) {
  return page.evaluate((sel) => !!document.querySelector(sel), CAPTCHA_SELECTOR).catch(() => false);
}

// Poll for a CAPTCHA appearing (SPAs render it after navigation settles).
async function waitForCaptcha(page, maxWaitMs = 3500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await hasCaptcha(page)) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

// Returns true if compatibility was applied on this call.
async function ensureCaptchaCompat(context, page) {
  if (!(await waitForCaptcha(page))) return false;
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await waitForReady(page);
  return true;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runViewport(browser, testCase, viewport, opts) {
  const disableAnimations = testCase.runtime?.disable_animations !== false;
  const context = await makeContext(browser, viewport, disableAnimations, opts.storageState);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');

  const startUrl = testCase.target.start_url;
  log(`  [${viewport.name}] navigating ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'load', timeout: 60000 });
  await waitForReady(page);

  const vpDir = path.join(opts.outDir, viewport.name);
  const screenshotsDir = path.join(vpDir, 'screenshots');
  ensureDir(screenshotsDir);

  const goalId = testCase.goals?.[0]?.id || null;
  const result = await crawl(page, cdp, { maxSteps: opts.maxSteps, screenshotsDir });
  const findings = deriveFindings(result, { viewport: viewport.name, goalId });

  const trace = {
    test_case_id: testCase.id,
    viewport: viewport.name,
    mode: 'crawl',
    viewport_size: { width: viewport.width, height: viewport.height },
    start_url: startUrl,
    generated_at: opts.timestamp,
    goals: (testCase.goals || []).map((g) => ({ id: g.id, intent: g.intent })),
    steps: result.steps,
  };

  fs.writeFileSync(path.join(vpDir, 'trace.json'), JSON.stringify(trace, null, 2));
  fs.writeFileSync(
    path.join(vpDir, 'deterministic-findings.json'),
    JSON.stringify(
      { test_case_id: testCase.id, viewport: viewport.name, generated_at: opts.timestamp, findings },
      null, 2
    )
  );

  log(`  [${viewport.name}] crawl: ${result.steps.length} steps, ${findings.length} finding(s) → ${vpDir}`);

  await cdp.detach().catch(() => {});
  await context.close();
  return { viewport: viewport.name, steps: result.steps.length, findings };
}

// Chromium launch args: full Chromium, new-headless → real pixels (SwiftShader).
const CHROMIUM_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
];

// ---------------------------------------------------------------------------
// Live agentic session. A persistent browser is driven ONE keystroke at a
// time across separate `step` invocations (state persists in the browser, which
// `serve` keeps alive). After each step the agent reads the observation and
// decides the next keystroke — the control loop lives in the agent, not here.
// ---------------------------------------------------------------------------

function sessionPaths(dir) {
  return {
    dir,
    sessionJson: path.join(dir, 'session.json'),
    stepsJson: path.join(dir, 'steps.json'),
    framesDir: path.join(dir, 'frames'),
    screenshotsDir: path.join(dir, 'screenshots'),
    restPng: path.join(dir, 'frames', 'rest.png'),
    stopFile: path.join(dir, 'STOP'),
  };
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

const VIEWPORT_PRESETS = {
  desktop: { name: 'desktop', width: 1280, height: 800 },
  mobile: { name: 'mobile', width: 390, height: 844 },
};

function loadCase(yamlPathArg) {
  const yamlPath = path.resolve(yamlPathArg);
  if (!fs.existsSync(yamlPath)) { log(`Test case not found: ${yamlPath}`); process.exit(1); }
  const testCase = parseYaml(fs.readFileSync(yamlPath, 'utf8'));
  if (!testCase?.target?.start_url) { log('Invalid test case: missing target.start_url'); process.exit(1); }
  return testCase;
}

// Ad-hoc test case synthesized from a plain URL (skill / one-off use). The
// natural-language task lives in the goal intent; the agent supplies the rest.
function synthCase(url, goalText) {
  let host = 'site';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  return {
    id: host.replace(/[^a-z0-9]+/gi, '-'),
    target: { start_url: url, scope: 'same-origin' },
    viewports: [VIEWPORT_PRESETS.desktop, VIEWPORT_PRESETS.mobile],
    goals: [{ id: 'adhoc', intent: goalText || 'keyboard-only accessibility pass' }],
    runtime: { disable_animations: true },
  };
}

function pickViewport(testCase, name) {
  const vps = testCase.viewports || [{ name: 'desktop', width: 1280, height: 800 }];
  const vp = name ? vps.find((v) => v.name === name) : vps[0];
  if (!vp) { log(`No matching viewport: ${name}`); process.exit(1); }
  return vp;
}

// Compact observation the agent reads to decide the next keystroke.
function observationOf(step) {
  const cfs = step.computed_focus_style || {};
  return {
    index: step.index,
    keystroke_sent: step.keystroke_sent,
    focus_moved: step.focus_moved,
    url: step.url,
    focused: {
      selector: step.active_element_selector,
      tag: step.tag,
      name: step.ax_name_role_state?.name ?? null,
      role: step.ax_name_role_state?.role ?? null,
      states: step.ax_name_role_state?.states ?? null,
    },
    focus_style: { has_outline: !!cfs.has_outline, has_shadow: !!cfs.has_shadow, outline: cfs.outline_style, box_shadow: cfs.box_shadow },
    region: step.region,
    bounding_box: step.bounding_box,
    screenshot: step.focused_region_screenshot,
  };
}

async function connectSession(dir) {
  const paths = sessionPaths(dir);
  if (!fs.existsSync(paths.sessionJson)) { log(`No session at ${dir}. Run \`serve\` first.`); process.exit(1); }
  const session = readJson(paths.sessionJson);
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  return { paths, session, browser, ctx, page, cdp };
}

async function cmdServe(args) {
  const testCase = args.url ? synthCase(args.url, args.goal) : loadCase(args._[1]);
  const vp = pickViewport(testCase, args.viewport);
  const port = args.port || 9333;
  const storageState = resolveStorageState(args.storageState);
  const outRoot = outRootFrom(args.out);
  const dir = path.join(outRoot, testCase.id, `session-${vp.name}`);
  const paths = sessionPaths(dir);
  ensureDir(paths.framesDir);
  ensureDir(paths.screenshotsDir);
  if (fs.existsSync(paths.stopFile)) fs.rmSync(paths.stopFile);

  const browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: [...CHROMIUM_ARGS, `--remote-debugging-port=${port}`],
  });
  // Startup self-check.
  const probe = await browser.newContext();
  try { await verifyFocusVisibleModality(probe); } finally { await probe.close(); }

  const disableAnimations = testCase.runtime?.disable_animations !== false;
  const context = await makeContext(browser, vp, disableAnimations, storageState);
  const page = await context.newPage();
  await page.goto(testCase.target.start_url, { waitUntil: 'load', timeout: 60000 });
  await waitForReady(page);
  const captchaCompat = await ensureCaptchaCompat(context, page);
  if (captchaCompat) log('  ⚠ CAPTCHA on start page — navigator.webdriver suppressed for this page (human-approved)');
  fs.writeFileSync(paths.restPng, await page.screenshot());

  writeJson(paths.sessionJson, {
    caseId: testCase.id,
    viewport: vp.name,
    viewport_size: { width: vp.width, height: vp.height },
    startUrl: page.url(),
    cdpUrl: `http://127.0.0.1:${port}`,
    goalId: testCase.goals?.[0]?.id || null,
    goals: (testCase.goals || []).map((g) => ({ id: g.id, intent: g.intent })),
    captchaCompat,
    index: 0,
  });
  writeJson(paths.stepsJson, []);

  log(`  ✓ :focus-visible verified · navigated ${page.url()}` + (storageState ? ` · storage state loaded` : ''));
  process.stdout.write(`READY ${dir}\n`);
  // Stay alive until `stop` writes the STOP file (keeps the browser persistent).
  await new Promise((resolve) => {
    const t = setInterval(() => { if (fs.existsSync(paths.stopFile)) { clearInterval(t); resolve(); } }, 500);
  });
  await browser.close();
  log('session stopped');
}

async function cmdObserve(args) {
  const { browser, cdp, session } = await connectSession(args._[1]);
  const focused = await captureFocused(cdp);
  await browser.close();
  process.stdout.write(JSON.stringify({
    index: session.index,
    note: 'current state (no keystroke sent)',
    url: focused.url ?? session.startUrl,
    focused: {
      selector: focused.selector, tag: focused.tag ?? null,
      name: focused.ax?.name ?? null, role: focused.ax?.role ?? null, states: focused.ax?.states ?? null,
    },
  }, null, 2) + '\n');
}

async function cmdStep(args) {
  const { paths, session, browser, ctx, page, cdp } = await connectSession(args._[1]);
  const steps = readJson(paths.stepsJson);
  const index = session.index + 1;

  let keystroke, activating = false;
  if (args.type != null) {
    await page.keyboard.type(args.type);
    keystroke = 'type:' + JSON.stringify(args.type.slice(0, 60));
  } else {
    const key = args.press || 'Tab';
    if (!ALLOWED_KEYS.has(key)) { log(`Disallowed key: ${key}`); await browser.close(); process.exit(1); }
    await page.keyboard.press(key === 'Space' ? ' ' : key);
    keystroke = key;
    activating = key === 'Enter' || key === 'Space';
  }
  await page.waitForTimeout(activating ? 250 : 40);
  if (activating) await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});

  // If this keystroke landed on a page that has a CAPTCHA, apply page-scoped
  // compatibility once so the CAPTCHA can run (and be tested) — human-approved.
  let captchaCompatApplied = false;
  if (!session.captchaCompat && activating) {
    captchaCompatApplied = await ensureCaptchaCompat(ctx, page);
    if (captchaCompatApplied) log(`  ⚠ CAPTCHA detected at ${page.url()} — navigator.webdriver suppressed for this page (human-approved)`);
  }

  const focused = await captureFocused(cdp);
  const prev = steps[steps.length - 1];
  const framePng = PNG.sync.read(await page.screenshot());
  fs.writeFileSync(path.join(paths.framesDir, `full_${pad(index)}.png`), PNG.sync.write(framePng));
  let shotRel = null;
  if (focused.bbox && focused.bbox.width >= 1 && focused.bbox.height >= 1) {
    fs.writeFileSync(path.join(paths.screenshotsDir, `${stepId(index)}.png`), PNG.sync.write(cropPng(framePng, inflate(focused.bbox))));
    shotRel = path.join('screenshots', `${stepId(index)}.png`);
  }
  const step = {
    step_id: stepId(index), index, keystroke_sent: keystroke,
    active_element_selector: focused.selector, tag: focused.tag ?? null, tabindex: focused.tabindex ?? null,
    dom_order_index: focused.domOrderIndex ?? -1,
    ax_name_role_state: focused.ax ? { name: focused.ax.name, role: focused.ax.role, states: focused.ax.states } : null,
    focus_moved: !prev || prev.active_element_selector !== focused.selector,
    bounding_box: focused.bbox ?? null, url: focused.url ?? session.startUrl,
    text: focused.text ?? '', is_body: !!focused.isBody,
    computed_focus_style: focused.focusStyle ?? null, region: focused.region ?? null,
    focused_region_screenshot: shotRel, focus_visible: null,
  };
  steps.push(step);
  writeJson(paths.stepsJson, steps);
  writeJson(paths.sessionJson, { ...session, index, captchaCompat: session.captchaCompat || captchaCompatApplied });
  await browser.close(); // disconnect only; the served browser stays alive
  const obs = observationOf(step);
  if (captchaCompatApplied) obs.captcha_compat_applied = true;
  process.stdout.write(JSON.stringify(obs, null, 2) + '\n');
}

async function cmdFinish(args) {
  const dir = args._[1];
  const paths = sessionPaths(dir);
  if (!fs.existsSync(paths.sessionJson)) { log(`No session at ${dir}`); process.exit(1); }
  const session = readJson(paths.sessionJson);
  const steps = readJson(paths.stepsJson);
  const restPng = PNG.sync.read(fs.readFileSync(paths.restPng));
  const fullFrames = steps.map((s) => PNG.sync.read(fs.readFileSync(path.join(paths.framesDir, `full_${pad(s.index)}.png`))));

  finalizeFocusVisible(steps, fullFrames, restPng);
  const findings = deriveFindings(
    { steps, startUrl: session.startUrl, contextChangeOnFocus: null },
    { viewport: session.viewport, goalId: session.goalId }
  );

  const trace = {
    test_case_id: session.caseId, viewport: session.viewport, mode: 'driven-live',
    viewport_size: session.viewport_size, start_url: session.startUrl,
    goals: session.goals, steps,
  };
  writeJson(path.join(dir, 'trace.json'), trace);
  writeJson(path.join(dir, 'deterministic-findings.json'),
    { test_case_id: session.caseId, viewport: session.viewport, mode: 'driven-live', findings });
  log(`finished: ${steps.length} steps, ${findings.length} deterministic finding(s) → ${dir}`);
  process.stdout.write(JSON.stringify({ steps: steps.length, findings }, null, 2) + '\n');
}

async function cmdStop(args) {
  const paths = sessionPaths(args._[1]);
  fs.writeFileSync(paths.stopFile, '1');
  log('stop requested');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Live-session subcommands.
  const sub = args._[0];
  if (sub === 'serve') return cmdServe(args);
  if (sub === 'observe') return cmdObserve(args);
  if (sub === 'step') return cmdStep(args);
  if (sub === 'finish') return cmdFinish(args);
  if (sub === 'stop') return cmdStop(args);

  // Batch blind-crawl: needs either a URL (--url) or a test-case YAML.
  if (args.help || (!args._.length && !args.url)) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const testCase = args.url ? synthCase(args.url, args.goal) : loadCase(args._[0]);

  let viewports = testCase.viewports || [{ name: 'desktop', width: 1280, height: 800 }];
  if (args.viewport) viewports = viewports.filter((v) => v.name === args.viewport);
  if (!viewports.length) {
    log(`No matching viewport: ${args.viewport}`);
    process.exit(1);
  }

  const timestamp = process.env.RUN_TIMESTAMP || new Date().toISOString();
  const outRoot = outRootFrom(args.out);
  const outDir = path.join(outRoot, testCase.id);
  ensureDir(outDir);
  const storageState = resolveStorageState(args.storageState);

  log(`Test case: ${testCase.id}`);
  log(`Viewports: ${viewports.map((v) => v.name).join(', ')}`);
  if (storageState) log(`Storage state: ${storageState}`);

  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: CHROMIUM_ARGS });

  try {
    // Startup self-check — fail fast if modality is wrong.
    log('Verifying :focus-visible modality on CDP-driven key events…');
    const probeCtx = await browser.newContext();
    try {
      await verifyFocusVisibleModality(probeCtx);
      log('  ✓ :focus-visible fires on keyboard modality');
    } finally {
      await probeCtx.close();
    }

    const summary = [];
    for (const vp of viewports) {
      const r = await runViewport(browser, testCase, vp, { outDir, maxSteps: args.maxSteps, timestamp, storageState });
      summary.push(r);
    }

    fs.writeFileSync(
      path.join(outDir, 'run-summary.json'),
      JSON.stringify({ test_case_id: testCase.id, generated_at: timestamp, viewports: summary }, null, 2)
    );
    log(`\nDone. Output: ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log('\nFATAL: ' + (err?.stack || err?.message || String(err)));
  process.exit(1);
});
