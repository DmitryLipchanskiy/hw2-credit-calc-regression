/**
 * Scenario regression suite: insurance (REQ-17…REQ-19) and early repayment
 * (REQ-20…REQ-25).
 *
 * Written against docs/spec.md alone. Neither src/** (TypeScript implementation)
 * nor oracle/** (Python reference) nor the files of the other agents in tests/**
 * were read while writing this file.
 *
 * Expected values are level 1 — properties and relations — almost everywhere.
 * docs/oracle.md leaves O-04, O-05 and O-06 empty on purpose: no external anchor
 * exists for insurance or early-repayment scenarios (D-15). Hand-computed monthly
 * tables are therefore forbidden here and none is used. The only exact numbers in
 * this file are:
 *   - the O-01 monthly payment, quoted from docs/oracle.md;
 *   - values obtained from the spec formula in a single operation
 *     (roundHalfUp(amount * i) and roundHalfUp(amount * insuranceRate / 100),
 *     both exact at the parameters used here);
 *   - structural constants: 0, the contract term, the month of a repayment.
 *
 * All money comparisons are strict equality of integer kopecks (REQ-36).
 */

import { test, expect } from '@playwright/test';
import { calculateCredit } from '../../src/core';
import { checkInvariants } from './invariants';

/* ------------------------------------------------------------------ *
 * Contract shapes, transcribed from spec.md section 9 (REQ-38).
 * They are declared locally rather than imported from src/** so that this
 * file depends on the specification, not on the layout of the implementation.
 * ------------------------------------------------------------------ */

type EarlyMode = 'reduceTerm' | 'reducePayment';

interface EarlyRepaymentShape {
  month: number;
  amount: number;
  mode: EarlyMode;
}

interface InputShape {
  amount: number;
  annualRatePercent: number;
  termMonths: number;
  insurance: { annualRatePercent: number } | null;
  earlyRepayments: EarlyRepaymentShape[];
}

interface RowShape {
  month: number;
  paymentTotal: number;
  interest: number;
  principal: number;
  insurance: number;
  earlyRepaymentRequested: number;
  earlyRepaymentApplied: number;
  earlyRepaymentExcess: number;
  balanceAfter: number;
}

interface IgnoredShape {
  index: number;
  month: number;
  amount: number;
}

interface TotalsShape {
  monthlyPayment: number;
  actualTermMonths: number;
  totalPrincipal: number;
  totalInterest: number;
  totalInsurance: number;
  totalPaid: number;
  totalEarlyRepaymentExcess: number;
  overpayment: number;
  ignoredEarlyRepayments: IgnoredShape[];
}

interface OkShape {
  ok: true;
  schedule: RowShape[];
  totals: TotalsShape;
}

type ResultShape = OkShape | { ok: false; errors: string[] };

/**
 * Called directly, with no type assertion. The shapes above are transcribed from
 * spec.md section 9, so if the transcription drifts from the real contract, this
 * line stops compiling — which is exactly the signal an `as unknown as` cast
 * would have swallowed. See D-17.
 */
const calculate = (source: InputShape): ResultShape => calculateCredit(source);

/**
 * INV-01…INV-08 (REQ-16) are checked on every case of this file through the
 * shared checker owned by agent C (tests/core/invariants.ts).
 *
 * The checker is called directly, with no type assertion. An earlier version
 * routed it through a permissive `as unknown as` alias to survive an unknown
 * signature — which silenced the compiler and let a reversed argument order
 * reach the green phase. See D-17.
 */
const assertInvariants = checkInvariants;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Rubles to kopecks. All money in this file is integer kopecks (REQ-01). */
const rub = (rubles: number): number => rubles * 100;

/** O-01 / O-05 / O-06 share these base parameters (docs/oracle.md). */
const BASE: InputShape = {
  amount: rub(1_000_000),
  annualRatePercent: 12,
  termMonths: 60,
  insurance: null,
  earlyRepayments: [],
};

const INSURANCE_1PCT = { annualRatePercent: 1 };

/** Monthly payment of O-01: 22 244,45 ₽. Quoted from docs/oracle.md (PMT). */
const O01_MONTHLY_PAYMENT = 2_224_445;

function input(patch: Partial<InputShape>): InputShape {
  return { ...BASE, ...patch };
}

/** Runs a case and checks INV-01…INV-08 on it (REQ-16). */
function run(source: InputShape): OkShape {
  const result = calculate(source);
  if (!result.ok) {
    throw new Error(
      `calculateCredit rejected a valid input: ${JSON.stringify(result)}`,
    );
  }
  assertInvariants(source, result);
  return result;
}

function row(result: OkShape, month: number): RowShape {
  const found = result.schedule.find((r) => r.month === month);
  if (!found) {
    throw new Error(
      `schedule has no month ${month} (actual term ${result.schedule.length})`,
    );
  }
  return found;
}

/** Distinct payment values over a month range, in first-seen order. */
function distinctPayments(result: OkShape, from: number, to: number): number[] {
  const values = result.schedule
    .filter((r) => r.month >= from && r.month <= to)
    .map((r) => r.paymentTotal);
  return [...new Set(values)];
}

const zerosLike = (values: number[]): number[] => values.map(() => 0);

/* ================================================================== *
 * REQ-17. Insurance: when it is charged and on what base
 * ================================================================== */

const INSURED_36 = input({
  termMonths: 36,
  insurance: INSURANCE_1PCT,
});

test('REQ-17: the premium is charged exactly in months 1, 13 and 25', () => {
  const result = run(INSURED_36);

  const charged = result.schedule
    .filter((r) => r.insurance > 0)
    .map((r) => r.month);

  expect(charged).toEqual([1, 13, 25]);
});

test('REQ-17: the premium is strictly zero in every month outside the annual points', () => {
  const result = run(INSURED_36);

  const others = result.schedule
    .filter((r) => r.month % 12 !== 1)
    .map((r) => r.insurance);

  expect(others).toEqual(zerosLike(others));
});

test('REQ-17: the first premium is one percent of the initial balance', () => {
  // Single operation from REQ-17: roundHalfUp(balanceBefore * rate / 100),
  // balanceBefore of month 1 = amount = 1 000 000,00 ₽, rate = 1,00 % →
  // 10 000,00 ₽ exactly, no rounding involved. Not a monthly table.
  const result = run(INSURED_36);

  expect(row(result, 1).insurance).toBe(rub(10_000));
});

test('REQ-17: the premium base is the balance at the start of the month, not the original amount', () => {
  // If the base were the original amount, every annual premium would be equal.
  const result = run(INSURED_36);

  expect(row(result, 13).insurance).toBeLessThan(row(result, 1).insurance);
});

test('REQ-17: the second annual premium is larger than the third one', () => {
  // Same direction one year later: the base keeps shrinking with the debt.
  const result = run(INSURED_36);

  expect(row(result, 25).insurance).toBeLessThan(row(result, 13).insurance);
});

test('REQ-17: no premium is charged anywhere when insurance is null', () => {
  const result = run(input({ termMonths: 36 }));

  const premiums = result.schedule.map((r) => r.insurance);

  expect(premiums).toEqual(zerosLike(premiums));
});

/* ================================================================== *
 * REQ-18. Insurance does not touch the repayment of the debt.
 * The pair of runs differs only by the presence of insurance.
 * ================================================================== */

const PAIR_BARE = input({});
const PAIR_INSURED = input({ insurance: INSURANCE_1PCT });

test('REQ-18: principal matches row by row with and without insurance', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.schedule.map((r) => r.principal)).toEqual(
    bare.schedule.map((r) => r.principal),
  );
});

test('REQ-18: interest matches row by row with and without insurance', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.schedule.map((r) => r.interest)).toEqual(
    bare.schedule.map((r) => r.interest),
  );
});

test('REQ-18: balanceAfter matches row by row with and without insurance', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.schedule.map((r) => r.balanceAfter)).toEqual(
    bare.schedule.map((r) => r.balanceAfter),
  );
});

test('REQ-18: the term is the same with and without insurance', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.totals.actualTermMonths).toBe(bare.totals.actualTermMonths);
});

test('REQ-18: the regular payment is the same with and without insurance', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.totals.monthlyPayment).toBe(bare.totals.monthlyPayment);
});

test('REQ-18: the premium raises only paymentTotal of its own month', () => {
  const bare = run(PAIR_BARE);
  const insured = run(PAIR_INSURED);

  expect(insured.schedule.map((r) => r.paymentTotal - r.insurance)).toEqual(
    bare.schedule.map((r) => r.paymentTotal),
  );
});

/* The same property must hold when an early repayment is in play. */

const EARLY_12_REDUCE_TERM: EarlyRepaymentShape = {
  month: 12,
  amount: rub(200_000),
  mode: 'reduceTerm',
};

const PAIR_EARLY_BARE = input({ earlyRepayments: [EARLY_12_REDUCE_TERM] });
const PAIR_EARLY_INSURED = input({
  insurance: INSURANCE_1PCT,
  earlyRepayments: [EARLY_12_REDUCE_TERM],
});

test('REQ-18: with an early repayment, balanceAfter still matches row by row', () => {
  const bare = run(PAIR_EARLY_BARE);
  const insured = run(PAIR_EARLY_INSURED);

  expect(insured.schedule.map((r) => r.balanceAfter)).toEqual(
    bare.schedule.map((r) => r.balanceAfter),
  );
});

test('REQ-18: with an early repayment, interest still matches row by row', () => {
  const bare = run(PAIR_EARLY_BARE);
  const insured = run(PAIR_EARLY_INSURED);

  expect(insured.schedule.map((r) => r.interest)).toEqual(
    bare.schedule.map((r) => r.interest),
  );
});

test('REQ-18: insurance does not change the term shortened by an early repayment', () => {
  const bare = run(PAIR_EARLY_BARE);
  const insured = run(PAIR_EARLY_INSURED);

  expect(insured.totals.actualTermMonths).toBe(bare.totals.actualTermMonths);
});

/* ================================================================== *
 * REQ-19. Insurance after the loan has been closed early
 * ================================================================== */

/** Requesting the whole original amount is certainly not less than any later balance. */
const CLOSING_AMOUNT = rub(1_000_000);

const CLOSED_AT_6 = input({
  termMonths: 36,
  insurance: INSURANCE_1PCT,
  earlyRepayments: [{ month: 6, amount: CLOSING_AMOUNT, mode: 'reduceTerm' }],
});

const CLOSED_AT_13 = input({
  termMonths: 36,
  insurance: INSURANCE_1PCT,
  earlyRepayments: [{ month: 13, amount: CLOSING_AMOUNT, mode: 'reduceTerm' }],
});

test('REQ-19: the schedule has no rows after the month of early closure', () => {
  const result = run(CLOSED_AT_6);

  expect(result.schedule.length).toBe(6);
});

test('REQ-19: no premium is charged for the annual periods that never started', () => {
  const result = run(CLOSED_AT_6);

  // Only the premium of month 1 was ever charged; months 13 and 25 do not exist.
  expect(result.totals.totalInsurance).toBe(row(result, 1).insurance);
});

test('REQ-19: the premium is still charged in the closing month when it is an annual point', () => {
  const result = run(CLOSED_AT_13);

  expect(row(result, 13).insurance).toBeGreaterThan(0);
});

test('REQ-19: closing on an annual point still ends the schedule at that month', () => {
  const result = run(CLOSED_AT_13);

  expect(result.totals.actualTermMonths).toBe(13);
});

/* ================================================================== *
 * REQ-20. The early repayment is applied after the regular payment
 * ================================================================== */

test('REQ-20: interest of the repayment month is unchanged by the early repayment', () => {
  // If the money were credited before the interest accrual, the interest of
  // month 12 would drop. Relation between two runs, no number needed.
  const withEarly = run(PAIR_EARLY_BARE);
  const without = run(PAIR_BARE);

  expect(row(withEarly, 12).interest).toBe(row(without, 12).interest);
});

test('REQ-20: principal of the repayment month is unchanged by the early repayment', () => {
  const withEarly = run(PAIR_EARLY_BARE);
  const without = run(PAIR_BARE);

  expect(row(withEarly, 12).principal).toBe(row(without, 12).principal);
});

test('REQ-20: the early repayment lowers balanceAfter of its month by exactly the applied sum', () => {
  const withEarly = run(PAIR_EARLY_BARE);
  const without = run(PAIR_BARE);

  const applied = row(withEarly, 12).earlyRepaymentApplied;

  expect(row(withEarly, 12).balanceAfter).toBe(
    row(without, 12).balanceAfter - applied,
  );
});

test('REQ-20: a repayment in month 1 leaves the interest of month 1 at the full rate', () => {
  // i = 12 / 100 / 12 = 0,01 exactly; interest of month 1 = roundHalfUp(amount * i)
  // = 1 % of 1 000 000,00 ₽ = 10 000,00 ₽. One operation from REQ-11 and REQ-15,
  // and the strongest form of REQ-20: the repayment of the very same month must
  // not reduce it.
  const result = run(
    input({
      earlyRepayments: [{ month: 1, amount: rub(200_000), mode: 'reduceTerm' }],
    }),
  );

  expect(row(result, 1).interest).toBe(rub(10_000));
});

test('REQ-20: the early repayment is not added to paymentTotal of its month', () => {
  // REQ-14: paymentTotal = principal + interest + insurance, the repayment stays out.
  const withEarly = run(PAIR_EARLY_BARE);
  const without = run(PAIR_BARE);

  expect(row(withEarly, 12).paymentTotal).toBe(row(without, 12).paymentTotal);
});

/* ================================================================== *
 * REQ-21. reduceTerm: the payment stays, the term shrinks
 * ================================================================== */

test('REQ-21: reduceTerm keeps one and the same regular payment for every month but the corrective last one', () => {
  const result = run(PAIR_EARLY_BARE);

  const beforeLast = distinctPayments(
    result,
    1,
    result.totals.actualTermMonths - 1,
  );

  expect(beforeLast).toEqual([row(result, 1).paymentTotal]);
});

test('REQ-21: reduceTerm leaves the payment of the month after the repayment equal to the payment before it', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(row(result, 13).paymentTotal).toBe(row(result, 12).paymentTotal);
});

test('REQ-21: reduceTerm makes the actual term shorter than the contract term', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(result.totals.actualTermMonths).toBeLessThan(BASE.termMonths);
});

test('REQ-21: reduceTerm still starts from the contractual monthly payment', () => {
  // O-01: 22 244,45 ₽ for 1 000 000,00 ₽ / 12,00 % / 60 months. O-05 shares those
  // base parameters with O-01, so the payment before the repayment is the same.
  const result = run(PAIR_EARLY_BARE);

  expect(result.totals.monthlyPayment).toBe(O01_MONTHLY_PAYMENT);
});

test('REQ-21: reduceTerm shortens the schedule but does not close the loan in the repayment month', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(result.totals.actualTermMonths).toBeGreaterThan(12);
});

/* ================================================================== *
 * REQ-22. reducePayment: the term stays, the payment falls
 * ================================================================== */

const REDUCE_PAYMENT_12 = input({
  earlyRepayments: [{ month: 12, amount: rub(200_000), mode: 'reducePayment' }],
});

test('REQ-22: reducePayment keeps the number of rows equal to the contract term', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(result.schedule.length).toBe(BASE.termMonths);
});

test('REQ-22: reducePayment makes the payment after the repayment strictly lower than before it', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(row(result, 13).paymentTotal).toBeLessThan(
    row(result, 12).paymentTotal,
  );
});

test('REQ-22: reducePayment leaves the payment untouched up to and including the repayment month', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(distinctPayments(result, 1, 12)).toEqual([
    row(result, 1).paymentTotal,
  ]);
});

test('REQ-22: reducePayment recomputes the payment once and keeps it to the corrective last month', () => {
  const result = run(REDUCE_PAYMENT_12);

  expect(distinctPayments(result, 13, BASE.termMonths - 1)).toEqual([
    row(result, 13).paymentTotal,
  ]);
});

test('REQ-22: reducePayment reports the first regular payment, not the reduced one', () => {
  // REQ-26: monthlyPayment is the first regular payment. O-01 anchor, O-06 shares
  // the base parameters of O-01.
  const result = run(REDUCE_PAYMENT_12);

  expect(result.totals.monthlyPayment).toBe(O01_MONTHLY_PAYMENT);
});

/* ================================================================== *
 * REQ-23. Requested sum against the remaining balance: three cases.
 *
 * The balance B after the regular payment of month 12 is taken from a probe run
 * of the very same parameters without any early repayment: REQ-20 puts the
 * repayment after the regular payment, so that month reaches the same balance in
 * both runs. B is used as an INPUT of the case, never as an expected value —
 * every expectation below is 0, the requested sum, or arithmetic over them.
 * ================================================================== */

function balanceAfterMonth12WithoutRepayment(): number {
  return row(run(PAIR_BARE), 12).balanceAfter;
}

/* --- case 1: requested < balance ------------------------------------ */

const LESS_THAN_BALANCE = rub(200_000);

test('REQ-23 (requested < balance): the whole requested sum is applied', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(row(result, 12).earlyRepaymentApplied).toBe(LESS_THAN_BALANCE);
});

test('REQ-23 (requested < balance): there is no excess', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(row(result, 12).earlyRepaymentExcess).toBe(0);
});

test('REQ-23 (requested < balance): the debt is not closed in that month', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(row(result, 12).balanceAfter).toBeGreaterThan(0);
});

test('REQ-23 (requested < balance): the schedule continues after the repayment month', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(result.schedule.length).toBeGreaterThan(12);
});

/* --- case 2: requested === balance ---------------------------------- */

test('REQ-23 (requested === balance): the whole requested sum is applied', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(
    input({
      earlyRepayments: [{ month: 12, amount: balance, mode: 'reduceTerm' }],
    }),
  );

  expect(row(result, 12).earlyRepaymentApplied).toBe(balance);
});

test('REQ-23 (requested === balance): there is no excess', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(
    input({
      earlyRepayments: [{ month: 12, amount: balance, mode: 'reduceTerm' }],
    }),
  );

  expect(row(result, 12).earlyRepaymentExcess).toBe(0);
});

test('REQ-23 (requested === balance): the balance is closed exactly to zero', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(
    input({
      earlyRepayments: [{ month: 12, amount: balance, mode: 'reduceTerm' }],
    }),
  );

  expect(row(result, 12).balanceAfter).toBe(0);
});

test('REQ-23 (requested === balance): the schedule ends in the repayment month', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(
    input({
      earlyRepayments: [{ month: 12, amount: balance, mode: 'reduceTerm' }],
    }),
  );

  expect(result.schedule.length).toBe(12);
});

/* --- case 3: requested > balance ------------------------------------ */

/** The whole original amount is strictly larger than any balance after month 1. */
const MORE_THAN_BALANCE = rub(1_000_000);

const OVERPAY_AT_12 = input({
  earlyRepayments: [
    { month: 12, amount: MORE_THAN_BALANCE, mode: 'reduceTerm' },
  ],
});

test('REQ-23 (requested > balance): only the remaining balance is applied', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(OVERPAY_AT_12);

  expect(row(result, 12).earlyRepaymentApplied).toBe(balance);
});

test('REQ-23 (requested > balance): the rest is reported as excess', () => {
  const balance = balanceAfterMonth12WithoutRepayment();
  const result = run(OVERPAY_AT_12);

  expect(row(result, 12).earlyRepaymentExcess).toBe(
    MORE_THAN_BALANCE - balance,
  );
});

test('REQ-23 (requested > balance): applied plus excess equals the requested sum', () => {
  // INV-07 stated on the row where it matters most.
  const result = run(OVERPAY_AT_12);
  const target = row(result, 12);

  expect(target.earlyRepaymentApplied + target.earlyRepaymentExcess).toBe(
    target.earlyRepaymentRequested,
  );
});

test('REQ-23 (requested > balance): the requested field keeps the sum that was asked for', () => {
  const result = run(OVERPAY_AT_12);

  expect(row(result, 12).earlyRepaymentRequested).toBe(MORE_THAN_BALANCE);
});

test('REQ-23 (requested > balance): the balance is closed exactly to zero', () => {
  const result = run(OVERPAY_AT_12);

  expect(row(result, 12).balanceAfter).toBe(0);
});

test('REQ-23 (requested > balance): the schedule ends in the repayment month', () => {
  const result = run(OVERPAY_AT_12);

  expect(result.schedule.length).toBe(12);
});

test('REQ-23 (requested > balance): the excess is aggregated in the totals', () => {
  const result = run(OVERPAY_AT_12);

  expect(result.totals.totalEarlyRepaymentExcess).toBe(
    row(result, 12).earlyRepaymentExcess,
  );
});

test('REQ-23 (requested > balance): the excess is not credited to the principal', () => {
  // The debt is repaid exactly once, however much was thrown at it.
  const result = run(OVERPAY_AT_12);

  expect(result.totals.totalPrincipal).toBe(BASE.amount);
});

test('REQ-23 (requested > balance): the excess is not part of totalPaid', () => {
  const result = run(OVERPAY_AT_12);

  expect(result.totals.totalPaid).toBe(
    result.totals.totalPrincipal +
      result.totals.totalInterest +
      result.totals.totalInsurance,
  );
});

/* ================================================================== *
 * REQ-24. Several early repayments, mixed modes.
 *
 * Two reducePayment steps and a closing reduceTerm step. The sums are far below
 * the remaining balance in every one of those months, so all three are applied
 * in full; the last step being reduceTerm makes the shortened term unambiguous.
 * ================================================================== */

const CHAIN: EarlyRepaymentShape[] = [
  { month: 6, amount: rub(100_000), mode: 'reducePayment' },
  { month: 12, amount: rub(100_000), mode: 'reducePayment' },
  { month: 24, amount: rub(100_000), mode: 'reduceTerm' },
];

const CHAINED = input({ earlyRepayments: CHAIN });

test('REQ-24: every repayment of the chain is applied in full', () => {
  const result = run(CHAINED);

  expect(CHAIN.map((e) => row(result, e.month).earlyRepaymentApplied)).toEqual(
    CHAIN.map((e) => e.amount),
  );
});

test('REQ-24: no repayment of the chain produces an excess', () => {
  const result = run(CHAINED);

  const excesses = CHAIN.map((e) => row(result, e.month).earlyRepaymentExcess);

  expect(excesses).toEqual(zerosLike(excesses));
});

test('REQ-24: the first reducePayment step lowers the payment', () => {
  const result = run(CHAINED);

  expect(row(result, 7).paymentTotal).toBeLessThan(row(result, 6).paymentTotal);
});

test('REQ-24: the second reducePayment step lowers the already lowered payment', () => {
  // This is what "each repayment is computed from the state left by the previous
  // one" means in observable terms.
  const result = run(CHAINED);

  expect(row(result, 13).paymentTotal).toBeLessThan(
    row(result, 12).paymentTotal,
  );
});

test('REQ-24: the reduceTerm step in the middle of the chain keeps the payment', () => {
  const result = run(CHAINED);

  expect(row(result, 25).paymentTotal).toBe(row(result, 24).paymentTotal);
});

test('REQ-24: the chain ending with reduceTerm shortens the actual term', () => {
  const result = run(CHAINED);

  expect(result.totals.actualTermMonths).toBeLessThan(BASE.termMonths);
});

test('REQ-24: nothing is ignored while the loan is alive', () => {
  const result = run(CHAINED);

  expect(result.totals.ignoredEarlyRepayments).toEqual([]);
});

test('REQ-24: repayments are applied by month, whatever the order in the input array', () => {
  const shuffled = run(
    input({
      earlyRepayments: [CHAIN[2]!, CHAIN[0]!, CHAIN[1]!],
    }),
  );
  const ordered = run(CHAINED);

  expect(shuffled.schedule).toEqual(ordered.schedule);
});

/* ================================================================== *
 * REQ-25. Repayments falling after the loan is already closed
 * ================================================================== */

const LATE_AMOUNT = rub(50_000);

const CLOSED_THEN_ONE_LATE = input({
  earlyRepayments: [
    { month: 6, amount: rub(100_000), mode: 'reduceTerm' },
    { month: 12, amount: MORE_THAN_BALANCE, mode: 'reduceTerm' },
    { month: 24, amount: LATE_AMOUNT, mode: 'reduceTerm' },
  ],
});

const CLOSED_THEN_TWO_LATE = input({
  earlyRepayments: [
    { month: 6, amount: rub(100_000), mode: 'reduceTerm' },
    { month: 12, amount: MORE_THAN_BALANCE, mode: 'reduceTerm' },
    { month: 24, amount: LATE_AMOUNT, mode: 'reduceTerm' },
    { month: 36, amount: rub(70_000), mode: 'reducePayment' },
  ],
});

test('REQ-25: the repayment that fell after the closure is listed with its index, month and amount', () => {
  const result = run(CLOSED_THEN_ONE_LATE);

  expect(result.totals.ignoredEarlyRepayments).toEqual([
    { index: 2, month: 24, amount: LATE_AMOUNT },
  ]);
});

test('REQ-25: the schedule ends in the month the loan was closed', () => {
  const result = run(CLOSED_THEN_ONE_LATE);

  expect(result.schedule.length).toBe(12);
});

test('REQ-25: the repayment that closed the loan is not among the ignored ones', () => {
  const result = run(CLOSED_THEN_ONE_LATE);

  expect(
    result.totals.ignoredEarlyRepayments.map((entry) => entry.month),
  ).toEqual([24]);
});

test('REQ-25: every repayment after the closure is listed, in the order of the input array', () => {
  const result = run(CLOSED_THEN_TWO_LATE);

  expect(result.totals.ignoredEarlyRepayments).toEqual([
    { index: 2, month: 24, amount: LATE_AMOUNT },
    { index: 3, month: 36, amount: rub(70_000) },
  ]);
});

test('REQ-25: an ignored repayment changes nothing in the schedule', () => {
  const withLate = run(CLOSED_THEN_ONE_LATE);
  const withoutLate = run(
    input({
      earlyRepayments: [
        { month: 6, amount: rub(100_000), mode: 'reduceTerm' },
        { month: 12, amount: MORE_THAN_BALANCE, mode: 'reduceTerm' },
      ],
    }),
  );

  expect(withLate.schedule).toEqual(withoutLate.schedule);
});

test('REQ-25: an ignored repayment is not counted in the totals of the excess', () => {
  const withLate = run(CLOSED_THEN_ONE_LATE);
  const withoutLate = run(
    input({
      earlyRepayments: [
        { month: 6, amount: rub(100_000), mode: 'reduceTerm' },
        { month: 12, amount: MORE_THAN_BALANCE, mode: 'reduceTerm' },
      ],
    }),
  );

  expect(withLate.totals.totalEarlyRepaymentExcess).toBe(
    withoutLate.totals.totalEarlyRepaymentExcess,
  );
});

test('REQ-25: a repayment falling past a term shortened by reduceTerm is ignored', () => {
  // The month is not known in advance and is not guessed: it is taken one month
  // past the term that reduceTerm produces. REQ-21 guarantees that term is
  // shorter than 60, so the month stays inside the range allowed by REQ-08.
  const shortened = run(PAIR_EARLY_BARE);
  const monthPastTheEnd = shortened.totals.actualTermMonths + 1;

  const result = run(
    input({
      earlyRepayments: [
        EARLY_12_REDUCE_TERM,
        { month: monthPastTheEnd, amount: LATE_AMOUNT, mode: 'reduceTerm' },
      ],
    }),
  );

  expect(result.totals.ignoredEarlyRepayments).toEqual([
    { index: 1, month: monthPastTheEnd, amount: LATE_AMOUNT },
  ]);
});

test('REQ-25: the field is an empty array when there is nothing to ignore', () => {
  const result = run(PAIR_EARLY_BARE);

  expect(result.totals.ignoredEarlyRepayments).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * Added during the merge, not by agent D.
 *
 * REQ-22 is ambiguous once an earlier reduceTerm has already shortened the
 * schedule: "число оставшихся месяцев не меняется (termMonths − M)" can be read
 * as "back to the original termMonths" or as "keep the current remaining term".
 * Agent D dodged it by reordering its chain, which left the case untested.
 *
 * The literal reading is fixed here: reducePayment recomputes over
 * termMonths − M, so it restores the end of the schedule to the original term.
 * Both implementations already agree on this across 20 mixed-mode cases of the
 * cross-check, so this is a characterisation test that pins a decided reading —
 * not an independent derivation from requirements. See D-22.
 * ------------------------------------------------------------------ */

test('REQ-22: reducePayment after an earlier reduceTerm restores the original term', () => {
  const shortenedOnly = run(
    input({
      earlyRepayments: [{ month: 12, amount: rub(200_000), mode: 'reduceTerm' }],
    }),
  );

  const thenReduced = run(
    input({
      earlyRepayments: [
        { month: 12, amount: rub(200_000), mode: 'reduceTerm' },
        { month: 24, amount: rub(100_000), mode: 'reducePayment' },
      ],
    }),
  );

  expect(
    shortenedOnly.totals.actualTermMonths,
    'the reduceTerm step alone must shorten the schedule below the original term',
  ).toBeLessThan(BASE.termMonths);

  expect(
    thenReduced.totals.actualTermMonths,
    'REQ-22 read literally: reducePayment recomputes over termMonths - M',
  ).toBe(BASE.termMonths);
});
