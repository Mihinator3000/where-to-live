import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- synthetic data ---------- */
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const stars = (n, v) => Object.fromEntries(STAR.slice(0, n).map(k => [k, v]));
const rate = (id, placeId, who, scores, extra = {}) => Object.assign({}, RATINGS[0], { id, place: placeId, who, scores, review: "", year: 6, veto: "" }, extra);
const view = (lat, lng, z) => ({ "wtl:view": { c: { lat, lng }, z } });
const RATED4 = [...RATINGS, rate("x5", "batumi", "Михаил", { "интернет": 3, "улица": 3, "море": 4, "эстетика": 3 })];
const PIN_PLACES = PLACES.map(p => (p.id === "tbilisi" ? Object.assign({}, p, { status: "отсев", reason: "шумно по ночам" }) : p));
const PIN_RATINGS = [
  rate("p1", "porto", "Михаил", stars(8, 4)),
  rate("p2", "porto", "Вика", stars(8, 4.5)),
  rate("p3", "valensiya", "Михаил", stars(3, 3.5)),
  rate("p4", "batumi", "Михаил", stars(6, 2.5), { veto: "сырость в квартирах круглый год" }),
  rate("p5", "tbilisi", "Михаил", stars(6, 3)),
];
const PIN_REPO = () => repo({ places: PIN_PLACES, ratings: PIN_RATINGS });
const CIVIDIS = ["#00224e", "#35456c", "#666970", "#a59c74", "#fee838"];

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `(await import("./js/app.js")).state`;
const PIN = title => `.leaflet-marker-icon[title="${title}"]`;

async function open({ w = 390, h = 844, dark = false, ...opts } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, opts);
  await page.waitFor(`(async () => { const s = ${APP}; return !!s.world.cities && (location.hash !== "#/map" || !!s.mapView); })()`, 10000, "world cities loaded");
  await still();
  page.takeErrors();
}

const still = () => page.waitFor(`(async () => {
  const s = ${APP}; const m = s.mapView && s.mapView.map; if (!m || location.hash !== "#/map") return true;
  const k = () => m.getCenter().lat.toFixed(5) + "," + m.getCenter().lng.toFixed(5) + "," + m.getZoom();
  const a = k(); await new Promise(r => setTimeout(r, 130)); const b = k(); await new Promise(r => setTimeout(r, 130));
  return !m._animatingZoom && a === b && b === k();
})()`, 8000, "map stopped moving");

const sheetText = () => page.eval(`document.getElementById("sheet").hidden ? "" : document.getElementById("sheetBody").innerText`);
const sheetTitle = () => page.eval(`document.getElementById("sheet").hidden ? "" : (document.querySelector("#sheetBody h3") || {}).innerText || ""`);
const legend = () => page.eval(`document.getElementById("legendBox").hidden ? "" : document.getElementById("legendBox").innerText`);
const lastEnds = () => page.eval(`(() => { const e = [...document.querySelectorAll("#legendBox .ends")].pop(); return e ? e.innerText.replace(/\\s+/g, " ").trim() : ""; })()`);
const suggestions = () => page.eval(`document.getElementById("searchResults").hidden ? "" : document.getElementById("searchResults").innerText`);
const suggestionTitles = () => page.eval(`[...document.querySelectorAll("#searchResults button")].map(b => b.childNodes[0].textContent.trim())`);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const tipText = () => page.eval(`document.getElementById("tip").hidden ? "" : document.getElementById("tip").innerText`);

async function typeSearch(q) {
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
}

async function openCity(q, name = q) {
  await typeSearch(q);
  await page.waitFor(`[...document.querySelectorAll("#searchResults button")].some(b => b.childNodes[0].textContent.trim() === ${JSON.stringify(name)})`, 5000, "suggestion " + name);
  await page.tap({ text: name, within: "#searchResults" });
  await still();
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${JSON.stringify(name)}; })()`, 5000, "sheet of " + name);
}

async function openPin(title) {
  await page.tap({ sel: PIN(title) });
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${JSON.stringify(title)}; })()`, 4000, "sheet of " + title);
}

async function tapMap(lat, lng) {
  const p = await page.eval(`(async () => { const s = ${APP}; const r = document.getElementById("map").getBoundingClientRect(); const p = s.mapView.map.latLngToContainerPoint([${lat}, ${lng}]); return { x: r.left + p.x, y: r.top + p.y }; })()`);
  const hit = await page.eval(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e && document.getElementById("map").contains(e) && !e.closest(".leaflet-marker-icon") ? "" : (e ? e.id || e.className || e.tagName : "nothing"); })()`);
  assert.equal(hit, "", `map point ${lat},${lng} is not free to tap (${hit})`);
  await page.click(p.x, p.y);
  await sleep(300);
}

async function openCountry(lat, lng, name) {
  await tapMap(lat, lng);
  await page.waitFor(`(document.querySelector("#sheetBody h3") || {}).innerText === ${JSON.stringify(name)}`, 4000, "country sheet " + name);
}

async function layers() {
  if (await page.eval(`document.getElementById("layersPanel").hidden`)) await page.tap({ sel: "#layersBtn" });
}

async function similarCities() {
  await page.tap({ text: "Похожие города", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simCityBox [data-city]").length >= 5`, 6000, "similar cities");
}

const COLOR = `(() => { const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true }); return c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(","); }; })()`;
const RATIO = `(() => { const rgb = ${COLOR}; const lum = s => { const [r, g, b] = s.split(",").map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; return (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100; }; })()`;

/* ---------- search ---------- */
test("a world city typed in Latin, in lower case or in Cyrillic opens the same city sheet with country and population", { skip }, async () => {
  await open();
  for (const q of ["Budva", "budva", "Будва"]) {
    await typeSearch(q);
    await page.waitFor(`/Будва/.test(document.getElementById("searchResults").innerText)`, 4000, "suggestion for " + q);
    const sug = await suggestions();
    assert.match(sug, /города мира[\s\S]*Будва/i, q);
    assert.match(sug, /Будва[\s\S]*Черногория · 18 тыс\. жителей/, q);
    await page.tap({ text: "Будва", within: "#searchResults" });
    await still();
    assert.equal(await sheetTitle(), "Будва", q);
    assert.match(await sheetText(), /Черногория[\s\S]*18 тыс\. жителей/, q);
    await page.tap({ sel: "#sheetClose" });
  }
  assert.deepEqual(page.takeErrors(), []);
});

test("typing a country name in Russian or English offers that country and opens its sheet", { skip }, async () => {
  await open();
  for (const q of ["Черногория", "Montenegro"]) {
    await typeSearch(q);
    await page.waitFor(`!document.getElementById("searchResults").hidden`, 3000, "suggestions");
    const titles = await suggestionTitles();
    assert.ok(titles.includes("Черногория"), `«${q}» offers only: ${titles.join(" | ")} — to open a country the user has to find it on the map by hand`);
  }
  await page.tap({ text: "Черногория", within: "#searchResults" });
  await still();
  assert.equal(await sheetTitle(), "Черногория");
  assert.match(await sheetText(), /Похожие страны/);
});

test("on a phone the «search everywhere» row does not tell the user to press Enter", { skip }, async () => {
  await open();
  await typeSearch("Херцег");
  await page.waitFor(`/везде/.test(document.getElementById("searchResults").innerText)`, 3000, "search-everywhere row");
  const row = await page.eval(`[...document.querySelectorAll("#searchResults button")].pop().innerText.replace(/\\s+/g, " ")`);
  assert.match(row, /Искать «Херцег» везде/);
  assert.doesNotMatch(row, /Enter/, `an iPhone keyboard has no Enter key, its key says «Найти»: «${row}»`);
});

/* ---------- city sheet ---------- */
test("a city sheet names its climate type in words, not only by a code like Cfa", { skip }, async () => {
  await open();
  await openCity("Будва");
  const chips = await page.eval(`[...document.querySelectorAll("#sheetBody .chips .chip")].map(c => c.innerText)`);
  const k = chips.find(c => /Cfa/.test(c));
  assert.ok(k, chips.join(" | "));
  assert.match(k, /климат/i, `the chip «${k}» does not say it is the climate type`);
});

test("the climate chart on a city sheet shows twelve months, a °C scale and a dashed SPb line named in its legend", { skip }, async () => {
  await open();
  await openCity("Будва");
  const c = await page.eval(`(() => { const s = document.querySelector('#sheetBody svg[aria-label="Климат по месяцам"]'); const t = [...s.querySelectorAll("text")].map(x => x.textContent); return { months: t.filter(x => /^[а-я]{3}$/.test(x)), degrees: t.filter(x => /°$/.test(x)).length, lines: s.querySelectorAll("polyline").length, dashed: s.querySelectorAll("polyline[stroke-dasharray]").length, legend: s.closest(".clim").nextElementSibling.innerText }; })()`);
  assert.deepEqual(c.months, ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]);
  assert.ok(c.degrees >= 3, "temperature axis in degrees");
  assert.equal(c.lines, 2, "Budva and SPb");
  assert.equal(c.dashed, 1, "SPb line is dashed");
  assert.match(c.legend, /Будва, средняя °C/);
  assert.match(c.legend, /СПб, °C/);
  assert.match(c.legend, /осадки, мм/);
});

test("tapping a month's rain bar on the climate chart shows that month's numbers, not only the tiny dot on the line", { skip }, async () => {
  await open();
  await openCity("Будва");
  const r = await page.eval(`(() => { const b = document.querySelectorAll('#sheetBody .clim rect')[6]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 2, h: r.height }; })()`);
  assert.ok(r.h > 4, "July bar is drawn");
  await page.click(r.x, r.y);
  await sleep(150);
  assert.match(await tipText(), /^июл/, "a finger on the July bar gets no numbers; only a 12 px dot on the temperature line answers");
});

test("in light and dark mode the dashed SPb line on the climate chart stands out from the sheet (at least 3:1)", { skip }, async () => {
  for (const dark of [false, true]) {
    await open({ dark });
    await openCity("Будва");
    const r = await page.eval(`(() => { const ratio = ${RATIO}; const l = document.querySelector('#sheetBody .clim polyline[stroke-dasharray]'); return ratio(getComputedStyle(l).stroke, getComputedStyle(document.getElementById("sheet")).backgroundColor); })()`);
    assert.ok(r >= 3, `${dark ? "dark" : "light"}: SPb comparison line contrast ${r}:1`);
  }
});

/* ---------- world data in a sheet ---------- */
test("the visa row says in words when a Russian passport needs a visa", { skip }, async () => {
  await open();
  await openCity("Тирана");
  const row = await page.eval(`(() => { const r = [...document.querySelectorAll("#sheetBody .world-row")].find(r => /Безвиз/.test(r.innerText)); return r ? { name: r.firstElementChild.childNodes[0].textContent, v: r.querySelector(".v").innerText } : null; })()`);
  assert.ok(row, "visa row is shown");
  assert.match(row.v, /виз/i, `Albania shows «${row.v}» for «${row.name}» — a bare zero instead of saying a visa is needed`);
});

test("world-data notes do not leak data-file jargon like «третий элемент»", { skip }, async () => {
  await open();
  await openCity("Тирана");
  const notes = await page.eval(`[...document.querySelectorAll("#sheetBody .world-row small")].map(s => s.innerText)`);
  const bad = notes.filter(n => /элемент|\\[|\\]/.test(n));
  assert.deepEqual(bad, [], "notes speak about the data file's structure, not about the country");
});

test("every world indicator without a unit says its scale, so a bare number like 0.45 can be read", { skip }, async () => {
  await open();
  await openCity("Тирана");
  const rows = await page.eval(`[...document.querySelectorAll("#sheetBody .world-row")].map(r => ({ name: r.firstElementChild.childNodes[0].textContent.trim(), v: r.querySelector(".v").innerText.trim() }))`);
  const bare = rows.filter(r => /^-?[\d\s.,]+$/.test(r.v) && !/Население/.test(r.name));
  assert.ok(bare.length >= 5, "unitless rows are shown");
  const unclear = bare.filter(r => !/\d\s*[–-]\s*[+−-]?\d|от\s*[+−-]?\d[\d,.]*\s*до\s*[+−-]?\d|=\s*100|на 100/.test(r.name)).map(r => `${r.name}: ${r.v}`);
  assert.deepEqual(unclear, [], "these numbers have no range or unit, so nobody can tell if they are high or low");
});

test("the «3 — как в России» note under world data holds for Russia's own scores, or the exceptions are marked", { skip }, async () => {
  await open({ local: view(57, 45, 5) });
  await openCountry(57, 45, "Россия");
  const w = await page.eval(`(() => { const w = document.querySelector("#sheetBody .world"); return { note: w.querySelector("p").innerText, rows: [...w.querySelectorAll(".world-row")].map(r => ({ text: r.innerText.replace(/\\s+/g, " "), s: r.querySelector(".s").innerText.trim() })).filter(r => r.s) }; })()`);
  assert.ok(w.rows.length >= 5, "Russia has scored rows");
  const claims = /3\s*—\s*как в России/.test(w.note);
  const off = w.rows.filter(r => r.s !== "3.0" && !/абсолют|порог|фиксирован|не от России/i.test(r.text)).map(r => r.text);
  assert.ok(!claims || !off.length, `the note says «${w.note}», but Russia itself scores:\n${off.join("\n")}`);
});

/* ---------- forecast ---------- */
test("a city's forecast says it is a 1–5 score where 3 means like SPb", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await openCity("Будва");
  const big = await page.eval(`(() => { const b = document.querySelector("#sheetBody .bigscore"); return b ? b.innerText.replace(/\\s+/g, " ") : ""; })()`);
  assert.match(big, /^\d\.\d прогноз/, big);
  assert.match(big, /из 5/, `«${big}» — out of what?`);
  assert.match(big, /3\s*—\s*как в СПб/, `«${big}» — is 3.3 good or bad?`);
});

test("a city's forecast names the rated places it is based on", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await openCity("Будва");
  const t = await sheetText();
  assert.match(t, /прогноз/);
  const named = ["Порту", "Валенсия", "Батуми"].filter(n => t.includes(n));
  assert.ok(named.length >= 1, `the forecast says «по похожим оценённым местам» but never which ones, so the user cannot tell why Budva gets this number:\n${t.slice(0, 300)}`);
});

test("the forecast top list in «Слои» tells how sure each forecast is", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await layers();
  await page.select("#lyCity", "Прогноз");
  await page.waitFor(`document.querySelectorAll("#layersPanel .ptop button").length === 10`, 8000, "top 10");
  const rows = await page.eval(`[...document.querySelectorAll("#layersPanel .ptop button")].map(b => b.innerText.replace(/\\s+/g, " "))`);
  const scores = new Set(rows.map(r => (r.match(/\d\.\d/) || [""])[0]));
  const bare = rows.filter(r => !/уверенн|\d+\s*%/.test(r));
  assert.ok(!bare.length || scores.size > 3, `ten rows with ${scores.size} distinct score(s) and no confidence — the order looks arbitrary:\n${rows.join("\n")}`);
});

test("the forecast legend says which colour means «as in SPb»", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await layers();
  await page.select("#lyCity", "Прогноз");
  await page.waitFor(`/Прогноз для нас/.test(document.getElementById("legendBox").innerText)`, 8000, "forecast legend");
  const ends = await lastEnds();
  assert.match(ends, /хуже/);
  assert.match(ends, /СПб|3/, `forecast legend «${ends}»: worse or better than what?`);
});

test("a world city that is already one of our rated places shows our total, not a forecast that contradicts it", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await openCity("Лиссабон");
  await similarCities();
  await page.tap({ text: "Порту", within: "#simCityBox" });
  await page.waitFor(`(document.querySelector("#sheetBody h3") || {}).innerText === "Порту" && /Наше место/.test(document.getElementById("sheetBody").innerText)`, 5000, "Porto city sheet");
  const big = await page.eval(`(() => { const b = document.querySelector("#sheetBody .bigscore"); return b ? b.innerText.replace(/\\s+/g, " ") : ""; })()`);
  const ours = await page.eval(`(async () => { const s = ${APP}; const m = await import("./js/views.js"); const p = s.M.PLACE.porto; return m.placeScore(s.M, p, (await import("./js/calc.js")).normalize(s.schema.groups, s.weights)).score.toFixed(1); })()`);
  assert.ok(!/прогноз/.test(big) || big.startsWith(ours), `we rated Порту ${ours}, yet its city sheet says «${big}»`);
});

/* ---------- adding a found city ---------- */
test("a found city added as a candidate leads on to its dossier with world data and similar places", { skip }, async () => {
  await open();
  await openCity("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  assert.match(await toastText(/Добавлено/), /Добавлено: Будва/);
  const saved = JSON.parse((await mockFiles(page))["places/budva.json"]);
  assert.deepEqual({ name: saved.name, cc: saved.cc, status: saved.status, geonameid: saved.geonameid }, { name: "Будва", cc: "MNE", status: "кандидат", geonameid: 3203106 });
  assert.equal(await sheetTitle(), "Будва");
  assert.match(await sheetText(), /кандидат[\s\S]*оценок: 0[\s\S]*только мировые данные/);
  await page.tap({ text: "Досье", within: "#sheet" });
  await page.waitFor(`location.hash === "#/place/budva" && document.getElementById("simBox") && !/Считаю/.test(document.getElementById("simBox").innerText)`, 8000, "dossier with similar places");
  const d = await page.eval(`({ h1: document.querySelector("#v-place h1").innerText, text: document.getElementById("v-place").innerText, chart: !!document.querySelector("#v-place .clim svg"), sim: document.querySelectorAll("#simBox [data-city]").length })`);
  assert.equal(d.h1, "Будва");
  assert.match(d.text, /Мы здесь ещё не были/);
  assert.ok(d.chart, "climate chart");
  assert.ok(d.sim >= 3, "similar places");
  assert.deepEqual(page.takeErrors(), []);
});

test("right after «Добавить как место» the new pin with its score is on top, not hidden under the black selection dot", { skip }, async () => {
  await open();
  await openCity("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  await toastText(/Добавлено/);
  await still();
  const hit = await page.eval(`(() => { const m = document.querySelector('${PIN("Будва")}'); if (!m) return "no pin"; const r = m.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return m.contains(e) ? "" : ((e.className && e.className.baseVal) || e.className || e.tagName); })()`);
  assert.equal(hit, "", "the new pin and its score are covered by the temporary marker of the picked city");
});

test("adding a city keeps its forecast on the new place's sheet instead of silently showing another number", { skip }, async () => {
  await open({ files: repo({ ratings: RATED4 }) });
  await openCity("Будва");
  const before = await page.eval(`document.querySelector("#sheetBody .bigscore").innerText.replace(/\\s+/g, " ")`);
  assert.match(before, /прогноз/);
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  await toastText(/Добавлено/);
  const after = await page.eval(`document.querySelector("#sheetBody .bigscore").innerText.replace(/\\s+/g, " ")`);
  assert.match(await sheetText(), /прогноз/, `before: «${before}»; after adding: «${after}» — the forecast is gone and a different number appears`);
});

/* ---------- similar ---------- */
test("«Похожие города» says the percentage is similarity and that it follows our weights from «Рейтинг»", { skip }, async () => {
  await open();
  await openCity("Будва");
  await similarCities();
  const box = await page.text("#simCityBox");
  assert.match(box, /сходств/i, "a bare «99%» — similarity? chance we like it?");
  assert.match(box, /Рейтинг/, "«веса «Оба»» means nothing on the map; say they are the weights from «Рейтинг»");
});

test("«Похожие страны» says what is compared and what the percentage means", { skip }, async () => {
  await open({ local: view(39.6, -8.0, 6) });
  await openCountry(39.6, -8.0, "Португалия");
  await page.tap({ text: "Похожие страны", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simCountryBox [data-country]").length >= 3`, 4000, "similar countries");
  const head = await page.eval(`(() => { const b = document.getElementById("simCountryBox").cloneNode(true); b.querySelectorAll(".sim").forEach(x => x.remove()); return b.innerText.replace(/\\s+/g, " "); })()`);
  assert.match(head, /сходств/i, `header «${head}»`);
  assert.match(head, /показател|данн|цен|безопасн/i, `header «${head}» does not say countries are compared by their indicators, not by climate or by us having been there`);
});

test("similarity reasons are plain words: no clipped abbreviations, no capitals in the middle of a list", { skip }, async () => {
  await open({ local: view(39.6, -8.0, 6) });
  await openCountry(39.6, -8.0, "Португалия");
  await page.tap({ text: "Похожие страны", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simCountryBox .sim-row small").length >= 3`, 4000, "reasons");
  const reasons = await page.eval(`[...document.querySelectorAll("#simCountryBox .sim-row small")].map(s => s.innerText)`);
  const items = reasons.flatMap(r => r.split(" · ").map(x => x.replace(/^(похожи|отличаются): /, "")).flatMap(x => x.split(", ")));
  const clipped = [...new Set(items.filter(x => /[а-яё]\.$/i.test(x)))];
  const capital = [...new Set(items.filter(x => /^[А-ЯЁ][а-яё]/.test(x)))];
  assert.deepEqual(clipped, [], "abbreviations like «Землетряс.» read as typos");
  assert.deepEqual(capital, [], "list items start with capitals mid-sentence while others («размер города») do not");
});

test("in a similar-places row the city name and its country are visibly apart", { skip }, async () => {
  await open();
  await openCity("Будва");
  await similarCities();
  const gap = await page.eval(`(() => { const b = document.querySelector("#simCityBox [data-city]"); const r1 = document.createRange(); r1.selectNodeContents(b.firstChild); const tn = b.querySelector("span").firstChild; const i = tn.textContent.indexOf("·"); const r2 = document.createRange(); r2.setStart(tn, i); r2.setEnd(tn, i + 1); return Math.round(r2.getBoundingClientRect().left - r1.getBoundingClientRect().right); })()`);
  assert.ok(gap >= 3, `«Херцег-Нови· Черногория»: the dot sticks to the name (gap ${gap}px)`);
});

test("after «Показать все на карте» on a phone, the city they are compared with is marked on the map", { skip }, async () => {
  await open();
  await openCity("Будва");
  await similarCities();
  await page.tap({ text: "Показать все на карте", within: "#sheet" });
  await page.waitFor(`/Похожие на «Будва»/.test(document.getElementById("legendBox").innerText)`, 5000, "similar legend");
  await still();
  const marks = await page.eval(`(async () => { const s = ${APP}; const map = s.mapView.map, el = document.getElementById("map").getBoundingClientRect(); let n = 0; map.eachLayer(l => { if (!l.getLatLng || l instanceof window.L.Tooltip) return; const p = l.getLatLng(); if (Math.abs(p.lat - 42.287) < 0.05 && Math.abs(p.lng - 18.839) < 0.05) { const c = map.latLngToContainerPoint(p); if (c.x > 0 && c.y > 0 && c.x < el.width && c.y < el.height) n++; } }); return n; })()`);
  assert.ok(marks >= 1, "60 similar dots are drawn but Budva itself is nowhere on the map");
});

test("the similarity legend says in words that its colours mean more or less similar", { skip }, async () => {
  await open();
  await openCity("Будва");
  await similarCities();
  await page.tap({ text: "Показать все на карте", within: "#sheet" });
  await page.waitFor(`/Похожие на «Будва»/.test(document.getElementById("legendBox").innerText)`, 5000, "similar legend");
  const ends = await lastEnds();
  assert.match(ends, /похож/i, `legend ends «${ends}» — less or more of what?`);
});

/* ---------- layers panel and legends ---------- */
test("the layers panel explains every kind of pin: SPb square, hollow, faded and a numbered cluster", { skip }, async () => {
  await open({ files: PIN_REPO() });
  await layers();
  const t = await page.text("#layersPanel");
  assert.match(t, /полый/i);
  const missing = [[/квадрат/i, "square = SPb"], [/бледн|полупрозрач|блекл|тускл/i, "faded pin"], [/отсе|вето/i, "why a pin is faded"], [/несколько мест|мест рядом|сколько мест/i, "numbered cluster"]].filter(([re]) => !re.test(t)).map(([, w]) => w);
  assert.deepEqual(missing, [], "after the intro is dismissed this panel is the only place that explains pins, and it skips these");
});

test("the first-visit intro also explains faded pins of rejected or vetoed places", { skip }, async () => {
  await open({ intro: true, files: PIN_REPO() });
  assert.equal(await sheetTitle(), "Как пользоваться картой");
  assert.ok(await page.eval(`document.querySelectorAll(".pin.out").length > 0`), "faded pins are on the map");
  const t = await sheetText();
  assert.match(t, /бледн|полупрозрач|блекл|тускл/i, "faded pins are not explained");
  assert.match(t, /отсе|вето/i);
});

test("the cities note does not promise «синее — лучше СПб» for layers coloured by plain values", { skip }, async () => {
  await open();
  await layers();
  await page.select("#lyCity", "Июль, средняя");
  await page.waitFor(`(async () => (${APP}).mapView.cityLayer.getLayers().length > 1000)()`, 8000, "city dots");
  const desc = await page.eval(`document.getElementById("lyCity").closest(".field").querySelector(".desc").innerText`);
  const fills = await page.eval(`(async () => [...new Set((${APP}).mapView.cityLayer.getLayers().map(l => l.options.fillColor))])()`);
  const plain = fills.some(f => CIVIDIS.includes(f));
  assert.ok(plain, "this layer uses the plain-value palette");
  assert.doesNotMatch(desc, /синее\s*—\s*лучше/, `the panel says «${desc}», but dark-blue dots here are just the coldest Julys, not «better than SPb»`);
});

test("every country colouring has a legend with its name, source and what no fill means, in both modes", { skip }, async () => {
  await open();
  await layers();
  const opts = await page.eval(`[...document.querySelectorAll("#lyCountry option")].filter(o => o.value).map(o => ({ v: o.value, t: o.text }))`);
  assert.ok(opts.length >= 10);
  const bad = [];
  for (const o of opts) {
    await page.select("#lyCountry", o.v);
    for (const mode of ["rel", "raw"]) {
      await page.tap({ sel: `#lyMode [data-mode=${mode}]` });
      const t = await legend();
      if (!t.includes(o.t) || !/нет данных/.test(t) || !/World Bank|INFORM|V-Dem|passport/.test(t)) bad.push(`${mode} ${o.t}: ${t.replace(/\s+/g, " ")}`);
      if (mode === "raw" && !/\d[\s\S]*\d/.test(await lastEnds())) bad.push(`raw ends without values: ${o.t}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(page.takeErrors(), []);
});

test("every city layer has a legend with its title and both ends", { skip }, async () => {
  await open();
  await layers();
  const opts = await page.eval(`[...document.querySelectorAll("#lyCity option")].filter(o => o.value && !o.disabled && !["similar", "predict"].includes(o.value)).map(o => ({ v: o.value, t: o.text }))`);
  assert.ok(opts.length >= 12);
  const bad = [];
  for (const o of opts) {
    await page.select("#lyCity", o.v);
    await page.waitFor(`document.getElementById("legendBox").innerText.includes(${JSON.stringify("Города: " + o.t)})`, 8000, "legend " + o.t);
    const ends = (await lastEnds()).split(" ").filter(Boolean);
    if (ends.length < 2) bad.push(`${o.t}: «${ends.join(" ")}»`);
  }
  assert.deepEqual(bad, []);
});

test("the raw-values country legend explains its colour groups in plain words, not only as «квантили»", { skip }, async () => {
  await open();
  await layers();
  await page.select("#lyCountry", "Уровень цен");
  await page.tap({ text: "Сырые значения", within: "#layersPanel" });
  const t = (await legend()).replace(/\s+/g, " ");
  assert.match(t, /пят\S* част|по 20|равн\S* (групп|част)|поровну/i, `«${t}» — a statistics word nobody on the trip will know; say that each colour holds a fifth of the countries`);
});

test("the «Относительно России / Сырые значения» switch explains what each mode shows", { skip }, async () => {
  await open();
  await layers();
  await page.select("#lyCountry", "Уровень цен");
  const t = await page.eval(`(() => { const f = document.getElementById("lyMode").closest(".field").cloneNode(true); f.querySelectorAll("select, #lyMode, label").forEach(x => x.remove()); return f.innerText.replace(/\\s+/g, " ").trim(); })()`);
  assert.match(t, /Росси/, `no explanation next to the switch: «${t}»`);
  assert.match(t, /значени/, `no explanation next to the switch: «${t}»`);
});

test("for every relative country colouring, the colour the legend calls «≈ Россия» is Russia's own colour", { skip }, async () => {
  await open();
  await layers();
  const opts = await page.eval(`[...document.querySelectorAll("#lyCountry option")].filter(o => o.value).map(o => ({ v: o.value, t: o.text }))`);
  const bad = [];
  for (const o of opts) {
    await page.select("#lyCountry", o.v);
    await page.tap({ sel: "#lyMode [data-mode=rel]" });
    if (!/≈ Россия/.test(await legend())) continue;
    const c = await page.eval(`(async () => { const rgb = ${COLOR}; const s = ${APP}; let ru = null; s.mapView.countryLayer.eachLayer(l => { if (l.feature.properties.iso3 === "RUS" && l.options.fillOpacity > 0) ru = l.options.fillColor; }); const mid = document.querySelectorAll("#legendBox .ramp")[0].children[2]; return { ru: ru && rgb(ru), mid: rgb(getComputedStyle(mid).backgroundColor) }; })()`);
    if (c.ru && c.ru !== c.mid) bad.push(o.t);
  }
  assert.deepEqual(bad, [], "on these fixed scales Russia is not in the middle colour, yet the legend labels the middle «≈ Россия»");
});

test("for every relative city layer, the colour the legend calls «≈ СПб» is SPb's own colour", { skip }, async () => {
  await open({ local: view(59.9, 30.3, 6) });
  await layers();
  const opts = await page.eval(`[...document.querySelectorAll("#lyCity option")].filter(o => o.value && !o.disabled && !["similar", "predict"].includes(o.value)).map(o => ({ v: o.value, t: o.text }))`);
  const bad = [];
  for (const o of opts) {
    await page.select("#lyCity", o.v);
    await page.waitFor(`document.getElementById("legendBox").innerText.includes(${JSON.stringify("Города: " + o.t)})`, 8000, "legend " + o.t);
    if (!/≈ СПб/.test(await legend())) continue;
    const c = await page.eval(`(async () => { const rgb = ${COLOR}; const s = ${APP}; const l = s.mapView.cityLayer.getLayers().find(l => Math.abs(l.getLatLng().lat - 59.939) < 0.01 && Math.abs(l.getLatLng().lng - 30.314) < 0.01); const mid = [...document.querySelectorAll("#legendBox .ramp")].pop().children[2]; return { spb: l ? rgb(l.options.fillColor) : null, mid: rgb(getComputedStyle(mid).backgroundColor) }; })()`);
    if (c.spb && c.spb !== c.mid) bad.push(o.t);
  }
  assert.deepEqual(bad, [], "SPb's own dot is not in the colour the legend calls «≈ СПб»");
});

test("the population layer legend agrees with the note on which towns are drawn", { skip }, async () => {
  await open();
  await layers();
  await page.select("#lyCity", "Население");
  await page.waitFor(`/Города: Население/.test(document.getElementById("legendBox").innerText)`, 8000, "population legend");
  const desc = await page.eval(`document.getElementById("lyCity").closest(".field").querySelector(".desc").innerText`);
  const lo = Number((await lastEnds()).split(" ")[0].replace(/\D/g, ""));
  const m = desc.match(/от (\d+) тыс/);
  assert.ok(!m || lo >= Number(m[1]) * 1000, `the note says «${m && m[0]} жителей», the legend starts at ${lo}`);
});

/* ---------- pins ---------- */
test("tapping a faded pin of a rejected place shows why it was rejected", { skip }, async () => {
  await open({ files: PIN_REPO(), local: view(41.7, 44.0, 7) });
  assert.ok(await page.eval(`!!document.querySelector('${PIN("Тбилиси")} .pin.out')`), "Tbilisi pin is faded");
  await openPin("Тбилиси");
  const t = await sheetText();
  assert.match(t, /отсев/);
  assert.match(t, /шумно по ночам/, "the sheet says «отсев» but not why");
});

test("tapping a faded pin of a vetoed place says it was vetoed", { skip }, async () => {
  await open({ files: PIN_REPO(), local: view(41.64, 41.63, 8) });
  assert.ok(await page.eval(`!!document.querySelector('${PIN("Батуми")} .pin.out')`), "Batumi pin is faded");
  await openPin("Батуми");
  const t = await sheetText();
  assert.match(t, /вето/i, `the pin is faded but its sheet says only «кандидат»:\n${t}`);
});

test("tapping a hollow pin of a place with a few own answers says they are too few for the ranking", { skip }, async () => {
  await open({ files: PIN_REPO(), local: view(39.47, -0.38, 7) });
  assert.ok(await page.eval(`!!document.querySelector('${PIN("Валенсия")} .pin.thin')`), "Valencia pin is hollow");
  await openPin("Валенсия");
  const t = await sheetText();
  assert.match(t, /мало|не в рейтинг/i, `the pin is hollow, but its sheet gives no reason:\n${t}`);
});

/* ---------- desktop and dark ---------- */
test("on a desktop the layers panel opens next to the «Слои» button", { skip }, async () => {
  await open({ w: 1280, h: 800 });
  await layers();
  const r = await page.eval(`(() => { const b = document.getElementById("layersBtn").getBoundingClientRect(), p = document.getElementById("layersPanel").getBoundingClientRect(); return { b: [b.left, b.right], p: [p.left, p.right], gap: Math.max(0, p.left - b.right, b.left - p.right) }; })()`);
  assert.ok(r.gap <= 100, `button at ${r.b.map(Math.round)}, panel at ${r.p.map(Math.round)} — ${Math.round(r.gap)}px away on the other side of the map`);
});

test("on a desktop a city picked in search stays visible beside the side sheet", { skip }, async () => {
  await open({ w: 1280, h: 800 });
  await openCity("Подгорица");
  const hit = await page.eval(`(async () => { const s = ${APP}; const r = document.getElementById("map").getBoundingClientRect(); const p = s.mapView.map.latLngToContainerPoint(s.mapView.temp.getLatLng()); const e = document.elementFromPoint(r.left + p.x, r.top + p.y); return document.getElementById("sheet").contains(e) ? "sheet" : document.getElementById("map").contains(e) ? "" : (e && (e.id || e.className)); })()`);
  assert.equal(hit, "");
});

test("in dark mode the map legend and the layers panel text are readable", { skip }, async () => {
  await open({ dark: true });
  await layers();
  await page.select("#lyCountry", "Уровень цен");
  await page.select("#lyCity", "Январь, средняя");
  await page.waitFor(`/Города: Январь/.test(document.getElementById("legendBox").innerText)`, 8000, "city legend");
  const low = await page.eval(`(() => { const ratio = ${RATIO}; const out = []; for (const root of ["legendBox", "layersPanel"]) { const bg = getComputedStyle(document.getElementById(root)).backgroundColor; for (const e of document.getElementById(root).querySelectorAll("*")) { if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue; const r = ratio(getComputedStyle(e).color, bg); if (r < 4.5) out.push(root + " «" + e.innerText.trim().slice(0, 25) + "» " + r); } } return out; })()`);
  assert.deepEqual(low, []);
});
