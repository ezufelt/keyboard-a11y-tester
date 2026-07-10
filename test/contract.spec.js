import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatch, fixtureUrl, tmpOutDir } from './helpers.js';

// CONTRIBUTING.md calls trace.json / deterministic-findings.json a stable
// contract the invoking agent (SKILL.md) depends on. This guards against
// accidentally renaming/removing a field rather than extending additively.
const TRACE_TOP_LEVEL_FIELDS = [
  'test_case_id', 'viewport', 'mode', 'personas', 'viewport_size',
  'start_url', 'generated_at', 'goals', 'steps',
];
const STEP_FIELDS = [
  'step_id', 'index', 'keystroke_sent', 'active_element_selector', 'tag', 'tabindex',
  'dom_order_index', 'ax_name_role_state', 'focus_moved', 'bounding_box', 'ancestor_boxes',
  'url', 'text', 'is_body', 'computed_focus_style', 'region', 'focused_region_screenshot',
  'focus_visible', 'sr_announcement',
];
const FINDING_FIELDS = [
  'id', 'wcag', 'source', 'persona', 'evidence_kind', 'conformance_level', 'confidence',
  'severity', 'viewport', 'goal_id', 'url', 'locations', 'summary', 'persona_impact', 'evidence',
];

test('trace.json and deterministic-findings.json keep their documented shape', async () => {
  const outDir = tmpOutDir();
  try {
    const { trace, findings } = await runBatch({
      url: fixtureUrl('mixed-defects.html'), persona: 'all', outDir, maxSteps: 15,
    });

    for (const field of TRACE_TOP_LEVEL_FIELDS) expect(trace).toHaveProperty(field);
    expect(trace.steps.length).toBeGreaterThan(0);
    for (const field of STEP_FIELDS) expect(trace.steps[0]).toHaveProperty(field);

    expect(findings.length).toBeGreaterThan(0);
    for (const field of FINDING_FIELDS) expect(findings[0]).toHaveProperty(field);
    for (const f of findings) {
      expect(['keyboard', 'screen-reader']).toContain(f.persona);
      expect(['step_id', 'selector']).toContain(f.evidence_kind);
      expect(['AA', 'AAA']).toContain(f.conformance_level);
      expect(f.wcag).toMatch(/^\d+\.\d+\.\d+$/);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
