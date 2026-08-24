import { expect, test } from '@playwright/test';
import { CalculatorPage } from './pages/CalculatorPage';

/**
 * Browser scenarios for the calculator page.
 *
 * Scope on purpose: arithmetic is covered by 156 core tests and by the Python oracle.
 * What is here is only what cannot be checked without a browser — that the form reaches
 * the core at all, that the button is the one and only trigger (REQ-29), that an invalid
 * input replaces the table with codes (REQ-31), and that the numbers reach the screen
 * in the REQ-30 format without being mangled on the way.
 *
 * Expected money values come from docs/oracle.md (O-01, O-05, O-06) — an external
 * anchor, not from our own implementation. Comparisons are exact strings of whole
 * kopecks; REQ-36 forbids any tolerance.
 */

/** REQ-30: U+00A0 between digit groups and before the ruble sign. */
const NBSP = ' ';

/** Writing '22 244,45 ₽' with real spaces and swapping them keeps the tests readable. */
const money = (text: string): string => text.replace(/ /g, NBSP);

/** docs/oracle.md, O-01 / O-05 / O-06 share this base. */
const ORACLE_BASE = {
  amountRubles: '1000000',
  ratePercent: '12',
  termMonths: '60',
} as const;

/** O-01: PMT in Google Sheets, 2026-08-23. */
const O01_MONTHLY_PAYMENT = money('22 244,45 ₽');

/** O-05: FV + simulation, 2026-08-24. */
const O05_ACTUAL_TERM = money('47 мес.');

/** O-06: FV + PMT in Google Sheets, 2026-08-24 — the payment from month 13 on. */
const O06_PAYMENT_FROM_MONTH_13 = money('16 977,68 ₽');

test.describe('credit calculator UI', () => {
  test('REQ-29, REQ-30: pressing Рассчитать renders a schedule that is not empty', async ({
    page,
  }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();

    // Nothing is shown before the button is pressed.
    await expect(calculator.result).toBeHidden();

    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();

    await expect(calculator.result).toBeVisible();
    await expect(calculator.scheduleTable).toBeVisible();
    await expect(calculator.scheduleRows).toHaveCount(60);
    await expect(calculator.scheduleRow(1)).toBeVisible();
    await expect(calculator.scheduleRow(60)).toBeVisible();

    // REQ-05: the last payment closes the debt exactly.
    expect(await calculator.textOf(calculator.cell(60, 'cell-balance'))).toBe(money('0,00 ₽'));
    expect(await calculator.textOf(calculator.actualTerm)).toBe(money('60 мес.'));
  });

  test('REQ-30 (oracle O-01): the monthly payment on screen is 22 244,45 ₽', async ({ page }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();

    expect(await calculator.textOf(calculator.monthlyPayment)).toBe(O01_MONTHLY_PAYMENT);

    // The first schedule row must show the same payment: the totals block and the table
    // are rendered from the same result, and a mismatch would mean one of them is stale.
    expect(await calculator.textOf(calculator.cell(1, 'cell-payment'))).toBe(O01_MONTHLY_PAYMENT);
  });

  test('REQ-30: money on screen uses a non-breaking separator and a comma', async ({ page }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();

    const total = await calculator.textOf(calculator.totalPaid);

    // Written out rather than via the `money` helper: this is the test that proves the
    // separator really is U+00A0, so it must not rely on the same substitution the other
    // expectations use.
    expect(total).toMatch(/^\d{1,3}(\u00A0\d{3})*,\d{2}\u00A0₽$/);
    expect(total).not.toContain(' ');
    expect(total).toContain(',');
    // Two group separators — a single-group value would satisfy the regex trivially.
    expect(total.split(NBSP)).toHaveLength(4);
  });

  test('REQ-29: changing a field does not recalculate until the button is pressed', async ({
    page,
  }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();
    await expect(calculator.scheduleRows).toHaveCount(60);

    await calculator.term.fill('120');
    // The field really did change and its input/change events really did fire...
    await expect(calculator.term).toHaveValue('120');
    // ...and the rendered result did not move.
    await expect(calculator.scheduleRows).toHaveCount(60);
    await expect(calculator.scheduleRow(120)).toBeHidden();
    expect(await calculator.textOf(calculator.monthlyPayment)).toBe(O01_MONTHLY_PAYMENT);

    await calculator.calculate();
    await expect(calculator.scheduleRows).toHaveCount(120);
    await expect(calculator.scheduleRow(120)).toBeVisible();
  });

  test('REQ-31: invalid input hides the schedule and lists error codes', async ({ page }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();

    // Start from a schedule that IS on screen. Going straight to an invalid input would
    // make the test pass against a UI that never hides the table at all — it would only
    // be observing the initial hidden state. Found by the red phase, session 3.
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();
    await expect(calculator.scheduleRows).toHaveCount(60);

    await calculator.fillBase({ amountRubles: '100', ratePercent: '12', termMonths: '400' });
    await calculator.calculate();

    // REQ-10: every applicable code, in the order of the REQ-09 table — not just the first.
    expect(await calculator.errorCodes()).toEqual(['AMOUNT_OUT_OF_RANGE', 'TERM_OUT_OF_RANGE']);
    await expect(calculator.error('AMOUNT_OUT_OF_RANGE')).toBeVisible();
    await expect(calculator.result).toBeHidden();
    await expect(calculator.scheduleTable).toBeHidden();
    await expect(calculator.scheduleRows).toHaveCount(0);

    // A different failure mode: text where a number belongs takes the NOT_A_NUMBER
    // branch rather than a range check, and must be reported just as structurally.
    await calculator.fillBase({ amountRubles: 'сто рублей', ratePercent: '12', termMonths: '60' });
    await calculator.calculate();
    expect(await calculator.errorCodes()).toEqual(['NOT_A_NUMBER']);
    await expect(calculator.result).toBeHidden();

    // Correcting the input must clear the errors, not merely add a table beside them.
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();
    await expect(calculator.errors).toBeHidden();
    await expect(calculator.result).toBeVisible();
    await expect(calculator.scheduleRows).toHaveCount(60);
  });

  test('REQ-18, REQ-37: insurance changes the total but leaves the payment alone', async ({
    page,
  }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.calculate();

    const paymentWithout = await calculator.textOf(calculator.monthlyPayment);
    const overpaymentWithout = await calculator.textOf(calculator.overpayment);
    const totalPaidWithout = await calculator.textOf(calculator.totalPaid);

    await calculator.enableInsurance('1');
    await calculator.calculate();

    const paymentWith = await calculator.textOf(calculator.monthlyPayment);
    const overpaymentWith = await calculator.textOf(calculator.overpayment);
    const totalPaidWith = await calculator.textOf(calculator.totalPaid);

    // REQ-26: monthlyPayment is the regular payment WITHOUT insurance, so it must not move.
    expect(paymentWith).toBe(paymentWithout);
    expect(paymentWith).toBe(O01_MONTHLY_PAYMENT);
    // REQ-37: the premium lands in the totals, and nowhere else.
    expect(overpaymentWith).not.toBe(overpaymentWithout);
    expect(totalPaidWith).not.toBe(totalPaidWithout);
    // REQ-17: the premium is charged in month 1 and in month 13, not in month 2.
    expect(await calculator.textOf(calculator.cell(2, 'cell-insurance'))).toBe(money('0,00 ₽'));
    expect(await calculator.textOf(calculator.cell(1, 'cell-insurance'))).not.toBe(money('0,00 ₽'));
  });

  test('REQ-21 (oracle O-05): a reduceTerm early repayment shortens the term to 47 months', async ({
    page,
  }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.addEarlyRepayment({
      month: '12',
      amountRubles: '200000',
      mode: 'reduceTerm',
    });
    await calculator.calculate();

    await expect(calculator.result).toBeVisible();
    expect(await calculator.textOf(calculator.actualTerm)).toBe(O05_ACTUAL_TERM);
    await expect(calculator.scheduleRows).toHaveCount(47);
    await expect(calculator.scheduleRow(48)).toBeHidden();
    // REQ-21: the regular payment does not change in this mode.
    expect(await calculator.textOf(calculator.cell(13, 'cell-payment'))).toBe(O01_MONTHLY_PAYMENT);
    // REQ-20: the repayment is shown on the month it was made.
    expect(await calculator.textOf(calculator.cell(12, 'cell-early'))).toBe(money('200 000,00 ₽'));
  });

  test('REQ-22 (oracle O-06): a reducePayment early repayment keeps 60 months and lowers the payment', async ({
    page,
  }) => {
    const calculator = new CalculatorPage(page);
    await calculator.open();
    await calculator.fillBase(ORACLE_BASE);
    await calculator.addEarlyRepayment({
      month: '12',
      amountRubles: '200000',
      mode: 'reducePayment',
    });
    await calculator.calculate();

    await expect(calculator.result).toBeVisible();
    expect(await calculator.textOf(calculator.actualTerm)).toBe(money('60 мес.'));
    await expect(calculator.scheduleRows).toHaveCount(60);
    // Months 1..12 are untouched; month 13 onward pays the recalculated amount.
    expect(await calculator.textOf(calculator.cell(12, 'cell-payment'))).toBe(O01_MONTHLY_PAYMENT);
    expect(await calculator.textOf(calculator.cell(13, 'cell-payment'))).toBe(
      O06_PAYMENT_FROM_MONTH_13,
    );
  });
});
