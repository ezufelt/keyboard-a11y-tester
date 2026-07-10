import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatchAllViewports, fixtureUrl, tmpOutDir } from './helpers.js';

// cross-viewport-findings.json is a different artifact than the other
// per-viewport outputs -- it only exists once BOTH viewports of a run have
// finished, so it gets its own spec file rather than living in
// defects.spec.js alongside the single-viewport fixture tests.
test.describe('cross-viewport census comparison', () => {
  test('viewport-content-divergence.html: flags a named control present on desktop only', async () => {
    const outDir = tmpOutDir();
    try {
      const { crossViewportFindings } = await runBatchAllViewports({
        url: fixtureUrl('viewport-content-divergence.html'), persona: 'screen-reader', outDir, maxSteps: 10,
      });
      expect(crossViewportFindings, 'cross-viewport-findings.json should exist when >1 viewport ran').toBeTruthy();
      const f = crossViewportFindings.find((x) => x.id.startsWith('cross-viewport-divergence'));
      expect(f, JSON.stringify(crossViewportFindings, null, 2)).toBeTruthy();
      expect(f.wcag).toBe('1.3.1');
      expect(f.summary).toContain('Advanced search');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('clean.html: no cross-viewport divergence findings', async () => {
    const outDir = tmpOutDir();
    try {
      const { crossViewportFindings } = await runBatchAllViewports({
        url: fixtureUrl('clean.html'), persona: 'screen-reader', outDir, maxSteps: 15,
      });
      expect(crossViewportFindings, JSON.stringify(crossViewportFindings, null, 2)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
