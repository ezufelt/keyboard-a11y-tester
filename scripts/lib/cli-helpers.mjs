// CLI/finding helpers factored out of runner.mjs so they can be imported
// directly (by tests) without triggering the CLI's own main()/browser launch.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PERSONAS = new Set(['keyboard', 'screen-reader', 'all']);

// AF_UNIX addresses carry the path in a fixed-size `sun_path` char array --
// 104 bytes on macOS/BSD, 108 on Linux -- and it must be NUL-terminated, so
// the usable length is one less. Exceeding it fails in listen(2)/connect(2)
// with a bare EINVAL that names no limit.
export const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 108;

// Windows named pipes live in a flat, virtual `\\.\pipe\` namespace, not the
// real filesystem -- binding an AF_UNIX-style socket file under a Temp
// directory is unreliable there (EACCES on GitHub Actions' windows-latest
// runners). Derive a unique pipe name from `dir` instead.
//
// Elsewhere the socket goes beside the session (discoverable, and torn down
// with it) -- but only when it fits. macOS's per-user TMPDIR
// (/var/folders/<2>/<28>/T/) spends ~49 of the 104 bytes before the tool adds
// `keyboard-a11y-tester/<site-slug>/session-<viewport>/control.sock`, so any
// site slug longer than about five characters used to push the default path
// past the cap and make `serve` unusable. Fall back to a short hashed name in
// a shorter root in that case. Pure and deterministic in `dir`, so `serve` and
// the observe/step/finish/stop clients each derive the same path without
// having to communicate it.
export function controlSockPath(dir, { platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  if (platform === 'win32') return '\\\\.\\pipe\\' + dir.replace(/[:\\]/g, '_');
  const beside = path.join(dir, 'control.sock');
  if (Buffer.byteLength(beside) < SUN_PATH_MAX) return beside;
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
  // Nested in its own directory rather than dropped loose in the temp root:
  // the session dir this socket is leaving behind is created 0700, and the
  // socket grants full control of a possibly-authenticated browser, so it must
  // not become the one artifact protected only by file mode. That matters on
  // Linux, where the temp root is the shared, world-writable /tmp; macOS's
  // per-user /var/folders root is already private, but the guarantee shouldn't
  // depend on which platform is running. The caller creates it with mode 0700.
  //
  // '/tmp' is the backstop for a TMPDIR so long even this overflows; it is the
  // shortest directory guaranteed writable on POSIX.
  for (const root of [tmpdir, '/tmp']) {
    const candidate = path.join(root, `ka11y-${hash}`, 'control.sock');
    if (Buffer.byteLength(candidate) < SUN_PATH_MAX) return candidate;
  }
  throw new Error(
    `Cannot place a control socket within the ${SUN_PATH_MAX}-byte AF_UNIX path limit ` +
    `(tried "${beside}" and a hashed name under "${tmpdir}" and "/tmp").`,
  );
}

// A bad --max-steps value (non-numeric, zero, negative) used to parse to
// NaN/<=0 and propagate silently: `for (let i = 1; i <= maxSteps; i++)` never
// runs when maxSteps is NaN or <= 0, so the batch crawl would do zero steps
// and exit as if it had passed. Validated here so a typo fails loudly instead.
export function parseArgs(argv) {
  const args = { _: [], out: null, viewport: null, maxSteps: 150, press: null, type: null, port: null, storageState: null, persona: 'all', userAgent: null };
  let maxStepsRaw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--viewport') args.viewport = argv[++i];
    else if (a === '--max-steps') { maxStepsRaw = argv[++i]; args.maxSteps = parseInt(maxStepsRaw, 10); }
    else if (a === '--press') args.press = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--goal') args.goal = argv[++i];
    else if (a === '--storage-state') args.storageState = argv[++i];
    else if (a === '--persona') args.persona = argv[++i];
    else if (a === '--user-agent') args.userAgent = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  if (maxStepsRaw !== null && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1)) {
    throw new Error(`Invalid --max-steps: ${maxStepsRaw} (expected a positive integer)`);
  }
  return args;
}

export function pickViewport(testCase, name) {
  const vps = testCase.viewports || [{ name: 'desktop', width: 1280, height: 800 }];
  const vp = name ? vps.find((v) => v.name === name) : vps[0];
  if (!vp) {
    throw new Error(`No matching viewport: ${name}`);
  }
  return vp;
}

export function validatePersona(p) {
  if (!PERSONAS.has(p)) {
    throw new Error(`Invalid --persona: ${p} (expected keyboard|screen-reader|all)`);
  }
  return p;
}

// Resolves --storage-state to an absolute path, failing fast if it is missing or
// not valid JSON: a silently-ignored auth file would make the whole run test the
// logged-out site while claiming to test the logged-in one.
export function resolveStorageState(arg) {
  if (!arg) return null;
  const p = path.resolve(arg);
  if (!fs.existsSync(p)) {
    throw new Error(`Storage state file not found: ${p}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`Storage state file is not valid JSON: ${p}\n  ${err.message}`, { cause: err });
  }
  // Playwright silently no-ops an unrecognized shape rather than erroring, which
  // would defeat the point of validating at all: the run would proceed fully
  // logged-out while claiming --storage-state was applied. A real export always
  // has both arrays (even if one is empty).
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error(
      `Storage state file is valid JSON but not a Playwright storageState export ` +
      `(expected "cookies" and "origins" arrays): ${p}`,
    );
  }
  return p;
}

// Rough default severities; AI layer may refine. A plain-object literal used
// as a map would return inherited Object.prototype members (a function, not
// a severity string) for keys like 'valueOf' or 'toString' — Object.hasOwn
// guards against that.
const SEVERITY_BY_WCAG = {
  '2.1.1': 'blocker',
  '2.1.2': 'blocker',
  '1.1.1': 'serious',
  '1.3.1': 'moderate',
  '1.4.1': 'moderate',
  '2.4.1': 'moderate',
  '2.4.3': 'moderate',
  '2.4.7': 'serious',
  '2.4.13': 'minor',
  '3.2.1': 'serious',
  '3.3.2': 'moderate',
  '4.1.2': 'serious',
  '4.1.3': 'moderate',
};

function severityFor(wcag) {
  return Object.hasOwn(SEVERITY_BY_WCAG, wcag) ? SEVERITY_BY_WCAG[wcag] : 'moderate';
}

// conformance_level: 'AA' findings are pass/fail; 'AAA' findings are INFORMATIVE
// (advisory) — never a scenario failure on their own.
function makeFinding({ id, wcag, confidence, viewport, goalId, summary, impact, evidence, severity, level, url, locations, persona, evidenceKind }) {
  return {
    id,
    wcag,
    source: 'deterministic',
    persona: persona || 'keyboard',          // 'keyboard' | 'screen-reader'
    evidence_kind: evidenceKind || 'step_id', // 'step_id' | 'selector'
    conformance_level: level || 'AA',
    confidence,
    severity: severity || severityFor(wcag),
    viewport,
    goal_id: goalId || null,
    url: url || null,               // page the evidence was observed on
    locations: locations || [],     // human locators (landmark / heading) on that page
    summary,
    persona_impact: impact,
    evidence: evidence || [],
  };
}

export { severityFor, makeFinding };
