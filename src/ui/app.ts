/**
 * UI layer. REQ-28…REQ-33.
 *
 * Deliberately thin: it reads the form, hands a CreditInput to the core and renders
 * whatever comes back. No arithmetic of its own beyond rubles<->kopecks conversion and
 * formatting — every number on screen is produced by src/core and only formatted here.
 * Nothing in this file may be imported by the core.
 */

import { calculateCredit } from '../core';
import type {
  CreditInput,
  EarlyRepaymentInput,
  EarlyRepaymentMode,
  ScheduleRow,
  ValidationCode,
} from '../core';

/** REQ-30: non-breaking space as the thousands separator, comma before kopecks. */
const NBSP = ' ';

/** REQ-31: text is for humans, `data-error-code` is for the tests. */
const ERROR_MESSAGES: Record<ValidationCode, string> = {
  AMOUNT_NOT_INTEGER: 'Сумма кредита должна быть целым числом копеек.',
  AMOUNT_OUT_OF_RANGE: 'Сумма кредита должна быть от 10 000 ₽ до 100 000 000 ₽.',
  RATE_OUT_OF_RANGE: 'Ставка должна быть от 0 до 100 % годовых.',
  RATE_TOO_PRECISE: 'У ставки не более двух знаков после запятой.',
  TERM_NOT_INTEGER: 'Срок должен быть целым числом месяцев.',
  TERM_OUT_OF_RANGE: 'Срок должен быть от 1 до 360 месяцев.',
  NOT_A_NUMBER: 'Одно из числовых полей заполнено не числом.',
  INSURANCE_RATE_OUT_OF_RANGE: 'Ставка страховки должна быть от 0 до 10 % годовых.',
  EARLY_MONTH_OUT_OF_RANGE: 'Месяц досрочного погашения выходит за срок кредита.',
  EARLY_AMOUNT_NOT_POSITIVE: 'Сумма досрочного погашения должна быть целым числом копеек больше нуля.',
  EARLY_MODE_UNKNOWN: 'Неизвестный режим досрочного погашения.',
  EARLY_DUPLICATE_MONTH: 'В одном месяце допускается не более одного досрочного погашения.',
};

// ---------------------------------------------------------------------------
// DOM access. Every lookup is by data-testid (REQ-32) and narrows with instanceof
// rather than a type assertion — `as` in this project has already hidden two real
// defects (CLAUDE.md 4.5, D-17), and the same argument applies outside the tests.
// ---------------------------------------------------------------------------

function elementIn(root: ParentNode, testId: string): HTMLElement {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`no element with data-testid="${testId}"`);
  }
  return node;
}

function inputIn(root: ParentNode, testId: string): HTMLInputElement {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLInputElement)) {
    throw new Error(`no <input> with data-testid="${testId}"`);
  }
  return node;
}

function selectIn(root: ParentNode, testId: string): HTMLSelectElement {
  const node = root.querySelector(`[data-testid="${testId}"]`);
  if (!(node instanceof HTMLSelectElement)) {
    throw new Error(`no <select> with data-testid="${testId}"`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Parsing and formatting. The only place in the project where rubles exist (REQ-01).
// ---------------------------------------------------------------------------

function normalizeNumeric(raw: string): string {
  return raw.replace(/\s/g, '').replace(',', '.');
}

/** Empty input is not zero: it is "not a number", so the core answers NOT_A_NUMBER. */
function parseNumberField(raw: string): number {
  const text = normalizeNumeric(raw);
  if (text === '') return Number.NaN;
  return Number(text);
}

/**
 * Rubles as typed by a human -> integer kopecks.
 *
 * Not `Number(text) * 100`: that gives 1234566.9999999998 for "12345.67", and the core
 * would reject a perfectly valid amount as AMOUNT_NOT_INTEGER. Splitting the string
 * keeps two-decimal input exact, while input finer than a kopeck still produces a
 * non-integer on purpose — otherwise AMOUNT_NOT_INTEGER would be unreachable from the UI.
 */
function parseRublesToKopecks(raw: string): number {
  const text = normalizeNumeric(raw);
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return Number.NaN;

  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? '' : body.slice(dot + 1);

  const wholeKopecks = (whole === '' ? 0 : Number(whole)) * 100;
  const fractionKopecks =
    fraction.length <= 2
      ? fraction === ''
        ? 0
        : Number(fraction.padEnd(2, '0'))
      : Number(`0.${fraction}`) * 100;

  const total = wholeKopecks + fractionKopecks;
  return negative ? -total : total;
}

/** REQ-30: `1 234 567,89 ₽`, with U+00A0 both between digit groups and before the sign. */
export function formatMoney(kopecks: number): string {
  if (!Number.isFinite(kopecks)) return '—';
  const sign = kopecks < 0 ? '-' : '';
  const absolute = Math.abs(kopecks);
  const rubles = Math.floor(absolute / 100);
  const remainder = Math.round(absolute - rubles * 100);
  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${sign}${grouped},${String(remainder).padStart(2, '0')}${NBSP}₽`;
}

function formatMonths(count: number): string {
  return `${count}${NBSP}мес.`;
}

// ---------------------------------------------------------------------------
// Early repayment rows
// ---------------------------------------------------------------------------

/**
 * Rows carry a stable data-index so a test can address one without counting siblings
 * (REQ-32 forbids position-based selectors). The counter never decreases, so removing
 * a row does not renumber the others out from under a running test.
 */
let nextEarlyIndex = 0;

function earlyRowTemplate(): HTMLTemplateElement {
  const node = document.querySelector('[data-testid="early-row-template"]');
  if (!(node instanceof HTMLTemplateElement)) {
    throw new Error('no <template data-testid="early-row-template">');
  }
  return node;
}

function addEarlyRow(): HTMLElement {
  const list = elementIn(document, 'early-list');
  const source = earlyRowTemplate().content.firstElementChild;
  if (!(source instanceof HTMLElement)) {
    throw new Error('early row template is empty');
  }
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error('cloning the early row template produced a non-element');
  }
  clone.dataset['index'] = String(nextEarlyIndex);
  nextEarlyIndex += 1;

  elementIn(clone, 'early-remove').addEventListener('click', () => {
    clone.remove();
  });

  list.append(clone);
  return clone;
}

function readEarlyRepayments(): EarlyRepaymentInput[] {
  // Array.from, not `for (const row of nodes)`: iterating a NodeList needs the
  // DOM.Iterable lib, and the root tsconfig (which type-checks this file in CI) does
  // not enable it. Not this branch's file to change.
  const rows = Array.from(
    elementIn(document, 'early-list').querySelectorAll('[data-testid="early-row"]'),
  );
  const result: EarlyRepaymentInput[] = [];
  for (const row of rows) {
    result.push({
      month: parseNumberField(inputIn(row, 'early-month').value),
      amount: parseRublesToKopecks(inputIn(row, 'early-amount').value),
      mode: readMode(selectIn(row, 'early-mode').value),
    });
  }
  return result;
}

/**
 * The <select> offers exactly the two documented modes, so EARLY_MODE_UNKNOWN is not
 * reachable through this UI. That code is covered at the core level instead; narrowing
 * here keeps the UI free of type assertions.
 */
function readMode(value: string): EarlyRepaymentMode {
  return value === 'reducePayment' ? 'reducePayment' : 'reduceTerm';
}

// ---------------------------------------------------------------------------
// Reading the form and rendering the answer
// ---------------------------------------------------------------------------

function readForm(): CreditInput {
  const insuranceEnabled = inputIn(document, 'insurance-enabled').checked;
  return {
    amount: parseRublesToKopecks(inputIn(document, 'amount').value),
    annualRatePercent: parseNumberField(inputIn(document, 'rate').value),
    termMonths: parseNumberField(inputIn(document, 'term').value),
    insurance: insuranceEnabled
      ? { annualRatePercent: parseNumberField(inputIn(document, 'insurance-rate').value) }
      : null,
    earlyRepayments: readEarlyRepayments(),
  };
}

function renderErrors(codes: readonly ValidationCode[]): void {
  const list = elementIn(document, 'errors');
  list.replaceChildren();
  for (const code of codes) {
    const item = document.createElement('li');
    item.dataset['errorCode'] = code;
    item.dataset['testid'] = 'error';
    item.textContent = ERROR_MESSAGES[code];
    list.append(item);
  }
  list.hidden = false;

  // REQ-31: the schedule is not merely stale, it is not on the page at all.
  //
  // Hiding the section was not enough. The rows of the previous, successful calculation
  // survived inside it — invisible, but present in the DOM and still carrying the old
  // numbers. `toBeHidden` was satisfied while `toHaveCount(0)` was not; the red phase of
  // session 3 caught it. Old figures a query can still reach are exactly what REQ-31 is
  // written against, so the body is emptied rather than merely covered up.
  elementIn(document, 'schedule-body').replaceChildren();
  elementIn(document, 'ignored-list').replaceChildren();
  elementIn(document, 'ignored-early').hidden = true;
  elementIn(document, 'result').hidden = true;
}

function scheduleCell(row: HTMLTableRowElement, testId: string, text: string): void {
  const cell = document.createElement('td');
  cell.dataset['testid'] = testId;
  cell.textContent = text;
  row.append(cell);
}

function renderSchedule(schedule: readonly ScheduleRow[]): void {
  const body = elementIn(document, 'schedule-body');
  body.replaceChildren();
  for (const entry of schedule) {
    const row = document.createElement('tr');
    row.dataset['testid'] = 'schedule-row';
    row.dataset['month'] = String(entry.month);
    scheduleCell(row, 'cell-month', String(entry.month));
    scheduleCell(row, 'cell-payment', formatMoney(entry.paymentTotal));
    scheduleCell(row, 'cell-interest', formatMoney(entry.interest));
    scheduleCell(row, 'cell-principal', formatMoney(entry.principal));
    scheduleCell(row, 'cell-insurance', formatMoney(entry.insurance));
    scheduleCell(row, 'cell-early', formatMoney(entry.earlyRepaymentApplied));
    scheduleCell(row, 'cell-balance', formatMoney(entry.balanceAfter));
    body.append(row);
  }
}

function render(): void {
  const result = calculateCredit(readForm());

  if (!result.ok) {
    renderErrors(result.errors);
    return;
  }

  elementIn(document, 'errors').hidden = true;

  const totals = result.totals;
  elementIn(document, 'monthly-payment').textContent = formatMoney(totals.monthlyPayment);
  elementIn(document, 'actual-term').textContent = formatMonths(totals.actualTermMonths);
  elementIn(document, 'total-paid').textContent = formatMoney(totals.totalPaid);
  elementIn(document, 'overpayment').textContent = formatMoney(totals.overpayment);

  const ignoredBlock = elementIn(document, 'ignored-early');
  const ignoredList = elementIn(document, 'ignored-list');
  ignoredList.replaceChildren();
  for (const ignored of totals.ignoredEarlyRepayments) {
    const item = document.createElement('li');
    item.dataset['testid'] = 'ignored-item';
    item.dataset['month'] = String(ignored.month);
    item.textContent = `Месяц ${ignored.month}: ${formatMoney(ignored.amount)} — кредит уже закрыт.`;
    ignoredList.append(item);
  }
  ignoredBlock.hidden = totals.ignoredEarlyRepayments.length === 0;

  renderSchedule(result.schedule);
  elementIn(document, 'result').hidden = false;
}

function start(): void {
  const form = elementIn(document, 'form');
  // REQ-29: the button, and only the button. No input/change listener recalculates.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    render();
  });
  elementIn(document, 'early-add').addEventListener('click', () => {
    addEarlyRow();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
