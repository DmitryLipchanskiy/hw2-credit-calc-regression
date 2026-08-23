/**
 * Общая функция-проверяльщик инвариантов графика.
 *
 * REQ-16 (INV-01 … INV-08) плюс согласованность итогов REQ-26 / REQ-27,
 * которую спецификация тоже объявляет свойством каждого расчёта,
 * а не отдельным тестом.
 *
 * Вызывается из КАЖДОГО кейса, где расчёт завершился успешно.
 * Отдельными тестами инварианты не проверяются — см. REQ-16.
 *
 * Все денежные сравнения — строгое равенство целых копеек (REQ-36).
 * Матчеры с параметром точности и округление перед сравнением запрещены.
 */
import { expect } from '@playwright/test';
import type {
  CalculationResult,
  CreditInput,
  CreditTotals,
  ScheduleRow,
} from '../../src/core/types';

/** Денежные поля строки графика. REQ-14. */
export const ROW_MONEY_FIELDS = [
  'paymentTotal',
  'interest',
  'principal',
  'insurance',
  'earlyRepaymentRequested',
  'earlyRepaymentApplied',
  'earlyRepaymentExcess',
  'balanceAfter',
] as const;

/** Денежные поля итогов. REQ-26. */
export const TOTALS_MONEY_FIELDS = [
  'monthlyPayment',
  'totalPrincipal',
  'totalInterest',
  'totalInsurance',
  'totalPaid',
  'totalEarlyRepaymentExcess',
  'overpayment',
] as const;

function sumBy(rows: ScheduleRow[], field: (typeof ROW_MONEY_FIELDS)[number]): number {
  let acc = 0;
  for (const row of rows) {
    acc += row[field];
  }
  return acc;
}

/**
 * Проверяет INV-01 … INV-08 и согласованность итогов REQ-26 / REQ-27
 * на одном успешном расчёте.
 *
 * @param input  вход, с которым был выполнен расчёт
 * @param result результат calculateCredit
 */
export function checkInvariants(input: CreditInput, result: CalculationResult): void {
  expect(result.ok, 'invariants are defined only for a successful calculation').toBe(true);
  if (!result.ok) {
    return;
  }

  const schedule: ScheduleRow[] = result.schedule;
  const totals: CreditTotals = result.totals;

  // INV-05: 1 ≤ actualTermMonths ≤ termMonths, месяцы идут подряд от 1 без пропусков.
  expect(schedule.length, 'INV-05: schedule must contain at least one row').toBeGreaterThanOrEqual(1);
  expect(
    schedule.length,
    'INV-05: schedule must not be longer than the requested term',
  ).toBeLessThanOrEqual(input.termMonths);
  expect(totals.actualTermMonths, 'INV-05: actualTermMonths equals the number of rows').toBe(
    schedule.length,
  );
  for (let i = 0; i < schedule.length; i += 1) {
    expect(schedule[i]!.month, `INV-05: month numbers are consecutive from 1 (row ${i})`).toBe(i + 1);
  }

  for (let i = 0; i < schedule.length; i += 1) {
    const row = schedule[i]!;

    // INV-06: все денежные поля строки — целые и ≥ 0; interest ≥ 0; principal > 0.
    for (const field of ROW_MONEY_FIELDS) {
      expect(
        Number.isInteger(row[field]),
        `INV-06: row ${row.month} field ${field} must be an integer number of kopecks`,
      ).toBe(true);
      expect(
        row[field],
        `INV-06: row ${row.month} field ${field} must be non-negative`,
      ).toBeGreaterThanOrEqual(0);
    }
    // Weakened from "strictly positive" to "non-negative" — see D-23. A strictly
    // positive principal does not follow from the specification: when
    // roundHalfUp(B*K) equals roundHalfUp(B*i), the debt is not amortised at all
    // and the whole body is closed by the corrective final payment. INV-02 still
    // guarantees the loan closes.
    expect(row.principal, `INV-06: row ${row.month} principal must not be negative`).toBeGreaterThanOrEqual(0);

    // INV-04: paymentTotal === principal + interest + insurance.
    expect(
      row.paymentTotal,
      `INV-04: row ${row.month} paymentTotal must equal principal + interest + insurance`,
    ).toBe(row.principal + row.interest + row.insurance);

    // INV-07: applied + excess === requested.
    expect(
      row.earlyRepaymentApplied + row.earlyRepaymentExcess,
      `INV-07: row ${row.month} applied + excess must equal requested`,
    ).toBe(row.earlyRepaymentRequested);

    // INV-03: balanceAfter монотонно не возрастает.
    const previousBalance = i === 0 ? input.amount : schedule[i - 1]!.balanceAfter;
    expect(
      row.balanceAfter,
      `INV-03: row ${row.month} balanceAfter must not grow`,
    ).toBeLessThanOrEqual(previousBalance);
  }

  // INV-02: остаток последней строки погашен ровно в ноль (REQ-05).
  expect(
    schedule[schedule.length - 1]!.balanceAfter,
    'INV-02: balanceAfter of the last row must be exactly zero',
  ).toBe(0);

  const sumPrincipal = sumBy(schedule, 'principal');
  const sumInterest = sumBy(schedule, 'interest');
  const sumInsurance = sumBy(schedule, 'insurance');
  const sumPaymentTotal = sumBy(schedule, 'paymentTotal');
  const sumApplied = sumBy(schedule, 'earlyRepaymentApplied');
  const sumExcess = sumBy(schedule, 'earlyRepaymentExcess');

  // INV-01: тело кредита погашено ровно.
  expect(
    sumPrincipal + sumApplied,
    'INV-01: sum(principal) + sum(earlyRepaymentApplied) must equal the credit amount',
  ).toBe(input.amount);

  // INV-08: totalPaid === totalPrincipal + totalInterest + totalInsurance.
  expect(
    totals.totalPaid,
    'INV-08: totalPaid must equal totalPrincipal + totalInterest + totalInsurance',
  ).toBe(totals.totalPrincipal + totals.totalInterest + totals.totalInsurance);

  // REQ-26: определения агрегатов.
  expect(totals.totalPrincipal, 'REQ-26: totalPrincipal is sum(principal) + sum(applied)').toBe(
    sumPrincipal + sumApplied,
  );
  expect(totals.totalInterest, 'REQ-26: totalInterest is sum(interest)').toBe(sumInterest);
  expect(totals.totalInsurance, 'REQ-26: totalInsurance is sum(insurance)').toBe(sumInsurance);
  expect(totals.totalPaid, 'REQ-26: totalPaid is sum(paymentTotal) + sum(applied)').toBe(
    sumPaymentTotal + sumApplied,
  );
  expect(
    totals.totalEarlyRepaymentExcess,
    'REQ-26: totalEarlyRepaymentExcess is sum(earlyRepaymentExcess)',
  ).toBe(sumExcess);
  expect(totals.overpayment, 'REQ-26: overpayment is totalInterest + totalInsurance').toBe(
    totals.totalInterest + totals.totalInsurance,
  );

  // REQ-27: согласованность итогов.
  expect(totals.totalPrincipal, 'REQ-27: totalPrincipal must equal the credit amount').toBe(
    input.amount,
  );
  expect(totals.overpayment, 'REQ-27: overpayment must equal totalPaid minus amount').toBe(
    totals.totalPaid - input.amount,
  );

  // REQ-01: денежные итоги — целые копейки.
  for (const field of TOTALS_MONEY_FIELDS) {
    expect(
      Number.isInteger(totals[field]),
      `REQ-01: totals field ${field} must be an integer number of kopecks`,
    ).toBe(true);
    expect(totals[field], `REQ-01: totals field ${field} must be non-negative`).toBeGreaterThanOrEqual(0);
  }

  // REQ-25: список проигнорированных досрочек — всегда массив, не null и не undefined.
  expect(
    Array.isArray(totals.ignoredEarlyRepayments),
    'REQ-25: ignoredEarlyRepayments must always be an array',
  ).toBe(true);
}
