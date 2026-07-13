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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { validatePersona, resolveStorageState, makeFinding, parseArgs, pickViewport } from './lib/cli-helpers.mjs';
import { relLum } from './lib/color.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `playwright`/`yaml`/`pngjs`/`pixelmatch` are only needed by `serve` and the
// batch crawl (`main()`'s non-subcommand branch) -- `observe`/`step`/`finish`/
// `stop` are spawned as a fresh Node process PER KEYSTROKE and only ever talk
// to control.sock (see sendControlRequest/socketRequest below), so importing
// these eagerly at module scope made every single keystroke pay ~250ms of
// Node loading Playwright's module graph just to forward one JSON line over a
// socket. Deferred to dynamic import(), called once via loadHeavyDeps() at
// the top of cmdServe() and the batch branch of main() -- the only two entry
// points that actually construct a browser or touch PNG/pixelmatch/YAML.
let chromium, parseYaml, PNG, pixelmatch;
async function loadHeavyDeps() {
  if (chromium) return; // already loaded (idempotent, no-op on repeat calls)
  const [pw, yamlMod, pngMod, pixelmatchMod] = await Promise.all([
    import('playwright'),
    import('yaml'),
    import('pngjs'),
    import('pixelmatch'),
  ]);
  chromium = pw.chromium;
  parseYaml = yamlMod.parse;
  PNG = pngMod.PNG;
  pixelmatch = pixelmatchMod.default;
}

// Default output root: a per-user temp directory, so the tool never writes into
// the project/skill directory. Override with --out.
const DEFAULT_OUT_ROOT = path.join(os.tmpdir(), 'keyboard-a11y-tester');
const outRootFrom = (arg) => (arg ? path.resolve(arg) : DEFAULT_OUT_ROOT);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const needsScreenReader = (persona) => persona === 'all' || persona === 'screen-reader';
const needsKeyboardChecks = (persona) => persona === 'all' || persona === 'keyboard';

const USAGE = `
keyboard-a11y-runner — keyboard-only accessibility runner

Output goes to a per-user temp dir by default (\${TMPDIR}/keyboard-a11y-tester); override
with --out <dir>. Nothing is written into the project/skill directory.

Authenticated runs: pass a Playwright storageState JSON file with --storage-state <file>
to start the browser with its cookies and localStorage (e.g. an already-logged-in session).
Generate one with \`context.storageState({ path: 'auth.json' })\` or \`npx playwright codegen
--save-storage=auth.json <url>\`.

Batch (blind Tab-crawl over the start page, per viewport):
  node scripts/runner.mjs (--url <url> [--goal "<task>"] | <test-case.yaml>) [--out <dir>] [--viewport <name>] [--max-steps <n>] [--storage-state <file>] [--persona <keyboard|screen-reader|all>]

Live agentic session (the agent observes and decides each keystroke):
  node scripts/runner.mjs serve  (--url <url> [--goal "<task>"] | <test-case.yaml>) [--viewport <name>] [--out <dir>] [--port <n>] [--storage-state <file>] [--persona <keyboard|screen-reader|all>]
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
  --persona <keyboard|screen-reader|all>   which persona pass(es) to run (default: all).
       keyboard: focus-visible/pixel-diff checks only (today's behavior).
       screen-reader: ARIA/ACCNAME accessibility-tree checks only (via @guidepup/virtual-screen-reader),
       no pixel work, no :focus-visible gate. all: both, merged into one findings report.
`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(4, '0');
const stepId = (n) => `step_${pad(n)}`;
// 0o700: the output tree holds traces, screenshots and the live-session control
// socket for a possibly-authenticated run, under a world-readable temp dir.
// Owner-only dirs stop other local users traversing in to drive or read it.
const ensureDir = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// A single output-path segment must never contain path separators or "..":
// testCase.id and viewport.name come from operator-supplied YAML and are joined
// into the output tree, so a value like "../../foo" would escape it. Collapse
// anything outside [a-z0-9] to hyphens (same rule synthCase already uses for
// the --url host), falling back to a placeholder so an empty result is safe.
const safeSeg = (s) => String(s ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'x';

function log(...m) {
  process.stderr.write(m.join(' ') + '\n');
}

// ---------------------------------------------------------------------------
// In-page collectors (serialized to the browser). Kept as strings so they run
// via CDP Runtime.callFunctionOn against document.activeElement.
// ---------------------------------------------------------------------------

// Computes a reasonably stable CSS selector + geometry for a given element.
// Runs in page context; `this` is the element.
// Takes the element as an explicit parameter (rather than binding \`this\')
// so the identical source runs two ways: via CDP's Runtime.callFunctionOn
// (main-frame focus, objectId passed in \`arguments\` alongside \`this\`) and
// via Playwright's ElementHandle.evaluate (focus recursed into an iframe --
// see resolveInnerFocus). Both invoke it as fn(el).
const COLLECT_ACTIVE = /* js */ `
function (el) {
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
  // Custom controls commonly render their focus indicator on a wrapping
  // container via :focus-within (a bordered/shadowed field wrapper around a
  // plain, unstyled input) rather than on the focused element itself. Walk up
  // a few ancestors so the pixel-diff has a shot at that box too -- capped to
  // "modestly bigger than the control" so this can't accidentally pick up a
  // whole-page container like <main> and rubber-stamp every page as visible.
  var ancestorBoxes = [];
  var ownArea = Math.max(1, r.width * r.height);
  var anc = el.parentElement;
  for (var hop = 0; anc && hop < 3 && anc !== document.body; hop++, anc = anc.parentElement) {
    var ar = anc.getBoundingClientRect();
    var area = ar.width * ar.height;
    if (area < 1 || area > ownArea * 25) continue;
    if (ar.width > window.innerWidth * 0.9 || ar.height > window.innerHeight * 0.9) continue;
    ancestorBoxes.push({ x: ar.x, y: ar.y, width: ar.width, height: ar.height });
  }
  // Best-effort accessible name/role, used only when focus has been traced
  // into an iframe (see resolveInnerFocus) -- that element's real CDP
  // backendNodeId lives in a different target our single CDP session can't
  // reach (cross-origin frames get their own renderer process), so ground-
  // truth ACCNAME via Accessibility.getPartialAXTree isn't reachable there.
  // This is a plain-DOM approximation (label/aria-label/alt/title/text), not
  // full name computation -- good enough to stop misattributing every
  // control inside a frame to the outer <iframe> element.
  function heuristicText(e) { return e ? (e.innerText || '').trim() : ''; }
  var heuristicName = '';
  var hLbl = el.getAttribute('aria-label');
  if (hLbl && hLbl.trim()) heuristicName = hLbl.trim();
  if (!heuristicName) {
    var hLbId = el.getAttribute('aria-labelledby');
    if (hLbId) {
      heuristicName = hLbId.split(/\\s+/).map(function (id) { return heuristicText(document.getElementById(id)); })
        .filter(Boolean).join(' ').trim();
    }
  }
  if (!heuristicName && el.id) {
    var forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel) heuristicName = heuristicText(forLabel);
  }
  if (!heuristicName) {
    var wrapLabel = el.closest('label');
    if (wrapLabel) heuristicName = heuristicText(wrapLabel);
  }
  if (!heuristicName && el.tagName === 'IMG' && el.alt) heuristicName = el.alt.trim();
  if (!heuristicName && el.getAttribute('title')) heuristicName = el.getAttribute('title').trim();
  if (!heuristicName) heuristicName = heuristicText(el);
  if (!heuristicName && el.getAttribute('placeholder')) heuristicName = el.getAttribute('placeholder').trim();
  var heuristicRole = el.getAttribute('role');
  if (!heuristicRole) {
    var ROLE_MAP = { a: el.hasAttribute('href') ? 'link' : 'generic', button: 'button', select: 'listbox', textarea: 'textbox', img: 'img' };
    heuristicRole = ROLE_MAP[el.tagName.toLowerCase()] || (el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase());
  }
  // Never let a secret field's plaintext value reach the trace on disk: the
  // captured text (and everything downstream) is persisted to steps.json /
  // trace.json in a world-readable temp dir. Passwords, OTPs and card numbers
  // are identified by input type or autocomplete token and have their .value
  // suppressed (label/aria-label still describe the control fine).
  var acToken = (el.getAttribute('autocomplete') || '').toLowerCase();
  var isSecretField = el.tagName.toLowerCase() === 'input' &&
    (((el.getAttribute('type') || '').toLowerCase() === 'password') ||
     acToken.indexOf('password') !== -1 ||
     acToken.indexOf('one-time-code') !== -1 ||
     acToken.indexOf('cc-') !== -1);
  return {
    isBody: false,
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    inputType: el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
    tabindex: tabindexAttr === null ? null : parseInt(tabindexAttr, 10),
    bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
    ancestorBoxes,
    heuristicName: heuristicName.slice(0, 200),
    heuristicRole,
    domOrderIndex,
    url: location.href,
    isSecretField,
    text: (el.innerText || (isSecretField ? '' : el.value) || el.getAttribute('aria-label') || '').trim().slice(0, 120),
    hasHref: el.tagName.toLowerCase() === 'a' && !!el.getAttribute('href'),
    focusStyle,
    region
  };
}`;

// Real function derived from the COLLECT_ACTIVE source, for the one call site
// that needs an actual JS value rather than a string: Playwright's
// ElementHandle.evaluate() serializes a function value's own source into the
// page and calls it there, but treats a string argument as a bare expression
// to evaluate (so `handle.evaluate(COLLECT_ACTIVE)` would just resolve the
// unreferenced function value itself, not call it -- verified empirically).
const COLLECT_ACTIVE_FN = new Function('el', `return (${COLLECT_ACTIVE})(el);`);

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
// Takes either { objectId } or { backendNodeId } -- getPartialAXTree accepts
// a live Runtime.RemoteObjectId directly, so callers that already hold an
// objectId (e.g. captureFocused) can skip the DOM.describeNode round trip
// that used to be needed purely to translate objectId -> backendNodeId.
async function axForNode(cdp, params) {
  try {
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
      ...params,
      fetchRelatives: false,
    });
    if (!nodes || !nodes.length) return null;
    // The requested node is the last in the returned partial tree.
    const node = ('backendNodeId' in params && nodes.find((n) => n.backendDOMNodeId === params.backendNodeId))
      || nodes[nodes.length - 1];
    const states = {};
    for (const p of node.properties || []) {
      states[p.name] = p.value && 'value' in p.value ? p.value.value : p.value;
    }
    // Which ACCNAME source actually produced the name (first non-superseded
    // source carrying a non-empty value). Lets checks tell an author-provided
    // name (label / aria-label / aria-labelledby / contents) apart from a
    // user-agent default — e.g. the bare file input's own "Choose File",
    // whose winning source is `contents` with attribute `value`.
    let nameSource = null;
    for (const s of node.name?.sources || []) {
      if (s.superseded) continue;
      const v = s.value && s.value.value;
      if (v === undefined || v === null || String(v).trim() === '') continue;
      nameSource = { type: s.type, attribute: s.attribute ?? null, native: s.nativeSource ?? null };
      break;
    }
    return {
      role: node.role?.value ?? null,
      name: node.name?.value ?? null,
      name_source: nameSource,
      ignored: !!node.ignored,
      states,
    };
  } catch {
    return null;
  }
}

// Blind Tab-crawling can land focus inside an <iframe> (same-origin OR
// cross-origin, e.g. an embedded video player). document.activeElement in the
// TOP document then IS the <iframe> element itself and stays that way for
// every Tab press while focus actually moves among controls inside it -- our
// single CDP session is bound to the top page's target and structurally can't
// see inside a cross-origin iframe's own (separate-process) target. Left
// unhandled, every control inside gets misattributed to the same unmoving
// <iframe> selector, which both hides its own findings and reads as a
// keyboard trap (>=3 consecutive "focus didn't move" steps) to the 2.1.2 check.
//
// Playwright's own Frame/ElementHandle API *can* reach into an OOPIF (it
// attaches to the sub-target internally), so once CDP tells us focus landed
// on an iframe, re-resolve document.activeElement through Playwright instead,
// recursing through nested iframes. If that resolution fails for any reason
// (frame not yet attached, cross-origin content still loading), we fall back
// to reporting the iframe element itself -- exactly today's behaviour, never
// worse.
const MAX_FRAME_HOPS = 8;

async function resolveInnerFocus(page) {
  let frame = page.mainFrame();
  let handle = await frame.evaluateHandle(() => document.activeElement).catch(() => null);
  let crossedFrame = false;
  for (let hop = 0; hop < MAX_FRAME_HOPS; hop++) {
    const el = handle && handle.asElement();
    if (!el) break;
    const tag = await el.evaluate((n) => n.tagName).catch(() => null);
    if (tag !== 'IFRAME' && tag !== 'FRAME') break;
    const child = await el.contentFrame().catch(() => null);
    if (!child) break; // cross-origin content not attached / not yet loaded
    const childHandle = await child.evaluateHandle(() => document.activeElement).catch(() => null);
    if (!childHandle) break;
    await handle.dispose().catch(() => {});
    handle = childHandle;
    frame = child;
    crossedFrame = true;
  }
  return { handle, frame, crossedFrame };
}

// Collects selector/geometry + AX for whatever currently has focus.
async function captureFocused(cdp, page) {
  const objectId = await activeElementObjectId(cdp);
  if (!objectId) {
    return { isBody: true, selector: 'body', ax: null };
  }
  // Geometry collection and the AX lookup both only need `objectId` and don't
  // depend on each other's result -- run them concurrently instead of paying
  // two sequential CDP round trips.
  const collectGeom = async () => {
    try {
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: COLLECT_ACTIVE,
        arguments: [{ objectId }],
        returnByValue: true,
      });
      return result.value;
    } catch {
      return { isBody: false, selector: '(unknown)', bbox: null, domOrderIndex: -1 };
    }
  };
  const collectAx = () => axForNode(cdp, { objectId }); // best-effort: resolves to null internally on failure
  let [geom, ax] = await Promise.all([collectGeom(), collectAx()]);
  await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});

  if (!geom.isBody && geom.tag === 'iframe' && page) {
    const { handle, crossedFrame } = await resolveInnerFocus(page);
    if (crossedFrame) {
      try {
        const innerGeom = await handle.evaluate(COLLECT_ACTIVE_FN);
        if (!innerGeom.isBody) {
          // The inner element's own getBoundingClientRect() (and therefore its
          // ancestorBoxes, computed the same way) is local to its frame's
          // viewport; Playwright's boundingBox() is page-relative (it accounts
          // for every ancestor frame's own offset/scroll). Drop ancestorBoxes
          // rather than pass through frame-local coordinates that would
          // silently point at the wrong place in the page-level screenshot.
          const box = await handle.asElement().boundingBox().catch(() => null);
          geom = {
            ...innerGeom,
            bbox: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
            ancestorBoxes: [],
            selector: `${geom.selector} >>> ${innerGeom.selector}`,
            // innerGeom.url is the IFRAME's OWN document location -- every
            // embedded iframe naturally has a different src URL than the top
            // page, which is not a context change by any meaningful reading of
            // 3.2.1 (the user never left the page they're on). Keep the outer,
            // top-level URL so that check only fires on a real top-level nav.
            url: geom.url,
          };
          // Ground-truth ACCNAME isn't reachable here (see resolveInnerFocus) --
          // use the plain-DOM heuristic computed alongside the rest of geom.
          ax = {
            role: innerGeom.heuristicRole ?? null,
            name: innerGeom.heuristicName || null,
            name_source: { type: 'heuristic', attribute: null, native: null },
            ignored: false,
            states: {},
          };
        }
      } catch {
        /* keep the outer <iframe> as the reported target -- today's behaviour */
      }
    }
    await handle?.dispose().catch(() => {});
  }

  return { ...geom, ax };
}

// ---------------------------------------------------------------------------
// Screen-reader persona (W3C "Lakshmi") — @guidepup/virtual-screen-reader,
// injected into the PAGE's JS realm. It builds an ARIA/ACCNAME-spec accessible
// tree over the live DOM and must run in-page, not in Node against a remote
// page. We never call its own interaction methods (act/interact/press/type) —
// all real interaction stays on Playwright's real keyboard events, same rule as
// the rest of this file (never JS-dispatch synthetic input).
//
// Its `virtual` singleton listens for real `focusin` events, so the moment we
// `start()` it, its cursor tracks Playwright's Tab-driven focus automatically —
// no manual `.next()` "chasing" is needed or performed. It also wires a
// MutationObserver that computes WAI-ARIA live-region semantics and pushes
// "assertive: …" / "polite: …" entries into the same spokenPhraseLog(), which
// covers WCAG 4.1.3 without a bespoke observer. The one thing that log
// structurally can't show is a live region that's declared but never fires —
// caught separately via a direct DOM query in runCensus().
// ---------------------------------------------------------------------------

const VSR_BUNDLE_PATH = path.join(
  __dirname, '..', 'node_modules', '@guidepup', 'virtual-screen-reader',
  'lib', 'esm', 'index.browser.js'
);

// Turns the library's self-contained browser ESM bundle into a plain classic-
// script IIFE assigning `window.__vsr = { Virtual, virtual }`. Deliberately
// avoids dynamic import()/blob: URLs, which real CSP script-src policies often
// block — a plain addInitScript-injected classic script is not subject to page
// CSP (verified empirically against a CSP-locked test page).
let _vsrIifeSource = null;
function loadVsrIife() {
  if (_vsrIifeSource) return _vsrIifeSource;
  if (!fs.existsSync(VSR_BUNDLE_PATH)) {
    throw new Error(
      'Screen-reader persona requires "@guidepup/virtual-screen-reader" (run `npm install`), ' +
      'or pass --persona keyboard to skip it.'
    );
  }
  const raw = fs.readFileSync(VSR_BUNDLE_PATH, 'utf8');
  const m = raw.match(/export\s*\{\s*([\w$]+)\s+as\s+Virtual\s*,\s*([\w$]+)\s+as\s+virtual\s*\}\s*;/);
  if (!m) {
    throw new Error(
      '@guidepup/virtual-screen-reader browser bundle export shape changed — update the ' +
      'regex in loadVsrIife() (runner.mjs), or pin an older compatible version.'
    );
  }
  const body = raw.slice(0, m.index);
  _vsrIifeSource = `(function(){ ${body}\nwindow.__vsr = { Virtual: ${m[1]}, virtual: ${m[2]} }; window.__vsrStarted = false; })();`;
  return _vsrIifeSource;
}

// Idempotent per-document: safe to call from both the initial navigation and a
// page.on('load') handler without double-starting the singleton monitor.
async function startVsr(page) {
  return page.evaluate(async () => {
    if (!window.__vsr || window.__vsrStarted) return !!window.__vsr;
    window.__vsrStarted = true;
    await window.__vsr.virtual.start({ container: document.body });
    return true;
  }).catch(() => false);
}

// Diffs the live monitor's spokenPhraseLog since prevLogLen, splitting
// "assertive:"/"polite:"-prefixed live-region announcements from the plain
// focus-change announcement. Returns null when screen-reader data isn't
// available for this step (e.g. persona doesn't include it, or the page hasn't
// finished (re)injecting yet) — callers must treat null as "unavailable".
async function captureScreenReader(page, prevLogLen) {
  return page.evaluate(async (prevLen) => {
    const v = window.__vsr && window.__vsr.virtual;
    if (!v) return null;
    const log = await v.spokenPhraseLog();
    const newPhrases = log.slice(prevLen);
    const live = [];
    let focusAnnouncement = null;
    for (const p of newPhrases) {
      const m = /^(assertive|polite):\s*(.*)$/.exec(p);
      if (m) live.push({ priority: m[1], text: m[2] });
      else focusAnnouncement = p; // last non-live phrase among THIS step's new entries only
    }
    return {
      log_length: log.length,
      new_phrases: newPhrases,
      live_announcements: live,
      focus_announcement: focusAnnouncement,
    };
  }, prevLogLen).catch(() => null);
}

// One page.evaluate round-trip that walks the WHOLE page with a separate,
// ephemeral Virtual instance (never the live per-step monitor, so it can't
// pollute that log), producing a structural census: reading-order entries
// (role/name pairs, from which heading hierarchy and landmark structure are
// derived), a direct DOM query for declared live regions (which the
// event-driven spokenPhraseLog can't show unless they actually fired), a
// direct DOM query for ARIA ID-reference attributes whose ID(s) don't resolve
// to any element (aria-controls/describedby/details/errormessage), and a
// direct DOM query for declared alternate reading order (aria-flowto) —
// descriptive only, for the AI layer's reading-order-vs-visual-order judgment.
const RUN_CENSUS_JS = /* js */ `
(async () => {
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

  const reader = new window.__vsr.Virtual();
  await reader.start({ container: document.body });
  const entries = [];
  let phrase = await reader.lastSpokenPhrase();
  let guard = 0;
  while (phrase !== 'end of document' && guard++ < 5000) {
    const el = reader.activeNode;
    const isEl = el && el.nodeType === 1;
    const comma = phrase.indexOf(',');
    const role = (comma === -1 ? phrase : phrase.slice(0, comma)).trim();
    entries.push({
      index: guard,
      spoken_phrase: phrase,
      role,
      tag: isEl ? el.tagName.toLowerCase() : null,
      selector: isEl ? cssPath(el) : null,
    });
    await reader.next();
    phrase = await reader.lastSpokenPhrase();
  }
  await reader.stop();

  const declaredLiveRegions = Array.from(
    document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log], [role=alertdialog]')
  ).map(el => ({
    selector: cssPath(el),
    live: el.getAttribute('aria-live') || null,
    role: el.getAttribute('role') || null,
  }));

  const ARIA_REF_ATTRS = ['aria-controls', 'aria-describedby', 'aria-details', 'aria-errormessage'];
  const declaredBrokenAriaRefs = [];
  Array.from(document.querySelectorAll(ARIA_REF_ATTRS.map(a => '[' + a + ']').join(', ')))
    .forEach(el => {
      ARIA_REF_ATTRS.forEach(attr => {
        const val = el.getAttribute(attr);
        if (!val) return;
        const ids = val.trim().split(/\\s+/).filter(Boolean);
        if (!ids.length) return;
        const anyResolves = ids.some(id => document.getElementById(id));
        if (!anyResolves) {
          declaredBrokenAriaRefs.push({ selector: cssPath(el), attribute: attr, ids });
        }
      });
    });

  const declaredAlternateReadingOrder = Array.from(document.querySelectorAll('[aria-flowto]'))
    .map(el => ({
      selector: cssPath(el),
      flowto_ids: (el.getAttribute('aria-flowto') || '').trim().split(/\\s+/).filter(Boolean),
    }));

  return {
    entries,
    declared_live_regions: declaredLiveRegions,
    declared_broken_aria_refs: declaredBrokenAriaRefs,
    declared_alternate_reading_order: declaredAlternateReadingOrder,
    truncated: guard >= 5000,
  };
})()`;

async function runCensus(page) {
  return page.evaluate(RUN_CENSUS_JS).catch((e) => { log('  screen-reader census failed:', e.message || String(e)); return null; });
}

async function runCensusWithTimeout(page, ms = 20000) {
  return Promise.race([
    runCensus(page),
    new Promise((resolve) =>
      setTimeout(() => resolve({
        entries: [], declared_live_regions: [], declared_broken_aria_refs: [],
        declared_alternate_reading_order: [], truncated: true, timed_out: true,
      }), ms)
    ),
  ]);
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
  // When a ring/edge cue is present, restrict this measurement to the
  // perimeter band and skip the component's own interior. Reveal/reposition
  // patterns (e.g. an off-canvas skip link that jumps on-screen on :focus)
  // uncover whatever unrelated content normally renders at that spot once
  // focus moves on, so diffing the full interior mixes the ring's true
  // contrast with that incidental content and produces a bogus ratio. A pure
  // interior-fill indicator (no ring/edge) has no such exterior noise to
  // avoid, so it keeps measuring the whole region as before.
  //
  // A full-box fill (e.g. a card/button swapping its whole background colour
  // on focus) also crosses the edge floor -- the top/bottom bands are subsets
  // of the box, so they read the same near-100% change as the interior. That
  // is NOT a ring/underline: `interior` also being at the floor is precisely
  // what tells the two apart, so only treat it as ring-like when the edge
  // band changed WITHOUT the interior changing along with it.
  const ringLike = borderBand >= PRESENCE_FLOOR || (edge >= PRESENCE_FLOOR && interior < PRESENCE_FLOOR);
  const rx = Math.min(Math.max(0, Math.floor(region.x)), Math.max(0, focusedPng.width - 1));
  const ry = Math.min(Math.max(0, Math.floor(region.y)), Math.max(0, focusedPng.height - 1));
  // Shrunk 2px in from the reported border-box on each side: subpixel layout
  // (fractional getBoundingClientRect vs the integer screenshot pixel grid)
  // means the rasterized outline can bleed a pixel or two inside the nominal
  // edge, so excluding right up to that edge undercounts a real ring's own
  // pixels. The reveal-pattern contamination this branch exists to dodge
  // involves the whole interior, so a couple of edge pixels back makes no
  // difference there.
  const EDGE_MARGIN = 2;
  const ix0 = box.x - rx + EDGE_MARGIN, iy0 = box.y - ry + EDGE_MARGIN;
  const ix1 = ix0 + Math.max(0, box.width - 2 * EDGE_MARGIN), iy1 = iy0 + Math.max(0, box.height - 2 * EDGE_MARGIN);
  let changedArea = 0, fLum = 0, bLum = 0;
  for (let y = 0; y < h; y++) {
    const insideInteriorY = ringLike && y >= iy0 && y < iy1;
    for (let x = 0; x < w; x++) {
      if (insideInteriorY && x >= ix0 && x < ix1) continue; // perimeter only
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

// A real focus indicator, however implemented (CSS ring on the element,
// :focus-within on a wrapper, or a decoupled/portaled overlay positioned by
// JS), renders close to the control it indicates -- so a small fixed search
// margin around the element's own box catches genuinely detached
// implementations (an absolutely-positioned ring that isn't a DOM ancestor
// at all) without reopening full-frame diffing to every unrelated change
// elsewhere on the page.
const NEARBY_SEARCH_MARGIN = 40;
const MIN_COMPONENT_PIXELS = 12;

// Searches a bounded window around the element's own box for a focus
// indicator that has no DOM relationship to it at all -- a sibling or
// portaled overlay repositioned by JS on focus, which the ancestor-box walk
// (finalizeFocusVisible) structurally cannot find since it only looks up the
// DOM tree. Builds a changed-pixel mask over the window (same per-pixel
// threshold as the AAA loop above), flood-fills it into connected
// components, and returns the largest surviving one's bounding box -- or
// null if nothing but noise changed nearby.
function findNearbyIndicatorBox(focusedPng, baselinePng, ownBox) {
  const frameW = Math.min(focusedPng.width, baselinePng.width);
  const frameH = Math.min(focusedPng.height, baselinePng.height);
  const win = inflate(ownBox, NEARBY_SEARCH_MARGIN);
  const x0 = Math.min(Math.max(0, Math.floor(win.x)), Math.max(0, frameW - 1));
  const y0 = Math.min(Math.max(0, Math.floor(win.y)), Math.max(0, frameH - 1));
  const x1 = Math.max(x0 + 1, Math.min(frameW, Math.ceil(win.x + win.width)));
  const y1 = Math.max(y0 + 1, Math.min(frameH, Math.ceil(win.y + win.height)));
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) return null;

  const changed = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x0 + x, fy = y0 + y;
      const iA = (fy * focusedPng.width + fx) * 4;
      const iB = (fy * baselinePng.width + fx) * 4;
      const d = Math.max(
        Math.abs(focusedPng.data[iA] - baselinePng.data[iB]),
        Math.abs(focusedPng.data[iA + 1] - baselinePng.data[iB + 1]),
        Math.abs(focusedPng.data[iA + 2] - baselinePng.data[iB + 2])
      );
      if (d > 32) changed[y * w + x] = 1;
    }
  }

  // 4-connected flood fill (iterative, no recursion) -- keep the largest
  // component above the noise floor.
  const visited = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!changed[start] || visited[start]) continue;
    let count = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      count++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0 && changed[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && changed[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && changed[p - w] && !visited[p - w]) { visited[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && changed[p + w] && !visited[p + w]) { visited[p + w] = 1; stack.push(p + w); }
    }
    if (count >= MIN_COMPONENT_PIXELS && (!best || count > best.count)) {
      best = { count, box: { x: x0 + minX, y: y0 + minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
    }
  }
  return best ? best.box : null;
}

// ---------------------------------------------------------------------------
// Step capture (shared by the blind Tab-crawl and the AI-driven mode)
// ---------------------------------------------------------------------------

// Captures one step AFTER the caller has performed a keystroke. Records the
// focused element, its AX name/role/state, geometry, computed focus style,
// locator region, and a focused-region screenshot; appends the full frame for
// the focus-visible neighbour diff. Returns { step, contextChange }.
async function recordStep(page, cdp, { keystroke, index, screenshotsDir, prevStep, startUrl, fullFrames, persona = 'all', srState }) {
  // These three reads of "current page state" are independent of each other --
  // run them concurrently instead of paying their round trips one after another.
  const capturePixelDiff = needsKeyboardChecks(persona);
  const captureSr = needsScreenReader(persona) && srState;
  const [focused, shotBuffer, sr] = await Promise.all([
    captureFocused(cdp, page),
    capturePixelDiff ? page.screenshot() : Promise.resolve(null),
    captureSr ? captureScreenReader(page, srState.logLength) : Promise.resolve(null),
  ]);

  const focusMoved = !prevStep || prevStep.active_element_selector !== focused.selector;
  let contextChange = null;
  if (focused.url && focused.url !== startUrl) {
    contextChange = { step: index, from: startUrl, to: focused.url };
  }

  let shotRel = null;
  if (capturePixelDiff) {
    const framePng = PNG.sync.read(shotBuffer);
    fullFrames.push(framePng);
    if (focused.bbox && focused.bbox.width >= 1 && focused.bbox.height >= 1) {
      const crop = cropPng(framePng, inflate(focused.bbox));
      shotRel = path.join('screenshots', `${stepId(index)}.png`);
      fs.writeFileSync(path.join(screenshotsDir, `${stepId(index)}.png`), PNG.sync.write(crop));
    }
  }

  let srAnnouncement = null;
  if (captureSr && sr) {
    srState.logLength = sr.log_length;
    srAnnouncement = { new_phrases: sr.new_phrases, live_announcements: sr.live_announcements, focus_announcement: sr.focus_announcement };
  }

  const step = {
    step_id: stepId(index),
    index,
    keystroke_sent: keystroke,
    active_element_selector: focused.selector,
    tag: focused.tag ?? null,
    input_type: focused.inputType ?? null,
    tabindex: focused.tabindex ?? null,
    dom_order_index: focused.domOrderIndex ?? -1,
    ax_name_role_state: focused.ax
      ? { name: focused.ax.name, role: focused.ax.role, states: focused.ax.states, name_source: focused.ax.name_source ?? null }
      : null,
    focus_moved: focusMoved,
    bounding_box: focused.bbox ?? null,
    ancestor_boxes: focused.ancestorBoxes ?? [],
    url: focused.url ?? startUrl,
    text: focused.text ?? '',
    is_body: !!focused.isBody,
    computed_focus_style: focused.focusStyle ?? null,
    region: focused.region ?? null,
    focused_region_screenshot: shotRel,
    focus_visible: null, // filled in post-process
    sr_announcement: srAnnouncement,
  };
  return { step, contextChange };
}

// ---------------------------------------------------------------------------
// The blind Tab-crawl (mechanical capture; scenario navigation is driven mode)
// ---------------------------------------------------------------------------

async function crawl(page, cdp, { maxSteps, screenshotsDir, persona = 'all', srState }) {
  const steps = [];
  const fullFrames = []; // decoded PNG per step, for focus-visible neighbour diff
  ensureDir(screenshotsDir);

  const capturePixelDiff = needsKeyboardChecks(persona);
  const restPng = capturePixelDiff ? PNG.sync.read(await page.screenshot()) : null; // baseline: nothing focused
  const startUrl = page.url();
  let firstSelector = null;
  let contextChangeOnFocus = null; // 3.2.1 probe

  for (let i = 1; i <= maxSteps; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30); // let auto-scroll / focus settle
    const { step, contextChange } = await recordStep(page, cdp, {
      keystroke: 'Tab', index: i, screenshotsDir, prevStep: steps[steps.length - 1], startUrl, fullFrames, persona, srState,
    });
    if (contextChange && !contextChangeOnFocus) contextChangeOnFocus = contextChange;
    steps.push(step);

    if (!step.is_body && firstSelector === null) firstSelector = step.active_element_selector;
    if (firstSelector && step.active_element_selector === firstSelector && i > 1) {
      step.cycle_closed = true; // full forward cycle → tab order closed
      break;
    }
  }

  if (capturePixelDiff) finalizeFocusVisible(steps, fullFrames, restPng);
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
    let m = focusMetrics(fullFrames[n], baseline, s.bounding_box);
    // Custom controls often carry their focus indicator on a wrapping
    // container (:focus-within border/shadow on a field wrapper) rather than
    // the focused element itself, which the element's own box never sees no
    // matter how far it's padded out. Only reached for ancestors, so a
    // neighbouring/sibling element's unrelated change can't leak in here the
    // way it can from blindly widening the search radius.
    let indicatorSource = 'own';
    if ((m === null || !m.visible) && s.ancestor_boxes && s.ancestor_boxes.length) {
      for (const abox of s.ancestor_boxes) {
        const am = focusMetrics(fullFrames[n], baseline, abox);
        if (am && am.visible && (m === null || !m.visible)) { m = am; indicatorSource = 'container'; break; }
      }
    }
    // Neither the element's own box nor any DOM ancestor showed an indicator --
    // last resort, search a small bounded radius around the element for one
    // that has no DOM relationship to it at all (a sibling or portaled overlay
    // repositioned by JS on focus, e.g. an absolutely-positioned custom ring).
    if (m === null || !m.visible) {
      const nearbyBox = findNearbyIndicatorBox(fullFrames[n], baseline, s.bounding_box);
      if (nearbyBox) {
        const nm = focusMetrics(fullFrames[n], baseline, nearbyBox);
        if (nm && nm.visible) { m = nm; indicatorSource = 'nearby'; }
      }
    }
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
      // A full-box fill also lights up the edge bands (they're subsets of the
      // box, so a uniform change covers them too) -- that's not a genuine
      // edge/underline shape, so only count `edge` as a shape cue when the
      // interior *didn't* change along with it. See the matching `ringLike`
      // note on focusMetrics() above.
      const fillCue = m.interior >= PRESENCE_FLOOR;
      const edgeOnlyCue = m.edge >= PRESENCE_FLOOR && !fillCue;
      const shapeCue = styleCue || m.borderBand >= PRESENCE_FLOOR || edgeOnlyCue;
      let indicator = 'none';
      if (indicatorSource === 'container') indicator = 'container';
      else if (indicatorSource === 'nearby') indicator = 'detached';
      else if (styleCue) indicator = cfs.has_outline ? 'outline' : 'shadow';
      else if (m.borderBand >= PRESENCE_FLOOR) indicator = 'ring';
      else if (edgeOnlyCue) indicator = 'edge';
      else if (fillCue) indicator = 'interior-only';
      // For an interior-only fill, reuse the AAA focused/unfocused luminance
      // ratio (>= 3:1, the same bar 2.4.13 uses) as the 1.4.1 signal: a fill
      // that shifts brightness enough to clear it reads as a real lightness
      // change independent of hue, so it isn't "colour is the only cue" even
      // without a ring/underline. Below the bar (or no measurable luminance
      // change at all), treat it as unresolved/colour-only.
      const colorSafe = indicator === 'interior-only' ? m.aaa.contrast_pass === true : null;
      s.focus_visible = {
        border_band: Number(m.borderBand.toFixed(4)),
        interior: Number(m.interior.toFixed(4)),
        edge: Number(m.edge.toFixed(4)),
        style_cue: styleCue,     // computed outline/box-shadow present
        pixel_cue: pixelCue,     // pixels changed on focus
        visible,                 // AA (2.4.7): present if either cue
        shape_cue: shapeCue,
        indicator,
        color_safe: colorSafe,   // 1.4.1: null unless indicator === 'interior-only'
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
function deriveFindingsKeyboard({ steps, startUrl, contextChangeOnFocus }, { viewport, goalId }) {
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
  // (ring/underline/border) -- e.g. a card or large button that swaps its
  // whole background colour on focus instead of drawing a ring. That may be a
  // colourblind-safe luminance fill OR a colour-only change that fails 1.4.1.
  // `color_safe` (focusMetrics' focused/unfocused luminance ratio, >= 3:1 --
  // the same bar 2.4.13 uses) tells the two apart: a fill bright/dark enough
  // to clear it reads as a real lightness change independent of hue, so only
  // fills that DON'T clear it (or have no measurable luminance change at all)
  // are flagged here.
  const colourOnly = focusStops.filter(
    (s) => s.focus_visible && s.focus_visible.visible === true &&
      s.focus_visible.shape_cue === false && s.focus_visible.color_safe !== true
  );
  if (colourOnly.length) {
    findings.push(
      makeFinding({
        id: `focus-indicator-color-only-${viewport}`,
        wcag: '1.4.1',
        confidence: 0.7,
        viewport,
        goalId,
        ...locate(colourOnly, startUrl),
        summary: `${colourOnly.length} focus stop(s) show only an interior fill change with no shape cue ` +
          `(no outline/underline/border) and < 3:1 focused/unfocused luminance contrast: a colour-only ` +
          `indicator fails 1.4.1 for users who cannot perceive the hue difference. ` +
          `e.g. ${colourOnly.slice(0, 5).map((s) => s.active_element_selector).join(', ')}`,
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

  // --- 3.3.2 Labels or Instructions: file input named only by the UA default
  // ACCNAME gives a bare <input type=file> the browser's own button text
  // ("Choose File"), so the 4.1.2 check above stays quiet — the control has a
  // name — yet no author label says WHAT to upload. A speech user can voice-
  // target "Choose File", but the field's purpose is conveyed by nothing.
  // Scoped to file inputs: their value attribute can never author the name
  // (it is the filename, and setting it is restricted), so a `contents`+
  // `value` winning name source is always the user-agent default — this can't
  // false-positive on <input type=submit value="Send">, whose value IS the
  // author's label.
  const uaNamedStops = focusStops.filter((s) =>
    s.input_type === 'file' &&
    s.ax_name_role_state?.name &&
    s.ax_name_role_state?.name_source?.type === 'contents' &&
    s.ax_name_role_state?.name_source?.attribute === 'value'
  );
  // A crawl can revisit the same control (tab cycle); report unique controls.
  const uaNamed = [...new Map(uaNamedStops.map((s) => [s.active_element_selector, s])).values()];
  if (uaNamed.length) {
    const where = locate(uaNamed, startUrl);
    findings.push(
      makeFinding({
        id: `ua-default-name-${viewport}`,
        wcag: '3.3.2',
        confidence: 0.75,
        viewport,
        goalId,
        ...where,
        summary: `${uaNamed.length} file input(s) are named only by the user-agent default ` +
          `("Choose File") with no author-provided label` +
          (where.locations.length ? ` (${where.locations.join('; ')})` : '') + `: ` +
          uaNamed.slice(0, 6).map((s) => s.active_element_selector).join(', ') +
          (uaNamed.length > 6 ? ' …' : ''),
        impact: 'The control announces only the browser’s generic button text: nothing tells the ' +
          'user what file is expected. Screen-reader and speech users get no field purpose.',
        evidence: uaNamed.slice(0, 10).map((s) => s.step_id),
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

// Screen-reader persona (W3C "Lakshmi") deterministic findings, derived from
// the page-wide census (reading-order entries + declared live regions) and the
// per-step sr_announcement data. Unlike deriveFindingsKeyboard, evidence here
// is mostly page-selector-based (evidence_kind: 'selector'), since census
// entries aren't tied to a specific keyboard step.
function deriveFindingsScreenReader({ steps, census }, { viewport, goalId }) {
  const findings = [];
  const pages = census ? Object.entries(census) : [];

  // Roles whose accessible name is the WHOLE spoken phrase when unnamed (i.e.
  // the phrase is exactly the bare role, no ", <name>" suffix).
  const NAMED_ROLES_1_1_1 = new Set(['image']);
  const NAMED_ROLES_4_1_2 = new Set([
    'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'slider', 'switch', 'searchbox',
  ]);
  const LANDMARK_ROLES = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'search', 'form',
  ]);

  // --- 1.1.1 Non-text Content: images with no accessible name -------------
  for (const [url, page] of pages) {
    const unnamed = (page.entries || []).filter((e) => NAMED_ROLES_1_1_1.has(e.role) && e.role === e.spoken_phrase);
    if (!unnamed.length) continue;
    findings.push(makeFinding({
      id: `sr-missing-alt-${viewport}`, wcag: '1.1.1', confidence: 0.85,
      viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
      summary: `${unnamed.length} image(s) on ${url} have no accessible name (missing alt text or ` +
        `aria-label): ` + unnamed.slice(0, 6).map((e) => e.selector).join(', '),
      impact: 'A screen-reader user hears only "image" with no indication of its content or purpose.',
      evidence: unnamed.slice(0, 10).map((e) => e.selector).filter(Boolean),
    }));
  }

  // --- 1.3.1 Info & Relationships: heading level skips --------------------
  for (const [url, page] of pages) {
    const levels = (page.entries || [])
      .map((e) => {
        const m = /^heading, .*, level (\d)$/.exec(e.spoken_phrase);
        return m ? { level: Number(m[1]), e } : null;
      })
      .filter(Boolean);
    const skips = [];
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].level - levels[i - 1].level > 1) skips.push(levels[i]);
    }
    if (!skips.length) continue;
    findings.push(makeFinding({
      id: `sr-heading-skip-${viewport}`, wcag: '1.3.1', confidence: 0.75,
      viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
      summary: `${skips.length} heading level skip(s) on ${url} (jumping past one or more levels): ` +
        skips.slice(0, 6).map((s) => s.e.spoken_phrase).join('; '),
      impact: 'A screen-reader user navigating by heading level loses the document outline and may miss sections.',
      evidence: skips.slice(0, 10).map((s) => s.e.selector).filter(Boolean),
    }));
  }

  // --- 1.3.1 Info & Relationships: duplicate unlabeled landmarks ----------
  for (const [url, page] of pages) {
    const counts = new Map();
    for (const e of page.entries || []) {
      if (LANDMARK_ROLES.has(e.role) && e.role === e.spoken_phrase) {
        counts.set(e.role, (counts.get(e.role) || 0) + 1);
      }
    }
    const dups = [...counts].filter(([, n]) => n > 1);
    if (!dups.length) continue;
    findings.push(makeFinding({
      id: `sr-duplicate-landmark-${viewport}`, wcag: '1.3.1', confidence: 0.55,
      viewport, goalId, url, persona: 'screen-reader',
      summary: `Unlabeled, duplicated landmark role(s) on ${url}: ` +
        dups.map(([r, n]) => `${r} (${n}×)`).join(', '),
      impact: 'A screen-reader user browsing by landmark cannot distinguish multiple regions sharing the same unlabeled role.',
    }));
  }

  // --- 4.1.2 Name, Role, Value: reading-order controls with no name -------
  // Superset of the keyboard persona's Tab-reachable check — also catches
  // controls only reachable via a screen reader's arrow-key browse mode.
  for (const [url, page] of pages) {
    const unnamed = (page.entries || []).filter((e) => NAMED_ROLES_4_1_2.has(e.role) && e.role === e.spoken_phrase);
    if (!unnamed.length) continue;
    findings.push(makeFinding({
      id: `sr-missing-accessible-name-${viewport}`, wcag: '4.1.2', confidence: 0.75,
      viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
      summary: `${unnamed.length} interactive control(s) on ${url} announce only their role, no name: ` +
        unnamed.slice(0, 6).map((e) => `${e.role} at ${e.selector}`).join(', '),
      impact: 'A screen-reader user cannot tell what the control does or target it by name.',
      evidence: unnamed.slice(0, 10).map((e) => e.selector).filter(Boolean),
    }));
  }

  // --- 4.1.2 Name, Role, Value: broken ARIA ID reference -------------------
  // aria-controls/describedby/details/errormessage pointing at an ID that
  // resolves to no element at all. Conservative: a multi-ID value only flags
  // if NONE of its IDs resolve (declaredBrokenAriaRefs already applies this
  // in the census DOM query, so no re-filtering needed here).
  for (const [url, page] of pages) {
    const broken = page.declared_broken_aria_refs || [];
    if (!broken.length) continue;
    findings.push(makeFinding({
      id: `sr-broken-aria-reference-${viewport}`, wcag: '4.1.2', confidence: 0.9,
      viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
      summary: `${broken.length} element(s) on ${url} declare an ARIA ID reference that resolves to no ` +
        `element: ` + broken.slice(0, 6).map((r) => `${r.attribute}="${r.ids.join(' ')}" on ${r.selector}`).join(', '),
      impact: 'A screen-reader user cannot reach the referenced control, description, or error message — the ' +
        'relationship the author declared simply does not exist in the page.',
      evidence: broken.slice(0, 10).map((r) => r.selector).filter(Boolean),
    }));
  }

  // --- 4.1.2 Name, Role, Value: keyboard-focusable but AT-invisible -------
  // Cross-references the keyboard persona's Tab-reachable trace against this
  // page's census: a control the crawl actually tabbed to but which never
  // appears in the census walk is (almost always) aria-hidden="true" paired
  // with a positive/zero tabindex — reachable by a sighted keyboard user,
  // invisible to a screen-reader user. `steps` is populated by the crawl
  // regardless of persona (the Tab loop always runs), so this fires even
  // under `--persona screen-reader` alone.
  for (const [url, page] of pages) {
    const censusSelectors = new Set((page.entries || []).map((e) => e.selector).filter(Boolean));
    const seen = new Set();
    const hidden = [];
    for (const s of steps) {
      if (s.is_body || s.url !== url) continue;
      const sel = s.active_element_selector;
      if (!sel || censusSelectors.has(sel) || seen.has(sel)) continue;
      seen.add(sel);
      hidden.push(s);
    }
    if (!hidden.length) continue;
    findings.push(makeFinding({
      id: `sr-focusable-not-exposed-${viewport}`, wcag: '4.1.2', confidence: 0.75,
      viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
      summary: `${hidden.length} control(s) on ${url} are keyboard-focusable but never appear in the screen-` +
        `reader accessibility-tree walk (likely aria-hidden="true" combined with a focusable tabindex): ` +
        hidden.slice(0, 6).map((s) => s.active_element_selector).join(', '),
      impact: 'A sighted keyboard user can tab to this control; a screen-reader user never learns it exists.',
      evidence: hidden.slice(0, 10).map((s) => s.active_element_selector).filter(Boolean),
    }));
  }

  // --- 4.1.3 Status Messages: declared live region that never announced ---
  const totalLiveAnnouncements = steps.reduce((n, s) => n + (s.sr_announcement?.live_announcements?.length || 0), 0);
  if (totalLiveAnnouncements === 0) {
    for (const [url, page] of pages) {
      if (!page.declared_live_regions?.length) continue;
      findings.push(makeFinding({
        id: `sr-live-region-silent-${viewport}`, wcag: '4.1.3', confidence: 0.4,
        viewport, goalId, url, persona: 'screen-reader', evidenceKind: 'selector',
        summary: `${page.declared_live_regions.length} declared live region(s) on ${url} (aria-live/status/` +
          `alert/log) never produced an announcement during this session: ` +
          page.declared_live_regions.slice(0, 5).map((r) => r.selector).join(', '),
        impact: 'If this region is meant to announce dynamic updates (e.g. form errors, confirmations), a ' +
          'screen-reader user never hears them on this path.',
        evidence: page.declared_live_regions.slice(0, 10).map((r) => r.selector).filter(Boolean),
      }));
    }
  }

  return findings;
}

// Dispatches to one or both persona finding sets based on --persona.
function deriveAllFindings({ steps, startUrl, contextChangeOnFocus, census }, { viewport, goalId, persona = 'all' }) {
  const findings = [];
  if (needsKeyboardChecks(persona)) {
    findings.push(...deriveFindingsKeyboard({ steps, startUrl, contextChangeOnFocus }, { viewport, goalId }));
  }
  if (needsScreenReader(persona)) {
    findings.push(...deriveFindingsScreenReader({ steps, census }, { viewport, goalId }));
  }
  return findings;
}

// Low-confidence, informative-leaning comparison across viewports (mobile vs.
// desktop): a NAMED interactive control present in one viewport's census but
// entirely absent from another's for the same URL. Often intentional
// responsive design (e.g. a nav collapsing into a hamburger), so this follows
// the same low-confidence precedent as the 4.1.3 silent-live-region check
// rather than treating a divergence as an automatic defect.
const CROSS_VIEWPORT_NAMED_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'slider', 'switch', 'searchbox',
]);
function deriveCrossViewportFindings(censusByViewport) {
  const findings = [];
  const viewportNames = Object.keys(censusByViewport);
  for (let i = 0; i < viewportNames.length; i++) {
    for (let j = i + 1; j < viewportNames.length; j++) {
      const [vpA, vpB] = [viewportNames[i], viewportNames[j]];
      const pagesA = censusByViewport[vpA] || {};
      const pagesB = censusByViewport[vpB] || {};
      const commonUrls = Object.keys(pagesA).filter((u) => u in pagesB);
      for (const url of commonUrls) {
        const namedEntries = (page) => (page.entries || [])
          .filter((e) => CROSS_VIEWPORT_NAMED_ROLES.has(e.role) && e.role !== e.spoken_phrase)
          .map((e) => e.spoken_phrase);
        const setA = new Set(namedEntries(pagesA[url]));
        const setB = new Set(namedEntries(pagesB[url]));
        const onlyInA = [...setA].filter((p) => !setB.has(p));
        const onlyInB = [...setB].filter((p) => !setA.has(p));
        if (!onlyInA.length && !onlyInB.length) continue;
        findings.push(makeFinding({
          id: `cross-viewport-divergence-${vpA}-vs-${vpB}`,
          wcag: '1.3.1', confidence: 0.4, viewport: `${vpA}+${vpB}`, url,
          persona: 'screen-reader',
          summary: `Named interactive control(s) present in the ${vpA} accessibility-tree census for ${url} ` +
            `but entirely absent from ${vpB} (or vice versa): ` +
            [...onlyInA.slice(0, 3).map((p) => `${vpA} only: "${p}"`), ...onlyInB.slice(0, 3).map((p) => `${vpB} only: "${p}"`)].join('; '),
          impact: 'A screen-reader user on one viewport may lose access to functionality available on the ' +
            'other — though this may also reflect intentional responsive design (e.g. a collapsed nav); ' +
            'needs human confirmation.',
        }));
      }
    }
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

// Same selector waitForReady's readiness check cares about (see below) --
// kept as one literal so the MutationObserver logic and the selector it's
// standing in for can't silently drift apart.
const FOCUSABLE_SELECTOR =
  'a[href],button,input:not([type=hidden]),select,textarea,[tabindex],summary,[contenteditable]';
const FOCUSABLE_ATTRS = ['href', 'type', 'tabindex', 'contenteditable'];

// Injected at document start (before any of the page's own scripts run) so it
// captures every DOM change from the very first paint, not just ones that
// happen after waitForReady() is called. Stamps window.__lastRelevantMutation
// on any change that could plausibly move waitForReady's focusable-element
// count. Deliberately NOT "any mutation at all" -- childList mutations are
// filtered in the callback to only the added/removed nodes that themselves
// match FOCUSABLE_SELECTOR or contain a descendant that does (native
// MutationObserver has no selector-based childList filter, only
// attributeFilter for attribute changes) -- otherwise ANY background DOM
// churn unrelated to focusable content (a live ticker, a chat widget
// appending messages, an ad slot refreshing) would reset the quiet window
// forever and this would never resolve before maxWaitMs. That's not a
// hypothetical: unscoped childList tracking measured 8000ms (full timeout)
// against a 2-static-button page with an unrelated background node churn,
// versus 613ms for the old count-based check on the same page.
const DOM_QUIET_TRACKER_JS = `(() => {
  window.__lastRelevantMutation = Date.now();
  const SELECTOR = ${JSON.stringify(FOCUSABLE_SELECTOR)};
  const isRelevant = (node) =>
    node.nodeType === 1 && ((node.matches && node.matches(SELECTOR)) || (node.querySelector && node.querySelector(SELECTOR)));
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { window.__lastRelevantMutation = Date.now(); continue; }
      let relevant = false;
      for (const n of r.addedNodes) { if (isRelevant(n)) { relevant = true; break; } }
      if (!relevant) for (const n of r.removedNodes) { if (isRelevant(n)) { relevant = true; break; } }
      if (relevant) window.__lastRelevantMutation = Date.now();
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ${JSON.stringify(FOCUSABLE_ATTRS)} });
})();`;

async function makeContext(browser, viewport, disableAnimations, storageState, persona = 'all') {
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
  if (needsScreenReader(persona)) {
    await context.addInitScript({ content: loadVsrIife() });
  }
  await context.addInitScript({ content: DOM_QUIET_TRACKER_JS });
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
// no perfect "fully loaded" signal on sites with continuous network chatter --
// a strict networkidle wait never resolves on a page with ordinary background
// traffic (analytics beacons, websocket keepalives) even once its DOM is long
// since settled, and burns its full timeout every time. So this waits on DOM
// stability alone: window.__lastRelevantMutation (maintained continuously
// from navigation start by DOM_QUIET_TRACKER_JS, see makeContext) going quiet
// for `quietMs` is the same "stopped changing" signal a count-polling loop
// would approximate, just detected the instant it's true instead of on a
// blind fixed tick -- so multi-burst hydration is caught right after its last
// real mutation instead of accumulating discretization slop per burst.
async function waitForReady(page, { quietMs = 600, maxWaitMs = 8000 } = {}) {
  await page.waitForFunction(
    (quiet) => Date.now() - (window.__lastRelevantMutation || 0) >= quiet,
    quietMs,
    { timeout: maxWaitMs }
  ).catch(() => {}); // best-effort: proceed with whatever the DOM is after maxWaitMs
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
  const persona = opts.persona || 'all';
  const disableAnimations = testCase.runtime?.disable_animations !== false;
  const context = await makeContext(browser, viewport, disableAnimations, opts.storageState, persona);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');

  const censusStore = {};
  const censusedUrls = new Set();
  const srState = { logLength: 0 };
  // Chains every 'load'-triggered census onto the previous one, so callers can
  // `await pendingCensus` to be sure no census work is still in flight before
  // reading censusStore or closing the page/context (avoids both a race where
  // findings are derived from an incomplete census, and a crash from evaluating
  // against an already-closed page).
  let pendingCensus = Promise.resolve();
  if (needsScreenReader(persona)) {
    page.on('load', () => {
      pendingCensus = pendingCensus.then(async () => {
        await startVsr(page);
        const url = page.url();
        if (!censusedUrls.has(url)) {
          censusedUrls.add(url);
          censusStore[url] = { captured_at: new Date().toISOString(), ...(await runCensusWithTimeout(page)) };
        }
      }).catch(() => {});
    });
  }

  const startUrl = testCase.target.start_url;
  log(`  [${viewport.name}] navigating ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'load', timeout: 60000 });
  await waitForReady(page);
  if (needsScreenReader(persona)) await startVsr(page);

  const vpDir = path.join(opts.outDir, safeSeg(viewport.name));
  const screenshotsDir = path.join(vpDir, 'screenshots');
  ensureDir(screenshotsDir);

  const goalId = testCase.goals?.[0]?.id || null;
  const result = await crawl(page, cdp, { maxSteps: opts.maxSteps, screenshotsDir, persona, srState });
  await pendingCensus;
  const findings = deriveAllFindings({ ...result, census: censusStore }, { viewport: viewport.name, goalId, persona });

  const trace = {
    test_case_id: testCase.id,
    viewport: viewport.name,
    mode: 'crawl',
    personas: persona === 'all' ? ['keyboard', 'screen-reader'] : [persona],
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
  if (needsScreenReader(persona)) {
    fs.writeFileSync(
      path.join(vpDir, 'screen-reader-census.json'),
      JSON.stringify(
        { test_case_id: testCase.id, viewport: viewport.name, generated_at: opts.timestamp, pages: censusStore },
        null, 2
      )
    );
  }

  log(`  [${viewport.name}] crawl: ${result.steps.length} steps, ${findings.length} finding(s) → ${vpDir}`);

  await cdp.detach().catch(() => {});
  await context.close();
  return { viewport: viewport.name, steps: result.steps.length, findings, census: censusStore };
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

// Windows named pipes live in a flat, virtual `\\.\pipe\` namespace, not the
// real filesystem -- binding an AF_UNIX-style socket file under a Temp
// directory is unreliable there (EACCES on GitHub Actions' windows-latest
// runners). Derive a unique pipe name from `dir` instead; on other platforms
// a plain socket file under `dir` works fine.
function controlSockPath(dir) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + dir.replace(/[:\\]/g, '_');
  return path.join(dir, 'control.sock');
}

function sessionPaths(dir) {
  return {
    dir,
    sessionJson: path.join(dir, 'session.json'),
    stepsJson: path.join(dir, 'steps.json'),
    screenshotsDir: path.join(dir, 'screenshots'),
    stopFile: path.join(dir, 'STOP'),
    controlSock: controlSockPath(dir),
    srCensusJson: path.join(dir, 'sr-census.json'),
  };
}
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
  testCase.id = safeSeg(testCase.id);
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
    sr_announcement: step.sr_announcement ?? null,
  };
}

// ---------------------------------------------------------------------------
// Live-session control channel. `serve` holds the one persistent page/cdp and
// an in-memory `state` object for the whole session and exposes them over a
// Unix-domain socket (control.sock) -- observe/step/finish/stop become thin
// clients that send one NDJSON request and read one NDJSON response, instead
// of each paying a fresh chromium.connectOverCDP() handshake + CDP session +
// DOM/Accessibility enable on every single keystroke.
// ---------------------------------------------------------------------------

// Low-level one-shot request: connect, write one line, read one line back,
// resolve with `data` or reject with `error`. Does not check whether the
// session dir looks valid -- `sendControlRequest` below does that; `stop`
// deliberately calls this directly so it keeps working even against a
// half-torn-down or never-started session (see cmdStop).
function socketRequest(paths, reqObj) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(paths.controlSock);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(reqObj) + '\n'));
    conn.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    conn.on('end', () => {
      try {
        const res = JSON.parse(buf.trim());
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error || 'request failed'));
      } catch (e) { reject(e); }
    });
    conn.on('error', reject);
  });
}

// Same failure UX as the old connectSession(): a missing session.json exits 1
// before ever touching the socket; an unreachable socket (serve crashed, or
// already stopped) exits 1 too.
async function sendControlRequest(dir, reqObj) {
  const paths = sessionPaths(dir);
  if (!fs.existsSync(paths.sessionJson)) { log(`No session at ${dir}. Run \`serve\` first.`); process.exit(1); }
  try {
    return await socketRequest(paths, reqObj);
  } catch (err) {
    log(`Session at ${dir} is not running (control socket unreachable): ${err.message}`);
    process.exit(1);
  }
}

// --- Request handlers: run inside the long-lived `serve` process against its
// one in-memory `state`, never re-reading session.json/steps.json between
// calls the way the old per-call connectSession() path had to.

async function handleObserve(state) {
  const focused = await captureFocused(state.cdp, state.page);
  const obs = {
    index: state.index,
    note: 'current state (no keystroke sent)',
    url: focused.url ?? state.startUrl,
    focused: {
      selector: focused.selector, tag: focused.tag ?? null,
      name: focused.ax?.name ?? null, role: focused.ax?.role ?? null, states: focused.ax?.states ?? null,
    },
  };
  if (needsScreenReader(state.persona)) {
    obs.sr_last_spoken_phrase = await state.page
      .evaluate(() => window.__vsr?.virtual?.lastSpokenPhrase())
      .catch(() => null);
  }
  return obs;
}

async function handleStep(state, req) {
  const index = state.index + 1;

  let keystroke, activating = false;
  if (req.type != null) {
    await state.page.keyboard.type(req.type);
    keystroke = 'type:' + JSON.stringify(req.type.slice(0, 60));
  } else {
    const key = req.press || 'Tab';
    await state.page.keyboard.press(key === 'Space' ? ' ' : key);
    keystroke = key;
    activating = key === 'Enter' || key === 'Space';
  }
  await state.page.waitForTimeout(activating ? 250 : 40);
  if (activating) await state.page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});

  // If this keystroke landed on a page that has a CAPTCHA, apply page-scoped
  // compatibility once so the CAPTCHA can run (and be tested) — human-approved.
  let captchaCompatApplied = false;
  if (!state.captchaCompat && activating) {
    captchaCompatApplied = await ensureCaptchaCompat(state.ctx, state.page);
    if (captchaCompatApplied) log(`  ⚠ CAPTCHA detected at ${state.page.url()} — navigator.webdriver suppressed for this page (human-approved)`);
    state.captchaCompat = state.captchaCompat || captchaCompatApplied;
  }

  const persona = state.persona;
  const prev = state.steps[state.steps.length - 1];

  // These three reads of "current page state" are independent of each other --
  // run them concurrently instead of paying their round trips one after another.
  const capturePixelDiff = needsKeyboardChecks(persona);
  const captureSr = needsScreenReader(persona);
  const [focused, shotBuffer, sr] = await Promise.all([
    captureFocused(state.cdp, state.page),
    capturePixelDiff ? state.page.screenshot() : Promise.resolve(null),
    captureSr ? captureScreenReader(state.page, state.srState.logLength) : Promise.resolve(null),
  ]);

  let shotRel = null;
  if (capturePixelDiff) {
    const framePng = PNG.sync.read(shotBuffer);
    // Kept in memory for handleFinish's focus-visible diff (see finalizeFocusVisible)
    // rather than round-tripped through disk -- the agent never reads full frames,
    // only the cropped screenshots/step_NNNN.png below.
    state.fullFrames.push(framePng);
    if (focused.bbox && focused.bbox.width >= 1 && focused.bbox.height >= 1) {
      fs.writeFileSync(path.join(state.paths.screenshotsDir, `${stepId(index)}.png`), PNG.sync.write(cropPng(framePng, inflate(focused.bbox))));
      shotRel = path.join('screenshots', `${stepId(index)}.png`);
    }
  }

  let srAnnouncement = null;
  if (captureSr && sr) {
    state.srState.logLength = sr.log_length;
    srAnnouncement = { new_phrases: sr.new_phrases, live_announcements: sr.live_announcements, focus_announcement: sr.focus_announcement };
  }

  // Mirror captureFocused's secret-field suppression for the typed text itself:
  // record that a type happened and its length, never the literal secret.
  if (req.type != null && focused.isSecretField) {
    keystroke = `type:[redacted ${req.type.length} chars]`;
  }

  const step = {
    step_id: stepId(index), index, keystroke_sent: keystroke,
    active_element_selector: focused.selector, tag: focused.tag ?? null, tabindex: focused.tabindex ?? null,
    dom_order_index: focused.domOrderIndex ?? -1,
    ax_name_role_state: focused.ax ? { name: focused.ax.name, role: focused.ax.role, states: focused.ax.states } : null,
    focus_moved: !prev || prev.active_element_selector !== focused.selector,
    bounding_box: focused.bbox ?? null, ancestor_boxes: focused.ancestorBoxes ?? [],
    url: focused.url ?? state.startUrl,
    text: focused.text ?? '', is_body: !!focused.isBody,
    computed_focus_style: focused.focusStyle ?? null, region: focused.region ?? null,
    focused_region_screenshot: shotRel, focus_visible: null,
    sr_announcement: srAnnouncement,
  };
  state.steps.push(step);
  state.index = index;
  writeJson(state.paths.stepsJson, state.steps);

  const obs = observationOf(step);
  if (captchaCompatApplied) obs.captcha_compat_applied = true;
  return obs;
}

async function handleFinish(state) {
  const steps = state.steps;
  const persona = state.persona;

  if (needsKeyboardChecks(persona)) {
    finalizeFocusVisible(steps, state.fullFrames, state.restPng);
  }

  let census = null;
  if (needsScreenReader(persona)) {
    // censusStore is kept live by the page.on('load') listener registered
    // once in cmdServe -- await pendingCensus so a still-in-flight census for
    // the most recent navigation can't race the check below (same guarantee
    // the old per-call connectSession()-based fallback gave, just without a
    // second connection to get it).
    await state.pendingCensus;
    census = state.censusStore;
    const currentUrl = state.page.url();
    if (!census[currentUrl]) {
      census[currentUrl] = { captured_at: new Date().toISOString(), ...(await runCensusWithTimeout(state.page)) };
      writeJson(state.paths.srCensusJson, census);
    }
  }

  const findings = deriveAllFindings(
    { steps, startUrl: state.startUrl, contextChangeOnFocus: null, census },
    { viewport: state.viewport, goalId: state.goalId, persona }
  );

  const trace = {
    test_case_id: state.caseId, viewport: state.viewport, mode: 'driven-live',
    personas: persona === 'all' ? ['keyboard', 'screen-reader'] : [persona],
    viewport_size: state.viewportSize, start_url: state.startUrl,
    goals: state.goals, steps,
  };
  writeJson(path.join(state.paths.dir, 'trace.json'), trace);
  writeJson(path.join(state.paths.dir, 'deterministic-findings.json'),
    { test_case_id: state.caseId, viewport: state.viewport, mode: 'driven-live', findings });
  if (needsScreenReader(persona)) {
    writeJson(path.join(state.paths.dir, 'screen-reader-census.json'),
      { test_case_id: state.caseId, viewport: state.viewport, mode: 'driven-live', pages: census });
  }
  log(`finished: ${steps.length} steps, ${findings.length} deterministic finding(s) → ${state.paths.dir}`);
  return { steps: steps.length, findings };
}

async function cmdServe(args) {
  await loadHeavyDeps();
  let persona;
  try {
    persona = validatePersona(args.persona || 'all');
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  const testCase = args.url ? synthCase(args.url, args.goal) : loadCase(args._[1]);
  let vp;
  try {
    vp = pickViewport(testCase, args.viewport);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  // Optional standalone devtools/CDP debugging of a live session -- no longer
  // used by this file's own observe/step/finish/stop, which talk to
  // `paths.controlSock` instead. The remote-debugging endpoint is
  // unauthenticated and grants full control of the (possibly authenticated)
  // browser, so it is opened only when the operator explicitly asks for it
  // via --port rather than always-on.
  const port = args.port || null;
  let storageState;
  try {
    storageState = resolveStorageState(args.storageState);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  const outRoot = outRootFrom(args.out);
  const dir = path.join(outRoot, testCase.id, `session-${safeSeg(vp.name)}`);
  const paths = sessionPaths(dir);
  ensureDir(paths.screenshotsDir);
  if (fs.existsSync(paths.stopFile)) fs.rmSync(paths.stopFile);
  if (fs.existsSync(paths.controlSock)) fs.rmSync(paths.controlSock);

  // Fail fast, before launching Chromium, if the screen-reader persona's
  // dependency can't be loaded (same philosophy as the :focus-visible gate).
  if (needsScreenReader(persona)) loadVsrIife();

  const browser = await chromium.launch({
    channel: 'chromium', headless: true,
    args: port ? [...CHROMIUM_ARGS, `--remote-debugging-port=${port}`] : CHROMIUM_ARGS,
  });
  // Startup self-check — irrelevant to a screen-reader-only run (no pixel work).
  if (needsKeyboardChecks(persona)) {
    const probe = await browser.newContext();
    try { await verifyFocusVisibleModality(probe); } finally { await probe.close(); }
  }

  const disableAnimations = testCase.runtime?.disable_animations !== false;
  const context = await makeContext(browser, vp, disableAnimations, storageState, persona);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');

  const censusStore = {};
  const censusedUrls = new Set();
  let pendingCensus = Promise.resolve(); // see runViewport for why this is chained/awaited
  if (needsScreenReader(persona)) {
    page.on('load', () => {
      pendingCensus = pendingCensus.then(async () => {
        await startVsr(page);
        const url = page.url();
        if (!censusedUrls.has(url)) {
          censusedUrls.add(url);
          censusStore[url] = { captured_at: new Date().toISOString(), ...(await runCensusWithTimeout(page)) };
          writeJson(paths.srCensusJson, censusStore);
        }
      }).catch(() => {});
    });
  }

  await page.goto(testCase.target.start_url, { waitUntil: 'load', timeout: 60000 });
  await waitForReady(page);
  if (needsScreenReader(persona)) await startVsr(page);
  const captchaCompat = await ensureCaptchaCompat(context, page);
  if (captchaCompat) log('  ⚠ CAPTCHA on start page — navigator.webdriver suppressed for this page (human-approved)');
  // Baseline (nothing focused) frame for the focus-visible diff in handleFinish
  // -- kept in memory (never read by the agent) rather than written to disk.
  const restPng = needsKeyboardChecks(persona) ? PNG.sync.read(await page.screenshot()) : null;

  const startUrl = page.url();
  const goalId = testCase.goals?.[0]?.id || null;
  const goals = (testCase.goals || []).map((g) => ({ id: g.id, intent: g.intent }));
  writeJson(paths.sessionJson, {
    caseId: testCase.id,
    viewport: vp.name,
    viewport_size: { width: vp.width, height: vp.height },
    startUrl,
    cdpUrl: port ? `http://127.0.0.1:${port}` : null,
    goalId,
    goals,
    captchaCompat,
    persona,
  });
  writeJson(paths.stepsJson, []);

  // The one in-memory object every socket request handler above operates on --
  // replaces the old per-call connectSession()/session.json/steps.json
  // read-modify-write with state that just lives for the process's lifetime.
  const state = {
    paths, page, ctx: context, cdp, persona, startUrl, caseId: testCase.id, goalId, goals,
    viewport: vp.name, viewportSize: { width: vp.width, height: vp.height },
    steps: [], index: 0, srState: { logLength: 0 },
    censusStore, censusedUrls, captchaCompat,
    fullFrames: [], restPng,
    get pendingCensus() { return pendingCensus; },
  };

  // Serial dispatch queue: requests run one at a time in arrival order. The
  // one-keystroke-at-a-time contract (the invoking agent always awaits one
  // `step` before issuing the next) makes overlap unreachable in practice,
  // but this makes it structurally impossible to corrupt `state` if it ever
  // happened — same chaining idiom as `pendingCensus` above.
  let queue = Promise.resolve();
  function runSerially(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      conn.removeAllListeners('data');
      let req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        conn.end(JSON.stringify({ ok: false, error: 'bad request: ' + e.message }) + '\n');
        return;
      }
      runSerially(async () => {
        if (req.cmd === 'observe') return handleObserve(state);
        if (req.cmd === 'step') return handleStep(state, req);
        if (req.cmd === 'finish') return handleFinish(state);
        if (req.cmd === 'stop') return null;
        throw new Error(`unknown cmd: ${req.cmd}`);
      })
        .then((data) => {
          conn.end(JSON.stringify({ ok: true, data }) + '\n');
          // Only signal shutdown AFTER the ack is queued for delivery, so the
          // client never sees a reset connection instead of its response.
          if (req.cmd === 'stop') resolveStop();
        })
        .catch((err) => conn.end(JSON.stringify({ ok: false, error: err?.message || String(err) }) + '\n'));
    });
    conn.on('error', () => {}); // client disconnected mid-write; nothing to do
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.controlSock, resolve);
  });

  log(`  ✓ startup checks passed · navigated ${page.url()}` + (storageState ? ` · storage state loaded (${storageState})` : ''));
  process.stdout.write(`READY ${dir}\n`);

  // Stay alive until `stop` is requested — normally over the socket above,
  // or (if the socket is unreachable) via the STOP-file fallback `cmdStop`
  // writes when it can't connect.
  const stopFilePoll = setInterval(() => {
    if (fs.existsSync(paths.stopFile)) resolveStop();
  }, 500);
  await stopped;
  clearInterval(stopFilePoll);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(paths.controlSock, { force: true });
  await pendingCensus; // let any in-flight census finish before the page/browser goes away
  await browser.close();
  log('session stopped');
}

async function cmdObserve(args) {
  const obs = await sendControlRequest(args._[1], { cmd: 'observe' });
  process.stdout.write(JSON.stringify(obs, null, 2) + '\n');
}

async function cmdStep(args) {
  const dir = args._[1];
  let reqBody;
  if (args.type != null) {
    reqBody = { cmd: 'step', type: args.type };
  } else {
    const key = args.press || 'Tab';
    if (!ALLOWED_KEYS.has(key)) { log(`Disallowed key: ${key}`); process.exit(1); }
    reqBody = { cmd: 'step', press: key };
  }
  const obs = await sendControlRequest(dir, reqBody);
  process.stdout.write(JSON.stringify(obs, null, 2) + '\n');
}

async function cmdFinish(args) {
  const result = await sendControlRequest(args._[1], { cmd: 'finish' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function cmdStop(args) {
  const paths = sessionPaths(args._[1]);
  try {
    await socketRequest(paths, { cmd: 'stop' });
  } catch {
    fs.writeFileSync(paths.stopFile, '1');
  }
  log('stop requested');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    log(err.message);
    process.exit(1);
  }

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
  await loadHeavyDeps();

  let persona;
  try {
    persona = validatePersona(args.persona);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  const testCase = args.url ? synthCase(args.url, args.goal) : loadCase(args._[0]);

  let viewports = testCase.viewports || [{ name: 'desktop', width: 1280, height: 800 }];
  if (args.viewport) viewports = viewports.filter((v) => v.name === args.viewport);
  if (!viewports.length) {
    log(`No matching viewport: ${args.viewport}`);
    process.exit(1);
  }

  // Fail fast, before launching Chromium, if the screen-reader persona's
  // dependency can't be loaded (same philosophy as the :focus-visible gate).
  if (needsScreenReader(persona)) loadVsrIife();

  const timestamp = process.env.RUN_TIMESTAMP || new Date().toISOString();
  const outRoot = outRootFrom(args.out);
  const outDir = path.join(outRoot, testCase.id);
  ensureDir(outDir);
  let storageState;
  try {
    storageState = resolveStorageState(args.storageState);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }

  log(`Test case: ${testCase.id}`);
  log(`Viewports: ${viewports.map((v) => v.name).join(', ')}`);
  if (storageState) log(`Storage state: ${storageState}`);
  log(`Persona: ${persona}`);

  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: CHROMIUM_ARGS });

  try {
    // Startup self-check — fail fast if modality is wrong. Irrelevant to a
    // screen-reader-only run (no pixel work), so skip it there.
    if (needsKeyboardChecks(persona)) {
      log('Verifying :focus-visible modality on CDP-driven key events…');
      const probeCtx = await browser.newContext();
      try {
        await verifyFocusVisibleModality(probeCtx);
        log('  ✓ :focus-visible fires on keyboard modality');
      } finally {
        await probeCtx.close();
      }
    }

    // Each viewport gets its own isolated context/page/CDP session (see
    // runViewport), so independent viewports can be crawled concurrently
    // instead of one-at-a-time — Promise.all preserves the `viewports` order
    // in `results` regardless of which finishes first.
    const results = await Promise.all(
      viewports.map((vp) => runViewport(browser, testCase, vp, { outDir, maxSteps: args.maxSteps, timestamp, storageState, persona }))
    );
    const summary = results.map((r) => ({ viewport: r.viewport, steps: r.steps, findings: r.findings }));
    const censusByViewport = {};
    if (needsScreenReader(persona)) {
      for (let i = 0; i < viewports.length; i++) censusByViewport[viewports[i].name] = results[i].census;
    }

    fs.writeFileSync(
      path.join(outDir, 'run-summary.json'),
      JSON.stringify({ test_case_id: testCase.id, generated_at: timestamp, viewports: summary }, null, 2)
    );

    // Cross-viewport comparison needs at least two viewports' census data at
    // once — no single runViewport() call ever sees more than one, so this
    // has to live here, after the loop, batch/crawl mode only.
    if (needsScreenReader(persona) && Object.keys(censusByViewport).length > 1) {
      const crossViewportFindings = deriveCrossViewportFindings(censusByViewport);
      fs.writeFileSync(
        path.join(outDir, 'cross-viewport-findings.json'),
        JSON.stringify({ test_case_id: testCase.id, generated_at: timestamp, findings: crossViewportFindings }, null, 2)
      );
    }
    log(`\nDone. Output: ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log('\nFATAL: ' + (err?.stack || err?.message || String(err)));
  process.exit(1);
});
