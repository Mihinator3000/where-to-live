import "./helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModel, normalize, fmt } from "../js/calc.js";
import { plural, esc, slug, daysBetween, scoreHex, heatHex, inkOn, refreshPalette, pal, todayISO } from "../js/util.js";
import { toScore, CITY_INDICATORS, World, SPB } from "../js/world.js";
import { Similar } from "../js/similar.js";
import { datesRu } from "../js/form.js";
import { rankHTML, placesListHTML, flagsHTML, heatHTML } from "../js/views.js";
import { makeRemote } from "./helpers/remote.mjs";
import { serialize, GitHubStore } from "../js/store.js";
import { Data } from "../js/data.js";

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
const [ME, PARTNER] = schema.people;
const STARS = schema.cats.filter(c => c.star).map(c => c.key);
const EQUAL = normalize(schema.groups, {});
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" };
const text = html => html.replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, m => ENT[m]).replace(/\s+/g, " ").trim();

const place = (id, name, extra = {}) => Object.assign({ id, name, status: "кандидат", ext: {} }, extra);
let rid = 0;
const rating = (placeId, who, scores, extra = {}) => Object.assign({ id: "e" + (++rid), place: placeId, who, start: "2026-08-01", end: "2026-08-14", season: "", mode: "", retro: false, year: null, veto: "", review: "", scores, conf: {}, notes: {} }, extra);
const stars = (v = 4, keys = STARS) => Object.fromEntries(keys.map(k => [k, v]));

/* ---------- palette: read the real colours from the stylesheet ---------- */

const CSS = readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
function cssBlock(selector) {
  const i = CSS.indexOf(selector + " {");
  assert.ok(i >= 0, `${selector} block not found in css/app.css`);
  const body = CSS.slice(CSS.indexOf("{", i) + 1, CSS.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
const LIGHT = cssBlock(":root");
const DARK = Object.assign({}, LIGHT, cssBlock(':root[data-theme="dark"]'));
let cssVars = LIGHT;
globalThis.document = globalThis.document || { documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: k => cssVars[k.replace(/^--/, "")] || "" });
function usePalette(vars) { cssVars = vars; refreshPalette(); }

const hex2rgb = h => { const s = h.replace("#", ""); const f = s.length === 3 ? s.split("").map(c => c + c).join("") : s; return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16)); };
const channel = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = h => { const [r, g, b] = hex2rgb(h).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = luminance(a) + 0.05, y = luminance(b) + 0.05; return Math.max(x, y) / Math.min(x, y); };

/* ---------- «Цифры места» helpers: from a pure module if there is one, else lifted out of app.js ---------- */

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
const liftConst = (src, name) => (src.match(new RegExp(`const ${name} = [^;]+;`)) || [null])[0];
let factsCache = null;
async function facts() {
  if (factsCache) return factsCache;
  try {
    const m = await import(new URL("../js/facts.js", import.meta.url));
    if (["parseAmount", "factScore", "factRef", "factValue"].every(n => typeof m[n] === "function")) return (factsCache = m);
  } catch {}
  const parts = [liftConst(APP_SRC, "MONEY_STEP"), liftConst(APP_SRC, "TDS"), liftFunction(APP_SRC, "factValue"), liftFunction(APP_SRC, "factRef"), liftFunction(APP_SRC, "factScore"), liftFunction(APP_SRC, "parseAmount")];
  assert.ok(parts.every(Boolean), "parseAmount / factValue / factRef / factScore not found in js/facts.js or js/app.js");
  return (factsCache = new Function(parts.join("\n") + "\nreturn { parseAmount, factValue, factRef, factScore };")());
}
const FACT = key => schema.facts.find(f => f.key === key);

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
const cityByEn = en => world().cities.find(c => c.en === en);
async function offlineWorld() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    const w = new World();
    await w.load();
    await w.loadCities();
    return w;
  } finally { globalThis.fetch = real; }
}

/* ==================== util ==================== */

test("counts read naturally in Russian: 1 место, 2 места, 5 мест, 11 мест, 21 место, 111 мест", () => {
  const p = n => `${n} ${plural(n, "место", "места", "мест")}`;
  assert.deepEqual([0, 1, 2, 5, 11, 12, 21, 22, 25, 111].map(p), ["0 мест", "1 место", "2 места", "5 мест", "11 мест", "12 мест", "21 место", "22 места", "25 мест", "111 мест"]);
  assert.equal(plural(14, "оценка", "оценки", "оценок"), "оценок");
  assert.equal(plural(101, "оценка", "оценки", "оценок"), "оценка");
  assert.equal(plural(1004, "оценка", "оценки", "оценок"), "оценки");
});

test("text from the data repo is shown as text: all five HTML characters are escaped, nothing is shown as «null» or «undefined»", () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(3.5), "3.5");
});

test("a new place gets a readable id from its Russian or accented name, and an empty name still gives an id", () => {
  assert.equal(slug("Санкт-Петербург"), "sankt-peterburg");
  assert.equal(slug("Херцег-Нови"), "hertseg-novi");
  assert.equal(slug("Йошкар-Ола"), "yoshkar-ola");
  assert.equal(slug("Kraków"), "krakow");
  assert.equal(slug("Žabljak"), "zabljak");
  assert.equal(slug("İstanbul"), "istanbul");
  assert.equal(slug("  Порту!!! "), "portu");
  assert.equal(slug(""), "place");
  assert.equal(slug(null), "place");
});

test("a place id made from a Balkan, Turkish or Polish name keeps all its letters instead of dropping đ, ı, ł, љ, ß", () => {
  const cases = [["Đurđevac", /^dj?urdj?evac$/], ["Ђурђевац", /^dj?urdj?eva(ts|c)$/], ["Љубљана", /^ljubljana$/], ["Ayvalık", /^ayvalik$/], ["Łódź", /^lodz$/], ["Straße", /^strasse$/], ["Ørsted", /^oe?rsted$/]];
  const bad = cases.map(([name, re]) => [name, slug(name), re]).filter(([, s, re]) => !re.test(s));
  assert.deepEqual(bad.map(([n, s]) => `${n} → ${s}`), [], "letters were dropped from the id");
});

test("a place id cut to 40 characters never ends with a dash", () => {
  for (const name of ["Сан-Себастьян-де-лос-Рейес-и-Санта-Мария-де-ла-Асунсьон", "a".repeat(39) + " b", "Нови Сад Нови Сад Нови Сад Нови Сад Нови Сад"]) {
    const s = slug(name);
    assert.ok(s.length <= 40, s);
    assert.doesNotMatch(s, /^-|-$/, `«${name}» → «${s}»`);
  }
});

test("trip length is the same whatever the phone's time zone, across clock changes, month ends and leap years", () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ["Europe/Moscow", "Europe/Podgorica", "America/New_York", "Asia/Tbilisi", "UTC"]) {
      process.env.TZ = zone;
      assert.equal(daysBetween("2026-03-28", "2026-03-30"), 3, zone + " spring clock change");
      assert.equal(daysBetween("2026-10-24", "2026-10-26"), 3, zone + " autumn clock change");
      assert.equal(daysBetween("2026-03-07", "2026-03-09"), 3, zone + " US clock change");
      assert.equal(daysBetween("2027-02-28", "2027-03-01"), 2, zone + " February");
      assert.equal(daysBetween("2028-02-28", "2028-03-01"), 3, zone + " leap February");
      assert.equal(daysBetween("2026-01-31", "2026-02-01"), 2, zone + " month end");
      assert.equal(daysBetween("2026-12-31", "2027-01-01"), 2, zone + " new year");
    }
  } finally {
    if (tz == null) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test("every score colour from 1 to 5 keeps readable text on it (contrast 4.5 or more) in the light and the dark theme", () => {
  const low = [];
  for (const [name, vars] of [["light", LIGHT], ["dark", DARK]]) {
    usePalette(vars);
    for (let i = 10; i <= 50; i++) {
      const v = i / 10;
      for (const [kind, bg] of [["score", scoreHex(v)], ["heat", heatHex(v)]]) {
        const c = contrast(bg, inkOn(bg));
        if (c < 4.5) low.push(`${name} ${kind} ${v}: ${bg} → ${c.toFixed(2)}`);
      }
    }
  }
  usePalette(LIGHT);
  assert.deepEqual(low, []);
});

test("a value that is not a number is shown as «—» in the no-data colour, never as «NaN» or an invalid colour", () => {
  usePalette(LIGHT);
  assert.equal(fmt(null), "—");
  assert.equal(fmt(NaN), "—");
  assert.equal(fmt(Infinity), "—");
  assert.equal(scoreHex(NaN), pal().none);
  assert.match(scoreHex(3.3), /^#[0-9a-f]{6}$/);
});

test("a trip date in a form the app does not expect never shows up as «undefined» or «NaN»", () => {
  for (const [a, b] of [["2026-13-45"], ["26.08.2026", "30.08.2026"], ["2026-08"], ["2026-08-01", "не помню"]]) {
    const s = datesRu(a, b);
    assert.doesNotMatch(s, /undefined|NaN/, `datesRu(${a}, ${b}) → «${s}»`);
    assert.ok(s.trim(), `datesRu(${a}, ${b}) gave nothing`);
  }
});

/* ==================== «Цифры места» ==================== */

test("the «Цифры места» helpers (parseAmount, factValue, factRef, factScore) live in a pure module that loads without a browser", async () => {
  let m = null, err = null;
  try { m = await import(new URL("../js/facts.js", import.meta.url)); } catch (e) { err = e; }
  assert.ok(m, "js/facts.js cannot be imported: " + (err && err.message));
  for (const n of ["parseAmount", "factValue", "factRef", "factScore"]) assert.equal(typeof m[n], "function", n + " is not exported");
});

test("figures typed with any usual thousands separator or currency sign are read as the whole amount", async () => {
  const { parseAmount } = await facts();
  const cases = { "640": 640, "1 200": 1200, "1 200": 1200, "1 200": 1200, "1 234 567": 1234567, "1.000.000": 1000000, "1.200,50": 1200.5, "1,200.50": 1200.5, "1 200,50": 1200.5, "36,5": 36.5, "€640": 640, "640 €": 640, "$1,200": 1200, "640 ₽": 640, "+640": 640 };
  for (const [raw, want] of Object.entries(cases)) assert.equal(parseAmount(raw), want, `«${raw}»`);
});

test("a figure typed with the word «евро» or «EUR» is read as the number, not rejected as «не число»", async () => {
  const { parseAmount } = await facts();
  for (const raw of ["640 евро", "640 EUR", "640 eur", "640евро"]) assert.equal(parseAmount(raw), 640, `«${raw}»`);
});

test("text that is not one amount (a range, «около», «Infinity», letters) is never read as a usable positive number", async () => {
  const { parseAmount } = await facts();
  for (const raw of ["~640", "640-700", "от 640", "Infinity", "abc", "-640", "−640"]) {
    const v = parseAmount(raw);
    assert.ok(!(v > 0), `«${raw}» was read as ${v}, and the form saves anything above 0`);
  }
});

test("a figure saved as 0, negative, text or infinity gives no score badge instead of 5.0, NaN or 1.0", async () => {
  const { factScore } = await facts();
  const rent = FACT("rent"), tds = FACT("tds");
  for (const x of [0, -5, NaN, Infinity, Number("abc")]) {
    assert.equal(factScore(rent, x, 550), null, `rent ${x}`);
    assert.equal(factScore(tds, x, null), null, `tds ${x}`);
  }
  assert.ok(Math.abs(factScore(rent, 825, 550) - 2) < 1e-9, "a real figure still scores");
});

test("SPb's figure saved as text in its file still works as the reference, and a broken one falls back to the default", async () => {
  const { factRef, factScore } = await facts();
  const rent = FACT("rent");
  const base = v => ({ id: "spb", status: "база", facts: { rent: { v } } });
  assert.equal(Number(factRef(rent, [base("700")])), 700);
  assert.equal(factRef(rent, [base("abc")]), rent.ref);
  assert.equal(factRef(rent, [base(0)]), rent.ref);
  assert.equal(factRef(rent, []), rent.ref);
  assert.ok(Math.abs(factScore(rent, 1050, factRef(rent, [base("700")])) - 2) < 1e-9);
});

/* ==================== scoring model with odd data ==================== */

test("a score outside 1–5 in a rating file (a typo like 45, or 0, 6, −3) never pushes a place outside 1–5", () => {
  for (const bad of [45, 0, 6, -3, 5.5]) {
    const a = place("alpha", "Альфа");
    const M = createModel(schema, { places: [a], ratings: [rating("alpha", ME, stars(bad))] });
    const s = M.total(a, EQUAL, "final").score;
    assert.ok(s == null || (s >= 1 && s <= 5), `score ${bad} gave a total of ${s}`);
    const one = M.personCat("alpha", ME, STARS[0]);
    assert.ok(one == null || (one >= 1 && one <= 5), `score ${bad} gave ${one} on one question`);
  }
});

test("a yes/no, blank, list or object value in place of a score is not read as a score", () => {
  const a = place("alpha", "Альфа");
  const M = createModel(schema, { places: [a], ratings: [rating("alpha", ME, { [STARS[0]]: true, [STARS[1]]: false, [STARS[2]]: " ", [STARS[3]]: [4], [STARS[4]]: {} })] });
  const got = STARS.slice(0, 5).map(k => [k, M.personCat("alpha", ME, k)]).filter(([, v]) => v != null);
  assert.deepEqual(got, [], "these values were counted as scores");
});

test("a score saved as a numeric string like \"4\" or \"4.5\" still counts", () => {
  const a = place("alpha", "Альфа");
  const M = createModel(schema, { places: [a], ratings: [rating("alpha", ME, { [STARS[0]]: "4", [STARS[1]]: "4.5" })] });
  assert.equal(M.personCat("alpha", ME, STARS[0]), 4);
  assert.equal(M.personCat("alpha", ME, STARS[1]), 4.5);
});

test("a rating signed by someone who is neither of us does not veto the place, add red flags or count as our rating", () => {
  const a = place("alpha", "Альфа");
  const M = createModel(schema, { places: [a], ratings: [
    rating("alpha", ME, stars(4)),
    rating("alpha", "Петя", stars(1), { veto: "не понравилось" }),
  ] });
  assert.equal(M.vetoed(a), false, "a stranger's veto removed the place");
  assert.deepEqual(M.candidates().map(p => p.id), ["alpha"]);
  assert.equal(M.ratingsOf("alpha").length, 1, "the stranger's rating is counted among ours");
  assert.deepEqual(M.allFlags().filter(f => /Петя/.test(f.head + f.text)).map(f => f.head), []);
});

test("a rating without an author or a place is ignored instead of breaking the model", () => {
  const a = place("alpha", "Альфа");
  const M = createModel(schema, { places: [a], ratings: [rating("alpha", "", stars(1)), rating("", ME, stars(1)), Object.assign(rating("alpha", ME, null), { scores: null })] });
  assert.equal(M.personCat("alpha", ME, STARS[0]), null);
  assert.doesNotThrow(() => { M.ranking(EQUAL); M.allFlags(); rankHTML(M, EQUAL); });
});

test("two place files with the same id show that place once in the ranking and the list", () => {
  usePalette(LIGHT);
  const M = createModel(schema, { places: [place("alpha", "Альфа"), place("alpha", "Альфа (копия)")], ratings: [rating("alpha", ME, stars(4))] });
  const r = M.ranking(EQUAL);
  const rows = r.rated.concat(r.thin, r.unrated).filter(x => x.p.id === "alpha");
  assert.equal(rows.length, 1, "the same place appears twice in the ranking");
  assert.equal((placesListHTML(M, EQUAL, "").match(/class="prow"/g) || []).length, 1, "the same place appears twice in «Места»");
});

test("a rating file duplicated under the same id counts once, not as an average of two versions", () => {
  const a = place("alpha", "Альфа");
  const old = rating("alpha", ME, { [STARS[0]]: 2 }, { id: "dup", updatedAt: "2026-08-01T00:00:00Z" });
  const now = rating("alpha", ME, { [STARS[0]]: 4 }, { id: "dup", updatedAt: "2026-09-01T00:00:00Z" });
  const M = createModel(schema, { places: [a], ratings: [old, now] });
  assert.equal(M.ratingsOf("alpha").length, 1);
  assert.ok([2, 4].includes(M.personCat("alpha", ME, STARS[0])), `got ${M.personCat("alpha", ME, STARS[0])}`);
});

test("a place marked deleted leaves the ranking, the list, the heat map and the flags together with its ratings", () => {
  usePalette(LIGHT);
  const gone = place("gone", "Удалённое", { deleted: true });
  const M = createModel(schema, { places: [place("alpha", "Альфа"), gone], ratings: [rating("alpha", ME, stars(4)), rating("gone", ME, stars(1), { veto: "плохо" })] });
  const all = rankHTML(M, EQUAL) + placesListHTML(M, EQUAL, "") + heatHTML(M, EQUAL) + flagsHTML(M).html;
  assert.doesNotMatch(text(all), /Удалённое/);
  assert.equal(M.ratings.length, 1);
});

test("a place file without a name never shows «undefined» in the ranking, the flags or the list", () => {
  usePalette(LIGHT);
  const nameless = { id: "noname", status: "кандидат", ext: {} };
  const M = createModel(schema, { places: [nameless, place("alpha", "Альфа")], ratings: [rating("noname", ME, stars(1)), rating("alpha", ME, stars(4))] });
  let html = "";
  assert.doesNotThrow(() => { html = rankHTML(M, EQUAL) + flagsHTML(M).html + placesListHTML(M, EQUAL, ""); }, "a nameless place breaks the screens");
  assert.doesNotMatch(text(html), /undefined/);
  assert.ok(M.allFlags().length > 0);
  assert.ok(M.allFlags().every(f => !/undefined/.test(f.head)), M.allFlags().map(f => f.head).join("; "));
});

test("with no data at all every screen helper still works and says there is nothing yet", () => {
  usePalette(LIGHT);
  const M = createModel(schema, {});
  const r = M.ranking(EQUAL);
  assert.deepEqual([r.rated.length, r.thin.length, r.unrated.length, r.base.length, r.out.length], [0, 0, 0, 0, 0]);
  assert.match(text(rankHTML(M, EQUAL)), /Своих оценок пока нет/);
  assert.match(text(placesListHTML(M, EQUAL, "")), /Мест пока нет/);
  assert.match(text(flagsHTML(M).html), /Флагов нет/);
});

test("100 places with 300 ratings: the model, ranking and all lists are ready in well under a second and a half", () => {
  usePalette(LIGHT);
  const keys = schema.cats.map(c => c.key);
  const places = Array.from({ length: 100 }, (_, i) => place("p" + i, "Место " + i));
  const ratings = Array.from({ length: 300 }, (_, i) => rating("p" + (i % 100), i % 2 ? PARTNER : ME, Object.fromEntries(keys.filter((_, j) => (i + j) % 3).map((k, j) => [k, 1 + ((i + j) % 9) / 2])), { start: `2026-0${1 + (i % 9)}-01`, year: i % 11 }));
  const t = performance.now();
  const M = createModel(schema, { places, ratings, weights: {} }, { autoData: () => 3 });
  const r = M.ranking(EQUAL);
  const html = rankHTML(M, EQUAL) + heatHTML(M, EQUAL) + placesListHTML(M, EQUAL, "") + flagsHTML(M).html;
  const ms = performance.now() - t;
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  assert.equal(r.rated.length + r.thin.length + r.unrated.length, 100);
  for (let i = 0; i < 100; i += 17) assert.ok(text(html).includes("Место " + i + " "), "Место " + i + " is missing");
});

/* ==================== weights ==================== */

test("a weights file of someone who is neither of us is ignored: no extra preset and no «own weights»", () => {
  const M = createModel(schema, { places: [place("alpha", "Альфа")], ratings: [], weights: { "Петя": { money: 90, legal: 10 } } });
  assert.deepEqual(Object.keys(M.presets).sort(), ["Вика", "Михаил", "Оба", "Поровну"].sort());
  assert.equal(M.hasOwnWeights, false);
  assert.deepEqual(M.presets[ME], EQUAL);
});

test("weights saved as numeric strings work like numbers", () => {
  const n = normalize(schema.groups, { money: "30", safety: "10" });
  assert.equal(Math.round(n.money), 75);
  assert.equal(Math.round(n.safety), 25);
});

test("a negative weight in a weights file counts as zero instead of showing −50 and 150 on the sliders", () => {
  const n = normalize(schema.groups, { money: -50, safety: 150 });
  assert.equal(n.money, 0);
  assert.equal(Math.round(n.safety), 100);
  assert.ok(Object.values(n).every(v => v >= 0 && v <= 100), JSON.stringify(n));
});

/* ==================== world data and similar places ==================== */

test("a world score is never NaN: a missing, text or broken SPb reference gives no score", () => {
  const lin = { dir: 1, scale: { type: "lin", step: 3 } }, log = { dir: -1, scale: { type: "log", step: Math.log(1.5) } };
  for (const ref of [NaN, undefined, null]) {
    for (const ind of [lin, log]) {
      const s = toScore(ind, 20, ref);
      assert.ok(s === null || Number.isFinite(s), `ref ${ref}: ${s}`);
    }
  }
  assert.equal(toScore({ dir: 1 }, 20, 20), null, "no scale");
  assert.equal(toScore({ dir: 0, scale: { type: "lin", step: 3 } }, 20, 20), null, "info only");
  assert.equal(toScore(lin, "20", 20), null, "a value saved as text is not scored");
});

test("when the world files could not be loaded, or for a place with no point and an unknown country, the data column is empty, not 0", async () => {
  const empty = await offlineWorld();
  assert.equal(empty.autoData({ cc: "MNE", lat: 42.29, lon: 18.84 }, "свет"), null);
  assert.equal(empty.autoData({ cc: "MNE", lat: 42.29, lon: 18.84 }, "преступность"), null);
  const w = world();
  assert.equal(w.autoData({ cc: "XXX" }, "свет"), null);
  assert.equal(w.autoData({}, "преступность"), null);
});

test("a city with no climate data is not shown as 100% similar to every city of its country", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  const budva = cityByEn("Budva");
  const bare = { id: 990001, n: "Без климата", cc: budva.cc, lat: budva.lat + 0.5, lon: budva.lon + 0.5 };
  const list = sim.similarCities({ cc: bare.cc, city: bare, lat: bare.lat, lon: bare.lon }, EQUAL, { k: 8 });
  list.forEach(o => assert.ok(Number.isInteger(o.pct) && o.pct >= 0 && o.pct <= 100, `${o.city.en}: ${o.pct}`));
  assert.deepEqual(list.filter(o => o.pct >= 100).map(o => o.city.en), [], "100% similar on the country alone");
});

test("a place known only by its country (no coordinates) does not list cities of that country as 100% similar", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  const sp = sim.similarSplit({ cc: "MNE", city: null, lat: undefined, lon: undefined }, EQUAL);
  assert.deepEqual(sp.home.filter(o => o.pct >= 100).map(o => `${o.city.en} ${o.pct}%`), []);
});

test("without the world files similar lists are empty and the predictor stays silent rather than failing", async () => {
  const empty = await offlineWorld();
  const sim = new Similar(empty, schema.groups);
  assert.deepEqual(sim.similarCities({ cc: "MNE", city: null }, EQUAL, { k: 3 }), []);
  assert.deepEqual(sim.similarCountries("MNE", EQUAL, 3), []);
  assert.equal(sim.predictor([{ cc: "MNE", score: 4 }, { cc: "SRB", score: 4 }, { cc: "PRT", score: 4 }], EQUAL), null);
  const w = world(), sim2 = new Similar(w, schema.groups);
  assert.equal(sim2.predictor([{ cc: null, city: null, score: 4 }, { cc: null, city: null, score: 5 }, { cc: null, city: null, score: 3 }], EQUAL), null);
});

/* ---------- the same field edited on two phones, with a background check in between ---------- */

function twoPhones(doc) {
  localStorage.clear();
  localStorage.setItem("wtl:token", JSON.stringify("tok"));
  const remote = makeRemote({ [`places/${doc.id}.json`]: serialize(doc) });
  const saved = globalThis.fetch;
  globalThis.fetch = remote.fetchImpl;
  const other = new GitHubStore({ owner: "x", repo: "y", token: "t", fetchImpl: remote.fetchImpl });
  const otherEdits = async patch => { await other.load(); const cur = JSON.parse(remote.state.files[`places/${doc.id}.json`]); await other.commit([{ path: `places/${doc.id}.json`, content: serialize(Object.assign(cur, patch)), baseOid: other.oids[`places/${doc.id}.json`] }], "other phone"); };
  return { remote, otherEdits, read: () => JSON.parse(remote.state.files[`places/${doc.id}.json`]), done: () => { globalThis.fetch = saved; } };
}

test("a card field the other phone changed is not overwritten silently, even after the app has refreshed in the background", async () => {
  const P0 = { id: "porto", name: "Порту", status: "кандидат", questions: "Сырость?" };
  const ph = twoPhones(P0);
  try {
    const a = new Data();
    await a.refresh();
    const seen = { questions: "Сырость?" };
    await ph.otherEdits({ questions: "Сырость?\nВопрос Вики" });
    await a.poll();
    assert.equal(a.docOf("places/porto.json").questions, "Сырость?\nВопрос Вики", "fixture: the background check brought the other phone's text");
    await assert.rejects(a.updatePlace("porto", { questions: "Мой вопрос" }, { base: seen }), e => e.code === "clash" && JSON.stringify(e.theirs) === JSON.stringify([["questions", "Сырость?\nВопрос Вики"]]));
    assert.equal(ph.read().questions, "Сырость?\nВопрос Вики", "the other phone's question is still there");
    const { r } = await a.updatePlace("porto", { questions: "Мой вопрос" }, { base: { questions: "Сырость?\nВопрос Вики" } });
    assert.equal(r, "sent", "after seeing the other value, the second save writes mine");
    assert.equal(ph.read().questions, "Мой вопрос");
  } finally { ph.done(); }
});

test("a numbers field changed on the other phone is reported with its value, while other fields still merge", async () => {
  const P0 = { id: "budva", name: "Будва", status: "кандидат", questions: "", facts: { rent: { v: 700, src: "", at: "2026-09-01" } } };
  const ph = twoPhones(P0);
  try {
    const a = new Data();
    await a.refresh();
    await ph.otherEdits({ facts: { rent: { v: 1150, src: "агентство", at: "2026-10-29" } }, questions: "Школа?" });
    await a.refresh();
    const err = await a.updatePlace("budva", { "facts.rent": { v: 800, src: "", at: "2026-10-30" } }, { base: { "facts.rent": { v: 700, src: "", at: "2026-09-01" } } }).catch(e => e);
    assert.equal(err.code, "clash");
    assert.equal(err.theirs[0][0], "facts.rent");
    assert.equal(err.theirs[0][1].v, 1150);
    const ok = await a.updatePlace("budva", { "facts.dinner": { v: 35, src: "", at: "2026-10-30" } }, { base: { "facts.dinner": undefined } });
    assert.equal(ok.r, "sent", "a field nobody else touched saves at once");
    const fin = ph.read();
    assert.equal(fin.facts.rent.v, 1150);
    assert.equal(fin.facts.dinner.v, 35);
    assert.equal(fin.questions, "Школа?");
  } finally { ph.done(); }
});

test("saving the same card field twice in a row on one phone never warns about another device", async () => {
  const P0 = { id: "batumi", name: "Батуми", status: "кандидат", questions: "" };
  const ph = twoPhones(P0);
  try {
    const a = new Data();
    await a.refresh();
    assert.equal((await a.updatePlace("batumi", { questions: "А" }, { base: { questions: "" } })).r, "sent");
    assert.equal((await a.updatePlace("batumi", { questions: "Б" }, { base: { questions: "А" } })).r, "sent");
    assert.equal(ph.read().questions, "Б");
  } finally { ph.done(); }
});

test("an edit made while an earlier edit of the same card waits offline is queued, not refused as a clash", async () => {
  const P0 = { id: "tbilisi", name: "Тбилиси", status: "кандидат", questions: "" };
  const ph = twoPhones(P0);
  try {
    const a = new Data();
    await a.refresh();
    ph.remote.state.offlineNext = 1;
    assert.equal((await a.updatePlace("tbilisi", { questions: "А" }, { base: { questions: "" } })).r, "queued");
    ph.remote.state.offlineNext = 1;
    const second = await a.updatePlace("tbilisi", { questions: "Б" }, { base: { questions: "А" } });
    assert.ok(["queued", "sent"].includes(second.r), "my own queued edit does not count as the other phone's");
    await a.refresh();
    assert.equal(ph.read().questions, "Б");
    assert.deepEqual(a.lost, []);
  } finally { ph.done(); }
});

/* ---------- «today» is the phone's own date, not the UTC one ---------- */

test("today's date is the phone's local date, also just after midnight in Moscow when UTC is still yesterday", () => {
  assert.equal(todayISO(new Date(2026, 9, 30, 0, 30)), "2026-10-30");
  assert.equal(todayISO(new Date(2026, 0, 1, 0, 5)), "2026-01-01");
  assert.equal(todayISO(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test("the rating form compares «Приехали» with the local date, not with the UTC date", () => {
  const src = readFileSync(new URL("../js/form.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, 10\)/, "form.js still takes «today» from the UTC clock");
  assert.match(src, /fStart"\)\.max = todayISO\(\)/);
});
