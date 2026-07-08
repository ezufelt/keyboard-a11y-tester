# Architecture reference

On-demand reference for the invoking agent: how the runner drives the browser and what it
captures. Self-contained — no external files required.

## Driver

- **Playwright (Chromium)** as the harness: maintained headless-Linux images,
  target/frame lifecycle, auto-waiting, stable selectors, bounding boxes, screenshots.
- `keyboard.press()` dispatches **real** `Input.dispatchKeyEvent` events, so native
  focus movement and `:focus-visible` behave correctly. Never JS-dispatch synthetic
  `KeyboardEvent`s — they don't move focus.
- Drop to a raw **CDP session** (`context.newCDPSession(page)`) for the accessibility
  tree: `Accessibility.getPartialAXTree` / `getFullAXTree` — ground truth for
  name/role/state. Do **not** use Playwright's deprecated `page.accessibility.snapshot()`.

## Runtime (container)

- New-headless full Chromium + SwiftShader for real pixels (focus-indicator detection).
- Fixed viewport, animations disabled, reduced motion → deterministic layout, tab
  order, and focus-indicator pixel diffs.
- **Validate `:focus-visible` fires on CDP-driven key events at startup; fail fast** if
  not — otherwise every focus-indicator check is invalid.

## Interaction model

Behaves like a keyboard user and nothing else. **Never** `.click()` or `.focus()` — if a
control is only reachable by mouse, that is a finding. Allowed keys only: `Tab`,
`Shift+Tab`, arrows, `Enter`, `Space`, `Escape`, `Home`, `End`.

## Per-step capture loop

After every keystroke, record: active element (stable selector), AX name/role/state
(CDP), focus_moved?, bounding box, focused-region screenshot (crop; diffed vs an
unfocused baseline for focus-visible). This trace is both the input to the AI layer and
the evidence attached to every finding.

## Deterministic vs AI judgment

The runner owns the machine-decidable checks (2.1.1 / 2.1.2 / 2.4.1 / 2.4.3 / 2.4.7 /
3.2.1 / 4.1.2). The AI layer reads `trace.json` + `screenshots/` and judges what rules
can't: task completion, logical focus order vs visual layout, focus-indicator
perceivability against *this* background, custom-widget APG patterns, and form quality.

## Findings & output

Every finding MUST reference the evidence step(s) that support it, carry a confidence
score, map to a specific WCAG success criterion, name the page URL, and state persona
impact in plain language. Finding shape (as emitted in `deterministic-findings.json`):
`{ id, wcag, source, conformance_level, confidence, severity, viewport, url, locations,
summary, persona_impact, evidence[] }`. The runner's I/O contract — a URL or test-case
YAML in; `trace.json` / `deterministic-findings.json` / `screenshots/` out (under a temp
dir) — is stable.

## Personas

Ground persona judgments in the W3C WAI user stories —
<https://www.w3.org/WAI/people-use-web/user-stories/>. The deterministic checks
already support the keyboard+speech reporter "Ade" (visible focus, logical order, skip
links, accessible names for speech control).
