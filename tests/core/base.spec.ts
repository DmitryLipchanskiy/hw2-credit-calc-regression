/**
 * Базовый набор проверок ядра кредитного калькулятора.
 *
 * Написан по docs/spec.md и docs/oracle.md, без чтения реализации.
 * Точные числа берутся только из контрольных точек oracle.md (ссылка O-NN
 * в комментарии) либо считаются по формуле спецификации в одну операцию.
 * Помесячных таблиц, посчитанных вручную, здесь нет — см. D-15.
 *
 * Все денежные величины — целые копейки, все сравнения денег —
 * строгое равенство (REQ-01, REQ-36).
 */
import { test, expect } from '@playwright/test';
import { calculateCredit, roundHalfUp } from '../../src/core';
import type {
  CalculationResult,
  CreditInput,
  CreditTotals,
  ScheduleRow,
  ValidationCode,
} from '../../src/core/types';
import { checkInvariants, ROW_MONEY_FIELDS, TOTALS_MONEY_FIELDS } from './invariants';

// ---------------------------------------------------------------------------
// Входы контрольных точек oracle.md
// ---------------------------------------------------------------------------

/** O-01: 1 000 000 ₽, 12,00 % годовых, 60 месяцев, без страховки и досрочки. */
const O01: CreditInput = {
  amount: 100_000_000,
  annualRatePercent: 12,
  termMonths: 60,
  insurance: null,
  earlyRepayments: [],
};

/** O-02: 3 000 000 ₽, 9,50 %, 240 месяцев. */
const O02: CreditInput = {
  amount: 300_000_000,
  annualRatePercent: 9.5,
  termMonths: 240,
  insurance: null,
  earlyRepayments: [],
};

/** O-03: 120 000 ₽, 0,00 %, 12 месяцев — ветка REQ-13. */
const O03: CreditInput = {
  amount: 12_000_000,
  annualRatePercent: 0,
  termMonths: 12,
  insurance: null,
  earlyRepayments: [],
};

/** O-04: параметры O-01 плюс страховка 1,00 % годовых от остатка. Пара к O-01 для REQ-37. */
const O04: CreditInput = {
  amount: 100_000_000,
  annualRatePercent: 12,
  termMonths: 60,
  insurance: { annualRatePercent: 1 },
  earlyRepayments: [],
};

/** O-07: 500 000 ₽, 19,90 %, 36 месяцев — некруглая ставка. */
const O07: CreditInput = {
  amount: 50_000_000,
  annualRatePercent: 19.9,
  termMonths: 36,
  insurance: null,
  earlyRepayments: [],
};

/** O-08: 5 000 000 ₽, 8,40 %, 180 месяцев. */
const O08: CreditInput = {
  amount: 500_000_000,
  annualRatePercent: 8.4,
  termMonths: 180,
  insurance: null,
  earlyRepayments: [],
};

/** Пара к O-03: та же сделка под минимальной ненулевой ставкой 0,01 % (REQ-13, D-06). */
const MINIMAL_NON_ZERO_RATE: CreditInput = {
  amount: 12_000_000,
  annualRatePercent: 0.01,
  termMonths: 12,
  insurance: null,
  earlyRepayments: [],
};

/** Сумма, не кратная рублю, — проверка целочисленной арифметики (REQ-02). */
const NON_ROUND_AMOUNT: CreditInput = {
  amount: 1_234_567,
  annualRatePercent: 13.37,
  termMonths: 7,
  insurance: null,
  earlyRepayments: [],
};

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

/**
 * Выполняет расчёт, требует успеха и прогоняет инварианты INV-01…INV-08
 * (REQ-16) на каждом успешном расчёте.
 */
function run(input: CreditInput): { schedule: ScheduleRow[]; totals: CreditTotals } {
  const result: CalculationResult = calculateCredit(input);
  expect(result.ok, 'REQ-09: valid input must produce a successful calculation').toBe(true);
  checkInvariants(input, result);
  const success = result as Extract<CalculationResult, { ok: true }>;
  return { schedule: success.schedule, totals: success.totals };
}

/** Выполняет расчёт, требует отказа и возвращает список кодов (REQ-09). */
function errorsOf(input: CreditInput): ValidationCode[] {
  const result: CalculationResult = calculateCredit(input);
  expect(result.ok, 'REQ-09: invalid input must be rejected without throwing').toBe(false);
  return (result as Extract<CalculationResult, { ok: false }>).errors;
}

/** Копия валидного входа с одним заменённым полем. */
function withField(base: CreditInput, patch: Record<string, unknown>): CreditInput {
  return { ...base, ...patch } as unknown as CreditInput;
}

// ===========================================================================
// REQ-01, REQ-02 — деньги целые, арифметика целочисленная
// ===========================================================================

test('REQ-01: every money field of the totals is an integer number of kopecks', () => {
  const { totals } = run(O01);
  for (const field of TOTALS_MONEY_FIELDS) {
    expect(Number.isInteger(totals[field]), `totals.${field} must be an integer`).toBe(true);
  }
});

test('REQ-01: every money field of every schedule row is an integer number of kopecks', () => {
  const { schedule } = run(O01);
  for (const row of schedule) {
    for (const field of ROW_MONEY_FIELDS) {
      expect(Number.isInteger(row[field]), `row ${row.month}.${field} must be an integer`).toBe(true);
    }
  }
});

test('REQ-02: a non round amount is repaid to the last kopeck without loss', () => {
  const { totals } = run(NON_ROUND_AMOUNT);
  expect(totals.totalPrincipal).toBe(NON_ROUND_AMOUNT.amount);
});

test('REQ-02: a non round amount produces only integer money fields in the schedule', () => {
  const { schedule } = run(NON_ROUND_AMOUNT);
  for (const row of schedule) {
    for (const field of ROW_MONEY_FIELDS) {
      expect(Number.isInteger(row[field]), `row ${row.month}.${field} must be an integer`).toBe(true);
    }
  }
});

// ===========================================================================
// REQ-04 — округление half-up
// ===========================================================================

test('REQ-04: roundHalfUp rounds 1.5 up to 2', () => {
  expect(roundHalfUp(1.5)).toBe(2);
});

test('REQ-04: roundHalfUp rounds 2.5 up to 3 and not down to the even 2', () => {
  expect(roundHalfUp(2.5)).toBe(3);
});

test('REQ-04: roundHalfUp rounds 4.5 up to 5 and not down to the even 4', () => {
  expect(roundHalfUp(4.5)).toBe(5);
});

test('REQ-04: roundHalfUp rounds 0.5 up to 1 and not down to the even 0', () => {
  expect(roundHalfUp(0.5)).toBe(1);
});

test('REQ-04: roundHalfUp rounds 1.4999 down to 1', () => {
  expect(roundHalfUp(1.4999)).toBe(1);
});

test('REQ-04: roundHalfUp rounds 0.4999 down to 0', () => {
  expect(roundHalfUp(0.4999)).toBe(0);
});

test('REQ-04: roundHalfUp leaves an already integer value unchanged', () => {
  expect(roundHalfUp(7)).toBe(7);
});

// ===========================================================================
// REQ-05 — последний платёж корректирующий
// ===========================================================================

test('REQ-05: the balance after the last row is exactly zero', () => {
  const { schedule } = run(O01);
  expect(schedule[schedule.length - 1]!.balanceAfter).toBe(0);
});

test('REQ-05: the principal of the last row equals the balance left after the previous row', () => {
  const { schedule } = run(O01);
  const last = schedule[schedule.length - 1]!;
  const previous = schedule[schedule.length - 2]!;
  expect(last.principal).toBe(previous.balanceAfter);
});

test('REQ-05: the balance after the last row is exactly zero for a non round amount too', () => {
  const { schedule } = run(NON_ROUND_AMOUNT);
  expect(schedule[schedule.length - 1]!.balanceAfter).toBe(0);
});

// ===========================================================================
// REQ-06 … REQ-10 — валидация
// ===========================================================================

test('REQ-09: a fully valid input is accepted', () => {
  const result = calculateCredit(O01);
  expect(result.ok).toBe(true);
});

test('REQ-09: a non integer amount is rejected with AMOUNT_NOT_INTEGER', () => {
  expect(errorsOf(withField(O01, { amount: 100_000_000.5 }))).toEqual(['AMOUNT_NOT_INTEGER']);
});

test('REQ-09: an amount below the lower bound is rejected with AMOUNT_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { amount: 999_999 }))).toEqual(['AMOUNT_OUT_OF_RANGE']);
});

test('REQ-09: an amount above the upper bound is rejected with AMOUNT_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { amount: 10_000_000_001 }))).toEqual(['AMOUNT_OUT_OF_RANGE']);
});

test('REQ-09: a rate above 100 percent is rejected with RATE_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { annualRatePercent: 101 }))).toEqual(['RATE_OUT_OF_RANGE']);
});

test('REQ-09: a negative rate is rejected with RATE_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { annualRatePercent: -1 }))).toEqual(['RATE_OUT_OF_RANGE']);
});

test('REQ-09: a rate with three decimal places is rejected with RATE_TOO_PRECISE', () => {
  // D-14: правило точности REQ-06 несёт нагрузку в REQ-13 и должно быть покрыто само.
  expect(errorsOf(withField(O01, { annualRatePercent: 0.001 }))).toEqual(['RATE_TOO_PRECISE']);
});

test('REQ-09: a rate of 12.345 percent is rejected with RATE_TOO_PRECISE', () => {
  expect(errorsOf(withField(O01, { annualRatePercent: 12.345 }))).toEqual(['RATE_TOO_PRECISE']);
});

test('REQ-09: a non integer term is rejected with TERM_NOT_INTEGER', () => {
  expect(errorsOf(withField(O01, { termMonths: 12.5 }))).toEqual(['TERM_NOT_INTEGER']);
});

test('REQ-09: a term of zero months is rejected with TERM_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { termMonths: 0 }))).toEqual(['TERM_OUT_OF_RANGE']);
});

test('REQ-09: a term of 361 months is rejected with TERM_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { termMonths: 361 }))).toEqual(['TERM_OUT_OF_RANGE']);
});

test('REQ-09: an amount of NaN is reported as NOT_A_NUMBER', () => {
  expect(errorsOf(withField(O01, { amount: Number.NaN }))).toContain('NOT_A_NUMBER');
});

test('REQ-09: a rate of Infinity is reported as NOT_A_NUMBER', () => {
  expect(errorsOf(withField(O01, { annualRatePercent: Number.POSITIVE_INFINITY }))).toContain(
    'NOT_A_NUMBER',
  );
});

test('REQ-09: a term given as a string is reported as NOT_A_NUMBER', () => {
  expect(errorsOf(withField(O01, { termMonths: '60' }))).toContain('NOT_A_NUMBER');
});

test('REQ-09: an insurance rate above 10 percent is rejected with INSURANCE_RATE_OUT_OF_RANGE', () => {
  expect(errorsOf(withField(O01, { insurance: { annualRatePercent: 15 } }))).toEqual([
    'INSURANCE_RATE_OUT_OF_RANGE',
  ]);
});

test('REQ-09: an early repayment after the last month is rejected with EARLY_MONTH_OUT_OF_RANGE', () => {
  const input = withField(O01, {
    earlyRepayments: [{ month: 61, amount: 10_000_000, mode: 'reduceTerm' }],
  });
  expect(errorsOf(input)).toEqual(['EARLY_MONTH_OUT_OF_RANGE']);
});

test('REQ-09: an early repayment in month zero is rejected with EARLY_MONTH_OUT_OF_RANGE', () => {
  const input = withField(O01, {
    earlyRepayments: [{ month: 0, amount: 10_000_000, mode: 'reduceTerm' }],
  });
  expect(errorsOf(input)).toEqual(['EARLY_MONTH_OUT_OF_RANGE']);
});

test('REQ-09: an early repayment of zero is rejected with EARLY_AMOUNT_NOT_POSITIVE', () => {
  const input = withField(O01, {
    earlyRepayments: [{ month: 12, amount: 0, mode: 'reduceTerm' }],
  });
  expect(errorsOf(input)).toEqual(['EARLY_AMOUNT_NOT_POSITIVE']);
});

test('REQ-09: a non integer early repayment is rejected with EARLY_AMOUNT_NOT_POSITIVE', () => {
  const input = withField(O01, {
    earlyRepayments: [{ month: 12, amount: 10_000.5, mode: 'reduceTerm' }],
  });
  expect(errorsOf(input)).toEqual(['EARLY_AMOUNT_NOT_POSITIVE']);
});

test('REQ-09: an unknown early repayment mode is rejected with EARLY_MODE_UNKNOWN', () => {
  const input = withField(O01, {
    earlyRepayments: [{ month: 12, amount: 10_000_000, mode: 'reduceInterest' }],
  });
  expect(errorsOf(input)).toEqual(['EARLY_MODE_UNKNOWN']);
});

test('REQ-09: two early repayments in the same month are rejected with EARLY_DUPLICATE_MONTH', () => {
  const input = withField(O01, {
    earlyRepayments: [
      { month: 12, amount: 10_000_000, mode: 'reduceTerm' },
      { month: 12, amount: 20_000_000, mode: 'reducePayment' },
    ],
  });
  expect(errorsOf(input)).toEqual(['EARLY_DUPLICATE_MONTH']);
});

test('REQ-10: a negative amount together with a 400 month term yields exactly two codes', () => {
  const input = withField(O01, { amount: -100_000_000, termMonths: 400 });
  expect(errorsOf(input)).toEqual(['AMOUNT_OUT_OF_RANGE', 'TERM_OUT_OF_RANGE']);
});

test('REQ-10: three invalid fields yield all three codes in the order of the REQ-09 table', () => {
  const input = withField(O01, {
    annualRatePercent: 101,
    termMonths: 361,
    insurance: { annualRatePercent: 15 },
  });
  expect(errorsOf(input)).toEqual([
    'RATE_OUT_OF_RANGE',
    'TERM_OUT_OF_RANGE',
    'INSURANCE_RATE_OUT_OF_RANGE',
  ]);
});

// ===========================================================================
// REQ-11, REQ-12 — месячная ставка и аннуитетный платёж
// ===========================================================================

test('REQ-11: the interest of the first month follows from the monthly rate on a non round rate', () => {
  // roundHalfUp(50 000 000 * 19.9 / 100 / 12) = roundHalfUp(829 166.666…) = 829 167 копеек.
  const { schedule } = run(O07);
  expect(schedule[0]!.interest).toBe(829_167);
});

test('REQ-12: the monthly payment of the base annuity matches the external control point', () => {
  // O-01: 22 244,45 ₽ = 2 224 445 копеек (Google Sheets PMT, oracle.md).
  const { totals } = run(O01);
  expect(totals.monthlyPayment).toBe(2_224_445);
});

test('REQ-12: the monthly payment over a 240 month term matches the external control point', () => {
  // O-02: 27 963,94 ₽ = 2 796 394 копейки.
  const { totals } = run(O02);
  expect(totals.monthlyPayment).toBe(2_796_394);
});

test('REQ-12: the monthly payment at a 19.90 percent rate matches the external control point', () => {
  // O-07: 18 556,33 ₽ = 1 855 633 копейки.
  const { totals } = run(O07);
  expect(totals.monthlyPayment).toBe(1_855_633);
});

test('REQ-12: the monthly payment over a 180 month term matches the external control point', () => {
  // O-08: 48 944,33 ₽ = 4 894 433 копейки.
  const { totals } = run(O08);
  expect(totals.monthlyPayment).toBe(4_894_433);
});

// ===========================================================================
// REQ-13 — нулевая ставка и граница ветвления (пара кейсов)
// ===========================================================================

test('REQ-13: a zero rate produces a payment equal to the amount divided by the term', () => {
  // O-03: 120 000 ₽ / 12 = 10 000,00 ₽ = 1 000 000 копеек, roundHalfUp(12 000 000 / 12).
  const { totals } = run(O03);
  expect(totals.monthlyPayment).toBe(1_000_000);
});

test('REQ-13: a zero rate produces no interest at all', () => {
  const { totals } = run(O03);
  expect(totals.totalInterest).toBe(0);
});

test('REQ-13: a zero rate produces zero overpayment', () => {
  const { totals } = run(O03);
  expect(totals.overpayment).toBe(0);
});

test('REQ-13: a zero rate charges no interest in any month of the schedule', () => {
  const { schedule } = run(O03);
  for (const row of schedule) {
    expect(row.interest, `month ${row.month} must carry no interest`).toBe(0);
  }
});

test('REQ-13: a rate of 0.01 percent is not rejected and is not routed to the zero rate branch', () => {
  // D-14: ноль и «слишком точное значение» — соседние ветки, 0.01 обязан быть валиден.
  const result = calculateCredit(MINIMAL_NON_ZERO_RATE);
  expect(result.ok).toBe(true);
});

test('REQ-13: a rate of 0.01 percent produces strictly positive total interest', () => {
  const { totals } = run(MINIMAL_NON_ZERO_RATE);
  expect(totals.totalInterest).toBeGreaterThan(0);
});

test('REQ-13: a rate of 0.01 percent charges interest in the first month by REQ-12', () => {
  // roundHalfUp(12 000 000 * 0.01 / 100 / 12) = roundHalfUp(100) = 100 копеек.
  const { schedule } = run(MINIMAL_NON_ZERO_RATE);
  expect(schedule[0]!.interest).toBe(100);
});

test('REQ-13: a rate of 0.01 percent gives a payment strictly above the zero rate payment', () => {
  const { totals } = run(MINIMAL_NON_ZERO_RATE);
  expect(totals.monthlyPayment).toBeGreaterThan(1_000_000);
});

test('REQ-13: a zero rate input is not rejected by the rate precision rule', () => {
  // D-14: ноль не должен уехать в RATE_TOO_PRECISE.
  const result = calculateCredit(O03);
  expect(result.ok).toBe(true);
});

// ===========================================================================
// REQ-14 — состав строки графика
// ===========================================================================

test('REQ-14: every schedule row carries all the fields listed in the specification', () => {
  const { schedule } = run(O01);
  const expectedFields = ['month', ...ROW_MONEY_FIELDS];
  for (const row of schedule) {
    for (const field of expectedFields) {
      expect(row, `row ${row.month} must have field ${field}`).toHaveProperty(field);
    }
  }
});

test('REQ-14: the month numbers of the schedule start at 1 and run without gaps', () => {
  const { schedule } = run(O01);
  expect(schedule.map((row) => row.month)).toEqual(
    Array.from({ length: schedule.length }, (_unused, index) => index + 1),
  );
});

test('REQ-14: the early repayment fields are zero on a schedule without early repayments', () => {
  const { schedule } = run(O01);
  for (const row of schedule) {
    expect(row.earlyRepaymentRequested, `month ${row.month} requested`).toBe(0);
    expect(row.earlyRepaymentApplied, `month ${row.month} applied`).toBe(0);
    expect(row.earlyRepaymentExcess, `month ${row.month} excess`).toBe(0);
  }
});

test('REQ-14: the insurance field is zero on a schedule without insurance', () => {
  const { schedule } = run(O01);
  for (const row of schedule) {
    expect(row.insurance, `month ${row.month} insurance`).toBe(0);
  }
});

// ===========================================================================
// REQ-15 — порядок вычислений внутри месяца
// ===========================================================================

test('REQ-15: the interest of the first month is charged on the opening balance', () => {
  // roundHalfUp(100 000 000 * 12 / 100 / 12) = 1 000 000 копеек = 10 000,00 ₽.
  // Проценты от balanceAfter дали бы меньшее значение — мутация ловится здесь же.
  const { schedule } = run(O01);
  expect(schedule[0]!.interest).toBe(1_000_000);
});

test('REQ-15: the principal of the first month is the payment minus the interest', () => {
  const { schedule, totals } = run(O01);
  expect(schedule[0]!.principal).toBe(totals.monthlyPayment - schedule[0]!.interest);
});

test('REQ-15: the balance after the first month is the amount minus the principal', () => {
  const { schedule } = run(O01);
  expect(schedule[0]!.balanceAfter).toBe(O01.amount - schedule[0]!.principal);
});

test('REQ-15: the interest of the second month is strictly smaller than that of the first', () => {
  // Проценты начисляются на убывающий остаток: если бы базой была исходная сумма
  // или balanceAfter текущего месяца, это отношение сломалось бы.
  const { schedule } = run(O01);
  expect(schedule[1]!.interest).toBeLessThan(schedule[0]!.interest);
});

// ===========================================================================
// REQ-26 — состав итогов
// ===========================================================================

test('REQ-26: the totals carry every field listed in the specification', () => {
  const { totals } = run(O01);
  const expectedFields = [...TOTALS_MONEY_FIELDS, 'actualTermMonths', 'ignoredEarlyRepayments'];
  for (const field of expectedFields) {
    expect(totals, `totals must have field ${field}`).toHaveProperty(field);
  }
});

test('REQ-26: actualTermMonths equals the number of rows in the schedule', () => {
  const { schedule, totals } = run(O01);
  expect(totals.actualTermMonths).toBe(schedule.length);
});

test('REQ-26: a schedule without early repayment runs for the full requested term', () => {
  // O-01: фактический срок 60 месяцев.
  const { totals } = run(O01);
  expect(totals.actualTermMonths).toBe(60);
});

test('REQ-26: monthlyPayment equals the total of the first row when there is no insurance', () => {
  const { schedule, totals } = run(O01);
  expect(totals.monthlyPayment).toBe(schedule[0]!.paymentTotal);
});

test('REQ-26: monthlyPayment excludes the insurance premium of the first month', () => {
  const { schedule, totals } = run(O04);
  expect(totals.monthlyPayment).toBe(schedule[0]!.paymentTotal - schedule[0]!.insurance);
});

test('REQ-26: ignoredEarlyRepayments is an empty array when there are no early repayments', () => {
  const { totals } = run(O01);
  expect(totals.ignoredEarlyRepayments).toEqual([]);
});

test('REQ-26: totalEarlyRepaymentExcess is zero when there are no early repayments', () => {
  const { totals } = run(O01);
  expect(totals.totalEarlyRepaymentExcess).toBe(0);
});

test('REQ-26: totalInsurance is zero when there is no insurance', () => {
  const { totals } = run(O01);
  expect(totals.totalInsurance).toBe(0);
});

// ===========================================================================
// REQ-37 — проценты и страховка раздельно (пара кейсов O-01 / O-04)
// ===========================================================================

test('REQ-37: totalInterest is strictly identical with and without insurance', () => {
  const withoutInsurance = run(O01);
  const withInsurance = run(O04);
  expect(withInsurance.totals.totalInterest).toBe(withoutInsurance.totals.totalInterest);
});

test('REQ-37: totalInsurance is zero in the calculation without insurance', () => {
  const withoutInsurance = run(O01);
  expect(withoutInsurance.totals.totalInsurance).toBe(0);
});

test('REQ-37: totalInsurance is strictly positive in the calculation with insurance', () => {
  const withInsurance = run(O04);
  expect(withInsurance.totals.totalInsurance).toBeGreaterThan(0);
});

test('REQ-37: the overpayment differs between the two calculations exactly by the insurance', () => {
  const withoutInsurance = run(O01);
  const withInsurance = run(O04);
  expect(withInsurance.totals.overpayment - withoutInsurance.totals.overpayment).toBe(
    withInsurance.totals.totalInsurance,
  );
});

test('REQ-37: totalPaid differs between the two calculations exactly by the insurance', () => {
  const withoutInsurance = run(O01);
  const withInsurance = run(O04);
  expect(withInsurance.totals.totalPaid - withoutInsurance.totals.totalPaid).toBe(
    withInsurance.totals.totalInsurance,
  );
});

test('REQ-37: the monthly payment is the same with and without insurance', () => {
  const withoutInsurance = run(O01);
  const withInsurance = run(O04);
  expect(withInsurance.totals.monthlyPayment).toBe(withoutInsurance.totals.monthlyPayment);
});
