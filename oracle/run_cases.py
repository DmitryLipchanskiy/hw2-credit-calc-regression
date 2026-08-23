"""Прогон набора кейсов через эталон.

    python3 oracle/run_cases.py [cases.json] [expected.json]

Читает oracle/cases.json (список входных объектов в snake_case), прогоняет каждый
через calculate_credit и пишет oracle/expected.json. Пути по умолчанию берутся
рядом со скриптом, поэтому запуск из корня репозитория работает как есть.

Формат expected.json:

    {
      "case_count": N,
      "cases": [ {"index": 0, "input": {...}, "result": {...}}, ... ]
    }

Совместимость: Python 3.9+.
"""

import json
import os
import sys
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from calculator import calculate_credit  # noqa: E402

DEFAULT_CASES = os.path.join(HERE, "cases.json")
DEFAULT_EXPECTED = os.path.join(HERE, "expected.json")


def load_cases(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("cases", [])
    if not isinstance(data, list):
        raise SystemExit("cases.json: ожидался массив кейсов")
    return data


def main(argv: List[str]) -> int:
    cases_path = argv[1] if len(argv) > 1 else DEFAULT_CASES
    expected_path = argv[2] if len(argv) > 2 else DEFAULT_EXPECTED

    cases = load_cases(cases_path)

    entries = []
    ok_count = 0
    error_count = 0
    total_rows = 0
    for index, case in enumerate(cases):
        result = calculate_credit(case)
        if result.get("ok"):
            ok_count += 1
            total_rows += len(result["schedule"])
        else:
            error_count += 1
        entries.append({"index": index, "input": case, "result": result})

    # Один кейс — одна строка файла: обычный JSON, но и размер, и git-diff остаются
    # обозримыми (график на 360 месяцев с отступами раздувает файл в разы).
    with open(expected_path, "w", encoding="utf-8") as fh:
        fh.write("{\n")
        fh.write('"case_count": {0},\n'.format(len(entries)))
        fh.write('"cases": [\n')
        for position, entry in enumerate(entries):
            fh.write(json.dumps(entry, ensure_ascii=False, allow_nan=False,
                                separators=(",", ":"), sort_keys=False))
            fh.write(",\n" if position + 1 < len(entries) else "\n")
        fh.write("]\n}\n")

    print("cases:      {0}".format(len(entries)))
    print("ok:         {0}".format(ok_count))
    print("errors:     {0}".format(error_count))
    print("rows total: {0}".format(total_rows))
    print("written:    {0}".format(expected_path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
