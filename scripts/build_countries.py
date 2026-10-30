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
WGI_LIC = "WGI, с атрибуцией World Bank"
INFORM_URL = "https://drmkc.jrc.ec.europa.eu/inform-index"
USD_SPAN = 5
EURO_SWITCH = {"HRV": (2023, 7.5345), "BGR": (2026, 1.95583)}  # WB keeps pre-euro LCU per USD unconverted
IND = [
    dict(key="price_level", name="Уровень цен в стране (США = 100)", short="Цены", group="money", unit="", fmt=1, dir=-1,
         scale={"type": "log", "step": 0.405}, source="World Bank WDI", code="PA.NUS.PRVT.PLI", cats=["цены_услуги"],
         note="страна в целом, вся корзина; зависит от курса рубля"),
    dict(key="usd_prices", name="Рост цен в долларах, % в год (5 лет)", short="Цены в $", group="money", unit="%", fmt=1,
         dir=-1, scale={"type": "lin", "step": 2}, source="World Bank WDI", code="FP.CPI.TOTL / PA.NUS.FCRF",
         url="https://data.worldbank.org/indicator/FP.CPI.TOTL", cats=["динамика_цен"],
         note="ИПЦ, пересчитанный в доллары по курсу: среднегодовой рост за 5 лет до указанного года"),
    dict(key="uhc", name="Охват медпомощью (UHC, 0–100)", short="Медпомощь", group="health", unit="", fmt=0, dir=1,
         scale={"type": "lin", "step": 10}, source="World Bank WDI (WHO)", code="SH_UHC_SCI", cats=["больница"],
         note="охват гос. системы базовой помощью, не качество больниц"),
    dict(key="pm25", name="PM2.5, среднегодовое", short="PM2.5", group="climate", unit="мкг/м³", fmt=1, dir=-1,
         scale={"type": "abs", "points": [[5, 4.5], [12, 3], [20, 2], [35, 1]]},
         source="World Bank WDI", code="EN.ATM.PM25.MC.M3", cats=["воздух"], note="по стране в целом"),
    dict(key="homicide", name="Убийства на 100 тыс. жителей, среднее за 5 лет", short="Убийства", group="safety",
         unit="", fmt=1, dir=-1, scale={"type": "log", "step": 0.693}, source="World Bank WDI (UNODC)",
         code="VC.IHR.PSRC.P5", cats=["преступность"],
         note="убийства — единственная сопоставимая цифра; бытовую преступность не отражает"),
    dict(key="wgi_pv", name="Политическая стабильность (WGI, от −2,5 до +2,5)", short="Стабильн.", group="safety", unit="", fmt=2, dir=1,
         scale={"type": "lin", "step": 0.5}, source="World Bank WGI", code="GOV_WGI_PV.EST", cats=["стабильность"]),
    dict(key="quake", name="Землетрясения (INFORM, риск 0–10, по стране)", short="Землетряс.", group="safety", unit="", fmt=1,
         dir=-1, scale={"type": "abs", "points": [[0, 3], [3, 2.75], [5, 2.25], [7, 1.75], [9, 1.25]]},
         source="INFORM Risk (EC JRC)", code="HA.NAT.EQ", license="CC BY, по данным HDX", url=INFORM_URL, cats=["стихии"],
         note="по стране в целом; у СПб почти нулевой риск"),
    dict(key="wgi_cc", name="Контроль коррупции (WGI, 0–100)", short="Коррупция", group="legal", unit="", fmt=0, dir=1,
         scale={"type": "abs", "points": [[0, 1], [100, 5]]}, source="World Bank WGI", code="GOV_WGI_CC.SC",
         cats=["бюрократия"], note="коррупция в целом, не миграционная бюрократия"),
    dict(key="wgi_ge", name="Эффективность госуправления (WGI, 0–100)", short="Госуправл.", group="legal", unit="", fmt=0,
         dir=1, scale={"type": "abs", "points": [[0, 1], [100, 5]]}, source="World Bank WGI", code="GOV_WGI_GE.SC",
         cats=["бюрократия"], note="качество госуправления в целом"),
    dict(key="free_speech", name="Свобода слова (V-Dem, 0–1)", short="Свобода слова", group="people", unit="", fmt=2,
         dir=1, scale={"type": "lin", "step": 0.38}, source="V-Dem через Our World in Data",
         code="freedom-of-expression-index", license="CC BY 4.0",
         url="https://ourworldindata.org/grapher/freedom-of-expression-index", cats=["свободы"]),
    dict(key="ru_visa", name="Безвиз для паспорта РФ", short="Безвиз РФ", group="legal", unit="дн.", fmt=0, dir=1,
         scale={"type": "abs", "points": [[0, 1], [30, 3], [90, 4], [180, 5]]}, source="passport-index-data",
         code="RUS → страна", license="MIT", url="https://github.com/imorte/passport-index-data", cats=[],
         note="сколько дней можно жить без визы; 0 — нужна виза или e-visa"),
]
WB_N = {"homicide": 5}
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


def usd_price_growth(fx, span=USD_SPAN):
    """CAGR of the price level in US dollars (CPI / LCU per USD) over the latest `span` years both exist.
    A yearly jump of 3x either way is a redenomination or an official-rate reset, not prices: country skipped."""
    cpi, rate = wb_series(fx, "FP.CPI.TOTL", 12), wb_series(fx, "PA.NUS.FCRF", 12)
    out, breaks = {}, []
    for c, rows in cpi.items():
        y0, k = EURO_SWITCH.get(c, (0, 1))
        lc = {y: v / k if y < y0 else v for y, v in rate.get(c, [])}
        usd = {y: v / lc[y] for y, v in rows if lc.get(y, 0) > 0 and v > 0}
        end = next((y for y in sorted(usd, reverse=True) if y - span in usd), None)
        if end is None:
            continue
        ys = [y for y in sorted(usd) if end - span <= y <= end]
        if any(not 1 / 3 < usd[b] / usd[a] < 3 for a, b in zip(ys, ys[1:])):
            breaks.append(c)
            continue
        out[c] = (end, ((usd[end] / usd[end - span]) ** (1 / span) - 1) * 100)
    log(f"  usd_prices: skipped for breaks: {' '.join(sorted(breaks))}")
    return out


EASY = {"visa free", "visa on arrival", "eta"}
DEFAULT_DAYS = {"visa free": 90, "visa on arrival": 30, "eta": 90}
MONTHS = "january february march april may june july august september october november december".split()


def passport_series(fx):
    readme = fx.get(f"{PASSPORT}/README.md").decode("utf-8")
    m = re.search(r"Last updated:\s*\**\s*(\d{1,2})\s+(\w+)\s+(\d{4})", readme)
    year = int(m.group(3)) if m else dt.date.today().year
    upd = f"{int(m.group(1)):02d}.{MONTHS.index(m.group(2).lower()) + 1:02d}.{year}" \
        if m and m.group(2).lower() in MONTHS else str(year)
    text = fx.get(f"{PASSPORT}/passport-index-tidy-iso3.csv", timeout=120).decode("utf-8")
    rd = csv.reader(io.StringIO(text))
    next(rd)
    ru = {}
    for frm, to, req in rd:
        req = req.strip().lower()
        if frm != "RUS" or req == "-1":
            continue
        if req.isdigit():
            ru[to] = (year, float(req), "visa free")
        elif req in DEFAULT_DAYS:
            ru[to] = (year, float(DEFAULT_DAYS[req]), req)
        else:
            ru[to] = (year, 0.0, req)
    ru["RUS"] = (year, 360.0, "home")
    return ru, upd


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
            if k == "usd_prices":
                jobs[k] = ex.submit(usd_price_growth, fx)
            elif k == "ru_visa":
                jobs[k] = ex.submit(passport_series, fx)
            elif i["source"].startswith("World Bank"):
                jobs[k] = ex.submit(wb_series, fx, c, WB_N.get(k, 1))
            elif "Our World in Data" in i["source"]:
                jobs[k] = ex.submit(owid_series, fx, c)
            elif i["source"].startswith("INFORM"):
                jobs[k] = ex.submit(inform_series, fx, c)

        data, failed, notes = {}, [], {}
        for k, fut in jobs.items():
            try:
                res = fut.result()
            except Exception as e:  # noqa: BLE001
                log(f"FAILED {k}: {e}")
                failed.append(k)
                continue
            if k == "ru_visa":
                res, notes["passport"] = res
                i = next(x for x in IND if x["key"] == k)
                i["note"] = f"{i['note']}; данные на {notes['passport']}"
            elif k in WB_N:
                avg = {}
                for c, v in res.items():
                    last = max(y for y, _ in v)
                    win = [x for y, x in v if y >= max(MIN_YEAR, last - WB_N[k] + 1)]
                    if win:
                        avg[c] = (last, sum(win) / len(win))
                res = avg
            elif isinstance(next(iter(res.values())), list):
                res = {c: max(v) for c, v in res.items()}
            data[k] = res
            log(f"  {k}: {len(res)} raw codes")

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
