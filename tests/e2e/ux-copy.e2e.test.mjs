import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS } from "./fixtures.mjs";

// Lens: texts and terms across the whole site. Crawls every screen with several data sets and checks that nothing
// reads like a leak from the code (undefined, NaN, empty brackets, dangling separators), then pins down the wording
// problems found while reading every screen at 390 px as a user.

const skip = !CHROME && "no Chrome";
let srv, page;

// Answers GitHub with the HTTP status stored in localStorage "test:status" (to show a server error).
const PROBE = `(() => {
  const inner = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const st = localStorage.getItem("test:status");
    if (st && url.startsWith("https://api.github.com/")) { await new Promise(r => setTimeout(r, 50)); return new Response(JSON.stringify({ message: "test" }), { status: Number(st), headers: { "Content-Type": "application/json" } }); }
    return inner(input, init);
  };
})();`;

before(async () => { srv = await serve(); page = await launch(); await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE }); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); page.takeErrors(); } });

/* ---------- data ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const APP = `(await import("./js/app.js")).state`;
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const MANY_CATS = STAR.concat(["банк", "где_работать", "рабочий_стек", "медицина", "стоматология", "аптеки", "пыльца", "еда_аллергены", "для_девушки", "дороги", "зима"]);
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район", retro: true, year: 6, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);
const all = (v, keys = STAR) => Object.fromEntries(keys.map(k => [k, v]));

const NOWHERE = place("nowhere", "Где-то", "", null, null, null);
const BUDVA = place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { status: "отсев", reason: "дорого и шумно" });
const BAR = place("bar", "Бар", "Черногория", "MNE", 42.0931, 19.1003, { status: "финалист", archetype: "малый курорт", facts: { rent: { v: 700, src: "halooglasi, 20 объявлений", at: "2026-10-10" }, tds: { v: 250, src: "TDS-метр", at: "2026-10-10" } } });

const EMPTY = repo({ places: [], ratings: [] });
const SMALL = repo();
const RICH = repo({
  places: PLACES.map(p => (p.id === "porto" ? Object.assign({}, p, { ext: { "улица": { res: 4 }, "шум": { res: 2 } } }) : p)).concat([BUDVA, NOWHERE, BAR]),
  ratings: RATINGS.concat([
    rating("r5", "budva", "Михаил", { "шум": 1, "интернет": 3 }, { start: "2026-07-01", end: "2026-07-21", days: 21, mode: "отпуск", housing: "центр", retro: false, year: 2, veto: "слишком шумно" }),
    rating("r6", "bar", "Михаил", Object.assign(all(4), { "транспорт": 2 }), { start: "2026-09-01", end: "2026-09-30", days: 30, season: "межсезон", retro: false, year: 8, review: "Тихо, море рядом.", conf: { "интернет": "A" }, notes: { work: "оптика" }, surprises: "ветер" }),
    rating("r7", "bar", "Вика", Object.assign(all(3.5), { "транспорт": 4 }), { start: "2026-09-01", end: "2026-09-30", days: 30, season: "межсезон", mode: "смешанно", retro: false, year: 7, review: "Нравится." }),
    rating("r8", "bar", "Михаил", { "море": 5, "шум": 3 }, { start: "2026-01-10", end: "2026-01-24", days: 15, season: "худший", mode: "отпуск", housing: "туристическая зона", retro: true, year: 6 }),
  ]),
  weights: [{ id: "mikhail", who: "Михаил", w: { legal: 20, money: 10, work: 10, health: 10, safety: 10, climate: 10, housing: 10, city: 5, nature: 5, people: 5, links: 5 } }],
});
const ODD = repo({
  places: [PLACES[0], { id: "iks", name: "Икс", lat: 43.5, lon: 16.44, cc: "HRV" }, place("igrek", "Игрек", "Хорватия", "HRV", 45.81, 15.98, { status: "финалист", ext: { "улица": { res: 4 }, "шум": { res: 2, data: 3.5 } }, facts: { dinner: { v: "40" }, tds: { v: 0 } } })],
  ratings: [
    { id: "q1", place: "iks", who: "Михаил", scores: { "интернет": 4 }, conf: { "интернет": "A" } },
    rating("q2", "igrek", "Михаил", { "интернет": 4, "кожа": 3, "улица": 1.5, "фонд": 3, "шум": 4.5, "пешком": 4 }, { start: "2026-02-01", end: "2026-03-05", days: null, season: "худший", mode: "смешанно", housing: "центр", year: 0, notes: { work: "  " } }),
    { id: "q3", place: "igrek", who: "Вика", start: "2026-02-01", scores: { "улица": 4, "шум": 2 }, year: 10 },
  ],
  weights: [{ id: "vika", who: "Вика", w: { legal: 1 } }],
});
const COUNTRIES = [["PRT", "Португалия", 38.7, -9.1], ["ESP", "Испания", 40.4, -3.7], ["ITA", "Италия", 41.9, 12.5], ["GRC", "Греция", 37.9, 23.7], ["HRV", "Хорватия", 45.8, 15.9], ["SRB", "Сербия", 44.8, 20.4], ["TUR", "Турция", 41.0, 28.9], ["GEO", "Грузия", 41.7, 44.8], ["ARM", "Армения", 40.1, 44.5], ["CYP", "Кипр", 35.1, 33.3], ["BGR", "Болгария", 42.6, 23.3]];
function bigRepo() {
  const places = [PLACES[0]];
  for (let i = 0; i < 22; i++) {
    const [cc, country, lat, lon] = COUNTRIES[i % COUNTRIES.length];
    places.push(place("t" + i, "Пробный " + (i + 1), country, cc, lat + (i % 3) * 0.6, lon + Math.floor(i / 11) * 0.8, { status: i % 7 === 6 ? "финалист" : i === 21 ? "отсев" : "кандидат", reason: i === 21 ? "далеко" : "" }));
  }
  const ratings = [];
  for (let i = 0; i < 25; i++) {
    const who = i % 2 ? "Вика" : "Михаил", v = 1 + (i % 9) * 0.5;
    ratings.push(rating("b" + i, "t" + (i % 20), who, all(v, STAR.slice(0, 3 + (i % 8))), { start: `2025-${String(1 + (i % 12)).padStart(2, "0")}-01`, end: `2025-${String(1 + (i % 12)).padStart(2, "0")}-15`, days: 15, season: ["пик", "межсезон", "худший"][i % 3], mode: ["отпуск", "удалёнка", "смешанно"][i % 3], year: i % 11, review: i % 4 ? "" : "Отзыв " + i }));
  }
  return repo({ places, ratings });
}

/* ---------- helpers ---------- */

const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

async function open(opts = {}) {
  await openApp(page, srv.url, opts);
  await page.waitFor(`(async () => !!(${APP}).world.cities)()`, 10000, "world cities loaded");
  await page.waitFor(`!["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 8000, "synced");
  await sleep(150);
}

async function show(hash) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  const name = hash.replace(/^#\/?/, "").split("/")[0] || "map";
  await page.waitFor(`!document.getElementById(${JSON.stringify(VIEW[name])}).hidden`, 4000, "view " + hash);
  await sleep(250);
  if (name === "place") await page.waitFor(`!document.getElementById("simBox") || !/Считаю/.test(document.getElementById("simBox").innerText)`, 8000, "similar places counted");
}

async function reload() {
  await page.eval("window.__beforeReload = 1");
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 10000, "reloaded");
  await page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 8000, "booted");
}

// Everything the user can read right now: header, current screen, map sheet, layers, legend, toast, suggestions.
function scanScreen() {
  const GARB = /undefined|NaN|\bnull\b|\[object|\(\s*\)|«\s*»|Infinity|·\s*·|,\s*,|:\s*[,.;·]|[,;:·]\s*$|\s[,.;](?=\s|$)/;
  const ATTR = /undefined|NaN|\bnull\b|\[object|\(\s*\)|«\s*»|Infinity/;
  const roots = [document.querySelector(".appbar"), document.querySelector(".view:not([hidden])")].concat(["sheet", "layersPanel", "legendBox", "toast", "searchResults"].map(id => document.getElementById(id))).filter(e => e && !e.hidden);
  const shown = e => { for (let x = e; x && x !== document.body; x = x.parentElement) { if (x.hidden) return false; const cs = getComputedStyle(x); if (cs.display === "none" || cs.visibility === "hidden") return false; } return true; };
  const bad = [];
  for (const r of roots) {
    for (const raw of r.innerText.split("\n")) {
      const l = raw.trim();
      if (!l || l === "·" || l === "—" || l === "×") continue;
      if (GARB.test(/^· \S/.test(l) ? l.slice(2) : l)) bad.push(l);
    }
    const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const el = n.parentElement;
      if (!el || el.closest("textarea, pre, script, style") || !shown(el)) continue;
      if (/\S[  ]{2,}\S/.test(n.nodeValue)) bad.push("double space: " + JSON.stringify(n.nodeValue.trim()));
    }
    r.querySelectorAll("[aria-label], [title], [data-tip], [placeholder]").forEach(e => {
      if (!shown(e)) return;
      ["aria-label", "title", "data-tip", "placeholder"].forEach(a => { const v = e.getAttribute(a); if (v && ATTR.test(v)) bad.push(a + ": " + v); });
    });
  }
  return [...new Set(bad)];
}

async function crawl(hashes) {
  const bad = [];
  for (const h of hashes) {
    await show(h);
    (await page.eval(`(${scanScreen})()`)).forEach(b => bad.push(`${h}: ${b}`));
  }
  return bad;
}

const scanNow = async label => (await page.eval(`(${scanScreen})()`)).map(b => `${label}: ${b}`);
const SCREENS = ["#/map", "#/rank", "#/places", "#/rate", "#/settings"];
const dossiers = ids => ids.map(id => "#/place/" + id);
const noErrors = () => assert.deepEqual(page.takeErrors(), [], "no script errors while crawling");

async function searchFor(q) {
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
  await page.waitFor(`!document.getElementById("searchResults").hidden && document.querySelectorAll("#searchResults button").length > 0`, 4000, "suggestions for " + q);
}

async function openSheet(q, title) {
  await show("#/map");
  await searchFor(q);
  await page.tap({ text: title, within: "#searchResults" });
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${JSON.stringify(title)}; })()`, 4000, "sheet of " + title);
  await sleep(200);
}

const sheetText = () => page.eval(`document.getElementById("sheetBody").innerText`);
const sheetChips = () => page.eval(`[...document.querySelectorAll("#sheetBody .chips .chip")].map(c => c.innerText.trim())`);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const rankScore = name => page.eval(`(() => { const r = [...document.querySelectorAll("#rank a.row")].find(r => r.querySelector("b").innerText === ${JSON.stringify(name)}); return r ? r.querySelector(".score").firstChild.textContent.trim() : null; })()`);
const listScore = name => page.eval(`(() => { const r = [...document.querySelectorAll("#plist a.prow")].find(r => r.querySelector("b").innerText === ${JSON.stringify(name)}); return r ? r.querySelector(".score").innerText.trim() : null; })()`);
const listMeta = name => page.eval(`(() => { const r = [...document.querySelectorAll("#plist a.prow")].find(r => r.querySelector("b").innerText === ${JSON.stringify(name)}); return r ? [...r.querySelectorAll(".meta")].map(m => m.innerText).join(" ").replace(/\\s+/g, " ").trim() : null; })()`);
const factHint = key => page.eval(`document.querySelector('[name="fact_${key}"]').closest(".fact").querySelector(".small.muted").innerText`);
const bump = () => `localStorage.setItem("mock:head", "h" + (Number((localStorage.getItem("mock:head") || "h0").slice(1)) + 1));`;
const editRemote = (path, doc) => page.eval(`(() => { const f = JSON.parse(localStorage.getItem("mock:files")); f[${JSON.stringify(path)}] = ${JSON.stringify(JSON.stringify(doc, null, 1) + "\n")}; localStorage.setItem("mock:files", JSON.stringify(f)); ${bump()} })()`);
const decimalMark = s => { const m = String(s).match(/\d([.,])\d/); return m ? m[1] : null; };

/* =================== crawls: no code leaks on any screen =================== */

test("with no places at all, every screen reads cleanly: no undefined, NaN, null, empty brackets or dangling separators", { skip }, async () => {
  await open({ files: EMPTY, intro: true });
  const bad = await scanNow("#/map with intro");
  bad.push(...(await crawl(SCREENS.concat(["#/place/porto", "#/rate/new/porto"]))));
  assert.deepEqual(bad, []);
  noErrors();
});

test("with a few places, every screen, every dossier and a rating being edited read cleanly", { skip }, async () => {
  await open({ files: SMALL });
  const bad = await crawl(SCREENS.concat(dossiers(PLACES.map(p => p.id)), ["#/rate/r1", "#/rate/new/batumi"]));
  assert.deepEqual(bad, []);
  noErrors();
});

test("with rejected, vetoed, coordinate-less, finalist and resident-rated places every screen and dossier reads cleanly", { skip }, async () => {
  await open({ files: RICH });
  const bad = await crawl(SCREENS.concat(dossiers(["sankt-peterburg", "porto", "tbilisi", "budva", "nowhere", "bar"]), ["#/rate/r6", "#/rate/r5", "#/rate/new/nowhere"]));
  await show("#/place/bar");
  await page.tap({ sel: "#showEmpty" });
  await page.eval(`document.querySelectorAll(".trip details").forEach(d => { d.open = true; })`);
  bad.push(...(await scanNow("#/place/bar with empty rows and comments open")));
  await show("#/rank");
  await page.tap({ sel: "#wdetails summary" });
  await page.eval(`document.querySelector(".rank-help").open = true`);
  bad.push(...(await scanNow("#/rank with weights and help open")));
  assert.deepEqual(bad, []);
  noErrors();
});

test("place and rating files with missing dates, season, country or status still read cleanly everywhere", { skip }, async () => {
  await open({ files: ODD });
  const bad = await crawl(SCREENS.concat(dossiers(["iks", "igrek"]), ["#/rate/q1", "#/rate/q2"]));
  for (const [q, title] of [["Икс", "Икс"], ["Игрек", "Игрек"]]) { await openSheet(q, title); bad.push(...(await scanNow("sheet " + title))); }
  assert.deepEqual(bad, []);
  noErrors();
});

test("with 22 places and 25 ratings every screen and a busy dossier read cleanly", { skip }, async () => {
  await open({ files: bigRepo() });
  const bad = await crawl(SCREENS.concat(dossiers(["t0", "t1", "t21"])));
  assert.deepEqual(bad, []);
  assert.match(await page.eval(`document.getElementById("v-place").innerText`), /\d/);
  noErrors();
});

test("without a key every screen and a shared place link read cleanly", { skip }, async () => {
  await open({ token: false, intro: true });
  const bad = await scanNow("#/map with intro");
  bad.push(...(await crawl(SCREENS.concat(["#/place/porto", "#/rate/r1"]))));
  assert.deepEqual(bad, []);
  noErrors();
});

test("offline on the very first start every screen reads cleanly", { skip }, async () => {
  await open({ offline: true });
  const bad = await crawl(SCREENS.concat(["#/place/porto", "#/rate/r1"]));
  assert.deepEqual(bad, []);
  noErrors();
});

test("map sheets, the layers panel, legends and search suggestions read cleanly", { skip }, async () => {
  await open({ files: RICH });
  const bad = [];
  for (const [q, title] of [["Порт", "Порту"], ["Тбил", "Тбилиси"], ["Санкт", "Санкт-Петербург"], ["Будв", "Будва"], ["Бар", "Бар"]]) {
    await openSheet(q, title);
    bad.push(...(await scanNow("sheet " + title)));
  }
  await page.tap({ text: "Похожие", within: "#sheetBody" });
  await page.waitFor(`/Похожие ·/i.test(document.getElementById("sheetBody").innerText)`, 6000, "similar list");
  bad.push(...(await scanNow("sheet Бар with similar")));
  await openSheet("Херцег", "Херцег-Нови");
  await page.tap({ text: "Похожие города", within: "#sheetBody" });
  await page.waitFor(`/Похожие ·/i.test(document.getElementById("sheetBody").innerText)`, 6000, "similar cities");
  bad.push(...(await scanNow("world city Херцег-Нови")));
  await show("#/map");
  await searchFor("Пор");
  bad.push(...(await scanNow("suggestions")));
  await page.key("Enter");
  await page.waitFor(`!/Ищу в OpenStreetMap/.test(document.getElementById("searchResults").innerText)`, 6000, "OpenStreetMap answered");
  bad.push(...(await scanNow("suggestions after Enter")));
  await searchFor("Херцег");
  await page.key("Enter");
  await page.waitFor(`/OpenStreetMap/i.test(document.getElementById("searchResults").innerText) && !/Ищу/.test(document.getElementById("searchResults").innerText)`, 6000, "OpenStreetMap answered");
  await page.tap({ sel: "#searchResults button", text: "Херцег-Нови" });
  await page.waitFor(`/Добавить как место/.test(document.getElementById("sheetBody").innerText)`, 4000, "OpenStreetMap sheet");
  bad.push(...(await scanNow("OpenStreetMap result")));
  await page.tap({ text: "О стране", within: "#sheetBody" });
  await page.waitFor(`document.querySelector("#sheetBody h3").innerText === "Черногория"`, 4000, "country sheet");
  await page.tap({ text: "Похожие страны", within: "#sheetBody" });
  await sleep(400);
  bad.push(...(await scanNow("country Черногория")));
  await page.tap("#sheetClose");
  await page.tap("#layersBtn");
  await page.select("#lyCountry", "Уровень цен");
  await page.select("#lyCity", "Январь, средняя");
  await page.waitFor(`/Города:/.test(document.getElementById("legendBox").innerText)`, 8000, "city legend");
  bad.push(...(await scanNow("layers relative")));
  await page.tap({ text: "Сырые значения" });
  await page.select("#lyCity", "Население");
  await page.waitFor(`/Население/.test(document.getElementById("legendBox").innerText)`, 8000, "population legend");
  bad.push(...(await scanNow("layers raw")));
  assert.deepEqual(bad, []);
  noErrors();
});

test("on a 1280 px screen in dark mode the ranking, places, a dossier, the rating form and settings read cleanly", { skip }, async () => {
  await page.viewport(1280, 800, { dark: true });
  await open({ files: RICH });
  const bad = await crawl(["#/rank", "#/places", "#/place/bar", "#/place/budva", "#/rate/r6", "#/settings"]);
  assert.deepEqual(bad, []);
  noErrors();
});

test("unsent changes of a card, a rating and weights are each described in words, with nothing left blank", { skip }, async () => {
  const lost = [
    { at: "2026-10-20T10:00:00.000Z", path: "places/porto.json", content: JSON.stringify(Object.assign({}, PLACES[1], { questions: "Где снимать зимой?" })), message: "Update place porto" },
    { at: "2026-10-20T10:00:00.000Z", path: "ratings/r1.json", content: JSON.stringify(Object.assign({}, RATINGS[0], { review: "новое" })), message: "Update rating r1" },
    { at: "2026-10-20T10:00:00.000Z", path: "ratings/r2.json", content: JSON.stringify(Object.assign({}, RATINGS[1], { deleted: true })), message: "Delete rating r2" },
    { at: "2026-10-20T10:00:00.000Z", path: "weights/mikhail.json", content: JSON.stringify({ id: "mikhail", who: "Михаил", w: { legal: 50, money: 50 } }), message: "Update weights" },
  ];
  await open({ hash: "#/rank", local: { "wtl:lost": lost } });
  const rows = await page.eval(`[...document.querySelectorAll("#v-rank .lost span")].map(s => s.innerText.trim())`);
  assert.equal(rows.length, 4, rows.join(" | "));
  for (const r of rows) assert.match(r, /[а-яё]{3,}.*[А-ЯЁа-яё]{3,}/, `«${r}» does not say what was not sent`);
  const bad = await crawl(["#/rank", "#/settings", "#/places"]);
  assert.deepEqual(bad, []);
});

/* =================== one total, one preset, everywhere =================== */

const ONE_WEIGHTS = repo({ weights: [{ id: "mikhail", who: "Михаил", w: { legal: 30, money: 10, work: 10, health: 10, safety: 10, climate: 10, housing: 5, city: 5, nature: 5, people: 3, links: 2 } }] });

test("with only Михаил's weights saved, Порту shows one total on its pin, in the list, in the ranking and in its dossier, also after a sync", { skip }, async () => {
  await open({ files: ONE_WEIGHTS });
  await page.waitFor(`document.querySelector('.leaflet-marker-icon[title="Порту"] .pin')`, 4000, "Porto pin");
  const pin = await page.eval(`document.querySelector('.leaflet-marker-icon[title="Порту"] .pin').innerText.trim()`);
  await show("#/places");
  const listBefore = await listScore("Порту");
  await show("#/rank");
  const rank = await rankScore("Порту");
  const preset = await page.eval(`document.querySelector("#presets [aria-pressed=true]").innerText`);
  await show("#/place/porto");
  const dossier = await page.text(".bigscore b");
  await show("#/places");
  await page.tap("#syncBtn");
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 6000, "synced again");
  await sleep(300);
  const listAfter = await listScore("Порту");
  assert.deepEqual({ pin, listBefore, dossier, listAfter }, { pin: rank, listBefore: rank, dossier: rank, listAfter: rank }, `the ranking shows ${rank} under «${preset}», other screens show another total`);
});

test("the dossier's similar places name the weights preset the ranking shows, never one the ranking does not offer", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rank" });
  const offered = await page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText)`);
  const current = await page.eval(`document.querySelector("#presets [aria-pressed=true]").innerText`);
  await show("#/place/porto");
  const head = await page.eval(`document.getElementById("simBox").closest(".block").querySelector(".sec-head").innerText.replace(/\\s+/g, " ")`);
  const named = (head.match(/«([^»]+)»/) || [])[1];
  assert.ok(offered.includes(named), `«${head}» names «${named}», but the ranking only offers ${offered.join(", ")}`);
  assert.equal(named, current, `the ranking uses «${current}»`);
});

/* =================== hidden ratings and the base in map sheets =================== */

test("the map sheet of a place only my partner rated neither says «оценок: 0» nor «Оценки: Вика скрыты»", { skip }, async () => {
  await open({ files: SMALL });
  await openSheet("Тбил", "Тбилиси");
  const chips = await sheetChips();
  assert.ok(!chips.includes("оценок: 0"), `Вика has rated Тбилиси, yet the sheet says: ${chips.join(" | ")}`);
  const t = await sheetText();
  assert.doesNotMatch(t, /Оценки: Вика скрыты|оценка Вика(?![а-яё])/, "the name must be in the genitive: «оценка Вики скрыта»");
  assert.match(t, /Вики/);
});

test("on Vika's phone the sheet of a place only Михаил rated says «Михаила» in the genitive and does not count zero ratings", { skip }, async () => {
  await open({ files: SMALL, me: "Вика" });
  await openSheet("Вален", "Валенсия");
  const chips = await sheetChips();
  assert.ok(!chips.includes("оценок: 0"), chips.join(" | "));
  const t = await sheetText();
  assert.doesNotMatch(t, /Оценки: Михаил скрыты|оценка Михаил(?![а-яё])/);
  assert.match(t, /Михаила/);
  await show("#/places");
  const meta = await listMeta("Валенсия");
  assert.doesNotMatch(meta, /оценка Михаил(?![а-яё])/, `places list: «${meta}»`);
});

test("the SPb sheet does not count ratings for the base, which cannot be rated", { skip }, async () => {
  await open({ files: SMALL });
  await openSheet("Санкт", "Санкт-Петербург");
  const chips = await sheetChips();
  assert.ok(!chips.some(c => /^оценок/.test(c)), `the base has no «Оценить» button, yet the sheet shows ${chips.join(" | ")}`);
});

/* =================== the same words for the same things =================== */

test("a trip in the dossier names the season and the work mode with the same words as the rating form", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rate" });
  const workLabel = await page.eval(`document.querySelector('[data-opt="mode"][data-val="удалёнка"]').innerText.trim()`);
  await show("#/place/porto");
  const line = await page.eval(`document.querySelector('.trip[data-rid="r1"] > .small.muted').innerText`);
  assert.ok(line.toLowerCase().includes(workLabel.toLowerCase()), `the form asks «Работали из поездки?» → «${workLabel}», the trip says «${line}»`);
  assert.doesNotMatch(line, /удалёнка/);
  assert.match(line, /сезон/i, `«пик» alone does not say it is the season: «${line}»`);
});

test("the last card of the rating form is not titled «Итог», the word the app uses for the computed score", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rate" });
  const title = await page.eval(`document.querySelector("[data-year]").closest(".fcard").querySelector("h2").innerText.trim()`);
  assert.notEqual(title, "Итог", "the year, review and veto card is called «Итог» while «Итог» everywhere else is the 1–5 total");
});

test("a half-point answer uses the same decimal mark in the rating form and in the dossier table", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rate/r1" });
  await page.waitFor(`document.querySelector('[data-qval="пешком"]').innerText !== ""`, 4000, "edit loaded");
  const inForm = await page.text('[data-qval="пешком"]');
  await show("#/place/porto");
  const inTable = await page.eval(`(() => { const row = [...document.querySelectorAll(".subtable tr")].find(r => /Всё пешком/.test(r.innerText)); return row.querySelectorAll("td")[2].innerText.trim(); })()`);
  assert.equal(decimalMark(inForm), decimalMark(inTable), `form shows «${inForm}», the dossier shows «${inTable}» for the same answer`);
});

test("the data sources give the download date in Russian, without nested brackets or English joiners", { skip }, async () => {
  await open({ files: SMALL, hash: "#/settings" });
  const t = await page.eval(`[...document.querySelectorAll("#v-settings section")].find(s => /Источники данных/i.test((s.querySelector("h2") || {}).textContent || "")).innerText`);
  assert.doesNotMatch(t, /\d{4}-\d{2}-\d{2}/, "ISO date in the sources");
  assert.match(t, /выгрузка[^.;)]*\d{1,2} [а-яё]+ \d{4}/);
  assert.doesNotMatch(t, /\([^()]*\(/, "brackets inside brackets: «(WGI (World Bank), …)», «(CC BY (по HDX))»");
  assert.doesNotMatch(t, /\bvia\b/);
});

test("the water-hardness hint says it is the score that never goes above 3, not the ppm reading", { skip }, async () => {
  await open({ files: SMALL, hash: "#/place/porto" });
  const hint = await factHint("tds");
  assert.match(hint, /оценка за воду/, `under a ppm field «выше 3 не бывает» reads as «the reading is never above 3 ppm»: «${hint}»`);
});

test("a place with no ratings and no world data says it has no total yet instead of «— из 5 · заполнено 0%»", { skip }, async () => {
  await open({ files: repo({ places: PLACES.concat([NOWHERE]) }), hash: "#/place/nowhere" });
  const t = (await page.text(".bigscore")).replace(/\s+/g, " ");
  assert.doesNotMatch(t, /из 5/, `«${t}»`);
  assert.doesNotMatch(t, /заполнено 0%/);
  assert.match(t, /нет|пока/);
});

test("a rejected place does not say it is «пока не в рейтинге» as if it would get in later", { skip }, async () => {
  await open({ files: repo({ places: PLACES.concat([BUDVA]), ratings: RATINGS.concat([rating("r5", "budva", "Михаил", { "шум": 1, "интернет": 3 })]) }), hash: "#/place/budva" });
  const t = (await page.text(".bigscore")).replace(/\s+/g, " ");
  assert.doesNotMatch(t, /пока не в рейтинге/, `«${t}»`);
});

/* =================== numbers and counts =================== */

test("the hidden-flags note reads the same for 1, 2, 5, 11 or 21 hidden flags and gives no count", { skip }, async () => {
  const seen = new Set();
  for (const n of [1, 2, 5, 11, 21]) {
    const files = repo({ places: [PLACES[0], PLACES[3]], ratings: [rating("h1", "tbilisi", "Вика", all(1, MANY_CATS.slice(0, n)))] });
    await open({ files, hash: "#/rank" });
    const t = (await page.text(".flags")).replace(/\s+/g, " ");
    assert.doesNotMatch(t, /\d+\s+флаг/, `${n} hidden flags are counted: «${t}»`);
    seen.add(t);
  }
  assert.equal(seen.size, 1, "the note changes with the number of hidden flags: " + [...seen].join(" | "));
});

test("search shows the population of a city of over a million in millions, not «2 120 тыс.»", { skip }, async () => {
  await open({ files: SMALL });
  await searchFor("Порт");
  const subs = await page.eval(`[...document.querySelectorAll("#searchResults small")].map(s => s.innerText)`);
  const big = subs.filter(s => { const m = s.match(/([\d\s ]+) тыс\./); return m && Number(m[1].replace(/\D/g, "")) >= 1000; });
  assert.deepEqual(big, [], "a million and more reads as «2,1 млн жителей»");
});

test("settings and the ranking count our places the same way", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rank" });
  const inRank = Number((await page.text("#v-rank header")).match(/Мест: (\d+)/)[1]);
  await show("#/settings");
  const msg = await page.text("#tokenMsg"), m = msg.match(/(\d+)\s+мест|мест[^\d]{0,3}(\d+)/);
  assert.ok(m, `«${msg}»`);
  const inSettings = Number(m[1] || m[2]);
  assert.equal(inSettings, inRank, "settings count SPb as a place, the ranking does not");
});

test("the ranking's note above the pale rows states the half-of-★ rule once", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rank" });
  const t = await page.eval(`document.querySelector("#rank .empty-row").innerText`);
  const times = (t.match(/половин[уаы] главных вопросов/g) || []).length;
  assert.ok(times <= 1, `the rule is said ${times} times in one note: «${t}»`);
});

test("world data puts every unit after the number with a space", { skip }, async () => {
  await open({ files: SMALL, hash: "#/place/porto" });
  const vals = await page.eval(`[...document.querySelectorAll(".world-row .v")].map(v => v.innerText.trim())`);
  assert.ok(vals.length > 10, vals.join(" | "));
  const odd = vals.filter(v => !/^-?\d[\d\s ]*([.,]\d+)?( (°C|мм|км|ч|мес|%|мкг\/м³|дн\.))?$/.test(v) && !/виз/.test(v));
  assert.deepEqual(odd, []);
});

/* =================== states and errors say what to do =================== */

test("offline before anything was loaded, the ranking does not claim we have no ratings, nothing to compare and no flags", { skip }, async () => {
  await open({ offline: true, hash: "#/rank" });
  const rank = await page.text("#rank");
  assert.doesNotMatch(rank, /Своих оценок пока нет/, `nothing was loaded yet: «${rank}»`);
  assert.doesNotMatch(await page.text("#v-rank"), /Сравнивать пока нечего/);
  assert.doesNotMatch(await page.text(".flags"), /Флагов нет/);
});

test("a GitHub server error banner says what to do next, not only «GitHub ответил 500»", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rank" });
  await page.eval(`localStorage.setItem("test:status", "500")`);
  try {
    await page.tap({ sel: "#syncBtn" });
    await page.waitFor(`document.getElementById("syncText").innerText === "GitHub не отвечает"`, 6000, "error shown");
    const t = await page.text("#v-rank .banner.err");
    assert.match(t, /попроб|позже|повтор|нажмите|обнов/i, `«${t}»`);
  } finally {
    await page.eval(`localStorage.removeItem("test:status")`);
  }
});

test("the offline status and the «forget key» message speak plain words, not «кэш»", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await reload();
  await page.waitFor(`/Нет связи/.test(document.getElementById("syncText").innerText)`, 6000, "offline");
  assert.doesNotMatch(await page.text("#syncText"), /кэш/, "status in the header");
  await show("#/settings");
  await page.tap({ text: "Забыть ключ на этом устройстве" });
  await page.tap({ text: "Точно забыть? Нажмите ещё раз" });
  assert.doesNotMatch(await toastText(/удален/), /кэш/, "toast after forgetting the key");
  await page.eval(`localStorage.removeItem("mock:offline")`);
});

test("a clash on the place numbers is reported as a clash on the numbers, not on «Карточку»", { skip }, async () => {
  await open({ files: SMALL, hash: "#/place/porto" });
  await editRemote("places/porto.json", Object.assign({}, PLACES[1], { questions: "Вопрос с ноутбука" }));
  await page.fill('#factsForm [name="fact_dinner"]', "40");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText.trim() !== ""`, 8000, "save result");
  const msg = await page.text("#factsMsg");
  assert.doesNotMatch(msg, /^Карточку/, `«Цифры места» and «Карточка места» are two separate sections: «${msg}»`);
  assert.match(msg, /цифр/i);
});

/* =================== more grammar in lists and chips =================== */

test("the ranking says whose veto took a place out in the genitive: «вето Михаила», not «вето Михаил»", { skip }, async () => {
  await open({ files: repo({ ratings: RATINGS.concat([rating("r5", "batumi", "Михаил", { "шум": 2 }, { veto: "плесень в каждой квартире" })]) }), hash: "#/rank" });
  const out = await page.eval(`[...document.querySelectorAll("#rank .empty-row")].map(e => e.innerText).find(t => /^Отсев/.test(t)) || ""`);
  assert.match(out, /Батуми/);
  assert.doesNotMatch(out, /вето Михаил(?![а-яё])/, `«${out}»`);
  assert.match(out, /Михаил/);
});

test("Russia's country sheet does not say «были: база» about SPb", { skip }, async () => {
  await open({ files: SMALL, local: { "wtl:view": { c: { lat: 57, lng: 40 }, z: 5 } } });
  const p = await page.eval(`(async () => { const s = ${APP}; const r = document.getElementById("map").getBoundingClientRect(); const pt = s.mapView.map.latLngToContainerPoint([57, 40]); return { x: r.left + pt.x, y: r.top + pt.y }; })()`);
  await page.click(p.x, p.y);
  await page.waitFor(`(document.querySelector("#sheetBody h3") || {}).innerText === "Россия"`, 4000, "Russia sheet");
  const chips = await sheetChips();
  assert.ok(!chips.some(c => /были: база/.test(c)), `«${chips.join(" | ")}» — «были» needs people, SPb is our base city`);
});

test("unsaved draft chips say what the number in brackets counts: 1 ответ, 2 ответа, 5 ответов", { skip }, async () => {
  await open({ files: SMALL, hash: "#/rate/new/valensiya" });
  const answer = async (keys, v) => { for (const k of keys) { const sel = `[data-score="${k}"][data-v="${v}"]`; await page.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" })`); await page.tap({ sel }, 120); } };
  await answer(["шум"], 2);
  await show("#/rate/new/belgrad");
  await answer(["шум", "улица"], 3);
  await show("#/rate/new/batumi");
  await answer(["шум", "улица", "интернет", "море", "язык"], 4);
  await show("#/rate/new/porto");
  const chips = await page.eval(`[...document.querySelectorAll("#fTop [data-draft]")].map(b => b.innerText.trim())`);
  assert.equal(chips.length, 3, chips.join(" | "));
  const of = name => chips.find(c => c.startsWith(name)) || "";
  assert.match(of("Валенсия"), /\b1 ответ(?![а-яё])/, `«${of("Валенсия")}»: a bare «(1)» does not say it counts answers`);
  assert.match(of("Белград"), /\b2 ответа(?![а-яё])/);
  assert.match(of("Батуми"), /\b5 ответов(?![а-яё])/);
});
