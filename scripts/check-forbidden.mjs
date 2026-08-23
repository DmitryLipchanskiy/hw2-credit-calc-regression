/**
 * Mechanical check for the forbidden patterns listed in CLAUDE.md, rule 4.5.
 *
 * Runs from the pre-commit hook against staged files only, and as `npm run lint:forbidden`
 * against the whole tests tree.
 *
 * Cross-platform (CLAUDE.md rule 3): pure node, no grep, no shell utilities,
 * path.join everywhere.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const RULES = [
  // --- Disabling or weakening a check ---
  { id: 'only', re: /\b(test|describe|it)\.only\b/, msg: 'test.only leaves the rest of the suite unrun' },
  { id: 'skip', re: /\b(test|describe|it)\.skip\b/, msg: 'test.skip hides a test instead of fixing it' },
  { id: 'fixme', re: /\btest\.fixme\b/, msg: 'test.fixme hides a test instead of fixing it' },
  { id: 'tautology', re: /expect\(\s*(true|1|'.*?')\s*\)\s*\.toBe\(\s*(true|1|'.*?')\s*\)/, msg: 'tautological assertion asserts nothing' },
  { id: 'waitForTimeout', re: /waitForTimeout\s*\(/, msg: 'waitForTimeout instead of waiting for a condition' },

  // --- Tolerances in money comparisons (REQ-36) ---
  { id: 'toBeCloseTo', re: /\.toBeCloseTo\s*\(/, msg: 'REQ-36: money is compared as exact integer kopecks' },
  { id: 'absDiff', re: /Math\.abs\s*\([^)]*\)\s*<=?/, msg: 'REQ-36: Math.abs(a - b) < eps is a tolerance' },
  { id: 'epsilon', re: /\b(epsilon|EPSILON|tolerance|delta)\b/, msg: 'REQ-36: tolerance identifiers have no place in money checks' },
  { id: 'roundInCompare', re: /\.(toBe|toEqual)\s*\(\s*(Math\.(round|floor|ceil)|[\w.]+\.toFixed)\s*\(/, msg: 'REQ-36: rounding before comparison hides a kopeck' },

  // --- Type assertions (added after session 2, see D-17) ---
  { id: 'asAny', re: /\bas\s+any\b/, msg: 'as any silences the compiler; see D-17' },
  { id: 'asUnknownAs', re: /\bas\s+unknown\s+as\b/, msg: 'as unknown as silences the compiler; see D-17' },
];

/**
 * Documented exception (CLAUDE.md 4.5): validation tests must pass a value of the
 * wrong type on purpose. Allowed only inside a helper carrying this marker comment.
 */
const EXCEPTION_MARKER = 'forbidden-check: allow-type-assertion';

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/**
 * This file necessarily contains every forbidden pattern — as regular expressions.
 * Checking itself would make the hook permanently red, so it is excluded by name.
 * Nothing else is exempt.
 */
const SELF = 'check-forbidden.mjs';

function targetFiles(explicit) {
  const list = explicit.length > 0 ? explicit : stagedFiles();
  return list.filter(
    (f) => /\.(ts|mts|mjs)$/.test(f) && !f.endsWith(SELF) && fs.existsSync(f),
  );
}

const files = targetFiles(process.argv.slice(2));
const findings = [];

for (const file of files) {
  const isTest = file.split(path.sep).includes('tests');
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    // A line that only talks about a pattern in prose is not a use of it.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;

      // Type assertions are allowed in a helper explicitly marked for it.
      if ((rule.id === 'asAny' || rule.id === 'asUnknownAs')) {
        const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (window.includes(EXCEPTION_MARKER)) continue;
      }

      // Tolerance rules only bite in test code, where money is asserted.
      if (['epsilon', 'absDiff'].includes(rule.id) && !isTest) continue;

      findings.push({ file, line: i + 1, rule, text: trimmed });
    }
  });
}

if (findings.length > 0) {
  console.error('\nCommit blocked: forbidden patterns found (CLAUDE.md rule 4.5)\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule.id}]  ${f.rule.msg}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    '\nFix the cause. Do not bypass with --no-verify: the rule exists because\n' +
      'each of these patterns has already hidden a real defect in this project.\n',
  );
  process.exit(1);
}

console.log(`forbidden-pattern check: ${files.length} file(s) clean`);
