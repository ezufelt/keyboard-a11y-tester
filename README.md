# keyboard-a11y-tester

An AI-assisted, **keyboard-only** web accessibility tester. It behaves like a person using
only the keyboard, records what happens at every focus stop, and emits evidence-linked
findings mapped to specific WCAG success criteria — against **any** website.

It has two layers:
- a **deterministic runner** (`scripts/runner.mjs`) that owns the mechanical, reproducible
  work — driving the page keyboard-only, capturing a per-step trace + screenshots, and
  computing the machine-decidable checks;
- an **AI-judgment layer** — the invoking agent — that reads the trace/screenshots and
  judges what rules can't (task completion, logical focus order, form quality). See
  `SKILL.md` for how an agent drives it.

Standalone and portable: it depends only on `playwright`, `yaml`, `pngjs`, and
`pixelmatch`, needs no bundled test cases, and writes all output to a per-user **temp
directory** (never into this folder).

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

There are **no runtime dependencies beyond these four** and no build step — the runner is
plain `.mjs` executed directly by Node. Run `node scripts/setup-check.mjs` to verify both the
npm deps and a working Chromium before your first run.

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
`--max-steps <n>` (blind crawl), `--port <n>` (session). Keys:
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
(every focus-indicator check would otherwise be invalid).

Checks are evaluated **per focus stop the persona actually visits** — this is *scenario*
testing, not an exhaustive page audit. Conformance target: **AA is pass/fail, AAA is
informative.**

| WCAG | Level | Check |
|------|-------|-------|
| 2.4.7 | AA | Focus indicator **present** — a declared `outline`/`box-shadow` in the computed style, or a pixel change on focus. (2.4.7 sets no size/contrast bar.) |
| 2.4.13 | AAA (informative) | Focus indicator **strength** — changed area ≥ a 2px-thick perimeter **and** ≥ 3:1 focused/unfocused contrast. Advisory, never a fail. |
| 1.4.1 | AA | Indicator is not colour-only (a shape cue exists) |
| 2.1.2 | AA | Keyboard trap — focus stalls for several consecutive Tabs |
| 2.4.1 | AA | No skip link near the top of the tab order |
| 2.4.3 | AA | Positive `tabindex` (logical/visual order is an AI check) |
| 3.2.1 | AA | Context change (navigation) from focus alone |
| 4.1.2 | AA | Focusable control with no accessible name (blocks speech control) |

The scenario-level verdicts — "was every control *needed to complete the goal* reachable"
(2.1.1) and "no trap *on the path*" (full 2.1.2) — need the AI-driven goal path, so the
agent produces them from the trace. The 2.4.1 / 4.1.2 checks directly support the W3C
keyboard+speech persona ("Ade", <https://www.w3.org/WAI/people-use-web/user-stories/story-one/>).

## Output

Everything is written under a per-user temp dir (`${TMPDIR}/keyboard-a11y-tester/…`, or
`--out`):

```
<out>/<site-or-case-id>/
  <viewport>/
    trace.json                    # per-step evidence: keystroke, selector, AX name/role/state, focus style, bbox, focus_visible, screenshot ref
    deterministic-findings.json   # findings: wcag, conformance_level, confidence, severity, url, locations, evidence[]
    screenshots/step_NNNN.png     # focused-region crop (inflated to include the focus ring)
```

Every finding references the evidence step(s), carries a confidence score and severity,
names the page URL, and maps to a specific WCAG success criterion.

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

## CAPTCHAs

CAPTCHAs detect automation (`navigator.webdriver`) and refuse to run. The runner
automatically suppresses that one signal **only on a page where a CAPTCHA is present**
(page-scoped) and reloads so the CAPTCHA can initialize and be tested; every other page
keeps the honest signal. Fully passing an enterprise CAPTCHA from automation is unreliable
by design.

## License

MIT © Everett Zufelt. See `LICENSE`.
