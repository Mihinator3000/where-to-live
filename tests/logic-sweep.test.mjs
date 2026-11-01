import "./helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModel, normalize, gen } from "../js/calc.js";
import { toScore, haversine, CITY_INDICATORS, World, SPB } from "../js/world.js";
import { Similar } from "../js/similar.js";
import { daysBetween } from "../js/util.js";
import { datesRu } from "../js/form.js";
import { rankHTML, placesListHTML, tripsHTML, flagsHTML, yearsLine, hiddenWho } from "../js/views.js";
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
const BASE = place("base", "Город-база", { status: "база" });
let rid = 0;
const rating = (placeId, who, scores, extra = {}) => Object.assign({ id: "r" + (++rid), place: placeId, who, start: "2026-08-01", end: "2026-08-14", season: "", mode: "", retro: false, year: null, veto: "", review: "", scores, conf: {}, notes: {} }, extra);
const stars = (keys, v = 4) => Object.fromEntries(keys.map(k => [k, v]));
const everywhere = v => () => v;

function build(data, { me = "", revealed = [], autoData, anon = false } = {}) {
  const v = { places: data.places || [], ratings: data.ratings || [], weights: data.weights || {} };
  const full = createModel(schema, v, { autoData });
  const hid = new Set(), rev = new Set(revealed);
  if (me || anon) full.places.forEach(p => {
    const rs = full.ratingsOf(p.id);
    if (rev.has(p.id) || (me ? rs.some(r => r.who === me) : full.PEOPLE.every(w => rs.some(r => r.who === w)))) return;
    rs.forEach(r => { if (r.who !== me) hid.add(p.id + "|" + r.who); });
  });
  const M = hid.size ? createModel(schema, Object.assign({}, v, { ratings: v.ratings.filter(r => !hid.has(r.place + "|" + r.who)) }), { autoData }) : full;
  M.hidden = (id, w) => hid.has(id + "|" + w);
  M.full = full;
  return M;
}

function rowOf(html, name) {
  const row = html.split(/<a class="row/).find(r => r.includes(`<b>${name}</b>`));
  return row ? text("<a " + row) : null;
}
const mainOrder = html => [...html.matchAll(/<span class="pos num">(\d+)<\/span>\s*<div class="name"><b>([^<]+)<\/b>/g)].map(m => [Number(m[1]), m[2]]);

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
  for (const f of ["../js/facts.js", "../js/calc.js", "../js/world.js"]) {
    try {
      const m = await import(new URL(f, import.meta.url));
      if (typeof m.factScore === "function" && typeof m.factRef === "function") {
        const factValue = m.factValue || ((p, key) => { const x = p && p.facts && p.facts[key]; const v = x && Number(x.v); return v > 0 ? v : null; });
        return (factsCache = { factScore: m.factScore, factRef: m.factRef, factValue });
      }
    } catch {}
  }
  const parts = [liftConst(APP_SRC, "MONEY_STEP"), liftConst(APP_SRC, "TDS"), liftFunction(APP_SRC, "factValue"), liftFunction(APP_SRC, "factRef"), liftFunction(APP_SRC, "factScore")];
  assert.ok(parts.every(Boolean), "facts scoring (factValue/factRef/factScore) not found in a module or in js/app.js");
  return (factsCache = new Function(parts.join("\n") + "\nreturn { factValue, factRef, factScore };")());
}
const FACT = key => schema.facts.find(f => f.key === key);
async function factNumberParser() {
  const m = APP_SRC.match(/const v = ([^\n;]*cur\.raw[^\n;]*);/);
  assert.ok(m, "the «Цифры места» number parser (const v = …cur.raw…) was not found in js/app.js");
  const expr = m[1];
  const util = Object.assign({}, await import(new URL("../js/util.js", import.meta.url)), await import(new URL("../js/facts.js", import.meta.url)).catch(() => ({})));
  const defs = [], scope = {};
  for (const n of new Set([...expr.matchAll(/\b([A-Za-z_$][\w$]*)\(/g)].map(x => x[1]))) {
    const f = liftFunction(APP_SRC, n) || liftConst(APP_SRC, n);
    if (f) defs.push(f); else if (util[n]) scope[n] = util[n];
  }
  return new Function(...Object.keys(scope), defs.join("\n") + `\nreturn raw => { const cur = { raw }; return ${expr}; };`)(...Object.values(scope));
}
function factsAuto(F, places, worldAuto = () => null) {
  return (p, k) => {
    const f = schema.facts.find(x => x.cat === k);
    const s = f ? F.factScore(f, F.factValue(p, f.key), F.factRef(f, places)) : null;
    return s != null ? s : worldAuto(p, k);
  };
}

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

const P = { id: "budva", name: "Будва", status: "кандидат", questions: "" };
function remoteSetup(files) {
  localStorage.clear();
  localStorage.setItem("wtl:token", JSON.stringify("tok"));
  const remote = makeRemote(files);
  globalThis.fetch = remote.fetchImpl;
  const phoneB = new GitHubStore({ owner: "x", repo: "y", token: "t", fetchImpl: remote.fetchImpl });
  const editB = async (path, doc) => { await phoneB.load(); await phoneB.commit([{ path, content: serialize(doc), baseOid: phoneB.oids[path] }], "B"); };
  const filesIn = dir => Object.entries(remote.state.files).filter(([k]) => k.startsWith(dir + "/")).map(([, v]) => JSON.parse(v));
  return { remote, editB, filesIn, read: path => JSON.parse(remote.state.files[path]) };
}

/* ---------- scores ---------- */

test("each subcategory mixes our score with data by how visible it is to a tourist: 70/30, 50/50, 20/80", () => {
  const vis = k => schema.cats.find(c => c.key === k).vis;
  assert.deepEqual(["интернет", "шум", "вне_сезона"].map(vis), ["●", "◐", "○"]);
  const a = place("alpha", "Альфа", { ext: { "интернет": { data: 1 }, "шум": { data: 1 }, "вне_сезона": { data: 1 } } });
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "интернет": 5, "шум": 5, "вне_сезона": 5 })] });
  assert.ok(Math.abs(M.finalCat(a, "интернет") - 3.8) < 1e-9);
  assert.ok(Math.abs(M.finalCat(a, "шум") - 3.0) < 1e-9);
  assert.ok(Math.abs(M.finalCat(a, "вне_сезона") - 1.8) < 1e-9);
});

test("a subcategory with only our score or only data uses that side alone, and residents and data are averaged first", () => {
  const a = place("alpha", "Альфа", { ext: { "к_русским": { res: 2, data: 4 }, "дружелюбие": { data: 1.5 } } });
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "шум": 4.5 })] });
  assert.equal(M.finalCat(a, "шум"), 4.5);
  assert.equal(M.finalCat(a, "дружелюбие"), 1.5);
  assert.equal(M.extCat(a, "к_русским"), 3);
  assert.equal(M.finalCat(a, "язык"), null);
});

test("health and safety take the lower of our two scores, other groups take the average", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "кожа": 5, "улица": 4, "шум": 4 }), rating("alpha", PARTNER, { "кожа": 2, "улица": 2.5, "шум": 3 })] });
  assert.equal(M.usCat("alpha", "кожа"), 2);
  assert.equal(M.usCat("alpha", "улица"), 2.5);
  assert.equal(M.usCat("alpha", "шум"), 3.5);
});

test("a trip with an unknown season or work mode counts as an ordinary trip next to a worst-season one", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "шум": 2 }, { season: "худший" }), rating("alpha", ME, { "шум": 5 }, { season: "зима", mode: "??" })] });
  assert.ok(Math.abs(M.personCat("alpha", ME, "шум") - (2 * 2 + 5) / 3) < 1e-9);
});

test("a score saved as text that is not a number is ignored instead of breaking the place total", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "интернет": 4, "шум": "3,5", "улица": "" })] });
  const t = M.total(a, EQUAL, "final");
  assert.ok(Number.isFinite(t.score), `total is ${t.score}`);
  assert.equal(t.score, 4, "only the real number 4 counts");
  assert.equal(M.personCat("alpha", ME, "улица"), null, "an empty answer is not a zero");
});

test("SPb is exactly 3 on every everyday group whatever world data says, has no score on legal and links, and is never ranked", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [BASE, a], ratings: [rating("base", ME, { "шум": 1 }), rating("alpha", ME, stars(STARS))] }, { autoData: everywhere(1) });
  schema.groups.forEach(g => assert.equal(M.groupScore(BASE, g.key, "final"), g.scale === "rel" ? 3 : null, g.key));
  assert.equal(M.finalCat(BASE, "стихии"), 3);
  assert.deepEqual(M.catFlags(BASE, "шум"), [], "a stray low score on SPb is not a red flag");
  assert.equal(M.ranksFor(EQUAL).base, undefined);
  assert.match(rowOf(rankHTML(M, EQUAL), "Город-база"), /3\.0 всегда/);
});

test("weights: saved weights become that person's preset, «Оба» averages both, and all-zero weights fall back to equal instead of dividing by zero", () => {
  const M = build({ places: [], ratings: [], weights: { [ME]: { money: 100 }, [PARTNER]: { money: 0, city: 50, people: 50 } } });
  assert.equal(M.presets[ME].money, 100);
  assert.equal(M.presets[PARTNER].city, 50);
  assert.equal(M.presets["Оба"].money, 50);
  assert.equal(M.presets["Оба"].city, 25);
  const zero = normalize(schema.groups, { money: 0, city: 0 });
  schema.groups.forEach(g => assert.ok(Math.abs(zero[g.key] - 100 / schema.groups.length) < 1e-9));
  const sum = Object.values(normalize(schema.groups, { money: "30", city: 10 })).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);
});

/* ---------- ranking ---------- */

test("a place with half of the star questions answered goes into the main ranking, with fewer it waits in «мало своих оценок»", () => {
  const a = place("alpha", "Альфа"), b = place("beta", "Бета");
  const M = build({ places: [a, b], ratings: [rating("alpha", ME, stars(STARS.slice(0, 5))), rating("beta", ME, stars(STARS.slice(0, 4)))] }, { autoData: everywhere(3) });
  assert.equal(M.ownShare("alpha"), 0.5);
  assert.equal(M.ownEnough("alpha"), true);
  assert.equal(M.ownEnough("beta"), false);
  const html = rankHTML(M, EQUAL);
  assert.deepEqual(mainOrder(html), [[1, "Альфа"]]);
  const pale = html.split("Мало своих оценок")[1] || "";
  assert.match(text(pale), /Бета.*своих ответов на ★: 4 из 10/);
});

test("star answers from both of us add up toward the half, and the same question answered twice counts once", () => {
  const a = place("alpha", "Альфа"), b = place("beta", "Бета");
  const M = build({ places: [a, b], ratings: [
    rating("alpha", ME, stars(STARS.slice(0, 3))), rating("alpha", PARTNER, stars(STARS.slice(3, 5))),
    rating("beta", ME, stars(STARS.slice(0, 3))), rating("beta", PARTNER, stars(STARS.slice(0, 3))),
  ] });
  assert.equal(M.ownShare("alpha"), 0.5);
  assert.equal(M.ownShare("beta"), 0.3);
});

test("a place below half coverage gets no rank and is listed under «Мало данных для рейтинга» with its percentage", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [rating("alpha", ME, stars(STARS.slice(0, 5)))] });
  const t = M.total(a, EQUAL, "final");
  assert.ok(t.coverage < 0.5);
  assert.equal(M.ranksFor(EQUAL).alpha, undefined);
  assert.match(text(rankHTML(M, EQUAL)), new RegExp(`Мало данных для рейтинга .*Альфа — ${Math.round(t.coverage * 100)}%`));
});

test("a place with no ratings and no data is listed as «Ещё без оценок и данных»", () => {
  const M = build({ places: [place("alpha", "Альфа")], ratings: [] });
  assert.equal(M.total(M.PLACE.alpha, EQUAL, "final").score, null);
  assert.match(text(rankHTML(M, EQUAL)), /Ещё без оценок и данных: Альфа/);
});

test("a vetoed or screened-out place leaves the ranking and the reason is shown", () => {
  const a = place("alpha", "Альфа"), b = place("beta", "Бета", { status: "отсев", reason: "" }), c = place("gamma", "Гамма");
  const M = build({ places: [a, b, c], ratings: [rating("alpha", PARTNER, stars(STARS), { veto: "сыро зимой" }), rating("gamma", ME, stars(STARS))] }, { autoData: everywhere(3) });
  assert.deepEqual(M.candidates().map(p => p.id), ["gamma"]);
  const t = text(rankHTML(M, EQUAL));
  assert.match(t, new RegExp(`Отсев: .*Альфа — вето ${gen(PARTNER)}: сыро зимой`));
  assert.match(t, /Бета — без причины/);
  assert.equal(M.allFlags()[0].sev, "crit");
  assert.match(M.allFlags()[0].head, /Альфа: вето/);
});

test("the position shown in the ranking list matches the place's №N", () => {
  const ps = [place("alpha", "Альфа"), place("beta", "Бета"), place("gamma", "Гамма")];
  const M = build({ places: ps, ratings: [rating("alpha", ME, stars(STARS, 3)), rating("beta", ME, stars(STARS, 5)), rating("gamma", PARTNER, stars(STARS, 4))] }, { autoData: everywhere(3) });
  const ranks = M.ranksFor(EQUAL);
  const order = mainOrder(rankHTML(M, EQUAL));
  assert.deepEqual(order.map(([, n]) => n), ["Бета", "Гамма", "Альфа"]);
  order.forEach(([pos, name]) => assert.equal(ranks[ps.find(p => p.name === name).id], pos, name));
});

test("two places that swap under one partner's weights both show a rank range", () => {
  const base = { "интернет": 3, "кожа": 3, "улица": 3, "фонд": 3, "шум": 3, "чистота": 3, "эстетика": 3, "язык": 3 };
  const a = place("alpha", "Альфа"), b = place("beta", "Бета");
  const M = build({ places: [a, b], ratings: [
    rating("alpha", ME, Object.assign({}, base, { "море": 5, "пешком": 3 })),
    rating("beta", ME, Object.assign({}, base, { "море": 3, "пешком": 5 })),
  ], weights: { [PARTNER]: { city: 100 } } });
  assert.deepEqual(M.ranksFor(EQUAL), { alpha: 1, beta: 2 });
  assert.deepEqual(M.ranksFor(M.presets[PARTNER]), { beta: 1, alpha: 2 });
  const html = rankHTML(M, EQUAL);
  assert.match(rowOf(html, "Альфа"), /№1–2 в зависимости от весов/);
  assert.match(rowOf(html, "Бета"), /№1–2 в зависимости от весов/);
});

test("a place scored on our own non-star answers is not labelled «только мировые данные»", () => {
  const own = { "банк": 4, "где_работать": 4, "медицина": 4, "для_девушки": 4, "зима": 4, "рынок_аренды": 4, "транспорт": 4, "кафе": 4, "дружелюбие": 4 };
  const g = place("gamma", "Гамма"), d = place("delta", "Дельта");
  const M = build({ places: [g, d], ratings: [rating("gamma", ME, own, { year: 7 })] }, { me: ME, autoData: (p) => (p.id === "delta" ? 3.5 : null) });
  const html = rankHTML(M, EQUAL);
  assert.equal(M.total(g, EQUAL, "data").score, null, "Гамма has no world data at all");
  assert.match(rowOf(html, "Дельта"), /только мировые данные/, "a place with nothing but data keeps the label");
  assert.doesNotMatch(rowOf(html, "Гамма"), /только мировые данные/);
});

/* ---------- flags, year, confidence ---------- */

test("flags: 1.5 or lower is a red flag, 1.5 points between us is a disagreement, 1.5 against residents is an illusion or an underestimate", () => {
  const a = place("alpha", "Альфа", { ext: { "шум": { res: 1.5 }, "улица": { res: 5 } } });
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "шум": 4, "улица": 3, "кафе": 1.5 }), rating("alpha", PARTNER, { "шум": 2.5, "улица": 3.5 })] });
  const short = k => M.catFlags(a, k).map(f => f.short);
  assert.deepEqual(short("кафе"), ["≤1.5"]);
  assert.deepEqual(short("шум"), ["разногласие", "иллюзия туриста"]);
  assert.deepEqual(short("улица"), ["недооценили"]);
  const sev = M.allFlags().map(f => f.sev);
  assert.deepEqual(sev, [...sev].sort((x, y) => ["crit", "serious", "warn", "info"].indexOf(x) - ["crit", "serious", "warn", "info"].indexOf(y)), "worst flags first");
});

test("«year here» shows the answer from the latest trip by date, not the last one saved, and a 0 is shown as 0/10", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [
    rating("alpha", ME, {}, { start: "2026-01-01", end: "2026-01-10", year: 3, updatedAt: "2026-02-01T00:00:00Z" }),
    rating("alpha", ME, {}, { start: "2025-06-01", end: "2025-06-10", year: 9, updatedAt: "2026-03-01T00:00:00Z" }),
    rating("alpha", PARTNER, {}, { year: 0 }),
  ] });
  assert.equal(M.latestYear("alpha", ME), 3);
  assert.equal(yearsLine(M, "alpha"), `${ME} 3/10 · ${PARTNER} 0/10`);
});

test("the confidence letter shows the weakest source across trips, and «seen as tourists» shows no letter", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [a], ratings: [rating("alpha", ME, { "шум": 3, "улица": 4 }, { conf: { "шум": "A" } }), rating("alpha", ME, { "шум": 4 }, { conf: { "шум": "C", "море": "D" } })] });
  assert.equal(M.confOf("alpha", ME, "шум"), "C");
  assert.equal(M.confOf("alpha", ME, "улица"), "");
  assert.equal(M.confOf("alpha", ME, "море"), "", "a letter without a score is ignored");
});

/* ---------- blind rating ---------- */

const blindData = () => ({ places: [BASE, place("alpha", "Альфа")], ratings: [rating("alpha", PARTNER, { "шум": 1, "улица": 2 }, { year: 3, review: "Секретный отзыв" })] });

test("the partner's rating of a place stays hidden until I rate it myself", () => {
  const M = build(blindData(), { me: ME });
  const a = M.PLACE.alpha;
  assert.equal(M.personCat("alpha", PARTNER, "шум"), null);
  assert.equal(M.full.personCat("alpha", PARTNER, "шум"), 1);
  assert.deepEqual(hiddenWho(M, "alpha"), [PARTNER]);
  const trips = text(tripsHTML(M, a, true, ME));
  assert.match(trips, new RegExp(`${PARTNER}: оценка скрыта`));
  assert.doesNotMatch(trips, /Секретный отзыв/);
  assert.equal(yearsLine(M, "alpha"), "");
  assert.match(text(placesListHTML(M, EQUAL, "")), new RegExp(`оценка ${gen(PARTNER)} скрыта до вашей`));
});

test("once I rate the place, the partner's rating becomes visible", () => {
  const data = blindData();
  data.ratings.push(rating("alpha", ME, { "шум": 4 }));
  const M = build(data, { me: ME });
  assert.deepEqual(hiddenWho(M, "alpha"), []);
  assert.equal(M.personCat("alpha", PARTNER, "шум"), 1);
  assert.match(text(tripsHTML(M, M.PLACE.alpha, true, ME)), /Секретный отзыв/);
});

test("«Показать всё равно» reveals the partner's rating without rating the place", () => {
  const M = build(blindData(), { me: ME, revealed: ["alpha"] });
  assert.deepEqual(hiddenWho(M, "alpha"), []);
  assert.equal(M.personCat("alpha", PARTNER, "улица"), 2);
});

test("a hidden partner's red flag is not shown but is counted in «Ещё N»", () => {
  const M = build(blindData(), { me: ME });
  assert.equal(M.full.allFlags().filter(f => f.sev === "crit").length, 1);
  const f = flagsHTML(M);
  assert.equal(f.count, 0);
  assert.match(text(f.html), /Флаги по местам, которые вы сами ещё не оценили, появятся после вашей оценки/);
  assert.doesNotMatch(text(f.html), /Ещё \d+ флаг/);
});

test("the hidden partner's scores do not move the place's total", () => {
  const M = build(blindData(), { me: ME, autoData: everywhere(3) });
  assert.ok(Math.abs(M.total(M.PLACE.alpha, EQUAL, "final").score - 3) < 1e-9);
  assert.ok(M.full.total(M.full.PLACE.alpha, EQUAL, "final").score < 3 - 1e-6, "with her low scores the full total would be below 3");
  assert.equal(M.total(M.PLACE.alpha, EQUAL, PARTNER).score, null);
});

test("when nobody chose who they are on this device, a place only one of us rated is hidden and a place we both rated is not", () => {
  const M = build(blindData(), { me: "", anon: true });
  assert.deepEqual(hiddenWho(M, "alpha"), [PARTNER]);
  assert.equal(M.personCat("alpha", PARTNER, "шум"), null);
  const both = blindData();
  both.ratings.push(rating("alpha", ME, { "шум": 4 }));
  const B = build(both, { me: "", anon: true });
  assert.equal(B, B.full);
  assert.deepEqual(hiddenWho(B, "alpha"), []);
  assert.equal(B.personCat("alpha", PARTNER, "шум"), 1);
});

/* ---------- «Цифры места» ---------- */

test("rent equal to SPb scores 3, 1.5 times dearer is one point less, 1.5 times cheaper one more, clipped to 1–5", async () => {
  const F = await facts();
  const rent = FACT("rent");
  const at = x => F.factScore(rent, x, 600);
  assert.equal(at(600), 3);
  assert.ok(Math.abs(at(900) - 2) < 1e-9);
  assert.ok(Math.abs(at(400) - 4) < 1e-9);
  assert.ok(Math.abs(at(1350) - 1) < 1e-9);
  assert.equal(at(5000), 1);
  assert.equal(at(50), 5);
});

test("SPb's own figure is the reference; without it the schema default is used; with neither the figure gives no score", async () => {
  const F = await facts();
  const rent = FACT("rent"), basket = FACT("basket");
  const spb = Object.assign({}, BASE, { facts: { rent: { v: 700 } } });
  assert.equal(F.factRef(rent, [spb]), 700);
  assert.equal(F.factRef(rent, [BASE]), rent.ref);
  assert.equal(basket.ref, null);
  assert.equal(F.factRef(basket, [BASE]), null);
  assert.equal(F.factScore(basket, 40, F.factRef(basket, [BASE])), null);
});

test("water hardness is scored by absolute points and never comes out better than SPb", async () => {
  const F = await facts();
  const tds = FACT("tds");
  const at = x => F.factScore(tds, x, null);
  assert.equal(at(20), 3);
  assert.equal(at(100), 3);
  assert.ok(Math.abs(at(150) - 2.75) < 1e-9);
  assert.ok(Math.abs(at(250) - 2.25) < 1e-9);
  assert.equal(at(500), 1);
  assert.equal(at(1200), 1);
});

test("a zero, negative or non-numeric figure counts as not filled in", async () => {
  const F = await facts();
  const p = v => ({ facts: { rent: { v } } });
  assert.equal(F.factValue(p("640"), "rent"), 640);
  assert.equal(F.factValue(p(0), "rent"), null);
  assert.equal(F.factValue(p(-5), "rent"), null);
  assert.equal(F.factValue(p("€640"), "rent"), null);
  assert.equal(F.factValue({}, "rent"), null);
  assert.equal(F.factValue(null, "rent"), null);
});

test("figures typed the Russian way are read correctly: spaces between thousands, a decimal comma, a currency sign", async () => {
  const parse = await factNumberParser();
  assert.equal(parse("1 200"), 1200);
  assert.equal(parse("1 200 €"), 1200);
  assert.equal(parse("36,5"), 36.5);
  assert.equal(parse("€640"), 640);
});

test("a price copied from a European listing as «1.200 €» is not saved as 1.2 euros", async () => {
  const parse = await factNumberParser();
  for (const raw of ["1.200 €", "2.450", "1,200"]) {
    const v = parse(raw);
    assert.ok(v === Number(raw.replace(/\D/g, "")) || !(v > 0), `«${raw}» was read as ${v}`);
  }
});

test("place figures feed the data column the way the app builds its model: they replace world data and mix with old ratings", async () => {
  const F = await facts();
  const spb = Object.assign({}, BASE, { facts: { rent: { v: 550 }, basket: { v: 30 } } });
  const a = place("alpha", "Альфа", { facts: { rent: { v: 825 }, basket: { v: 45 } } });
  const b = place("beta", "Бета");
  const places = [spb, a, b];
  const auto = factsAuto(F, places, (p, k) => (k === "продукты" || k === "аренда" ? 4.5 : null));
  const M = build({ places, ratings: [rating("alpha", ME, { "аренда": 4 })] }, { autoData: auto });
  assert.ok(Math.abs(M.extCat(a, "аренда", "data") - 2) < 1e-9);
  assert.ok(Math.abs(M.extCat(a, "продукты", "data") - 2) < 1e-9, "the figure wins over world data");
  assert.ok(Math.abs(M.finalCat(a, "аренда") - 3) < 1e-9, "rent is ◐: half our old rating 4, half the figure 2");
  assert.equal(M.extCat(b, "продукты", "data"), 4.5, "no figure: world data stays");
  assert.equal(M.finalCat(spb, "аренда"), 3);
});

/* ---------- world data ---------- */

test("world indicators: linear and log follow their direction, absolute ignores the SPb reference, info-only ones give no score", () => {
  const lin = { dir: -1, scale: { type: "lin", step: 3 } };
  assert.equal(toScore(lin, 20, 20), 3);
  assert.equal(toScore(lin, 23, 20), 2);
  assert.equal(toScore(lin, 50, 20), 1);
  assert.equal(toScore(lin, 20, null), null);
  const log = { dir: -1, scale: { type: "log", step: Math.log(1.5) } };
  assert.ok(Math.abs(toScore(log, 150, 100) - 2) < 1e-9);
  assert.equal(toScore(log, 0, 100), null);
  const air = CITY_INDICATORS.find(i => i.key === "air_km");
  assert.equal(toScore(air, 40, 999), toScore(air, 40, null));
  assert.equal(toScore(air, 40, null), 4);
  const info = CITY_INDICATORS.find(i => i.key === "t_jul");
  assert.equal(toScore(info, 30, 18), null);
});

test("a missing or broken world value never turns into NaN or the worst possible score", () => {
  assert.equal(toScore({ dir: 1, scale: { type: "lin", step: 3 } }, NaN, 0), null);
  assert.equal(toScore({ dir: -1, scale: { type: "abs", points: [[15, 5], [350, 1]] } }, NaN, null), null);
  const w = world();
  for (const ind of CITY_INDICATORS) {
    const s = w.cityScore({ id: 1, n: "без координат" }, ind.key);
    assert.ok(s == null || Number.isFinite(s), `${ind.key} gives ${s}`);
  }
});

test("a city record without climate data gives empty values, not zeros, and only daylight is still known", () => {
  const c = { id: 2, lat: 42.3, lon: 18.8 };
  const got = Object.fromEntries(CITY_INDICATORS.map(i => [i.key, i.get(c)]));
  Object.entries(got).forEach(([k, v]) => { if (k !== "day_dec") assert.ok(v == null, `${k}: ${v}`); });
  assert.ok(got.day_dec > 8 && got.day_dec < 10);
  const half = Object.assign({}, c, { t: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, null], c: [50, 50] });
  assert.equal(CITY_INDICATORS.find(i => i.key === "t_jan").get(half), null, "an incomplete year is not used");
  assert.equal(CITY_INDICATORS.find(i => i.key === "cloud_win").get(half), null);
});

test("SPb's city scores exactly 3 on every relative climate and time-zone indicator, and every bundled city gets a finite score or none", () => {
  const w = world();
  assert.equal(w.spbCity.en, "Saint Petersburg");
  CITY_INDICATORS.filter(i => i.dir && i.scale && i.scale.type !== "abs").forEach(i => assert.equal(w.cityScore(w.spbCity, i.key), 3, i.key));
  assert.equal(w.cityScore(w.spbCity, "tz_msk"), 3);
  for (const c of w.cities) for (const i of CITY_INDICATORS) {
    const s = w.cityScore(c, i.key);
    if (s != null) assert.ok(Number.isFinite(s) && s >= 1 && s <= 5, `${c.en} ${i.key}: ${s}`);
  }
});

test("a place uses its own city within 30 km, otherwise its exact point, and gets no city without coordinates", () => {
  const w = world();
  assert.equal(w.placeCity({ lat: 42.29, lon: 18.84 }).en, "Budva");
  const sea = w.placeCity({ lat: 35.5, lon: 17.5 });
  assert.equal(sea.synthetic, true);
  assert.equal(w.placeCity({ name: "без координат" }), null);
  assert.equal(w.autoData({ lat: 59.94, lon: 30.31, cc: "RUS" }, "свет"), 3);
  assert.equal(w.autoData({ lat: 42.29, lon: 18.84, cc: "MNE" }, "зима"), null);
});

test("distances: zero to itself, the same both ways, short across the date line, SPb to Moscow about 634 km", () => {
  const spb = { lat: 59.9386, lon: 30.3141 }, msk = { lat: 55.7558, lon: 37.6173 };
  assert.equal(haversine(spb, spb), 0);
  assert.equal(haversine(spb, msk), haversine(msk, spb));
  const d = haversine(spb, msk);
  assert.ok(d > 620 && d < 650, `${d}`);
  assert.ok(haversine({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }) < 30);
  assert.ok(Number.isFinite(haversine({ lat: 59.94, lon: 30.31 }, { lat: -59.94, lon: -149.69 })));
});

/* ---------- similar places ---------- */

test("a city is identical to itself and similarity is the same in both directions", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  sim.prepare();
  const budva = cityByEn("Budva"), msk = cityByEn("Moscow");
  const a = sim.profile({ cc: budva.cc, city: budva }), b = sim.profile({ cc: msk.cc, city: msk });
  assert.equal(sim.distance(a, a, EQUAL).d, 0);
  const ab = sim.distance(a, b, EQUAL), ba = sim.distance(b, a, EQUAL);
  assert.ok(ab.d > 0);
  assert.ok(Math.abs(ab.d - ba.d) < 1e-12);
});

test("similar cities never list the place itself or its next-door neighbours, and percentages are real numbers", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  const budva = cityByEn("Budva");
  const list = sim.similarCities({ cc: budva.cc, city: budva, lat: budva.lat, lon: budva.lon }, EQUAL, { k: 15 });
  assert.equal(list.length, 15);
  assert.ok(!list.some(o => o.city.id === budva.id));
  assert.ok(!list.some(o => o.city.en === "Kotor"), "Kotor is next door, not «similar»");
  list.forEach(o => assert.ok(Number.isInteger(o.pct) && o.pct >= 0 && o.pct <= 100, `${o.city.en}: ${o.pct}`));
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].pct >= list[i].pct, "most similar first");
});

test("with only climate weighted, a city with the same climate is closer than one with a cold winter", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  sim.prepare();
  const climateOnly = normalize(schema.groups, { climate: 100 });
  const prof = en => { const c = cityByEn(en); return sim.profile({ cc: c.cc, city: c }); };
  const budva = prof("Budva");
  assert.ok(sim.distance(budva, prof("Herceg Novi"), climateOnly).d < sim.distance(budva, prof("Moscow"), climateOnly).d);
});

test("with all weights at zero there is no similar list rather than NaN percentages", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  const zero = Object.fromEntries(schema.groups.map(g => [g.key, 0]));
  const budva = cityByEn("Budva");
  assert.deepEqual(sim.similarCities({ cc: budva.cc, city: budva }, zero, { k: 5 }), []);
});

test("the score predictor needs at least three rated places and keeps its guess within 1–5", () => {
  const w = world(), sim = new Similar(w, schema.groups);
  const x = en => { const c = cityByEn(en); return { cc: c.cc, city: c }; };
  assert.equal(sim.predictor([Object.assign(x("Budva"), { score: 4 }), Object.assign(x("Kotor"), { score: 4 })], EQUAL), null);
  const pred = sim.predictor(["Budva", "Kotor", "Tivat"].map(en => Object.assign(x(en), { score: 4.5 })), EQUAL);
  const g = pred(x("Herceg Novi"));
  assert.ok(g && g.score > 3 && g.score <= 5, JSON.stringify(g));
  assert.ok(g.conf > 0 && g.conf < 1);
});

/* ---------- trip dates ---------- */

test("trip length counts both ends: a day trip is 1 day, an end before the start gives no length", () => {
  assert.equal(daysBetween("2026-08-01", "2026-08-01"), 1);
  assert.equal(daysBetween("2026-08-01", "2026-08-20"), 20);
  assert.equal(daysBetween("2026-03-28", "2026-03-30"), 3);
  assert.equal(daysBetween("2026-12-30", "2027-01-02"), 4);
  assert.equal(daysBetween("2026-08-02", "2026-08-01"), null);
  assert.equal(daysBetween("2026-08-01", ""), null);
  assert.equal(daysBetween("не дата", "2026-08-01"), null);
});

test("trip dates read naturally across months and years", () => {
  assert.equal(datesRu("2026-08-01", "2026-08-20"), "1–20 августа 2026");
  assert.equal(datesRu("2026-08-28", "2026-09-03"), "28 августа – 3 сентября 2026");
  assert.equal(datesRu("2026-12-28", "2027-01-03"), "28 декабря 2026 – 3 января 2027");
  assert.equal(datesRu("2026-08-01"), "1 августа 2026");
  assert.equal(datesRu(""), "");
});

test("a one-day trip shows a single date, not «1–1 июля»", () => {
  assert.equal(datesRu("2026-07-01", "2026-07-01"), "1 июля 2026");
});

/* ---------- sync queue and clashes ---------- */

test("a rating saved offline survives an app restart and is sent exactly once when back online", async () => {
  const { remote, filesIn } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  const { r } = await a.saveRating({ place: "budva", who: PARTNER, scores: { "шум": 2 } });
  assert.equal(r, "queued");
  const b = new Data();
  assert.equal(b.view().ratings.length, 1, "the queued rating is visible after restart");
  await b.refresh();
  assert.equal(b.pending.length, 0);
  assert.deepEqual(filesIn("ratings").map(x => x.scores), [{ "шум": 2 }]);
});

test("deleting a rating that is still waiting to be sent hides it at once and sends the deletion later", async () => {
  const { remote, filesIn } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 2;
  const { doc } = await a.saveRating({ place: "budva", who: PARTNER, scores: { "шум": 2 } });
  assert.equal(await a.deleteRating(doc), "queued");
  const M = createModel(schema, a.view());
  assert.equal(M.ratings.length, 0);
  await a.refresh();
  assert.equal(a.pending.length, 0);
  assert.deepEqual(filesIn("ratings").map(x => x.deleted), [true]);
});

test("«Записать мою» writes my unsent version over the other phone's and clears the warning", async () => {
  const { remote, editB, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  await a.savePlace(Object.assign({}, P, { questions: "мой вопрос" }), false);
  await editB("places/budva.json", Object.assign({}, P, { questions: "чужой вопрос" }));
  await a.refresh();
  assert.equal(a.lost.length, 1);
  assert.equal(await a.applyLost(0), "sent");
  assert.equal(read("places/budva.json").questions, "мой вопрос");
  assert.equal(a.lost.length, 0);
  assert.equal(a.notice, "");
  assert.equal(a.view().places[0].questions, "мой вопрос");
});

test("«Выбросить» drops only the chosen unsent edit and the warning goes away with the last one", () => {
  remoteSetup({});
  localStorage.setItem("wtl:lost", JSON.stringify([{ at: "1", path: "places/a.json", content: "{}" }, { at: "2", path: "places/b.json", content: "{}" }]));
  const a = new Data();
  a.notice = "Не отправлено";
  a.dropLost(0);
  assert.deepEqual(a.lost.map(l => l.path), ["places/b.json"]);
  assert.equal(a.notice, "Не отправлено");
  a.dropLost(0);
  assert.deepEqual(a.lost, []);
  assert.equal(a.notice, "");
});

test("weights saved twice offline end up as the last version in one commit", async () => {
  const { remote, read } = remoteSetup({});
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  await a.saveWeights(PARTNER, { money: 50 });
  remote.state.offlineNext = 1;
  await a.saveWeights(PARTNER, { money: 70 });
  assert.deepEqual(a.view().weights[PARTNER], { money: 70 });
  const before = remote.state.n;
  await a.refresh();
  assert.equal(remote.state.n - before, 1);
  assert.deepEqual(read("weights/vika.json").w, { money: 70 });
});

test("edits waiting offline survive «Забыть ключ» and are sent after a new key, as the message promises", async () => {
  const { remote, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  await a.savePlace(Object.assign({}, P, { questions: "без сети" }), false);
  a.forget();
  assert.equal(a.status, "notoken");
  assert.equal(a.pending.length, 1);
  a.setCredentials(null, "new-key");
  await a.refresh();
  assert.equal(a.pending.length, 0);
  assert.equal(read("places/budva.json").questions, "без сети");
});

test("a broken file in the data repo does not hide the rest and is named in the error", async () => {
  remoteSetup({ "places/budva.json": serialize(P), "places/broken.json": "{oops", "ratings/r1.json": serialize({ id: "r1", place: "budva", who: ME, scores: { "шум": 3 } }) });
  const a = new Data();
  await a.refresh();
  assert.equal(a.view().places.length, 1);
  assert.equal(a.view().ratings.length, 1);
  assert.match(a.error, /places\/broken\.json/);
});

test("two new places with the same name get different ids even while offline", async () => {
  const { remote, filesIn } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 2;
  const one = await a.savePlace({ name: "Будва", status: "кандидат" }, true);
  const two = await a.savePlace({ name: "Будва", status: "кандидат" }, true);
  assert.deepEqual([one.doc.id, two.doc.id], ["budva-2", "budva-3"]);
  await a.refresh();
  assert.equal(filesIn("places").length, 3);
});

test("a clash is still reported when 50 older unsent edits are already waiting", async () => {
  const { remote, editB, read } = remoteSetup({ "places/budva.json": serialize(P) });
  localStorage.setItem("wtl:lost", JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ at: "2026-10-01", path: `places/old${i}.json`, content: "{}", message: "old" }))));
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  assert.equal((await a.savePlace(Object.assign({}, P, { questions: "A1" }), false)).r, "queued");
  await editB("places/budva.json", Object.assign({}, P, { questions: "B" }));
  await assert.rejects(a.savePlace(Object.assign({}, P, { questions: "A2" }), false), e => e.code === "clash", "the save must not be reported as sent");
  assert.equal(read("places/budva.json").questions, "B");
});

test("a save refused because the other phone changed the same card does not report a broken connection", async () => {
  const { editB } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  const oldOid = a.oidOf("places", "budva");
  await editB("places/budva.json", Object.assign({}, P, { questions: "B" }));
  await a.refresh();
  await assert.rejects(a.savePlace(Object.assign({}, P, { questions: "A" }), false, oldOid), e => e.code === "clash");
  assert.equal(a.status, "live", "the connection is fine: the sync badge must not say «Ошибка связи»");
  assert.equal(a.error, "");
});
