import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import fc from 'fast-check';
import { severityFor, makeFinding, validatePersona, resolveStorageState, parseArgs, pickViewport, controlSockPath, SUN_PATH_MAX } from '../scripts/lib/cli-helpers.mjs';
import { relLum } from '../scripts/lib/color.mjs';

const KNOWN_FLAGS = [
  '--out', '--viewport', '--max-steps', '--press', '--type', '--port',
  '--url', '--goal', '--storage-state', '--persona', '--user-agent', '-h', '--help',
];

test('severityFor always returns a known severity for any input string', () => {
  fc.assert(
    fc.property(fc.string(), (wcag) => {
      expect(['blocker', 'serious', 'moderate', 'minor']).toContain(severityFor(wcag));
    }),
  );
});

test('severityFor never throws, including on empty string, unicode, and very long input', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.constant(''), fc.string({ unit: 'grapheme' }), fc.string({ minLength: 1000, maxLength: 5000 })),
      (wcag) => {
        expect(() => severityFor(wcag)).not.toThrow();
      },
    ),
  );
});

test('makeFinding always produces output matching the documented trace/findings contract', () => {
  fc.assert(
    fc.property(
      fc.record({
        id: fc.string(),
        wcag: fc.string(),
        confidence: fc.float({ min: 0, max: 1, noNaN: true }),
        viewport: fc.constantFrom('desktop', 'mobile'),
        summary: fc.string(),
        evidence: fc.array(fc.string()),
        locations: fc.array(fc.string()),
      }),
      (input) => {
        const finding = makeFinding(input);
        expect(['keyboard', 'screen-reader']).toContain(finding.persona);
        expect(['step_id', 'selector']).toContain(finding.evidence_kind);
        expect(['AA', 'AAA']).toContain(finding.conformance_level);
        expect(['blocker', 'serious', 'moderate', 'minor']).toContain(finding.severity);
        expect(Array.isArray(finding.locations)).toBe(true);
        expect(Array.isArray(finding.evidence)).toBe(true);
        expect(finding.id).toBe(input.id);
        expect(finding.wcag).toBe(input.wcag);
      },
    ),
  );
});

test('validatePersona accepts exactly the three known personas and rejects everything else', () => {
  fc.assert(
    fc.property(fc.string(), (p) => {
      if (['keyboard', 'screen-reader', 'all'].includes(p)) {
        expect(validatePersona(p)).toBe(p);
      } else {
        expect(() => validatePersona(p)).toThrow();
      }
    }),
  );
});

test('resolveStorageState rejects any file that is not a well-formed Playwright storageState export', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant('not json'),
        fc.jsonValue().map((v) => JSON.stringify(v)),
      ),
      (content) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-storage-'));
        const file = path.join(dir, 'state.json');
        fs.writeFileSync(file, content);
        try {
          expect(() => resolveStorageState(file)).toThrow();
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 25 }, // real filesystem I/O per run — keep it light
  );
});

test('resolveStorageState accepts a well-formed storageState export and returns its resolved path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-storage-ok-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  try {
    expect(resolveStorageState(file)).toBe(path.resolve(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `serve` used to bind a socket at <session-dir>/control.sock unconditionally.
// On macOS the per-user TMPDIR (/var/folders/<2>/<28>/T/) is ~49 of the 104
// AF_UNIX bytes before the tool's own path is appended, so any site slug over
// ~5 characters overflowed and listen(2) failed with a bare EINVAL naming no
// limit -- `serve` was unusable for essentially every real site. The length
// bound is the whole point of the function, so assert it over arbitrary dirs
// rather than the one path that happened to break.
test('controlSockPath never exceeds the platform AF_UNIX path limit, for any session dir', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), fc.constantFrom('darwin', 'linux'), (dir, platform) => {
      const sock = controlSockPath(dir, { platform, tmpdir: os.tmpdir() });
      expect(Buffer.byteLength(sock)).toBeLessThan(SUN_PATH_MAX);
    }),
  );
});

// Non-negotiable: `serve` binds the socket and the separate observe/step/
// finish/stop processes connect to it. They never exchange the path, so each
// re-derives it from the session dir -- if that derivation were not a pure
// function of `dir`, the clients would silently fail to reach a live session.
test('controlSockPath is deterministic in the session dir', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), fc.constantFrom('darwin', 'linux'), (dir, platform) => {
      const opts = { platform, tmpdir: os.tmpdir() };
      expect(controlSockPath(dir, opts)).toBe(controlSockPath(dir, opts));
    }),
  );
});

// Distinct sessions must never collide on one socket, or a second `serve`
// would hijack the first's control channel. Compared after path.resolve: "a"
// and "a/" are the same directory and *should* share a socket, so raw string
// inequality is the wrong precondition here.
test('controlSockPath maps genuinely distinct session dirs to distinct sockets', () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 400 }), fc.string({ maxLength: 400 }), fc.constantFrom('darwin', 'linux'),
      (a, b, platform) => {
        fc.pre(path.resolve(a) !== path.resolve(b));
        const opts = { platform, tmpdir: os.tmpdir() };
        expect(controlSockPath(a, opts)).not.toBe(controlSockPath(b, opts));
      },
    ),
  );
});

// The fallback is a fallback: a session dir that fits must keep its socket
// beside it, where it is discoverable and torn down with the session.
test('controlSockPath keeps the socket in the session dir whenever it fits', () => {
  const shortDir = path.join(os.tmpdir(), 'ka');
  const sock = controlSockPath(shortDir, { platform: 'linux', tmpdir: os.tmpdir() });
  expect(sock).toBe(path.join(shortDir, 'control.sock'));
});

test('parseArgs never throws on argv that never mentions --max-steps', () => {
  fc.assert(
    fc.property(
      fc.array(fc.string().filter((s) => s !== '--max-steps')),
      (argv) => {
        expect(() => parseArgs(argv)).not.toThrow();
      },
    ),
  );
});

// --max-steps used to parseInt to NaN/<=0 and propagate silently: the batch
// crawl's `for (let i = 1; i <= maxSteps; i++)` never runs when maxSteps is
// NaN or <= 0, so a typo'd flag produced a zero-step run that exited as if
// it had passed. This is exactly the shape of bug property tests are for.
test('parseArgs accepts --max-steps iff it parses to a positive integer, and rejects it otherwise', () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1) {
        expect(parseArgs(['--max-steps', raw]).maxSteps).toBe(n);
      } else {
        expect(() => parseArgs(['--max-steps', raw])).toThrow();
      }
    }),
  );
});

test('parseArgs routes tokens that never match a known flag into args._, untouched', () => {
  fc.assert(
    fc.property(
      fc.array(fc.string().filter((s) => !KNOWN_FLAGS.includes(s))),
      (argv) => {
        const args = parseArgs(argv);
        expect(args._).toEqual(argv);
        expect(args.help).toBeFalsy();
      },
    ),
  );
});

const viewportArb = fc.array(
  fc.record({
    name: fc.string({ minLength: 1 }),
    width: fc.integer({ min: 1, max: 4000 }),
    height: fc.integer({ min: 1, max: 4000 }),
  }),
  { minLength: 1, maxLength: 5 },
);

test('pickViewport returns a viewport with the requested name when present, and throws when absent', () => {
  fc.assert(
    fc.property(viewportArb, fc.string(), (viewports, name) => {
      const testCase = { viewports };
      // pickViewport does `name ? find(...) : vps[0]` -- an empty string (the
      // only falsy string) takes the default-viewport branch, same as omitting
      // --viewport entirely, rather than being treated as "no such viewport".
      if (!name) {
        expect(pickViewport(testCase, name)).toBe(viewports[0]);
      } else if (viewports.some((v) => v.name === name)) {
        expect(pickViewport(testCase, name).name).toBe(name);
      } else {
        expect(() => pickViewport(testCase, name)).toThrow();
      }
    }),
  );
});

test('pickViewport defaults to the first viewport when no name is given', () => {
  fc.assert(
    fc.property(viewportArb, (viewports) => {
      const testCase = { viewports };
      expect(pickViewport(testCase, undefined)).toBe(viewports[0]);
    }),
  );
});

test('pickViewport falls back to a default desktop viewport when the test case has none', () => {
  expect(pickViewport({}, undefined)).toEqual({ name: 'desktop', width: 1280, height: 800 });
  expect(() => pickViewport({}, 'mobile')).toThrow();
});

test('relLum stays within [0,1] for any valid 8-bit RGB input', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      (r, g, b) => {
        const l = relLum(r, g, b);
        expect(Number.isFinite(l)).toBe(true);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
      },
    ),
  );
});

test('relLum is monotonically non-decreasing in each channel (brighter never reads as darker)', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      (r1, r2, g, b) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1];
        expect(relLum(lo, g, b)).toBeLessThanOrEqual(relLum(hi, g, b));
      },
    ),
  );
});

test('relLum hits the exact WCAG boundary values for black and white', () => {
  expect(relLum(0, 0, 0)).toBe(0);
  expect(relLum(255, 255, 255)).toBe(1);
});
