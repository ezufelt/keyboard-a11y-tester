---
name: keyboard-a11y-tester
description: >-
  Drive a real browser KEYBOARD-ONLY to test whether a person using only the keyboard can
  complete a task on a website, and report evidence-linked WCAG findings. Use when the user
  wants to test/audit a site with the keyboard, check keyboard navigation, focus order, focus
  visibility, keyboard traps, skip links, or accessible names — OR asks whether a keyboard-only
  user can complete a specific task ("visit X and find/do Y", "can a keyboard user submit the
  form", "check the nav/menu/filter/search keyboard behavior"), OR to run a *.test.yaml case.
  Behaves like the W3C keyboard persona "Ade". Do NOT use for axe/Lighthouse-only rule scans,
  or for screen-reader-only or colour-contrast-only audits.
---

# Keyboard-only accessibility tester

You drive a real Chromium browser using **only the keyboard** and judge whether a keyboard-only
person can accomplish a task, producing findings mapped to WCAG success criteria. A bundled
script (`scripts/runner.mjs`) owns the mechanical work — driving keys, capturing state, and
computing the deterministic checks. **You are the judgment layer**: you decide each keystroke by
reading what happened, and you write the findings the rules can't (task completion, logical
order, form quality).

Never call a mouse. If a control is only reachable/operable by pointer, that is a finding.

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

2. **Observe / step.** Each `step` performs ONE key and prints an observation: the focused
   element's accessible **name / role / states**, the **URL**, its **computed focus style**
   (`has_outline`/`has_shadow`), a **screenshot path**, and whether focus moved.
   ```bash
   node scripts/runner.mjs observe <session-dir>              # current state, no keystroke
   node scripts/runner.mjs step <session-dir> --press Tab     # one key
   node scripts/runner.mjs step <session-dir> --press Enter
   node scripts/runner.mjs step <session-dir> --type "hello@example.com"   # type into focused field
   ```
   Allowed keys: `Tab Shift+Tab Enter Space Escape ArrowUp ArrowDown ArrowLeft ArrowRight Home End`.
   Read the screenshot with your Read tool when the AX name isn't enough to decide (e.g. which
   grid tile, is the focus ring actually visible against this background).

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
+ nearest heading), `evidence` step ids, `confidence`, `severity`, `conformance_level`:
- **2.4.7 (AA)** focus indicator PRESENT on each stop (presence only — 2.4.7 sets no size bar).
- **2.4.13 (AAA, informative)** focus-appearance strength (area + 3:1 contrast). Advisory only.
- **1.4.1** indicator not colour-only · **2.1.2** focus stalls (trap) · **2.4.1** skip link ·
  **2.4.3** positive tabindex · **3.2.1** context change on focus · **4.1.2** missing accessible name.

`trace.json` — every step: keystroke, selector, AX name/role/state, computed focus style, region
locator, bounding box, focus-visible verdict, screenshot ref.

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

Every finding MUST: reference the evidence step(s), carry a confidence score, map to a specific
WCAG SC, name the page **URL**, and state persona impact in plain language ("a keyboard user
cannot …"). Merge your findings with the deterministic ones into one report. Be honest about
uncertainty and verify before asserting — prefer confirming a suspected issue against the
computed style / a screenshot over guessing.

## Persona

Keyboard-only, sighted, may use speech-recognition and tire quickly — the W3C user "Ade"
(<https://www.w3.org/WAI/people-use-web/user-stories/story-one/>). This is why accessible names
(voice control), visible focus, logical order, and skip links matter. Judge success from that
point of view.

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

## Reference

`references/architecture.md` (driver / runtime / interaction model / output contract).
Do both viewports (desktop + mobile); behaviour differs — nav often collapses behind a
disclosure/hamburger on mobile.
