# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Fixed
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` descriptions still
  described a keyboard-only-only tool after the 0.2.0 screen-reader persona work; only their
  version numbers had been bumped. Both now mention the screen-reader persona, matching
  `package.json`.

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

[Unreleased]: https://github.com/ezufelt/keyboard-a11y-tester/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ezufelt/keyboard-a11y-tester/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ezufelt/keyboard-a11y-tester/releases/tag/v0.1.0
