export const SEASON_W = { "худший": 2, "межсезон": 1.5, "пик": 1 };
export const MODE_W = { "удалёнка": 1.5, "смешанно": 1.2, "отпуск": 1 };
export const US_SHARE = { "●": 0.7, "◐": 0.5, "○": 0.2 };
export const MIN_COVERAGE = 0.5;
export const MIN_OWN = 0.5;

export const GEN = { "Михаил": "Михаила", "Вика": "Вики" };
export const gen = w => GEN[w] || w;
export const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const fmt = v => (!Number.isFinite(v) ? "—" : (Math.round(v * 10) / 10).toFixed(1));
export const tenth = v => Math.round(v * 10);
export const byScore = (sa, sb, a, b) => Math.round(((sb == null ? -9 : sb) - (sa == null ? -9 : sa)) * 1e9) || String(a.name).localeCompare(String(b.name), "ru") || String(a.id).localeCompare(String(b.id));

export function normalize(groups, w) {
  const val = k => Math.max(0, Number(w && w[k]) || 0);
  const sum = groups.reduce((a, g) => a + val(g.key), 0);
  const out = {};
  groups.forEach(g => { out[g.key] = sum ? val(g.key) / sum * 100 : 100 / groups.length; });
  return out;
}

export function createModel(schema, data, opts = {}) {
  const PEOPLE = schema.people;
  const GROUPS = schema.groups;
  const CATS = schema.cats;
  const CAT = Object.fromEntries(CATS.map(c => [c.key, c]));
  const GROUP = Object.fromEntries(GROUPS.map(g => [g.key, g]));
  const STAR_KEYS = CATS.filter(c => c.star).map(c => c.key);
  const autoRaw = opts.autoData || (() => null);
  const autoCache = new Map(), groupCache = new Map();
  const autoData = (p, key) => { const k = p.id + "|" + key; if (!autoCache.has(k)) autoCache.set(k, autoRaw(p, key)); return autoCache.get(k); };
  const num = v => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number(v) >= 1 && Number(v) <= 5;
  const latest = list => { const by = new Map(), rest = []; list.forEach(d => { if (!d.id) { rest.push(d); return; } const o = by.get(d.id); if (!o || String(d.updatedAt || "") >= String(o.updatedAt || "")) by.set(d.id, d); }); return [...by.values()].concat(rest); };
  const coord = v => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const tidy = p => { const name = String(p.name == null ? "" : p.name).trim() || `Без названия (${p.id})`, lat = coord(p.lat), lon = coord(p.lon); return name === p.name && lat === p.lat && lon === p.lon ? p : Object.assign({}, p, { name }, lat == null || lon == null ? { lat: null, lon: null } : { lat, lon }); };
  const places = latest((data.places || []).filter(Boolean)).filter(p => !p.deleted).map(tidy);
  const ids = new Set(places.map(p => p.id));
  const ratings = latest((data.ratings || []).filter(Boolean)).filter(r => !r.deleted && r.place && PEOPLE.includes(r.who) && ids.has(r.place)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const PLACE = Object.fromEntries(places.map(p => [p.id, p]));
  const BY = {};
  ratings.forEach(r => (BY[r.place] = BY[r.place] || []).push(r));
  const cache = new Map(), ranges = new Map();

  const isBase = p => p.status === "база";
  const ratingsOf = id => (BY[id] || []).slice();

  const EQUAL = normalize(GROUPS, {});
  const presets = { "Поровну": EQUAL };
  let hasOwnWeights = false;
  PEOPLE.forEach(who => {
    const w = (data.weights || {})[who] || {};
    if (Object.keys(w).length) hasOwnWeights = true;
    presets[who] = Object.keys(w).length ? normalize(GROUPS, w) : EQUAL;
  });
  presets["Оба"] = normalize(GROUPS, Object.fromEntries(GROUPS.map(g => [g.key, mean(PEOPLE.map(w => presets[w][g.key]))])));

  function rw(r) { return (SEASON_W[r.season] || 1) * (MODE_W[r.mode] || 1) * (r.retro ? 0.8 : 1); }

  function personCat(id, who, key) {
    const k = id + "|" + who + "|" + key;
    if (cache.has(k)) return cache.get(k);
    let s = 0, w = 0;
    (BY[id] || []).forEach(r => {
      if (r.who === who && r.scores && num(r.scores[key])) { const x = rw(r); s += Number(r.scores[key]) * x; w += x; }
    });
    const v = w ? s / w : null;
    cache.set(k, v);
    return v;
  }

  function usCat(id, key) {
    const vals = PEOPLE.map(w => personCat(id, w, key)).filter(v => v != null);
    if (!vals.length) return null;
    return GROUP[CAT[key].group].risky ? Math.min(...vals) : mean(vals);
  }

  function extCat(p, key, src) {
    const e = (p.ext && p.ext[key]) || {}, ok = v => (num(v) ? Number(v) : null);
    const res = ok(e.res);
    const dat = ok(e.data) != null ? ok(e.data) : autoData(p, key);
    if (src === "res") return res;
    if (src === "data") return dat;
    return mean([res, dat].filter(v => v != null));
  }

  function finalCat(p, key) {
    if (isBase(p) && GROUP[CAT[key].group].scale === "rel") return 3;
    const u = usCat(p.id, key), e = extCat(p, key);
    if (u == null) return e;
    if (e == null) return u;
    const s = US_SHARE[CAT[key].vis];
    return s * u + (1 - s) * e;
  }

  function catValue(p, key, src) {
    if (src === "final") return finalCat(p, key);
    if (src === "res" || src === "data") return extCat(p, key, src);
    if (isBase(p)) return null;
    return personCat(p.id, src, key);
  }

  function groupScore(p, g, src) {
    if (isBase(p) && src === "final") return GROUP[g].scale === "rel" ? 3 : null;
    const k = p.id + "|" + g + "|" + src;
    if (!groupCache.has(k)) groupCache.set(k, mean(CATS.filter(c => c.group === g).map(c => catValue(p, c.key, src)).filter(v => v != null)));
    return groupCache.get(k);
  }

  function total(p, W, src) {
    let s = 0, w = 0, all = 0;
    GROUPS.forEach(g => {
      const wg = W[g.key] || 0;
      all += wg;
      const v = groupScore(p, g.key, src);
      if (v != null && wg > 0) { s += v * wg; w += wg; }
    });
    return { score: w ? s / w : null, coverage: all ? w / all : 0 };
  }

  const shares = new Map();
  const ownShare = id => { if (!shares.has(id)) shares.set(id, STAR_KEYS.length ? STAR_KEYS.filter(k => PEOPLE.some(w => personCat(id, w, k) != null)).length / STAR_KEYS.length : 0); return shares.get(id); };
  const ownEnough = id => ownShare(id) >= MIN_OWN;

  const vetoes = () => ratings.filter(r => r.veto);
  const vetoed = p => (BY[p.id] || []).some(r => r.veto);
  const candidates = () => places.filter(p => p.status !== "отсев" && !isBase(p) && !vetoed(p));

  let pool = null;
  function ranksFor(W) {
    const list = (pool ||= candidates().filter(p => ownEnough(p.id))).map(p => ({ p, t: total(p, W, "final") })).filter(x => x.t.score != null && x.t.coverage >= MIN_COVERAGE);
    list.sort((a, b) => byScore(a.t.score, b.t.score, a.p, b.p));
    const r = {};
    list.forEach((x, i) => { r[x.p.id] = i + 1; });
    return r;
  }

  function rankRange(W) {
    const key = JSON.stringify(W);
    if (!ranges.has(key)) ranges.set(key, rangeOf(W));
    return ranges.get(key);
  }

  function rangeOf(W) {
    const runs = [ranksFor(W)];
    GROUPS.forEach(g => [0.8, 1.2].forEach(f => {
      const w2 = Object.assign({}, W); w2[g.key] = (W[g.key] || 0) * f; runs.push(ranksFor(w2));
    }));
    PEOPLE.forEach(who => runs.push(ranksFor(presets[who])));
    const out = {};
    runs.forEach(r => Object.keys(r).forEach(n => {
      const o = out[n] || (out[n] = { min: Infinity, max: -Infinity });
      o.min = Math.min(o.min, r[n]); o.max = Math.max(o.max, r[n]);
    }));
    return out;
  }

  function latestYear(id, who) {
    const rs = (BY[id] || []).filter(r => r.who === who && r.year != null);
    if (!rs.length) return null;
    rs.sort((a, b) => String(b.end || b.start || "").localeCompare(String(a.end || a.start || "")) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return rs[0].year;
  }

  function confOf(id, who, key) {
    const rs = (BY[id] || []).filter(r => r.who === who && r.scores && num(r.scores[key]));
    if (!rs.length) return "";
    const c = rs.map(r => (r.conf && r.conf[key]) || "B").sort();
    const worst = c[c.length - 1];
    return worst === "B" ? "" : worst;
  }

  function catFlags(p, key) {
    if (isBase(p)) return [];
    const out = [];
    const per = PEOPLE.map(w => personCat(p.id, w, key));
    const low = per.map((v, i) => [PEOPLE[i], v]).filter(([, v]) => v != null && tenth(v) <= 15);
    if (low.length === 1) out.push({ sev: "crit", short: "≤1.5", text: `${low[0][0]} ставит ${fmt(low[0][1])}` });
    else if (low.length > 1) out.push({ sev: "crit", short: "≤1.5", text: low.every(([, v]) => fmt(v) === fmt(low[0][1])) ? `${low.map(x => x[0]).join(" и ")} ставят ${fmt(low[0][1])}` : low.map(([w, v]) => `${w} ${fmt(v)}`).join(", ") });
    if (per.every(v => v != null) && Math.abs(tenth(per[0]) - tenth(per[1])) >= 15) out.push({ sev: "serious", short: "разногласие", text: `${PEOPLE[0]} ${fmt(per[0])}, ${PEOPLE[1]} ${fmt(per[1])}` });
    const us = usCat(p.id, key), res = extCat(p, key, "res");
    if (us != null && res != null) {
      if (tenth(us) - tenth(res) >= 15) out.push({ sev: "warn", short: "иллюзия туриста", text: `мы ${fmt(us)}, живущие ${fmt(res)}` });
      if (tenth(res) - tenth(us) >= 15) out.push({ sev: "info", short: "недооценили", text: `мы ${fmt(us)}, живущие ${fmt(res)}` });
    }
    return out;
  }

  let flagList = null;
  function allFlags() {
    if (flagList) return flagList;
    const order = { crit: 0, serious: 1, warn: 2, info: 3 };
    const out = flagList = [];
    vetoes().forEach(r => out.push({ sev: "crit", place: r.place, head: `${(PLACE[r.place] || {}).name}: вето — ${r.who}`, what: `вето — ${r.who}`, text: r.veto }));
    places.forEach(p => CATS.forEach(c => catFlags(p, c.key).forEach(f => out.push({ sev: f.sev, place: p.id, head: `${p.name}: ${c.name}`, what: c.name, text: f.text }))));
    out.sort((a, b) => order[a.sev] - order[b.sev]);
    return out;
  }

  function ranking(W, fast) {
    const range = fast ? {} : rankRange(W);
    const rows = candidates().map(p => {
      const t = total(p, W, "final");
      const per = {};
      PEOPLE.forEach(w => { per[w] = total(p, W, w).score; });
      return { p, t, per, range: range[p.id] || null };
    });
    rows.sort((a, b) => byScore(a.t.score, b.t.score, a.p, b.p));
    return {
      rated: rows.filter(r => r.t.score != null && r.t.coverage >= MIN_COVERAGE),
      thin: rows.filter(r => r.t.score != null && r.t.coverage < MIN_COVERAGE),
      unrated: rows.filter(r => r.t.score == null),
      base: places.filter(isBase),
      out: places.filter(p => !isBase(p) && (p.status === "отсев" || vetoed(p))).map(p => ({
        p,
        why: p.status === "отсев" ? (p.reason || "без причины") : ratingsOf(p.id).filter(r => r.veto).map(r => `вето ${gen(r.who)}: ${r.veto}`).join("; "),
      })),
    };
  }

  return {
    PEOPLE, GROUPS, CATS, CAT, GROUP, STAR_KEYS, EQUAL, presets, hasOwnWeights,
    places, ratings, PLACE, isBase, ratingsOf, ownShare, ownEnough,
    personCat, usCat, extCat, finalCat, catValue, groupScore, total,
    vetoes, vetoed, candidates, ranksFor, rankRange, latestYear, confOf, catFlags, allFlags, ranking,
    normalize: w => normalize(GROUPS, w),
  };
}
