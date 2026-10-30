const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export { MONTHS };

export function daylight(lat, day = 355) {
  const decl = 23.44 * Math.sin((2 * Math.PI / 365) * (day - 81)) * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const c = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
  const w0 = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
  return 2 * w0 / 15;
}

const sum = a => a.reduce((x, y) => x + y, 0);
const okArr = a => Array.isArray(a) && a.length === 12 && a.every(v => v != null);

export const CITY_INDICATORS = [
  { key: "t_jan", name: "Январь, средняя °C", short: "Январь", group: "climate", unit: "°C", fmt: 1, dir: 1, scale: { type: "lin", step: 3 }, cats: [], get: c => (okArr(c.t) ? c.t[0] : null) },
  { key: "tn_jan", name: "Январь, ночной минимум °C", short: "Ночи января", group: "climate", unit: "°C", fmt: 1, dir: 0, cats: [], get: c => c.tn1 ?? null },
  { key: "t_jul", name: "Июль, средняя °C", short: "Июль", group: "climate", unit: "°C", fmt: 1, dir: 0, cats: [], get: c => (okArr(c.t) ? c.t[6] : null) },
  { key: "tx_jul", name: "Июль, дневной максимум °C", short: "Жара июля", group: "climate", unit: "°C", fmt: 1, dir: -1, scale: { type: "abs", points: [[24, 3], [27, 2.75], [30, 2.25], [33, 1.75], [36, 1]] }, cats: [], get: c => c.tx },
  { key: "tn_jul", name: "Июль, ночной минимум °C", short: "Ночи июля", group: "climate", unit: "°C", fmt: 1, dir: -1, scale: { type: "abs", points: [[17, 3], [20, 2.5], [22, 2], [24, 1.5], [26, 1]] }, cats: ["лето"], note: "от 20 °C — душные ночи, без кондиционера плохо спится", get: c => c.tn ?? null },
  { key: "warm", name: "Месяцев со средней ≥ 18 °C", short: "Тёплых мес.", group: "climate", unit: "мес", fmt: 0, dir: 0, cats: [], get: c => (okArr(c.t) ? c.t.filter(v => v >= 18).length : null) },
  { key: "rain", name: "Осадки за год, мм", short: "Осадки", group: "climate", unit: "мм", fmt: 0, dir: 0, cats: [], note: "модель, у моря и в горах часто завышена", get: c => (okArr(c.p) ? sum(c.p) : null) },
  { key: "cloud_win", name: "Облачность ноябрь–февраль, %", short: "Тучи зимой", group: "climate", unit: "%", fmt: 0, dir: -1, scale: { type: "lin", step: 8 }, cats: ["свет"], get: c => (okArr(c.c) ? (c.c[10] + c.c[11] + c.c[0] + c.c[1]) / 4 : null) },
  { key: "day_dec", name: "Световой день 21 декабря, ч", short: "Свет 21.12", group: "climate", unit: "ч", fmt: 1, dir: 1, scale: { type: "lin", step: 1.5 }, cats: ["свет"], get: c => (c.lat == null ? null : daylight(c.lat)) },
  { key: "tz_msk", name: "Разница с Москвой зимой, ч", short: "Пояс", group: "work", unit: "ч", fmt: 0, dir: -1, scale: { type: "abs", points: [[0, 3], [1, 2.75], [2, 2.5], [4, 2], [6, 1.5], [8, 1]] }, cats: ["часовой_пояс"], get: c => (c.tz == null ? null : Math.abs(c.tz)) },
  { key: "air_km", name: "До аэропорта с регулярными рейсами, км", short: "Аэропорт", group: "links", unit: "км", fmt: 0, dir: -1, scale: { type: "abs", points: [[15, 5], [40, 4], [90, 3], [180, 2], [350, 1]] }, cats: ["аэропорт"], get: c => c.air },
  { key: "pop", name: "Население", short: "Население", group: "city", unit: "", fmt: 0, dir: 0, cats: [], get: c => c.pop || null },
];

export const SPB = { lat: 59.94, lon: 30.31 };

function interp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

export function toScore(ind, v, ref) {
  if (v == null || !Number.isFinite(v) || !ind.scale || !ind.dir && ind.scale.type !== "abs") return null;
  const s = ind.scale;
  let out;
  if (s.type === "abs") out = interp(s.points, v);
  else if (ref == null) return null;
  else if (s.type === "log") { if (v <= 0 || ref <= 0) return null; out = 3 + ind.dir * (Math.log(v) - Math.log(ref)) / s.step; }
  else out = 3 + ind.dir * (v - ref) / s.step;
  return Math.max(1, Math.min(5, out));
}

export function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class World {
  constructor() {
    this.indicators = [];
    this.countries = {};
    this.geo = null;
    this.names = {};
    this.enNames = {};
    this.iso2 = {};
    this.cities = null;
    this.citiesPromise = null;
    this.generated = "";
    this.citySource = "";
  }

  async load() {
    const [ind, geo] = await Promise.all([
      fetch("data/world/indicators.json").then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/world/countries.geojson").then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (ind) {
      this.indicators = ind.indicators || [];
      this.countries = ind.countries || {};
      this.generated = ind.generated || "";
    }
    if (geo) {
      this.geo = geo;
      geo.features.forEach(f => {
        const p = f.properties;
        if (!this.names[p.iso3]) this.names[p.iso3] = p.name_ru || p.name;
        if (!this.enNames[p.iso3]) this.enNames[p.iso3] = p.name;
        if (p.iso2) this.iso2[p.iso2.toUpperCase()] = p.iso3;
      });
    }
    this.IND = Object.fromEntries(this.indicators.map(i => [i.key, i]));
    this.CIND = Object.fromEntries(CITY_INDICATORS.map(i => [i.key, i]));
  }

  loadCities() {
    if (!this.citiesPromise) {
      this.citiesPromise = fetch("data/world/cities.json").then(r => (r.ok ? r.json() : { cities: [] })).catch(() => ({ cities: [] })).then(d => {
        this.cities = d.cities || [];
        this.citySource = d.source || "";
        this.spbCity = this.nearestCity(SPB, 40);
        return this.cities;
      });
    }
    return this.citiesPromise;
  }

  nameOf(iso3) { return this.names[iso3] || iso3 || ""; }

  enNameOf(iso3) { return this.enNames[iso3] || ""; }
  iso3of(iso2) { return this.iso2[String(iso2 || "").toUpperCase()] || null; }

  raw(iso3, key) {
    const c = this.countries[iso3];
    const v = c && c[key];
    return Array.isArray(v) ? v : v == null ? null : [v, null];
  }

  countryScore(iso3, key) {
    const ind = this.IND[key];
    const r = this.raw(iso3, key), ref = this.raw("RUS", key);
    return ind && r ? toScore(ind, r[0], ref ? ref[0] : null) : null;
  }

  nearestCity(pt, maxKm = 30) {
    if (!this.cities || pt.lat == null) return null;
    let best = null, bd = Infinity;
    for (const c of this.cities) {
      if (Math.abs(c.lat - pt.lat) > 1 || Math.abs(c.lon - pt.lon) > 1.5) continue;
      const d = haversine(pt, c);
      if (d < bd) { bd = d; best = c; }
    }
    return bd <= maxKm ? best : null;
  }

  cityValue(city, key) {
    const ind = this.CIND[key];
    return ind && city ? ind.get(city) : null;
  }

  cityScore(city, key) {
    const ind = this.CIND[key];
    if (!ind || !city) return null;
    const v = ind.get(city);
    const ref = this.spbCity ? ind.get(this.spbCity) : null;
    return toScore(ind, v, ref);
  }

  placeCity(place) {
    if (!place || place.lat == null) return null;
    if (this.pcFor !== this.cities) { this.pc = new Map(); this.pcFor = this.cities; }
    const k = place.lat + "," + place.lon;
    if (!this.pc.has(k)) this.pc.set(k, this.nearestCity(place, 30) || this.pointCity(place));
    return this.pc.get(k);
  }

  pointCity(place) {
    return { lat: place.lat, lon: place.lon, synthetic: true };
  }

  autoData(place, catKey) {
    const vals = [];
    if (place.cc) this.indicators.forEach(ind => { if ((ind.cats || []).includes(catKey)) { const s = this.countryScore(place.cc, ind.key); if (s != null) vals.push(s); } });
    const city = this.placeCity(place);
    if (city) CITY_INDICATORS.forEach(ind => { if (ind.cats.includes(catKey)) { const s = this.cityScore(city, ind.key); if (s != null) vals.push(s); } });
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  quantiles(values, n = 5) {
    const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return [];
    return Array.from({ length: n - 1 }, (_, i) => v[Math.floor((i + 1) * v.length / n)]);
  }
}

export function fmtValue(ind, v) {
  if (v == null) return "—";
  const d = ind.fmt == null ? 1 : ind.fmt;
  const n = Math.abs(v) >= 10000 ? Math.round(v).toLocaleString("ru-RU") : Number(v).toFixed(d);
  return ind.unit && ind.unit !== "$" ? `${n} ${ind.unit}` : ind.unit === "$" ? `$${n}` : n;
}

export const CIVIDIS = ["#00224e", "#35456c", "#666970", "#a59c74", "#fee838"];
