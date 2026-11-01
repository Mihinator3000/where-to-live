import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, mockFiles, PLACES } from "./fixtures.mjs";

// Lens: leaks of the blind rating across the whole interface. Until I (wtl:me) rate a place, nothing my
// partner wrote or scored about it may be visible or inferable on any screen — except «Показать всё равно»
// and the agreed fact that her veto takes the place out for both. Synthetic data only; GitHub and Nominatim are mocked.

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- synthetic data ---------- */
const T = "2026-10-01T00:00:00.000Z";
const SPB = PLACES[0];
const place = (id, name, country, cc, lat, lon, x = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, x);
const rating = (id, placeId, who, scores, x = {}) => Object.assign({ id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район", retro: false, year: 7, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, x);

const COORD = { porto: [41.14961, -8.61099], valensiya: [39.46975, -0.37739], budva: [42.287, 18.839], tbilisi: [41.69411, 44.83368], batumi: [41.64228, 41.63392], belgrad: [44.80401, 20.46513], "hertseg-novi": [42.4531, 18.5375] };
const PL = [
  SPB,
  place("porto", "Порту", "Португалия", "PRT", ...COORD.porto),
  place("valensiya", "Валенсия", "Испания", "ESP", ...COORD.valensiya),
  place("budva", "Будва", "Черногория", "MNE", ...COORD.budva),
  place("tbilisi", "Тбилиси", "Грузия", "GEO", ...COORD.tbilisi),
  place("batumi", "Батуми", "Грузия", "GEO", ...COORD.batumi),
  place("belgrad", "Белград", "Сербия", "SRB", ...COORD.belgrad),
  place("hertseg-novi", "Херцег-Нови", "Черногория", "MNE", ...COORD["hertseg-novi"]),
];

// distinctive words the partner wrote — none may appear anywhere before I rate the place
const MARK = { review: "ОТЗЫВ-ЛИМОНАД", note: "КОММЕНТ-КИТ", surprise: "СЮРПРИЗ-ЁЖ", review2: "ОТЗЫВ-ЖИРАФ", veto: "ВЕТО-СЛИВА", mine: "ОТЗЫВ-МИХАИЛА-ПАЛЬМА" };
const SECRET = [MARK.review, MARK.note, MARK.surprise, MARK.review2, MARK.veto];

const MINE = [
  rating("m-porto", "porto", "Михаил", { "интернет": 4, "улица": 4, "шум": 3.5, "пешком": 4.5, "эстетика": 5, "чистота": 3.5, "язык": 3 }, { year: 8, review: "Хочу вернуться в Порту." }),
  rating("v-porto", "porto", "Вика", { "интернет": 4, "улица": 4.5, "шум": 3, "пешком": 4, "эстетика": 4.5, "чистота": 4, "язык": 2.5 }, { year: 7, review: "Холмы, но красиво." }),
  rating("m-val", "valensiya", "Михаил", { "интернет": 4.5, "улица": 4, "шум": 3, "пешком": 4, "эстетика": 4, "море": 5, "чистота": 4 }, { year: 8, review: MARK.mine }),
  rating("m-budva", "budva", "Михаил", { "интернет": 3, "улица": 4, "шум": 2.5, "пешком": 4, "эстетика": 4, "море": 4.5 }, { year: 6 }),
];
const V_TBI_SCORES = { "интернет": 1, "улица": 1.5, "шум": 1, "пешком": 2, "эстетика": 2, "чистота": 1.5, "язык": 1, "кожа": 2 };
const vTbi = (scores = V_TBI_SCORES) => rating("v-tbi", "tbilisi", "Вика", scores, { start: "2026-03-03", end: "2026-03-17", days: 15, season: "худший", mode: "смешанно", housing: "центр", year: 2, review: MARK.review, notes: { housing: MARK.note }, surprises: MARK.surprise, conf: { "интернет": "A" } });
const vBat = rating("v-bat", "batumi", "Вика", { "интернет": 5, "улица": 5, "шум": 4.5, "пешком": 5, "эстетика": 5, "чистота": 4.5, "язык": 4.5, "море": 5 }, { start: "2026-05-05", end: "2026-05-25", days: 21, season: "межсезон", year: 9, review: MARK.review2 });
const vBel = rating("v-bel", "belgrad", "Вика", { "интернет": 3, "улица": 3 }, { year: 1, veto: MARK.veto });
const HIDDEN = [vTbi(), vBat, vBel];

const WITH = repo({ places: PL, ratings: [...MINE, ...HIDDEN] });
const WITHOUT = repo({ places: PL, ratings: MINE });
const HIDDEN_NO_FLAGS = repo({ places: PL, ratings: [...MINE, vTbi(Object.fromEntries(Object.keys(V_TBI_SCORES).map(k => [k, 3]))), vBat, vBel] });

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `(await import("./js/app.js")).state`;
const PIN = title => `.leaflet-marker-icon[title="${title}"]`;
const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

const still = () => page.waitFor(`(async () => {
  const s = ${APP}; const m = s.mapView && s.mapView.map; if (!m || location.hash !== "#/map") return true;
  const k = () => m.getCenter().lat.toFixed(5) + "," + m.getCenter().lng.toFixed(5) + "," + m.getZoom();
  const a = k(); await new Promise(r => setTimeout(r, 130)); const b = k(); await new Promise(r => setTimeout(r, 130));
  return !m._animatingZoom && a === b && b === k();
})()`, 8000, "map stopped moving");

async function open({ files = WITH, hash = "#/rank", me = "Михаил", w = 390, h = 844, dark = false, local = {} } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, { files, hash, me, local });
  await page.waitFor(`(async () => { const s = ${APP}; return !!(s.M && s.world.cities && (location.hash !== "#/map" || s.mapView)); })()`, 10000, "app with world data");
  await still();
  page.takeErrors();
}

async function go(hash) {
  await page.goto(srv.url + hash, 150);
  const v = VIEW[hash.replace(/^#\//, "").split("/")[0]];
  await page.waitFor(`!document.getElementById(${JSON.stringify(v)}).hidden`, 4000, "view " + hash);
  await sleep(200);
}

async function reload() {
  await page.eval(`window.__beforeReload = true`);
  await page.send("Page.reload");
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 10000, "page reloaded");
  await page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 8000, "app booted");
  await sleep(300);
}

async function press(sel, settle = 200) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}

const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const html = () => page.eval(`document.documentElement.outerHTML`);
const leaked = async (marks = SECRET) => { const h = await html(); return marks.filter(m => h.includes(m)); };
const viewText = id => page.eval(`document.getElementById(${JSON.stringify(id)}).innerText`);

async function sheetOf(id, name, zoom = 8) {
  if ((await page.eval("location.hash")) !== "#/map") await go("#/map");
  await page.eval(`(async () => { const s = ${APP}; if (!document.getElementById("sheet").hidden) document.getElementById("sheetClose").click(); s.mapView.map.setView([${COORD[id][0]}, ${COORD[id][1]}], ${zoom}, { animate: false }); })()`);
  await still();
  await page.tap({ sel: PIN(name) });
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${JSON.stringify(name)}; })()`, 4000, "sheet of " + name);
  return page.eval(`document.getElementById("sheetBody").innerText`);
}

// what the screen would show if the partner had not rated: the hidden note is the only allowed difference
const NOOWN = s => String(s).replace(/оценк[аи] (Вики|Михаила)( и [А-Яа-яё]+)? скрыт[аы] до вашей( оценки)?/g, "NOOWN").replace(/только мировые данные/g, "NOOWN").replace(/\s+/g, " ").trim();

const pinsNow = () => page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(m => ({ title: m.title, label: m.getAttribute("aria-label"), text: m.innerText.trim(), style: (m.querySelector(".pin") || m).getAttribute("style"), cls: (m.querySelector(".pin") || m).className })).sort((a, b) => a.title.localeCompare(b.title))`);
const rankNow = () => page.eval(`[...document.querySelectorAll("#rank a.row")].map(r => ({ pos: r.querySelector(".pos").innerText.trim(), name: r.querySelector(".name b").innerText, score: r.querySelector(".score").innerText.replace(/\\s+/g, " "), chips: [...r.querySelectorAll(".chip")].map(c => c.innerText), dots: [...r.querySelectorAll(".dot")].map(d => d.className + "@" + d.style.left + "@" + d.dataset.tip), bar: (r.querySelector(".bar") || {}).outerHTML || "", sr: (r.querySelector(".sr-only") || {}).innerText || "" }))`);
const heatNow = () => page.eval(`[...document.querySelectorAll("#heat tbody tr")].map(tr => ({ head: tr.querySelector("th").innerText, cells: [...tr.querySelectorAll("td")].map(td => td.innerText + "|" + td.getAttribute("style") + "|" + td.dataset.tip) }))`);
const placesNow = () => page.eval(`[...document.querySelectorAll("#plist a.prow")].map(r => ({ name: r.querySelector("b").innerText, score: r.querySelector(".score").innerText, sw: r.querySelector(".sw").getAttribute("style"), meta: [...r.querySelectorAll(".meta span")].map(s => s.innerText) }))`);
const dossierNow = () => page.eval(`(() => {
  const v = document.getElementById("v-place"), heads = [...v.querySelectorAll(".subtable thead th")].map(t => t.innerText.trim()), vi = heads.indexOf("Вика");
  return {
    big: v.querySelector(".bigscore").innerText.replace(/\\s+/g, " "),
    sides: [...v.querySelectorAll(".panel.pad p.small")].map(p => p.innerText).filter(t => /СПб:|Сильнее|Слабее/.test(t)),
    radar: v.querySelector(".radar svg").outerHTML,
    nums: (v.querySelector(".radar-nums") || {}).outerHTML || "",
    rows: [...v.querySelectorAll(".subtable tbody tr")].map(tr => [...tr.children].filter((c, i) => tr.classList.contains("grp") || i !== vi).map(c => c.innerText.trim()).join(" | ")),
  };
})()`);

/* =====================================================================
   1. Nothing the partner wrote is anywhere on the page before I rate
   ===================================================================== */

test("the partner's review, comments, surprises and veto reason are nowhere in the page on the map, ranking, places list, dossiers or the rating form", { skip, timeout: 90000 }, async () => {
  await open({ hash: "#/map" });
  const seen = {};
  for (const [id, name] of [["tbilisi", "Тбилиси"], ["batumi", "Батуми"], ["belgrad", "Белград"]]) {
    await sheetOf(id, name);
    seen["sheet " + name] = await leaked();
  }
  for (const h of ["#/rank", "#/places", "#/place/tbilisi", "#/place/batumi", "#/place/belgrad", "#/rate/new/tbilisi", "#/settings"]) {
    await go(h);
    if (h === "#/place/tbilisi") await page.eval(`document.querySelectorAll("#v-place details").forEach(d => d.open = true)`);
    seen[h] = await leaked();
  }
  const bad = Object.entries(seen).filter(([, v]) => v.length);
  assert.deepEqual(bad, [], "partner's words found in the DOM: " + JSON.stringify(bad));
});

test("the partner's hidden trip dates, season, work mode and «откуда знаем» letters are not shown before I rate", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  await page.eval(`document.querySelectorAll("#v-place details").forEach(d => d.open = true)`);
  const dossier = await viewText("v-place");
  assert.doesNotMatch(dossier, /3–17 марта|сезон: худший|работали часть дней|15 дн\./, "her trip facts show in the dossier");
  const conf = await page.eval(`[...document.querySelectorAll("#v-place .subtable .c")].map(c => c.innerText + ":" + c.title)`);
  assert.deepEqual(conf.filter(c => /^A/.test(c)), [], "her «проверили в быту» letter shows in the table");
  const sheet = await sheetOf("tbilisi", "Тбилиси");
  assert.doesNotMatch(sheet, /3–17 марта|марта 2026/, "her trip dates show on the map card");
  await go("#/rank");
  assert.doesNotMatch(await viewText("v-rank"), /3–17 марта|худший/);
});

test("the rating form for a place my partner rated shows none of her answers, even when I switch «Кто оценивает» to her", { skip }, async () => {
  await open({ hash: "#/rate/new/tbilisi" });
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form on Тбилиси");
  let t = await viewText("v-rate");
  assert.doesNotMatch(t, /У вас уже есть оценка этого места/, "the form says I already rated a place I have not");
  await press('#fWho [data-who="Вика"]');
  t = await viewText("v-rate");
  assert.doesNotMatch(t, /уже есть оценка этого места за 3–17 марта/, "picking Вика reveals that she rated it and when");
  assert.deepEqual(await leaked(), []);
  assert.equal(await page.eval(`document.querySelectorAll('[data-score][aria-pressed="true"]').length`), 0, "her scores are pre-pressed in the form");
});

test("searching for a hidden place lists only its name and country", { skip }, async () => {
  await open({ hash: "#/map" });
  await page.tap({ sel: "#searchInput" });
  await page.type("Тби");
  await page.waitFor(`!document.getElementById("searchResults").hidden`, 3000, "suggestions");
  const t = await page.eval(`document.getElementById("searchResults").innerText`);
  assert.match(t, /Тбилиси/);
  assert.doesNotMatch(t, /\d\.\d|\/10|Вика/, "the search suggestion carries a score or her name: " + t);
});

test("the accessibility tree of the ranking, dossier and map card names the partner only as hidden, with none of her numbers", { skip }, async () => {
  const attrs = () => page.eval(`[...document.querySelectorAll(".view:not([hidden]) [aria-label], .view:not([hidden]) [title], .view:not([hidden]) [data-tip], .view:not([hidden]) .sr-only, #sheetBody [aria-label], #sheetBody [title], #sheetBody .sr-only")].map(e => [e.getAttribute("aria-label"), e.getAttribute("title"), e.dataset.tip, e.classList.contains("sr-only") ? e.textContent : ""].filter(Boolean).join(" ¦ "))`);
  const herNumber = /Вика[^¦]{0,12}\d|Вики[^¦]{0,12}\d/;
  await open({ hash: "#/place/tbilisi" });
  assert.equal(await page.eval("document.title"), "Тбилиси — Где жить");
  let a = await attrs();
  assert.deepEqual(a.filter(x => herNumber.test(x)), [], "dossier attributes");
  assert.ok(a.some(x => /скрыт/.test(x)), "a screen reader is never told that her column is hidden");
  await go("#/rank");
  a = await attrs();
  assert.deepEqual(a.filter(x => /Тбилиси|Батуми|Белград/.test(x) && herNumber.test(x)), [], "ranking attributes");
  assert.equal(await page.eval(`[...document.querySelectorAll("#rank a.row")].filter(r => /Тбилиси|Батуми|Белград/.test(r.innerText) && r.querySelector(".sr-only")).length`), 0, "hidden places carry a screen-reader line with scores");
  await sheetOf("batumi", "Батуми");
  a = await attrs();
  assert.deepEqual(a.filter(x => herNumber.test(x)), [], "map card attributes");
});

/* =====================================================================
   2. Numbers: every screen looks as if she had not rated the hidden places
   ===================================================================== */

async function both(hash, collect, prep) {
  const out = [];
  for (const files of [WITH, WITHOUT]) {
    await open({ files, hash });
    if (prep) await prep();
    out.push(await collect());
  }
  return out;
}

test("map pins of places only the partner rated have the same number, colour, shape and label as if she had not rated them", { skip }, async () => {
  const [a, b] = await both("#/map", pinsNow);
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
});

test("the ranking keeps the same order, positions, bars, dots and scores as if she had not rated the hidden places; only the note says hers is hidden", { skip }, async () => {
  const [a, b] = await both("#/rank", rankNow);
  const norm = rows => rows.map(r => Object.assign({}, r, { chips: r.chips.map(NOOWN) }));
  assert.deepEqual(norm(a), norm(b));
  const tbi = a.find(r => r.name === "Тбилиси");
  assert.ok(tbi.chips.some(c => /скрыт/.test(c)), "the Тбилиси row does not say why it has no own scores");
});

test("the places × groups table has the same cells, colours and order as if she had not rated the hidden places", { skip }, async () => {
  const [a, b] = await both("#/rank", heatNow);
  const norm = rows => rows.map(r => ({ head: NOOWN(r.head), cells: r.cells }));
  assert.deepEqual(norm(a), norm(b));
});

test("the places list shows the same scores, colours and order, with «оценка Вики скрыта до вашей» where there would be «только мировые данные»", { skip }, async () => {
  const [a, b] = await both("#/places", placesNow);
  const norm = rows => rows.map(r => Object.assign({}, r, { meta: r.meta.map(NOOWN) }));
  assert.deepEqual(norm(a), norm(b));
  assert.match(a.find(r => r.name === "Батуми").meta.join(" · "), /оценка Вики скрыта до вашей/);
});

test("the dossier of a hidden place shows the same total, strengths, radar and subcategory numbers as without her rating", { skip }, async () => {
  for (const id of ["tbilisi", "batumi", "belgrad"]) {
    const [a, b] = await both("#/place/" + id, dossierNow);
    assert.deepEqual(a, b, id);
  }
});

test("the map card of a hidden place shows only the world-data total, with no per-person score, year answer or review", { skip }, async () => {
  const cards = [];
  for (const files of [WITH, WITHOUT]) {
    await open({ files, hash: "#/map" });
    const t = await sheetOf("batumi", "Батуми");
    const big = await page.eval(`document.querySelector("#sheetBody .bigscore b").innerText.replace(/\\s+/g, " ")`);
    const per = await page.eval(`(document.querySelector("#sheetBody .bigscore + .legend") || {}).innerText || ""`);
    cards.push({ t, big, per });
  }
  const [a, b] = cards;
  assert.equal(a.big, b.big, "the big number on the card moved because of her hidden rating");
  assert.equal(a.per, "", "per-person totals are listed: " + a.per);
  assert.doesNotMatch(a.t, /год здесь|здесь год:|Вика 9\/10|4\.8/, "her year answer or her total shows on the card");
  assert.match(a.t, /Оценка Вики скрыта, пока вы не оцените место сами/);
});

test("«Прогноз для нас» on the map ranks the same cities as if she had not rated the hidden places", { skip, timeout: 60000 }, async () => {
  const top = async () => {
    await page.tap({ sel: "#layersBtn" });
    await page.waitFor(`!document.getElementById("layersPanel").hidden`, 3000, "layers");
    await page.select("#lyCity", "predict");
    await page.waitFor(`!!document.querySelector("#layersPanel .ptop")`, 8000, "forecast list");
    return page.eval(`[...document.querySelectorAll("#layersPanel .ptop button")].map(b => b.innerText.replace(/\\s+/g, " "))`);
  };
  const [a, b] = await both("#/map", top);
  assert.ok(a.length > 0, "no forecast list");
  assert.deepEqual(a, b);
});

test("a country I only know through her hidden trips is not outlined or labelled as visited by her", { skip, timeout: 60000 }, async () => {
  const georgia = async () => {
    const style = await page.eval(`(async () => { const s = ${APP}; let o = null; s.mapView.countryLayer.eachLayer(l => { if (l.feature.properties.iso3 === "GEO") o = { color: l.options.color, weight: l.options.weight, dash: l.options.dashArray }; }); return o; })()`);
    await page.tap({ sel: "#searchInput" });
    await page.type("Грузия");
    await page.waitFor(`[...document.querySelectorAll("#searchResults button")].some(b => /^Грузия/.test(b.innerText))`, 4000, "country suggestion");
    await page.tap({ text: "Грузия", within: "#searchResults" });
    await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return h && h.innerText === "Грузия"; })()`, 4000, "country card");
    const chips = await page.eval(`[...document.querySelectorAll("#sheetBody .chips .chip")].map(c => c.innerText)`);
    return { style, chips };
  };
  const [a, b] = await both("#/map", georgia);
  assert.deepEqual(a, b);
  assert.ok(!a.chips.some(c => /Вика/.test(c)), "the country card says Вика was there: " + a.chips);
});

/* =====================================================================
   3. Flags: the hidden-flags note must not tell anything about her scores
   ===================================================================== */

test("the flags section reads the same whether the partner's hidden ratings contain red flags or not", { skip }, async () => {
  const flags = async () => ({ head: await page.eval(`[...document.querySelectorAll("#v-rank .sec-head")].find(h => /Флаги/i.test(h.innerText)).innerText.replace(/\\s+/g, " ")`), body: (await page.text("#v-rank .flags")).replace(/\s+/g, " ") });
  await open({ files: WITH });
  const withFlags = await flags();
  await open({ files: HIDDEN_NO_FLAGS });
  const noFlags = await flags();
  assert.doesNotMatch(withFlags.body, /Тбилиси|ставит|1\.0/, "her flags themselves show");
  assert.deepEqual(withFlags, noFlags, `her hidden 1.0 and 1.5 scores in Тбилиси change the flags section: «${withFlags.body}» vs «${noFlags.body}»`);
});

test("with a single hidden place, the flags section does not count how many low scores the partner gave it", { skip }, async () => {
  const files = repo({ places: PL, ratings: [...MINE, vTbi()] });
  await open({ files });
  const t = (await page.text("#v-rank .flags")).replace(/\s+/g, " ");
  assert.doesNotMatch(t, /\d+ флаг/, `the note counts her hidden red flags in Тбилиси: «${t}»`);
});

/* =====================================================================
   4. Once I rate, everything appears; when I delete my rating, it hides again
   ===================================================================== */

async function rateHere(placeId, scores, year) {
  await page.waitFor(`document.getElementById("fPlace").value === ${JSON.stringify(placeId)}`, 4000, "form on " + placeId);
  for (const [k, v] of Object.entries(scores)) await press(`[data-score="${k}"][data-v="${v}"]`, 60);
  if (year != null) await press(`[data-year="${year}"]`, 60);
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 8000, "dossier after saving");
  await sleep(300);
}
const FIVE = { "интернет": 3, "улица": 3, "шум": 3, "пешком": 3, "эстетика": 3 };

test("rating a hidden place myself opens her review, comments, year answer, column, radar line and flags at once", { skip }, async () => {
  await open({ hash: "#/rate/new/tbilisi" });
  await rateHere("tbilisi", FIVE, 5);
  const t = await viewText("v-place");
  assert.match(t, new RegExp(MARK.review), "her review");
  assert.match(t, /Вика 2\/10/, "her year answer");
  assert.match(t, /3–17 марта 2026/, "her trip dates");
  assert.doesNotMatch(t, /оценка скрыта|Показать всё равно/);
  assert.deepEqual(await leaked([MARK.note, MARK.surprise]), [MARK.note, MARK.surprise], "her comments are not in the trip");
  assert.equal(await page.eval(`document.querySelectorAll('#v-place .subtable td[title^="скрыто"]').length`), 0, "her column is still dotted");
  assert.ok(await page.eval(`!!document.querySelector('#v-place .radar svg path[stroke="var(--v)"]')`), "no radar line for her");
  await go("#/rank");
  assert.match(await page.text("#v-rank .flags"), /Тбилиси[\s\S]*Вика ставит 1\.0/);
});

test("deleting my only rating of a place hides the partner's rating there again on every screen", { skip, timeout: 60000 }, async () => {
  const mineTbi = rating("m-tbi", "tbilisi", "Михаил", FIVE, { year: 5 });
  await open({ files: repo({ places: PL, ratings: [...MINE, ...HIDDEN, mineTbi] }), hash: "#/place/tbilisi" });
  assert.match(await viewText("v-place"), new RegExp(MARK.review), "precondition: her review is open while I have a rating");
  await page.tap({ text: "Изменить", within: "#v-place .trips" });
  await page.waitFor(`!!document.querySelector(".edit-head")`, 4000, "edit form");
  await press("#fDelete");
  await press("#fDelete");
  await page.waitFor(`location.hash === "#/place/tbilisi"`, 8000, "dossier after delete");
  assert.match(await toastText(/удалена/), /Оценка удалена/);
  assert.match(await viewText("v-place"), /Оценка Вики скрыта, пока вы не оцените место сами/);
  assert.deepEqual(await leaked(), [], "her words stay on the dossier");
  await go("#/rank");
  assert.doesNotMatch(await page.text("#v-rank .flags"), /Вика ставит/);
  assert.match((await rankNow()).find(r => r.name === "Тбилиси").chips.join(" "), /оценка Вики скрыта до вашей/);
  assert.deepEqual(await leaked(), []);
});

test("a rating I save without connection, still waiting in the queue, already opens the partner's rating", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await rateHere("batumi", FIVE, 6);
  assert.match(await toastText(/Нет связи/), /отправится/);
  assert.match(await viewText("v-place"), new RegExp(MARK.review2), "her review stays hidden although my rating is saved on the phone");
});

test("the hidden state survives reopening the app without connection from the saved copy", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await reload();
  await page.waitFor(`/Тбилиси/.test(document.getElementById("v-place").innerText)`, 5000, "dossier from cache");
  assert.match(await page.text("#syncText"), /Нет связи/);
  assert.match(await viewText("v-place"), /Оценка Вики скрыта, пока вы не оцените место сами/);
  assert.deepEqual(await leaked(), []);
});

/* =====================================================================
   5. Reveal
   ===================================================================== */

test("«Показать всё равно» on one place reveals only that place, not her other hidden places", { skip }, async () => {
  await open({ hash: "#/place/batumi" });
  await page.tap({ text: "Показать всё равно", within: "#v-place .panel.pad" });
  await page.waitFor(`/${MARK.review2}/.test(document.getElementById("v-place").innerText)`, 3000, "Батуми revealed");
  await go("#/place/tbilisi");
  assert.match(await viewText("v-place"), /Оценка Вики скрыта/);
  assert.deepEqual(await leaked([MARK.review, MARK.note, MARK.surprise, MARK.veto]), []);
  await go("#/places");
  const rows = await placesNow();
  assert.match(rows.find(r => r.name === "Белград").meta.join(" "), /скрыта до вашей/);
  assert.doesNotMatch(rows.find(r => r.name === "Батуми").meta.join(" "), /скрыта/);
});

test("after «Показать всё равно» there is a way to hide the partner's rating again", { skip }, async () => {
  await open({ hash: "#/place/batumi" });
  await page.tap({ text: "Показать всё равно", within: "#v-place .panel.pad" });
  await page.waitFor(`/${MARK.review2}/.test(document.getElementById("v-place").innerText)`, 3000, "Батуми revealed");
  const undo = await page.eval(`[...document.querySelectorAll("#v-place button, #v-place a, #toast button")].filter(b => b.offsetParent && /скрыть|не показывать|отменить/i.test(b.innerText)).map(b => b.innerText.trim())`);
  assert.ok(undo.length, "one accidental tap spoils the blind rating for good: no «Скрыть снова» or undo anywhere on the dossier");
  await page.tap({ text: undo[0] });
  assert.doesNotMatch(await viewText("v-place"), new RegExp(MARK.review2), "her review is still shown after hiding");
  assert.match(await viewText("v-place"), /Показать всё равно/);
});

/* =====================================================================
   6. The mirror: the same device switched to the partner
   ===================================================================== */

test("switching «Кто я» to Вика hides Михаил's places she has not rated and opens hers, and switching back mirrors it", { skip }, async () => {
  await open({ hash: "#/settings" });
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  await go("#/place/valensiya");
  assert.match(await viewText("v-place"), /Оценка Михаила скрыта, пока вы не оцените место сами/);
  assert.deepEqual(await leaked([MARK.mine]), [], "his review shows to Вика");
  await go("#/place/tbilisi");
  assert.match(await viewText("v-place"), new RegExp(MARK.review), "her own review is hidden from her");
  await go("#/rank");
  assert.match((await rankNow()).find(r => r.name === "Валенсия").chips.join(" "), /оценка Михаила скрыта до вашей/);
  assert.match(await page.text("#v-rank .flags"), /Вика ставит 1\.0/, "her own flags are hidden from her");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Михаил"]' });
  await go("#/place/tbilisi");
  assert.match(await viewText("v-place"), /Оценка Вики скрыта/);
  assert.deepEqual(await leaked(), []);
  await go("#/place/valensiya");
  assert.match(await viewText("v-place"), new RegExp(MARK.mine));
});

test("switching «Кто я» with the other person's unsaved rating in the form neither shows her answers nor turns them into mine, and switching back keeps her draft", { skip }, async () => {
  await open({ hash: "#/rate/new/hertseg-novi", me: "Вика" });
  await page.waitFor(`document.getElementById("fPlace").value === "hertseg-novi"`, 4000, "form");
  await press('[data-score="интернет"][data-v="2"]');
  await page.fill("#fReview", "ЧЕРНОВИК-ВИКИ-КОКОС");
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes("ЧЕРНОВИК-ВИКИ-КОКОС")`, 4000, "draft saved");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Михаил"]' });
  await go("#/rate");
  const who = await page.eval(`(document.querySelector('#fWho [aria-pressed="true"]') || {}).innerText || ""`);
  const review = await page.eval(`document.getElementById("fReview").value`);
  assert.ok(!(who === "Михаил" && /ЧЕРНОВИК-ВИКИ-КОКОС/.test(review)), "Вика's unsaved review now sits in Михаил's form and «Сохранить» would save it under his name");
  assert.doesNotMatch(review, /ЧЕРНОВИК-ВИКИ-КОКОС/, "Михаил sees Вика's unsaved review");
  await go("#/place/hertseg-novi");
  assert.doesNotMatch(await viewText("v-place"), /черновик вашей оценки/, "her draft is offered to Михаил as his own");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  await go("#/rate/new/hertseg-novi");
  await sleep(300);
  assert.equal(await page.eval(`document.getElementById("fReview").value`), "ЧЕРНОВИК-ВИКИ-КОКОС", "Вика's draft is lost after the switch");
});

/* =====================================================================
   7. Other doors: no chosen person, a direct link, the data copy
   ===================================================================== */

test("on a device that does not know who I am yet, the map card of a place only Вика rated shows neither her review nor her scores", { skip }, async () => {
  await open({ hash: "#/map", me: "" });
  const t = await sheetOf("tbilisi", "Тбилиси");
  assert.doesNotMatch(t, new RegExp(MARK.review), "her review shows before the device knows who is looking");
  assert.doesNotMatch(t, /Вика 2\/10|Вика 1\.\d/, "her year answer or total shows: " + t.replace(/\s+/g, " "));
  assert.match(t, /Кто вы|скрыт/i, "the card neither asks who I am nor says the ratings are hidden");
});

test("on a device that does not know who I am yet, the dossier and flags do not show ratings only one of us made", { skip }, async () => {
  await open({ hash: "#/place/tbilisi", me: "" });
  assert.match(await viewText("v-place"), /Кто вы на этом устройстве\?/);
  assert.deepEqual(await leaked(), [], "her words are in the dossier before I said who I am");
  await go("#/rank");
  assert.doesNotMatch(await page.text("#v-rank .flags"), /Вика ставит|ВЕТО-СЛИВА/, "her flags and veto reason show before I said who I am");
});

test("a direct link to the partner's hidden rating does not open her answers in the rating form", { skip }, async () => {
  await open({ hash: "#/rate/v-tbi" });
  await sleep(400);
  const review = await page.eval(`document.getElementById("fReview").value`);
  const top = await page.text("#fTop");
  assert.notEqual(review, MARK.review, "her hidden review is loaded into the form");
  assert.doesNotMatch(top, /Правка оценки: Тбилиси · Вика/, "her hidden rating opens for editing: " + top);
  const toast = await page.eval(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText`);
  assert.match(toast + " " + top, /скрыт|не найдена/i, "nothing tells why the link opened an empty form");
});

test("the data copy either leaves out the partner's hidden ratings or says plainly that it contains them", { skip }, async () => {
  await open({ hash: "#/settings" });
  await page.eval(`window.__blobs = []; URL.createObjectURL = b => { window.__blobs.push(b); return "blob:test"; }; HTMLAnchorElement.prototype.click = function () { window.__download = this.download; }`);
  await page.tap({ text: "Скачать копию данных" });
  await page.waitFor(`window.__blobs.length > 0`, 3000, "export file");
  const file = await page.eval(`window.__blobs[0].text()`);
  const inFile = SECRET.filter(m => file.includes(m));
  const section = await page.eval(`document.getElementById("exportBtn").closest(".block").innerText`);
  if (inFile.length) assert.match(section, /скрыт/i, `the copy contains her hidden texts (${inFile.join(", ")}) while the screen says «${section.replace(/\s+/g, " ")}»`);
  assert.ok(JSON.parse(file).ratings.some(r => r.id === "m-val"), "my own ratings are missing from the copy");
});

test("questions for the next trip are shared on purpose: the writer is told, and her hidden review still stays hidden", { skip, timeout: 60000 }, async () => {
  await open({ hash: "#/rate/new/hertseg-novi", me: "Вика" });
  await page.waitFor(`document.getElementById("fPlace").value === "hertseg-novi"`, 4000, "form");
  assert.match(await page.eval(`document.querySelector('label[for="fQuestions"]').innerText`), /видны обоим|увидит/, "the writer is not told the questions are seen at once");
  await press('[data-score="интернет"][data-v="2"]');
  await page.fill("#fReview", "ОТЗЫВ-КАКТУС");
  await page.fill("#fQuestions", "ВОПРОС-АРБУЗ: проверить воду");
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/hertseg-novi"`, 8000, "dossier");
  const files = await mockFiles(page);
  await open({ files, hash: "#/place/hertseg-novi", me: "Михаил" });
  const t = await viewText("v-place");
  assert.match(t, /Оценка Вики скрыта/);
  assert.match(t, /Вопросы к следующей поездке: ВОПРОС-АРБУЗ/);
  assert.deepEqual(await leaked(["ОТЗЫВ-КАКТУС"]), []);
});

/* =====================================================================
   8. Is the hidden state clear without being noisy
   ===================================================================== */

test("every screen that would show a hidden place says whose rating is hidden and why", { skip, timeout: 60000 }, async () => {
  await open({ hash: "#/rank" });
  assert.match((await rankNow()).find(r => r.name === "Батуми").chips.join(" "), /оценка Вики скрыта до вашей/);
  assert.match((await heatNow()).find(r => /Батуми/.test(r.head)).head, /оценка Вики скрыта до вашей/);
  await page.eval(`document.querySelector(".rank-help").open = true`);
  assert.match(await page.text(".rank-help"), /скрыта, пока вы не оцените место сами[^.]*Показать всё равно/);
  await go("#/places");
  assert.match((await placesNow()).find(r => r.name === "Батуми").meta.join(" "), /оценка Вики скрыта до вашей/);
  await go("#/place/batumi");
  const dossier = await viewText("v-place");
  for (const re of [/Оценка Вики скрыта/, /пока вы не оцените/, /Показать всё равно/]) assert.match(dossier, re, `dossier: «${dossier}»`);
  const sheet = await sheetOf("batumi", "Батуми");
  for (const re of [/Оценка Вики скрыта/, /пока вы не оцените/]) assert.match(sheet, re, `map card: «${sheet}»`);
});

test("the dossier of a hidden place says how to see her rating: rate it yourself with «Оценить», or «Показать всё равно»", { skip }, async () => {
  await open({ hash: "#/place/batumi" });
  const t = await viewText("v-place");
  assert.match(t, /пока вы не оцените место сами/);
  assert.ok(await page.locate({ text: "Оценить", within: "#v-place .place-head" }).then(r => !r.error), "no «Оценить» next to the hidden note");
  assert.ok(await page.locate({ text: "Показать всё равно", within: "#v-place .panel.pad" }).then(r => !r.error && !r.covered));
  const h = await page.eval(`Math.round(document.querySelector('#v-place .panel.pad [data-reveal]').getBoundingClientRect().height)`);
  assert.ok(h >= 24, `«Показать всё равно» is only ${h}px tall on a phone`);
});

test("in the subcategory table, the dots in the partner's column are explained on the screen, not only in a tooltip a phone cannot show", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  const block = await page.eval(`(() => { const b = document.querySelector("#v-place .subtable").closest(".block"); const c = b.cloneNode(true); c.querySelector("table").remove(); return c.innerText; })()`);
  assert.ok(await page.eval(`document.querySelectorAll('#v-place .subtable td[title^="скрыто"]').length > 0`), "precondition: her column is dotted");
  assert.match(block, /скрыт/i, `nothing near the table says what «·» in the «Вика» column means: «${block.replace(/\s+/g, " ")}»`);
});

test("the radar legend says the partner's line is hidden instead of listing her colour with no line", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  assert.ok(await page.eval(`!document.querySelector('#v-place .radar svg path[stroke="var(--v)"]')`), "precondition: her radar line is hidden");
  const legend = await page.eval(`document.querySelector("#v-place .radar .legend").innerText.replace(/\\s+/g, " ")`);
  assert.match(legend, /Вика[^·]{0,25}скрыт|скрыт[^·]{0,25}Вик/i, `the legend lists «Вика» in orange but there is no orange line: «${legend}»`);
});

test("on a wide screen in dark mode the hidden place reads the same: notes present, her data absent", { skip }, async () => {
  await open({ hash: "#/place/tbilisi", w: 1280, h: 800, dark: true });
  const t = await viewText("v-place");
  assert.match(t, /Оценка Вики скрыта, пока вы не оцените место сами/);
  assert.match(t, /Вика скрыто/);
  assert.deepEqual(await leaked(), []);
  const note = await page.eval(`(() => { const e = [...document.querySelectorAll("#v-place .panel.pad p")].find(p => /скрыта/.test(p.innerText)); const s = getComputedStyle(e); return { color: s.color, bg: getComputedStyle(document.body).backgroundColor }; })()`);
  assert.notEqual(note.color, note.bg, "the hidden note is invisible in dark mode");
  await go("#/rank");
  assert.deepEqual(await leaked(), []);
  assert.match(await viewText("v-rank"), /оценка Вики скрыта до вашей/);
});

/* =====================================================================
   9. Counts, forecasts, drafts, weights and late arrivals
   ===================================================================== */

const vBat2 = rating("v-bat-2", "batumi", "Вика", { "интернет": 4, "улица": 4, "шум": 4 }, { start: "2026-06-10", end: "2026-06-20", days: 11, year: 8, review: "ОТЗЫВ-ВТОРОЙ-ЗАХОД" });

test("the map card, the settings status and the refresh toast read the same whether she rated a hidden place once or twice", { skip, timeout: 60000 }, async () => {
  const seen = [];
  for (const files of [WITH, repo({ places: PL, ratings: [...MINE, ...HIDDEN, vBat2] })]) {
    await open({ files, hash: "#/settings" });
    const status = (await page.text("#tokenMsg")).replace(/\s+/g, " ");
    await page.tap({ sel: "#refreshBtn" });
    const toast = await toastText(/Данные обновлены/);
    const card = (await sheetOf("batumi", "Батуми")).replace(/\s+/g, " ");
    seen.push({ status, toast, card });
  }
  assert.deepEqual(seen[1], seen[0], "her second hidden trip to Батуми shows up as one more rating in the counts");
  assert.deepEqual(await leaked(["ОТЗЫВ-ВТОРОЙ-ЗАХОД"]), []);
});

test("the map card of a place only the partner rated still gives me «прогноз для нас», as it would if she had not rated it", { skip, timeout: 60000 }, async () => {
  const vHn = rating("v-hn", "hertseg-novi", "Вика", { "интернет": 2, "улица": 2, "шум": 2 }, { year: 3, review: "ОТЗЫВ-ХН-ТЫКВА" });
  const cards = [];
  for (const files of [WITHOUT, repo({ places: PL, ratings: [...MINE, vHn] })]) {
    await open({ files, hash: "#/map" });
    cards.push((await sheetOf("hertseg-novi", "Херцег-Нови", 10)).replace(/\s+/g, " "));
  }
  assert.match(cards[0], /прогноз для нас/, "precondition: the forecast shows on the card of a place nobody rated");
  assert.match(cards[1], /Оценка Вики скрыта/);
  assert.match(cards[1], /прогноз для нас/, `with her rating hidden I get less help than with no rating at all: «${cards[1]}»`);
  assert.deepEqual(await leaked(["ОТЗЫВ-ХН-ТЫКВА"]), []);
});

test("on a shared phone my rating form neither lists the partner's unsaved drafts nor hands me her unsaved answers", { skip }, async () => {
  await open({ hash: "#/rate/new/hertseg-novi", me: "Вика" });
  await page.waitFor(`document.getElementById("fPlace").value === "hertseg-novi"`, 4000, "form");
  await press('[data-score="интернет"][data-v="2"]');
  await page.fill("#fReview", "ЧЕРНОВИК-ВИКИ-ФИНИК");
  await sleep(400);
  await go("#/rate/new/porto");
  await page.waitFor(`/Херцег-Нови \\(1 ответ\\)/.test(document.getElementById("fTop").innerText)`, 4000, "precondition: her draft is parked in the drafts list");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Михаил"]' });
  await go("#/rate");
  const top = (await page.text("#fTop")).replace(/\s+/g, " ");
  assert.doesNotMatch(top, /Херцег-Нови/, `Михаил's form offers Вика's unsaved draft: «${top}»`);
  assert.deepEqual(await leaked(["ЧЕРНОВИК-ВИКИ-ФИНИК"]), []);
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  await go("#/rate");
  assert.match(await page.text("#fTop"), /Херцег-Нови \(1 ответ\)/, "her draft is gone after the switch back");
});

const WM = { id: "mikhail", who: "Михаил", w: { legal: 6, money: 30, work: 12, health: 6, safety: 6, climate: 6, housing: 12, city: 6, nature: 6, people: 5, links: 5 }, updatedAt: T };
const WV = { id: "vika", who: "Вика", w: { legal: 4, money: 4, work: 4, health: 20, safety: 20, climate: 20, housing: 4, city: 4, nature: 10, people: 5, links: 5 }, updatedAt: T };

test("switching to her weights moves places and announces the same rises whether or not she rated the hidden places", { skip, timeout: 60000 }, async () => {
  const out = [];
  for (const ratings of [[...MINE, ...HIDDEN], MINE]) {
    await open({ files: repo({ places: PL, ratings, weights: [WM, WV] }), hash: "#/rank", local: { preset: "Михаил" } });
    await page.tap({ sel: '#presets button[data-p="Вика"]' });
    await sleep(300);
    const toast = await page.eval(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText`);
    out.push({ toast, rows: (await rankNow()).map(r => Object.assign({}, r, { chips: r.chips.map(NOOWN) })), heat: (await heatNow()).map(r => ({ head: NOOWN(r.head), cells: r.cells })) });
  }
  assert.deepEqual(out[0], out[1]);
});

test("my own rating that was deleted on another device does not unlock her rating of the place", { skip }, async () => {
  const gone = rating("m-tbi-old", "tbilisi", "Михаил", FIVE, { year: 5, deleted: true, review: "УДАЛЁННЫЙ-МОЙ" });
  await open({ files: repo({ places: PL, ratings: [...MINE, ...HIDDEN, gone] }), hash: "#/place/tbilisi" });
  assert.match(await viewText("v-place"), /Оценка Вики скрыта, пока вы не оцените место сами/);
  assert.deepEqual(await leaked([...SECRET, "УДАЛЁННЫЙ-МОЙ"]), []);
});

test("a rating she saves while I look at a place arrives hidden after «Обновить данные»", { skip }, async () => {
  const late = rating("v-hn-late", "hertseg-novi", "Вика", { "интернет": 1, "улица": 1, "шум": 1 }, { year: 1, review: "ОТЗЫВ-ПОЗДНИЙ-КИВИ" });
  await open({ files: WITHOUT, hash: "#/place/hertseg-novi" });
  assert.doesNotMatch(await viewText("v-place"), /скрыт/, "precondition: nobody has rated Херцег-Нови");
  await page.eval(`(() => { const f = JSON.parse(localStorage.getItem("mock:files")); f["ratings/v-hn-late.json"] = ${JSON.stringify(JSON.stringify(late, null, 1) + "\n")}; localStorage.setItem("mock:files", JSON.stringify(f)); localStorage.setItem("mock:head", "h1"); })()`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`/Оценка Вики скрыта/.test(document.getElementById("v-place").innerText)`, 8000, "her new rating arrives as hidden");
  assert.deepEqual(await leaked(["ОТЗЫВ-ПОЗДНИЙ-КИВИ"]), []);
  await go("#/rank");
  assert.doesNotMatch(await page.text("#v-rank .flags"), /Херцег-Нови|ставит 1\.0/, "her 1.0 scores show as flags");
});

test("when I rate a place she has not, I am told she will see it only after rating it herself, and on her phone it is hidden", { skip, timeout: 60000 }, async () => {
  await open({ hash: "#/rate/new/hertseg-novi" });
  await page.waitFor(`document.getElementById("fPlace").value === "hertseg-novi"`, 4000, "form");
  await page.fill("#fReview", "ОТЗЫВ-МОЙ-МАНГО");
  await rateHere("hertseg-novi", FIVE, 6);
  assert.match(await toastText(/Сохранено/), /Вика не увидит вашу оценку, пока не оценит место/);
  assert.match(await viewText("v-place"), /Вика увидит эту оценку, когда оценит место/);
  const files = await mockFiles(page);
  await open({ files, hash: "#/place/hertseg-novi", me: "Вика" });
  assert.match(await viewText("v-place"), /Оценка Михаила скрыта, пока вы не оцените место сами/);
  assert.deepEqual(await leaked(["ОТЗЫВ-МОЙ-МАНГО"]), []);
});

test("after switching «Кто я» back and forth, no tab I have not reopened still holds the other person's words in the page", { skip }, async () => {
  await open({ hash: "#/settings", me: "Вика" });
  for (const h of ["#/rank", "#/places", "#/place/belgrad"]) await go(h);
  assert.ok((await leaked([MARK.veto])).length, "precondition: Вика sees her own veto reason");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Михаил"]' });
  assert.deepEqual(await leaked(), [], "the hidden ranking, places and dossier tabs still carry Вика's texts after the switch to Михаил");
});

test("no screen I visit while her ratings are hidden throws an error", { skip }, async () => {
  await open({ hash: "#/map" });
  await sheetOf("tbilisi", "Тбилиси");
  for (const h of ["#/rank", "#/places", "#/place/tbilisi", "#/place/belgrad", "#/rate/new/batumi", "#/settings"]) await go(h);
  assert.deepEqual(page.takeErrors(), []);
});

/* =====================================================================
   Cycle 3 review: wording of the hidden rating and a shared phone
   ===================================================================== */

test("the map card of a hidden place says once that Vika's rating is hidden, not twice", { skip }, async () => {
  await open({ hash: "#/map" });
  const t = (await sheetOf("batumi", "Батуми")).replace(/\s+/g, " ");
  assert.equal((t.match(/скрыт/g) || []).length, 1, `the card repeats that the rating is hidden: «${t}»`);
  const big = await page.eval(`document.querySelector("#sheetBody .bigscore").innerText.replace(/\\s+/g, " ")`);
  assert.match(big, /пока только мировые данные/, `the big number no longer says where it comes from: «${big}»`);
  assert.match(t, /Оценка Вики скрыта, пока вы не оцените место сами/);
  const order = await page.eval(`(() => { const b = document.querySelector("#sheetBody .bigscore"), h = [...document.querySelectorAll("#sheetBody p")].find(p => /скрыта/.test(p.innerText)), btns = document.querySelector("#sheetBody .btns"); return [b, h, btns].every(Boolean) && (b.compareDocumentPosition(h) & 4) && (h.compareDocumentPosition(btns) & 4) ? "score, why, buttons" : "other"; })()`);
  assert.equal(order, "score, why, buttons", "the only explanation must sit right under the score it explains, above the buttons");
  await page.shot("c3-blind-map-card-hidden-once");
});

test("on a device that does not know who I am, the places list and the ranking say the rating is hidden until I choose who I am, not «до вашей»", { skip }, async () => {
  await open({ hash: "#/places", me: "" });
  const rows = await placesNow();
  const meta = rows.find(r => r.name === "Тбилиси").meta.join(" · ");
  assert.match(meta, /оценка Вики скрыта, пока не выбрано, кто вы/, `«${meta}»`);
  assert.doesNotMatch((await viewText("v-places")), /до вашей/, "there is no «ваша» оценка on a device that does not know who you are");
  await go("#/rank");
  assert.doesNotMatch(await viewText("v-rank"), /скрыт[аы] до вашей/);
});

test("on a shared phone, after «Кто я» goes to Вика and back, «Оценить» for the place opens my half-filled answers instead of an empty form", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await page.waitFor(`document.getElementById("fPlace").value === "batumi"`, 4000, "form on Батуми");
  await press('[data-score="интернет"][data-v="4"]');
  await press('[data-score="улица"][data-v="3.5"]');
  await sleep(400);
  const setMe = async who => { await go("#/settings"); await page.tap({ text: who, within: "#meSeg" }); await sleep(200); };
  await setMe("Вика");
  await go("#/rate/new/batumi");
  assert.match(await page.text("#fCounts"), /0 из 10/, "fixture: Vika gets her own empty form");
  await setMe("Михаил");
  await go("#/place/batumi");
  await page.tap({ text: "Оценить", within: "#v-place .place-head" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace").value === "batumi"`, 4000, "form on Батуми again");
  assert.match(await page.text("#fCounts"), /2 из 10/, "my two answers are only in «Несохранённые черновики», the form is empty and invites filling it a second time");
  assert.equal(await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').getAttribute("aria-pressed")`), "true");
});
