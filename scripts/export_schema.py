#!/usr/bin/env python3
import json
import sys
from pathlib import Path

WTL = Path.home() / "Notes" / "scripts" / "where-to-live"
sys.path.insert(0, str(WTL))
import wtl  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "schema.json"

OPTIONAL = {"банк", "рабочий_стек", "медицина", "стоматология", "аптеки", "пыльца", "зима", "лето", "доставка", "вода", "вне_сезона", "менталитет"}
CAP3 = {"доставка", "вне_сезона", "религиозность"}
FACTS = [
    {"key": "rent", "cat": "аренда", "name": "Аренда на год", "unit": "€ в месяц", "rule": "money", "ref": 550,
     "hint": "Квартира со спальней и гостиной (1+1, евродвушка), договор от 12 месяцев. Медиана 10–30 объявлений в жилых районах, не Airbnb."},
    {"key": "dinner", "cat": "цены_услуги", "name": "Ужин на двоих в обычном кафе", "unit": "€", "rule": "money", "ref": 35,
     "hint": "Горячее и напиток каждому, без алкоголя, с чаевыми. Медиана 3–5 ужинов за поездку."},
    {"key": "basket", "cat": "продукты", "name": "Свой чек из 15 позиций", "unit": "€", "rule": "money", "ref": None,
     "hint": "Один и тот же список в обычном супермаркете. Чтобы сравнивать, впишите этот же чек в карточку СПб."},
    {"key": "utilities", "cat": "коммуналка", "name": "Коммуналка в январе", "unit": "€ в месяц", "rule": "money", "ref": 90,
     "hint": "Свет, отопление, вода и интернет за такую же квартиру. Спросить хозяина или агента."},
    {"key": "tds", "cat": "жесткость_воды", "name": "Жёсткость воды", "unit": "ppm (TDS)", "rule": "tds", "ref": None,
     "hint": "TDS-метр в кране снятой квартиры, 2–3 замера. В СПб вода мягкая, поэтому выше 3 не бывает."},
]

schema = {
    "people": wtl.PEOPLE,
    "groups": [{"key": k, "name": n, "scale": s, "risky": r} for k, n, s, r in wtl.GROUPS],
    "cats": [
        dict({"key": k, "name": n, "group": g, "vis": v, "star": st, "form": f, "hint": h}, **({"opt": True} if k in OPTIONAL else {}), **({"cap": 3} if k in CAP3 else {}))
        for k, n, g, v, st, f, h in wtl.CATS
    ],
    "facts": FACTS,
    "options": {"season": wtl.SEASONS, "mode": wtl.MODES, "housing": wtl.HOUSINGS},
    "statuses": wtl.STATUSES,
}
OUT.write_text(json.dumps(schema, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"{OUT}: {len(schema['groups'])} groups, {len(schema['cats'])} cats")
