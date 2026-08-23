/**
 * Public contract of the calculation core.
 * Transcribed from docs/spec.md, REQ-38. Do not change field names here:
 * the tests and the Python oracle are written against this contract.
 */

/** A money amount. Always an integer number of kopecks, non-negative. REQ-01. */
export type Kopecks = number;

export type EarlyRepaymentMode = 'reduceTerm' | 'reducePayment';

export interface EarlyRepaymentInput {
  month: number;
  amount: Kopecks;
  mode: EarlyRepaymentMode;
}

export interface InsuranceInput {
  annualRatePercent: number;
}

export interface CreditInput {
  amount: Kopecks;
  annualRatePercent: number;
  termMonths: number;
  insurance: InsuranceInput | null;
  earlyRepayments: EarlyRepaymentInput[];
}

/** Error codes from the REQ-09 table. */
export type ValidationCode =
  | 'AMOUNT_NOT_INTEGER'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'RATE_OUT_OF_RANGE'
  | 'RATE_TOO_PRECISE'
  | 'TERM_NOT_INTEGER'
  | 'TERM_OUT_OF_RANGE'
  | 'NOT_A_NUMBER'
  | 'INSURANCE_RATE_OUT_OF_RANGE'
  | 'EARLY_MONTH_OUT_OF_RANGE'
  | 'EARLY_AMOUNT_NOT_POSITIVE'
  | 'EARLY_MODE_UNKNOWN'
  | 'EARLY_DUPLICATE_MONTH';

/** One schedule row. Field list is REQ-14. */
export interface ScheduleRow {
  month: number;
  paymentTotal: Kopecks;
  interest: Kopecks;
  principal: Kopecks;
  insurance: Kopecks;
  earlyRepaymentRequested: Kopecks;
  earlyRepaymentApplied: Kopecks;
  earlyRepaymentExcess: Kopecks;
  balanceAfter: Kopecks;
}

/** REQ-25. */
export interface IgnoredEarlyRepayment {
  index: number;
  month: number;
  amount: Kopecks;
}

/** Totals. Field list is REQ-26. */
export interface CreditTotals {
  monthlyPayment: Kopecks;
  actualTermMonths: number;
  totalPrincipal: Kopecks;
  totalInterest: Kopecks;
  totalInsurance: Kopecks;
  totalPaid: Kopecks;
  totalEarlyRepaymentExcess: Kopecks;
  overpayment: Kopecks;
  ignoredEarlyRepayments: IgnoredEarlyRepayment[];
}

export type CalculationResult =
  | { ok: true; schedule: ScheduleRow[]; totals: CreditTotals }
  | { ok: false; errors: ValidationCode[] };
