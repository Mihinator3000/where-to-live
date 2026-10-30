import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles, mockLog } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- fixtures (synthetic data only) ---------- */
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const stars = (n, v) => Object.fromEntries(STAR.slice(0, n).map(k => [k, v]));
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rate = (id, placeId, who, scores, extra = {}) => Object.assign({}, RATINGS[0], { id, place: placeId, who, scores, review: "", year: 6 }, extra);
const view = (lat, lng, z) => ({ "wtl:view": { c: { lat, lng }, z } });
const MNE = [place("budva", "Будва", "Черногория", "MNE", 42.287, 18.839), place("bar", "Бар", "Черногория", "MNE", 42.094, 19.098), place("herceg-novi", "Херцег-Нови", "Черногория", "MNE", 42.453, 18.538)];
const THREE_RATED = [...RATINGS, rate("r5", "batumi", "Михаил", { "интернет": 3, "улица": 3, "море": 4, "эстетика": 3 })];

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `(await import("./js/app.js")).state`;
const PIN = title => `.leaflet-marker-icon[title="${title}"]`;

async function open({ w = 390, h = 844, dark = false, ...opts } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, opts);
  await page.waitFor(`(async () => { const s = ${APP}; return !!s.world.cities && (location.hash !== "#/map" || !!s.mapView); })()`, 10000, "world cities loaded");
  await still();
}

const still = () => page.waitFor(`(async () => {
  const s = ${APP}; const m = s.mapView && s.mapView.map; if (!m || location.hash !== "#/map") return true;
  const k = () => m.getCenter().lat.toFixed(5) + "," + m.getCenter().lng.toFixed(5) + "," + m.getZoom();
  const a = k(); await new Promise(r => setTimeout(r, 130)); const b = k(); await new Promise(r => setTimeout(r, 130));
  return !m._animatingZoom && a === b && b === k();
})()`, 8000, "map stopped moving");

async function reload() {
  await page.eval(`window.__beforeReload = true`);
  await page.send("Page.reload");
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 10000, "page reloaded");
  await page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 8000, "app booted");
  await page.waitFor(`(async () => !!(${APP}).mapView)()`, 5000, "map ready");
  await still();
}

const sheetOpen = () => page.eval(`!document.getElementById("sheet").hidden`);
const sheetText = () => page.eval(`document.getElementById("sheet").hidden ? "" : document.getElementById("sheetBody").innerText`);
const sheetTitle = () => page.eval(`document.getElementById("sheet").hidden ? "" : (document.querySelector("#sheetBody h3") || {}).innerText || ""`);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const suggestions = () => page.eval(`document.getElementById("searchResults").hidden ? null : document.getElementById("searchResults").innerText`);
const suggestionTitles = () => page.eval(`[...document.querySelectorAll("#searchResults button")].map(b => b.childNodes[0].textContent.trim())`);
const legend = () => page.eval(`document.getElementById("legendBox").hidden ? "" : document.getElementById("legendBox").innerText`);
const layersOpen = () => page.eval(`!document.getElementById("layersPanel").hidden`);
const doc = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const pending = () => page.eval(`JSON.parse(localStorage.getItem("wtl:pending") || "[]")`);

async function typeSearch(q) {
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
}

async function searchEverywhere(q) {
  await typeSearch(q);
  await page.key("Enter");
  await page.waitFor(`(() => { const r = document.getElementById("searchResults"); return !r.hidden && !/Ищу в OpenStreetMap/.test(r.innerText); })()`, 6000, "OpenStreetMap answered");
}

async function pick(text, nth = 0) {
  await page.tap({ text, within: "#searchResults", nth });
  await still();
}

async function openPin(title) {
  await page.tap({ sel: PIN(title) });
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${JSON.stringify(title)}; })()`, 4000, "sheet of " + title);
}

async function mapPoint(lat, lng) {
  return page.eval(`(async () => { const s = ${APP}; const r = document.getElementById("map").getBoundingClientRect(); const p = s.mapView.map.latLngToContainerPoint([${lat}, ${lng}]); return { x: r.left + p.x, y: r.top + p.y }; })()`);
}

async function centre(lat, lng, z) {
  await page.eval(`(async () => void (${APP}).mapView.map.setView([${lat}, ${lng}], ${z}, { animate: false }))()`);
  await still();
}

async function tapMap(lat, lng) {
  const p = await mapPoint(lat, lng);
  const hit = await page.eval(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e && document.getElementById("map").contains(e) && !e.closest(".leaflet-marker-icon") ? "" : (e ? e.id || e.className || e.tagName : "nothing"); })()`);
  assert.equal(hit, "", `map point ${lat},${lng} is not free to tap (${hit})`);
  await page.click(p.x, p.y);
  await sleep(300);
}

async function similarCitiesSeen() {
  return page.eval(`(async () => {
    const s = ${APP}; const map = s.mapView.map, el = document.getElementById("map"), mr = el.getBoundingClientRect();
    const pts = s.mapView.cityLayer.getLayers().map(l => map.latLngToContainerPoint(l.getLatLng())).map(p => ({ x: mr.left + p.x, y: mr.top + p.y }));
    const seen = pts.filter(p => p.x > mr.left && p.x < mr.right && p.y > mr.top && p.y < mr.bottom && el.contains(document.elementFromPoint(p.x, p.y)));
    return { total: pts.length, seen: seen.length };
  })()`);
}

const netDown = () => page.eval(`(() => { const f = window.fetch; window.fetch = (u, i) => String(typeof u === "string" ? u : u.url).includes("nominatim.openstreetmap.org") ? Promise.reject(new TypeError("Failed to fetch")) : f(u, i); })()`);
const reverseReturns = body => page.eval(`(() => { const f = window.fetch; window.fetch = (u, i) => String(typeof u === "string" ? u : u.url).startsWith("https://nominatim.openstreetmap.org/reverse") ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(body))}, { headers: { "Content-Type": "application/json" } })) : f(u, i); })()`);
const GORI = { name: "Гори", display_name: "Гори, Шида-Картли, Грузия", lat: "41.985", lon: "44.113", osm_type: "relation", osm_id: 4410, addresstype: "town", address: { town: "Гори", country: "Грузия", country_code: "ge" } };

const CONTRAST = `(() => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgb = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = a => { const [r, g, b] = a.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  return [...document.querySelectorAll(".leaflet-marker-icon .pin:not(.base):not(.cluster)")].filter(p => p.innerText.trim()).map(p => {
    const cs = getComputedStyle(p), a = lum(rgb(cs.color)), b = lum(rgb(cs.backgroundColor));
    return { name: p.parentElement.title, text: p.innerText, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
  });
})()`;

const AUDIT = roots => `(() => {
  const out = [];
  const vis = e => { if (e.closest("[hidden]")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = e => (e.getAttribute("aria-label") || e.title || e.innerText || e.value || e.placeholder || (e.id && document.querySelector('label[for="' + e.id + '"]')?.innerText) || e.closest("label")?.innerText || "").trim();
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "")) + " «" + name(e).slice(0, 30) + "»";
  const els = [...document.querySelectorAll(${JSON.stringify(roots)})].flatMap(r => [...r.querySelectorAll("button, a[href], input, select, textarea, summary")]).filter(vis);
  for (const e of els) {
    if (!name(e)) out.push("unnamed " + desc(e));
    const inline = e.tagName === "A" && getComputedStyle(e).display === "inline" || e.classList.contains("linkbtn");
    const r = e.getBoundingClientRect();
    if (!inline && !["checkbox", "radio", "range"].includes(e.type) && Math.min(r.width, r.height) < 24) out.push("small " + desc(e) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();
    const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !(e.tagName === "INPUT" && hit.closest("label") === e.closest("label"))) out.push("covered " + desc(e) + " under " + (hit.id ? "#" + hit.id : hit.className || hit.tagName));
  }
  return out;
})()`;

/* ---------- pins ---------- */
test("every place gets a pin named after it, SPb is a square base pin whose label is always shown", { skip }, async () => {
  await open({ local: view(50, 15, 4) });
  const pins = await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(m => m.title).sort()`);
  assert.deepEqual(pins, PLACES.map(p => p.name).sort());
  const base = await page.eval(`(() => { const p = document.querySelector('${PIN("Санкт-Петербург")} .pin'); return { base: p.classList.contains("base"), radius: getComputedStyle(p).borderTopLeftRadius }; })()`);
  assert.deepEqual(base, { base: true, radius: "4px" }, "SPb pin is a square, not a circle");
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('${PIN("Порту")} .pin')).borderTopLeftRadius`), "50%");
  const labels = await page.eval(`Object.fromEntries([...document.querySelectorAll(".pin-label")].map(l => [l.innerText, getComputedStyle(l).opacity]))`);
  assert.equal(labels["Санкт-Петербург · база, 3"], "1", "base label visible when zoomed out");
  assert.equal(labels["Порту"], "0", "candidate names are hidden at continent zoom");
  assert.deepEqual(page.takeErrors(), []);
});

test("place names next to pins appear once the map is zoomed in to region level", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  const shown = await page.eval(`[...document.querySelectorAll(".pin-label")].filter(l => getComputedStyle(l).opacity === "1").map(l => l.innerText)`);
  assert.ok(shown.includes("Тбилиси") && shown.includes("Батуми"), shown.join(", "));
});

test("a place with half of the star questions answered gets a filled pin, fewer answers a hollow one", { skip }, async () => {
  const ratings = [rate("f1", "porto", "Михаил", stars(5, 4.5)), rate("f2", "valensiya", "Михаил", stars(4, 4.5))];
  await open({ files: repo({ ratings }), local: view(40.5, -4, 5) });
  const cls = await page.eval(`Object.fromEntries(["Порту", "Валенсия"].map(n => [n, document.querySelector('.leaflet-marker-icon[title="' + n + '"] .pin').classList.contains("thin")]))`);
  assert.deepEqual(cls, { "Порту": false, "Валенсия": true });
  const pinText = await page.text(`${PIN("Порту")} .pin`);
  await openPin("Порту");
  assert.equal(await page.text("#sheetBody .bigscore b"), pinText, "the pin shows the same score as the sheet");
  assert.match(pinText, /^\d\.\d$/);
});

test("rejected and vetoed places are drawn faded", { skip }, async () => {
  const places = PLACES.map(p => (p.id === "belgrad" ? Object.assign({}, p, { status: "отсев", reason: "дорого" }) : p));
  const ratings = [...RATINGS, rate("v1", "batumi", "Михаил", stars(3, 3), { veto: "сырость" })];
  await open({ files: repo({ places, ratings }), local: view(43, 30, 5) });
  const op = await page.eval(`Object.fromEntries(["Белград", "Батуми", "Тбилиси"].map(n => [n, Number(getComputedStyle(document.querySelector('.leaflet-marker-icon[title="' + n + '"] .pin')).opacity)]))`);
  assert.ok(op["Белград"] < 1, "rejected place is faded");
  assert.ok(op["Батуми"] < 1, "vetoed place is faded");
  assert.equal(op["Тбилиси"], 1);
});

test("a place without coordinates has no pin but can be found in search and opened", { skip }, async () => {
  const places = [...PLACES, place("bez-koordinat", "Бескоординатск", "Сербия", "SRB", null, null)];
  await open({ files: repo({ places }) });
  assert.equal(await page.eval(`!!document.querySelector('${PIN("Бескоординатск")}')`), false);
  await typeSearch("Бескоорд");
  assert.match(await suggestions(), /Наши места[\s\S]*Бескоординатск/i);
  await pick("Бескоординатск");
  assert.equal(await sheetTitle(), "Бескоординатск");
  assert.deepEqual(page.takeErrors(), []);
});

test("nearby places merge into a numbered cluster, and tapping it zooms in until they separate", { skip }, async () => {
  await open({ files: repo({ places: [PLACES[0], ...MNE], ratings: [] }), local: view(42.3, 18.8, 6) });
  const cluster = await page.eval(`(() => { const c = document.querySelector(".pin.cluster"); return c && { n: c.innerText, title: c.parentElement.title }; })()`);
  assert.equal(cluster.n, "3");
  assert.match(cluster.title, /Будва/);
  await page.tap({ sel: ".leaflet-marker-icon:has(.cluster)" });
  await still();
  assert.equal(await page.eval(`document.querySelectorAll(".pin.cluster").length`), 0, "no cluster left after zooming in");
  for (const n of ["Будва", "Бар", "Херцег-Нови"]) assert.equal((await page.locate(PIN(n))).covered, "", n + " pin is visible and tappable");
  assert.equal(await sheetOpen(), false, "tapping a cluster zooms, it does not open a sheet");
});

test("a place added on the other phone appears on the map after tapping the sync button", { skip }, async () => {
  await open();
  await page.eval(`(() => { const f = JSON.parse(localStorage.getItem("mock:files")); f["places/kotor.json"] = JSON.stringify(${JSON.stringify(place("kotor", "Котор", "Черногория", "MNE", 42.4247, 18.7712))}); localStorage.setItem("mock:files", JSON.stringify(f)); localStorage.setItem("mock:head", "h9"); })()`);
  assert.equal(await page.eval(`!!document.querySelector('${PIN("Котор")}')`), false);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`!!document.querySelector('${PIN("Котор")}')`, 6000, "new pin");
});

test("the score on a filled pin is readable in light mode", { skip }, async () => {
  const ratings = [rate("c1", "porto", "Михаил", stars(6, 5)), rate("c2", "batumi", "Михаил", stars(6, 3.5))];
  await open({ files: repo({ ratings }), local: view(42, 15, 4) });
  const low = (await page.eval(CONTRAST)).filter(p => p.ratio < 4.5);
  assert.deepEqual(low, [], "pin text contrast below 4.5:1");
});

/* ---------- place sheet ---------- */
test("tapping a pin opens a sheet with country, status, score and the three actions", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  const t = await sheetText();
  assert.match(t, /Грузия/);
  assert.match(t, /кандидат/);
  assert.match(t, /\d\.\d\s+из 5, где 3 — как в СПб/);
  const acts = await page.eval(`[...document.querySelectorAll("#sheetBody .btns > *")].map(b => b.innerText)`);
  assert.deepEqual(acts, ["Досье", "Оценить", "Похожие"]);
});

test("«Досье» in the place sheet opens that place's dossier", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  await page.tap({ text: "Досье", within: "#sheet" });
  await page.waitFor(`location.hash === "#/place/batumi"`, 3000, "dossier route");
  assert.equal(await page.text("#v-place h1"), "Батуми");
  assert.equal(await sheetOpen(), false, "sheet is closed when leaving the map");
});

test("«Оценить» in the place sheet opens the rating form with that place chosen", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  await page.tap({ text: "Оценить", within: "#sheet" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace")`, 3000, "rating form");
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi");
});

test("the SPb sheet says it is the base with 3.0 and offers no rating button", { skip }, async () => {
  await open({ local: view(59.9, 30.3, 6) });
  await openPin("Санкт-Петербург");
  assert.equal(await page.text("#sheetBody .bigscore b"), "3.0");
  assert.match(await sheetText(), /база/);
  const acts = await page.eval(`[...document.querySelectorAll("#sheetBody .btns > *")].map(b => b.innerText)`);
  assert.ok(!acts.includes("Оценить"), acts.join(", "));
});

test("the partner's review stays hidden in the sheet until «Показать всё равно»", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Тбилиси");
  const t = await sheetText();
  assert.match(t, /Вика скрыты, пока вы не оцените место сами/);
  assert.doesNotMatch(t, /Пыльно и шумно/);
  await page.tap({ text: "Показать всё равно", within: "#sheet" });
  await page.waitFor(`/Пыльно и шумно/.test(document.getElementById("sheetBody").innerText)`, 3000, "review revealed");
  assert.equal(await sheetTitle(), "Тбилиси", "the same sheet stays open");
});

test("«Похожие» lists similar cities at home and abroad, and tapping one opens that city", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Тбилиси");
  await page.tap({ text: "Похожие", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simPlaceBox [data-city]").length >= 5`, 5000, "similar list");
  const box = await page.text("#simPlaceBox");
  assert.match(box, /В стране: Грузия/i);
  assert.match(box, /В других странах/i);
  assert.match(box, /\d+%/);
  const name = await page.eval(`[...document.querySelectorAll("#simPlaceBox [data-city]")].pop().childNodes[0].textContent.trim()`);
  await page.tap({ sel: "#simPlaceBox [data-city]", nth: (await page.eval(`document.querySelectorAll("#simPlaceBox [data-city]").length`)) - 1 });
  await still();
  assert.equal(await sheetTitle(), name);
  assert.match(await sheetText(), /Добавить как место/);
});

test("a similar city that is already one of our places links to our dossier", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Тбилиси");
  await page.tap({ text: "Похожие", within: "#sheet" });
  await page.waitFor(`[...document.querySelectorAll("#simPlaceBox [data-city]")].some(b => /Батуми/.test(b.innerText))`, 5000, "Batumi in similar list");
  await page.tap({ text: "Батуми", within: "#simPlaceBox" });
  await still();
  await page.tap({ text: "Наше место: Батуми", within: "#sheet" });
  await page.waitFor(`location.hash === "#/place/batumi"`, 3000, "dossier");
});

test("«Показать все на карте» shows the similar cities on a phone map with their legend", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Тбилиси");
  await page.tap({ text: "Похожие", within: "#sheet" });
  await page.waitFor(`document.querySelector("#simPlaceBox [data-act=simshow]")`, 5000, "show-all button");
  await page.tap({ text: "Показать все на карте", within: "#sheet" });
  await page.waitFor(`/Похожие на «Тбилиси»/.test(document.getElementById("legendBox").innerText)`, 4000, "similar legend");
  assert.deepEqual(JSON.parse(await page.eval(`localStorage.getItem("wtl:layers")`)).simTo, { type: "place", id: "tbilisi" });
  await still();
  assert.equal((await page.locate("#legendBox")).covered, "", "the legend explaining the colours is visible");
  const r = await similarCitiesSeen();
  assert.ok(r.total >= 20, "similar cities are drawn");
  assert.ok(r.seen >= r.total / 2, `only ${r.seen} of ${r.total} similar cities can be seen on the map`);
});

test("the place sheet closes with ×, with Escape and with a tap on open sea", { skip }, async () => {
  await open({ local: view(42.5, 38.5, 6) });
  await openPin("Батуми");
  await page.tap({ sel: "#sheetClose" });
  assert.equal(await sheetOpen(), false, "×");
  await openPin("Батуми");
  await page.key("Escape");
  assert.equal(await sheetOpen(), false, "Escape");
  await openPin("Батуми");
  await tapMap(43.0, 36.0);
  assert.equal(await sheetOpen(), false, "tap on the sea");
});

test("a tapped pin is not hidden under the sheet it opens on a phone", { skip }, async () => {
  await open({ local: view(44.6, 41.6, 6) });
  assert.equal((await page.locate(PIN("Батуми"))).covered, "");
  await openPin("Батуми");
  await still();
  assert.equal((await page.locate(PIN("Батуми"))).covered, "", "the selected pin should stay in sight above the sheet");
});

test("a newly opened sheet starts at its top even if the previous one was scrolled down", { skip }, async () => {
  await open({ local: view(41.69, 44.83, 6) });
  await tapMap(44.5, 44.0);
  assert.equal(await sheetTitle(), "Россия");
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 195, y: 700, deltaX: 0, deltaY: 900 });
  await page.waitFor(`document.getElementById("sheetBody").scrollTop > 300`, 3000, "sheet scrolled");
  await page.tap({ sel: "#sheetClose" });
  await tapMap(40.4, 47.9);
  assert.equal(await sheetTitle(), "Азербайджан");
  const top = await page.eval(`(() => { const h = document.querySelector("#sheetBody h3").getBoundingClientRect(), b = document.getElementById("sheetBody").getBoundingClientRect(); return { title: h.top, body: b.top, scroll: document.getElementById("sheetBody").scrollTop }; })()`);
  assert.equal(top.scroll, 0, "new sheet opened scrolled down by " + top.scroll + "px, its title and buttons are out of sight");
});

test("the similar list in an open sheet survives a data sync", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  await page.tap({ text: "Похожие", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simPlaceBox [data-city]").length > 3`, 5000, "similar list");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 6000, "sync done");
  await sleep(200);
  assert.ok((await page.eval(`document.querySelectorAll("#simPlaceBox [data-city]").length`)) > 3, "the list the user asked for vanished after the sync");
});

test("the sheet grip visibly changes the sheet size", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  const h0 = await page.eval(`document.getElementById("sheet").getBoundingClientRect().height`);
  await page.tap({ sel: "#sheetGrip" });
  const h1 = await page.eval(`document.getElementById("sheet").getBoundingClientRect().height`);
  assert.notEqual(Math.round(h1), Math.round(h0), "«Свернуть или развернуть» did nothing visible");
});

/* ---------- country, city and found-place sheets ---------- */
test("tapping a country shows who has been there and links to our places in it", { skip }, async () => {
  await open({ local: view(39.6, -8.0, 6) });
  await tapMap(39.6, -8.0);
  assert.equal(await sheetTitle(), "Португалия");
  const t = await sheetText();
  assert.match(t, /были: Михаил, Вика/);
  assert.match(t, /Наши места: Порту/);
  assert.match(t, /Похожие страны/);
  assert.match(t, /Добавить город в этой точке/);
  await page.tap({ text: "Порту", within: "#sheet", sel: "a" });
  await page.waitFor(`location.hash === "#/place/porto"`, 3000, "dossier");
});

test("«Похожие страны» lists countries with a match and tapping one opens it", { skip }, async () => {
  await open({ local: view(42.0, 43.5, 6) });
  await tapMap(42.0, 43.5);
  assert.equal(await sheetTitle(), "Грузия");
  await page.tap({ text: "Похожие страны", within: "#sheet" });
  const rows = await page.eval(`[...document.querySelectorAll("#simCountryBox .sim-row")].map(r => r.innerText)`);
  assert.ok(rows.length >= 3, rows.join(" | "));
  assert.ok(rows.every(r => /\d+%/.test(r)));
  const first = await page.eval(`document.querySelector("#simCountryBox [data-country]").innerText`);
  await page.tap({ sel: "#simCountryBox [data-country]" });
  await still();
  assert.equal(await sheetTitle(), first);
  assert.deepEqual(page.takeErrors(), []);
});

test("with countries coloured by an indicator, the country sheet puts that indicator first", { skip }, async () => {
  await open({ local: view(39.6, -8.0, 6) });
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCountry", "Уровень цен");
  await page.tap({ text: "Готово", within: "#layersPanel" });
  await tapMap(39.6, -8.0);
  const first = await page.eval(`(() => { const h = [...document.querySelectorAll("#sheetBody .wgh")][0]; return h.innerText + " → " + h.nextElementSibling.innerText.split("\\n")[0]; })()`);
  assert.equal(first, "Показатель на карте → Уровень цен в стране (США = 100)");
});

test("«Добавить город в этой точке» finds the town at the tapped point and adds it there", { skip }, async () => {
  await open({ local: view(42.0, 43.5, 6) });
  await reverseReturns(GORI);
  await tapMap(42.0, 43.5);
  await page.tap({ text: "Добавить город в этой точке", within: "#sheet" });
  await page.waitFor(`/Добавить место/.test(document.getElementById("sheetBody").innerText)`, 5000, "found-place sheet");
  assert.equal(await sheetTitle(), "Гори");
  assert.match(await sheetText(), /О стране/);
  await page.tap({ text: "Добавить место", within: "#sheet" });
  assert.match(await toastText(/Добавлено/), /Добавлено: Гори/);
  const p = await doc("places/gori.json");
  assert.equal(p.name, "Гори");
  assert.equal(p.cc, "GEO");
  assert.equal(p.status, "кандидат");
  assert.ok(Math.abs(p.lat - 42.0) < 0.05 && Math.abs(p.lon - 43.5) < 0.05, `saved at the tapped point, not elsewhere: ${p.lat},${p.lon}`);
  assert.equal(await sheetTitle(), "Гори", "the new place's sheet is open");
});

test("if no town is found at the tapped point the user is told and can try again", { skip }, async () => {
  await open({ local: view(42.0, 43.5, 6) });
  await reverseReturns({ error: "Unable to geocode" });
  await tapMap(42.0, 43.5);
  await page.tap({ text: "Добавить город в этой точке", within: "#sheet" });
  assert.match(await toastText(/населённого/), /Здесь не нашлось населённого пункта/);
  const b = await page.eval(`(() => { const b = document.querySelector("#sheetBody [data-act=addhere]"); return { text: b.innerText, disabled: b.disabled }; })()`);
  assert.deepEqual(b, { text: "Добавить город в этой точке", disabled: false });
});

test("a world city opens a sheet with population, climate chart and a marker that goes away on close", { skip }, async () => {
  await open();
  await typeSearch("Будва");
  assert.match(await suggestions(), /Города мира[\s\S]*Будва[\s\S]*Черногория/i);
  await pick("Будва");
  assert.equal(await sheetTitle(), "Будва");
  const t = await sheetText();
  assert.match(t, /Черногория/);
  assert.match(t, /18 тыс\. жителей/);
  assert.ok(await page.eval(`!!document.querySelector('#sheetBody svg[aria-label="Климат по месяцам"]')`), "climate chart");
  assert.match(t, /Добавить как место/);
  assert.equal(await page.eval(`document.getElementById("searchInput").value`), "", "search box is cleared after picking");
  assert.equal(await page.eval(`document.querySelectorAll(".leaflet-places-pane path").length`), 1, "the picked point is marked");
  await page.tap({ sel: "#sheetClose" });
  assert.equal(await page.eval(`document.querySelectorAll(".leaflet-places-pane path").length`), 0, "marker removed with the sheet");
});

test("«Похожие города» in a city sheet lists cities and can colour them on the map", { skip }, async () => {
  await open();
  await typeSearch("Будва");
  await pick("Будва");
  await page.tap({ text: "Похожие города", within: "#sheet" });
  await page.waitFor(`document.querySelectorAll("#simCityBox [data-city]").length >= 5`, 5000, "similar cities");
  assert.match(await page.text("#simCityBox"), /Похожие · веса «Оба»/i);
  await page.tap({ text: "Показать все на карте", within: "#sheet" });
  await page.waitFor(`/Похожие на «Будва»/.test(document.getElementById("legendBox").innerText)`, 4000, "similar legend");
  await page.waitFor(`document.getElementById("toast").hidden`, 5000, "toast gone");
  await page.tap({ sel: "#layersBtn" });
  const opt = await page.eval(`(() => { const s = document.getElementById("lyCity"); return { value: s.value, disabled: s.selectedOptions[0].disabled }; })()`);
  assert.deepEqual(opt, { value: "similar", disabled: false });
});

test("tapping a world city dot on a city layer opens that city", { skip }, async () => {
  await open({ local: view(56.946, 24.106, 6) });
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCity", "Январь, средняя");
  await page.tap({ text: "Готово", within: "#layersPanel" });
  await page.waitFor(`(async () => (${APP}).mapView.cityLayer.getLayers().length > 1000)()`, 6000, "city dots");
  await tapMap(56.946, 24.106);
  assert.equal(await sheetTitle(), "Рига");
});

/* ---------- search ---------- */
test("search lists our places first, then world cities, then an offer to search everywhere", { skip }, async () => {
  await open();
  await typeSearch("Бат");
  const t = await suggestions();
  assert.match(t, /^Наши места\s+Батуми\s+Грузия\s+Города мира/i);
  assert.match(t, /Искать «Бат» везде/);
  const titles = await suggestionTitles();
  assert.equal(titles.filter(x => x === "Батуми").length, 1, "Batumi is not repeated as a world city");
});

test("Enter searches OpenStreetMap and says when everything found is already ours", { skip }, async () => {
  await open();
  await searchEverywhere("Порту");
  const t = await suggestions();
  assert.match(t, /Всё найденное уже есть среди наших мест/);
  assert.match(t, /Наши места\s+Порту/i);
});

test("«Искать везде» finds a town in OpenStreetMap that opens with «Добавить место» and «О стране»", { skip }, async () => {
  await open();
  await typeSearch("Херцег");
  await page.tap({ text: "везде", within: "#searchResults" });
  await page.waitFor(`/OpenStreetMap/i.test(document.getElementById("searchResults").innerText) && !/Ищу/.test(document.getElementById("searchResults").innerText)`, 6000, "OSM results");
  await page.tap({ text: "Херцег-Нови, Черногория", within: "#searchResults" });
  await still();
  assert.equal(await sheetTitle(), "Херцег-Нови");
  assert.match(await sheetText(), /Херцег-Нови, Черногория/);
  await page.tap({ text: "О стране", within: "#sheet" });
  assert.equal(await sheetTitle(), "Черногория");
});

test("a query nobody knows says nothing was found, and the suggestions close on a tap outside or on clearing", { skip }, async () => {
  await open();
  await searchEverywhere("Ыщщзх");
  assert.match(await suggestions(), /Ничего не нашлось/);
  await page.tap({ sel: "#layersBtn" });
  assert.equal(await suggestions(), null, "tap outside closes suggestions");
  await page.tap({ sel: "#layersBtn" });
  await typeSearch("Бат");
  assert.notEqual(await suggestions(), null);
  await page.fill("#searchInput", "");
  assert.equal(await suggestions(), null, "clearing the box hides suggestions");
});

test("picking our place from search opens its sheet with the pin centred above it", { skip }, async () => {
  await open({ local: view(50, 10, 4) });
  await typeSearch("бату");
  await pick("Батуми");
  assert.equal(await sheetTitle(), "Батуми");
  assert.equal(await page.eval(`document.getElementById("searchInput").value`), "");
  const loc = await page.locate(PIN("Батуми"));
  assert.equal(loc.covered, "");
  assert.ok(loc.y < (await page.eval(`document.getElementById("sheet").getBoundingClientRect().top`)), "pin above the sheet");
});

test("search text with markup is shown as plain text", { skip }, async () => {
  await open();
  await typeSearch(`<img src=x onerror="window.__xss=1">`);
  assert.match(await suggestions(), /Искать «<img src=x onerror="window.__xss=1">» везде/);
  assert.equal(await page.eval(`document.querySelectorAll("#searchResults img").length`), 0);
  assert.equal(await page.eval(`window.__xss === undefined`), true);
});

test("typing the Latin name of our place finds our place", { skip }, async () => {
  await open();
  await typeSearch("Porto");
  const titles = await suggestionTitles();
  assert.ok(titles.includes("Порту"), "our Порту is missing; got: " + titles.join(", "));
});

test("an exact city name is suggested even when longer names are bigger cities", { skip }, async () => {
  await open();
  await typeSearch("Бар");
  const t = await suggestions();
  assert.match(t, /\nБар\nЧерногория/, "the town called exactly «Бар» is not suggested:\n" + t);
});

test("a city typed with е instead of ё is still found", { skip }, async () => {
  await open();
  await typeSearch("Кишинев");
  assert.ok((await suggestionTitles()).includes("Кишинёв"), await suggestions());
});

test("a town that is both a world city and an OpenStreetMap result is listed once", { skip }, async () => {
  await open();
  await searchEverywhere("Херцег");
  const titles = (await suggestionTitles()).filter(x => x === "Херцег-Нови");
  assert.equal(titles.length, 1, "same town listed twice:\n" + (await suggestions()));
});

test("when OpenStreetMap can't be reached, search and «Добавить город в этой точке» say so in Russian", { skip }, async () => {
  await open({ local: view(42.0, 43.5, 6) });
  await netDown();
  await searchEverywhere("Херцег");
  const t = await suggestions();
  assert.doesNotMatch(t, /Failed to fetch/);
  assert.match(t, /связ|интернет|недоступ/i, t);
  await page.fill("#searchInput", "");
  await tapMap(42.0, 43.5);
  await page.tap({ text: "Добавить город в этой точке", within: "#sheet" });
  const msg = await toastText();
  assert.doesNotMatch(msg, /Failed to fetch/);
  assert.match(msg, /связ|интернет|недоступ/i);
});

/* ---------- adding places ---------- */
test("adding a world city saves a candidate with its coordinates, puts a pin and opens its sheet", { skip }, async () => {
  await open();
  await typeSearch("Будва");
  await pick("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  assert.match(await toastText(/Добавлено/), /Добавлено: Будва/);
  const p = await doc("places/budva.json");
  assert.deepEqual({ name: p.name, country: p.country, cc: p.cc, lat: p.lat, lon: p.lon, status: p.status, geonameid: p.geonameid }, { name: "Будва", country: "Черногория", cc: "MNE", lat: 42.287, lon: 18.839, status: "кандидат", geonameid: 3203106 });
  assert.deepEqual(await mockLog(page), [{ op: "add", path: "places/budva.json" }], "one file in one commit");
  assert.ok(await page.eval(`!!document.querySelector('${PIN("Будва")}')`), "pin drawn");
  assert.equal(await sheetTitle(), "Будва");
  assert.match(await sheetText(), /Досье[\s\S]*Оценить/);
  await page.waitFor(`document.getElementById("toast").hidden`, 5000, "toast gone");
  await typeSearch("Будв");
  assert.equal((await suggestionTitles()).filter(x => x === "Будва").length, 1, "now listed once, as our place");
});

test("adding an OpenStreetMap result saves its OSM id and country", { skip }, async () => {
  await open();
  await searchEverywhere("Бар");
  await page.tap({ text: "Бар, Черногория", within: "#searchResults" });
  await still();
  await page.tap({ text: "Добавить место", within: "#sheet" });
  assert.match(await toastText(/Добавлено/), /Добавлено: Бар/);
  const p = await doc("places/bar.json");
  assert.equal(p.country, "Черногория");
  assert.equal(p.cc, "MNE");
  assert.deepEqual(p.osm, { type: "relation", id: Math.round(42.0931 * 1000 + 19.1003) });
  assert.deepEqual([p.lat, p.lon], [42.0931, 19.1003]);
});

test("without a key, «Добавить как место» sends the user to settings and saves nothing", { skip }, async () => {
  await open({ token: false });
  assert.equal(await page.eval(`document.querySelectorAll(".leaflet-marker-icon").length`), 0, "no data, no pins");
  await typeSearch("Будва");
  await pick("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  assert.match(await toastText(), /ключ доступа/);
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  assert.deepEqual(await mockLog(page), []);
  assert.deepEqual(await pending(), []);
});

test("offline, a new place is queued, shown on the map, and sent when the network is back", { skip }, async () => {
  await open();
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await typeSearch("Будва");
  await pick("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  assert.match(await toastText(/Нет связи/), /место отправится позже/);
  assert.deepEqual((await pending()).map(c => c.path), ["places/budva.json"]);
  assert.ok(await page.eval(`!!document.querySelector('${PIN("Будва")}')`), "queued place is on the map");
  assert.equal(await doc("places/budva.json"), null);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.waitFor(`document.getElementById("toast").hidden`, 5000);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await doc("places/budva.json")).name, "Будва");
});

test("adding a town within 3 km of one of our places opens that place instead of a duplicate", { skip }, async () => {
  await open({ local: view(41.632, 41.658, 12) });
  await tapMap(41.632, 41.658);
  assert.equal(await sheetTitle(), "Грузия");
  await page.tap({ text: "Добавить город в этой точке", within: "#sheet" });
  await page.waitFor(`/Добавить место/.test(document.getElementById("sheetBody").innerText)`, 5000, "found-place sheet");
  await page.tap({ text: "Добавить место", within: "#sheet" });
  assert.match(await toastText(/уже есть/), /Это место уже есть: Батуми/);
  assert.equal(await sheetTitle(), "Батуми");
  assert.deepEqual(await mockLog(page), [], "nothing written");
});

test("if the partner has just added the same city, adding it says it already exists, not a connection error", { skip }, async () => {
  await open();
  await typeSearch("Будва");
  await pick("Будва");
  await page.eval(`(() => { const f = JSON.parse(localStorage.getItem("mock:files")); f["places/budva.json"] = JSON.stringify(${JSON.stringify(place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { questions: "пляжи" }))}); localStorage.setItem("mock:files", JSON.stringify(f)); localStorage.setItem("mock:head", "h5"); })()`);
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  const msg = await toastText();
  assert.doesNotMatch(msg, /places\/|\.json/, "technical file path shown to the user: " + msg);
  assert.match(msg, /уже есть/);
  await page.waitFor(`!/Обновляю/.test(document.getElementById("syncText").innerText)`, 5000);
  assert.doesNotMatch(await page.text("#syncText"), /Ошибка/, "sync status claims a connection error");
  assert.equal((await doc("places/budva.json")).questions, "пляжи", "partner's card is untouched");
});

/* ---------- layers ---------- */
test("«Слои» opens the panel, and «Готово», Escape and a tap on the sea close it", { skip }, async () => {
  await open({ local: view(46.5, 34, 6) });
  const expanded = () => page.eval(`document.getElementById("layersBtn").getAttribute("aria-expanded")`);
  await page.tap({ sel: "#layersBtn" });
  assert.equal(await layersOpen(), true);
  assert.equal(await expanded(), "true");
  await page.tap({ text: "Готово", within: "#layersPanel" });
  assert.equal(await layersOpen(), false, "Готово");
  assert.equal(await expanded(), "false");
  await page.tap({ sel: "#layersBtn" });
  await page.key("Escape");
  assert.equal(await layersOpen(), false, "Escape");
  await page.tap({ sel: "#layersBtn" });
  await tapMap(43.3, 34.0);
  assert.equal(await layersOpen(), false, "tap on the map");
  assert.equal(await expanded(), "false");
});

test("colouring countries shows a legend against Russia, switches to raw quantiles, and is remembered", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  assert.equal(await page.visible("#legendBox"), false, "no legend without layers");
  await page.select("#lyCountry", "Уровень цен");
  assert.match(await legend(), /Уровень цен в стране[\s\S]*хуже\s+≈ Россия\s+лучше/);
  await page.tap({ text: "Сырые значения", within: "#layersPanel" });
  assert.match(await legend(), /квантили/);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#lyMode button")].map(b => b.getAttribute("aria-pressed"))`), ["false", "true"]);
  await reload();
  assert.match(await legend(), /квантили/, "legend restored after reload");
  await page.tap({ sel: "#layersBtn" });
  assert.equal(await page.eval(`document.getElementById("lyCountry").selectedOptions[0].text`), "Уровень цен в стране (США = 100)");
  await page.select("#lyCountry", "Без раскраски");
  assert.equal(await page.visible("#legendBox"), false);
});

test("a climate city layer draws world cities and explains colours against SPb", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCity", "Январь, средняя");
  await page.waitFor(`/Города: Январь, средняя °C/.test(document.getElementById("legendBox").innerText)`, 6000, "city legend");
  assert.match(await legend(), /≈ СПб/);
  assert.ok(await page.eval(`(async () => (${APP}).mapView.cityLayer.getLayers().length > 1000)()`), "city dots drawn");
  await page.select("#lyCity", "Не показывать");
  assert.equal(await legend(), "");
  assert.equal(await page.eval(`(async () => (${APP}).mapView.cityLayer.getLayers().length)()`), 0);
});

test("«Похожие на выбранное место» becomes available after picking a place on the map", { skip }, async () => {
  await open({ local: view(41.6, 43, 6) });
  await openPin("Батуми");
  await page.tap({ sel: "#layersBtn" });
  const opt = await page.eval(`(() => { const o = document.querySelector('#lyCity option[value="similar"]'); return { disabled: o.disabled, text: o.text }; })()`);
  assert.equal(opt.disabled, false, `the option still says «${opt.text}» although a place is picked`);
});

test("«Прогноз для нас» needs three rated places, then lists a top 10 that opens cities", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  const off = await page.eval(`(() => { const o = document.querySelector('#lyCity option[value="predict"]'); return { disabled: o.disabled, text: o.text }; })()`);
  assert.deepEqual(off, { disabled: true, text: "Прогноз для нас (нужно ≥ 3 оценённых места)" });
  await open({ files: repo({ ratings: THREE_RATED }) });
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCity", "Прогноз");
  await page.waitFor(`document.querySelectorAll("#layersPanel .ptop button").length === 10`, 8000, "top 10");
  assert.match(await legend(), /Прогноз для нас/);
  const first = await page.eval(`(() => { const b = document.querySelector("#layersPanel .ptop button"); return { name: b.firstElementChild.childNodes[0].textContent.trim(), score: b.querySelector(".num").innerText }; })()`);
  assert.match(first.score, /^\d\.\d$/);
  await page.tap({ sel: "#layersPanel .ptop button" });
  await still();
  assert.equal(await layersOpen(), false);
  assert.equal(await sheetTitle(), first.name);
  assert.match(await sheetText(), new RegExp(first.score.replace(".", "\\.") + "\\s+прогноз для нас"));
});

test("unticking «Наши места» hides every pin and ticking it brings them back", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  await page.tap({ sel: "#lyPlaces" });
  assert.equal(await page.eval(`document.querySelectorAll(".leaflet-marker-icon").length`), 0);
  assert.equal(JSON.parse(await page.eval(`localStorage.getItem("wtl:layers")`)).places, false);
  await page.tap({ sel: "#lyPlaces" });
  assert.equal(await page.eval(`document.querySelectorAll(".leaflet-marker-icon").length`), PLACES.length);
});

test("«Страны, где были» outlines countries: solid where both were, dashed in my colour where only I was", { skip }, async () => {
  await open();
  const OUT = `(async () => { const s = ${APP}; const o = {}; s.mapView.countryLayer.eachLayer(l => { const i = l.feature.properties.iso3; if (["PRT", "ESP", "SRB"].includes(i)) o[i] = { color: l.options.color, weight: l.options.weight, dash: l.options.dashArray }; }); return o; })()`;
  const m = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--m").trim()`);
  const ink = await page.eval(`getComputedStyle(document.documentElement).getPropertyValue("--ink").trim()`);
  let o = await page.eval(OUT);
  assert.deepEqual(o.PRT, { color: ink, weight: 2.2, dash: null }, "both were in Portugal");
  assert.deepEqual(o.ESP, { color: m, weight: 2.2, dash: "6 4" }, "only Михаил was in Spain");
  assert.ok(o.SRB.weight < 1, "nobody was in Serbia");
  await page.tap({ sel: "#layersBtn" });
  await page.tap({ sel: "#lyVisited" });
  o = await page.eval(OUT);
  assert.ok(o.PRT.weight < 1 && o.ESP.weight < 1, "outlines removed");
});

test("the raw/relative switch is not offered while countries are not coloured", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  assert.equal(await page.eval(`document.getElementById("lyCountry").value`), "");
  const live = await page.eval(`[...document.querySelectorAll("#lyMode button")].filter(b => !b.disabled && b.getBoundingClientRect().width > 0).map(b => b.innerText)`);
  assert.deepEqual(live, [], "these buttons change nothing on the map: " + live.join(", "));
});

test("with «Слои» open on a phone, search suggestions can still be tapped", { skip }, async () => {
  await open();
  await page.tap({ sel: "#layersBtn" });
  await typeSearch("Бату");
  const loc = await page.locate({ text: "Батуми", within: "#searchResults" });
  assert.equal(loc.covered, "", "suggestion is under the layers panel");
});

/* ---------- intro, legend, layout ---------- */
test("the first visit shows how to use the map, and «Понятно» or × dismisses it for good", { skip }, async () => {
  await open({ intro: true });
  assert.equal(await sheetTitle(), "Как пользоваться картой");
  await page.tap({ text: "Понятно", within: "#sheet" });
  assert.equal(await sheetOpen(), false);
  await reload();
  assert.equal(await sheetOpen(), false, "not shown again after reload");
  await page.eval(`localStorage.removeItem("wtl:introSeen")`);
  await reload();
  assert.equal(await sheetTitle(), "Как пользоваться картой", "shown again once forgotten");
  await page.tap({ sel: "#sheetClose" });
  await reload();
  assert.equal(await sheetOpen(), false, "× also counts as seen");
});

test("without a key the intro says where to paste it", { skip }, async () => {
  await open({ intro: true, token: false });
  assert.match(await sheetText(), /вставьте ключ доступа в настройках/);
  await page.tap({ text: "настройках", within: "#sheet", sel: "a" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
});

test("the intro explains what a hollow pin means", { skip }, async () => {
  await open({ intro: true });
  assert.equal(await page.eval(`document.querySelectorAll(".pin.thin").length > 0`), true, "hollow pins are on the map");
  assert.match(await sheetText(), /полый|пуст|контур/i, "intro only explains filled pins");
});

test("changing a layer after looking at a place does not reopen the intro or close the panel", { skip }, async () => {
  await open({ intro: true, local: view(41.6, 43, 6) });
  assert.equal(await sheetTitle(), "Как пользоваться картой");
  await openPin("Батуми");
  await page.tap({ sel: "#sheetClose" });
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCountry", "Уровень цен");
  assert.equal(await layersOpen(), true, "layers panel closed by itself");
  assert.equal(await sheetOpen(), false, "intro popped up again");
});

test("on desktop the legend is not hidden behind an open country sheet", { skip }, async () => {
  await open({ w: 1280, h: 800, local: view(53.7, 28.0, 5) });
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCountry", "Уровень цен");
  await page.tap({ text: "Готово", within: "#layersPanel" });
  await tapMap(53.7, 28.0);
  assert.equal(await sheetTitle(), "Белоруссия");
  assert.equal((await page.locate("#legendBox")).covered, "", "legend is under the sheet");
});

test("a confirmation toast does not block the search box and «Слои»", { skip }, async () => {
  await open();
  await typeSearch("Будва");
  await pick("Будва");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  await toastText(/Добавлено/);
  assert.equal((await page.locate("#searchInput")).covered, "", "search box is under the toast");
  assert.equal((await page.locate("#layersBtn")).covered, "", "«Слои» is under the toast");
});

test("on desktop the sheet is a side panel and the picked place is not behind it", { skip }, async () => {
  await open({ w: 1280, h: 800, local: view(45, 15, 5) });
  await typeSearch("Бату");
  await pick("Батуми");
  const g = await page.eval(`(() => { const s = document.getElementById("sheet").getBoundingClientRect(), p = document.querySelector('${PIN("Батуми")}').getBoundingClientRect(); return { w: s.width, left: s.left, sheetRight: s.right, pinLeft: p.left }; })()`);
  assert.equal(g.w, 400);
  assert.ok(g.left < 20);
  assert.ok(g.pinLeft > g.sheetRight, "pin is to the right of the sheet");
  assert.equal((await page.locate(PIN("Батуми"))).covered, "");
});

test("the map reopens where it was left", { skip }, async () => {
  await open({ local: view(50, 10, 4) });
  await typeSearch("Бату");
  await pick("Батуми");
  const before = await page.eval(`(async () => { const m = (${APP}).mapView.map; return [m.getZoom(), +m.getCenter().lat.toFixed(2), +m.getCenter().lng.toFixed(2)]; })()`);
  await reload();
  const afterReload = await page.eval(`(async () => { const m = (${APP}).mapView.map; return [m.getZoom(), +m.getCenter().lat.toFixed(2), +m.getCenter().lng.toFixed(2)]; })()`);
  assert.deepEqual(afterReload, before);
  assert.equal(before[0], 10);
});

test("in dark mode the sheet and pins use the dark palette", { skip }, async () => {
  await open({ dark: true, local: view(41.6, 43, 6) });
  await openPin("Батуми");
  const c = await page.eval(`(() => { const lum = s => { const m = s.match(/[\\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; }; return { sheet: lum(getComputedStyle(document.getElementById("sheet")).backgroundColor), title: lum(getComputedStyle(document.querySelector("#sheetBody h3")).color), pin: lum(getComputedStyle(document.querySelector('${PIN("Батуми")} .pin')).color) }; })()`);
  assert.ok(c.sheet < 0.2, "dark sheet");
  assert.ok(c.title > 0.8, "light title");
  assert.ok(c.pin > 0.8, "light text on hollow pin");
  assert.deepEqual(page.takeErrors(), []);
});

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`at ${w}px every control in the map sheets and layers panel is named, at least 24px and not covered`, { skip }, async () => {
    const issues = [];
    await open({ w, h, files: repo({ ratings: THREE_RATED }), local: view(41.6, 43, 6) });
    await page.tap({ sel: "#layersBtn" });
    await page.select("#lyCity", "Прогноз");
    await page.waitFor(`document.querySelector("#layersPanel .ptop")`, 8000, "top 10");
    issues.push(...(await page.eval(AUDIT("#layersPanel, .map-top"))).map(x => "layers: " + x));
    await page.select("#lyCity", "Не показывать");
    await page.tap({ text: "Готово", within: "#layersPanel" });
    await openPin("Тбилиси");
    await page.tap({ text: "Похожие", within: "#sheet" });
    await page.waitFor(`document.querySelector("#simPlaceBox [data-act=simshow]")`, 5000);
    issues.push(...(await page.eval(AUDIT("#sheet"))).map(x => "place: " + x));
    await page.tap({ sel: "#simPlaceBox [data-city]" });
    await still();
    issues.push(...(await page.eval(AUDIT("#sheet"))).map(x => "city: " + x));
    await page.tap({ sel: "#sheetClose" });
    await centre(42.0, 43.5, 6);
    await tapMap(42.0, 43.5);
    await page.eval(`document.getElementById("sheetBody").scrollTop = 0`);
    await page.tap({ text: "Похожие страны", within: "#sheet" });
    issues.push(...(await page.eval(AUDIT("#sheet"))).map(x => "country: " + x));
    assert.deepEqual([...new Set(issues)], []);
    assert.deepEqual(page.takeErrors(), []);
  });
}

test("«На карте» in the dossier opens the map on that place with its sheet", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.tap({ text: "На карте" });
  await page.waitFor(`location.hash === "#/map"`, 3000);
  await still();
  assert.equal(await sheetTitle(), "Порту");
  assert.equal((await page.locate(PIN("Порту"))).covered, "");
});

test("«Показать на карте» under similar places in the dossier shows that place and its similar cities", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.waitFor(`document.getElementById("simMap")`, 8000, "similar block");
  await page.tap({ sel: "#simMap" });
  await page.waitFor(`location.hash === "#/map" && /Похожие на «Порту»/.test(document.getElementById("legendBox").innerText)`, 5000, "similar layer");
  await still();
  const pin = await page.locate(PIN("Порту"));
  const inView = await page.eval(`(() => { const p = document.querySelector('${PIN("Порту")}').getBoundingClientRect(), m = document.getElementById("map").getBoundingClientRect(); return p.left >= m.left && p.right <= m.right && p.top >= m.top && p.bottom <= m.bottom; })()`);
  assert.ok(inView && pin.covered === "", "Порту itself is not on screen");
  const r = await similarCitiesSeen();
  assert.ok(r.seen >= r.total / 2, `only ${r.seen} of ${r.total} similar cities on screen`);
});
