/**
 * Tests added in response to the skeptic's report (session 3).
 *
 * They live in their own file rather than inside base.spec.ts / scenarios.spec.ts
 * on purpose: it must stay visible which checks existed before the audit and which
 * were written because an audit found them missing.
 *
 * Every mutation named below survived all 156 tests of the original suite. Each test
 * here is anchored to a value in docs/oracle.md computed outside our implementation
 * (FV/PMT, or a single division) — not to whatever the code happens to return.
 *
 * See docs/mutations.md and sessions/session-3-skeptic.md.
 */

import { test, expect } from '@playwright/test';

import { calculateCredit } from '../../src/core';
import type { CreditInput, ScheduleRow } from '../../src/core';
import { checkInvariants } from './invariants';

const rub = (rubles: number): number => rubles * 100;

const BASE: CreditInput = {
  amount: rub(1_000_000),
  annualRatePercent: 12,
  termMonths: 60,
  insurance: null,
  earlyRepayments: [],
};

function run(source: CreditInput) {
  const result = calculateCredit(source);
  if (!result.ok) {
    throw new Error(`calculateCredit rejected a valid input: ${JSON.stringify(result)}`);
  }
  checkInvariants(source, result);
  return result;
}

function rowOf(schedule: ScheduleRow[], month: number): ScheduleRow {
  const found = schedule.find((r) => r.month === month);
  if (!found) throw new Error(`schedule has no month ${month}`);
  return found;
}

/* ================================================================== *
 * M-02, M-10, M-11 — the recomputed payment was pinned by nothing.
 *
 * All three mutations shifted the payment recomputed after a reducePayment
 * repayment (by a kopeck, by 1000 rubles, by one period) and all 156 tests
 * stayed green: the corrective final payment (REQ-05) absorbs any error, and
 * every REQ-22 check was written as a relation rather than a number.
 * ================================================================== */

/** O-06: FV + PMT, computed outside this codebase. 16 977,68 RUB. */
const O06_REDUCED_PAYMENT = 1_697_768;

/** O-05: term after reduceTerm, verified by an independent simulation. */
const O05_TERM_AFTER_REDUCE_TERM = 47;

const REDUCE_PAYMENT_12: CreditInput = {
  ...BASE,
  earlyRepayments: [{ month: 12, amount: rub(200_000), mode: 'reducePayment' }],
};

const REDUCE_TERM_12: CreditInput = {
  ...BASE,
  earlyRepayments: [{ month: 12, amount: rub(200_000), mode: 'reduceTerm' }],
};

test('REQ-22 (O-06): the payment recomputed after reducePayment equals the external anchor', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(rowOf(result.schedule, 13).paymentTotal).toBe(O06_REDUCED_PAYMENT);
});

test('REQ-22 (O-06): the recomputed payment holds through to the corrective month', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(rowOf(result.schedule, 59).paymentTotal).toBe(O06_REDUCED_PAYMENT);
});

test('REQ-21 (O-05): reduceTerm shortens the schedule to the externally verified term', () => {
  const result = run(REDUCE_TERM_12);

  expect(result.totals.actualTermMonths).toBe(O05_TERM_AFTER_REDUCE_TERM);
});

/* ================================================================== *
 * M-01 — insurance rounding.
 *
 * The month-1 premium is pinned, but at those parameters it is a whole number,
 * so rounding never participates. The premiums that do have a fractional part
 * were checked only by inequalities.
 * ================================================================== */

/** O-09: FV-derived balances, half-up rounded. 7 055,84 and 3 738,30 RUB. */
const O09_PREMIUM_MONTH_13 = 705_584;
const O09_PREMIUM_MONTH_25 = 373_830;

const INSURED_36: CreditInput = {
  ...BASE,
  termMonths: 36,
  insurance: { annualRatePercent: 1 },
};

test('REQ-17 (O-09): the second annual premium matches the external anchor to the kopeck', () => {
  const result = run(INSURED_36);

  expect(rowOf(result.schedule, 13).insurance).toBe(O09_PREMIUM_MONTH_13);
});

test('REQ-17 (O-09): the third annual premium matches the external anchor to the kopeck', () => {
  const result = run(INSURED_36);

  expect(rowOf(result.schedule, 25).insurance).toBe(O09_PREMIUM_MONTH_25);
});

/* ================================================================== *
 * M-22 — rounding inside the zero-rate branch.
 * The only zero-rate case divided exactly, so the rounding was never exercised.
 * ================================================================== */

/** O-10: 1 234 567 / 7 = 176 366,71... -> half-up -> 176 367. */
const O10_PAYMENT = 176_367;

test('REQ-13 (O-10): a zero-rate payment that does not divide evenly is rounded half-up', () => {
  const result = run({
    ...BASE,
    amount: 1_234_567,
    annualRatePercent: 0,
    termMonths: 7,
  });

  expect(result.schedule[0]?.paymentTotal).toBe(O10_PAYMENT);
});

test('REQ-13: a zero-rate loan still costs nothing in interest', () => {
  const result = run({
    ...BASE,
    amount: 1_234_567,
    annualRatePercent: 0,
    termMonths: 7,
  });

  expect(result.totals.totalInterest).toBe(0);
});

/* ================================================================== *
 * M-04, M-05, M-06 — lower bounds of validation.
 *
 * The suite covered the upper bounds of rejected values (361, 101, 15) and never
 * the lower bounds of accepted ones, so widening a comparison to reject a legal
 * input went unnoticed. These are the only surviving mutations the cross-check
 * does not catch either: cases.json has no such inputs.
 * ================================================================== */

test('REQ-06: a one-month term is a valid input, not an error', () => {
  const result = calculateCredit({ ...BASE, termMonths: 1 });

  expect(result.ok).toBe(true);
});

test('REQ-06: a one-month loan is repaid in a single corrective payment', () => {
  const result = run({ ...BASE, termMonths: 1 });

  expect(result.schedule).toHaveLength(1);
});

test('REQ-06: the single payment of a one-month loan clears the debt exactly', () => {
  const result = run({ ...BASE, termMonths: 1 });

  expect(result.schedule[0]?.balanceAfter).toBe(0);
});

test('REQ-07: an insurance rate of exactly 10,00 % is accepted', () => {
  const result = calculateCredit({
    ...BASE,
    insurance: { annualRatePercent: 10 },
  });

  expect(result.ok).toBe(true);
});

test('REQ-07: an insurance rate of exactly 10,00 % charges a premium', () => {
  const result = run({ ...BASE, insurance: { annualRatePercent: 10 } });

  expect(result.schedule[0]?.insurance).toBe(rub(100_000));
});

test('REQ-08: an early repayment in the last month of the term is a valid input', () => {
  const result = calculateCredit({
    ...BASE,
    earlyRepayments: [{ month: BASE.termMonths, amount: rub(10_000), mode: 'reduceTerm' }],
  });

  expect(result.ok).toBe(true);
});
