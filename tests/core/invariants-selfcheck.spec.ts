/**
 * Negative control for the invariant checker itself.
 *
 * checkInvariants (INV-01…INV-08) is the only thing holding the correctness of
 * the insurance and early-repayment scenarios: docs/oracle.md leaves O-04, O-05
 * and O-06 empty, so those paths have no external anchor at all. A checker that
 * silently accepts a violated invariant would be eight lines of decoration.
 *
 * Each test below takes a valid result, breaks exactly one invariant in a copy
 * of it, and asserts that the checker throws. See D-20.
 */

import { test, expect } from '@playwright/test';

import { calculateCredit } from '../../src/core';
import type { CalculationResult, CreditInput, ScheduleRow } from '../../src/core';
import { checkInvariants } from './invariants';

/** O-01 parameters: 1 000 000 ₽, 12,00 % a year, 60 months, no extras. */
const INPUT: CreditInput = {
  amount: 100_000_000,
  annualRatePercent: 12,
  termMonths: 60,
  insurance: null,
  earlyRepayments: [],
};

type OkResult = Extract<CalculationResult, { ok: true }>;

function freshResult(): OkResult {
  const result = calculateCredit(INPUT);
  if (!result.ok) {
    throw new Error(`fixture input was rejected: ${JSON.stringify(result)}`);
  }
  // Deep copy, so a mutation in one test cannot leak into another.
  return JSON.parse(JSON.stringify(result)) as OkResult;
}

/** Sanity: the untouched fixture must pass, otherwise every test below is vacuous. */
test('selfcheck: the untouched result passes the invariant checker', () => {
  expect(() => checkInvariants(INPUT, freshResult())).not.toThrow();
});

test('INV-01: a principal short by one kopeck is caught', () => {
  const broken = freshResult();
  const row = broken.schedule[0] as ScheduleRow;
  row.principal -= 1;
  row.paymentTotal -= 1; // keep INV-04 intact so INV-01 is what fires
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-02: a non-zero closing balance is caught', () => {
  const broken = freshResult();
  const last = broken.schedule[broken.schedule.length - 1] as ScheduleRow;
  last.balanceAfter = 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-03: a balance that grows between rows is caught', () => {
  const broken = freshResult();
  const row = broken.schedule[1] as ScheduleRow;
  row.balanceAfter = (broken.schedule[0] as ScheduleRow).balanceAfter + 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-04: paymentTotal that does not equal its parts is caught', () => {
  const broken = freshResult();
  (broken.schedule[0] as ScheduleRow).paymentTotal += 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-05: a gap in month numbering is caught', () => {
  const broken = freshResult();
  (broken.schedule[2] as ScheduleRow).month = 99;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-06: a negative principal row is caught', () => {
  // Zero is legal since D-23 — a degenerate schedule amortises nothing until the
  // corrective final payment. Negative is still a defect, and must be caught.
  const broken = freshResult();
  const row = broken.schedule[0] as ScheduleRow;
  row.principal = -1;
  row.paymentTotal -= 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-06: a non-integer money field is caught', () => {
  const broken = freshResult();
  (broken.schedule[0] as ScheduleRow).interest += 0.5;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-07: applied plus excess drifting from requested is caught', () => {
  const broken = freshResult();
  (broken.schedule[0] as ScheduleRow).earlyRepaymentExcess += 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('INV-08: totals that do not add up are caught', () => {
  const broken = freshResult();
  broken.totals.totalPaid += 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});

test('REQ-27: an overpayment inconsistent with the totals is caught', () => {
  const broken = freshResult();
  broken.totals.overpayment += 1;
  expect(() => checkInvariants(INPUT, broken)).toThrow();
});
