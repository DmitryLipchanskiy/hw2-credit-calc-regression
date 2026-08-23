/**
 * Annuity schedule and totals. REQ-11 … REQ-27, REQ-37.
 *
 * Every money value is an integer number of kopecks (REQ-01, REQ-02). Floating point
 * appears only in the monthly rate `i` and the annuity factor `K` (REQ-03); the product
 * of money and `i` or `K` is rounded to whole kopecks immediately by roundHalfUp.
 */

import { roundHalfUp } from './round';
import type {
  CreditInput,
  CreditTotals,
  EarlyRepaymentInput,
  IgnoredEarlyRepayment,
  Kopecks,
  ScheduleRow,
} from './types';

/** An early repayment together with its position in the input array (REQ-25). */
interface IndexedEarlyRepayment {
  index: number;
  entry: EarlyRepaymentInput;
}

/**
 * Regular payment for `balance` spread over `months` months. REQ-12, REQ-13.
 *
 * The zero-rate branch is chosen strictly by `annualRatePercent === 0` at the call site
 * (REQ-13): at any non-zero rate, however small, `i > 0` and REQ-12 applies.
 */
function computePayment(balance: Kopecks, months: number, i: number, zeroRate: boolean): Kopecks {
  if (zeroRate) {
    return roundHalfUp(balance / months);
  }
  const growth = Math.pow(1 + i, months);
  const k = (i * growth) / (growth - 1);
  return roundHalfUp(balance * k);
}

/**
 * Insurance premium of the month. REQ-17, REQ-18.
 *
 * Charged in months 1, 13, 25, … on the balance at the start of the month. It never
 * touches principal, interest or the balance — only paymentTotal of its own month.
 */
function computeInsurance(balanceBefore: Kopecks, month: number, ratePercent: number | null): Kopecks {
  if (ratePercent === null || (month - 1) % 12 !== 0) {
    return 0;
  }
  return roundHalfUp((balanceBefore * ratePercent) / 100);
}

/**
 * Builds the payment schedule. REQ-14, REQ-15.
 *
 * The input is already validated, so no check here can fail. The loop never runs past
 * `termMonths`: in that last month the principal is forced to the whole remaining
 * balance (REQ-05), which also absorbs the kopeck-level drift of the rounded payment.
 */
function buildSchedule(input: CreditInput): ScheduleRow[] {
  const zeroRate = input.annualRatePercent === 0; // REQ-13, strict boundary
  const i = input.annualRatePercent / 100 / 12; // REQ-11
  const insuranceRate = input.insurance === null ? null : input.insurance.annualRatePercent;
  const termMonths = input.termMonths;

  const byMonth = new Map<number, IndexedEarlyRepayment>();
  input.earlyRepayments.forEach((entry, index) => byMonth.set(entry.month, { index, entry }));

  const schedule: ScheduleRow[] = [];
  let balance: Kopecks = input.amount;
  let payment: Kopecks = computePayment(input.amount, termMonths, i, zeroRate);

  for (let month = 1; month <= termMonths && balance > 0; month++) {
    const balanceBefore = balance;

    // 1. Interest on the balance at the START of the month (REQ-15).
    const interest = roundHalfUp(balanceBefore * i);

    // 2-3. Principal, capped by the balance. In the last month of the term the principal
    // is the whole remaining balance rather than the annuity figure (REQ-05).
    let principal = payment - interest;
    if (principal > balanceBefore || month === termMonths) {
      principal = balanceBefore;
    }

    // 4-5. Insurance is added to paymentTotal only; an early repayment is not part of it.
    const insurance = computeInsurance(balanceBefore, month, insuranceRate);
    const paymentTotal = principal + interest + insurance;

    // 6. Balance after the regular payment.
    let balanceAfter = balanceBefore - principal;

    // 7. The early repayment of this month is applied AFTER the regular payment
    // (REQ-20) and only up to the remaining balance (REQ-23).
    const early = byMonth.get(month);
    const earlyRepaymentRequested = early === undefined ? 0 : early.entry.amount;
    const earlyRepaymentApplied = Math.min(earlyRepaymentRequested, balanceAfter);
    const earlyRepaymentExcess = earlyRepaymentRequested - earlyRepaymentApplied;
    balanceAfter -= earlyRepaymentApplied;

    schedule.push({
      month,
      paymentTotal,
      interest,
      principal,
      insurance,
      earlyRepaymentRequested,
      earlyRepaymentApplied,
      earlyRepaymentExcess,
      balanceAfter,
    });
    balance = balanceAfter;

    // 8. Recalculation for the remaining term, only if something was actually written
    // off and the credit is still open.
    if (early !== undefined && earlyRepaymentApplied > 0 && balance > 0) {
      if (early.entry.mode === 'reducePayment') {
        // REQ-22: the number of remaining months stays termMonths - month, the payment
        // is recomputed from the new balance.
        payment = computePayment(balance, termMonths - month, i, zeroRate);
      }
      // REQ-21 "reduceTerm": the payment is left unchanged, so the same payment simply
      // clears the smaller balance in fewer months — the loop ends as soon as the
      // balance is gone. Nothing to recompute.
    }
  }

  return schedule;
}

/**
 * Aggregates. REQ-26, REQ-27, REQ-37.
 *
 * Interest and insurance stay separate fields; `overpayment` is derived from them and
 * is never a source of truth (REQ-37). The excess of an early repayment is reported
 * but is part of neither totalPaid nor totalPrincipal (REQ-23).
 */
function computeTotals(input: CreditInput, schedule: ScheduleRow[]): CreditTotals {
  let totalPrincipal = 0;
  let totalInterest = 0;
  let totalInsurance = 0;
  let totalPaid = 0;
  let totalEarlyRepaymentExcess = 0;

  for (const row of schedule) {
    totalPrincipal += row.principal + row.earlyRepaymentApplied;
    totalInterest += row.interest;
    totalInsurance += row.insurance;
    totalPaid += row.paymentTotal + row.earlyRepaymentApplied;
    totalEarlyRepaymentExcess += row.earlyRepaymentExcess;
  }

  const actualTermMonths = schedule.length;
  const first = schedule[0];

  // REQ-26: the first regular payment, insurance excluded.
  const monthlyPayment = first === undefined ? 0 : first.principal + first.interest;

  // REQ-25: an early repayment whose month is never reached, because the credit was
  // already closed, is ignored and reported with its position in the input array.
  const ignoredEarlyRepayments: IgnoredEarlyRepayment[] = [];
  input.earlyRepayments.forEach((entry, index) => {
    if (entry.month > actualTermMonths) {
      ignoredEarlyRepayments.push({ index, month: entry.month, amount: entry.amount });
    }
  });

  return {
    monthlyPayment,
    actualTermMonths,
    totalPrincipal,
    totalInterest,
    totalInsurance,
    totalPaid,
    totalEarlyRepaymentExcess,
    overpayment: totalInterest + totalInsurance,
    ignoredEarlyRepayments,
  };
}

/** Schedule plus totals for an already validated input. REQ-11 … REQ-27. */
export function calculateSchedule(input: CreditInput): {
  schedule: ScheduleRow[];
  totals: CreditTotals;
} {
  const schedule = buildSchedule(input);
  return { schedule, totals: computeTotals(input, schedule) };
}
