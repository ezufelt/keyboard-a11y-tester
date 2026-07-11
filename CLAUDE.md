# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Keyboard-only + screen-reader web accessibility tester. Drives a real Chromium browser
keyboard-only and emits evidence-linked WCAG findings for two W3C personas simultaneously:
a keyboard-only user ("Ade") and a screen-reader user ("Lakshmi"). Ships primarily as a Claude
Code plugin/skill (see `SKILL.md`), and can also run standalone as a CLI.

The tool is two layers:
- A **deterministic runner** (`scripts/runner.mjs`) that drives the browser and computes the
  machine-decidable subset of WCAG checks.
- An **AI-judgment layer** — the invoking agent itself, per `SKILL.md` — which drives one keystroke
  at a time via `serve`/`observe`/`step`, reads each JSON observation, and adds findings that are
  not structurally computable (task completion, logical order, announcement quality), merging them
  with `deterministic-findings.json`.

Full architecture reference: `references/architecture.md`. Full output schema and the WCAG check
table: `docs/interface.md`. Usage: `docs/usage.md`.

## Commands

- Install deps + browser: `npm install && npx playwright install chromium` (or `npm run postinstall-browsers`)
- Lint: `npm run lint` (ESLint flat config, `eslint.config.js`)
- Run all tests: `npm test` (→ `playwright test`, using `@playwright/test` purely as a parallel
  runner/reporter — see Testing below)
- Run one test file: `npx playwright test test/defects.spec.js`
- Run one test by name: `npx playwright test -g "<test name>"`
- Verify local setup: `node scripts/setup-check.mjs`
- Run the tool directly: `node scripts/runner.mjs --url <url>` (batch blind Tab-crawl mode), or
  `node scripts/runner.mjs serve|observe|step|finish|stop` for a live agentic session
- No build/start script exists — there is no build step (see Architecture constraints below).

## Architecture

There is no `src/` directory. The entire tool is `scripts/runner.mjs`, dispatched by `main()`
on the first CLI arg to one of: `serve`, `observe`, `step`, `finish`, `stop`, or (no subcommand)
the default batch blind Tab-crawl requiring `--url` or a `*.test.yaml` path.

**Browser driving**: `chromium.launch()` (headless, SwiftShader for real pixel rendering), driven
only via real `page.keyboard.press()`/`.type()` — never `.click()`/`.focus()`, never synthetic
`dispatchEvent(KeyboardEvent)`. This is an intentional constraint (see CONTRIBUTING.md), not an
oversight — don't "fix" it. A raw CDP session (`context.newCDPSession(page)`) provides the
ground-truth accessibility tree via `Accessibility.getPartialAXTree`/`getFullAXTree`.

**Per-step capture**: after every keystroke, `recordStep()`/`captureFocused()` capture the active
element's selector, AX name/role/state, whether focus moved, bounding boxes, a cropped screenshot,
computed focus style, and (if the screen-reader persona is active) `sr_announcement`.

**Screen-reader emulation ("Lakshmi")**: `@guidepup/virtual-screen-reader` is not a real screen
reader — it computes an ARIA/accname tree and simulated announcements inside the page's own JS
engine. Its bundle is regex-extracted and re-injected as a classic-script IIFE via
`context.addInitScript` (CSP-safe). Two instances run per page load: a long-lived "monitor" whose
virtual cursor tracks real keyboard focus, and a one-time ephemeral "census" walk that builds the
structural census (`screen-reader-census.json`).

**Focus-indicator pixel detection**: screenshots are diffed with `pixelmatch`/`pngjs` to compute
`focus_visible` (2.4.7 AA presence) and `focus_appearance` (2.4.13 AAA strength) per step.

**Deterministic findings**: `deriveFindingsKeyboard()`, `deriveFindingsScreenReader()`,
`deriveAllFindings()`, `deriveCrossViewportFindings()` implement the machine-decidable WCAG checks
(keyboard persona: 2.1.2, 2.4.1, 2.4.3, 2.4.7, 2.4.13, 1.4.1, 3.2.1, 3.3.2, 4.1.2; screen-reader
persona: 1.1.1, 1.3.1, 4.1.2, 4.1.3). Full mapping in `docs/interface.md`.

**Output**: written per run to `${TMPDIR}/keyboard-a11y-tester/<site-or-case-id>/...`
(`trace.json`, `deterministic-findings.json`, `screen-reader-census.json`, `run-summary.json`,
`cross-viewport-findings.json`, `screenshots/step_NNNN.png`) — **never into the repo**.

**No build step**: deliberate (CONTRIBUTING.md: "Don't introduce a bundler/transpiler"). Plain
`.mjs` ES modules (`"type": "module"`), Node ≥20. `@guidepup/virtual-screen-reader`'s pre-bundled
browser ESM is consumed via runtime regex-extraction rather than a bundler.

## Testing

Tests spawn `scripts/runner.mjs` as a **black-box child process** against local HTML fixtures —
they do not use Playwright Test's own `page` fixture, since the runner launches its own Chromium
per invocation. Shared spawning/serving helpers live in `test/helpers.js` (fixtures are served over
local HTTP because Chromium rejects storageState localStorage injection for `file://`).

Test files in `test/`: `contract.spec.js` (output shape contract), `defects.spec.js` (seeded-defect
fixtures assert expected findings, plus a false-positive guard via `clean.html`),
`persona-parity.spec.js`, `cross-viewport.spec.js`, `live-session.spec.js` (`serve`/`observe`/
`step`/`finish`/`stop` round trip), `storage-state.spec.js` (auth seeding).

`playwright.config.js`: `testDir: './test'`, `fullyParallel: true`, `workers: 4` (2 in CI).
