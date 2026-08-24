/**
 * Turns a run into evidence instead of a colour.
 *
 * A green job whose Python half silently skipped looks exactly like a green job
 * where it ran. This script reads the actual artefacts, prints the numbers, and
 * FAILS when any of them is zero — so "0 cases compared" can never pass as success.
 *
 * Writes to the GitHub step summary when available, so the numbers show on the job
 * page without expanding a single step.
 *
 * Usage: node scripts/ci-summary.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const problems = [];
const lines = [];

function say(line) {
  lines.push(line);
  console.log(line);
}

/* ---------- Which Python was actually available ---------- */

const CANDIDATES = ['python3', 'python', 'py'];
let interpreter = null;
for (const name of CANDIDATES) {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8', shell: false });
  if (probe.status === 0) {
    interpreter = `${name} -- ${(probe.stdout || probe.stderr).trim()}`;
    break;
  }
}
if (interpreter === null) {
  problems.push('no Python interpreter found');
  interpreter = 'NONE FOUND';
}

say(`Platform:           ${process.platform} (${process.arch})`);
say(`Node:               ${process.version}`);
say(`Python interpreter: ${interpreter}`);

/* ---------- How much the cross-check actually compared ---------- */

/**
 * Reads a JSON artefact. Any failure is a problem, never a silent zero:
 * printing zeros for an unreadable report is worse than having no script at all,
 * because it manufactures the appearance of evidence.
 */
function readJson(p, label) {
  if (!fs.existsSync(p)) {
    problems.push(`${label} is missing -- that stage did not run`);
    return null;
  }
  const raw = fs.readFileSync(p, 'utf8');
  if (raw.trim().length === 0) {
    problems.push(`${label} is empty`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    problems.push(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function countCases(file) {
  const doc = readJson(path.join(root, 'oracle', file), `oracle/${file}`);
  if (doc === null) return 0;
  if (Array.isArray(doc)) return doc.length;
  if (Array.isArray(doc.cases)) return doc.cases.length;
  problems.push(`oracle/${file} has an unexpected shape -- cannot count cases`);
  return 0;
}

const pyCases = countCases('expected.json');
const tsCases = countCases('ts-results.json');

say(`Oracle cases (Python):     ${pyCases}`);
say(`Oracle cases (TypeScript): ${tsCases}`);

if (pyCases === 0 || tsCases === 0) {
  problems.push('the cross-check compared zero cases');
}
if (pyCases !== tsCases) {
  problems.push(`case count mismatch: python ${pyCases} vs typescript ${tsCases}`);
}

/* ---------- What the suite actually reported ---------- */

const resultsPath = path.join(root, 'test-results', 'results.json');
const report = readJson(resultsPath, 'test-results/results.json');

if (report === null) {
  say('Tests: REPORT UNREADABLE');
} else if (!Array.isArray(report.suites)) {
  problems.push('test-results/results.json has no `suites` array -- the shape is not what this script parses');
  say('Tests: REPORT SHAPE UNRECOGNISED');
} else {
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, other: 0 };

  // Playwright's JSON reporter reports outcomes, not statuses: a passing test is
  // "expected", a failing one "unexpected". Mapping them to passed/failed by name
  // silently yields zeros — which is exactly the false green this script exists to
  // prevent, and it did so on its own first run.
  const OUTCOME = {
    expected: 'passed',
    unexpected: 'failed',
    skipped: 'skipped',
    flaky: 'flaky',
  };

  /**
   * Per-project tally, keyed by the project names the config declares.
   *
   * The overall total is not enough. If a project stops matching any files —
   * a renamed directory, a changed testDir, a stray filter — the run still ends
   * green: the remaining project passes, nothing fails, and the total stays
   * comfortably above zero. The browser half of the suite would simply stop
   * running, and no signal would say so.
   *
   * The expected names come from `config.projects`, never from a hand-written
   * list here: a list that must be updated by hand is a list that will be wrong,
   * as the lint:forbidden file list already demonstrated after a merge.
   */
  const declared = (report.config?.projects ?? []).map((p) => p.name).filter(Boolean);
  const byProject = new Map(declared.map((name) => [name, 0]));

  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const key = OUTCOME[t.status] ?? 'other';
        counts[key] += 1;
        if (key === 'passed' && typeof t.projectName === 'string') {
          byProject.set(t.projectName, (byProject.get(t.projectName) ?? 0) + 1);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);

  const total =
    counts.passed + counts.failed + counts.skipped + counts.flaky + counts.other;

  say(
    `Tests: ${total} total -- ${counts.passed} passed, ${counts.failed} failed, ` +
      `${counts.skipped} skipped, ${counts.flaky} flaky`,
  );

  if (declared.length === 0) {
    problems.push('the report declares no Playwright projects -- cannot verify per-project coverage');
  } else {
    const perProject = declared
      .map((name) => `${name}: ${byProject.get(name) ?? 0}`)
      .join(', ');
    say(`Projects: ${perProject}`);

    for (const name of declared) {
      if ((byProject.get(name) ?? 0) === 0) {
        problems.push(
          `project "${name}" passed zero tests -- declared in the config but produced no work`,
        );
      }
    }
  }

  if (total === 0) problems.push('the suite reported zero tests');
  if (counts.passed === 0) problems.push('zero tests passed');
  if (counts.other > 0) {
    problems.push(`${counts.other} test(s) with an unrecognised outcome -- the mapping is stale`);
  }
  if (counts.failed > 0) problems.push(`${counts.failed} test(s) failed`);
  if (counts.skipped > 0) {
    problems.push(`${counts.skipped} test(s) skipped -- name them or remove them`);
  }
}

/* ---------- Publish and decide ---------- */

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  const body =
    `### Run evidence -- ${process.platform}\n\n` +
    '```\n' +
    lines.join('\n') +
    '\n```\n' +
    (problems.length > 0
      ? '\n**Problems**\n\n' + problems.map((p) => `- ${p}`).join('\n') + '\n'
      : '\nEvery stage reported non-zero work.\n');
  fs.appendFileSync(summaryFile, body);
}

if (problems.length > 0) {
  console.error('\nEvidence check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nEvidence check passed: every stage reported non-zero work.');
