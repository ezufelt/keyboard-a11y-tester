# Architecture reference

On-demand reference for the invoking agent: how the runner drives the browser and what it
captures. Self-contained — no external files required.

## Driver

- **Playwright (Chromium)** as the harness: maintained headless-Linux images,
  target/frame lifecycle, auto-waiting, stable selectors, bounding boxes, screenshots.
- `keyboard.press()` dispatches **real** `Input.dispatchKeyEvent` events, so native
  focus movement and `:focus-visible` behave correctly. Never JS-dispatch synthetic
  `KeyboardEvent`s — they don't move focus.
- Drop to a raw **CDP session** (`context.newCDPSession(page)`) for the accessibility
  tree: `Accessibility.getPartialAXTree` / `getFullAXTree` — ground truth for
  name/role/state. Do **not** use Playwright's deprecated `page.accessibility.snapshot()`.

## Runtime (container)

- New-headless full Chromium + SwiftShader for real pixels (focus-indicator detection).
- Fixed viewport, animations disabled, reduced motion → deterministic layout, tab
  order, and focus-indicator pixel diffs.
- **Validate `:focus-visible` fires on CDP-driven key events at startup; fail fast** if
  not — otherwise every focus-indicator check is invalid.

## Interaction model

Behaves like a keyboard user and nothing else. **Never** `.click()` or `.focus()` — if a
control is only reachable by mouse, that is a finding. Allowed keys only: `Tab`,
`Shift+Tab`, arrows, `Enter`, `Space`, `Escape`, `Home`, `End`. This rule extends to the
screen-reader persona's library too — its own interaction methods (`act()`/`interact()`/
`press()`/`type()`) are **never** called; all real interaction stays on Playwright's real
keyboard events, and the library is used only to *observe* (compute accessible
name/role/state and announcements), never to drive the page.

## Per-step capture loop

After every keystroke, record: active element (stable selector), AX name/role/state
(CDP), focus_moved?, bounding box, focused-region screenshot (crop; diffed vs an
unfocused baseline for focus-visible), and — when the screen-reader persona is active —
`sr_announcement` (see below). This trace is both the input to the AI layer and the
evidence attached to every finding.

## Screen-reader accessibility-tree capture (persona "Lakshmi")

`@guidepup/virtual-screen-reader` builds an ARIA/ACCNAME-spec accessible tree over the
live DOM and emulates screen-reader announcements — no real assistive technology (NVDA/
VoiceOver) is driven. It ships a self-contained browser ESM bundle
(`lib/esm/index.browser.js`); the runner regex-extracts its trailing `export{...}`
statement and re-emits it as a plain classic-script IIFE (`loadVsrIife()`), injected via
`context.addInitScript({ content })`. This is deliberate: a plain `addInitScript`-injected
classic script is not subject to the page's own CSP (`script-src`), unlike a dynamic
`import()`/`blob:` URL, which real CSP policies often block — verified empirically against
both a synthetic CSP-locked test page and a real CSP-locked production site.

Two-instance model:
- **One long-lived monitor per page load** — the library's `virtual` singleton, started
  once (`startVsr()`, idempotent) per navigation. It registers a native `focusin`
  listener, so its cursor **tracks Playwright's real Tab-driven focus automatically** —
  the runner never calls `.next()` to "chase" focus, so there is no cursor-drift risk. It
  also wires a `MutationObserver` that computes WAI-ARIA live-region semantics (explicit
  `aria-live`, implicit `alert`/`status`/`log`/`alertdialog` roles) and pushes
  `"assertive: …"`/`"polite: …"` entries into the same `spokenPhraseLog()` — this is what
  `sr_announcement.live_announcements` is diffed from per step (`captureScreenReader()`).
- **One ephemeral instance per page, for the structural census** — a separate
  `new Virtual()` (never the live monitor, so it can't pollute that log), walked via
  `.next()` from the top once per newly-seen URL (`runCensus()`), producing the reading-
  order sequence written to `screen-reader-census.json`. This is the only place the
  runner performs a whole-page AX walk; the per-step capture elsewhere is focus-only.
  Declared-but-never-fired live regions are caught separately via a direct
  `querySelectorAll('[aria-live],[role=status],...')` in the same pass, since a live
  region that never mutates never appears in the event-driven `spokenPhraseLog`.

## Deterministic vs AI judgment

The runner owns the machine-decidable checks. Keyboard persona: 2.1.1 / 2.1.2 / 2.4.1 /
2.4.3 / 2.4.7 / 3.2.1 / 4.1.2. Screen-reader persona: 1.1.1 / 1.3.1 (heading skips,
duplicate unlabeled landmarks) / 4.1.2 (bare-role controls) / 4.1.3 (silent declared live
regions). The AI layer reads `trace.json` + `screenshots/` + `screen-reader-census.json`
and judges what rules can't: task completion, logical focus/reading order vs visual
layout, focus-indicator and announcement perceivability/quality, custom-widget APG
patterns, and form quality.

## Findings & output

Every finding MUST reference the evidence (step id(s), or a page selector for
screen-reader census-sourced findings — see `evidence_kind`), carry a confidence score,
map to a specific WCAG success criterion, name the page URL, and state persona impact in
plain language. Finding shape (as emitted in `deterministic-findings.json`):
`{ id, wcag, source, persona, evidence_kind, conformance_level, confidence, severity,
viewport, url, locations, summary, persona_impact, evidence[] }` (`persona` and
`evidence_kind` are additive fields; `persona` defaults to `'keyboard'` and
`evidence_kind` to `'step_id'` when absent, so older consumers of this shape don't break).
The runner's I/O contract — a URL or test-case YAML in; `trace.json` /
`deterministic-findings.json` / `screenshots/` / `screen-reader-census.json` out (under a
temp dir) — is stable.

## Personas

Ground persona judgments in the W3C WAI user stories —
<https://www.w3.org/WAI/people-use-web/user-stories/>. The deterministic checks support:
- **Ade** (keyboard+speech reporter): visible focus, logical order, skip links,
  accessible names for speech control.
- **Lakshmi** (blind, screen-reader user on desktop and mobile): accessible
  names/descriptions, heading/landmark structure, and live-region announcements. Both
  personas run together by default (`--persona all`); `--persona keyboard` or
  `--persona screen-reader` restricts to one.
