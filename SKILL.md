---
name: keyboard-a11y-tester
description: >-
  Drive a real browser KEYBOARD-ONLY to test whether a keyboard-only person AND a screen-reader
  person can complete a task on a website, and report evidence-linked WCAG findings. Both
  personas run by default in one pass. Use when the user wants to test/audit a site with the
  keyboard, check keyboard navigation, focus order, focus visibility, keyboard traps, skip links,
  accessible names, screen-reader announcements, ARIA live regions, heading/landmark structure,
  or alt text — OR asks whether a keyboard-only or screen-reader user can complete a specific
  task ("visit X and find/do Y", "can a keyboard user submit the form", "would a screen reader
  announce this correctly"), OR to run a *.test.yaml case. Behaves like the W3C keyboard persona
  "Ade" and the W3C screen-reader persona "Lakshmi". Do NOT use for axe/Lighthouse-only rule
  scans, colour-contrast-only audits, or for driving a REAL screen reader (NVDA/VoiceOver) — the
  screen-reader checks here are ARIA/ACCNAME-tree emulation, not real assistive-tech automation.
---

# Keyboard-only + screen-reader accessibility tester

You drive a real Chromium browser using **only the keyboard** and judge whether a keyboard-only
person and a screen-reader person can accomplish a task, producing findings mapped to WCAG
success criteria. A bundled script (`scripts/runner.mjs`) owns the mechanical work — driving
keys, capturing state, and computing the deterministic checks for both personas. **You are the
judgment layer**: you decide each keystroke by reading what happened, and you write the findings
the rules can't (task completion, logical order, form quality, announcement quality).

Never call a mouse. If a control is only reachable/operable by pointer, that is a finding. The
screen-reader checks never drive a real screen reader either — they emulate ARIA/ACCNAME-tree
computation via `@guidepup/virtual-screen-reader` (see the "Screen-reader" section below and
`references/architecture.md`), which augments but does not replace testing with real screen
readers and real users.

## Setup (check first, then ASK before installing)

All commands run from this skill's directory (`cd` into it). Run the preflight, then
install only what's missing — and **ask the user first** each time:

```bash
node scripts/setup-check.mjs   # prints JSON: { deps_installed, browser_available, ... }
```

1. If `deps_installed` is `false`: ask the user *"Install this skill's npm dependencies
   (`npm install`)?"* — run it only if they agree.
2. Re-run the preflight (the browser can only be checked once deps exist). If
   `browser_available` is `false`: ask the user *"Install the Playwright Chromium browser
   (`npx playwright install chromium`)?"* — run it only if they agree.
   **Do NOT ask about the browser when `browser_available` is already `true`** — the
   preflight actually launches Chromium, so `true` means you already have access.

Never install without asking.

## The core loop: observe → decide → act (this is the whole skill)

Work one keystroke at a time against a persistent browser session. **After every keystroke, read
the observation and decide the next key from what you actually see — never send a pre-counted
sequence of Tabs.** "Tab 6 times" is wrong; "Tab *until the focused control is named X*" is right.

1. **Start a session** (keep it running in the background):
   ```bash
   node scripts/runner.mjs serve --url <https://site> --goal "<the task in plain words>" \
        --viewport desktop --port 9400
   # prints:  READY <session-dir>     (the session dir is under the system temp dir)
   ```
   `--url` runs against any site — no test file needed. (Optional: pass a saved
   `<scenario>.test.yaml` path instead of `--url`; see `test-cases/TEMPLATE.test.yaml`.)
   Run once per viewport (`--viewport desktop`, then `--viewport mobile` on a different `--port`).
   All output (trace, findings, screenshots) is written under a per-user **temp directory**
   — never into the skill/project folder. Override with `--out <dir>` if you want it elsewhere.

   By default BOTH personas run in the same pass (`--persona all`, the default). Restrict to one
   with `--persona keyboard` (today's behavior, no screen-reader data, no `screen-reader-census.json`)
   or `--persona screen-reader` (no pixel/focus-indicator work, no `:focus-visible` startup gate —
   irrelevant to a blind persona).

   If `serve` aborts with `returned HTTP 403 — refusing to audit an error page`, a CDN/WAF is
   blocking headless Chromium on its user-agent (very common on CloudFront/Cloudflare sites; the
   same URL loads fine in a headed browser). Retry with a headful UA — and tell the user you did:
   ```bash
   --user-agent 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
   ```
   Never work around the abort by auditing the error page — a blocked page has no focusable
   elements, so it reads as a keyboard trap and a landmark-less page, and every finding you'd
   write from it would be fiction.

   To test a page that requires login, pass `--storage-state <file>` with a saved Playwright
   storageState JSON (cookies + localStorage from an already-authenticated session). It's applied
   once when the session's browser launches, and the state stays alive for every `step` after that
   — no need to re-authenticate mid-session. A missing or invalid file fails immediately rather
   than silently testing the logged-out page.

2. **Observe / step.** Each `step` performs ONE key and prints an observation: the focused
   element's accessible **name / role / states**, the **URL**, its **computed focus style**
   (`has_outline`/`has_shadow`), a **screenshot path**, and whether focus moved. When the
   screen-reader persona is active, it also includes `sr_announcement: { focus_announcement,
   live_announcements, new_phrases }` — what the emulated screen reader would say as a result of
   this keystroke.
   ```bash
   node scripts/runner.mjs observe <session-dir>              # current state, no keystroke
   node scripts/runner.mjs step <session-dir> --press Tab     # one key
   node scripts/runner.mjs step <session-dir> --press Enter
   node scripts/runner.mjs step <session-dir> --type "hello@example.com"   # type into focused field
   ```
   Allowed keys: `Tab Shift+Tab Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight Home End`.
   Read the screenshot with your Read tool when the AX name isn't enough to decide (e.g. which
   grid tile, is the focus ring actually visible against this background).

   **Reading `sr_announcement`:** `live_announcements` are entries that appeared **without** your
   keystroke being the direct cause of a focus-name change (e.g. you pressed Enter on a "Submit"
   button and a `polite:`-prefixed confirmation showed up) — that's strong evidence a status
   message IS reaching a screen reader (supports 4.1.3). If you take an action that visibly
   produces a confirmation/error on screen but no `live_announcements` entry appears, that's
   evidence the update is NOT announced — a real 4.1.3 problem worth writing up even beyond what
   the deterministic `sr-live-region-silent` check catches (that check only fires when NOTHING
   was ever announced all session; a region that fires for some updates but not others needs your
   judgment).

3. **Decide** from the observation, e.g.:
   - navigate: `step --press Tab` repeatedly *until* `focused.name` matches your target, then act.
   - operate a control: `Enter`/`Space` to activate; arrows for menus/tabs/selects/radios;
     `Escape` to close a menu/dialog (and check focus returns sensibly).
   - fill a form: re-read each field's label *before* typing — forms reorder when they reveal
     conditional fields; match value→label, don't assume field order.
   - confirm success by state, not assumption (e.g. a filter button flipping to `pressed:true`,
     a URL change, a heading receiving focus, a visible confirmation).

4. **Finish & stop:**
   ```bash
   node scripts/runner.mjs finish <session-dir>   # writes trace.json + deterministic-findings.json
   node scripts/runner.mjs stop <session-dir>     # closes the browser
   ```

## What the deterministic layer gives you (from `finish`)

`deterministic-findings.json` — machine-decidable checks, each with `url`, `locations` (landmark
+ nearest heading), `evidence` (step ids or, for screen-reader findings, page selectors —
see `evidence_kind`), `confidence`, `severity`, `conformance_level`, `persona`
(`keyboard`/`screen-reader`):

Keyboard persona (per focus stop visited):
- **2.4.7 (AA)** focus indicator PRESENT on each stop (presence only — 2.4.7 sets no size bar).
- **2.4.13 (AAA, informative)** focus-appearance strength (area + 3:1 contrast). Advisory only.
- **1.4.1** indicator not colour-only · **2.1.2** focus stalls (trap) · **2.4.1** skip link ·
  **2.4.3** positive tabindex · **3.2.1** context change on focus · **3.3.2** file input named only
  by the UA default ("Choose File", no author label) · **4.1.2** missing accessible name.

Screen-reader persona (from the page-wide census + live announcements):
- **1.1.1** images with no accessible name (missing alt/aria-label).
- **1.3.1** heading-level skips, and duplicate unlabeled landmark roles.
- **4.1.2** interactive controls whose whole announcement is a bare role (reading-order superset
  of the keyboard persona's Tab-reachable check — also catches arrow-key browse-mode-only
  controls).
- **4.1.2** broken ARIA ID reference — `aria-controls`/`aria-describedby`/`aria-details`/
  `aria-errormessage` pointing at an ID that resolves to no element.
- **4.1.2** keyboard-focusable control absent from the accessibility-tree census (cross-checks
  the keyboard persona's Tab-reachable trace against this page's census — almost always
  `aria-hidden="true"` combined with a focusable `tabindex`).
- **4.1.3** a declared live region (`aria-live`/`role=status|alert|log|alertdialog`) that never
  announced anything all session.
- **1.3.1** (batch mode, `cross-viewport-findings.json`, only when >1 viewport ran) a named
  interactive control present in one viewport's census but absent from another's for the same
  URL. Low confidence (0.4) — often intentional responsive design (e.g. a collapsed nav), treat
  as a lead to confirm rather than a settled finding.

`trace.json` — every step: keystroke, selector, AX name/role/state, computed focus style, region
locator, bounding box, focus-visible verdict, screenshot ref, and (screen-reader persona)
`sr_announcement`. `screen-reader-census.json` — a one-time-per-page structural dump: the full
reading-order sequence (`entries`, each `{spoken_phrase, role, tag, selector}`),
`declared_live_regions`, `declared_broken_aria_refs`, and `declared_alternate_reading_order`
(`aria-flowto` relationships — descriptive only, no deterministic check reads this, use it for
the reading-order judgment call below). Read this once per page for the judgment calls below —
it's the richest source for 2.4.6/1.3.2/label-quality/reading-order review.

## What YOU add (the AI-judgment findings)

Read the trace + screenshots and write findings the scanners can't, using the SAME shape:
- **Task completion** — could the persona finish the task keyboard-only, and exactly where does
  it break? (unreachable control, focus not managed into a revealed panel/dialog, no perceivable
  confirmation, a step that needs the mouse).
- **Logical focus order** vs the *visual* layout (deterministic 2.4.3 only flags positive
  tabindex; you judge whether the sequence makes sense).
- **Focus-indicator perceivability** against the actual background (the pixel check says present;
  you judge distinguishable).
- **Custom-widget keyboard contract** (menu/tablist/combobox arrows, `Escape` closes dialog,
  `Enter`/`Space` on custom buttons; does it match its apparent role?).
- **Form quality** — meaningful labels, validation errors move/announce focus, success reachable.
- **Reading order vs visual order** (screen-reader persona) — compare
  `screen-reader-census.json`'s `entries` sequence against the visual layout, and check
  `declared_alternate_reading_order` for any `aria-flowto` path the visual layout doesn't match;
  the deterministic layer never judges this, only DOM order (2.4.3).
- **Announcement quality** (screen-reader persona) — is a name/label present but *unhelpful*
  ("button", "link", generic icon-only controls with a technically-non-empty but meaningless
  name)? Deterministic checks only catch a fully bare role, not a bad one.
- **Live-region behavior beyond "ever fired"** — does *every* dynamic update you'd expect to be
  announced actually show up in a step's `live_announcements`, not just at least one all session
  (see the `sr_announcement` guidance above)?

Every finding MUST: reference the evidence (step id(s), or a page selector for screen-reader
census-sourced findings), carry a confidence score, map to a specific WCAG SC, name the page
**URL**, and state persona impact in plain language ("a keyboard user cannot …" / "a screen-reader
user hears …"). Merge your findings with the deterministic ones into one report. Be honest about
uncertainty and verify before asserting — prefer confirming a suspected issue against the
computed style / a screenshot / the census over guessing.

## Personas

- **Ade** — keyboard-only, sighted, may use speech-recognition and tire quickly
  (<https://www.w3.org/WAI/people-use-web/user-stories/story-one/>). This is why accessible names
  (voice control), visible focus, logical order, and skip links matter.
- **Lakshmi** — blind, uses a screen reader on desktop and mobile
  (<https://www.w3.org/WAI/people-use-web/user-stories/story-three/>). This is why accessible
  names/descriptions, heading/landmark structure, reading order, and live-region announcements
  matter. The screen-reader checks here **emulate** what a spec-compliant screen reader would
  announce (via `@guidepup/virtual-screen-reader`'s ARIA/ACCNAME-tree computation) — they augment
  but do not replace testing with a real screen reader and real users.

Judge success from whichever persona's checks you're reviewing.

## CAPTCHAs

CAPTCHAs detect automation (`navigator.webdriver`) and refuse to run. The runner automatically
suppresses that one signal **only on a page where a CAPTCHA is present** (page-scoped,
human-approved) and reloads so the CAPTCHA can run and be tested — every other page keeps the
honest signal. A reCAPTCHA image grid IS keyboard-operable (tab into tiles, `Space` to select,
Verify) but is often not focus-managed on appearance and is fatiguing — report that, and note
that fully passing an enterprise CAPTCHA from automation is unreliable by design.

## Quick whole-page scan (no task)

For a fast, unattended pass over the start page instead of a driven task:
```bash
node scripts/runner.mjs --url <https://site>                # blind Tab-crawl, per viewport
```
`--persona` applies here too (default `all`); the blind crawl never presses Enter/Space, so
live-region findings from this mode only tell you a region *never* fired passively, not whether
it fires correctly on activation — use a driven `serve` session for that.

## Reference

`references/architecture.md` (driver / runtime / interaction model / output contract).
Do both viewports (desktop + mobile); behaviour differs — nav often collapses behind a
disclosure/hamburger on mobile.
