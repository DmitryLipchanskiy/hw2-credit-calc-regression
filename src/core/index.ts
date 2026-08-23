/**
 * Calculation core — STUB.
 *
 * Every function throws NotImplemented on purpose. The test suites written by the
 * blind agents are run against this stub first: all of them must fail. A test that
 * passes here asserts nothing and is broken by definition. See CLAUDE.md, rule 4.2.
 */

import type { CalculationResult, CreditInput, Kopecks } from './types';

export * from './types';

/** Single entry point of the core. Never throws once implemented (REQ-09). */
export function calculateCredit(input: CreditInput): CalculationResult {
  void input;
  throw new Error('NotImplemented');
}

/** Half-up rounding to whole kopecks. REQ-04. */
export function roundHalfUp(value: number): Kopecks {
  void value;
  throw new Error('NotImplemented');
}
