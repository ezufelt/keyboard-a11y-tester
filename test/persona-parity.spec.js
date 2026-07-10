import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatch, fixtureUrl, tmpOutDir } from './helpers.js';

test.describe('--persona parity/contract', () => {
  test('--persona keyboard: no screen-reader artifacts, pixel work still runs', async () => {
    const outDir = tmpOutDir();
    try {
      const { trace, census, screenshotCount } = await runBatch({
        url: fixtureUrl('mixed-defects.html'), persona: 'keyboard', outDir, maxSteps: 15,
      });
      expect(census).toBeNull();
      expect(trace.personas).toEqual(['keyboard']);
      expect(trace.steps.every((s) => s.sr_announcement === null)).toBe(true);
      expect(screenshotCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('--persona screen-reader: no pixel work, census present, all findings tagged screen-reader', async () => {
    const outDir = tmpOutDir();
    try {
      const { trace, census, screenshotCount, findings } = await runBatch({
        url: fixtureUrl('mixed-defects.html'), persona: 'screen-reader', outDir, maxSteps: 15,
      });
      expect(census).not.toBeNull();
      expect(trace.personas).toEqual(['screen-reader']);
      expect(screenshotCount).toBe(0);
      expect(findings.every((f) => f.persona === 'screen-reader')).toBe(true);
      expect(trace.steps.some((s) => s.sr_announcement !== null)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('--persona all: merges findings from both personas', async () => {
    const outDir = tmpOutDir();
    try {
      const { trace, census, findings } = await runBatch({
        url: fixtureUrl('mixed-defects.html'), persona: 'all', outDir, maxSteps: 15,
      });
      expect(census).not.toBeNull();
      expect(trace.personas).toEqual(['keyboard', 'screen-reader']);
      expect(findings.some((f) => f.persona === 'keyboard')).toBe(true);
      expect(findings.some((f) => f.persona === 'screen-reader')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
