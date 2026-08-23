"""Эталонная реализация кредитного калькулятора (агент B).

Написана по docs/spec.md (REQ-01…REQ-27, REQ-36…REQ-38) независимо от реализации
на TypeScript. Код TypeScript при написании не читался.

Контракт — раздел 9 спецификации (REQ-38), имена полей в snake_case:

    calculate_credit(input_dict) -> {"ok": True,  "schedule": [...], "totals": {...}}
                                 |  {"ok": False, "errors": [...]}

Деньги — целые числа копеек (REQ-01, REQ-02). Плавающая точка используется только
для месячной ставки i (REQ-11) и аннуитетного коэффициента K (REQ-12) — REQ-03.
Округление — half-up (REQ-04), реализовано явно через decimal.ROUND_HALF_UP
и через целочисленное деление; встроенный round() (банковское округление) не
используется нигде.

Совместимость: Python 3.9+ (без match/case, без `X | None` в аннотациях).
"""

from decimal import Decimal, ROUND_HALF_UP
import math
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------
# Константы диапазонов (REQ-06, REQ-07, REQ-08)
# --------------------------------------------------------------------------

AMOUNT_MIN = 1_000_000            # копеек = 10 000 ₽
AMOUNT_MAX = 10_000_000_000       # копеек = 100 000 000 ₽
RATE_MIN = 0.0
RATE_MAX = 100.0
TERM_MIN = 1
TERM_MAX = 360
INSURANCE_RATE_MIN = 0.0
INSURANCE_RATE_MAX = 10.0
MAX_RATE_DECIMALS = 2

MODE_REDUCE_TERM = "reduceTerm"
MODE_REDUCE_PAYMENT = "reducePayment"
EARLY_MODES = (MODE_REDUCE_TERM, MODE_REDUCE_PAYMENT)

# Порядок кодов ошибок — строго порядок строк таблицы REQ-09 (REQ-10).
ERROR_ORDER = (
    "AMOUNT_NOT_INTEGER",
    "AMOUNT_OUT_OF_RANGE",
    "RATE_OUT_OF_RANGE",
    "RATE_TOO_PRECISE",
    "TERM_NOT_INTEGER",
    "TERM_OUT_OF_RANGE",
    "NOT_A_NUMBER",
    "INSURANCE_RATE_OUT_OF_RANGE",
    "EARLY_MONTH_OUT_OF_RANGE",
    "EARLY_AMOUNT_NOT_POSITIVE",
    "EARLY_MODE_UNKNOWN",
    "EARLY_DUPLICATE_MONTH",
)

_ONE = Decimal(1)


# --------------------------------------------------------------------------
# Округление (REQ-04)
# --------------------------------------------------------------------------

def round_half_up(value: float) -> int:
    """Half-up до целых копеек. REQ-04.

    Встроенный round() в Python округляет к чётному (round(2.5) == 2) —
    здесь используется decimal.ROUND_HALF_UP по точному двоичному значению float.

    round_half_up(1.5) == 2, round_half_up(2.5) == 3, round_half_up(1.4999) == 1.
    """
    return int(Decimal(value).quantize(_ONE, rounding=ROUND_HALF_UP))


def div_half_up(numerator: int, denominator: int) -> int:
    """Целочисленное деление с округлением half-up. Только неотрицательные числа.

    Точный эквивалент round_half_up(numerator / denominator) без плавающей точки.
    """
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return (2 * numerator + denominator) // (2 * denominator)


def _decimal_round_half_up(value: Decimal) -> int:
    return int(value.quantize(_ONE, rounding=ROUND_HALF_UP))


# --------------------------------------------------------------------------
# Валидация (REQ-06 … REQ-10)
# --------------------------------------------------------------------------

def _is_number(value: Any) -> bool:
    """Конечное число. bool числом не считается, NaN и Infinity — тоже."""
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _is_integral(value: Any) -> bool:
    if isinstance(value, int):
        return True
    return float(value).is_integer()


def _decimal_places(value: float) -> int:
    """Число знаков после запятой в десятичной записи числа."""
    d = Decimal(repr(float(value))).normalize()
    exponent = d.as_tuple().exponent
    if not isinstance(exponent, int):     # NaN/Infinity сюда не доходят
        return 0
    return max(0, -exponent)


def _validate(raw: Dict[str, Any]) -> List[str]:
    """Возвращает список кодов ошибок в порядке таблицы REQ-09. Пустой — вход корректен."""
    codes = set()

    amount = raw.get("amount", None)
    rate = raw.get("annual_rate_percent", None)
    term = raw.get("term_months", None)
    insurance = raw.get("insurance", None)
    early = raw.get("early_repayments", None)
    if early is None:
        early = []

    # amount
    if not _is_number(amount):
        codes.add("NOT_A_NUMBER")
    else:
        if not _is_integral(amount):
            codes.add("AMOUNT_NOT_INTEGER")
        if not (AMOUNT_MIN <= amount <= AMOUNT_MAX):
            codes.add("AMOUNT_OUT_OF_RANGE")

    # annual_rate_percent
    if not _is_number(rate):
        codes.add("NOT_A_NUMBER")
    else:
        if not (RATE_MIN <= rate <= RATE_MAX):
            codes.add("RATE_OUT_OF_RANGE")
        if _decimal_places(rate) > MAX_RATE_DECIMALS:
            codes.add("RATE_TOO_PRECISE")

    # term_months
    term_valid = False
    if not _is_number(term):
        codes.add("NOT_A_NUMBER")
    else:
        if not _is_integral(term):
            codes.add("TERM_NOT_INTEGER")
        if not (TERM_MIN <= term <= TERM_MAX):
            codes.add("TERM_OUT_OF_RANGE")
        term_valid = _is_integral(term) and TERM_MIN <= term <= TERM_MAX

    # insurance (REQ-07)
    if insurance is not None:
        if not isinstance(insurance, dict):
            codes.add("NOT_A_NUMBER")
        else:
            ins_rate = insurance.get("annual_rate_percent", None)
            if not _is_number(ins_rate):
                codes.add("NOT_A_NUMBER")
            elif not (INSURANCE_RATE_MIN <= ins_rate <= INSURANCE_RATE_MAX):
                codes.add("INSURANCE_RATE_OUT_OF_RANGE")
            # Ограничение «не более 2 знаков» из REQ-07 не имеет собственного кода
            # в таблице REQ-09 и здесь не проверяется. См. отчёт, вопрос Q-01.

    # early_repayments (REQ-08)
    if not isinstance(early, list):
        codes.add("NOT_A_NUMBER")
    else:
        seen_months = set()
        for item in early:
            if not isinstance(item, dict):
                codes.add("NOT_A_NUMBER")
                continue

            month = item.get("month", None)
            if not _is_number(month):
                codes.add("NOT_A_NUMBER")
            else:
                month_ok = _is_integral(month) and month >= TERM_MIN
                if term_valid and month_ok:
                    month_ok = month <= term
                if not month_ok:
                    codes.add("EARLY_MONTH_OUT_OF_RANGE")
                elif _is_integral(month):
                    key = int(month)
                    if key in seen_months:
                        codes.add("EARLY_DUPLICATE_MONTH")
                    seen_months.add(key)

            er_amount = item.get("amount", None)
            if not _is_number(er_amount):
                codes.add("NOT_A_NUMBER")
            elif (not _is_integral(er_amount)) or er_amount <= 0:
                codes.add("EARLY_AMOUNT_NOT_POSITIVE")

            if item.get("mode", None) not in EARLY_MODES:
                codes.add("EARLY_MODE_UNKNOWN")

    return [code for code in ERROR_ORDER if code in codes]


# --------------------------------------------------------------------------
# Расчёт
# --------------------------------------------------------------------------

def _monthly_rate(annual_rate_percent: float) -> float:
    """i = annualRatePercent / 100 / 12. REQ-11. Единственная float-величина вместе с K."""
    return annual_rate_percent / 100 / 12


def _regular_payment(balance: int, i: float, n: int, zero_rate: bool) -> int:
    """Регулярный платёж: REQ-12 при i > 0, REQ-13 при нулевой ставке.

    Ветка нулевой ставки выбирается строго при annual_rate_percent == 0 (REQ-13),
    признак приходит снаружи в zero_rate — здесь нет условий вида i < eps.
    """
    if zero_rate:
        # REQ-13: payment = roundHalfUp(amount / n) — целочисленно, точный half-up.
        return div_half_up(balance, n)
    # REQ-12: K = i * (1 + i)^n / ((1 + i)^n − 1); порядок операций — как в спецификации.
    p = (1.0 + i) ** n
    k = i * p / (p - 1.0)
    return round_half_up(balance * k)


def _insurance_premium(balance_before: int, insurance_rate: float) -> int:
    """REQ-17: insurance = roundHalfUp(balanceBefore * insuranceAnnualRatePercent / 100).

    Считается точно, в десятичной арифметике: страховая ставка не входит в список
    величин, для которых REQ-03 допускает плавающую точку.
    """
    value = Decimal(balance_before) * Decimal(repr(float(insurance_rate))) / Decimal(100)
    return _decimal_round_half_up(value)


def _make_row(month: int,
              interest: int,
              principal: int,
              insurance: int,
              requested: int,
              applied: int,
              excess: int,
              balance_after: int) -> Dict[str, int]:
    return {
        "month": month,
        "payment_total": principal + interest + insurance,   # REQ-14, INV-04
        "interest": interest,
        "principal": principal,
        "insurance": insurance,
        "early_repayment_requested": requested,
        "early_repayment_applied": applied,
        "early_repayment_excess": excess,
        "balance_after": balance_after,
    }


def calculate_credit(input_dict: Any) -> Dict[str, Any]:
    """Единственная точка входа эталона. Исключений не бросает (REQ-09)."""
    if not isinstance(input_dict, dict):
        return {"ok": False, "errors": ["NOT_A_NUMBER"]}

    errors = _validate(input_dict)
    if errors:
        return {"ok": False, "errors": errors}

    amount = int(input_dict["amount"])
    annual_rate_percent = float(input_dict["annual_rate_percent"])
    term_months = int(input_dict["term_months"])

    insurance_cfg = input_dict.get("insurance", None)
    insurance_rate = None  # type: Optional[float]
    if insurance_cfg is not None:
        insurance_rate = float(insurance_cfg["annual_rate_percent"])

    raw_early = input_dict.get("early_repayments", None)
    if raw_early is None:
        raw_early = []

    # REQ-24: применяются в порядке возрастания месяца; index — позиция во входном массиве.
    early_by_month = {}  # type: Dict[int, Tuple[int, int, str]]
    early_records = []   # type: List[Tuple[int, int, int, str]]
    for idx, item in enumerate(raw_early):
        month = int(item["month"])
        er_amount = int(item["amount"])
        mode = item["mode"]
        early_by_month[month] = (idx, er_amount, mode)
        early_records.append((idx, month, er_amount, mode))

    zero_rate = (annual_rate_percent == 0)  # REQ-13: строгое сравнение с нулём
    i = _monthly_rate(annual_rate_percent)

    payment = _regular_payment(amount, i, term_months, zero_rate)

    schedule = []  # type: List[Dict[str, int]]
    balance = amount

    for month in range(1, term_months + 1):
        if balance == 0:
            break

        balance_before = balance

        # REQ-15, шаг 1: проценты от остатка на начало месяца.
        if zero_rate:
            interest = 0
        else:
            interest = round_half_up(balance_before * i)

        # шаг 2-3
        principal = payment - interest
        if principal < 0:
            principal = 0
        if principal > balance_before or month == term_months:
            # REQ-05: последний платёж корректирующий, гасит остаток ровно в ноль.
            principal = balance_before

        # шаг 4: страховка (REQ-17), месяцы 1, 13, 25, …
        insurance = 0
        if insurance_rate is not None and month % 12 == 1:
            insurance = _insurance_premium(balance_before, insurance_rate)

        # шаги 5-6
        balance = balance_before - principal

        # шаг 7: досрочное погашение (REQ-20, REQ-23)
        requested = 0
        applied = 0
        excess = 0
        record = early_by_month.get(month)
        if record is not None:
            requested = record[1]
            applied = requested if requested < balance else balance
            excess = requested - applied
            balance = balance - applied

        schedule.append(_make_row(month, interest, principal, insurance,
                                  requested, applied, excess, balance))

        # шаг 8: пересчёт — только если досрочка что-то списала и кредит не закрыт.
        if record is not None and applied > 0 and balance > 0:
            mode = record[2]
            if mode == MODE_REDUCE_PAYMENT:
                # REQ-22: число оставшихся месяцев не меняется (termMonths − M),
                # платёж пересчитывается от нового остатка.
                remaining = term_months - month
                if remaining > 0:
                    payment = _regular_payment(balance, i, remaining, zero_rate)
            # MODE_REDUCE_TERM (REQ-21): платёж не меняется, срок сокращается сам.

    actual_term_months = len(schedule)

    # REQ-25: досрочки, до которых расчёт не дошёл, потому что кредит уже закрыт.
    ignored = []
    for idx, month, er_amount, _mode in early_records:
        if month > actual_term_months:
            ignored.append({"index": idx, "month": month, "amount": er_amount})

    total_regular_principal = sum(row["principal"] for row in schedule)
    total_applied = sum(row["early_repayment_applied"] for row in schedule)
    total_interest = sum(row["interest"] for row in schedule)
    total_insurance = sum(row["insurance"] for row in schedule)
    total_payment_rows = sum(row["payment_total"] for row in schedule)
    total_excess = sum(row["early_repayment_excess"] for row in schedule)

    first_row = schedule[0]
    # REQ-26: первый регулярный платёж без страховки.
    monthly_payment = first_row["payment_total"] - first_row["insurance"]

    totals = {
        "monthly_payment": monthly_payment,
        "actual_term_months": actual_term_months,
        "total_principal": total_regular_principal + total_applied,
        "total_interest": total_interest,
        "total_insurance": total_insurance,
        "total_paid": total_payment_rows + total_applied,
        "total_early_repayment_excess": total_excess,
        "overpayment": total_interest + total_insurance,
        "ignored_early_repayments": ignored,
    }

    return {"ok": True, "schedule": schedule, "totals": totals}
