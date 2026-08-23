/**
 * Money rounding. REQ-04.
 */

import type { Kopecks } from './types';

/**
 * Half-up rounding to whole kopecks. REQ-04.
 *
 * Deliberately NOT Math.round: Math.round(-1.5) === -1, which is half-up towards
 * positive infinity only by accident, and several languages round 2.5 to 2 (banker's
 * rounding). The fractional part is taken as `value - Math.floor(value)` rather than
 * via `Math.floor(value + 0.5)`: adding 0.5 first can itself round up in binary
 * floating point and turn 0.49999999999999994 into 1.
 *
 * Behaviour on negative input is not defined by the spec (REQ-04): every money amount
 * in this calculator is non-negative.
 */
export function roundHalfUp(value: number): Kopecks {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction >= 0.5 ? lower + 1 : lower;
}
