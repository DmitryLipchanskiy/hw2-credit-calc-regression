"""Сверка результатов реализации на TypeScript с эталоном.

    python3 oracle/compare.py <ts-results.json> <oracle/expected.json>

Сравнение — поле за полем, по каждой строке графика и каждому итогу.
Деньги сравниваются как целые числа, на строгое равенство. Приближённые сравнения,
округление перед сравнением и сравнение в рублях запрещены (REQ-36).
Нецелое значение в денежном поле — само по себе расхождение (REQ-01).

Имена полей: TypeScript отдаёт camelCase, эталон — snake_case. Преобразование
делается здесь, механически (paymentTotal -> payment_total и так далее).

Код возврата: 0 — расхождений нет, 1 — есть хотя бы одно, 2 — файлы не читаются.

Совместимость: Python 3.9+.
"""

import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

ROW_MONEY_FIELDS = (
    "payment_total",
    "interest",
    "principal",
    "insurance",
    "early_repayment_requested",
    "early_repayment_applied",
    "early_repayment_excess",
    "balance_after",
)
ROW_FIELDS = ("month",) + ROW_MONEY_FIELDS

TOTALS_MONEY_FIELDS = (
    "monthly_payment",
    "total_principal",
    "total_interest",
    "total_insurance",
    "total_paid",
    "total_early_repayment_excess",
    "overpayment",
)
TOTALS_SCALAR_FIELDS = ("monthly_payment", "actual_term_months", "total_principal",
                        "total_interest", "total_insurance", "total_paid",
                        "total_early_repayment_excess", "overpayment")

IGNORED_FIELDS = ("index", "month", "amount")

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def to_snake(name: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def normalise_keys(value: Any) -> Any:
    """Рекурсивно переводит ключи объектов из camelCase в snake_case.

    Значения не трогаются: строковые константы режимов и коды ошибок остаются
    такими, какими их задаёт спецификация (reduceTerm, AMOUNT_OUT_OF_RANGE).
    """
    if isinstance(value, dict):
        return dict((to_snake(k), normalise_keys(v)) for k, v in value.items())
    if isinstance(value, list):
        return [normalise_keys(item) for item in value]
    return value


def load_results(path: str) -> List[Any]:
    """Достаёт из файла плоский список результатов расчёта, в порядке кейсов.

    Понимает три формы: массив результатов; массив обёрток с полем result;
    объект с полем cases/results/entries, внутри — то же самое.
    """
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    data = normalise_keys(data)

    if isinstance(data, dict):
        for key in ("cases", "results", "entries", "items"):
            if key in data and isinstance(data[key], list):
                data = data[key]
                break
        else:
            raise SystemExit(
                "{0}: не найден массив кейсов (ожидались ключи cases/results/entries)".format(path))

    if not isinstance(data, list):
        raise SystemExit("{0}: ожидался массив кейсов".format(path))

    results = []
    for item in data:
        if isinstance(item, dict) and "result" in item and isinstance(item["result"], dict):
            results.append(item["result"])
        else:
            results.append(item)
    return results


class Diff(object):
    def __init__(self, case_index: int, path: str, actual: Any, expected: Any, note: str = ""):
        self.case_index = case_index
        self.path = path
        self.actual = actual
        self.expected = expected
        self.note = note

    def render(self) -> str:
        line = "case #{0}  {1}:  ts={2!r}  oracle={3!r}".format(
            self.case_index, self.path, self.actual, self.expected)
        if self.note:
            line += "   ({0})".format(self.note)
        return line


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def compare_money(diffs: List[Diff], case_index: int, path: str,
                  actual: Any, expected: Any) -> None:
    """Строгое равенство целых чисел копеек, без приближений (REQ-36)."""
    if not is_int(expected):
        diffs.append(Diff(case_index, path, actual, expected,
                          "эталон вернул не целое — ошибка эталона"))
        return
    if not is_int(actual):
        diffs.append(Diff(case_index, path, actual, expected,
                          "значение не целое число копеек (REQ-01)"))
        return
    if actual != expected:
        diffs.append(Diff(case_index, path, actual, expected,
                          "разница {0:+d}".format(actual - expected)))


def compare_plain(diffs: List[Diff], case_index: int, path: str,
                  actual: Any, expected: Any) -> None:
    if actual != expected:
        diffs.append(Diff(case_index, path, actual, expected))


def compare_case(case_index: int, actual: Any, expected: Any) -> List[Diff]:
    diffs = []  # type: List[Diff]

    if not isinstance(actual, dict):
        diffs.append(Diff(case_index, "<result>", actual, "<object>",
                          "результат TypeScript не является объектом"))
        return diffs

    exp_ok = expected.get("ok")
    act_ok = actual.get("ok")
    if act_ok != exp_ok:
        diffs.append(Diff(case_index, "ok", act_ok, exp_ok))
        # дальше сравнивать нечего: структуры разные
        act_errors = actual.get("errors")
        exp_errors = expected.get("errors")
        if act_errors is not None or exp_errors is not None:
            diffs.append(Diff(case_index, "errors", act_errors, exp_errors))
        return diffs

    if exp_ok is False:
        compare_plain(diffs, case_index, "errors",
                      actual.get("errors"), expected.get("errors"))
        return diffs

    exp_schedule = expected.get("schedule") or []
    act_schedule = actual.get("schedule")
    if not isinstance(act_schedule, list):
        diffs.append(Diff(case_index, "schedule", act_schedule, "<array>",
                          "график отсутствует или не массив"))
        return diffs

    if len(act_schedule) != len(exp_schedule):
        diffs.append(Diff(case_index, "schedule.length",
                          len(act_schedule), len(exp_schedule)))

    for row_no in range(min(len(act_schedule), len(exp_schedule))):
        act_row = act_schedule[row_no]
        exp_row = exp_schedule[row_no]
        if not isinstance(act_row, dict):
            diffs.append(Diff(case_index, "schedule[{0}]".format(row_no),
                              act_row, "<object>"))
            continue
        for field in ROW_FIELDS:
            path = "schedule[{0}].{1}".format(row_no, field)
            if field == "month":
                compare_plain(diffs, case_index, path,
                              act_row.get(field), exp_row.get(field))
            else:
                compare_money(diffs, case_index, path,
                              act_row.get(field), exp_row.get(field))
        extra = set(act_row.keys()) - set(ROW_FIELDS)
        for field in sorted(extra):
            diffs.append(Diff(case_index, "schedule[{0}].{1}".format(row_no, field),
                              act_row[field], None, "лишнее поле в строке графика"))

    exp_totals = expected.get("totals") or {}
    act_totals = actual.get("totals")
    if not isinstance(act_totals, dict):
        diffs.append(Diff(case_index, "totals", act_totals, "<object>",
                          "итоги отсутствуют или не объект"))
        return diffs

    for field in TOTALS_SCALAR_FIELDS:
        path = "totals.{0}".format(field)
        if field in TOTALS_MONEY_FIELDS:
            compare_money(diffs, case_index, path,
                          act_totals.get(field), exp_totals.get(field))
        else:
            compare_plain(diffs, case_index, path,
                          act_totals.get(field), exp_totals.get(field))

    exp_ignored = exp_totals.get("ignored_early_repayments")
    act_ignored = act_totals.get("ignored_early_repayments")
    if not isinstance(act_ignored, list):
        diffs.append(Diff(case_index, "totals.ignored_early_repayments",
                          act_ignored, exp_ignored,
                          "ожидался массив записей (REQ-25)"))
    else:
        if len(act_ignored) != len(exp_ignored or []):
            diffs.append(Diff(case_index, "totals.ignored_early_repayments.length",
                              len(act_ignored), len(exp_ignored or [])))
        for k in range(min(len(act_ignored), len(exp_ignored or []))):
            act_item = act_ignored[k]
            exp_item = exp_ignored[k]
            if not isinstance(act_item, dict):
                diffs.append(Diff(case_index,
                                  "totals.ignored_early_repayments[{0}]".format(k),
                                  act_item, exp_item))
                continue
            for field in IGNORED_FIELDS:
                path = "totals.ignored_early_repayments[{0}].{1}".format(k, field)
                if field == "amount":
                    compare_money(diffs, case_index, path,
                                  act_item.get(field), exp_item.get(field))
                else:
                    compare_plain(diffs, case_index, path,
                                  act_item.get(field), exp_item.get(field))

    extra_totals = set(act_totals.keys()) - set(TOTALS_SCALAR_FIELDS) - {"ignored_early_repayments"}
    for field in sorted(extra_totals):
        diffs.append(Diff(case_index, "totals.{0}".format(field),
                          act_totals[field], None, "лишнее поле в итогах"))

    return diffs


def main(argv: List[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write(
            "usage: python3 oracle/compare.py <ts-results.json> <oracle/expected.json>\n")
        return 2

    ts_path, expected_path = argv[1], argv[2]
    for path in (ts_path, expected_path):
        if not os.path.exists(path):
            sys.stderr.write("файл не найден: {0}\n".format(path))
            return 2

    actual_list = load_results(ts_path)
    expected_list = load_results(expected_path)

    diffs = []  # type: List[Diff]
    if len(actual_list) != len(expected_list):
        diffs.append(Diff(-1, "<case count>", len(actual_list), len(expected_list),
                          "число кейсов не совпало"))

    common = min(len(actual_list), len(expected_list))
    cases_with_diffs = 0
    for index in range(common):
        case_diffs = compare_case(index, actual_list[index], expected_list[index])
        if case_diffs:
            cases_with_diffs += 1
            diffs.extend(case_diffs)

    print("сверка: TypeScript {0} <-> эталон {1}".format(ts_path, expected_path))
    print("кейсов сопоставлено: {0}".format(common))
    print("кейсов с расхождениями: {0}".format(cases_with_diffs))
    print("расхождений всего: {0}".format(len(diffs)))

    if diffs:
        print("")
        for diff in diffs:
            print(diff.render())
        print("")
        print("РАСХОЖДЕНИЯ ЕСТЬ")
        return 1

    print("расхождений нет")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
