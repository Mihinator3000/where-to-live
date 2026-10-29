#!/usr/bin/env python3
"""Build data/world/cities.json: GeoNames cities + Russian names + CHELSA V2.1 climate normals.

Run: uv run --with rasterio --with numpy --with tzdata python scripts/build_cities.py
"""
import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import os
import random
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from zoneinfo import ZoneInfo

UA = "where-to-live-build/1.0 (personal non-commercial)"
ROOT = Path(__file__).resolve().parents[1]
GN = "https://download.geonames.org/export/dump"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
AIRPORTS = "https://davidmegginson.github.io/ourairports-data/airports.csv"
WDQS = "https://query.wikidata.org/sparql"
CHELSA = "https://os.unil.cloud.switch.ch/chelsa02/chelsa/global"

WORLD_MIN = 200_000
RU_MIN = 100_000
FOCUS_MIN = {cc: 15_000 for cc in "ME RS GE AM CY GR HR AL BA MK BG SI PT KZ AZ".split()}
FOCUS_MIN.update({"ES": 22_000, "IT": 22_000, "TR": 22_000})
ALL_OF = {"ME"}
SKIP_FCODES = {"PPLX", "PPLH", "PPLQ", "PPLW"}
MOSCOW_UTC = 3

# CHELSA kg0 codes 1..31 (CHELSA V2.1 tech spec, Kottek et al. 2006 order); verified against
# classes recomputed from CHELSA tas/pr in the local run (see scripts/README-data.md).
KOPPEN = ("Af Am As Aw BWk BWh BSk BSh Cfa Cfb Cfc Csa Csb Csc Cwa Cwb Cwc "
          "Dfa Dfb Dfc Dfd Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd EF ET").split()

SOURCE = ("GeoNames cities15000/cities1000 (CC BY 4.0); названия — Wikidata (CC0); климат — CHELSA V2.1 "
          "climatologies 1981–2010 (CC0; Karger et al. 2017, Sci Data 4:170122; Karger et al. 2021, "
          "EnviDat doi:10.16904/envidat.228.v2.1); аэропорты — OurAirports (public domain), без стран с визой "
          "для паспорта РФ — passport-index-data (MIT); страны — Natural Earth (public domain)")
AIR_TYPES = {"large_airport", "medium_airport"}
# Residence in one Schengen state opens its other airports, so a city there is not cut off from them.
SCHENGEN = set("AUT BEL BGR CHE CZE DEU DNK ESP EST FIN FRA GRC HRV HUN ISL ITA LIE LTU LUX LVA MLT NLD NOR POL "
               "PRT ROU SVK SVN SWE".split())
UPDATABLE = {"air", "tn", "tn1"}

os.environ.update({
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_USERAGENT": UA,
    "GDAL_CACHEMAX": "1024",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": "67108864",
    "GDAL_HTTP_MAX_RETRY": "6",
    "GDAL_HTTP_RETRY_DELAY": "3",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_VERSION": "2",
})


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Fetcher:
    def __init__(self, cache):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)

    def get(self, url, timeout=120, tries=5, data=None, headers=None, name=None):
        key = hashlib.sha1((url + (data or b"").decode()).encode()).hexdigest()[:16]
        f = self.cache / (name or key + ".raw")
        if f.exists() and f.stat().st_size:
            return f.read_bytes()
        err = None
        for k in range(tries):
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read()
                tmp = f.with_suffix(".part")
                tmp.write_bytes(body)
                tmp.replace(f)
                return body
            except Exception as e:  # noqa: BLE001
                err = e
                log(f"  retry {k + 1}/{tries} {url[:90]}: {e}")
                time.sleep(5 * (k + 1))
        raise RuntimeError(f"fetch failed {url}: {err}")


def gn_rows(fx, name):
    z = zipfile.ZipFile(io.BytesIO(fx.get(f"{GN}/{name}.zip", timeout=300, name=f"{name}.zip")))
    with z.open(f"{name}.txt") as fh:
        yield from csv.reader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE)


def iso_map(fx):
    m = {}
    for line in fx.get(f"{GN}/countryInfo.txt", name="countryInfo.txt").decode("utf-8").splitlines():
        if line and not line.startswith("#"):
            p = line.split("\t")
            m[p[0]] = p[1]
    for f in json.loads(fx.get(NE_URL, name="ne50.geojson"))["features"]:
        p = f["properties"]
        if p["ISO_A2_EH"] != "-99":
            m[p["ISO_A2_EH"]] = p["ISO_A3_EH"] if p["ISO_A3_EH"] != "-99" else p["ADM0_A3"]
    return m


def select(fx):
    keep, dropped = {}, {}
    for r in gn_rows(fx, "cities15000"):
        if r[7] in SKIP_FCODES:
            continue
        pop, cc = int(r[14] or 0), r[8]
        if pop >= WORLD_MIN or (cc == "RU" and pop >= RU_MIN) or (cc in FOCUS_MIN and pop >= FOCUS_MIN[cc]):
            keep[r[0]] = r
        elif cc in FOCUS_MIN and pop >= 15_000 and cc != "RU":
            dropped[cc] = dropped.get(cc, 0) + 1
    for r in gn_rows(fx, "cities1000"):
        if r[8] in ALL_OF and r[7] not in SKIP_FCODES:
            keep[r[0]] = r
    return list(keep.values()), dropped



def drop_metro_parts(rows):
    """GeoNames keeps big-city districts (Konak, Bağcılar, Brooklyn) as separate places: drop a city when a
    city of the same country at least twice as big lies within 8 km * sqrt(pop in millions), 6..35 km."""
    big = sorted(rows, key=lambda r: -int(r[14] or 0))
    out = []
    for r in rows:
        pop, lat, lon = int(r[14] or 0), float(r[4]), float(r[5])
        part = False
        if r[8] not in ALL_OF:
            for b in big:
                bpop = int(b[14] or 0)
                if bpop < 2 * pop:
                    break
                if b[8] == r[8] and abs(float(b[4]) - lat) < 0.4 and \
                        nearest_km(lat, lon, [(float(b[4]), float(b[5]))]) < min(35, max(6, 8 * math.sqrt(bpop / 1e6))):
                    part = True
                    break
        if not part:
            out.append(r)
    return out

LABEL_PREFIX = re.compile(r"^(городской округ|район|муниципалитет|община|коммуна)\s+", re.I)


def clean_label(s):
    return LABEL_PREFIX.sub("", re.sub(r"\s*\([^)]*\)$", "", s)).strip() or s


def ru_labels(fx, ids, batch=300):
    out = {}
    for b in range(0, len(ids), batch):
        chunk = ids[b:b + batch]
        q = ('SELECT ?gn ?l WHERE { VALUES ?gn { %s } ?it wdt:P1566 ?gn . ?it rdfs:label ?l . '
             'FILTER(LANG(?l) = "ru") }') % " ".join(f'"{i}"' for i in chunk)
        body = urllib.parse.urlencode({"query": q}).encode()
        try:
            res = json.loads(fx.get(WDQS, data=body, timeout=180, headers={
                "Accept": "application/sparql-results+json",
                "Content-Type": "application/x-www-form-urlencoded"}))
        except Exception as e:  # noqa: BLE001
            log(f"  wikidata batch {b // batch} failed: {e}")
            continue
        for x in res["results"]["bindings"]:
            gid, label = x["gn"]["value"], clean_label(x["l"]["value"])
            if gid not in out or len(label) < len(out[gid]):
                out[gid] = label
        time.sleep(1)
    return out


def ru_labels_by_name(fx, rows, batch=100, max_km=25):
    """Fallback when Wikidata P1566 points to another GeoNames ID (municipality, ADM2):
    items with the same en/mul label and coordinates within max_km of the GeoNames point."""
    out = {}

    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')

    for b in range(0, len(rows), batch):
        chunk = {r[0]: r for r in rows[b:b + batch]}
        vals = " ".join(f'("{esc(n)}"@{lg} "{gid}")' for gid, r in chunk.items()
                        for n in {r[1], r[2]} for lg in ("en", "mul"))
        q = ('SELECT ?gid ?ru ?coord WHERE { hint:Query hint:optimizer "None" . VALUES (?l ?gid) { %s } '
             '?it rdfs:label ?l . ?it wdt:P625 ?coord . ?it rdfs:label ?ru . FILTER(LANG(?ru) = "ru") }') % vals
        body = urllib.parse.urlencode({"query": q}).encode()
        try:
            res = json.loads(fx.get(WDQS, data=body, timeout=180, headers={
                "Accept": "application/sparql-results+json",
                "Content-Type": "application/x-www-form-urlencoded"}))
        except Exception as e:  # noqa: BLE001
            log(f"  wikidata name batch {b // batch} failed: {e}")
            continue
        for x in res["results"]["bindings"]:
            gid, v = x["gid"]["value"], x["coord"]["value"]
            if not v.startswith("Point("):
                continue
            lon, lat = map(float, v[6:-1].split())
            r = chunk[gid]
            km = math.hypot((lon - float(r[5])) * math.cos(math.radians(lat)), lat - float(r[4])) * 111.2
            if km <= max_km and (gid not in out or km < out[gid][1]):
                out[gid] = (clean_label(x["ru"]["value"]), km)
        time.sleep(1)
    return {k: v[0] for k, v in out.items()}


def ru_visa_days(path):
    """Days without a visa for a Russian passport by ISO3, from indicators.json (build_countries.py runs first)."""
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        return {iso: v["ru_visa"][0] for iso, v in d["countries"].items() if "ru_visa" in v}
    except Exception as e:  # noqa: BLE001
        log(f"WARNING: no ru_visa in {path} ({e}): airports are not filtered by visa")
        return None


def airports(fx, iso):
    """Large and medium airports with scheduled flights: (lat, lon, ISO3, ident). Closed ones (Atatürk) drop out."""
    rd = csv.DictReader(io.StringIO(fx.get(AIRPORTS, name="airports.csv").decode("utf-8")))
    return [(float(a["latitude_deg"]), float(a["longitude_deg"]), iso.get(a["iso_country"]), a["ident"])
            for a in rd if a["type"] in AIR_TYPES and a["scheduled_service"] == "yes"]


class AirIndex:
    """Nearest usable airport for a city: same country, the same Schengen zone, or a country whose
    ru_visa is above 0 days. Dubrovnik is out for Herceg Novi, Spanish airports stay for Spanish cities."""

    def __init__(self, air, days):
        self.air, self.days, self.by_cc = air, days, {}

    def ok(self, cc, a):
        return self.days is None or a == cc or (cc in SCHENGEN and a in SCHENGEN) or self.days.get(a, 0) > 0

    def nearest(self, lat, lon, cc):
        if cc not in self.by_cc:
            self.by_cc[cc] = [x for x in self.air if self.ok(cc, x[2])]
        pts = self.by_cc[cc]
        if not pts:
            return None, None
        k = nearest_idx(lat, lon, pts)
        return nearest_km(lat, lon, [pts[k][:2]]), pts[k][3]


def nearest_idx(lat, lon, pts):
    c = math.cos(math.radians(lat))
    return min(range(len(pts)), key=lambda i: (pts[i][0] - lat) ** 2 + ((pts[i][1] - lon + 540) % 360 - 180) ** 2 * c * c)


def nearest_km(lat, lon, pts):
    p1 = math.radians(lat)
    best = 1e9
    for la, lo in (x[:2] for x in pts):
        p2 = math.radians(la)
        h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo - lon) / 2) ** 2
        best = min(best, 2 * 6371.0088 * math.asin(math.sqrt(h)))
    return best


def tz_offset(name, lat, year):
    try:
        z = ZoneInfo(name)
    except Exception:  # noqa: BLE001
        return None
    d = dt.datetime(year, 1 if lat >= 0 else 7, 15, 12, tzinfo=z)
    h = d.utcoffset().total_seconds() / 3600 - MOSCOW_UTC
    return int(h) if h == int(h) else round(h, 2)


def rasters():
    c = f"{CHELSA}/climatologies"
    out = []
    for v in ("tas", "pr", "clt"):
        out += [(f"{v}_{m:02d}", f"{c}/{v}/1981-2010/CHELSA_{v}_{m:02d}_1981-2010_V.2.1.tif") for m in range(1, 13)]
    out += [("tasmax_07", f"{c}/tasmax/1981-2010/CHELSA_tasmax_07_1981-2010_V.2.1.tif"),
            ("tasmin_07", f"{c}/tasmin/1981-2010/CHELSA_tasmin_07_1981-2010_V.2.1.tif"),
            ("tasmin_01", f"{c}/tasmin/1981-2010/CHELSA_tasmin_01_1981-2010_V.2.1.tif"),
            ("kg0", f"{CHELSA}/bioclim/kg0/1981-2010/CHELSA_kg0_1981-2010_V.2.1.tif")]
    return out


def sample(url, pts, level, nb=2):
    """Values at (lon, lat) points; nodata -> nearest valid pixel in a (2nb+1)^2 window."""
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(url) as base:
        sc, off = base.scales[0], base.offsets[0]  # overviews lose scale/offset metadata
    kw = {"overview_level": level} if level >= 0 else {}
    with rasterio.open(url, **kw) as ds:
        inv = ~ds.transform
        nod = ds.nodata
        bh, bw = ds.block_shapes[0]
        groups = {}
        for i, (lon, lat) in enumerate(pts):
            c, r = inv * (lon, lat)
            r, c = int(math.floor(r)), int(math.floor(c))
            if 0 <= r < ds.height and 0 <= c < ds.width:
                groups.setdefault((r // bh, c // bw), []).append((i, r, c))
        out = [None] * len(pts)
        for key in sorted(groups):
            g = groups[key]
            r0 = max(min(x[1] for x in g) - nb, 0)
            r1 = min(max(x[1] for x in g) + nb + 1, ds.height)
            c0 = max(min(x[2] for x in g) - nb, 0)
            c1 = min(max(x[2] for x in g) + nb + 1, ds.width)
            arr = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
            for i, r, c in g:
                rr, cc = r - r0, c - c0
                v = arr[rr, cc]
                if v == nod:
                    best = None
                    for dr in range(-nb, nb + 1):
                        for dc in range(-nb, nb + 1):
                            y, x = rr + dr, cc + dc
                            if 0 <= y < arr.shape[0] and 0 <= x < arr.shape[1] and arr[y, x] != nod:
                                d = dr * dr + dc * dc
                                if best is None or d < best[0]:
                                    best = (d, arr[y, x])
                    v = None if best is None else best[1]
                out[i] = None if v is None else float(v) * sc + off
    return out


def sample_par(url, pts, level, n):
    """sample() split into n threads by region: one raster is latency-bound, not CPU-bound."""
    if n <= 1 or len(pts) < 200:
        return sample(url, pts, level)
    order = sorted(range(len(pts)), key=lambda i: (pts[i][1] // 10, pts[i][0]))
    parts = [order[j * len(order) // n:(j + 1) * len(order) // n] for j in range(n)]
    out = [None] * len(pts)
    with ThreadPoolExecutor(max_workers=n) as ex:
        for part, vals in zip(parts, ex.map(lambda q: sample(url, [pts[i] for i in q], level), parts)):
            for i, v in zip(part, vals):
                out[i] = v
    return out


def pkey(lon, lat):
    return f"{lon:.4f},{lat:.4f}"


def sample_all(pts, cache, level, workers, only=None):
    """Per-raster cache {lon,lat: value}: a changed city list resamples only new points."""
    cdir = Path(cache) / f"chelsa_L{level}"
    cdir.mkdir(parents=True, exist_ok=True)
    todo = [(k, u) for k, u in rasters() if not only or k in only]
    per = max(1, workers // max(1, len(todo)))
    res = {}

    def run(k, u):
        f = cdir / f"{k}.json"
        known = json.loads(f.read_text()) if f.exists() else {}
        new = [p for p in dict.fromkeys(pts) if pkey(*p) not in known]
        t = time.time()
        if new:
            lv = -1 if k == "kg0" else level  # categories: never resampled overviews
            for attempt in range(3):
                try:
                    vals = sample_par(u, new, lv, per)
                    break
                except Exception as e:  # noqa: BLE001
                    log(f"  {k} attempt {attempt + 1}: {e}")
                    time.sleep(10)
            else:
                raise RuntimeError(f"CHELSA {k} failed")
            known.update({pkey(*p): v for p, v in zip(new, vals)})
            tmp = f.with_suffix(".part")
            tmp.write_text(json.dumps(known))
            tmp.replace(f)
        return k, [known[pkey(*p)] for p in pts], len(new), time.time() - t

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(run, k, u) for k, u in todo]
        for n, fu in enumerate(as_completed(futs), 1):
            k, vals, nn, sec = fu.result()
            res[k] = vals
            log(f"  [{n}/{len(todo)}] {k}: {nn} new points, {sec:.0f}s, missing {sum(v is None for v in vals)}")
    return res


def r1(v):
    if v is None:
        return None
    v = round(v, 1)
    return 0.0 if v == 0 else v


def r0(v):
    return None if v is None else int(round(v))


def kelvin(v):
    return r1(None if v is None else v - 273.15)


def update(a, fx):
    """Recompute only some fields of the existing cities.json, no full CHELSA/Wikidata run."""
    fields = set(a.update.split(","))
    if fields - UPDATABLE:
        sys.exit(f"--update: unknown fields {sorted(fields - UPDATABLE)}, allowed {sorted(UPDATABLE)}")
    out = Path(a.out)
    cities = json.loads(out.read_text(encoding="utf-8"))["cities"]
    if "air" in fields:
        ai = AirIndex(airports(fx, iso_map(fx)), ru_visa_days(a.indicators))
        log(f"airports with scheduled flights: {len(ai.air)}")
        for c in cities:
            c["air"] = r0(ai.nearest(c["lat"], c["lon"], c["cc"])[0])
    clim_fields = {"tn": "tasmin_07", "tn1": "tasmin_01"}
    keys = {clim_fields[f] for f in fields & set(clim_fields)}
    if keys:
        exact = {r[0]: (float(r[5]), float(r[4])) for r in gn_rows(fx, "cities1000")}
        pts = [exact.get(str(c["id"]), (c["lon"], c["lat"])) for c in cities]
        log(f"points: {len(pts)}, exact GeoNames coordinates for {sum(str(c['id']) in exact for c in cities)}")
        clim = sample_all(pts, a.cache, a.level, a.workers, keys)
        for f, k in clim_fields.items():
            if f in fields:
                for c, v in zip(cities, clim[k]):
                    c[f] = kelvin(v)
    return cities


def write(out, cities, t0):
    cities.sort(key=lambda c: (-c["pop"], c["id"]))
    gen = dt.datetime.now(dt.timezone.utc).date().isoformat()
    head = json.dumps({"generated": gen, "source": SOURCE}, ensure_ascii=False)[:-1]
    body = ",\n".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in cities)
    text = head + ',"cities":[\n' + body + "\n]}\n"
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.read_text(encoding="utf-8").split("\n", 1)[-1] == text.split("\n", 1)[-1]:
        log("data unchanged, file kept")
    else:
        out.write_text(text, encoding="utf-8")
    json.loads(out.read_text(encoding="utf-8"))
    raw = len(text.encode("utf-8"))
    gz = len(gzip.compress(text.encode("utf-8"), 9))
    miss = sum(1 for c in cities if c["t"][0] is None)
    log(f"wrote {out}: {len(cities)} cities, {raw / 1e6:.2f} MB raw, {gz / 1e6:.2f} MB gzip, "
        f"no climate: {miss}, no cc: {sum(1 for c in cities if not c['cc'])}, total {time.time() - t0:.0f}s")
    if raw > 1_500_000:
        log("WARNING: cities.json > 1.5 MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "world" / "cities.json"))
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "where-to-live-build" / "cities"))
    ap.add_argument("--level", type=int, default=-1, help="CHELSA overview level: -1 native 1 km, 0 = 2 km, 1 = 4 km")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="test: random sample of N cities")
    ap.add_argument("--only", default="", help="test: comma-separated raster keys")
    ap.add_argument("--update", default="", help="recompute only these fields of the existing --out: air,tn,tn1")
    ap.add_argument("--indicators", default=str(ROOT / "data" / "world" / "indicators.json"),
                    help="ru_visa source for the airport visa filter")
    a = ap.parse_args()
    t0 = time.time()
    fx = Fetcher(a.cache)
    if a.update:
        write(a.out, update(a, fx), t0)
        return

    iso = iso_map(fx)
    rows, dropped = select(fx)
    n0 = len(rows)
    rows = drop_metro_parts(rows)
    log(f"dropped {n0 - len(rows)} districts of bigger cities")
    log(f"selected {len(rows)} cities; focus-country cities ≥15k dropped by a raised threshold: {dropped}")
    if a.limit:
        random.Random(1).shuffle(rows)
        rows = rows[:a.limit]
    pts = [(float(r[5]), float(r[4])) for r in rows]

    only = set(filter(None, a.only.split(",")))
    clim = sample_all(pts, a.cache, a.level, a.workers, only)
    t_clim = time.time() - t0
    log(f"CHELSA done in {t_clim:.0f}s")
    if only:
        return

    names = ru_labels(fx, [r[0] for r in rows])
    n1 = len(names)
    names.update(ru_labels_by_name(fx, [r for r in rows if r[0] not in names]))
    log(f"ru labels: {len(names)}/{len(rows)} (by GeoNames ID {n1}, by name+coords {len(names) - n1})")
    ai = AirIndex(airports(fx, iso), ru_visa_days(a.indicators))
    log(f"airports with scheduled flights: {len(ai.air)}")
    year = dt.date.today().year

    cities = []
    for i, r in enumerate(rows):
        lat, lon = float(r[4]), float(r[5])
        el = int(r[15]) if r[15].strip() else (int(r[16]) if r[16].strip() and int(r[16]) != -9999 else None)
        kg = clim["kg0"][i]
        kg = KOPPEN[int(kg) - 1] if kg is not None and 1 <= int(kg) <= len(KOPPEN) else None
        cities.append({
            "id": int(r[0]), "n": names.get(r[0], r[1]), "en": r[1],
            "lat": round(lat, 3), "lon": round(lon, 3), "cc": iso.get(r[8]), "pop": int(r[14] or 0),
            "el": el, "tz": tz_offset(r[17], lat, year) if r[17] else None,
            "air": r0(ai.nearest(lat, lon, iso.get(r[8]))[0]), "kg": kg,
            "t": [r1(None if v is None else v - 273.15) for v in (clim[f"tas_{m:02d}"][i] for m in range(1, 13))],
            "p": [r0(clim[f"pr_{m:02d}"][i]) for m in range(1, 13)],
            "c": [r0(clim[f"clt_{m:02d}"][i]) for m in range(1, 13)],
            "tx": kelvin(clim["tasmax_07"][i]),
            "tn": kelvin(clim["tasmin_07"][i]),
            "tn1": kelvin(clim["tasmin_01"][i]),
        })
    write(a.out, cities, t0)


if __name__ == "__main__":
    main()
