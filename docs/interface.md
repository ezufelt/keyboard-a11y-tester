# Interface reference

This is the authoritative reference for `scripts/runner.mjs`'s CLI surface and the output
files it writes. See [`docs/usage.md`](usage.md) for a task-oriented quick start.

## CLI commands

### Default mode — blind Tab-crawl (no subcommand)

```
node scripts/runner.mjs (--url <url> [--goal "<task>"] | <test-case.yaml>) \
  [--out <dir>] [--viewport <name>] [--max-steps <n>] [--persona <keyboard|screen-reader|all>]
```

Runs an unattended Tab-crawl of the start page for each matching viewport, then writes
`trace.json`, `deterministic-findings.json`, `screen-reader-census.json` (if the
screen-reader persona ran), and a `run-summary.json` covering all viewports in the run. If the
screen-reader persona ran across more than one viewport, also writes a top-level
`cross-viewport-findings.json` comparing their census results. Requires either `--url` or a
positional path to a `*.test.yaml` scenario file. Exits 1 (after printing usage) if neither is
given.

### `serve` — start a live session

```
node scripts/runner.mjs serve (--url <url> [--goal "<task>"] | <test-case.yaml>) \
  [--viewport <name>] [--out <dir>] [--port <n>] [--persona <keyboard|screen-reader|all>]
```

Launches Chromium, navigates to the start page, and blocks, keeping the browser alive so
`step`/`observe`/`finish` can drive it from separate invocations. Prints `READY <session-dir>`
to stdout on startup — the invoking agent parses this line to get the session directory
used by every subsequent command. Ends when a matching `stop <session-dir>` call is made.

### `observe <session-dir>` — read current state without acting

Reports the currently focused element (selector, tag, accessible name/role/state) and, for
the screen-reader persona, the last spoken phrase. Sends no keystroke.

### `step <session-dir> (--press <Key> | --type <text>)` — drive one keystroke

Sends exactly one keystroke or one text-typing action, then prints an observation: keystroke
sent, whether focus moved, focused element's name/role/state, computed focus style, region
(landmark/heading), bounding box, screenshot path, and (screen-reader persona) the
announcement produced. `--press` accepts one of:

```
Tab  Shift+Tab  Enter  Space  Escape  ArrowUp  ArrowDown  ArrowLeft  ArrowRight  Home  End
```

Any other value is rejected (exit 1). `--type <text>` types real keystrokes (never `.fill()`).
Defaults to `--press Tab` if neither `--press` nor `--type` is given.

### `finish <session-dir>` — close out the session's evidence

Finalizes focus-visible/focus-appearance metrics (keyboard persona), guarantees the current
page has a screen-reader census entry, derives all findings, and writes `trace.json`,
`deterministic-findings.json`, and (screen-reader persona) `screen-reader-census.json` into
the session directory. Prints a `{ steps, findings }` summary to stdout.

### `stop <session-dir>` — end a live session

Signals the running `serve` process to close the browser and exit. No stdout output.

## Flags

| Flag | Type | Default | Applies to | Meaning |
|------|------|---------|------------|---------|
| `--url <url>` | string | — | default mode, `serve` | Run against a URL directly, no scenario file needed. |
| `--goal "<text>"` | string | — | default mode, `serve` (with `--url`) | Free-text task description; becomes the synthesized scenario's goal intent. |
| `--out <dir>` | path | temp dir (`${TMPDIR}/keyboard-a11y-tester`) | all | Overrides the output root. |
| `--viewport <name>` | string | first viewport in the scenario (`desktop` if none declared) | default mode, `serve` | Selects/filters which viewport(s) run. |
| `--max-steps <n>` | integer | `150` | default mode | Cap on Tab-presses during the blind crawl. Must parse to a positive integer; any other value exits 1 with a clear error instead of silently running zero steps. |
| `--persona <keyboard\|screen-reader\|all>` | enum | `all` | all | Restricts which persona's checks run. Invalid values exit 1. |
| `--port <n>` | integer | `9333` | `serve` | CDP remote-debugging port for the live session. |
| `--press <Key>` | enum (see key list above) | `Tab` | `step` | The single keystroke to send. |
| `--type <text>` | string | — | `step` | Types text instead of pressing a key. |
| `-h`, `--help` | flag | — | default mode | Prints usage and exits 0. |

Also: instead of `--url`, any command that accepts it can instead take a positional path to a
saved scenario file (see `test-cases/TEMPLATE.test.yaml`).

## Output file schema

Everything is written under `<out>/<site-or-case-id>/…` (`<out>` defaults to
`${TMPDIR}/keyboard-a11y-tester`). `<site-or-case-id>` is the scenario's `id:` field when run
from a `*.test.yaml` file, or — when run from `--url` — the URL's hostname with a leading
`www.` stripped and every run of non-alphanumeric characters collapsed to a single hyphen.

### Directory layout

```
<out>/<site-or-case-id>/
  run-summary.json                    # batch mode only: { test_case_id, generated_at, viewports: [{ viewport, steps, findings }] }
  cross-viewport-findings.json        # batch mode only: screen-reader persona AND >1 viewport ran
  <viewport>/                         # batch (blind-crawl) mode
    trace.json
    deterministic-findings.json
    screen-reader-census.json         # only if the screen-reader persona ran
    screenshots/step_NNNN.png
  session-<viewport>/                 # live mode (serve/observe/step/finish)
    session.json                      # live session state
    steps.json                        # accumulated step records
    frames/rest.png                   # baseline screenshot (no keystroke sent yet)
    frames/full_NNNN.png              # full-page screenshot per step
    screenshots/step_NNNN.png
    sr-census.json                    # running per-URL census (screen-reader persona)
    STOP                              # sentinel file written by `stop`
    trace.json                        # written by `finish`
    deterministic-findings.json       # written by `finish`
    screen-reader-census.json         # written by `finish`, if screen-reader persona ran
```

### `trace.json`

Top-level fields:

| Field | Type | Notes |
|-------|------|-------|
| `test_case_id` | string | Scenario/site id. |
| `viewport` | string | e.g. `desktop`, `mobile`. |
| `mode` | `"crawl"` \| `"driven-live"` | Blind-crawl vs. live-session run. |
| `personas` | array | `["keyboard","screen-reader"]` for `--persona all`, else the single persona. |
| `viewport_size` | `{ width, height }` | |
| `start_url` | string | |
| `generated_at` | string (ISO timestamp) | Batch mode only; omitted in `driven-live` mode. |
| `goals` | array of `{ id, intent }` | |
| `steps` | array of step records | See below. |

Each entry in `steps[]`:

| Field | Type | Notes |
|-------|------|-------|
| `step_id` | string | `step_NNNN`, 4-digit zero-padded index. |
| `index` | integer | 1-based. |
| `keystroke_sent` | string | e.g. `Tab`, `Shift+Tab`, or `type:"<text>"` for typed input. |
| `active_element_selector` | string | CSS path, or `:root`/`body`. When focus is traced into an iframe (same-origin or cross-origin), `"<outer iframe selector> >>> <inner selector>"`. |
| `tag` | string \| null | Lowercase tag name. |
| `tabindex` | integer \| null | Parsed `tabindex` attribute. |
| `dom_order_index` | integer | Position in `document.querySelectorAll('*')` (within whichever document the focused element lives in), or `-1`. |
| `ax_name_role_state` | `{ name, role, states, name_source } \| null` | From the CDP accessibility tree, except inside an iframe: `name_source.type` is `"heuristic"` (label/aria-label/alt/title/text, not full ACCNAME -- ground truth isn't reachable across a cross-origin frame's own target) and `states` is `{}`. |
| `focus_moved` | boolean | Whether the selector differs from the previous step. |
| `bounding_box` | `{ x, y, width, height } \| null` | |
| `ancestor_boxes` | `{ x, y, width, height }[]` | Up to 3 ancestor boxes, capped to ~25x the element's own area, for detecting a `:focus-within`-style indicator on a wrapping container. |
| `url` | string | Page URL at capture time. |
| `text` | string | innerText/value/aria-label, trimmed and truncated to 120 chars. |
| `is_body` | boolean | |
| `computed_focus_style` | object \| null | See below. |
| `region` | `{ landmark, heading } \| null` | Nearest landmark label and heading text (truncated). |
| `focused_region_screenshot` | string \| null | Relative path, e.g. `screenshots/step_0007.png`; `null` if the element has no usable bounding box. |
| `focus_visible` | object \| null | Filled in by `finish`/end of batch run — see below. |
| `sr_announcement` | object \| null | See below; only populated for the screen-reader persona. |
| `cycle_closed` | boolean | Present only on the step where the blind crawl detects the tab cycle closed. |
| `focus_appearance` | object \| null | AAA-only metric, present once `focus_visible` has been finalized. |

`computed_focus_style`:

| Field | Type |
|-------|------|
| `outline_style`, `outline_width`, `outline_color`, `outline_offset` | string (raw computed CSS values) |
| `box_shadow` | string \| null |
| `has_outline` | boolean |
| `has_shadow` | boolean |

`sr_announcement`:

| Field | Type | Notes |
|-------|------|-------|
| `new_phrases` | string[] | Raw spoken phrases newly logged this step. |
| `live_announcements` | `{ priority: "assertive"\|"polite", text }[]` | Parsed from live-region announcements. |
| `focus_announcement` | string \| null | Last non-live phrase logged this step. |

`focus_visible` (2.4.7 AA presence verdict):

| Field | Type | Notes |
|-------|------|-------|
| `border_band`, `interior`, `edge` | number (4 decimal places) | Pixel-diff signal strength in each region. |
| `style_cue` | boolean | Computed outline/box-shadow declared. |
| `pixel_cue` | boolean | Pixels changed on focus. |
| `visible` | boolean | `style_cue \|\| pixel_cue` — the AA pass/fail verdict. |
| `shape_cue` | boolean | Non-colour-only signal (for 1.4.1). `edge` only counts as a shape cue when the interior did NOT also change — a full-box fill lights up the edge bands too (they're subsets of the box) without being a genuine edge/underline. |
| `indicator` | `"outline"\|"shadow"\|"ring"\|"edge"\|"interior-only"\|"container"\|"detached"\|"none"` | `"container"` means the indicator was only found on an ancestor box, not the focused element itself. `"detached"` means it was found via a bounded pixel search near the element, with no DOM relationship to it at all (e.g. a portaled/absolutely-positioned ring). `"interior-only"` covers both a partial-region change and a full-box fill (e.g. a card/button swapping its whole background colour on focus) — see `color_safe`. |
| `color_safe` | boolean \| null | Only set when `indicator === "interior-only"`; `null` otherwise. `true` when the fill's focused/unfocused luminance contrast clears the same >= 3:1 bar `focus_appearance.contrast_pass` uses — bright/dark enough to read as a real lightness change independent of hue. `false` (or a fill with no measurable luminance change) feeds the 1.4.1 Use-of-Color finding below. |

When the focus region is too small/indeterminate: `{ visible: null, note: "region too small / indeterminate" }`, and `focus_appearance` is `null`.

`focus_appearance` (2.4.13 AAA, informative only; present only when `focus_visible.visible === true`):

| Field | Type | Notes |
|-------|------|-------|
| `changed_area` | integer | Changed pixel count over the padded region. |
| `ref_area_2px_perimeter` | integer | Reference area for a 2px-thick perimeter of the bounding box. |
| `area_pass` | boolean | `changed_area >= ref_area_2px_perimeter`. |
| `contrast` | number \| null | Rounded to 2 decimals; `null` if `changed_area` is 0. |
| `contrast_pass` | boolean \| null | `contrast >= 3`. |
| `aaa_pass` | boolean | `area_pass && contrast_pass === true`. Advisory only — never fails the run. |

### `deterministic-findings.json`

Top level: `{ test_case_id, viewport, generated_at, findings }` (batch mode) or
`{ test_case_id, viewport, mode: "driven-live", findings }` (live mode).

Each entry in `findings[]`:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | e.g. `focus-not-visible-desktop`, `sr-missing-alt-mobile`. |
| `wcag` | string | WCAG success criterion number, e.g. `2.4.7`. |
| `source` | `"deterministic"` | |
| `persona` | `"keyboard"` \| `"screen-reader"` | |
| `evidence_kind` | `"step_id"` \| `"selector"` | |
| `conformance_level` | `"AA"` \| `"AAA"` | AAA findings are informative and never fail the run. |
| `confidence` | number (0–1) | |
| `severity` | `"blocker"` \| `"serious"` \| `"moderate"` \| `"minor"` | |
| `viewport` | string | |
| `goal_id` | string \| null | |
| `url` | string \| null | Page the evidence was observed on. |
| `locations` | string[] | Up to 5 human-readable landmark/heading locators. |
| `summary` | string | Human-readable description. |
| `persona_impact` | string | Human-readable impact statement. |
| `evidence` | string[] | `step_id`s or selectors, per `evidence_kind`. |

Default severities by WCAG SC: `2.1.1`/`2.1.2` → blocker · `1.1.1`/`2.4.7`/`3.2.1`/`4.1.2` →
serious · `1.3.1`/`1.4.1`/`2.4.1`/`2.4.3`/`4.1.3` → moderate · `2.4.13` → minor.

### `screen-reader-census.json`

Top level: `{ test_case_id, viewport, generated_at, pages }` (batch mode) or
`{ test_case_id, viewport, mode: "driven-live", pages }` (live mode). `pages` is an object
keyed by page URL:

| Field | Type | Notes |
|-------|------|-------|
| `captured_at` | string (ISO timestamp) | |
| `entries` | array | Reading-order walk of the page — see below. |
| `declared_live_regions` | array of `{ selector, live, role }` | From `[aria-live]`/`[role=status\|alert\|log\|alertdialog]`. |
| `declared_broken_aria_refs` | array of `{ selector, attribute, ids }` | Elements whose `aria-controls`/`aria-describedby`/`aria-details`/`aria-errormessage` value contains only ID(s) that resolve to no element. Backs the corresponding 4.1.2 finding. |
| `declared_alternate_reading_order` | array of `{ selector, flowto_ids }` | From `[aria-flowto]` — descriptive only; no deterministic check reads this today, it's additional evidence for the AI layer's reading-order-vs-visual-order judgment. |
| `truncated` | boolean | `true` if the walk hit its safety cap or timed out. |
| `timed_out` | boolean | Only present if the census timed out (20s); in that case `entries`/`declared_live_regions`/`declared_broken_aria_refs`/`declared_alternate_reading_order` are empty and `truncated` is `true`. |

Each `entries[]` item:

| Field | Type | Notes |
|-------|------|-------|
| `index` | integer | 1-based walk position. |
| `spoken_phrase` | string | Full announcement, e.g. `"heading, Some Title, level 2"`. |
| `role` | string | Substring of `spoken_phrase` before the first comma. |
| `tag` | string \| null | |
| `selector` | string \| null | |

### `cross-viewport-findings.json`

Batch mode only, written after the viewport loop completes, and only when the screen-reader
persona ran across **more than one** viewport (no single viewport's run ever sees another
viewport's census, so this comparison can't happen inside `<viewport>/deterministic-findings.json`).
Not produced by live (`serve`) mode — see [Design constraints](../CONTRIBUTING.md).

Top level: `{ test_case_id, generated_at, findings }`. `findings` uses the same finding shape
as `deterministic-findings.json` (see below), with `viewport` set to `"<vpA>+<vpB>"` for the
pair being compared. Currently one comparison: a named interactive control (button, link,
textbox, etc.) present in one viewport's census `entries` for a URL but entirely absent from
another's — flagged at `confidence: 0.4` (low; often intentional responsive design, e.g. a
collapsed nav, so treat as a lead to confirm, not a confirmed defect).

### `screenshots/step_NNNN.png`

A crop of the full-page screenshot around the focused element, inflated by 8px on every
side (to capture outline/box-shadow rings that render outside the element's border box).
Written only when the focused element has a usable bounding box (width and height both
≥ 1px); otherwise the corresponding step's `focused_region_screenshot` is `null`. In live
mode, an additional uncropped `frames/full_NNNN.png` is kept per step (used by `finish` to
compute focus-visible metrics), plus a one-time `frames/rest.png` baseline captured before
any keystroke.

## WCAG checks

Checks are evaluated **per focus stop the persona actually visits** (keyboard persona) or
against a page-wide structural census (screen-reader persona) — this is *scenario* testing,
not an exhaustive page audit. Conformance target: **AA is pass/fail, AAA is informative.**

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
| 4.1.2 | AA | screen-reader | Broken ARIA ID reference — `aria-controls`/`aria-describedby`/`aria-details`/`aria-errormessage` whose ID(s) resolve to no element in the page. A multi-ID value only flags if none of its IDs resolve. |
| 4.1.2 | AA | screen-reader | Keyboard-focusable control absent from the accessibility-tree census — almost always `aria-hidden="true"` combined with a focusable `tabindex`, cross-referencing the keyboard persona's Tab-reachable trace against this page's census |
| 4.1.3 | AA | screen-reader | A declared live region (`aria-live`/`role=status\|alert\|log\|alertdialog`) that never announced anything all session |
| 1.3.1 | AA | screen-reader | Cross-viewport census comparison (`cross-viewport-findings.json`, batch mode, >1 viewport only) — a named interactive control present in one viewport's census but absent from another's for the same URL. Low confidence (0.4): often intentional responsive design, needs human confirmation. |

The scenario-level verdicts — "was every control *needed to complete the goal* reachable"
(2.1.1) and "no trap *on the path*" (full 2.1.2) — need the AI-driven goal path, so the
agent produces them from the trace. The 2.4.1 / 4.1.2 keyboard-persona checks directly
support the W3C keyboard+speech persona ("Ade",
<https://www.w3.org/WAI/people-use-web/user-stories/story-one/>); the screen-reader-persona
checks support the W3C blind/screen-reader persona ("Lakshmi",
<https://www.w3.org/WAI/people-use-web/user-stories/story-three/>).

## `scripts/setup-check.mjs`

Preflight check for the two prerequisites (npm deps, a working Chromium), run before
`npm install` so it uses only Node built-ins until deps are confirmed present. Takes no
arguments. Prints:

```json
{
  "deps_installed": true,
  "browser_available": true,
  "install_deps_cmd": "npm install",
  "install_browser_cmd": "npx playwright install chromium"
}
```

`deps_installed` is `true` only if both `playwright` and `@guidepup/virtual-screen-reader`
are present in `node_modules`. `browser_available` is only checked (and stays `null`
otherwise) if `deps_installed` is `true`; on failure it's `false` and a `browser_error`
field is added with the first line of the launch error.
