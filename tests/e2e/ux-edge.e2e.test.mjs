import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); page.takeErrors(); } });

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const LONG = "Сан-Себастьян-де-лос-Рейес-и-Санта-Мария-де-ла-Асунсьон-дель-Мар";
const withPlace = (...extra) => PLACES.concat(extra);
const like = (id, over) => Object.assign({}, PLACES.find(p => p.id === id), over);

async function open(files, hash, opts = {}) {
  await openApp(page, srv.url, Object.assign({ files, hash }, opts));
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 8000, "data loaded");
  await sleep(250);
}
async function go(hash, settle = 400) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(settle);
}
async function seen(js, timeout = 3000) {
  try { await page.waitFor(js, timeout); return true; } catch { return false; }
}
const viewText = () => page.eval(`document.querySelector(".view:not([hidden])")?.innerText || ""`);
const banners = sel => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel + " .banner")})].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
const noErrors = what => assert.deepEqual(page.takeErrors(), [], what + ": the page threw");
const noSideScroll = async where => {
  const r = await page.eval(`({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth })`);
  assert.ok(r.sw <= r.w, `${where}: page scrolls sideways (${r.sw} > ${r.w})`);
};

function brokenRepo() {
  const files = repo();
  files["places/broken.json"] = `{ "name": "Будва", "status": `;
  return files;
}

function fiftyPlaces() {
  const places = [PLACES[0]], ratings = [];
  for (let i = 0; i < 50; i++) {
    const id = "p" + i, month = String(1 + (i % 9)).padStart(2, "0");
    places.push({ id, name: "Место " + (i + 1), country: "Черногория", cc: "MNE", lat: 41 + (i % 10) * 0.4, lon: 15 + Math.floor(i / 10) * 0.6, status: i % 7 === 0 ? "отсев" : i % 5 === 0 ? "финалист" : "кандидат", reason: i % 7 === 0 ? "дорого" : "", archetype: "", questions: "", ext: {}, createdAt: T, updatedAt: T });
    const scores = Object.fromEntries(STAR.slice(0, 3 + (i % 8)).map((k, j) => [k, 1 + ((i + j) % 9) / 2]));
    for (const who of ["Михаил", "Вика"]) ratings.push({ id: `r${i}-${who === "Михаил" ? "m" : "v"}`, place: id, who, start: `2026-${month}-01`, end: `2026-${month}-10`, days: 10, season: "", mode: "", housing: "", retro: false, year: i % 11, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T });
  }
  return repo({ places, ratings });
}

const orphan = { id: "r9", place: "gone", who: "Михаил", start: "2026-06-01", end: "2026-06-10", days: 10, season: "", mode: "", housing: "", retro: false, year: 3, veto: "", review: "Было шумно", scores: { "шум": 2, "улица": 3 }, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T };

/* ---------- a broken file in the data repo ---------- */

test("a broken file in the data repo leaves everything else on screen, and the notice says what it means and what to do", { skip }, async () => {
  await open(brokenRepo(), "#/rank");
  assert.match(await page.text("#rank"), /Порту/, "the rest of the data is not shown");
  const b = (await banners("#v-rank")).find(x => /broken\.json/.test(x));
  assert.ok(b, "the broken file is not named on the ranking screen");
  assert.match(b, /остальн/i, `the notice does not say the rest is loaded: «${b}»`);
  assert.match(b, /исправ/i, `the notice does not say what to do: «${b}»`);
  noErrors("broken file");
});

test("a broken file in the repo does not hide unsent edits: «Записать мою» and «Выбросить» are still offered", { skip }, async () => {
  const lost = [{ at: T, path: "places/porto.json", content: JSON.stringify(like("porto", { questions: "Моя правка про сырость" })), baseOid: "old", message: "Update place porto" }];
  await open(brokenRepo(), "#/rank", { local: { "wtl:lost": lost } });
  assert.equal(await page.text("#syncText"), "Не отправлено: 1");
  const offered = await seen(`[...document.querySelectorAll("#v-rank .banner button")].some(b => /Записать мою/.test(b.innerText)) && [...document.querySelectorAll("#v-rank .banner button")].some(b => /Выбросить/.test(b.innerText))`);
  assert.ok(offered, "the unsent edit cannot be applied or dropped: banners are " + JSON.stringify(await banners("#v-rank")));
});

test("a broken file in the repo does not hide the question «Кто вы на этом устройстве?»", { skip }, async () => {
  await open(brokenRepo(), "#/rank", { me: "" });
  const asked = (await banners("#v-rank")).some(x => /Кто вы на этом устройстве/.test(x));
  assert.ok(asked, "nobody is asked who they are: banners are " + JSON.stringify(await banners("#v-rank")));
});

/* ---------- a place file missing name, status or coordinates ---------- */

const nameless = { id: "noname", cc: "MNE", ext: {} };

test("the places list still opens when a place file has no name, and that place is listed under a readable name", { skip }, async () => {
  const files = repo({ places: withPlace(nameless) });
  files["places/empty.json"] = "{}";
  await open(files, "#/places");
  const ok = await seen(`document.querySelectorAll("#plist .prow").length >= ${PLACES.length + 2}`);
  assert.ok(ok, "the list never appears: «" + (await page.text("#plist")) + "»");
  const names = await page.eval(`[...document.querySelectorAll("#plist .prow b")].map(b => b.innerText.trim())`);
  assert.ok(names.every(n => n && !/undefined|null/.test(n)), JSON.stringify(names));
  noErrors("places list");
});

test("the rating form still lists every place when one place file has no name", { skip }, async () => {
  await open(repo({ places: withPlace(nameless) }), "#/rate");
  const opts = await page.eval(`[...document.querySelectorAll("#fPlace option")].map(o => o.text)`);
  assert.equal(opts.length, PLACES.length + 1, "places missing from the form: " + JSON.stringify(opts));
  assert.ok(opts.slice(1).every(o => o.trim() && !/undefined/.test(o)), JSON.stringify(opts));
  noErrors("rating form");
});

test("a place file with neither a name nor coordinates opens its own dossier, not the previous one", { skip }, async () => {
  await open(repo({ places: withPlace(nameless) }), "#/place/porto");
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Порту"`, 4000, "Порту dossier");
  await go("#/place/noname", 600);
  const h1 = await page.eval(`document.querySelector("#v-place h1")?.innerText || ""`);
  assert.notEqual(h1, "Порту", "the old dossier stayed on screen");
  assert.ok(await page.eval(`!!document.getElementById("factsForm")`), "the dossier did not render");
  noErrors("nameless dossier");
});

test("a place without a name is not announced as «undefined» on the map", { skip }, async () => {
  await open(repo({ places: withPlace({ id: "noname2", cc: "GRC", lat: 37.0, lon: 23.0, status: "кандидат", ext: {} }) }), "#/map");
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length >= 5`, 5000, "pins");
  const labels = await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(e => [e.getAttribute("aria-label"), e.getAttribute("title")].join(" | ")).concat([...document.querySelectorAll(".pin-label")].map(e => e.innerText))`);
  assert.deepEqual(labels.filter(l => /undefined/.test(l)), []);
});

test("a place with a status the app does not know shows the same status in its header and in its card", { skip }, async () => {
  await open(repo({ places: withPlace(like("valensiya", { id: "kotor", name: "Котор", country: "Черногория", cc: "MNE", lat: 42.42, lon: 18.77, status: "думаем" })) }), "#/place/kotor");
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Котор"`, 4000, "Котор dossier");
  const chips = await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText.trim())`);
  const sel = await page.eval(`document.querySelector('#placeForm [name="status"]').value`);
  assert.ok(chips.includes(sel), `header says ${JSON.stringify(chips)}, the card's status field says «${sel}»`);
});

test("coordinates saved as text in a place file do not break the map: every place still gets its pin", { skip }, async () => {
  const files = repo({ places: withPlace(like("batumi", { id: "kobuleti", name: "Кобулети", lat: "41.82", lon: "41.78" }), like("batumi", { id: "ureki", name: "Уреки", lat: "41.99", lon: "41.77" })) });
  await open(files, "#/map");
  const NAMES = ["Санкт-Петербург", "Порту", "Валенсия", "Тбилиси", "Батуми", "Белград", "Кобулети", "Уреки"];
  await page.waitFor(`(() => { const l = [...document.querySelectorAll(".leaflet-marker-icon")].map(e => e.getAttribute("aria-label") || "").join(" "); return ${JSON.stringify(NAMES)}.every(n => l.includes(n)); })()`, 4000, "every pin").catch(() => {});
  const labels = (await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(e => e.getAttribute("aria-label") || "")`)).join(" ");
  const missing = NAMES.filter(n => !labels.includes(n));
  assert.deepEqual(missing, [], "these places have no pin");
  noErrors("map with text coordinates");
});

test("a figure saved as text or as 0 in a place file shows no score badge rather than «NaN» or «5.0»", { skip }, async () => {
  await open(repo({ places: withPlace(like("valensiya", { id: "odd", name: "Странное", facts: { rent: { v: "abc", src: "x" }, dinner: { v: 0, src: "y" } } })) }), "#/place/odd");
  await page.waitFor(`!!document.querySelector('#factsForm [name="fact_rent"]')`, 4000, "facts form");
  const badges = await page.eval(`["rent", "dinner"].map(k => { const f = document.querySelector('#factsForm [name="fact_' + k + '"]').closest(".fact"); const b = f.querySelector(".badge"); return b ? k + ": " + b.innerText : ""; }).filter(Boolean)`);
  assert.deepEqual(badges, []);
  assert.doesNotMatch(await page.text("#factsForm"), /NaN/);
});

test("a place without coordinates explains that similar places are compared by country only and claims no 100% match", { skip }, async () => {
  await open(repo({ places: withPlace({ id: "nocoords", name: "Без точки", country: "Черногория", cc: "MNE", status: "кандидат", ext: {} }) }), "#/place/nocoords");
  await page.waitFor(`document.getElementById("simBox") && !/Считаю/.test(document.getElementById("simBox").innerText)`, 8000, "similar places");
  const sim = await page.text("#simBox");
  assert.doesNotMatch(sim, /\b100%/, `«${sim.slice(0, 200)}»`);
  assert.match(sim, /по стране|нет координат|без координат/i, `no hint that only the country was compared: «${sim.slice(0, 200)}»`);
});

/* ---------- very long names and many places ---------- */

test("a 60+ character place name fits a 320 px phone on every screen without sideways scrolling", { skip }, async () => {
  await page.viewport(320, 640);
  await open(repo({ places: PLACES.map(p => (p.id === "porto" ? Object.assign({}, p, { name: LONG }) : p)) }), "#/rank");
  await noSideScroll("ranking");
  for (const h of ["#/places", "#/place/porto", "#/rate/new/porto", "#/settings"]) { await go(h, 600); await noSideScroll(h); }
  assert.match(await page.eval(`document.getElementById("fPlace").selectedOptions[0].text`), /Сан-Себастьян/);
  await go("#/map", 800);
  await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].find(e => (e.getAttribute("aria-label") || "").includes("Сан-Себастьян")).dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  await page.waitFor(`!document.getElementById("sheet").hidden`, 3000, "place sheet");
  await noSideScroll("map sheet");
  noErrors("long names");
});

test("with 50 places every one is listed, the ranking shows them, and screened-out places are named with their reason", { skip }, async () => {
  await open(fiftyPlaces(), "#/places");
  await page.waitFor(`document.querySelectorAll("#plist .prow").length === 51`, 5000, "51 rows in «Места»");
  await go("#/rank", 600);
  const rank = await page.text("#rank");
  const missing = Array.from({ length: 50 }, (_, i) => "Место " + (i + 1)).filter(n => !new RegExp(n + "(?!\\d)").test(rank));
  assert.deepEqual(missing, [], "places missing from the ranking screen");
  assert.match(rank, /Отсев:[^]*Место 8 — дорого/);
  assert.equal(await page.eval(`document.querySelectorAll("#heat tbody tr").length`), 43, "the heat map lists SPb and every candidate");
  noErrors("50 places");
});

test("the trip counter does not read «50 из 20» when there were more trips than planned", { skip }, async () => {
  await open(fiftyPlaces(), "#/rank");
  const head = await page.text("#v-rank header");
  const m = head.match(/поездок-разведок: (\d+) из (\d+)/);
  assert.ok(!m || Number(m[1]) <= Number(m[2]), `«${head.trim()}»`);
  assert.match(head, /50/, "the real number of trips is not shown");
});

/* ---------- a rating whose place was removed, weights of a stranger ---------- */

test("a rating whose place was removed counts nowhere: Settings and the ranking give the same number of ratings", { skip }, async () => {
  await open(repo({ ratings: RATINGS.concat([orphan]) }), "#/rank");
  const head = (await page.text("#v-rank header")).match(/оценок: (\d+)/);
  await go("#/settings", 500);
  const settings = (await page.text("#tokenMsg")).match(/оценок (\d+)/);
  assert.ok(head && settings, "counts not found");
  assert.equal(settings[1], head[1], `Settings says ${settings[1]}, the ranking says ${head[1]}`);
});

test("opening a rating whose place was removed says the place is gone instead of «Правка оценки: ?»", { skip }, async () => {
  await open(repo({ ratings: RATINGS.concat([orphan]) }), "#/rate/r9");
  await page.waitFor(`document.getElementById("fTop").innerText.trim().length > 0`, 4000, "edit header");
  const top = await page.text("#fTop");
  assert.doesNotMatch(top, /: \?/, `«${top}»`);
  assert.match(top, /удал|больше нет|не найден/i, `«${top}»`);
});

test("a weights file of someone who is neither of us is ignored without errors and adds no weights button", { skip }, async () => {
  await open(repo({ weights: [{ id: "petya", who: "Петя", w: { money: 90, legal: 10 }, updatedAt: T }] }), "#/rank");
  const presets = await page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText)`);
  assert.deepEqual(presets, ["Поровну", "Своё"]);
  assert.match(await page.text("#wsum"), /своих весов ещё никто не сохранил/);
  noErrors("stranger's weights");
});

/* ---------- map credits over the place sheet ---------- */

test("with a place sheet open on a phone, the map credits do not sit on top of the sheet", { skip }, async () => {
  await open(repo(), "#/map");
  await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].find(e => (e.getAttribute("aria-label") || "").startsWith("Порту")).dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  await page.waitFor(`!document.getElementById("sheet").hidden`, 3000, "place sheet");
  await page.idle(200);
  await page.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const r = await page.eval(`(() => { const a = document.querySelector(".leaflet-control-attribution"); if (!a || a.closest("[hidden]")) return null; const ar = a.getBoundingClientRect(), s = document.getElementById("sheet").getBoundingClientRect(); if (!ar.width) return null; const overlap = ar.top < s.bottom && ar.bottom > s.top && ar.left < s.right && ar.right > s.left; const hit = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2); return { overlap, onTop: !!hit && a.contains(hit) }; })()`);
  assert.ok(!r || !(r.overlap && r.onTop), "the «© OpenStreetMap · Natural Earth» line is drawn over the place sheet");
});
