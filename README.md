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

**Documentation:** [`docs/usage.md`](docs/usage.md) (setup, dependencies, quick start,
CAPTCHAs) · [`docs/interface.md`](docs/interface.md) (full CLI reference, output file
schema, WCAG checks table).

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

Requires **Node.js ≥ 20** and Chromium (via Playwright), plus five small npm dependencies —
no build step. Run `node scripts/setup-check.mjs` to verify both before your first run.

See [`docs/usage.md`](docs/usage.md#requirements--dependencies) for the full dependency
table, licensing credit for `@guidepup/virtual-screen-reader`, and setup instructions.

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

See [`docs/usage.md`](docs/usage.md#run-against-any-url-no-test-file-needed) for the full
quick-start walkthrough, and [`docs/interface.md`](docs/interface.md) for every CLI flag and
the complete output file schema.

### Authenticated runs

Pages behind a login can't be tested with a fresh, logged-out browser. Pass a Playwright
`storageState` JSON file with `--storage-state <file>` to start the browser with its cookies
and localStorage already loaded (e.g. an already-logged-in session). Generate one with
`context.storageState({ path: 'auth.json' })` or `npx playwright codegen --save-storage=auth.json <url>`.
The file is validated (exists, parses as JSON, and looks like a real storageState export —
i.e. has `cookies`/`origins` arrays) before the browser launches — a missing or malformed file
fails the run immediately rather than silently testing the logged-out site. In `serve` mode
it's applied once at launch and the session browser keeps the state alive for every subsequent
`step`.

**A storageState file holds live session cookies/tokens — treat it as a secret.** Don't commit
it; `.gitignore` already excludes `auth.json`, `storageState.json`, and `*storage-state*.json`,
but a differently-named file won't be caught automatically.

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
| 2.4.7 | AA | keyboard | Focus indicator present |
| 2.4.13 | AAA (informative) | keyboard | Focus indicator strength |
| 1.4.1 | AA | keyboard | Indicator is not colour-only |
| 2.1.2 | AA | keyboard | Keyboard trap |
| 2.4.1 | AA | keyboard | No skip link |
| 2.4.3 | AA | keyboard | Positive `tabindex` |
| 3.2.1 | AA | keyboard | Context change from focus alone |
| 3.3.2 | AA | keyboard | File input named only by the user-agent default ("Choose File") |
| 4.1.2 | AA | keyboard | Focusable control with no accessible name |
| 1.1.1 | AA | screen-reader | Missing alt text/aria-label |
| 1.3.1 | AA | screen-reader | Heading level skip |
| 1.3.1 | AA | screen-reader | Duplicate, unlabeled landmark roles |
| 4.1.2 | AA | screen-reader | Interactive control announced as a bare role |
| 4.1.3 | AA | screen-reader | Declared live region that never announced anything |

See [`docs/interface.md`](docs/interface.md#wcag-checks) for the authoritative version of
this table (full check descriptions) and the W3C persona references.

## Output

Everything is written under a per-user temp dir (`${TMPDIR}/keyboard-a11y-tester/…`, or
`--out`): a `trace.json` (per-step evidence), `deterministic-findings.json` (WCAG findings),
`screen-reader-census.json` (screen-reader persona), and cropped `screenshots/step_NNNN.png`
per viewport. See [`docs/interface.md`](docs/interface.md#output-file-schema) for the
complete directory layout and field-by-field schema of every output file.

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
If the focused element's own box shows no indicator, the same diff is also tried against up
to 3 bounded ancestor boxes (`ancestor_boxes` in the trace) — this catches a common
custom-field pattern where the indicator is a border/shadow on a `:focus-within`-styled
wrapper, not the control itself. If that also finds nothing, a small fixed-radius search
around the element looks for an indicator with no DOM relationship to it at all — a sibling
or portaled overlay repositioned by JS on focus (`indicator: "detached"` in the trace). This
search is still bounded, not full-frame, so it won't pick up unrelated changes elsewhere on
the page.

**Strength (AAA, informative)** measures whether the indicator meets 2.4.13 Focus
Appearance — changed area ≥ a 2px-thick perimeter of the control, and ≥ 3:1 WCAG luminance
contrast between focused and unfocused states. Advisory only. When a ring/edge cue is
present, this measurement is restricted to the perimeter band around the control (excluding
its own interior), so a reveal/reposition-style indicator (e.g. an off-canvas skip link that
jumps on-screen on `:focus`) isn't corrupted by whatever unrelated content normally renders
at that spot once focus moves on. (This measure is still unreliable on pages that mutate
between steps in some other way — e.g. "load more" — because the neighbour-frame baseline
then differs by content beyond just the focus ring; treat AAA numbers on such pages with
caution. AA presence is unaffected, being driven by the computed style.)

So 2.4.7 (AA) requires only that an indicator is *visible* with no size/contrast minimum: a
faint 1px or low-opacity ring passes AA and is flagged *weak* at AAA — rather than being
falsely reported as "no focus indicator."

**Iframes:** if focus lands inside an `<iframe>` (same-origin or cross-origin — e.g. an
embedded video player), the runner resolves the real focused control inside it via
Playwright's frame API rather than stopping at the outer `<iframe>` element, so each inner
control is tracked and checked distinctly (selector `"<outer selector> >>> <inner selector>"`).
Its accessible name is a best-effort DOM heuristic (`name_source: "heuristic"` in the
trace), not the ground-truth accessibility tree, since that isn't reachable across a
cross-origin frame's own target.

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

CAPTCHAs detect automation and refuse to run; the runner has a page-scoped, human-approved
compatibility workaround. See [`docs/usage.md`](docs/usage.md#captchas) for details.

## License

MIT © Everett Zufelt. See `LICENSE`.
