// CLI/finding helpers factored out of runner.mjs so they can be imported
// directly (by tests) without triggering the CLI's own main()/browser launch.
import fs from 'node:fs';
import path from 'node:path';

export const PERSONAS = new Set(['keyboard', 'screen-reader', 'all']);

// A bad --max-steps value (non-numeric, zero, negative) used to parse to
// NaN/<=0 and propagate silently: `for (let i = 1; i <= maxSteps; i++)` never
// runs when maxSteps is NaN or <= 0, so the batch crawl would do zero steps
// and exit as if it had passed. Validated here so a typo fails loudly instead.
export function parseArgs(argv) {
  const args = { _: [], out: null, viewport: null, maxSteps: 150, press: null, type: null, port: null, storageState: null, persona: 'all' };
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
