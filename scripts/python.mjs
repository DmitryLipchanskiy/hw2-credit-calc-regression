/**
 * Cross-platform Python launcher.
 *
 * macOS/Linux ship `python3` and usually have no `python` at all.
 * Windows ships `python` and has no `python3`. Hard-coding either name breaks
 * one of the two CI legs — this is the exact failure that cost a whole session
 * on the previous assignment, and CLAUDE.md rule 3 exists because of it.
 *
 * Probes the candidates in order and runs the first one that answers.
 *
 * Usage: node scripts/python.mjs <script.py> [args...]
 */

import { spawnSync } from 'node:child_process';

const CANDIDATES = ['python3', 'python', 'py'];

function findInterpreter() {
  for (const name of CANDIDATES) {
    const probe = spawnSync(name, ['--version'], { encoding: 'utf8', shell: false });
    if (probe.status === 0) {
      return { name, version: (probe.stdout || probe.stderr).trim() };
    }
  }
  return null;
}

const found = findInterpreter();

if (found === null) {
  console.error(
    `No Python interpreter found. Tried: ${CANDIDATES.join(', ')}.\n` +
      'Install Python 3.9 or newer and make sure it is on PATH.',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/python.mjs <script.py> [args...]');
  process.exit(2);
}

console.log(`using ${found.name} (${found.version})`);

const run = spawnSync(found.name, args, { stdio: 'inherit', shell: false });
process.exit(run.status ?? 1);
