import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { runBatch, fixtureUrl, tmpOutDir } from './helpers.js';

test.describe('seeded-defect fixtures', () => {
  test('mixed-defects.html: keyboard + screen-reader findings detected', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('mixed-defects.html'), persona: 'all', outDir, maxSteps: 15 });
      const wcags = findings.map((f) => f.wcag);
      expect(wcags).toContain('1.1.1'); // image with no accessible name
      expect(wcags).toContain('1.3.1'); // heading skip and/or duplicate landmark
      expect(wcags).toContain('4.1.3'); // batch crawl never presses Enter -> live region never fires
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('no-focus-indicator.html: 2.4.7 (Focus Visible) fires', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('no-focus-indicator.html'), persona: 'keyboard', outDir, maxSteps: 10 });
      expect(findings.some((f) => f.wcag === '2.4.7')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('keyboard-trap.html: 2.1.2 (No Keyboard Trap) fires', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('keyboard-trap.html'), persona: 'keyboard', outDir, maxSteps: 10 });
      expect(findings.some((f) => f.wcag === '2.1.2')).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('clean.html: zero AA (pass/fail) findings', async () => {
    const outDir = tmpOutDir();
    try {
      const { findings } = await runBatch({ url: fixtureUrl('clean.html'), persona: 'all', outDir, maxSteps: 15 });
      // AAA findings are informative-only by this tool's own design (never a
      // scenario failure) -- only AA findings represent an actual defect here.
      const aaFindings = findings.filter((f) => f.conformance_level === 'AA');
      expect(aaFindings, JSON.stringify(aaFindings, null, 2)).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
