/**
 * Проверки, закрывающие находки внешнего аудита (сессия 4, находка F-1).
 *
 * Отдельный файл по тому же принципу, что и skeptic-findings.spec.ts: должно
 * оставаться видно, какие проверки существовали до аудита, а какие появились
 * потому, что аудит нашёл их отсутствие. Отчёт — sessions/session-4-auditor.md.
 *
 * Аудитор внёс в ядро 35 поломок, по одной, с откатом между ними. Семь из них
 * не заметил ни один тест набора; две не заметил и второй контур — кросс-сверка
 * с Python-эталоном. Обе жили в src/core/validate.ts. Тесты ниже закрывают их.
 *
 * Написаны по docs/spec.md, разделы REQ-06, REQ-09 и REQ-10. Внешних контрольных
 * точек здесь нет и быть не может: oracle.md фиксирует деньги, а не коды ошибок.
 * Все сравнения — строгое равенство (REQ-36).
 */
import { test, expect } from '@playwright/test';

import { calculateCredit } from '../../src/core';
import type { CalculationResult, CreditInput, ValidationCode } from '../../src/core/types';

/** O-01: 1 000 000 ₽, 12,00 % годовых, 60 месяцев — валидная основа для порчи полей. */
const O01: CreditInput = {
  amount: 100_000_000,
  annualRatePercent: 12,
  termMonths: 60,
  insurance: null,
  earlyRepayments: [],
};

/** Выполняет расчёт, требует отказа и возвращает список кодов (REQ-09). */
function errorsOf(input: CreditInput): ValidationCode[] {
  const result: CalculationResult = calculateCredit(input);
  expect(result.ok, 'REQ-09: invalid input must be rejected without throwing').toBe(false);
  return (result as Extract<CalculationResult, { ok: false }>).errors;
}

/**
 * Копия валидного входа с заменёнными полями.
 *
 * Приведение типа здесь законно по той же причине, что и в base.spec.ts: тесты
 * REQ-09 обязаны подавать значение неверного типа там, где по контракту число.
 * Исключение документировано в CLAUDE.md 4.5.
 *
 * forbidden-check: allow-type-assertion
 */
function withField(base: CreditInput, patch: Record<string, unknown>): CreditInput {
  return { ...base, ...patch } as unknown as CreditInput;
}

/* ===========================================================================
 * F-1, поломка M34: 'NOT_A_NUMBER' переставлен в конец CODE_ORDER.
 *
 * REQ-10 фиксирует не только состав списка кодов, но и его порядок — порядок
 * таблицы REQ-09. Существующие проверки REQ-10 сравнивали пары и тройки кодов,
 * среди которых NOT_A_NUMBER не встречался ни разу, поэтому его позицию
 * не удерживало ничего: перестановка в конец списка оставляла все 168 тестов
 * зелёными и не давала ни одного расхождения в кросс-сверке.
 *
 * Вход ниже нарушает четыре правила сразу и закрепляет пять позиций из двенадцати,
 * в том числе обе границы NOT_A_NUMBER — код перед ним и код после него.
 * ======================================================================== */

test('REQ-10: NOT_A_NUMBER keeps its place between the term codes and the insurance code', () => {
  const input = withField(O01, {
    amount: 999_999.5, // не целое И вне диапазона — сразу два кода подряд
    termMonths: Number.NaN, // NOT_A_NUMBER
    insurance: { annualRatePercent: 15 }, // INSURANCE_RATE_OUT_OF_RANGE
    earlyRepayments: [{ month: 0, amount: 100_000, mode: 'reduceTerm' }],
  });
  expect(errorsOf(input)).toEqual([
    'AMOUNT_NOT_INTEGER',
    'AMOUNT_OUT_OF_RANGE',
    'NOT_A_NUMBER',
    'INSURANCE_RATE_OUT_OF_RANGE',
    'EARLY_MONTH_OUT_OF_RANGE',
  ]);
});

/* ===========================================================================
 * F-1, поломка M35: допуск в проверке точности ставки ослаблен с 1e-9 до 1e-4.
 *
 * REQ-06 разрешает ставке не более двух знаков после запятой. В коде это правило
 * живёт единственным числом — допуском, с которым дробная часть сравнивается
 * с нулём. Существующие проверки подавали ставки, лишние знаки которых грубы
 * (0,001 и 12,345 дают дрейф 0,1 и 0,5), поэтому допуск можно было ослабить
 * на пять порядков, не уронив ничего в обоих контурах.
 *
 * Ставка ниже нарушает REQ-06 на девятом знаке: дрейф около 1e-7. Она обязана
 * быть отвергнута, и она отсекает любое ослабление допуска до 1e-6 и грубее.
 * ======================================================================== */

test('REQ-06 (REQ-09): a rate over-precise in the ninth decimal is still RATE_TOO_PRECISE', () => {
  expect(errorsOf(withField(O01, { annualRatePercent: 7.000000001 }))).toEqual([
    'RATE_TOO_PRECISE',
  ]);
});
