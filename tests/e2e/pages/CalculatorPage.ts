import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page Object for the calculator page.
 *
 * REQ-32: every locator here is built from a data-* hook. No class selectors and no
 * position-based ones — `.nth(0)`, `.first()` and `:nth-child` appear nowhere, because
 * a row's identity is its month and an early-repayment row's identity is its data-index,
 * not where it happens to sit in the DOM.
 */

export type EarlyMode = 'reduceTerm' | 'reducePayment';

export interface BaseParameters {
  /** Rubles, as a human types them into the field. */
  amountRubles: string;
  ratePercent: string;
  termMonths: string;
}

export interface EarlyRepayment {
  month: string;
  amountRubles: string;
  mode: EarlyMode;
}

/** Columns of the schedule table, by their data-testid. */
export type ScheduleColumn =
  | 'cell-month'
  | 'cell-payment'
  | 'cell-interest'
  | 'cell-principal'
  | 'cell-insurance'
  | 'cell-early'
  | 'cell-balance';

export class CalculatorPage {
  readonly amount: Locator;
  readonly rate: Locator;
  readonly term: Locator;
  readonly insuranceEnabled: Locator;
  readonly insuranceRate: Locator;
  readonly calculateButton: Locator;
  readonly result: Locator;
  readonly errors: Locator;
  readonly monthlyPayment: Locator;
  readonly actualTerm: Locator;
  readonly totalPaid: Locator;
  readonly overpayment: Locator;
  readonly scheduleTable: Locator;
  readonly scheduleRows: Locator;

  /** Mirrors the page's own counter so a row can be addressed by a stable index. */
  private addedEarlyRepayments = 0;

  constructor(private readonly page: Page) {
    this.amount = page.getByTestId('amount');
    this.rate = page.getByTestId('rate');
    this.term = page.getByTestId('term');
    this.insuranceEnabled = page.getByTestId('insurance-enabled');
    this.insuranceRate = page.getByTestId('insurance-rate');
    this.calculateButton = page.getByTestId('calculate');
    this.result = page.getByTestId('result');
    this.errors = page.getByTestId('errors');
    this.monthlyPayment = page.getByTestId('monthly-payment');
    this.actualTerm = page.getByTestId('actual-term');
    this.totalPaid = page.getByTestId('total-paid');
    this.overpayment = page.getByTestId('overpayment');
    this.scheduleTable = page.getByTestId('schedule-table');
    this.scheduleRows = page.getByTestId('schedule-row');
  }

  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.calculateButton).toBeVisible();
  }

  async fillBase(parameters: BaseParameters): Promise<void> {
    await this.amount.fill(parameters.amountRubles);
    await this.rate.fill(parameters.ratePercent);
    await this.term.fill(parameters.termMonths);
  }

  async enableInsurance(ratePercent: string): Promise<void> {
    await this.insuranceRate.fill(ratePercent);
    await this.insuranceEnabled.check();
  }

  /** Adds one early-repayment row and fills it. Returns the row's stable data-index. */
  async addEarlyRepayment(repayment: EarlyRepayment): Promise<number> {
    const index = this.addedEarlyRepayments;
    await this.page.getByTestId('early-add').click();
    const row = this.earlyRow(index);
    await expect(row).toBeVisible();
    await row.getByTestId('early-month').fill(repayment.month);
    await row.getByTestId('early-amount').fill(repayment.amountRubles);
    await row.getByTestId('early-mode').selectOption(repayment.mode);
    this.addedEarlyRepayments += 1;
    return index;
  }

  earlyRow(index: number): Locator {
    return this.page.locator(`[data-testid="early-row"][data-index="${index}"]`);
  }

  /**
   * REQ-29: the only way to recalculate. The click handler in app.ts is synchronous —
   * it neither awaits nor schedules — so the DOM is already updated when click()
   * resolves. Nothing here sleeps; the assertions that follow auto-wait anyway.
   */
  async calculate(): Promise<void> {
    await this.calculateButton.click();
  }

  /** A schedule row addressed by its month, not by its position in the table. */
  scheduleRow(month: number): Locator {
    return this.page.locator(`[data-testid="schedule-row"][data-month="${month}"]`);
  }

  cell(month: number, column: ScheduleColumn): Locator {
    return this.scheduleRow(month).getByTestId(column);
  }

  /**
   * Raw textContent, deliberately.
   *
   * `toHaveText` normalizes whitespace, and U+00A0 is whitespace to that normalizer —
   * it would quietly turn the REQ-30 thousands separator into an ordinary space and the
   * formatting assertions would pass against wrong output. Reading the node and comparing
   * with toBe keeps the comparison exact (REQ-36).
   */
  async textOf(locator: Locator): Promise<string> {
    await expect(locator).toBeVisible();
    return (await locator.textContent()) ?? '';
  }

  /** REQ-31: the codes, in the order the core returned them. Never the message text. */
  async errorCodes(): Promise<string[]> {
    await expect(this.errors).toBeVisible();
    return this.page
      .getByTestId('error')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-error-code') ?? ''));
  }

  error(code: string): Locator {
    return this.page.locator(`[data-error-code="${code}"]`);
  }
}
