/**
 * Calculation core. Public contract — docs/spec.md, REQ-38.
 *
 * calculateCredit is the single entry point; roundHalfUp is exported because REQ-04
 * fixes its behaviour separately from the schedule.
 */

import { calculateSchedule } from './schedule';
import type { CalculationResult, CreditInput, EarlyRepaymentInput } from './types';
import { validate } from './validate';

export * from './types';
export { roundHalfUp } from './round';

/**
 * Single entry point of the core. REQ-09: never throws, never returns NaN, Infinity
 * or a half-filled result — an invalid input is `{ ok: false, errors }` with every
 * applicable code (REQ-10).
 */
export function calculateCredit(input: CreditInput): CalculationResult {
  try {
    const errors = validate(input);
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // Validation accepts an absent insurance object and an absent early repayment list
    // as "none"; the calculation below expects them in their canonical shape.
    const earlyRepayments: EarlyRepaymentInput[] = Array.isArray(input.earlyRepayments)
      ? input.earlyRepayments
      : [];
    const { schedule, totals } = calculateSchedule({
      amount: input.amount,
      annualRatePercent: input.annualRatePercent,
      termMonths: input.termMonths,
      insurance: input.insurance ?? null,
      earlyRepayments,
    });

    return { ok: true, schedule, totals };
  } catch {
    // REQ-09 is unconditional: no input may make the core throw. Validation above
    // already covers every documented case, so this guard should stay unreachable.
    return { ok: false, errors: ['NOT_A_NUMBER'] };
  }
}
