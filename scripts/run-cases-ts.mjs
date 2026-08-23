/**
 * Runs oracle/cases.json through the TypeScript core and writes the results
 * to oracle/ts-results.json, so oracle/compare.py can diff them against the
 * Python reference.
 *
 * Cross-platform on purpose (CLAUDE.md rule 3): pure node, path.join
 * everywhere, no shell utilities.
 *
 * Usage: node scripts/run-cases-ts.mjs
 * Requires: npm run build (dist/core/index.js must exist)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const corePath = path.join(root, 'dist', 'core', 'index.js');
if (!fs.existsSync(corePath)) {
  console.error(`Core build not found at ${corePath}. Run: npm run build`);
  process.exit(2);
}

const { calculateCredit } = require(corePath);

const casesPath = path.join(root, 'oracle', 'cases.json');
const outPath = path.join(root, 'oracle', 'ts-results.json');

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

/** The Python side speaks snake_case; the contract (REQ-38) is camelCase. */
function toCamelInput(c) {
  return {
    amount: c.amount,
    annualRatePercent: c.annual_rate_percent,
    termMonths: c.term_months,
    insurance:
      c.insurance === null || c.insurance === undefined
        ? null
        : { annualRatePercent: c.insurance.annual_rate_percent },
    earlyRepayments: (c.early_repayments ?? []).map((e) => ({
      month: e.month,
      amount: e.amount,
      mode: e.mode,
    })),
  };
}

const results = cases.map((c) => calculateCredit(toCamelInput(c)));

fs.writeFileSync(outPath, JSON.stringify(results), 'utf8');

const ok = results.filter((r) => r.ok).length;
console.log(`cases:      ${results.length}`);
console.log(`ok:         ${ok}`);
console.log(`errors:     ${results.length - ok}`);
console.log(`written:    ${outPath}`);
