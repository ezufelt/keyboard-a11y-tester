# Contributing

Thanks for considering a contribution. This is a small, single-maintainer project.

- **Bugs and feature requests**: file a [GitHub issue](https://github.com/ezufelt/keyboard-a11y-tester/issues).
  Include repro steps (or the site/scenario that triggered it) and, for bugs, the relevant
  `trace.json`/`deterministic-findings.json` excerpt if you have one.
- **Changes**: all changes land via pull request against `main` — please open an issue
  before large changes so we can agree on approach first.

## Coding standards

- **ES modules only** — the package is `"type": "module"`; use `import`/`export`, not `require`.
- **No build step** — `scripts/runner.mjs` and friends are plain `.mjs`, executed directly by
  Node. Don't introduce a bundler/transpiler.
- **Node.js ≥ 20** (see `engines` in `package.json`).

## Setup

```bash
npm install
npx playwright install chromium
node scripts/setup-check.mjs   # verify deps + a working Chromium
```

## Required before opening a PR

Run these and confirm they pass — CI re-runs the same checks, but catching problems locally
first saves a round trip:

```bash
node scripts/setup-check.mjs   # confirm deps_installed and browser_available are both true
npm run lint                   # eslint
npm test                       # runs the functional suite in test/ via @playwright/test
```

`test/` drives `scripts/runner.mjs` as a black-box CLI (spawned as a child process) against
local HTML fixtures in `test/fixtures/` — it doesn't use Playwright's own `page` fixture,
since the runner launches and drives its own Chromium instance per invocation:

- `test/defects.spec.js` — seeded-defect fixtures (missing alt, heading skip, no focus
  indicator, keyboard trap, silent live region) assert the expected finding fires, plus a
  `clean.html` fixture that must produce zero AA findings (the false-positive guard).
- `test/persona-parity.spec.js` — `--persona keyboard`/`screen-reader`/`all` behave as
  documented (no cross-contamination of artifacts between personas).
- `test/live-session.spec.js` — the `serve`/`observe`/`step`/`finish`/`stop` round trip,
  since that's a different code path than the batch crawl.
- `test/contract.spec.js` — `trace.json`/`deterministic-findings.json` keep their
  documented shape.
- `test/storage-state.spec.js` — `--storage-state` actually seeds the browser context,
  both via localStorage and via a cookie inspected server-side (real logins are usually
  httpOnly cookies), using fixtures served over a local HTTP origin since Chromium rejects
  storageState's localStorage injection for `file://` pages. Covers both batch and `serve`
  mode, and fails fast on a missing, invalid-JSON, or wrong-shape file.

If you add a new deterministic check or a new fixture defect, add or extend a fixture in
`test/fixtures/` and a corresponding assertion rather than only verifying manually. If you
touched something not exercised above (e.g. CAPTCHA compat), still verify manually and say
so in the PR description — the suite doesn't cover everything yet.

A new WCAG check touches docs in three places, not one — update all of them in the same PR:
the short table in `README.md`, the full-detail table in `docs/interface.md` (the
authoritative version), and the persona summary in `SKILL.md`. Also add an entry under
`[Unreleased]` in `CHANGELOG.md`.

CI runs `setup-check.mjs`, the linter, and this suite on every PR (`.github/workflows/test.yml`).

## Design constraints to respect

- **Keyboard-only, never a pointer.** The runner must never call `.click()`/`.focus()`; if
  a control is only reachable by pointer, that's a finding, not something to route around.
- **No synthetic key/event dispatch.** Always drive real `page.keyboard` input (or, for the
  screen-reader persona, read what the injected `@guidepup/virtual-screen-reader` observes)
  — never `dispatchEvent(new KeyboardEvent(...))`.
- **Minimal dependencies.** The tool is intentionally portable (any OS, no build step, plain
  `.mjs`). A new runtime dependency needs a real justification, not convenience.
- **The I/O contract is stable.** `trace.json` / `deterministic-findings.json` /
  `screen-reader-census.json` are read by the invoking agent (see `SKILL.md`). Extend these
  shapes additively; don't rename or remove existing fields without a good reason and a
  README/SKILL.md update alongside it.
- **Deterministic vs. AI-judgment split.** The runner (`scripts/runner.mjs`) only emits
  checks that are machine-decidable from the trace/census. Anything requiring visual or
  semantic judgment (task completion, logical order vs. layout, label quality) belongs in
  the agent-facing guidance in `SKILL.md`, not hardcoded here. See
  `references/architecture.md` for the current split.

## Where things live

- `scripts/runner.mjs` — the deterministic runner (CLI, Playwright/CDP driving, checks).
- `scripts/setup-check.mjs` — preflight dependency/browser check.
- `SKILL.md` — instructions for the agent driving this as a Claude Code skill.
- `references/architecture.md` — how the runner is built, for anyone extending it.
- `test-cases/TEMPLATE.test.yaml` — optional saved-scenario format.

## License

By contributing, you agree your contributions are licensed under this project's
[MIT License](LICENSE).
