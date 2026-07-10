# Usage

## Requirements & dependencies

**Runtime:**
- **Node.js ≥ 20** (declared in `package.json` `engines`; ES modules — the package is `"type": "module"`)
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
"Screen-reader detection (Lakshmi)" in the [README](../README.md) for how it's used and its
limitations.

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

See [`docs/interface.md`](interface.md) for the full command/flag reference and output file
schema.

## CAPTCHAs

CAPTCHAs detect automation (`navigator.webdriver`) and refuse to run. The runner
automatically suppresses that one signal **only on a page where a CAPTCHA is present**
(page-scoped) and reloads so the CAPTCHA can initialize and be tested; every other page
keeps the honest signal. Fully passing an enterprise CAPTCHA from automation is unreliable
by design.
