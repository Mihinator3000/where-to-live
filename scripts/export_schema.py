#!/usr/bin/env python3
import json
import sys
from pathlib import Path

WTL = Path.home() / "Notes" / "scripts" / "where-to-live"
sys.path.insert(0, str(WTL))
import wtl  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "schema.json"

schema = {
    "people": wtl.PEOPLE,
    "groups": [{"key": k, "name": n, "scale": s, "risky": r} for k, n, s, r in wtl.GROUPS],
    "cats": [
        {"key": k, "name": n, "group": g, "vis": v, "star": st, "form": f, "hint": h}
        for k, n, g, v, st, f, h in wtl.CATS
    ],
    "options": {"season": wtl.SEASONS, "mode": wtl.MODES, "housing": wtl.HOUSINGS},
    "statuses": wtl.STATUSES,
}
OUT.write_text(json.dumps(schema, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"{OUT}: {len(schema['groups'])} groups, {len(schema['cats'])} cats")
