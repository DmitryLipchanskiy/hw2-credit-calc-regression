/**
 * Pre-push scan: secrets, personal data, and references to the user's work.
 *
 * Implements CLAUDE.md rule 6 mechanically, so that "I checked" is a command with
 * output rather than a claim. Scans the working tree and, with --history, the whole
 * commit history — because after a push to a public repository, cleaning is too late.
 *
 * Two sources of patterns:
 *   1. Built-in rules below: tokens, keys, private-key headers, e-mail addresses.
 *      Versioned, safe to publish — they describe shapes, not values.
 *   2. .private-denylist.txt: names of the user's work projects, one per line.
 *      NEVER committed (first line of .gitignore). Missing file is not an error:
 *      on another machine or in CI the scan simply runs without it.
 *
 * The denylist values are never printed. A hit reports the file, the line number
 * and a masked form — printing the matched word would defeat the entire purpose.
 *
 * Cross-platform (CLAUDE.md rule 3): pure node, no grep, path.join everywhere.
 *
 * Usage:
 *   node scripts/check-secrets.mjs            # working tree
 *   node scripts/check-secrets.mjs --history  # working tree + full history
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const DENYLIST_FILE = '.private-denylist.txt';

const BUILTIN = [
  { id: 'github-token', re: /\b(gho_|ghp_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{16,}/, msg: 'GitHub token' },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}/, msg: 'API key' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, msg: 'AWS access key' },
  { id: 'private-key', re: /BEGIN\s+[A-Z ]*PRIVATE KEY/, msg: 'private key block' },
  { id: 'assignment', re: /\b(api[_-]?key|secret|password|passwd)\s*[:=]\s*["'][^"']{6,}/i, msg: 'credential assignment' },
  {
    id: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    msg: 'e-mail address',
    // noreply addresses are deliberate and public by design
    allow: /(users\.noreply\.github\.com|noreply@anthropic\.com|example\.(com|org))/,
  },
];

/** Masks a hit so the finding is actionable without republishing the value. */
function mask(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return `${word[0]}${'*'.repeat(word.length - 2)}${word[word.length - 1]}`;
}

function loadDenylist() {
  const file = path.resolve(process.cwd(), DENYLIST_FILE);
  if (!fs.existsSync(file)) return null;
  const words = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return words.length > 0 ? words : null;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const denylist = loadDenylist();
const findings = [];

function scanText(where, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of BUILTIN) {
      const m = line.match(rule.re);
      if (!m) continue;
      if (rule.allow && rule.allow.test(m[0])) continue;
      findings.push({ where, line: i + 1, id: rule.id, msg: rule.msg, shown: mask(m[0]) });
    }
    if (denylist !== null) {
      for (const word of denylist) {
        if (line.toLowerCase().includes(word.toLowerCase())) {
          // The matched word is NOT recorded — not even masked. A mask still leaks
          // the length and the first and last character, and the whole point of the
          // denylist is that its contents never leave the local machine. The finding
          // carries the location; the user opens that line and sees what it is.
          findings.push({
            where,
            line: i + 1,
            id: 'work-reference',
            msg: 'reference to a work project (local denylist) — value withheld by design',
            shown: null,
          });
        }
      }
    }
  });
}

// --- working tree ---
for (const file of trackedFiles()) {
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  scanText(file, fs.readFileSync(file, 'utf8'));
}

// --- history ---
if (process.argv.includes('--history')) {
  const log = execFileSync('git', ['log', '-p', '--all', '--no-color'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  scanText('<git history>', log);
}

console.log(
  denylist === null
    ? `${DENYLIST_FILE} not found — local word list skipped, built-in rules only`
    : `${DENYLIST_FILE} loaded — ${denylist.length} entr${denylist.length === 1 ? 'y' : 'ies'} (values not printed)`,
);

if (findings.length > 0) {
  console.error(`\nFound ${findings.length} item(s) needing a decision:\n`);
  for (const f of findings) {
    const tail = f.shown === null ? '' : `: ${f.shown}`;
    console.error(`  ${f.where}:${f.line}  [${f.id}]  ${f.msg}${tail}`);
  }
  console.error('\nNothing was removed. Review each item and decide before pushing.\n');
  process.exit(1);
}

console.log('scan clean: no secrets, no work references');
