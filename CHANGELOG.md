# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `test/property.spec.js`: property-based tests (new `fast-check` devDependency) for
  `severityFor`, `makeFinding`, `validatePersona`, `resolveStorageState`, `parseArgs`,
  `pickViewport`, and `relLum`.
- `scripts/lib/cli-helpers.mjs` and `scripts/lib/color.mjs`: the pure, side-effect-free
  functions above, extracted from `runner.mjs` so they can be imported directly by tests —
  `runner.mjs` calls `main()` unconditionally at module scope (no `import.meta.url` guard),
  so importing it directly triggers a live CLI run.

### Fixed
- `severityFor` used a plain object literal as a lookup map, so a WCAG value colliding with
  an inherited `Object.prototype` member name (e.g. `"valueOf"`, `"toString"`,
  `"constructor"`) returned that inherited function instead of falling back to `'moderate'`.
  Not reachable today (WCAG values are always internal constants), but caught by a fast-check
  property test and corrected with `Object.hasOwn()`.
- `--max-steps` with a non-positive-integer value (a typo, or `0`/negative) used to parse to
  `NaN` or a non-positive number and propagate silently: the crawl loop
  (`for (let i = 1; i <= maxSteps; i++)`) never executes when `maxSteps` is `NaN` or `<= 0`,
  so the run silently did zero steps and exited as if it had passed. Now validated in
  `parseArgs` and rejected with a one-line error (exit 1).
- `validatePersona`, `resolveStorageState`, `parseArgs`, and `pickViewport` called
  `process.exit(1)` directly on invalid input, making them impossible to unit-test in-process
  (a fuzzed invalid input would kill the test worker). They now throw a plain `Error`, caught
  at every CLI call site to preserve the exact prior behavior (one-line message, exit 1, no
  stack trace).

### Changed
- Local (non-CI) Playwright worker count now scales to `os.cpus().length` (capped at 8)
  instead of a fixed `4` — roughly halves local full-suite wall-clock time on multi-core
  machines (~90s → ~48s measured on an 8-core machine). CI stays pinned at `2` workers.

## [0.5.0] - 2026-07-10

### Added
- `docs/usage.md` and `docs/interface.md` — usage guide and full CLI/output-schema reference,
  split out of README.md.
- `CHANGELOG.md` (this file).
- ESLint (flat config) and a `npm run lint` script.
- CI now also runs `scripts/setup-check.mjs` and the linter, in addition to the functional
  test suite.
- New deterministic check, **3.3.2 (AA, keyboard)**: flags a file input named only by the
  user-agent default ("Choose File") — the control has an ACCNAME so 4.1.2 stays quiet, but
  no author label conveys the field's purpose. Adds an additive `name_source` field (plus
  `input_type` on steps) captured from CDP's winning ACCNAME source.
- Focus-visible detection now follows focus into `<iframe>` content (same-origin or
  cross-origin, e.g. an embedded video player), resolving the real inner control via
  Playwright's frame API instead of stopping at the outer `<iframe>` element. Adds a
  `<outer selector> >>> <inner selector>` selector convention for iframe-crossed steps and a
  best-effort (non-ground-truth) `name_source: "heuristic"` for their accessible name, since
  the real CDP accessibility tree isn't reachable across a cross-origin frame's own target.
- `ancestor_boxes` (trace step field): up to 3 bounded ancestor boxes per focus stop, so the
  2.4.7/2.4.13 pixel-diff can also catch a focus indicator rendered on a wrapping
  `:focus-within` container rather than the focused element itself.
- When neither the focused element's own box nor any ancestor box shows an indicator, the
  2.4.7/2.4.13 pixel-diff now also searches a small bounded radius around the element for a
  connected region of changed pixels (`indicator: "detached"` in the trace). This catches an
  indicator with no DOM relationship to the control at all — a sibling or portaled overlay
  repositioned by JS on focus — which the ancestor-box walk above can't find, since it only
  ever looks up the DOM tree. Still bounded, not a full-frame diff, so unrelated changes
  elsewhere on the page aren't picked up.
- New deterministic check, **4.1.2 (AA, screen-reader)**: flags a broken ARIA ID reference —
  `aria-controls`/`aria-describedby`/`aria-details`/`aria-errormessage` whose value contains
  only ID(s) that resolve to no element. Adds an additive `declared_broken_aria_refs` field to
  `screen-reader-census.json`.
- New deterministic check, **4.1.2 (AA, screen-reader)**: flags a keyboard-focusable control
  that's entirely absent from the screen-reader census (almost always `aria-hidden="true"`
  paired with a focusable `tabindex`) by cross-referencing the keyboard persona's Tab-reachable
  trace against the census for the same page — the first check to correlate both personas'
  data for a single finding.
- `screen-reader-census.json` now also captures `declared_alternate_reading_order`
  (`aria-flowto` relationships) — descriptive only, additional evidence for the AI layer's
  reading-order-vs-visual-order judgment; no deterministic check reads it.
- New top-level output, **`cross-viewport-findings.json`** (batch mode, screen-reader persona,
  only when more than one viewport ran): compares each viewport's census against the others and
  flags a named interactive control present in one but entirely absent from another for the
  same URL, at low confidence (0.4) since this can reflect intentional responsive design.
- 1.4.1 (Use of Color) now resolves deterministically for a full-box `interior-only` fill (e.g.
  a card or large button that swaps its whole background colour on focus instead of drawing a
  ring) instead of always deferring to AI review: a new `color_safe` field on `focus_visible`
  reuses the existing focused/unfocused luminance-contrast measurement (the same >= 3:1 bar
  2.4.13 already uses) to tell a real lightness shift (colourblind-safe even with no ring/
  underline) apart from a near-isoluminant, colour-only change. Confidence raised from 0.3 to
  0.7 for this finding.

### Fixed
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` descriptions still
  described a keyboard-only-only tool after the 0.2.0 screen-reader persona work; only their
  version numbers had been bumped. Both now mention the screen-reader persona, matching
  `package.json`.
- 2.4.13 (Focus Appearance) false positive on indicators that reveal/reposition on focus
  (e.g. an off-canvas skip link that jumps on-screen on `:focus`): once focus moved on, the
  neighbour-frame baseline showed whatever unrelated content normally renders at that spot,
  and diffing against it corrupted the measured contrast. The area/contrast measurement now
  excludes the component's own interior when a ring/edge cue is present, isolating the actual
  indicator from that incidental content.
- 2.4.7 (Focus Visible) false positive when the indicator lives on a `:focus-within`
  container wrapping the control (a common custom-field pattern) rather than the control
  itself — the pixel-diff only ever looked at the focused element's own (padded) box, so it
  never saw the wrapper's border and reported "not visible". Falls back to the new
  `ancestor_boxes` when the element's own box shows no indicator.
- Focus tracked inside an `<iframe>` no longer gets misattributed to the unmoving `<iframe>`
  element itself for every control inside it — previously this both hid each inner control's
  own findings and read as a keyboard trap (2.1.2) to the "focus didn't move" heuristic.
- A full-box background-colour fill on focus (no ring/underline/outline) was misclassified as
  an `"edge"` shape cue: the top/bottom edge bands are subsets of the box, so a uniform fill
  changes them too, same as the interior. This both hid full-fill indicators from the 1.4.1
  Use-of-Color check entirely and corrupted their 2.4.13 contrast measurement (restricted to a
  thin perimeter band meant for genuine rings, instead of the real interior change) — a
  high-contrast fill could be misreported as a "weak" indicator. `edge` now only counts as a
  shape cue when the interior did *not* also change.

## [0.2.0]

### Added
- Screen-reader persona ("Lakshmi"): ARIA/ACCNAME-tree emulation via
  `@guidepup/virtual-screen-reader`, a page-wide structural census
  (`screen-reader-census.json`), and five new deterministic WCAG checks (missing alt text,
  heading-level skips, duplicate unlabeled landmarks, bare-role announcements, silent live
  regions).
- `--persona keyboard|screen-reader|all` flag to select which persona's checks run.
- Functional test suite (`@playwright/test`) covering seeded-defect fixtures, persona
  parity/contract behavior, the live `serve`/`observe`/`step`/`finish`/`stop` session round
  trip, and the `trace.json`/`deterministic-findings.json` output contract.
- CI workflow (`.github/workflows/test.yml`) running the suite on every push/PR.
- CAPTCHA compatibility: page-scoped, human-approved suppression of the automation signal
  only on pages where a CAPTCHA is actually present.
- Claude Code plugin packaging (`.claude-plugin/`) so the tool can be installed as a plugin
  skill, alongside standalone/CLI use.

## [0.1.0]

### Added
- Initial release: deterministic keyboard-only accessibility runner (`scripts/runner.mjs`).
- Full-Chromium, keyboard-only page driving via Playwright, with a raw CDP session for the
  accessibility tree (ground truth for name/role/state).
- Deterministic WCAG AA checks for the keyboard persona ("Ade"): focus-indicator presence
  (2.4.7), color-only indicators (1.4.1), keyboard traps (2.1.2), skip links (2.4.1),
  positive `tabindex` (2.4.3), context changes on focus (3.2.1), and missing accessible
  names (4.1.2) — plus an informative AAA focus-appearance strength check (2.4.13).
- Evidence-linked output: `trace.json` (per-step trace), `deterministic-findings.json`
  (WCAG findings), and cropped focus-region screenshots.
- `scripts/setup-check.mjs` preflight dependency/browser check.
- Saved-scenario support (`*.test.yaml`, see `test-cases/TEMPLATE.test.yaml`) alongside
  ad-hoc `--url` runs.

[Unreleased]: https://github.com/ezufelt/keyboard-a11y-tester/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ezufelt/keyboard-a11y-tester/compare/v0.2.0...v0.5.0
[0.2.0]: https://github.com/ezufelt/keyboard-a11y-tester/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ezufelt/keyboard-a11y-tester/releases/tag/v0.1.0
