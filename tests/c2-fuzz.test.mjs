import "./helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModel, normalize, fmt } from "../js/calc.js";
import { factValue, factRef, factScore, parseAmount, TDS } from "../js/facts.js";
import { toScore, haversine, daylight, CITY_INDICATORS, World, SPB } from "../js/world.js";
import { Similar } from "../js/similar.js";
import { plural, esc, slug, daysBetween, scoreColor, scoreHex, inkOn, mixHex, refreshPalette } from "../js/util.js";
import { rankHTML, placesListHTML, tripsHTML, subtableHTML, flagsHTML, heatHTML, radarSVG, yearsLine, hiddenWho } from "../js/views.js";

/* ==================== shared fixtures ==================== */

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
const PEOPLE = schema.people;
const [ME, PARTNER] = PEOPLE;
const GROUPS = schema.groups;
const CATS = schema.cats;
const CAT_KEYS = CATS.map(c => c.key);
const STAR_KEYS = CATS.filter(c => c.star).map(c => c.key);
const FORM_KEYS = CATS.filter(c => c.form).map(c => c.key);
const RISKY = new Set(GROUPS.filter(g => g.risky).map(g => g.key));
const REL = GROUPS.filter(g => g.scale === "rel").map(g => g.key);
const CAT_GROUP = Object.fromEntries(CATS.map(c => [c.key, c.group]));
const EQUAL = normalize(GROUPS, {});
const SRC = ["final", "res", "data", ...PEOPLE];
const FACT = key => schema.facts.find(f => f.key === key);
const MONEY_FACTS = schema.facts.filter(f => f.rule === "money");

/* the real light-theme colours from the stylesheet, so heat-map and pin colours can be computed without a browser */
const CSS = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
const CSS_VARS = (() => { const i = CSS.indexOf(":root {"), body = CSS.slice(CSS.indexOf("{", i) + 1, CSS.indexOf("}", i)); return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])); })();
globalThis.document = globalThis.document || { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: k => CSS_VARS[k.replace(/^--/, "")] || "" });
refreshPalette();

/* deterministic PRNG (mulberry32) so every run sees the same thousands of data sets */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo, hi) => lo + next() * (hi - lo),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    sample: (arr, n) => { const c = arr.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, n); },
    shuffle: arr => r.sample(arr, arr.length),
    score: () => (next() < 0.85 ? 1 + Math.floor(next() * 5) : [1.5, 2.5, 3.5, 4.5][Math.floor(next() * 4)]),
  };
  return r;
}
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

const NAMES = ["Будва", "Котор", "Тиват", "Бар", "Херцег-Нови", "Анталья", "Измир", "Белград", "Нови-Сад", "Тбилиси", "Батуми", "Ереван"];

/* the "world data" column: figures of the place first (as the app does), then a stable pseudo-world value */
function autoFor(seed, places) {
  return (p, k) => {
    const F = schema.facts.find(f => f.cat === k);
    const s = F ? factScore(F, factValue(p, F.key), factRef(F, places)) : null;
    if (s != null) return s;
    const u = hash(seed + "|" + p.id + "|" + k);
    return u < 0.55 ? null : 1 + 4 * hash("v" + seed + "|" + p.id + "|" + k);
  };
}

function genData(r, { places: nP = r.int(2, 8), ratings: nR = r.int(0, 16), base = r.chance(0.8), ext = true, veto = 0.05 } = {}) {
  const places = [];
  if (base) places.push({ id: "spb", name: "Санкт-Петербург", status: "база", cc: "RUS", ext: {}, facts: r.chance(0.5) ? { rent: { v: r.int(400, 900) }, dinner: { v: r.int(20, 60) }, utilities: { v: r.int(50, 150) }, basket: { v: r.int(20, 60) } } : undefined });
  for (let i = 0; i < nP; i++) {
    const p = { id: "p" + i, name: NAMES[i % NAMES.length] + (i >= NAMES.length ? " " + i : ""), status: r.pick(["кандидат", "кандидат", "кандидат", "финалист", "отсев"]), ext: {} };
    if (p.status === "отсев" && r.chance(0.5)) p.reason = "слишком дорого";
    if (ext && r.chance(0.4)) r.sample(CAT_KEYS, r.int(1, 6)).forEach(k => { p.ext[k] = { res: r.chance(0.6) ? r.score() : null }; if (r.chance(0.3)) p.ext[k].data = r.score(); });
    if (r.chance(0.5)) { p.facts = {}; r.sample(schema.facts.map(f => f.key), r.int(1, 5)).forEach(k => { p.facts[k] = { v: k === "tds" ? r.int(10, 900) : k === "rent" ? r.int(150, 3000) : r.int(5, 300) }; }); }
    places.push(p);
  }
  const ratings = [];
  for (let i = 0; i < nR; i++) ratings.push(genRating(r, places, "r" + i, veto));
  const weights = {};
  PEOPLE.forEach(w => { if (r.chance(0.5)) weights[w] = Object.fromEntries(GROUPS.map(g => [g.key, r.int(0, 100)])); });
  return { places, ratings, weights };
}

function genRating(r, places, id, veto = 0.05, extra = {}) {
  const p = r.pick(places);
  const scores = {};
  r.sample(r.chance(0.5) ? STAR_KEYS : FORM_KEYS, r.int(1, 10)).forEach(k => { scores[k] = r.score(); });
  const conf = {};
  Object.keys(scores).forEach(k => { if (r.chance(0.3)) conf[k] = r.pick(["A", "B", "C", "D"]); });
  const d = r.int(1, 28), m = r.int(1, 12);
  const start = `202${r.int(4, 6)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return Object.assign({
    id, place: p.id, who: r.pick(PEOPLE), start, end: start, season: r.pick(["", "пик", "межсезон", "худший"]), mode: r.pick(["", "отпуск", "удалёнка", "смешанно"]),
    retro: r.chance(0.2), year: r.chance(0.6) ? r.int(0, 10) : null, veto: r.chance(veto) ? "вето-" + id : "", review: r.chance(0.5) ? "отзыв-" + id : "",
    scores, conf, notes: {}, updatedAt: `2026-0${r.int(1, 9)}-1${r.int(0, 9)}T10:00:00.000Z`,
  }, extra);
}

function genWeights(r) {
  const raw = Object.fromEntries(GROUPS.map(g => [g.key, r.chance(0.15) ? 0 : r.int(1, 100)]));
  return r.chance(0.5) ? normalize(GROUPS, raw) : raw;
}

const model = (data, seed) => createModel(schema, data, { autoData: autoFor(seed, data.places) });

/* every number the screens can show for a model, in a form deepEqual can compare */
function snapshot(M, W) {
  const out = {};
  M.places.forEach(p => {
    out[p.id] = {
      cats: CAT_KEYS.map(k => [M.finalCat(p, k), M.usCat(p.id, k), ...SRC.map(s => M.catValue(p, k, s)), ...PEOPLE.map(w => M.confOf(p.id, w, k))]),
      groups: GROUPS.map(g => SRC.map(s => M.groupScore(p, g.key, s))),
      totals: SRC.map(s => M.total(p, W, s)),
      own: M.ownShare(p.id),
      years: PEOPLE.map(w => M.latestYear(p.id, w)),
      flags: CAT_KEYS.map(k => M.catFlags(p, k)),
      vetoed: M.vetoed(p),
    };
  });
  const rk = M.ranking(W);
  out._ranking = { rated: rk.rated.map(x => x.p.id), thin: rk.thin.map(x => x.p.id), unrated: rk.unrated.map(x => x.p.id), base: rk.base.map(p => p.id), out: rk.out.map(x => [x.p.id, x.why]) };
  out._ranks = M.ranksFor(W);
  out._range = M.rankRange(W);
  out._flags = M.allFlags();
  return out;
}

/* the same snapshot with the order of equal-score places and of flags made canonical, numbers rounded */
function canonical(snap) {
  const round = v => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : v);
  const deep = v => (Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : round(v));
  const s = deep(snap);
  ["rated", "thin", "unrated", "base"].forEach(k => s._ranking[k].sort());
  s._ranking.out = s._ranking.out.map(([id, why]) => [id, why.split("; ").sort().join("; ")]).sort((a, b) => a[0].localeCompare(b[0]));
  s._flags = s._flags.map(f => JSON.stringify(f)).sort();
  delete s._ranks;
  delete s._range;
  return s;
}

function firstDiff(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], path + "." + k); if (d) return d; }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const inRange = v => v == null || (Number.isFinite(v) && v >= 1 - 1e-9 && v <= 5 + 1e-9);
const close = (a, b, eps = 1e-9) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= eps);

/* ---------- the app's own rebuild() (blind rating), lifted out of js/app.js; a faithful copy if it cannot be lifted ---------- */

const APP_SRC = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
function liftFunction(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
  }
  return null;
}
let rebuildFactory;
function appModel(data, { me = "", revealed = [], seed = 1 } = {}) {
  if (rebuildFactory === undefined) {
    const rb = liftFunction(APP_SRC, "rebuild"), pn = liftFunction(APP_SRC, "presetNames");
    try { rebuildFactory = rb && pn ? new Function("state", "createModel", "factScore", "factValue", "factRef", "me", "useData", `${rb}\n${pn}\nreturn rebuild;`) : null; } catch { rebuildFactory = null; }
  }
  const view = { places: data.places, ratings: data.ratings, weights: data.weights || {} };
  const autoWorld = autoFor(seed, []);
  const worldOnly = (p, k) => (schema.facts.some(f => f.cat === k && factValue(p, f.key) != null) ? null : autoWorld(p, k));
  if (rebuildFactory) {
    const state = { schema, data: { view: () => view }, revealed: new Set(revealed), world: { autoData: worldOnly }, preset: "Поровну", weights: null };
    rebuildFactory(state, createModel, factScore, factValue, factRef, () => me, () => true)();
    return state.M;
  }
  const auto = (p, k) => { const F = schema.facts.find(f => f.cat === k); const s = F ? factScore(F, factValue(p, F.key), factRef(F, view.places)) : null; return s != null ? s : worldOnly(p, k); };
  const full = createModel(schema, view, { autoData: auto });
  const hid = new Set(), rev = new Set(revealed);
  if (me) full.places.forEach(p => { const rs = full.ratingsOf(p.id); if (rev.has(p.id) || rs.some(x => x.who === me)) return; rs.forEach(x => { if (x.who !== me) hid.add(p.id + "|" + x.who); }); });
  const M = hid.size ? createModel(schema, Object.assign({}, view, { ratings: view.ratings.filter(x => !hid.has(x.place + "|" + x.who)) }), { autoData: auto }) : full;
  M.hidden = (id, w) => hid.has(id + "|" + w);
  M.full = full;
  return M;
}

/* ---------- bundled world data ---------- */

let worldCache = null;
function world() {
  if (worldCache) return worldCache;
  const readJSON = f => JSON.parse(readFileSync(new URL(`../data/world/${f}`, import.meta.url), "utf8"));
  const ind = readJSON("indicators.json"), cities = readJSON("cities.json");
  const w = new World();
  w.indicators = ind.indicators;
  w.countries = ind.countries;
  w.IND = Object.fromEntries(w.indicators.map(i => [i.key, i]));
  w.CIND = Object.fromEntries(CITY_INDICATORS.map(i => [i.key, i]));
  w.cities = cities.cities;
  w.spbCity = w.nearestCity(SPB, 40);
  return (worldCache = w);
}
let simCache = null;
function sim() {
  if (!simCache) { simCache = new Similar(world(), GROUPS); simCache.prepare(); }
  return simCache;
}
const simWeights = r => Object.fromEntries(GROUPS.map(g => [g.key, r.chance(0.2) ? 0 : r.int(1, 100)]));

/* ==================== scoring model: ranges ==================== */

test("in 2000 random data sets every subcategory, group score and total is a real number from 1 to 5 or empty, never NaN or Infinity", () => {
  const bad = [];
  for (let seed = 1; seed <= 2000 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r), M = model(data, seed), W = genWeights(r);
    M.places.forEach(p => {
      CAT_KEYS.forEach(k => { [M.finalCat(p, k), M.usCat(p.id, k), ...SRC.map(s => M.catValue(p, k, s))].forEach(v => { if (!inRange(v)) bad.push(`seed ${seed} ${p.id} ${k}: ${v}`); }); });
      GROUPS.forEach(g => SRC.forEach(s => { const v = M.groupScore(p, g.key, s); if (!inRange(v)) bad.push(`seed ${seed} ${p.id} ${g.key}/${s}: ${v}`); }));
      SRC.forEach(s => { const t = M.total(p, W, s); if (!inRange(t.score) || !(t.coverage >= 0 && t.coverage <= 1)) bad.push(`seed ${seed} ${p.id} total/${s}: ${t.score} cov ${t.coverage}`); });
    });
  }
  assert.deepEqual(bad, []);
});

test("a residents' or data score typed by hand into a place file as text or outside 1–5 never pushes the place outside 1–5 or to NaN", () => {
  const bad = [];
  for (const res of ["4", "4.5", 7, 0, -2, "abc", true, [3]]) {
    const p = { id: "a", name: "Альфа", status: "кандидат", ext: { "к_русским": { res }, "преступность": { data: res } } };
    const M = createModel(schema, { places: [p], ratings: [{ id: "r1", place: "a", who: ME, scores: { "к_русским": 3, "улица": 4 } }] }, { autoData: () => 3 });
    const vals = [M.finalCat(p, "к_русским"), M.extCat(p, "к_русским"), M.finalCat(p, "преступность"), M.groupScore(p, "people", "final"), M.total(p, EQUAL, "final").score];
    if (!vals.every(inRange)) bad.push(`res ${JSON.stringify(res)} → ${vals.map(v => String(v)).join(", ")}`);
  }
  assert.deepEqual(bad, []);
});

test("the share of answered ★ questions is between 0 and 1 and equals answered ★ questions out of all ★ questions", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed), data = genData(r), M = model(data, seed);
    M.places.forEach(p => {
      const share = M.ownShare(p.id);
      assert.ok(share >= 0 && share <= 1, `seed ${seed} ${p.id}: ${share}`);
      const answered = STAR_KEYS.filter(k => M.ratings.some(x => x.place === p.id && x.scores && Number(x.scores[k]) >= 1 && Number(x.scores[k]) <= 5)).length;
      assert.ok(Math.abs(share * STAR_KEYS.length - answered) < 1e-9, `seed ${seed} ${p.id}: share ${share} vs ${answered}/${STAR_KEYS.length}`);
      assert.equal(M.ownEnough(p.id), answered >= STAR_KEYS.length / 2, `seed ${seed} ${p.id}`);
    });
  }
});

test("SPb is exactly 3 on every everyday group and subcategory whatever ratings, figures or residents' words it has, and is never ranked", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed), data = genData(r, { base: true });
    const spb = data.places[0];
    spb.ext = Object.fromEntries(r.sample(CAT_KEYS, 8).map(k => [k, { res: r.score(), data: r.score() }]));
    for (let i = 0; i < 4; i++) data.ratings.push(genRating(r, [spb], "b" + i));
    const M = model(data, seed), W = genWeights(r), b = M.PLACE.spb;
    CATS.filter(c => REL.includes(c.group)).forEach(c => assert.equal(M.finalCat(b, c.key), 3, `seed ${seed} ${c.key}`));
    GROUPS.forEach(g => assert.equal(M.groupScore(b, g.key, "final"), REL.includes(g.key) ? 3 : null, `seed ${seed} ${g.key}`));
    const t = M.total(b, W, "final").score;
    assert.ok(t == null || Math.abs(t - 3) < 1e-12, `seed ${seed}: SPb total ${t}`);
    const rk = M.ranking(W);
    assert.ok(!rk.rated.concat(rk.thin, rk.unrated).some(x => x.p.id === "spb") && rk.base.some(p => p.id === "spb"), `seed ${seed}`);
    assert.equal(M.ranksFor(W).spb, undefined);
  }
});

test("health and safety never score above the lower of our two scores, other groups stay between our two scores", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed), data = genData(r, { ratings: 20 }), M = model(data, seed);
    M.places.forEach(p => CAT_KEYS.forEach(k => {
      const per = PEOPLE.map(w => M.personCat(p.id, w, k)).filter(v => v != null), us = M.usCat(p.id, k);
      if (!per.length) return assert.equal(us, null);
      if (RISKY.has(CAT_GROUP[k])) assert.ok(us <= Math.min(...per) + 1e-12, `seed ${seed} ${p.id} ${k}`);
      else assert.ok(us >= Math.min(...per) - 1e-12 && us <= Math.max(...per) + 1e-12, `seed ${seed} ${p.id} ${k}`);
    }));
  }
});

/* ==================== ranking ==================== */

test("every place appears exactly once: in the ranking, «мало данных», «без оценок», as the base or in «Отсев»", () => {
  for (let seed = 1; seed <= 800; seed++) {
    const r = rng(seed), data = genData(r, { veto: 0.15 }), M = model(data, seed), W = genWeights(r);
    const rk = M.ranking(W);
    const ids = [...rk.rated, ...rk.thin, ...rk.unrated].map(x => x.p.id).concat(rk.base.map(p => p.id), rk.out.map(x => x.p.id));
    assert.deepEqual(ids.slice().sort(), M.places.map(p => p.id).sort(), `seed ${seed}`);
    rk.out.forEach(x => assert.ok(x.why && !/undefined|null/.test(x.why), `seed ${seed}: «${x.why}»`));
  }
});

test("№ positions run 1, 2, 3… without gaps, a higher total never gets a lower position, and the weight range always contains the position", () => {
  for (let seed = 1; seed <= 800; seed++) {
    const r = rng(seed), data = genData(r, { places: r.int(3, 9), ratings: r.int(10, 30) }), M = model(data, seed), W = genWeights(r);
    const ranks = M.ranksFor(W), range = M.rankRange(W);
    const ids = Object.keys(ranks);
    assert.deepEqual(ids.map(id => ranks[id]).sort((a, b) => a - b), ids.map((_, i) => i + 1), `seed ${seed}`);
    const score = id => M.total(M.PLACE[id], W, "final").score;
    ids.forEach(a => ids.forEach(b => { if (score(a) > score(b) + 1e-9) assert.ok(ranks[a] < ranks[b], `seed ${seed}: ${a} ${score(a)} vs ${b} ${score(b)}`); }));
    ids.forEach(id => assert.ok(range[id] && range[id].min <= ranks[id] && ranks[id] <= range[id].max, `seed ${seed} ${id}: №${ranks[id]} outside ${JSON.stringify(range[id])}`));
    const rated = M.ranking(W).rated.filter(x => M.ownEnough(x.p.id)).map(x => x.p.id);
    assert.deepEqual(rated, ids.slice().sort((a, b) => ranks[a] - ranks[b]), `seed ${seed}: list order differs from №`);
  }
});

test("places with the same total keep the same order whatever order the place and rating files are loaded in", () => {
  const flips = [];
  for (let seed = 1; seed <= 400 && flips.length < 3; seed++) {
    const r = rng(seed);
    const data = genData(r, { places: 4, ratings: 0, ext: false, base: true, veto: 0 });
    data.places.forEach(p => { p.status = p.status === "база" ? p.status : "кандидат"; delete p.facts; p.ext = {}; });
    const scores = Object.fromEntries(STAR_KEYS.map(k => [k, r.int(1, 5)]));
    data.places.filter(p => p.status !== "база").forEach((p, i) => data.ratings.push({ id: "t" + i, place: p.id, who: ME, scores: Object.assign({}, scores), season: "", mode: "", retro: false }));
    const order = d => { const M = createModel(schema, d); return M.ranking(EQUAL).rated.map(x => x.p.name).join(" > "); };
    const a = order(data), b = order({ places: r.shuffle(data.places), ratings: r.shuffle(data.ratings), weights: {} });
    if (a !== b) flips.push(`seed ${seed}: ${a}  /  ${b}`);
  }
  assert.deepEqual(flips, [], "places with identical totals change places when files load in another order");
});

/* ==================== monotonicity ==================== */

test("adding a trip that scores a question at or above my current average never lowers my total or our joint total for that place", () => {
  const bad = [];
  for (let seed = 1; seed <= 1500 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(1, 14) }), W = genWeights(r);
    const before = model(data, seed);
    const pairs = [];
    before.places.forEach(p => { if (!before.isBase(p)) PEOPLE.forEach(w => CAT_KEYS.forEach(k => { const v = before.personCat(p.id, w, k); if (v != null && v < 5) pairs.push([p, w, k, v]); })); });
    if (!pairs.length) continue;
    const [p, who, k, v] = r.pick(pairs);
    const add = { id: "new", place: p.id, who, scores: { [k]: Math.min(5, Math.ceil(v) + r.int(0, 2)) }, season: r.pick(["", "пик", "худший"]), mode: r.pick(["", "удалёнка"]), retro: r.chance(0.3) };
    const after = model({ places: data.places, ratings: data.ratings.concat([add]), weights: data.weights }, seed);
    for (const src of [who, "final"]) {
      const a = before.total(p, W, src).score, b = after.total(after.PLACE[p.id], W, src).score;
      if (a != null && b < a - 1e-12) bad.push(`seed ${seed} ${p.id} ${who} ${k}=${add.scores[k]} (was ${v}): ${src} total ${a} → ${b}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("adding a trip that scores a question at or below my current average never raises my total for that place", () => {
  const bad = [];
  for (let seed = 1; seed <= 1500 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(1, 14) }), W = genWeights(r);
    const before = model(data, seed);
    const pairs = [];
    before.places.forEach(p => { if (!before.isBase(p)) PEOPLE.forEach(w => CAT_KEYS.forEach(k => { const v = before.personCat(p.id, w, k); if (v != null && v > 1) pairs.push([p, w, k, v]); })); });
    if (!pairs.length) continue;
    const [p, who, k, v] = r.pick(pairs);
    const add = { id: "new", place: p.id, who, scores: { [k]: Math.max(1, Math.floor(v) - r.int(0, 2)) }, season: r.pick(["", "межсезон"]), mode: r.pick(["", "смешанно"]) };
    const after = model({ places: data.places, ratings: data.ratings.concat([add]), weights: data.weights }, seed);
    for (const src of [who, "final"]) {
      const a = before.total(p, W, src).score, b = after.total(after.PLACE[p.id], W, src).score;
      if (a != null && b > a + 1e-12) bad.push(`seed ${seed} ${p.id} ${who} ${k}=${add.scores[k]} (was ${v}): ${src} total ${a} → ${b}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("editing a saved trip to raise one answer never lowers that place's totals and never moves the place down the ranking", () => {
  const bad = [];
  for (let seed = 1; seed <= 1200 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(2, 16) }), W = genWeights(r);
    const editable = data.ratings.filter(x => !x.veto && Object.values(x.scores).some(v => v < 5) && data.places.find(p => p.id === x.place).status !== "база");
    if (!editable.length) continue;
    const old = r.pick(editable), k = r.pick(Object.keys(old.scores).filter(q => old.scores[q] < 5));
    const edited = Object.assign({}, old, { scores: Object.assign({}, old.scores, { [k]: Math.min(5, old.scores[k] + r.int(1, 3)) }), updatedAt: "2027-01-01T00:00:00.000Z" });
    const before = model(data, seed), after = model({ places: data.places, ratings: data.ratings.concat([edited]), weights: data.weights }, seed);
    const p = before.PLACE[old.place];
    for (const src of [old.who, "final"]) {
      const a = before.total(p, W, src).score, b = after.total(after.PLACE[p.id], W, src).score;
      if (a != null && b < a - 1e-12) bad.push(`seed ${seed} ${p.id} ${src}: ${a} → ${b}`);
    }
    const ra = before.ranksFor(W)[p.id], rb = after.ranksFor(W)[p.id];
    if (ra && rb && rb > ra) bad.push(`seed ${seed} ${p.id}: №${ra} → №${rb}`);
  }
  assert.deepEqual(bad, []);
});

test("a dearer rent, dinner, basket or utilities figure never raises the place's total or its position", () => {
  const bad = [];
  for (let seed = 1; seed <= 800 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(4, 16) }), W = genWeights(r);
    const cands = data.places.filter(p => p.status !== "база");
    const p = r.pick(cands), F = r.pick(MONEY_FACTS);
    const v = r.int(10, 1500);
    const at = x => { const places = data.places.map(q => (q.id === p.id ? Object.assign({}, q, { facts: Object.assign({}, q.facts, { [F.key]: { v: x } }) }) : q)); return model({ places, ratings: data.ratings, weights: data.weights }, seed); };
    const cheap = at(v), dear = at(v * r.float(1.01, 3));
    const a = cheap.total(cheap.PLACE[p.id], W, "final").score, b = dear.total(dear.PLACE[p.id], W, "final").score;
    if (a != null && b > a + 1e-12) bad.push(`seed ${seed} ${F.key}: ${a} → ${b}`);
    const ra = cheap.ranksFor(W)[p.id], rb = dear.ranksFor(W)[p.id];
    if (ra && rb && rb < ra) bad.push(`seed ${seed} ${F.key}: №${ra} → №${rb}`);
  }
  assert.deepEqual(bad, []);
});

test("one person's trips never change the other person's own total, and a trip to one place never changes another place's scores", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed), data = genData(r), W = genWeights(r);
    const before = model(data, seed);
    const add = genRating(r, data.places.filter(p => p.status !== "база"), "new", 0);
    const after = model({ places: data.places, ratings: data.ratings.concat([add]), weights: data.weights }, seed);
    const other = PEOPLE.find(w => w !== add.who);
    before.places.forEach(p => {
      assert.ok(close(before.total(p, W, other).score, after.total(after.PLACE[p.id], W, other).score, 0), `seed ${seed} ${p.id}: ${other}'s total moved`);
      if (p.id !== add.place) GROUPS.forEach(g => assert.equal(after.groupScore(after.PLACE[p.id], g.key, "final"), before.groupScore(p, g.key, "final"), `seed ${seed} ${p.id} ${g.key}`));
    });
  }
});

/* ==================== weights ==================== */

test("multiplying every weight by the same number changes no total, no coverage and no ranking", () => {
  const bad = [];
  for (let seed = 1; seed <= 800 && bad.length < 5; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(4, 20) }), M = model(data, seed), W = genWeights(r);
    const k = r.pick([0.001, 0.37, 3, 1000, 1e6]);
    const W2 = Object.fromEntries(Object.entries(W).map(([g, v]) => [g, v * k]));
    M.places.forEach(p => SRC.forEach(s => {
      const a = M.total(p, W, s), b = M.total(p, W2, s);
      if (!close(a.score, b.score) || Math.abs(a.coverage - b.coverage) > 1e-9) bad.push(`seed ${seed} ${p.id} ${s} ×${k}: ${a.score}/${a.coverage} vs ${b.score}/${b.coverage}`);
    }));
    const n1 = normalize(GROUPS, W), n2 = normalize(GROUPS, W2);
    GROUPS.forEach(g => { if (Math.abs(n1[g.key] - n2[g.key]) > 1e-9) bad.push(`seed ${seed} normalize ${g.key} ×${k}`); });
    const rank = WW => { const rk = M.ranking(WW); return [rk.rated, rk.thin, rk.unrated].map(l => l.map(x => x.p.id).sort().join(",")).join(" | "); };
    if (rank(W) !== rank(W2)) bad.push(`seed ${seed} ×${k}: lists differ`);
  }
  assert.deepEqual(bad, []);
});

test("weights from any weights file come out non-negative and add up to 100, and «Поровну» is 100/11 for every group", () => {
  const r = rng(77);
  const junk = [0, -5, 3, 50, 100, "40", "abc", null, undefined, true, "", 1e-9, 1e6, 1e300, NaN];
  const bad = [];
  for (let i = 0; i < 3000; i++) {
    const w = Object.fromEntries(r.sample(GROUPS, r.int(0, GROUPS.length)).map(g => [g.key, r.pick(junk)]));
    const n = normalize(GROUPS, w), vals = GROUPS.map(g => n[g.key]);
    const sum = vals.reduce((a, b) => a + b, 0);
    if (!vals.every(v => Number.isFinite(v) && v >= 0) || Math.abs(sum - 100) > 1e-6) bad.push(`${JSON.stringify(w)} → ${JSON.stringify(n)}`);
    if (bad.length > 3) break;
  }
  assert.deepEqual(bad, []);
  const M = createModel(schema, { places: [], ratings: [], weights: {} });
  GROUPS.forEach(g => assert.ok(Math.abs(M.presets["Поровну"][g.key] - 100 / GROUPS.length) < 1e-12));
});

test("preset «Поровну» ranks exactly like setting every slider to the same value, and «Оба» without saved weights is «Поровну»", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(4, 20) });
    data.weights = {};
    const M = model(data, seed);
    const same = Object.fromEntries(GROUPS.map(g => [g.key, r.int(1, 100)]));
    Object.keys(same).forEach(k => { same[k] = same.legal; });
    M.places.forEach(p => assert.ok(close(M.total(p, M.presets["Поровну"], "final").score, M.total(p, same, "final").score), `seed ${seed} ${p.id}`));
    const ids = W => M.ranking(W).rated.map(x => [x.p.id, Math.round(x.t.score * 1e9)]);
    assert.deepEqual(ids(M.presets["Поровну"]), ids(same), `seed ${seed}`);
    GROUPS.forEach(g => { assert.ok(Math.abs(M.presets["Оба"][g.key] - M.presets["Поровну"][g.key]) < 1e-12); PEOPLE.forEach(w => assert.equal(M.presets[w][g.key], M.presets["Поровну"][g.key])); });
  }
});

/* ==================== order and deletion ==================== */

test("the order the rating and place files come in never changes any score, flag or which list a place is in", () => {
  const bad = [];
  for (let seed = 1; seed <= 600 && bad.length < 3; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(4, 24) }), W = genWeights(r);
    const a = canonical(snapshot(model(data, seed), W));
    const shuffled = { places: r.shuffle(data.places), ratings: r.shuffle(data.ratings), weights: data.weights };
    const b = canonical(snapshot(model(shuffled, seed), W));
    const d = firstDiff(a, b);
    if (d) bad.push(`seed ${seed}: ${d}`);
  }
  assert.deepEqual(bad, []);
});

test("several trips to one place give the same averaged score and the same red flag whatever order their files are read in", () => {
  const bad = [];
  const p = { id: "a", name: "Альфа", status: "кандидат" };
  const trip = (id, v, extra) => Object.assign({ id, place: "a", who: ME, scores: { "шум": v }, season: "", mode: "", retro: false }, extra);
  const minimal = [trip("t1", 1, { retro: true }), trip("t2", 1, { retro: true }), trip("t3", 2, { retro: true, season: "худший" })];
  const look = rs => { const M = createModel(schema, { places: [p], ratings: rs }); const v = M.personCat("a", ME, "шум"); return `${fmt(v)} ${M.catFlags(p, "шум").map(f => f.sev).join(",") || "no flag"}`; };
  const a = look(minimal), b = look(minimal.slice().reverse());
  if (a !== b) bad.push(`3 trips по памяти scoring 1, 1, 2 (худший сезон): «${a}» in one order, «${b}» in the other`);
  for (let seed = 1; seed <= 3000 && bad.length < 4; seed++) {
    const r = rng(seed);
    const rs = Array.from({ length: r.int(3, 6) }, (_, i) => trip("t" + i, r.int(1, 3), { season: r.pick(["", "пик", "межсезон", "худший"]), mode: r.pick(["", "отпуск", "удалёнка", "смешанно"]), retro: r.chance(0.4) }));
    const want = look(rs);
    for (let k = 0; k < 4; k++) { const got = look(r.shuffle(rs)); if (got !== want) { bad.push(`seed ${seed}: «${want}» vs «${got}»`); break; } }
  }
  assert.deepEqual(bad, []);
});

test("a later edit of a trip wins over the earlier version whatever order the two copies are read in", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(1, 10), veto: 0 }), W = genWeights(r);
    const old = r.pick(data.ratings.length ? data.ratings : [genRating(r, data.places, "x")]);
    const newer = Object.assign({}, old, { scores: Object.fromEntries(Object.keys(old.scores).map(k => [k, r.int(1, 5)])), updatedAt: "2027-05-05T00:00:00.000Z" });
    const only = model({ places: data.places, ratings: data.ratings.filter(x => x !== old).concat([newer]), weights: data.weights }, seed);
    const both1 = model({ places: data.places, ratings: data.ratings.concat([newer]), weights: data.weights }, seed);
    const both2 = model({ places: data.places, ratings: [newer].concat(data.ratings), weights: data.weights }, seed);
    const want = canonical(snapshot(only, W));
    assert.deepEqual(canonical(snapshot(both1, W)), want, `seed ${seed}`);
    assert.deepEqual(canonical(snapshot(both2, W)), want, `seed ${seed}`);
  }
});

test("deleting a trip gives back exactly the scores, flags, ranking and ranges the app showed before that trip was added", () => {
  for (let seed = 1; seed <= 600; seed++) {
    const r = rng(seed), data = genData(r, { veto: 0.1 }), W = genWeights(r);
    const before = snapshot(model(data, seed), W);
    const add = genRating(r, data.places, "added", 0.2);
    const withIt = model({ places: data.places, ratings: data.ratings.concat([add]), weights: data.weights }, seed);
    snapshot(withIt, W);
    const gone = Object.assign({}, add, { deleted: true, updatedAt: "2027-01-01T00:00:00.000Z" });
    const after = snapshot(model({ places: data.places, ratings: data.ratings.concat([gone]), weights: data.weights }, seed), W);
    assert.deepEqual(after, before, `seed ${seed}`);
  }
});

test("a vetoed place leaves the ranking, and deleting the veto trip puts it back exactly where it was", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(6, 20), veto: 0 }), W = genWeights(r);
    const open = data.places.filter(x => x.status !== "база" && x.status !== "отсев");
    if (!open.length) continue;
    const p = r.pick(open);
    const before = model(data, seed);
    const v = genRating(r, [p], "veto", 0, { veto: "сыро и шумно" });
    const vetoed = model({ places: data.places, ratings: data.ratings.concat([v]), weights: data.weights }, seed);
    assert.equal(vetoed.ranksFor(W)[p.id], undefined, `seed ${seed}`);
    assert.ok(vetoed.ranking(W).out.some(x => x.p.id === p.id && /сыро и шумно/.test(x.why)), `seed ${seed}`);
    const undone = model({ places: data.places, ratings: data.ratings.concat([Object.assign({}, v, { deleted: true, updatedAt: "2027-02-02T00:00:00.000Z" })]), weights: data.weights }, seed);
    assert.deepEqual(undone.ranksFor(W), before.ranksFor(W), `seed ${seed}`);
  }
});

/* ==================== blind rating ==================== */

function blindData(r) {
  const data = genData(r, { ratings: 0, veto: 0 });
  const cands = data.places.filter(p => p.status !== "база");
  for (let i = 0; i < r.int(3, 14); i++) {
    const x = genRating(r, cands, "q" + i, 0.15);
    if (x.who === PARTNER) Object.assign(x, { review: "СЕКРЕТ-" + i, veto: x.veto ? "ВЕТО-" + i : "", surprises: "СЮРПРИЗ-" + i, notes: { safety: "ЗАМЕТКА-" + i }, year: 7 });
    data.ratings.push(x);
  }
  return data;
}

test("with me chosen, nothing on any screen shows the partner's scores, review, veto, year or flags for a place I have not rated", () => {
  const leaks = [];
  for (let seed = 1; seed <= 400 && leaks.length < 5; seed++) {
    const r = rng(seed), data = blindData(r), W = genWeights(r);
    const M = appModel(data, { me: ME, seed });
    const hiddenPlaces = M.places.filter(p => !M.isBase(p) && data.ratings.some(x => x.place === p.id && x.who === PARTNER && !x.deleted) && !data.ratings.some(x => x.place === p.id && x.who === ME));
    const secrets = id => data.ratings.filter(x => x.place === id && x.who === PARTNER).flatMap(x => [x.review, x.veto, x.surprises, x.notes.safety]).filter(Boolean);
    const pages = [rankHTML(M, W), placesListHTML(M, W, ""), flagsHTML(M).html, heatHTML(M, W)].join("\n");
    hiddenPlaces.forEach(p => {
      const where = `seed ${seed} ${p.id}`;
      if (JSON.stringify(hiddenWho(M, p.id)) !== JSON.stringify([PARTNER])) leaks.push(`${where}: not marked hidden`);
      if (M.ratingsOf(p.id).some(x => x.who === PARTNER)) leaks.push(`${where}: ratingsOf has partner trips`);
      if (CAT_KEYS.some(k => M.personCat(p.id, PARTNER, k) != null || M.confOf(p.id, PARTNER, k) !== "")) leaks.push(`${where}: partner scores readable`);
      if (M.total(p, W, PARTNER).score != null || M.latestYear(p.id, PARTNER) != null || yearsLine(M, p.id) !== "") leaks.push(`${where}: partner total/year readable`);
      if (M.vetoed(p) || M.allFlags().some(f => f.place === p.id)) leaks.push(`${where}: partner veto or flag shown`);
      const own = [tripsHTML(M, p, true, ME), subtableHTML(M, p, true), radarSVG(M, p)].join("\n");
      secrets(p.id).forEach(s => { if (pages.includes(s) || own.includes(s)) leaks.push(`${where}: «${s}» is on screen`); });
      const without = createModel(schema, { places: data.places, ratings: data.ratings.filter(x => !(x.place === p.id && x.who === PARTNER)), weights: data.weights }, { autoData: (q, k) => M.extCat(q, k, "data") });
      if (!close(M.total(p, W, "final").score, without.total(without.PLACE[p.id], W, "final").score)) leaks.push(`${where}: hidden scores move the total`);
    });
  }
  assert.deepEqual(leaks, []);
});

test("once I rate a place or press «Показать всё равно», the partner's scores there are exactly the full ones", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed), data = blindData(r);
    const partnerOnly = data.places.filter(p => data.ratings.some(x => x.place === p.id && x.who === PARTNER) && !data.ratings.some(x => x.place === p.id && x.who === ME));
    if (!partnerOnly.length) continue;
    const [shown, rated] = [partnerOnly[0], partnerOnly[1]];
    if (rated) data.ratings.push(genRating(r, [rated], "mine", 0, { who: ME }));
    const M = appModel(data, { me: ME, revealed: [shown.id], seed });
    for (const p of [shown, rated].filter(Boolean)) {
      assert.deepEqual(hiddenWho(M, p.id), [], `seed ${seed} ${p.id}`);
      CAT_KEYS.forEach(k => assert.equal(M.personCat(p.id, PARTNER, k), M.full.personCat(p.id, PARTNER, k), `seed ${seed} ${p.id} ${k}`));
    }
  }
});

test("«Ещё N флагов скрыто» counts exactly the partner's flags on places I have not rated", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed), data = blindData(r);
    const M = appModel(data, { me: ME, seed });
    const hiddenIds = new Set(M.places.filter(p => hiddenWho(M, p.id).length).map(p => p.id));
    const want = M.full.allFlags().filter(f => hiddenIds.has(f.place)).length;
    const f = flagsHTML(M).html;
    assert.doesNotMatch(f, /Ещё \d+ флаг/, `seed ${seed}`);
    if (hiddenIds.size) assert.match(f, /появятся после вашей оценки/, `seed ${seed}`);
  }
});

/* ==================== flags ==================== */

test("flags come sorted: red flags first, then disagreements, tourist illusions and underestimates", () => {
  const order = { crit: 0, serious: 1, warn: 2, info: 3 };
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed), data = genData(r, { ratings: r.int(5, 25), veto: 0.1 }), M = model(data, seed);
    const sev = M.allFlags().map(f => order[f.sev]);
    assert.deepEqual(sev, sev.slice().sort((a, b) => a - b), `seed ${seed}`);
    M.allFlags().forEach(f => assert.doesNotMatch(f.head + " " + f.text, /NaN|undefined|null|Infinity/, `seed ${seed}`));
  }
});

test("a red flag appears exactly when a score shown in the table is 1.5 or lower, also for an average of several trips", () => {
  const bad = [];
  for (let seed = 1; seed <= 1500 && bad.length < 4; seed++) {
    const r = rng(seed), data = genData(r, { places: 2, ratings: r.int(4, 12), base: false, ext: false, veto: 0 });
    data.ratings.forEach(x => { x.place = "p0"; });
    const M = model(data, seed), p = M.PLACE.p0;
    CAT_KEYS.forEach(k => PEOPLE.forEach(w => {
      const v = M.personCat("p0", w, k);
      if (v == null) return;
      const shown = Number(fmt(v)), red = M.catFlags(p, k).some(f => f.sev === "crit" && f.text.includes(w));
      if ((shown <= 1.5) !== red) bad.push(`seed ${seed} ${k}: ${w} shown ${fmt(v)} (raw ${v}) — red flag ${red ? "shown" : "missing"}`);
    }));
  }
  assert.deepEqual(bad, [], "the legend says «Красный флаг — чья-то оценка 1.5 и ниже»");
});

test("a disagreement flag appears exactly when our two scores shown in the table are 1.5 or more apart", () => {
  const bad = [];
  for (let seed = 1; seed <= 1500 && bad.length < 4; seed++) {
    const r = rng(seed), data = genData(r, { places: 2, ratings: r.int(4, 12), base: false, ext: false, veto: 0 });
    data.ratings.forEach(x => { x.place = "p0"; });
    const M = model(data, seed), p = M.PLACE.p0;
    CAT_KEYS.forEach(k => {
      const per = PEOPLE.map(w => M.personCat("p0", w, k));
      if (per.some(v => v == null)) return;
      const gap = Math.abs(Number(fmt(per[0])) - Number(fmt(per[1]))), flag = M.catFlags(p, k).some(f => f.sev === "serious");
      if ((gap >= 1.5 - 1e-9) !== flag) bad.push(`seed ${seed} ${k}: shown ${fmt(per[0])} and ${fmt(per[1])} (raw ${per[0]}, ${per[1]}) — flag ${flag ? "shown" : "missing"}`);
    });
  }
  assert.deepEqual(bad, [], "the legend says «Разногласие — наши оценки расходятся на 1.5 балла и больше»");
});

/* ==================== «Цифры места» ==================== */

test("a dearer rent, dinner, basket or utilities figure never scores higher than a cheaper one, every figure scores 1–5, and SPb's own price scores exactly 3", () => {
  const r = rng(11);
  for (let i = 0; i < 5000; i++) {
    const F = r.pick(MONEY_FACTS), ref = r.pick([F.ref, r.int(5, 2000), r.float(0.5, 50)]) || 100;
    const a = r.float(0.01, 20000), b = a * r.float(1, 4);
    const sa = factScore(F, a, ref), sb = factScore(F, b, ref);
    assert.ok(sa >= 1 && sa <= 5 && sb >= 1 && sb <= 5, `${F.key} ${a}/${b} ref ${ref}: ${sa}/${sb}`);
    assert.ok(sb <= sa + 1e-12, `${F.key}: ${b} € scores ${sb}, cheaper ${a} € scores ${sa}`);
    assert.equal(factScore(F, ref, ref), 3);
  }
});

test("harder water never scores higher than softer water, never above SPb's 3, and has no jumps between the steps", () => {
  const tds = FACT("tds"), r = rng(12);
  for (let i = 0; i < 5000; i++) {
    const a = r.float(0.1, 2000), b = a + r.float(0, 500);
    const sa = factScore(tds, a, null), sb = factScore(tds, b, null);
    assert.ok(sa >= 1 && sa <= 3 && sb >= 1 && sb <= 3, `${a}: ${sa}, ${b}: ${sb}`);
    assert.ok(sb <= sa + 1e-12, `${b} ppm scores ${sb}, softer ${a} ppm scores ${sa}`);
  }
  TDS.forEach(([x]) => assert.ok(Math.abs(factScore(tds, x - 1e-6, null) - factScore(tds, x + 1e-6, null)) < 1e-4, `jump at ${x} ppm`));
});

test("an amount written in any usual way (1 050, 1.050, 1,050.5, 1050€, € 1 050, 1 050 евро) is read back as exactly that amount", () => {
  const r = rng(13), bad = [];
  const group = (int, sep) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const styles = [
    (i, d) => i + (d ? "." + d : ""),
    (i, d) => i + (d ? "," + d : ""),
    (i, d) => group(i, " ") + (d ? "," + d : ""),
    (i, d) => group(i, " ") + (d ? "," + d : ""),
    (i, d) => group(i, " ") + (d ? "," + d : ""),
    (i, d) => group(i, ".") + (d ? "," + d : ""),
    (i, d) => group(i, ",") + (d ? "." + d : ""),
    (i, d) => group(i, " ") + (d ? "," + d : "") + " €",
    (i, d) => "€ " + group(i, " ") + (d ? "," + d : ""),
    (i, d) => i + (d ? "." + d : "") + "€",
    (i, d) => group(i, " ") + (d ? "," + d : "") + " евро",
    (i, d) => "EUR " + group(i, ",") + (d ? "." + d : ""),
  ];
  for (let n = 0; n < 4000; n++) {
    const int = String(r.pick([r.int(1, 999), r.int(1000, 99999), r.int(100000, 9999999)]));
    const dec = r.chance(0.5) ? String(r.int(0, 99)).padStart(r.pick([1, 2]), "0") : "";
    const want = Number(int + (dec ? "." + dec : ""));
    const s = r.pick(styles)(int, dec), got = parseAmount(s);
    if (Math.abs(got - want) > 1e-9) bad.push(`«${s}» → ${got}, want ${want}`);
    if (bad.length > 5) break;
  }
  assert.deepEqual(bad, []);
});

test("programmer notations like 1e3, 0x1F or 0b11 in a figure field are not read as amounts", () => {
  const bad = ["1e3", "2E2", "0x1F", "0b11", "0o17"].map(s => [s, parseAmount(s)]).filter(([, v]) => v > 0);
  assert.deepEqual(bad, [], "these are saved as 1000, 200, 31, 3, 15 €");
});

test("two numbers separated by a space (60 70, 12 5) are not glued into one amount", () => {
  const bad = ["60 70", "12 5", "1 2 3", "600 7", "45 50 €"].map(s => [s, parseAmount(s)]).filter(([, v]) => v > 0);
  assert.deepEqual(bad, [], "«60 70» is saved as 6070 €, a rent of «600 7» as 6007 €");
});

test("random text with no single amount in it is never read as a positive amount", () => {
  const r = rng(14), bad = [];
  const parts = ["около", "от", "до", "~", "-", "–", "/", "abc", "руб", "..", "%", "?", "x", "₽₽", "eur eur"];
  for (let i = 0; i < 3000; i++) {
    const s = r.sample(parts, r.int(1, 3)).join(r.pick(["", " "])) + (r.chance(0.5) ? r.int(1, 999) + r.pick(["-", "–", "/", "~"]) + r.int(1, 999) : "");
    const v = parseAmount(s);
    if (v > 0) bad.push(`«${s}» → ${v}`);
    if (bad.length > 5) break;
  }
  assert.deepEqual(bad, []);
});

/* ==================== util ==================== */

test("counts read naturally in Russian for every number from 0 to 200 and from 1000 to 1200", () => {
  const want = n => { const t = n % 100, u = n % 10; return t >= 11 && t <= 14 ? "мест" : u === 1 ? "место" : u >= 2 && u <= 4 ? "места" : "мест"; };
  for (const n of [...Array(201).keys(), ...Array.from({ length: 201 }, (_, i) => 1000 + i)]) assert.equal(plural(n, "место", "места", "мест"), want(n), `${n}`);
});

test("any text from the data repo is shown as the same text: escaping never loses or adds characters and leaves no raw < > \" ' &", () => {
  const r = rng(15), alphabet = ["<", ">", "&", "\"", "'", "a", "я", " ", "&amp;", "&lt;", " ", "😀", "\\", "/", "=", "`"];
  const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, m => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" }[m]));
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: r.int(0, 20) }, () => r.pick(alphabet)).join("");
    const e = esc(s);
    assert.equal(unesc(e), s);
    assert.doesNotMatch(e, /[<>"']|&(?!(amp|lt|gt|quot|#39);)/, `«${s}» → «${e}»`);
  }
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("a place id made from any name is short, lowercase latin with single dashes, and the same name always gives the same id", () => {
  const r = rng(16), alphabet = [..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяABCxyzčćžšđıłøßæœјљњћџ0123456789 -_.,'’()/&😀́"];
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: r.int(0, 60) }, () => r.pick(alphabet)).join("");
    const id = slug(s);
    assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `«${s}» → «${id}»`);
    assert.ok(id.length <= 40, `«${s}» → ${id.length} chars`);
    assert.equal(slug(s), id);
  }
});

test("trip length is the number of calendar days including both ends for any two dates, and empty when the end is before the start", () => {
  const r = rng(17);
  for (let i = 0; i < 3000; i++) {
    const a = Date.UTC(r.int(2015, 2030), r.int(0, 11), r.int(1, 28)), span = r.int(-40, 4000), b = a + span * 86400000;
    const iso = t => new Date(t).toISOString().slice(0, 10);
    const d = daysBetween(iso(a), iso(b));
    assert.equal(d, span + 1 > 0 && span + 1 < 3650 ? span + 1 : null, `${iso(a)} → ${iso(b)}`);
  }
});

test("text on any score colour uses whichever of black or white reads better", () => {
  const r = rng(18);
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = h => { const [x, y, z] = [1, 3, 5].map(i => lin(parseInt(h.slice(i, i + 2), 16))); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
  const contrast = (a, b) => { const x = lum(a) + 0.05, y = lum(b) + 0.05; return Math.max(x, y) / Math.min(x, y); };
  for (let i = 0; i < 3000; i++) {
    const a = "#" + Array.from({ length: 3 }, () => r.int(0, 255).toString(16).padStart(2, "0")).join(""), b = "#" + Array.from({ length: 3 }, () => r.int(0, 255).toString(16).padStart(2, "0")).join("");
    const bg = mixHex(a, b, r.next());
    assert.match(bg, /^#[0-9a-f]{6}$/);
    const ink = inkOn(bg), other = ink === "#ffffff" ? "#000000" : "#ffffff";
    assert.ok(contrast(ink, bg) >= contrast(other, bg) - 1e-9, `${bg}: ${ink}`);
  }
  assert.equal(mixHex("#123456", "#abcdef", 0), "#123456");
  assert.equal(mixHex("#123456", "#abcdef", 1), "#abcdef");
});

test("two scores shown with the same number (say both «3.0») never get opposite colours, one reddish and one greenish", () => {
  refreshPalette();
  const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
  const dist = (a, b) => Math.hypot(...rgb(a).map((v, k) => v - rgb(b)[k]));
  const pole = s => (/--pos/.test(s) ? "pos" : /--neg/.test(s) ? "neg" : "mid");
  const step = dist(scoreHex(4.0), scoreHex(4.1));
  const bad = [];
  for (let k = 10; k <= 50; k++) {
    const lo = k / 10 - 0.04, hi = k / 10 + 0.04;
    if (fmt(lo) !== fmt(hi)) continue;
    if (pole(scoreColor(lo)) !== pole(scoreColor(hi))) bad.push(`list swatch: ${lo} and ${hi} both «${fmt(lo)}» → ${scoreColor(lo)} / ${scoreColor(hi)}`);
    if (dist(scoreHex(lo), scoreHex(hi)) > 3 * step) bad.push(`map pin: ${lo} and ${hi} both «${fmt(lo)}» → ${scoreHex(lo)} / ${scoreHex(hi)}`);
  }
  assert.deepEqual(bad, []);
});

/* ==================== world data ==================== */

const ALL_IND = () => world().indicators.concat(CITY_INDICATORS).filter(i => i.scale);

test("every world indicator scores from 1 to 5 for any value, and a better value never scores worse", () => {
  const r = rng(19), bad = [];
  for (const ind of ALL_IND()) {
    for (let i = 0; i < 1500; i++) {
      const ref = r.chance(0.1) ? null : r.float(-50, 500), a = r.float(-100, 1000), b = a + r.float(0, 300);
      const sa = toScore(ind, a, ref), sb = toScore(ind, b, ref);
      [sa, sb].forEach(s => { if (!(s == null || (s >= 1 && s <= 5))) bad.push(`${ind.key}: ${s}`); });
      if (sa == null || sb == null) continue;
      if (ind.dir > 0 && sb < sa - 1e-12) bad.push(`${ind.key} (more is better): ${a} → ${sa}, ${b} → ${sb}`);
      if (ind.dir < 0 && sb > sa + 1e-12) bad.push(`${ind.key} (less is better): ${a} → ${sa}, ${b} → ${sb}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("on relative world scales a value equal to SPb's or Russia's scores exactly 3, and absolute scales ignore the reference", () => {
  const r = rng(20);
  for (const ind of ALL_IND()) for (let i = 0; i < 300; i++) {
    const x = r.float(0.01, 500);
    if (ind.scale.type === "abs") assert.equal(toScore(ind, x, r.float(0, 100)), toScore(ind, x, null), ind.key);
    else if (ind.dir) assert.equal(toScore(ind, x, x), 3, `${ind.key} at ${x}`);
  }
});

test("every bundled country and city gets a world score from 1 to 5 or none on every indicator, and any point on the map gets a data score from 1 to 5 or none", () => {
  const W = world(), bad = [];
  Object.keys(W.countries).forEach(iso => W.indicators.forEach(ind => { const s = W.countryScore(iso, ind.key); if (!inRange(s)) bad.push(`${iso} ${ind.key}: ${s}`); }));
  W.cities.forEach(c => CITY_INDICATORS.forEach(ind => { const s = W.cityScore(c, ind.key); if (!inRange(s)) bad.push(`${c.en} ${ind.key}: ${s}`); }));
  const r = rng(21), isos = Object.keys(W.countries);
  for (let i = 0; i < 250; i++) {
    const c = r.pick(W.cities), near = r.chance(0.7);
    const p = { id: "x" + i, cc: r.chance(0.8) ? r.pick(isos) : undefined, lat: near ? c.lat + r.float(-0.3, 0.3) : r.float(-60, 70), lon: near ? c.lon + r.float(-0.3, 0.3) : r.float(-180, 180) };
    CAT_KEYS.forEach(k => { const s = W.autoData(p, k); if (!inRange(s)) bad.push(`point ${p.lat},${p.lon} ${p.cc} ${k}: ${s}`); });
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("daylight on 21 December is between 0 and 24 hours and never grows going north", () => {
  const r = rng(22);
  for (let i = 0; i < 3000; i++) {
    const a = r.float(-89, 89), b = Math.min(89, a + r.float(0, 30));
    const da = daylight(a), db = daylight(b);
    assert.ok(da >= 0 && da <= 24 && db >= 0 && db <= 24, `${a}: ${da}, ${b}: ${db}`);
    assert.ok(db <= da + 1e-9, `${a}° → ${da} h, ${b}° → ${db} h`);
  }
});

test("distances between places are never negative, the same both ways, at most half the Earth round, and a detour is never shorter", () => {
  const r = rng(23), pt = () => ({ lat: r.float(-89.9, 89.9), lon: r.float(-180, 180) });
  for (let i = 0; i < 4000; i++) {
    const a = pt(), b = pt(), c = pt();
    const ab = haversine(a, b), ba = haversine(b, a);
    assert.ok(ab >= 0 && ab <= Math.PI * 6371 + 1e-6, `${ab}`);
    assert.ok(Math.abs(ab - ba) < 1e-6);
    assert.ok(haversine(a, a) < 1e-9);
    assert.ok(ab <= haversine(a, c) + haversine(c, b) + 1e-6, "triangle");
  }
});

/* ==================== similar places ==================== */

test("how alike two cities are is the same both ways, between 0 and 100 %, and a city is 100 % like itself, for any weights", () => {
  const S = sim(), r = rng(24), W0 = world(), bad = [];
  for (let i = 0; i < 1500; i++) {
    const W = simWeights(r);
    const ca = r.pick(W0.cities), cb = r.pick(W0.cities);
    const a = S.profile({ cc: ca.cc, city: ca }), b = S.profile({ cc: cb.cc, city: cb });
    const ab = S.distance(a, b, W), ba = S.distance(b, a, W), aa = S.distance(a, a, W);
    if ((ab == null) !== (ba == null) || (ab && Math.abs(ab.d - ba.d) > 1e-12)) bad.push(`${ca.en}↔${cb.en}: ${ab && ab.d} vs ${ba && ba.d}`);
    if (ab && !(ab.d >= 0 && ab.d <= 1 && ab.cov > 0 && ab.cov <= 1 + 1e-12)) bad.push(`${ca.en}↔${cb.en}: d ${ab.d} cov ${ab.cov}`);
    if (aa && aa.d !== 0) bad.push(`${ca.en} to itself: ${aa.d}`);
    if (bad.length > 4) break;
  }
  assert.deepEqual(bad, []);
});

test("multiplying all weights by the same number does not change how alike two cities or two countries are", () => {
  const S = sim(), r = rng(25), W0 = world(), isos = Object.keys(S.countryVec);
  for (let i = 0; i < 800; i++) {
    const W = simWeights(r), k = r.pick([0.01, 2.5, 1000]);
    const Wk = Object.fromEntries(Object.entries(W).map(([g, v]) => [g, v * k]));
    const ca = r.pick(W0.cities), cb = r.pick(W0.cities);
    const a = S.profile({ cc: ca.cc, city: ca }), b = S.profile({ cc: cb.cc, city: cb });
    const x = S.distance(a, b, W), y = S.distance(a, b, Wk);
    assert.ok((x == null && y == null) || Math.abs(x.d - y.d) < 1e-9, `${ca.en}↔${cb.en} ×${k}`);
    const ia = S.profile({ cc: r.pick(isos) }), ib = S.profile({ cc: r.pick(isos) });
    const u = S.distance(ia, ib, W, 0), v = S.distance(ia, ib, Wk, 0), vb = S.distance(ib, ia, W, 0);
    assert.ok((u == null && v == null) || Math.abs(u.d - v.d) < 1e-9, `countries ×${k}`);
    assert.ok((u == null && vb == null) || Math.abs(u.d - vb.d) < 1e-12, "countries both ways");
  }
});

test("similar-city lists go from most to least alike with whole percentages 0–100 and never list the place itself", () => {
  const S = sim(), r = rng(26), W0 = world();
  for (let i = 0; i < 12; i++) {
    const c = r.pick(W0.cities), W = simWeights(r);
    const list = S.similarCities({ cc: c.cc, city: c, lat: c.lat, lon: c.lon }, W, { k: 15 });
    list.forEach(o => { assert.ok(Number.isInteger(o.pct) && o.pct >= 0 && o.pct <= 100, `${o.city.en}: ${o.pct}`); assert.notEqual(o.city.id, c.id); });
    list.forEach((o, j) => { if (j) assert.ok(o.r.d >= list[j - 1].r.d, `${c.en}: list not sorted`); });
    const split = S.similarSplit({ cc: c.cc, city: c, lat: c.lat, lon: c.lon }, W);
    split.home.forEach(o => assert.equal(o.city.cc, c.cc));
    split.abroad.forEach(o => assert.notEqual(o.city.cc, c.cc));
  }
});

test("the guess for a place nobody has rated stays within 1–5 with a confidence between 0 and 1, whatever the rated places", () => {
  const S = sim(), r = rng(27), W0 = world();
  for (let i = 0; i < 40; i++) {
    const W = simWeights(r);
    const rated = Array.from({ length: r.int(3, 8) }, (_, j) => { const c = r.pick(W0.cities); return { cc: c.cc, city: c, score: r.float(1, 5), name: "м" + j }; });
    const f = S.predictor(rated, W);
    if (!f) continue;
    for (let j = 0; j < 30; j++) {
      const c = r.pick(W0.cities), g = f({ cc: c.cc, city: c });
      if (g) { assert.ok(g.score >= 1 && g.score <= 5, `${g.score}`); assert.ok(g.conf >= 0.3 && g.conf <= 1, `${g.conf}`); }
    }
  }
});
