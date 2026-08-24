/**
 * Regression run driven by changes ("прогон по изменениям").
 *
 * Procedure (docs/plan.md, S4 -> "Workflow"):
 *
 *   diff since the last run (tag `last-run`)
 *     -> map changed files onto spec.md areas (REQ-NN)
 *     -> select the affected checks plus smoke
 *     -> run them
 *     -> write reports/run-<date>.md
 *     -> move the `last-run` tag onto HEAD
 *
 * Cross-platform by construction (CLAUDE.md rule 3): pure node, no shell pipelines,
 * no `&&`, no rm/cp/curl, every child process spawned with shell:false and every
 * path built with path.join. Playwright is invoked through its JS entry point
 * (node_modules/@playwright/test/cli.js) rather than node_modules/.bin — the .bin
 * shim is a .cmd file on Windows and cannot be spawned without a shell.
 *
 * Usage:
 *   node scripts/regression-run.mjs [--base=<ref>] [--no-tag] [--tag=<name>]
 *
 * Exit code is 0 only when tests actually ran AND nothing failed. A run that
 * executed zero tests is reported as a failure, not as "всё зелёное"
 * (CLAUDE.md rule 4.4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_JSON = path.join(ROOT, 'test-results', 'results.json');
const PLAYWRIGHT_CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
let baseOverride = null;
let tagName = 'last-run';
let doTag = true;

for (const arg of argv) {
  if (arg.startsWith('--base=')) baseOverride = arg.slice('--base='.length);
  else if (arg.startsWith('--tag=')) tagName = arg.slice('--tag='.length);
  else if (arg === '--no-tag') doTag = false;
  else {
    console.error(`Unknown argument: ${arg}`);
    console.error('Usage: node scripts/regression-run.mjs [--base=<ref>] [--no-tag] [--tag=<name>]');
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const log = [];
function say(line = '') {
  log.push(line);
  console.log(line);
}

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (r.error) {
    if (allowFail) return { ok: false, out: '', code: -1 };
    console.error(`git ${args.join(' ')} could not be started: ${r.error.message}`);
    process.exit(2);
  }
  const out = `${r.stdout ?? ''}`.trim();
  if (r.status !== 0 && !allowFail) {
    console.error(`git ${args.join(' ')} failed:\n${r.stderr}`);
    process.exit(2);
  }
  return { ok: r.status === 0, out, code: r.status };
}

function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).ok;
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

const req = (n) => `REQ-${String(n).padStart(2, '0')}`;

/* ------------------------------------------------------------------ */
/* The mapping table: changed path -> area of checks                   */
/* ------------------------------------------------------------------ */

/**
 * `match` entries are path prefixes in posix form. A directory prefix ends with `/`.
 * `reqs` are requirement numbers from docs/spec.md; they select tests by title,
 * because every test in this project is titled with the REQ-NN / INV-NN it covers.
 */
const AREAS = [
  {
    id: 'core-round',
    title: 'Округление и представление денег',
    match: ['src/core/round.ts'],
    reqs: [1, 2, 3, 4, 36],
    invariants: true,
  },
  {
    id: 'core-validate',
    title: 'Валидация входа',
    match: ['src/core/validate.ts'],
    reqs: range(6, 10),
  },
  {
    id: 'core-schedule',
    title: 'График, страховка, досрочное погашение, итоги',
    match: ['src/core/schedule.ts'],
    reqs: [...range(11, 27), 37],
    invariants: true,
  },
  {
    id: 'core-contract',
    title: 'Публичный контракт ядра',
    match: ['src/core/index.ts', 'src/core/types.ts'],
    full: true,
  },
  {
    id: 'ui',
    title: 'Форма калькулятора',
    match: ['src/ui/'],
    reqs: range(28, 33),
    project: 'e2e',
  },
  {
    id: 'oracle',
    title: 'Кросс-проверка TS <-> Python',
    match: ['oracle/'],
    crossCheck: true,
  },
  {
    id: 'tests',
    title: 'Сами проверки',
    match: ['tests/'],
    full: true,
  },
  {
    id: 'infra',
    title: 'Инфраструктура прогона',
    match: [
      'playwright.config.ts',
      'tsconfig.json',
      'tsconfig.build.json',
      'package.json',
      'package-lock.json',
      'eslint.config.mjs',
      'scripts/',
      '.github/',
      '.githooks/',
    ],
    full: true,
  },
  {
    id: 'docs',
    title: 'Документы и служебные файлы',
    match: [
      'docs/',
      'sessions/',
      'reports/',
      '.claude/',
      'README.md',
      'REPORT.md',
      'CLAUDE.md',
      '.gitignore',
    ],
    noTests: true,
  },
];

/**
 * Smoke: runs on every invocation, whatever changed. Deliberately small and
 * deliberately central — the annuity payment itself, the last correcting payment,
 * the schedule invariants and the totals.
 */
const SMOKE_REQS = [5, 12, 16, 26];

function areaFor(file) {
  for (const area of AREAS) {
    for (const prefix of area.match) {
      if (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix) return area;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Step 1 — base of comparison                                         */
/* ------------------------------------------------------------------ */

const startedAt = new Date();

say('=== Регрессионный прогон по изменениям ===');
say(`Каталог:  ${ROOT}`);
say(`Начало:   ${startedAt.toISOString()}`);
say();

const headSha = git(['rev-parse', 'HEAD']).out;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;

let base;
let baseKind;
if (baseOverride !== null) {
  if (!refExists(baseOverride)) {
    console.error(`--base=${baseOverride}: такой ref не существует`);
    process.exit(2);
  }
  base = baseOverride;
  baseKind = `указан вручную (--base=${baseOverride})`;
} else if (refExists(`refs/tags/${tagName}`)) {
  base = `refs/tags/${tagName}`;
  baseKind = `тег ${tagName} с прошлого прогона`;
} else if (refExists('refs/heads/main')) {
  base = 'refs/heads/main';
  baseKind = `тега ${tagName} нет — последний коммит на main`;
} else if (refExists('refs/remotes/origin/main')) {
  base = 'refs/remotes/origin/main';
  baseKind = `тега ${tagName} и локальной main нет — origin/main`;
} else {
  base = 'HEAD';
  baseKind = 'ни тега, ни main — сравнивать не с чем, база = HEAD';
}

const baseSha = git(['rev-parse', base]).out;
const baseDescribed = git(['log', '-1', '--format=%h %s', baseSha]).out;

say('--- Шаг 1. База сравнения ---');
say(`Ветка:    ${branch}`);
say(`HEAD:     ${headSha}`);
say(`База:     ${baseSha}`);
say(`Основание: ${baseKind}`);
say(`Коммит базы: ${baseDescribed}`);
say();

/* ------------------------------------------------------------------ */
/* Step 2 — changed files                                              */
/* ------------------------------------------------------------------ */

const committed =
  baseSha === headSha
    ? []
    : git(['diff', '--name-only', baseSha, 'HEAD']).out.split('\n').filter(Boolean);

// Uncommitted work counts too: a run that silently ignored the working tree would
// report on code that is not the code on disk.
const dirty = git(['status', '--porcelain'])
  .out.split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

const changed = [...new Set([...committed, ...dirty])].sort();

say('--- Шаг 2. Изменённые файлы ---');
say(`git diff --name-only ${baseSha.slice(0, 12)} HEAD  ->  ${committed.length} файл(ов)`);
say(`git status --porcelain (незакоммиченное)          ->  ${dirty.length} файл(ов)`);
if (changed.length === 0) say('(изменений нет)');
for (const f of changed) say(`  ${f}`);
say();

/* ------------------------------------------------------------------ */
/* Step 3 — map onto areas of checks                                   */
/* ------------------------------------------------------------------ */

const matched = new Map(); // area.id -> { area, files: [] }
const unmapped = [];

for (const file of changed) {
  const area = areaFor(file);
  if (area === null) {
    unmapped.push(file);
    continue;
  }
  if (!matched.has(area.id)) matched.set(area.id, { area, files: [] });
  matched.get(area.id).files.push(file);
}

const testAreas = [...matched.values()].filter((m) => !m.area.noTests);
const needFull = testAreas.some((m) => m.area.full) || unmapped.length > 0;
const needCrossCheck = testAreas.some((m) => m.area.crossCheck);
const e2eArea = testAreas.find((m) => m.area.project === 'e2e') ?? null;

const affectedReqs = new Set();
let needInvariants = false;
for (const { area } of testAreas) {
  for (const n of area.reqs ?? []) affectedReqs.add(req(n));
  if (area.invariants) needInvariants = true;
}

say('--- Шаг 3. Сопоставление с областями проверок ---');
if (matched.size === 0 && unmapped.length === 0) {
  say('Ни один файл не изменился — сопоставлять нечего.');
}
for (const { area, files } of matched.values()) {
  const target = area.full
    ? 'полный прогон'
    : area.crossCheck
      ? 'кросс-проверка TS <-> Python'
      : area.noTests
        ? 'проверок не требует'
        : [...(area.reqs ?? []).map(req), ...(area.invariants ? ['все инварианты INV-*'] : [])].join(', ');
  say(`  [${area.id}] ${area.title}`);
  say(`      файлы: ${files.join(', ')}`);
  say(`      область: ${target}`);
}
if (unmapped.length > 0) {
  say('  [!] файлы вне таблицы соответствия — трактуются консервативно, как полный прогон:');
  for (const f of unmapped) say(`      ${f}`);
}
say();

/* ------------------------------------------------------------------ */
/* Step 4 — run the affected checks plus smoke                         */
/* ------------------------------------------------------------------ */

const smokeIds = SMOKE_REQS.map(req);
const selectedIds = [...new Set([...affectedReqs, ...smokeIds])].sort();
const grepParts = [...selectedIds];
if (needInvariants) grepParts.push('INV-');

const stages = [];
if (needFull) {
  stages.push({
    name: 'полный прогон',
    why: 'изменения затронули область, локализовать которую нельзя',
    args: ['test'],
  });
} else {
  stages.push({
    name: 'затронутое + smoke',
    why: `выбор по заголовкам тестов: ${grepParts.join(' | ')}`,
    args: ['test', '--grep', grepParts.join('|')],
  });
}

/**
 * Projects declared in playwright.config.ts. Read from the file rather than by
 * booting Playwright: this is only used to say honestly whether an e2e project
 * exists at all, and a wrong guess here must not fail the run.
 */
function declaredProjects() {
  const cfg = path.join(ROOT, 'playwright.config.ts');
  if (!fs.existsSync(cfg)) return [];
  const text = fs.readFileSync(cfg, 'utf8');
  return [...text.matchAll(/name:\s*['"]([\w-]+)['"]/g)].map((m) => m[1]);
}

const projects = declaredProjects();
const notes = [];

if (e2eArea !== null && !needFull) {
  if (projects.includes('e2e')) {
    stages.push({
      name: 'проект e2e',
      why: 'изменилась форма (src/ui/**)',
      args: ['test', '--project', 'e2e'],
    });
  } else {
    notes.push(
      'Изменения затронули src/ui/**, но проект `e2e` в playwright.config.ts не объявлен — ' +
        'браузерные сценарии не прогонялись. Это дыра, а не «нечего проверять».',
    );
  }
}

function runPlaywright(stage) {
  say(`> node ${path.relative(ROOT, PLAYWRIGHT_CLI)} ${stage.args.join(' ')}`);
  if (fs.existsSync(RESULTS_JSON)) fs.rmSync(RESULTS_JSON);

  const r = spawnSync(process.execPath, [PLAYWRIGHT_CLI, ...stage.args], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
  for (const line of output.split('\n')) say(`  | ${line}`);
  return { exitCode: r.status, counts: readCounts() };
}

/**
 * Playwright's JSON reporter records outcomes, not statuses: a passing test is
 * "expected", a failing one "unexpected". Mapping them by name would silently
 * produce zeros — the exact false green rule 4.4 forbids.
 */
const OUTCOME = { expected: 'passed', unexpected: 'failed', skipped: 'skipped', flaky: 'flaky' };

function readCounts() {
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, other: 0, total: 0, readable: false };
  if (!fs.existsSync(RESULTS_JSON)) return counts;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
  } catch {
    return counts;
  }
  if (!Array.isArray(doc.suites)) return counts;
  counts.readable = true;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) counts[OUTCOME[t.status] ?? 'other'] += 1;
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of doc.suites) walk(suite);
  counts.total = counts.passed + counts.failed + counts.skipped + counts.flaky + counts.other;
  return counts;
}

say('--- Шаг 4. Прогон ---');
if (testAreas.length === 0 && unmapped.length === 0) {
  say('Изменения не затронули ни одной области проверок (или изменений нет вовсе).');
  say('Полный прогон не требовался — прогоняется только smoke.');
  say();
}

const problems = [];
const stageResults = [];

for (const stage of stages) {
  say(`[${stage.name}] ${stage.why}`);
  const res = runPlaywright(stage);
  stageResults.push({ stage, ...res });
  const c = res.counts;
  if (!c.readable) {
    problems.push(`[${stage.name}] отчёт test-results/results.json не прочитан — прогон не доказан`);
  }
  say(
    `[${stage.name}] итог: ${c.total} всего — ${c.passed} passed, ${c.failed} failed, ` +
      `${c.skipped} skipped, ${c.flaky} flaky (exit ${res.exitCode})`,
  );
  say();
}

const totals = { passed: 0, failed: 0, skipped: 0, flaky: 0, other: 0, total: 0 };
for (const r of stageResults) {
  for (const k of Object.keys(totals)) totals[k] += r.counts[k];
}

if (totals.total === 0) problems.push('прогон выполнил ноль тестов — это провал, а не «всё зелёное»');
if (totals.passed === 0) problems.push('ни один тест не прошёл');
if (totals.failed > 0) problems.push(`упало тестов: ${totals.failed}`);
if (totals.skipped > 0) problems.push(`пропущено тестов: ${totals.skipped} — назвать их или убрать`);
if (totals.other > 0) problems.push(`${totals.other} тест(ов) с неизвестным исходом — карта исходов устарела`);
for (const r of stageResults) {
  if (r.exitCode !== 0) problems.push(`[${r.stage.name}] playwright вернул код ${r.exitCode}`);
}

/* ---- cross-check TS <-> Python, only when oracle/** changed ---- */

const crossSteps = [];
if (needCrossCheck) {
  say('--- Шаг 4a. Кросс-проверка TS <-> Python ---');
  const steps = [
    { title: 'build', argv: [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'] },
    { title: 'oracle:py', argv: [path.join(ROOT, 'scripts', 'python.mjs'), path.join('oracle', 'run_cases.py')] },
    { title: 'oracle:ts', argv: [path.join(ROOT, 'scripts', 'run-cases-ts.mjs')] },
    {
      title: 'oracle:compare',
      argv: [
        path.join(ROOT, 'scripts', 'python.mjs'),
        path.join('oracle', 'compare.py'),
        path.join('oracle', 'ts-results.json'),
        path.join('oracle', 'expected.json'),
      ],
    },
  ];
  for (const step of steps) {
    say(`> node ${step.argv.map((a) => path.relative(ROOT, a) || a).join(' ')}`);
    const r = spawnSync(process.execPath, step.argv, { cwd: ROOT, encoding: 'utf8', shell: false });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    for (const line of out.split('\n')) say(`  | ${line}`);
    crossSteps.push({ title: step.title, code: r.status });
    if (r.status !== 0) problems.push(`кросс-проверка: шаг ${step.title} вернул код ${r.status}`);
  }
  say();
}

/* ------------------------------------------------------------------ */
/* Step 5 — the report file                                            */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
const dateStamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;

const reportsDir = path.join(ROOT, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });

// One file per run: a second run on the same date must not overwrite the first,
// otherwise the trail the procedure exists to leave disappears.
let reportPath = path.join(reportsDir, `run-${dateStamp}.md`);
let n = 1;
while (fs.existsSync(reportPath)) {
  n += 1;
  reportPath = path.join(reportsDir, `run-${dateStamp}-${n}.md`);
}

const verdict = problems.length === 0 ? 'ЗЕЛЁНЫЙ' : 'КРАСНЫЙ';

/* ---- tag ---- */

let tagLine;
if (!doTag) {
  tagLine = `Тег \`${tagName}\` не ставился: запуск с --no-tag.`;
} else if (problems.length > 0) {
  tagLine =
    `Тег \`${tagName}\` **не** переставлен: прогон красный. ` +
    'Тег отмечает последнюю проверенную точку, а не последнюю попытку.';
} else {
  const before = refExists(`refs/tags/${tagName}`) ? git(['rev-parse', `refs/tags/${tagName}`]).out : null;
  git(['tag', '-f', tagName, headSha]);
  tagLine =
    `Тег \`${tagName}\` переставлен на ${headSha}` +
    (before === null ? ' (создан впервые).' : ` (был ${before}).`);
}

const lines = [];
lines.push(`# Регрессионный прогон по изменениям — ${dateStamp}`);
lines.push('');
lines.push('Сформировано `scripts/regression-run.mjs`, один файл на один прогон.');
lines.push('');
lines.push('## 1. Что сравнивалось');
lines.push('');
lines.push('| | |');
lines.push('|---|---|');
lines.push(`| Начало | ${startedAt.toISOString()} |`);
lines.push(`| Ветка | \`${branch}\` |`);
lines.push(`| HEAD | \`${headSha}\` |`);
lines.push(`| База | \`${baseSha}\` |`);
lines.push(`| Как выбрана база | ${baseKind} |`);
lines.push(`| Коммит базы | ${baseDescribed} |`);
lines.push('');
lines.push('## 2. Что изменилось');
lines.push('');
lines.push(`Закоммичено с базы: ${committed.length}. Незакоммичено в рабочем дереве: ${dirty.length}.`);
lines.push('');
if (changed.length === 0) {
  lines.push('Изменений нет.');
} else {
  for (const f of changed) {
    const area = areaFor(f);
    lines.push(`- \`${f}\` → ${area === null ? '**вне таблицы соответствия**' : area.title}`);
  }
}
lines.push('');
lines.push('## 3. Затронутые области');
lines.push('');
if (matched.size === 0 && unmapped.length === 0) {
  lines.push('Ни одной: сопоставлять нечего.');
} else {
  lines.push('| Область | Файлы | Что прогоняется |');
  lines.push('|---|---|---|');
  for (const { area, files } of matched.values()) {
    const target = area.full
      ? 'полный прогон'
      : area.crossCheck
        ? 'кросс-проверка TS ↔ Python'
        : area.noTests
          ? 'проверок не требует'
          : [...(area.reqs ?? []).map(req), ...(area.invariants ? ['INV-*'] : [])].join(', ');
    lines.push(`| ${area.title} | ${files.map((f) => `\`${f}\``).join('<br>')} | ${target} |`);
  }
  if (unmapped.length > 0) {
    lines.push(
      `| **Вне таблицы** | ${unmapped.map((f) => `\`${f}\``).join('<br>')} | полный прогон (консервативно) |`,
    );
  }
}
lines.push('');
if (testAreas.length === 0) {
  lines.push(
    'Ни одна область проверок не затронута — полный прогон **не требовался**. ' +
      'Прогнан только smoke, чтобы прогон не был пустым словом.',
  );
  lines.push('');
}
lines.push('## 4. Что прогонялось');
lines.push('');
lines.push(`Smoke (всегда): ${smokeIds.join(', ')}.`);
if (!needFull) lines.push(`Выбор по заголовкам: \`${grepParts.join('|')}\`.`);
else lines.push('Выбран полный прогон.');
lines.push('');
lines.push('| Этап | Команда | Всего | passed | failed | skipped | flaky | exit |');
lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of stageResults) {
  const c = r.counts;
  lines.push(
    `| ${r.stage.name} | \`node node_modules/@playwright/test/cli.js ${r.stage.args.join(' ')}\` | ` +
      `${c.total} | ${c.passed} | ${c.failed} | ${c.skipped} | ${c.flaky} | ${r.exitCode} |`,
  );
}
lines.push('');
lines.push(
  `**Итого: ${totals.total} тест(ов) — ${totals.passed} passed, ${totals.failed} failed, ` +
    `${totals.skipped} skipped, ${totals.flaky} flaky.**`,
);
lines.push('');
if (crossSteps.length > 0) {
  lines.push('### Кросс-проверка TS ↔ Python');
  lines.push('');
  lines.push('| Шаг | Код возврата |');
  lines.push('|---|---:|');
  for (const s of crossSteps) lines.push(`| ${s.title} | ${s.code} |`);
  lines.push('');
}
lines.push('## 5. Вердикт');
lines.push('');
lines.push(`**${verdict}**`);
lines.push('');
if (problems.length > 0) {
  for (const p of problems) lines.push(`- ${p}`);
  lines.push('');
}
for (const note of notes) lines.push(`> ${note}`);
if (notes.length > 0) lines.push('');
lines.push(`Проекты в playwright.config.ts: ${projects.length > 0 ? projects.join(', ') : '(не найдены)'}.`);
lines.push('');
lines.push('## 6. Метка');
lines.push('');
lines.push(tagLine);
lines.push('');

fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

say('--- Шаг 5. Отчёт ---');
say(`Записан: ${path.relative(ROOT, reportPath)}`);
say();
say('--- Шаг 6. Метка ---');
say(tagLine.replace(/\*\*/g, '').replace(/`/g, ''));
say();
say('--- Итог ---');
say(
  `Всего тестов: ${totals.total} — ${totals.passed} passed, ${totals.failed} failed, ` +
    `${totals.skipped} skipped, ${totals.flaky} flaky`,
);
for (const note of notes) say(`Замечание: ${note}`);
if (problems.length > 0) {
  say(`Вердикт: ${verdict}`);
  for (const p of problems) say(`  - ${p}`);
  process.exit(1);
}
say(`Вердикт: ${verdict}`);
