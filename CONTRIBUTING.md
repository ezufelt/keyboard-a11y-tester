# Contributing

Thanks for considering a contribution. This is a small, single-maintainer project — issues
and PRs are welcome, but please open an issue before large changes so we can agree on
approach first.

## Setup

```bash
npm install
npx playwright install chromium
node scripts/setup-check.mjs   # verify deps + a working Chromium
```

## Before opening a PR

There is no automated test suite yet — verification is manual:

- `node --check scripts/runner.mjs` — syntax sanity check.
- Run the runner against a real or local test page in each `--persona` mode
  (`keyboard`, `screen-reader`, `all`) and inspect `trace.json` /
  `deterministic-findings.json` / `screen-reader-census.json` for the change you made.
- If you touched the live `serve`/`step`/`finish` flow, exercise it directly rather than
  only the batch crawl — they share code but have different session-persistence paths.

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
