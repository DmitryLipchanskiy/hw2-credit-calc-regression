/**
 * Input validation. REQ-06 … REQ-10.
 *
 * Never throws and never inspects a value in a way that could throw: an invalid input
 * is data, not an exceptional situation (REQ-09).
 */

import type { CreditInput, EarlyRepaymentInput, InsuranceInput, ValidationCode } from './types';

const AMOUNT_MIN = 1_000_000;
const AMOUNT_MAX = 10_000_000_000;
const RATE_MIN = 0;
const RATE_MAX = 100;
const TERM_MIN = 1;
const TERM_MAX = 360;
const INSURANCE_RATE_MIN = 0;
const INSURANCE_RATE_MAX = 10;

/**
 * Order of codes in the REQ-09 table. The returned list follows it (REQ-10),
 * so the order does not depend on the order in which checks happen to run.
 */
const CODE_ORDER: readonly ValidationCode[] = [
  'AMOUNT_NOT_INTEGER',
  'AMOUNT_OUT_OF_RANGE',
  'RATE_OUT_OF_RANGE',
  'RATE_TOO_PRECISE',
  'TERM_NOT_INTEGER',
  'TERM_OUT_OF_RANGE',
  'NOT_A_NUMBER',
  'INSURANCE_RATE_OUT_OF_RANGE',
  'EARLY_MONTH_OUT_OF_RANGE',
  'EARLY_AMOUNT_NOT_POSITIVE',
  'EARLY_MODE_UNKNOWN',
  'EARLY_DUPLICATE_MONTH',
];

/** REQ-09, NOT_A_NUMBER: NaN, Infinity, null, a string or undefined is not a number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * REQ-09, RATE_TOO_PRECISE: more than two decimal places.
 * Compares against the nearest hundredth instead of parsing the decimal text, because
 * a rate is a binary double: 0.07 * 100 === 7.000000000000001, and String(1e-7) is
 * "1e-7" and has no decimal point at all.
 */
function hasMoreThanTwoDecimals(value: number): boolean {
  const scaled = value * 100;
  const drift = scaled - Math.round(scaled);
  return drift > 1e-9 || drift < -1e-9;
}

/**
 * Collects every applicable error code (REQ-10), deduplicated, in REQ-09 table order.
 * An empty array means the input may be calculated.
 */
export function validate(input: CreditInput): ValidationCode[] {
  const found = new Set<ValidationCode>();
  const raw: Partial<CreditInput> = typeof input === 'object' && input !== null ? input : {};

  const amount: unknown = raw.amount;
  if (!isNumber(amount)) {
    found.add('NOT_A_NUMBER');
  } else {
    if (!Number.isInteger(amount)) found.add('AMOUNT_NOT_INTEGER');
    if (amount < AMOUNT_MIN || amount > AMOUNT_MAX) found.add('AMOUNT_OUT_OF_RANGE');
  }

  const rate: unknown = raw.annualRatePercent;
  if (!isNumber(rate)) {
    found.add('NOT_A_NUMBER');
  } else {
    if (rate < RATE_MIN || rate > RATE_MAX) found.add('RATE_OUT_OF_RANGE');
    if (hasMoreThanTwoDecimals(rate)) found.add('RATE_TOO_PRECISE');
  }

  const term: unknown = raw.termMonths;
  if (!isNumber(term)) {
    found.add('NOT_A_NUMBER');
  } else {
    if (!Number.isInteger(term)) found.add('TERM_NOT_INTEGER');
    if (term < TERM_MIN || term > TERM_MAX) found.add('TERM_OUT_OF_RANGE');
  }

  // REQ-07: insurance === null means "no insurance". REQ-09 has no code for an
  // over-precise insurance rate, so only the range is checked.
  const insurance: InsuranceInput | null | undefined = raw.insurance;
  if (insurance !== null && insurance !== undefined) {
    const insuranceRate: unknown = insurance.annualRatePercent;
    if (!isNumber(insuranceRate)) {
      found.add('NOT_A_NUMBER');
    } else if (insuranceRate < INSURANCE_RATE_MIN || insuranceRate > INSURANCE_RATE_MAX) {
      found.add('INSURANCE_RATE_OUT_OF_RANGE');
    }
  }

  // REQ-08. The month range depends on termMonths, so it is only compared against it
  // when termMonths is itself an integer.
  const earlyRepayments: readonly EarlyRepaymentInput[] = Array.isArray(raw.earlyRepayments)
    ? raw.earlyRepayments
    : [];
  const termLimit: number | null = isNumber(term) && Number.isInteger(term) ? term : null;
  const seenMonths = new Set<number>();

  for (const item of earlyRepayments) {
    const entry: Partial<EarlyRepaymentInput> =
      typeof item === 'object' && item !== null ? item : {};

    const month: unknown = entry.month;
    if (!isNumber(month)) {
      found.add('NOT_A_NUMBER');
    } else {
      if (!Number.isInteger(month) || month < 1 || (termLimit !== null && month > termLimit)) {
        found.add('EARLY_MONTH_OUT_OF_RANGE');
      }
      if (seenMonths.has(month)) found.add('EARLY_DUPLICATE_MONTH');
      seenMonths.add(month);
    }

    const earlyAmount: unknown = entry.amount;
    if (!isNumber(earlyAmount)) {
      found.add('NOT_A_NUMBER');
    } else if (!Number.isInteger(earlyAmount) || earlyAmount <= 0) {
      found.add('EARLY_AMOUNT_NOT_POSITIVE');
    }

    if (entry.mode !== 'reduceTerm' && entry.mode !== 'reducePayment') {
      found.add('EARLY_MODE_UNKNOWN');
    }
  }

  return CODE_ORDER.filter((code) => found.has(code));
}
