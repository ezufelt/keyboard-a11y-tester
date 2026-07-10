# keyboard-a11y-tester

An AI-assisted web accessibility tester that behaves like two W3C personas at once: a
**keyboard-only** user ("Ade") and a **screen-reader** user ("Lakshmi"). It drives a page
keyboard-only, records what happens at every focus stop, and emits evidence-linked
findings mapped to specific WCAG success criteria — against **any** website. Both
personas run in the same pass by default; a `--persona` flag restricts to just one.

It has two layers:
- a **deterministic runner** (`scripts/runner.mjs`) that owns the mechanical, reproducible
  work — driving the page keyboard-only, capturing a per-step trace + screenshots, and
  computing the machine-decidable checks for both personas;
- an **AI-judgment layer** — the invoking agent — that reads the trace/screenshots/census
  and judges what rules can't (task completion, logical focus/reading order, form
  quality, announcement quality). See `SKILL.md` for how an agent drives it.

Standalone and portable: it depends only on `playwright`, `yaml`, `pngjs`, `pixelmatch`,
and `@guidepup/virtual-screen-reader`, needs no bundled test cases, and writes all output
to a per-user **temp directory** (never into this folder). The screen-reader persona
never drives a real screen reader (NVDA/VoiceOver) — see "Screen-reader detection" below.

## Quick start

**As a Claude Code plugin** — register this repo as a plugin marketplace, then install it:

```
/plugin marketplace add ezufelt/keyboard-a11y-tester
/plugin install keyboard-a11y-tester@ezufelt
```

The first command registers this repo as a marketplace (named `ezufelt`, per
`.claude-plugin/marketplace.json`); the second installs the plugin. Once installed, the
skill in `SKILL.md` becomes available to the agent.

**As a standalone clone** — clone the repo and install its dependencies:

```bash
git clone https://github.com/ezufelt/keyboard-a11y-tester.git
cd keyboard-a11y-tester
npm install
npx playwright install chromium
```

Then drive it directly (see [Run against any URL](#run-against-any-url-no-test-file-needed)).

## Requirements & dependencies

**Runtime:**
- **Node.js ≥ 18** (declared in `package.json` `engines`; ES modules — the package is `"type": "module"`)
- **Chromium** — installed via Playwright (`npx playwright install chromium`), not bundled

**npm dependencies** (installed by `npm install`):

| Package | Version | Why |
|---------|---------|-----|
| `playwright` | ^1.48.0 | Drives full Chromium keyboard-only and reads the CDP accessibility tree |
| `pngjs` | ^7.0.0 | Decodes the per-step screenshots for pixel comparison |
| `pixelmatch` | ^7.2.0 | Diffs focused vs. baseline frames to detect focus-indicator pixel changes |
| `yaml` | ^2.5.0 | Parses saved scenario `*.test.yaml` files |
| `@guidepup/virtual-screen-reader` | ^0.32.1 | Builds an ARIA/ACCNAME accessibility tree over the live page and emulates screen-reader announcements + live-region monitoring, for the screen-reader persona |

There are **no runtime dependencies beyond these five** and no build step — the runner is
plain `.mjs` executed directly by Node (the screen-reader library ships a pre-bundled
browser ESM file, so no bundler was added). Run `node scripts/setup-check.mjs` to verify
both the npm deps and a working Chromium before your first run.

This project builds on [Guidepup](https://github.com/guidepup)'s
[`@guidepup/virtual-screen-reader`](https://github.com/guidepup/virtual-screen-reader)
(MIT license) for the screen-reader persona's accessible-name/role computation and
live-region monitoring — credit to Craig Morten and the Guidepup project. See
"Screen-reader detection (Lakshmi)" below for how it's used and its limitations.

## Setup

```bash
node scripts/setup-check.mjs          # reports what's installed (deps + Chromium)
npm install                           # if deps are missing
npx playwright install chromium       # if the browser is missing
```

`setup-check.mjs` prints JSON (`deps_installed`, `browser_available`) and actually launches
Chromium to verify real access. When run as a skill, the agent runs this first and **asks
before installing** anything that's missing.

## Run against any URL (no test file needed)

```bash
# quick unattended blind Tab-crawl of the start page, per viewport
node scripts/runner.mjs --url https://example.com

# a full scenario, driven live by the agent one keystroke at a time
node scripts/runner.mjs serve --url https://example.com --goal "find the pricing page" \
     --viewport desktop --port 9400
#   → prints:  READY <session-dir>   (under the system temp dir)
node scripts/runner.mjs observe <session-dir>
node scripts/runner.mjs step    <session-dir> --press Tab      # one keystroke; prints observation
node scripts/runner.mjs step    <session-dir> --press Enter
node scripts/runner.mjs step    <session-dir> --type "hello@example.com"
node scripts/runner.mjs finish  <session-dir>                  # writes trace + findings
node scripts/runner.mjs stop    <session-dir>
```

Options: `--out <dir>` (override the temp output root), `--viewport desktop|mobile`,
`--max-steps <n>` (blind crawl), `--port <n>` (session), `--persona keyboard|screen-reader|all`
(default `all` — both personas in one pass). Keys:
`Tab Shift+Tab Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight Home End`; text is
entered with `--type` (real keyboard typing, never `.fill()`). Run each viewport separately.

**The live loop is agentic, not scripted:** each `step` prints an observation (focused
accessible name/role/state, URL, computed focus style, screenshot path); the agent reads it
and decides the next keystroke. Never drive a counted sequence of Tabs — tab **until** the
focused control matches by name/role. State persists in the browser across `step` calls.

Optional: instead of `--url` you can pass a saved scenario file (see
`test-cases/TEMPLATE.test.yaml`).

## What the runner does (deterministic layer)

Playwright (full Chromium, new-headless + SwiftShader for real pixels) drives the page with
**only** the keyboard — it never calls `.click()` or `.focus()`; if a control is only
reachable by pointer, that is itself a finding. It drops to a raw CDP session for the
accessibility tree (`Accessibility.getPartialAXTree`), the ground truth for name/role/state.
At startup it **fails fast** if `:focus-visible` does not fire on CDP-driven key events
(every focus-indicator check would otherwise be invalid) — skipped entirely when
`--persona screen-reader` is passed, since that persona has no pixel/focus-ring work.

Checks are evaluated **per focus stop the persona actually visits** (keyboard persona) or
against a page-wide structural census (screen-reader persona) — this is *scenario*
testing, not an exhaustive page audit. Conformance target: **AA is pass/fail, AAA is
informative.**

| WCAG | Level | Persona | Check |
|------|-------|---------|-------|
| 2.4.7 | AA | keyboard | Focus indicator **present** — a declared `outline`/`box-shadow` in the computed style, or a pixel change on focus. (2.4.7 sets no size/contrast bar.) |
| 2.4.13 | AAA (informative) | keyboard | Focus indicator **strength** — changed area ≥ a 2px-thick perimeter **and** ≥ 3:1 focused/unfocused contrast. Advisory, never a fail. |
| 1.4.1 | AA | keyboard | Indicator is not colour-only (a shape cue exists) |
| 2.1.2 | AA | keyboard | Keyboard trap — focus stalls for several consecutive Tabs |
| 2.4.1 | AA | keyboard | No skip link near the top of the tab order |
| 2.4.3 | AA | keyboard | Positive `tabindex` (logical/visual order is an AI check) |
| 3.2.1 | AA | keyboard | Context change (navigation) from focus alone |
| 3.3.2 | AA | keyboard | File input named only by the user-agent default ("Choose File") — the control has an ACCNAME so 4.1.2 stays quiet, but no author label conveys the field's purpose |
| 4.1.2 | AA | keyboard | Focusable control with no accessible name (blocks speech control) |
| 1.1.1 | AA | screen-reader | Image/graphic with no accessible name (missing alt text/aria-label) |
| 1.3.1 | AA | screen-reader | Heading level skip (jumps past one or more levels) |
| 1.3.1 | AA | screen-reader | Duplicate, unlabeled landmark roles (can't be told apart by role alone) |
| 4.1.2 | AA | screen-reader | Interactive control whose whole announcement is a bare role — reading-order superset of the keyboard-persona 4.1.2 check, also catches arrow-key browse-mode-only controls |
| 4.1.3 | AA | screen-reader | A declared live region (`aria-live`/`role=status\|alert\|log\|alertdialog`) that never announced anything all session |

The scenario-level verdicts — "was every control *needed to complete the goal* reachable"
(2.1.1) and "no trap *on the path*" (full 2.1.2) — need the AI-driven goal path, so the
agent produces them from the trace. The 2.4.1 / 4.1.2 keyboard-persona checks directly
support the W3C keyboard+speech persona ("Ade",
<https://www.w3.org/WAI/people-use-web/user-stories/story-one/>); the screen-reader-persona
checks support the W3C blind/screen-reader persona ("Lakshmi",
<https://www.w3.org/WAI/people-use-web/user-stories/story-three/>).

## Output

Everything is written under a per-user temp dir (`${TMPDIR}/keyboard-a11y-tester/…`, or
`--out`):

```
<out>/<site-or-case-id>/
  <viewport>/
    trace.json                    # per-step evidence: keystroke, selector, AX name/role/state, focus style, bbox, focus_visible, sr_announcement, screenshot ref
    deterministic-findings.json   # findings: wcag, persona, evidence_kind, conformance_level, confidence, severity, url, locations, evidence[]
    screen-reader-census.json     # (screen-reader persona) reading-order entries + declared live regions, per page URL visited
    screenshots/step_NNNN.png     # focused-region crop (inflated to include the focus ring); keyboard persona only
```

Every finding references its evidence (a step id, or — for screen-reader census-sourced
findings — a page selector), carries a confidence score and severity, names the page URL,
and maps to a specific WCAG success criterion.

## Focus-visible detection (2.4.7 AA presence + 2.4.13 AAA strength)

**Presence (AA)** uses two independent signals, so a faint-but-real indicator is never
missed:
1. the focused element's **computed style** declares an `outline` or `box-shadow` (ground
   truth — recorded in the trace as `computed_focus_style`), or
2. **pixels change** on focus (catches background/colour indicators with no outline).

Either one means the indicator is present → AA pass. Pixel diffing compares the focused
frame to a scroll-aligned baseline (the next step's frame, where the element is no longer
focused — so focus is never manipulated programmatically), measuring ring slices at
increasing offset (thin *and* offset outlines), the interior, and top/bottom edge bands.

**Strength (AAA, informative)** measures whether the indicator meets 2.4.13 Focus
Appearance — changed area ≥ a 2px-thick perimeter of the control, and ≥ 3:1 WCAG luminance
contrast between focused and unfocused states. Advisory only. (This measure is unreliable
on pages that mutate between steps — e.g. "load more" — because the neighbour-frame
baseline then differs by content, not just the focus ring; treat AAA numbers on such pages
with caution. AA presence is unaffected, being driven by the computed style.)

So 2.4.7 (AA) requires only that an indicator is *visible* with no size/contrast minimum: a
faint 1px or low-opacity ring passes AA and is flagged *weak* at AAA — rather than being
falsely reported as "no focus indicator."

## Screen-reader detection (Lakshmi)

The screen-reader persona is emulated, never driven for real: `@guidepup/virtual-screen-reader`
builds an ARIA/ACCNAME-spec accessible tree over the live page and computes what a
spec-compliant screen reader would announce, entirely in the browser's own JS engine — no
NVDA/JAWS/VoiceOver is launched, and it works the same way on any OS the runner itself
supports.

Its self-contained browser bundle is injected via Playwright's `context.addInitScript`,
which is not subject to the page's own CSP — verified against both a synthetic CSP-locked
page and a real CSP-locked production site. Once injected, its virtual cursor **tracks
real keyboard focus automatically** (it listens for native `focusin` events), so every
`step` you drive with real `Tab`/`Enter`/etc. produces a matching `sr_announcement` with no
separate "chasing" logic and no drift between what's focused and what's reported as
announced. The same mechanism also wires a `MutationObserver` that computes WAI-ARIA
live-region semantics and captures `"assertive: …"`/`"polite: …"` announcements as they
happen — this is what `4.1.3` (Status Messages) findings are derived from.

Separately, once per newly-visited page URL, an ephemeral instance walks the *entire* page
in reading order (never touching the live per-step monitor) to build
`screen-reader-census.json` — the source for the heading-hierarchy, duplicate-landmark,
missing-alt-text, and bare-role-control checks, since those need whole-page context rather
than just the stops a keyboard user's Tab order happens to visit.

**This augments but does not replace testing with a real screen reader and real users** —
the upstream library's own README says exactly that, and it's worth repeating: this checks
what a *spec-compliant* screen reader should announce given the page's ARIA/HTML, not the
specific quirks of any one real screen reader implementation.

## CAPTCHAs

CAPTCHAs detect automation (`navigator.webdriver`) and refuse to run. The runner
automatically suppresses that one signal **only on a page where a CAPTCHA is present**
(page-scoped) and reloads so the CAPTCHA can initialize and be tested; every other page
keeps the honest signal. Fully passing an enterprise CAPTCHA from automation is unreliable
by design.

## License

MIT © Everett Zufelt. See `LICENSE`.
