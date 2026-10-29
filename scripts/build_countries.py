#!/usr/bin/env python3
"""Build data/world/indicators.json: country indicators keyed by Natural Earth ISO3."""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import re
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

MIN_YEAR = 2005

UA = "where-to-live-build/1.0 (personal non-commercial)"
ROOT = Path(__file__).resolve().parents[1]
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
WB = "https://api.worldbank.org/v2"
OWID = "https://ourworldindata.org/grapher/{}.csv?useColumnShortNames=true"
INFORM = "https://drmkc.jrc.ec.europa.eu/inform-index/API/InformAPI"
PASSPORT = "https://raw.githubusercontent.com/imorte/passport-index-data/main"
ISO_FIX = {"XKX": "KOS", "OWID_KOS": "KOS", "OWID_CYN": "CYN"}

WB_LIC = "CC BY 4.0"
WGI_LIC = "WGI (World Bank), с атрибуцией"
IND = [
    dict(key="gdp_ppp", name="ВВП на душу по ППС", short="ВВП/душу", group="money", unit="$", fmt=0, dir=1,
         scale={"type": "log", "step": 0.405}, source="World Bank WDI", code="NY.GDP.PCAP.PP.CD", cats=[]),
    dict(key="price_level", name="Уровень цен в стране (США = 100)", short="Цены", group="money", unit="", fmt=1, dir=-1,
         scale={"type": "log", "step": 0.405}, source="World Bank WDI", code="PA.NUS.PRVT.PLI", cats=["цены_услуги"],
         note="по стране в целом, не по городу"),
    dict(key="inflation5", name="Инфляция, среднее за 5 лет", short="Инфляция", group="money", unit="%", fmt=1, dir=-1,
         scale={"type": "lin", "step": 4}, source="World Bank WDI", code="FP.CPI.TOTL.ZG", cats=["динамика_цен"],
         note="среднее за 5 последних доступных лет; год — последний"),
    dict(key="unemployment", name="Безработица", short="Безработ.", group="work", unit="%", fmt=1, dir=-1,
         scale={"type": "lin", "step": 3}, source="World Bank WDI", code="SL.UEM.TOTL.ZS", cats=[]),
    dict(key="life_exp", name="Ожидаемая продолжительность жизни", short="Жизнь", group="health", unit="лет", fmt=1, dir=1,
         scale={"type": "lin", "step": 3}, source="World Bank WDI", code="SP.DYN.LE00.IN", cats=["больница"]),
    dict(key="uhc", name="Охват медпомощью (UHC, 0–100)", short="Медпомощь", group="health", unit="", fmt=0, dir=1,
         scale={"type": "lin", "step": 10}, source="World Bank WDI (WHO)", code="SH_UHC_SCI", cats=["больница"]),
    dict(key="pm25", name="PM2.5, среднегодовое", short="PM2.5", group="climate", unit="мкг/м³", fmt=1, dir=-1,
         scale={"type": "abs", "points": [[5, 5], [10, 4], [15, 3.5], [25, 2], [35, 1]]},
         source="World Bank WDI", code="EN.ATM.PM25.MC.M3", cats=["воздух"], note="по стране в целом"),
    dict(key="homicide", name="Убийства на 100 тыс. жителей", short="Убийства", group="safety", unit="", fmt=1, dir=-1,
         scale={"type": "log", "step": 0.693}, source="World Bank WDI (UNODC)", code="VC.IHR.PSRC.P5", cats=["преступность"]),
    dict(key="internet", name="Пользуются интернетом", short="Интернет", group="work", unit="%", fmt=0, dir=1,
         scale={"type": "lin", "step": 10}, source="World Bank WDI (ITU)", code="IT.NET.USER.ZS", cats=[],
         note="доля жителей, не скорость"),
    dict(key="wgi_pv", name="Политическая стабильность (WGI)", short="Стабильн.", group="safety", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.5}, source="World Bank WGI", code="GOV_WGI_PV.EST", cats=["стабильность"]),
    dict(key="wgi_rl", name="Верховенство права (WGI)", short="Право", group="safety", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.5}, source="World Bank WGI", code="GOV_WGI_RL.EST", cats=[]),
    dict(key="wgi_cc", name="Контроль коррупции (WGI)", short="Коррупция", group="legal", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.5}, source="World Bank WGI", code="GOV_WGI_CC.EST", cats=["бюрократия"]),
    dict(key="wgi_ge", name="Эффективность госуправления (WGI)", short="Госуправл.", group="legal", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.5}, source="World Bank WGI", code="GOV_WGI_GE.EST", cats=["бюрократия"]),
    dict(key="hdi", name="Индекс человеческого развития", short="ИЧР", group="people", unit="", fmt=3, dir=1,
         scale={"type": "lin", "step": 0.04}, source="UNDP HDR via Our World in Data", code="human-development-index",
         license="CC BY 3.0 IGO", url="https://ourworldindata.org/grapher/human-development-index", cats=[]),
    dict(key="happiness", name="Индекс счастья (WHR, 0–10)", short="Счастье", group="people", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.7}, source="World Happiness Report via Our World in Data",
         code="happiness-cantril-ladder", license="WHR data sharing policy, с атрибуцией",
         url="https://ourworldindata.org/grapher/happiness-cantril-ladder", cats=[]),
    dict(key="democracy", name="Электоральная демократия (V-Dem, 0–1)", short="Демократия", group="people", unit="", fmt=2,
         dir=1, scale={"type": "lin", "step": 0.12}, source="V-Dem via Our World in Data", code="electoral-democracy-index",
         license="CC BY 4.0", url="https://ourworldindata.org/grapher/electoral-democracy-index", cats=["свободы"]),
    dict(key="inform_risk", name="Риск кризисов и бедствий (INFORM, 0–10)", short="INFORM", group="safety", unit="",
         fmt=1, dir=-1, scale={"type": "lin", "step": 1.0}, source="INFORM Risk (EC JRC)", code="INFORM",
         license="CC BY (по HDX)", url="https://drmkc.jrc.ec.europa.eu/inform-index", cats=[]),
    dict(key="inform_nat", name="Природные угрозы (INFORM, 0–10)", short="Стихии", group="safety", unit="", fmt=1,
         dir=-1, scale={"type": "lin", "step": 1.0}, source="INFORM Risk (EC JRC)", code="HA.NAT",
         license="CC BY (по HDX)", url="https://drmkc.jrc.ec.europa.eu/inform-index", cats=["стихии"],
         note="землетрясения, наводнения, цунами, циклоны, засуха"),
    dict(key="ru_visa", name="Безвиз для паспорта РФ", short="Безвиз РФ", group="legal", unit="дн.", fmt=0, dir=1,
         scale={"type": "abs", "points": [[0, 1], [30, 3], [90, 4], [180, 5]]}, source="passport-index-data",
         code="RUS → страна", license="MIT", url="https://github.com/imorte/passport-index-data", cats=[],
         note="0 — нужна виза или e-visa; третий элемент — режим въезда"),
    dict(key="passport_power", name="Сила паспорта страны (безвиз/VOA/eTA)", short="Паспорт", group="legal",
         unit="стран", fmt=0, dir=1, scale={"type": "abs", "points": [[40, 1], [80, 2], [115, 3], [145, 4], [165, 5]]},
         source="passport-index-data", code="страна → мир", license="MIT",
         url="https://github.com/imorte/passport-index-data", cats=["гражданство"]),
]
for i in IND:
    if i["source"].startswith("World Bank"):
        i.setdefault("license", WGI_LIC if "WGI" in i["source"] else WB_LIC)
        i.setdefault("url", f"https://data.worldbank.org/indicator/{i['code']}")

ORDER = ["key", "name", "short", "group", "unit", "fmt", "dir", "scale", "source", "code", "license", "url", "cats", "note"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Fetcher:
    def __init__(self, cache, reuse):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.reuse = reuse

    def get(self, url, timeout=90, tries=4, data=None):
        f = self.cache / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".raw")
        if self.reuse and f.exists():
            return f.read_bytes()
        err = None
        for k in range(tries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA}, data=data)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read()
                f.write_bytes(body)
                return body
            except Exception as e:  # noqa: BLE001
                err = e
                log(f"  retry {k + 1}/{tries} {url[:100]}: {e}")
                time.sleep(3 * (k + 1))
        raise RuntimeError(f"fetch failed {url}: {err}")


def ne_iso3(fx):
    d = json.loads(fx.get(NE_URL, timeout=120))
    out = {}
    for f in d["features"]:
        p = f["properties"]
        iso3 = p["ISO_A3_EH"] if p["ISO_A3_EH"] != "-99" else p["ADM0_A3"]
        out[iso3] = p.get("NAME_RU") or p["NAME"]
    return out


def wb_aggregates(fx):
    d = json.loads(fx.get(f"{WB}/country?format=json&per_page=400"))
    return {c["id"] for c in d[1] if c["region"]["id"] == "NA"}


def wb_series(fx, code, n):
    src = "&source=3" if code.startswith("GOV_WGI") else ""
    url = f"{WB}/country/all/indicator/{code}?format=json&mrnev={n}&per_page=5000{src}"
    d = json.loads(fx.get(url, timeout=240))
    if len(d) < 2 or not d[1]:
        raise RuntimeError(f"WB {code}: empty {d[0]}")
    rows = {}
    for x in d[1]:
        if x["value"] is None:
            continue
        rows.setdefault(x["countryiso3code"] or x["country"]["id"], []).append((int(x["date"]), float(x["value"])))
    return rows


def owid_series(fx, slug):
    text = fx.get(OWID.format(slug), timeout=120).decode("utf-8")
    rd = csv.reader(io.StringIO(text))
    head = next(rd)
    vi = next(i for i, h in enumerate(head) if h not in ("entity", "code", "year", "owid_region"))
    best = {}
    for r in rd:
        code, year, val = r[1], r[2], r[vi]
        if not code or not val:
            continue
        y = int(year)
        if code not in best or y > best[code][0]:
            best[code] = (y, float(val))
    return best


def inform_series(fx, indicator):
    year = dt.date.today().year
    for y in (year + 1, year, year - 1):
        try:
            wfs = json.loads(fx.get(f"{INFORM}/workflows/GetByWorkflowGroup/INFORM{y}", timeout=60))
        except Exception as e:  # noqa: BLE001
            log(f"  INFORM{y}: {e}")
            continue
        main = [w for w in wfs if w["Name"].strip() == f"INFORM Risk {y}"]
        if not main:
            continue
        wid = main[0]["WorkflowId"]
        d = json.loads(fx.get(f"{INFORM}/countries/Scores/?WorkflowId={wid}&IndicatorId={indicator}", timeout=120, tries=6))
        log(f"  INFORM {y} workflow {wid} {indicator}: {len(d)}")
        return {x["Iso3"]: (y, float(x["IndicatorScore"])) for x in d if x.get("IndicatorScore") is not None}
    raise RuntimeError("INFORM: no workflow found")


EASY = {"visa free", "visa on arrival", "eta"}
DEFAULT_DAYS = {"visa free": 90, "visa on arrival": 30, "eta": 90}


def passport_series(fx):
    readme = fx.get(f"{PASSPORT}/README.md").decode("utf-8")
    m = re.search(r"Last updated:\s*\**\s*(\d{1,2}\s+\w+\s+(\d{4}))", readme)
    year = int(m.group(2)) if m else dt.date.today().year
    text = fx.get(f"{PASSPORT}/passport-index-tidy-iso3.csv", timeout=120).decode("utf-8")
    rd = csv.reader(io.StringIO(text))
    next(rd)
    power, ru = {}, {}
    for frm, to, req in rd:
        req = req.strip().lower()
        if req == "-1":
            continue
        easy = req.isdigit() or req in EASY
        power[frm] = power.get(frm, 0) + (1 if easy else 0)
        if frm == "RUS":
            if req.isdigit():
                ru[to] = (year, float(req), "visa free")
            elif req in DEFAULT_DAYS:
                ru[to] = (year, float(DEFAULT_DAYS[req]), req)
            else:
                ru[to] = (year, 0.0, req)
    ru["RUS"] = (year, 360.0, "home")
    return {k: (year, float(v)) for k, v in power.items()}, ru, (m.group(1) if m else str(year))


def rnd(v, fmt):
    v = round(v, fmt)
    return int(v) if fmt == 0 else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "world" / "indicators.json"))
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "where-to-live-build" / "countries"))
    ap.add_argument("--reuse", action="store_true", help="reuse cached raw responses")
    a = ap.parse_args()
    fx = Fetcher(a.cache, a.reuse)
    t0 = time.time()

    ne = ne_iso3(fx)
    agg = wb_aggregates(fx)
    log(f"NE countries: {len(ne)}, WB aggregates: {len(agg)}")

    jobs = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i in IND:
            k, c = i["key"], i["code"]
            if i["source"].startswith("World Bank"):
                jobs[k] = ex.submit(wb_series, fx, c, 5 if k == "inflation5" else 1)
            elif "Our World in Data" in i["source"]:
                jobs[k] = ex.submit(owid_series, fx, c)
            elif k.startswith("inform"):
                jobs[k] = ex.submit(inform_series, fx, c)
        jobs["_passport"] = ex.submit(passport_series, fx)

        data, failed, notes = {}, [], {}
        for k, fut in jobs.items():
            try:
                res = fut.result()
            except Exception as e:  # noqa: BLE001
                log(f"FAILED {k}: {e}")
                failed.append(k)
                continue
            if k == "_passport":
                power, ru, upd = res
                data["passport_power"], data["ru_visa"] = power, ru
                notes["passport"] = upd
                continue
            if k == "inflation5":
                res = {c: (max(y for y, _ in v), sum(x for _, x in v[:5]) / len(v[:5])) for c, v in res.items()}
            elif isinstance(next(iter(res.values())), list):
                res = {c: max(v) for c, v in res.items()}
            data[k] = res
            log(f"  {k}: {len(res)} raw codes")

    if "_passport" in failed:
        failed += ["ru_visa", "passport_power"]
    inds = [i for i in IND if i["key"] in data]
    countries = {}
    dropped = set()
    for i in inds:
        k = i["key"]
        for code, val in data[k].items():
            iso = ISO_FIX.get(code, code)
            if code in agg or iso not in ne:
                dropped.add(code)
                continue
            year, v = val[0], val[1]
            if v is None or (isinstance(v, float) and math.isnan(v)) or year < MIN_YEAR:
                continue
            entry = [rnd(v, i["fmt"]), year]
            if len(val) > 2:
                entry.append(val[2])
            countries.setdefault(iso, {})[k] = entry

    gen = dt.datetime.now(dt.timezone.utc).date().isoformat()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    lines = ["{" + f'"generated":"{gen}",', '"indicators":[']
    lines.append(",\n".join(json.dumps({f: i[f] for f in ORDER if f in i}, ensure_ascii=False) for i in inds) + "],")
    lines.append('"countries":{')
    lines.append(",\n".join(f'"{c}":' + json.dumps(countries[c], ensure_ascii=False, separators=(",", ":"))
                            for c in sorted(countries)))
    lines.append("}}")
    text = "\n".join(lines) + "\n"
    if out.exists() and out.read_text(encoding="utf-8").split("\n", 1)[-1] == text.split("\n", 1)[-1]:
        log("data unchanged, file kept")
    else:
        out.write_text(text, encoding="utf-8")
    json.loads(out.read_text(encoding="utf-8"))

    log(f"dropped codes (aggregates/not in NE): {len(dropped)}: {' '.join(sorted(c for c in dropped if c not in agg))}")
    log(f"passport data updated: {notes.get('passport')}")
    log(f"wrote {out}: {len(inds)} indicators, {len(countries)} countries, {out.stat().st_size} B, {time.time() - t0:.0f}s")
    if failed:
        log(f"FAILED: {', '.join(failed)}")
        if len(failed) > len(IND) // 2:
            sys.exit(1)


if __name__ == "__main__":
    main()
