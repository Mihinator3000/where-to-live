const ALPHA = 0.65;

function clipNorm(values, log) {
  const xs = values.filter(v => v != null && isFinite(v) && (!log || v > 0)).map(v => (log ? Math.log(v) : v)).sort((a, b) => a - b);
  if (xs.length < 5) return null;
  const lo = xs[Math.floor(xs.length * 0.02)], hi = xs[Math.ceil(xs.length * 0.98) - 1];
  if (!(hi > lo)) return null;
  return v => {
    if (v == null || !isFinite(v) || (log && v <= 0)) return null;
    const x = log ? Math.log(v) : v;
    return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  };
}

const KG_LABEL = { A: "тропики", B: "сухой", C: "умеренный", D: "континентальный", E: "полярный" };
export const kgName = kg => (kg ? `${kg} · ${KG_LABEL[kg[0]] || ""}`.trim() : "—");

export class Similar {
  constructor(world, groups) {
    this.world = world;
    this.groups = groups;
    this.ready = false;
  }

  prepare() {
    const W = this.world;
    const cities = W.cities || [];
    this.cfeat = [];
    W.indicators.forEach(ind => {
      const all = Object.keys(W.countries).map(iso => { const r = W.raw(iso, ind.key); return r ? r[0] : null; });
      const f = clipNorm(all, ind.scale && ind.scale.type === "log");
      if (f) this.cfeat.push({ key: ind.key, name: ind.short || ind.name, group: ind.group, norm: f });
    });
    this.countryVec = {};
    Object.keys(W.countries).forEach(iso => {
      this.countryVec[iso] = this.cfeat.map(f => { const r = W.raw(iso, f.key); return r ? f.norm(r[0]) : null; });
    });
    const pdefs = [
      { key: "pop", name: "размер города", group: "city", log: true, get: c => c.pop || null },
      { key: "air", name: "аэропорт", group: "links", log: true, get: c => (c.air == null ? null : c.air + 5) },
      { key: "el", name: "высота", group: "nature", log: false, get: c => c.el },
      { key: "tz", name: "часовой пояс", group: "work", log: false, get: c => (c.tz == null ? null : Math.abs(c.tz)) },
      { key: "day", name: "свет зимой", group: "climate", log: false, get: c => this.world.cityValue(c, "day_dec") },
    ];
    this.pfeat = pdefs.map(d => Object.assign({}, d, { norm: clipNorm(cities.map(d.get), d.log) })).filter(d => d.norm);
    const dims = 36;
    const stats = Array.from({ length: dims }, () => ({ s: 0, q: 0, n: 0 }));
    const climRaw = c => {
      if (!Array.isArray(c.t) || !Array.isArray(c.p)) return null;
      const v = [];
      for (let m = 0; m < 12; m++) v.push(c.t[m], c.p[m] == null ? null : Math.log1p(c.p[m]), Array.isArray(c.c) ? c.c[m] : null);
      return v;
    };
    this.climRaw = climRaw;
    cities.forEach(c => {
      const v = climRaw(c);
      if (!v) return;
      v.forEach((x, i) => { if (x != null) { stats[i].s += x; stats[i].q += x * x; stats[i].n++; } });
    });
    this.climStats = stats.map(s => { const m = s.n ? s.s / s.n : 0; const sd = s.n ? Math.sqrt(Math.max(1e-9, s.q / s.n - m * m)) : 1; return { m, sd }; });
    let samples = [];
    const step = Math.max(1, Math.floor(cities.length / 300));
    const vecs = cities.filter((_, i) => i % step === 0).map(c => this.climZ(c)).filter(Boolean);
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j += 7) samples.push(this.climEuclid(vecs[i], vecs[j]));
    samples = samples.filter(x => x != null).sort((a, b) => a - b);
    this.climScale = samples.length ? samples[Math.floor(samples.length * 0.9)] : 2;
    this.ready = true;
  }

  climZ(c) {
    const v = this.climRaw(c);
    if (!v) return null;
    return v.map((x, i) => (x == null ? null : (x - this.climStats[i].m) / this.climStats[i].sd));
  }

  climEuclid(a, b) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) { s += (a[i] - b[i]) ** 2; n++; }
    return n >= 12 ? Math.sqrt(s / n) : null;
  }

  profile(x) {
    const cc = x.cc;
    const city = x.city || null;
    return {
      cc,
      cvec: cc ? this.countryVec[cc] || null : null,
      pvec: city ? this.pfeat.map(f => f.norm(f.get(city))) : null,
      clim: city ? this.climZ(city) : null,
      kg: city ? city.kg : null,
    };
  }

  distance(a, b, W, alpha = ALPHA) {
    const parts = [];
    let s = 0, ws = 0, wAll = 0;
    const gcount = (feats) => { const n = {}; feats.forEach(f => { n[f.group] = (n[f.group] || 0) + 1; }); return n; };
    const cN = gcount(this.cfeat), pN = gcount(this.pfeat);
    const add = (w, d, name) => { wAll += w; if (d == null) return; s += w * d; ws += w; parts.push({ name, w, d }); };
    this.cfeat.forEach((f, i) => {
      const w = (W[f.group] || 0) / cN[f.group] * (1 - alpha);
      const av = a.cvec ? a.cvec[i] : null, bv = b.cvec ? b.cvec[i] : null;
      add(w, av == null || bv == null ? null : Math.abs(av - bv), f.name);
    });
    if (alpha > 0) {
      const climW = (W.climate || 0) * alpha;
      this.pfeat.forEach((f, i) => {
        const share = f.group === "climate" ? 0.2 : 1;
        const w = (W[f.group] || 0) / (pN[f.group] || 1) * alpha * share;
        const av = a.pvec ? a.pvec[i] : null, bv = b.pvec ? b.pvec[i] : null;
        add(w, av == null || bv == null ? null : Math.abs(av - bv), f.name);
      });
      const ce = a.clim && b.clim ? this.climEuclid(a.clim, b.clim) : null;
      add(climW * 0.6, ce == null ? null : Math.min(1, ce / this.climScale), "климат по месяцам");
      const kd = a.kg && b.kg ? (a.kg === b.kg ? 0 : a.kg[0] === b.kg[0] ? 0.5 : 1) : null;
      add(climW * 0.2, kd, "тип климата");
    }
    if (!ws || ws / wAll < 0.35) return null;
    return { d: s / ws, cov: ws / wAll, parts };
  }

  explain(r) {
    const sorted = r.parts.filter(p => p.w > 0).slice().sort((x, y) => x.d - y.d);
    const close = sorted.filter(p => p.d <= 0.15).slice(0, 3).map(p => p.name);
    const far = sorted.slice().reverse().filter(p => p.d >= 0.3).slice(0, 3).map(p => p.name);
    return { close, far };
  }

  similarCities(x, W, { k = 15, otherCountry = false } = {}) {
    if (!this.ready) this.prepare();
    const a = this.profile(x);
    const out = [];
    for (const c of this.world.cities || []) {
      if (x.city && c.id === x.city.id) continue;
      if (otherCountry && c.cc === x.cc) continue;
      if (x.lat != null && Math.abs(c.lat - x.lat) < 0.15 && Math.abs(c.lon - x.lon) < 0.2) continue;
      const r = this.distance(a, this.profile({ cc: c.cc, city: c }), W);
      if (r) out.push({ city: c, r });
    }
    out.sort((p, q) => p.r.d - q.r.d);
    return out.slice(0, k).map(o => Object.assign(o, { pct: Math.round((1 - o.r.d) * 100), why: this.explain(o.r) }));
  }

  similarCountries(cc, W, k = 10) {
    if (!this.ready) this.prepare();
    const a = this.profile({ cc });
    const out = [];
    Object.keys(this.countryVec).forEach(iso => {
      if (iso === cc) return;
      const r = this.distance(a, this.profile({ cc: iso }), W, 0);
      if (r) out.push({ cc: iso, r });
    });
    out.sort((p, q) => p.r.d - q.r.d);
    return out.slice(0, k).map(o => Object.assign(o, { pct: Math.round((1 - o.r.d) * 100), why: this.explain(o.r) }));
  }

  predictor(rated, W) {
    if (!this.ready) this.prepare();
    const pts = rated.map(x => ({ prof: this.profile(x), score: x.score })).filter(x => x.prof.cvec || x.prof.clim);
    if (pts.length < 3) return null;
    const ds = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const r = this.distance(pts[i].prof, pts[j].prof, W); if (r) ds.push(r.d); }
    ds.sort((a, b) => a - b);
    const h = ds.length ? Math.max(0.05, ds[Math.floor(ds.length / 2)]) : 0.15;
    const k0 = 2;
    return x => {
      const p = this.profile(x);
      let sw = 0, s = 0;
      pts.forEach(q => { const r = this.distance(p, q.prof, W); if (!r) return; const w = Math.exp(-((r.d / h) ** 2)); sw += w; s += w * q.score; });
      const conf = sw / (sw + k0);
      return conf < 0.3 ? null : { score: (s + k0 * 3) / (sw + k0), conf };
    };
  }
}
