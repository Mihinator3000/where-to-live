import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, mockFiles } from "./fixtures.mjs";

// Lens «iPhone и Safari по-настоящему»: Михаил uses an iPhone 12 Pro with the app on the Home Screen.
// Chrome is made to look like that phone: iPhone user agent, touch (real touch events for taps, swipes,
// long presses and pinches), 390×844 upright and 844×390 sideways, notch insets, the on-screen keyboard
// (simulated by shrinking the viewport while a field has focus) and the installed app (navigator.standalone).
// Synthetic data only; GitHub and Nominatim are mocked.

const skip = !CHROME && "no Chrome";
let srv, page, UA;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CRIOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1";
const INAPP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const SIDEWAYS = { top: 0, bottom: 21, left: 47, right: 47 };
const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
const APP = `(await import("./js/app.js")).state`;
const VALENCIA_VIEW = { "wtl:view": { c: { lat: 39.47, lng: -0.38 }, z: 7 } };

// The installed (Home Screen) app: iOS sets navigator.standalone and matches display-mode: standalone.
const STANDALONE = `(() => { try {
  if (!localStorage.getItem("test:standalone")) return;
  Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });
  const mm = window.matchMedia.bind(window);
  window.matchMedia = q => /display-mode:\\s*(standalone|fullscreen)/.test(String(q)) ? { matches: true, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } } : mm(q);
} catch (e) {} })();`;

before(async () => {
  srv = await serve();
  page = await launch();
  UA = await page.eval("navigator.userAgent");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STANDALONE });
});
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => {
  if (!page) return;
  await as(IPHONE);
  await insets(NONE);
  await page.viewport(390, 844, { dark: false });
  page.takeErrors();
});

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const as = ua => page.send("Emulation.setUserAgentOverride", /iPhone/.test(ua) ? { userAgent: ua, platform: "iPhone" } : { userAgent: ua });
const insets = i => page.send("Emulation.setSafeAreaInsetsOverride", { insets: i }).catch(() => {});
const until = async (js, ms = 2500) => { try { await page.waitFor(js, ms); return true; } catch (e) { return false; } };

const point = ([x, y]) => ({ x, y, radiusX: 4, radiusY: 4, force: 1, id: 0 });
const touch = (type, pts = []) => page.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(point) });
async function fingerTap(at, { hold = 60, settle = 350 } = {}) {
  assert.ok(at, "nothing to tap");
  await touch("touchStart", [at]);
  await sleep(hold);
  await touch("touchEnd");
  await sleep(settle);
}
async function fingerSwipe(from, to, { steps = 12, ms = 260, settle = 550 } = {}) {
  await touch("touchStart", [from]);
  for (let i = 1; i <= steps; i++) {
    await touch("touchMove", [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]);
    await sleep(ms / steps);
  }
  await touch("touchEnd");
  await sleep(settle);
}
// Centre of the nth element matching sel, scrolled to the middle of the screen first (except on the map and in the card).
const spot = (sel, nth = 0) => page.eval(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; if (!e.closest(".leaflet-container, #sheet")) e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const tapSel = async (sel, nth = 0, opts) => fingerTap(await spot(sel, nth), opts);

// How many CSS px of an element can actually be seen (not covered by bars, not off screen), sampled every 2 px.
const SHOWN = `(e => { if (!e || e === document.body) return 0; const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40); let n = 0; for (let y = Math.max(0, Math.ceil(r.top)); y < Math.min(innerHeight, r.bottom); y += 2) { const h = document.elementFromPoint(x, y); if (h && (h === e || e.contains(h))) n += 2; } return n; })`;
const HIT = `(s => { const e = typeof s === "string" ? document.querySelector(s) : s; if (!e || e.closest("[hidden]")) return false; const r = e.getBoundingClientRect(); if (!r.width || r.bottom <= 0 || r.top >= innerHeight) return false; const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === e || e.contains(h)); })`;
const tip = () => page.eval(`(() => { const t = document.getElementById("tip"); return { shown: !t.hidden && t.getClientRects().length > 0 && getComputedStyle(t).visibility !== "hidden" && t.textContent.trim() !== "", text: t.textContent }; })()`);
const mapCenter = () => page.eval(`(async () => { const m = (${APP}).mapView.map; const c = m.getCenter(); return [c.lat, c.lng, m.getZoom()]; })()`);
const pinAt = name => page.eval(`(() => { const m = document.querySelector('.leaflet-marker-icon[title=${JSON.stringify(name)}]'); if (!m) return null; const r = m.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const sheetTitle = () => page.eval(`!document.getElementById("sheet").hidden && document.getElementById("sheetTitle") ? document.getElementById("sheetTitle").textContent : ""`);

async function openMap(opts = {}) {
  await openApp(page, srv.url, Object.assign({ hash: "#/map", local: VALENCIA_VIEW }, opts));
  await page.waitFor(`(async () => !!(${APP}).mapView && !!document.querySelector('.leaflet-marker-icon'))()`, 8000, "map with pins");
  await sleep(400);
}
async function openValenciaCard() {
  await fingerTap(await pinAt("Валенсия"));
  assert.ok(await until(`!document.getElementById("sheet").hidden && document.getElementById("sheetTitle")?.textContent === "Валенсия"`), "a finger tap on the Valencia pin opens its card");
}
async function openRate(place = "Батуми") {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.waitFor(`!document.getElementById("v-rate").hidden && document.querySelectorAll("#fPlace option").length > 1`, 5000, "rating form");
  if (place) await page.select("#fPlace", place);
}
async function focusField(sel) {
  await tapSel(sel);
  await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (document.activeElement !== e) e.focus({ preventScroll: true }); })()`);
  assert.equal(await page.eval(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`), true, sel + " has focus");
}
const keyboardOpens = h => page.viewport(page.vp.w, h);
const layout = () => page.eval(`(() => { const e = document.activeElement, r = e.getBoundingClientRect(), g = s => { const x = document.querySelector(s); if (!x || x.closest("[hidden]") || getComputedStyle(x).display === "none") return null; const b = x.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; }; return { field: [Math.round(r.top), Math.round(r.bottom)], header: g(".appbar"), saveBar: g(".savebar"), tabs: g(".bottomnav"), screen: innerHeight }; })()`);

/* ---------- text fields and the iPhone keyboard ---------- */

test("every text field on every screen is at least 16 px, so iPhone does not zoom the page in when it is tapped", { skip }, async () => {
  const small = [];
  const check = async where => {
    const r = await page.eval(`[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=button]):not([type=submit]), select, textarea')].filter(e => !e.closest("[hidden]") || e.closest("#rateForm")).map(e => [e.id || e.name || e.type, parseFloat(getComputedStyle(e).fontSize)]).filter(x => x[1] < 16)`);
    r.forEach(([n, s]) => small.push(`${where}: ${n} is ${s}px`));
  };
  await openMap();
  await tapSel("#layersBtn");
  await page.waitFor(`!document.getElementById("layersPanel").hidden && !!document.getElementById("lyCity")`, 3000, "layers panel");
  await check("map with layers");
  for (const hash of ["#/places", "#/place/porto", "#/place/sankt-peterburg", "#/rate", "#/settings"]) {
    await page.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(500);
    await check(hash);
  }
  assert.deepEqual(small, [], "iOS zooms in on fields under 16 px and does not zoom back out");
});

test("the map search and the places filter do not autocorrect city names (iOS would turn «Будва» into another word on «Найти»)", { skip }, async () => {
  await openMap();
  const map = await page.eval(`(() => { const e = document.getElementById("searchInput"); return { autocorrect: e.getAttribute("autocorrect"), spellcheck: e.getAttribute("spellcheck") }; })()`);
  await page.eval(`location.hash = "#/places"`);
  await page.waitFor(`!!document.getElementById("placeFilter")`, 3000, "places filter");
  const list = await page.eval(`(() => { const e = document.getElementById("placeFilter"); return { autocorrect: e.getAttribute("autocorrect"), spellcheck: e.getAttribute("spellcheck") }; })()`);
  const bad = [["map search", map], ["places filter", list]].filter(([, a]) => String(a.autocorrect).toLowerCase() !== "off" || a.spellcheck !== "false").map(([w, a]) => `${w}: autocorrect=${a.autocorrect}, spellcheck=${a.spellcheck}`);
  assert.deepEqual(bad, [], "search fields for place names need autocorrect=\"off\" spellcheck=\"false\"");
});

test("the key and the repository fields are never auto-capitalised or auto-corrected by the iPhone keyboard", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  const r = await page.eval(`["token", "repo"].map(n => { const e = document.querySelector('#tokenForm [name="' + n + '"]'); return { n, type: e.type, cap: e.getAttribute("autocapitalize"), cor: e.getAttribute("autocorrect"), spell: e.getAttribute("spellcheck") }; })`);
  const bad = r.filter(x => x.type !== "password" && !(/^(off|none)$/i.test(x.cap || "") && /^off$/i.test(x.cor || "") && x.spell === "false")).map(x => `${x.n}: autocapitalize=${x.cap}, autocorrect=${x.cor}, spellcheck=${x.spell}`);
  assert.deepEqual(bad, [], "iOS autocorrect can silently change «where-to-live-data» or the owner name");
});

test("amounts in «Цифры места» open the decimal keyboard and accept the iPhone decimal comma: «1050,50» and «85,5» are saved as 1050.5 and 85.5", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.waitFor(`!!document.querySelector('[name="fact_rent"]')`, 4000, "facts form");
  const modes = await page.eval(`[...document.querySelectorAll('#factsForm input[name^="fact_"]')].map(e => [e.name, e.getAttribute("inputmode")]).filter(x => x[1] !== "decimal")`);
  assert.deepEqual(modes, [], "amount fields without inputmode=decimal get the full letter keyboard");
  await focusField('[name="fact_rent"]');
  await page.type("1050,50");
  await focusField('[name="fact_tds"]');
  await page.type("85,5");
  await tapSel("#factsForm button[type=submit]");
  assert.ok(await until(`/сохранены/.test(document.getElementById("factsMsg")?.textContent || "")`, 4000), "saved: " + (await page.text("#factsMsg")));
  const doc = JSON.parse((await mockFiles(page))["places/porto.json"]);
  assert.equal(doc.facts.rent.v, 1050.5);
  assert.equal(doc.facts.tds.v, 85.5);
});

test("pressing «Найти» on the iPhone keyboard in the places filter closes the keyboard and keeps the filtered list", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  await focusField("#placeFilter");
  await page.type("Бат");
  await page.key("Enter");
  await sleep(200);
  const r = await page.eval(`({ active: document.activeElement.id, rows: [...document.querySelectorAll("#plist .prow")].map(a => a.innerText.split("\\n")[0]), hash: location.hash })`);
  assert.deepEqual(r.rows, ["Батуми"], "the filter result stays");
  assert.equal(r.hash, "#/places");
  assert.notEqual(r.active, "placeFilter", "the field keeps focus, so the keyboard stays over half of the list (no form, no blur on Enter)");
});

test("while typing a review with the keyboard open, the review box and the «Сохранить» button stay in sight", { skip }, async () => {
  await openRate();
  await focusField("#fReview");
  const h = (await layout()).field;
  await keyboardOpens(450);
  const ok = await until(`${SHOWN}(document.activeElement) >= ${Math.min(60, h[1] - h[0] - 4)} && ${HIT}("#fSave")`, 2000);
  const r = await layout();
  await page.shot("c3-ios-keyboard-review");
  assert.ok(ok, `with the keyboard up the review box is hidden behind the save bar or the tabs: ${JSON.stringify(r)}, visible ${await page.eval(`${SHOWN}(document.activeElement)`)}px, «Сохранить» visible: ${await page.eval(`${HIT}("#fSave")`)}`);
});

test("typing an amount in «Цифры места» with the keyboard open keeps the field above the tab bar", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.waitFor(`!!document.querySelector('[name="fact_utilities"]')`, 4000, "facts form");
  await focusField('[name="fact_utilities"]');
  await keyboardOpens(450);
  const ok = await until(`${SHOWN}(document.activeElement) >= 36`, 2000);
  const r = await layout();
  await page.shot("c3-ios-keyboard-fact");
  assert.ok(ok, `the amount being typed is under the tab bar: ${JSON.stringify(r)}, visible ${await page.eval(`${SHOWN}(document.activeElement)`)}px`);
});

test("with the phone sideways and the keyboard open, at least a line of the review being typed is visible", { skip }, async () => {
  await page.viewport(844, 390);
  await openRate();
  await focusField("#fReview");
  await keyboardOpens(200);
  const ok = await until(`${SHOWN}(document.activeElement) >= 24`, 2000);
  const r = await layout();
  await page.shot("c3-ios-keyboard-sideways");
  assert.ok(ok, `sideways the header, the save bar and the tabs leave no room for the text being typed: ${JSON.stringify(r)}, visible ${await page.eval(`${SHOWN}(document.activeElement)`)}px`);
});

test("with the keyboard open, the map search suggestions fit above it and can be tapped", { skip }, async () => {
  await openMap();
  await focusField("#searchInput");
  await page.type("Ба");
  await page.waitFor(`!document.getElementById("searchResults").hidden && document.querySelectorAll("#searchResults button").length > 1`, 4000, "suggestions");
  await keyboardOpens(450);
  await sleep(300);
  const r = await page.eval(`(() => { const b = document.getElementById("searchResults").getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, first: ${HIT}(document.querySelector("#searchResults button")) }; })()`);
  assert.ok(r.bottom <= r.h, "the list runs under the keyboard: " + JSON.stringify(r));
  assert.ok(r.first, "the first suggestion can be tapped");
});

test("the trip date fields keep their full height on iPhone even when empty (an empty iOS date field collapses without a minimum height)", { skip }, async () => {
  await openRate(null);
  const r = await page.eval(`["fStart", "fEnd"].map(id => { const e = document.getElementById(id), cs = getComputedStyle(e); return [id, cs.minHeight, e.value]; })`);
  const bad = r.filter(([, mh]) => !(parseFloat(mh) >= 40)).map(([id, mh]) => `${id}: min-height ${mh}`);
  assert.deepEqual(bad, [], "set a min-height (≥ 40–44 px) on input[type=date]");
});

test("in dark mode the place picker, the date and the text fields are dark with light text, not white boxes", { skip }, async () => {
  await page.viewport(390, 844, { dark: true });
  await openRate(null);
  const r = await page.eval(`(() => {
    const cv = document.createElement("canvas").getContext("2d");
    const rgb = c => { cv.fillStyle = "#000"; cv.fillStyle = c; const v = cv.fillStyle; const m = v.match(/^#(..)(..)(..)$/); return m ? m.slice(1).map(x => parseInt(x, 16)) : (v.match(/\\d+/g) || [0, 0, 0]).slice(0, 3).map(Number); };
    const lum = a => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
    return ["#fPlace", "#fStart", "#fReview", "#fVeto"].map(s => { const cs = getComputedStyle(document.querySelector(s)), bg = lum(rgb(cs.backgroundColor)), fg = lum(rgb(cs.color)); return { s, bg: Math.round(bg * 1000) / 1000, ratio: Math.round((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) * 10) / 10, scheme: cs.colorScheme }; });
  })()`);
  const bad = r.filter(x => x.bg > 0.1 || x.ratio < 7 || !/dark/.test(x.scheme));
  assert.deepEqual(bad, [], JSON.stringify(r));
});

/* ---------- taps, double taps, long presses ---------- */

test("buttons, tabs and links ignore iPhone double-tap zoom, so a quick second tap on «Точно стереть?» or «Точно забыть?» is a tap, not a page zoom", { skip }, async () => {
  const NO_DTZ = `(() => {
    const vis = e => { if (e.closest("[hidden], .sr-only, .leaflet-container")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
    const free = e => { for (let a = e; a; a = a.parentElement) if (getComputedStyle(a).touchAction !== "auto") return true; return false; };
    const name = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/)[0] : "")) + " «" + (e.innerText || e.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 22) + "»";
    return [...document.querySelectorAll("button, a[href], summary, select, label, [role=button]")].filter(vis).filter(e => !free(e)).map(name);
  })()`;
  const out = {};
  await openRate();
  await tapSel('[data-score="интернет"][data-v="4"]');
  out.rate = await page.eval(NO_DTZ);
  await page.eval(`location.hash = "#/settings"`);
  await sleep(500);
  out.settings = await page.eval(NO_DTZ);
  await page.eval(`location.hash = "#/rank"`);
  await sleep(500);
  out.rank = await page.eval(NO_DTZ);
  const must = ["#fReset", "#fSave", "#forget"].filter(id => [...out.rate, ...out.settings].some(x => x.startsWith(id + " ")));
  assert.deepEqual(must, [], "confirm-by-second-tap buttons let iOS zoom on a quick double tap (touch-action: manipulation missing)");
  const n = Object.values(out).flat().length;
  assert.equal(n, 0, `${n} controls still allow double-tap zoom, e.g. ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.slice(0, 6)])))}`);
});

test("quick finger taps on the rating buttons register every tap: 4, then 4½, then «год здесь» 7", { skip }, async () => {
  await openRate();
  const a = await spot('[data-score="интернет"][data-v="4"]'), b = await spot('[data-score="интернет"][data-v="4.5"]');
  await fingerTap(a, { hold: 40, settle: 90 });
  await fingerTap(b, { hold: 40, settle: 90 });
  await tapSel('[data-year="7"]', 0, { hold: 40, settle: 300 });
  const f = await page.eval(`(async () => { const f = (${APP}).form.form; return { s: f.scores["интернет"], y: f.year }; })()`);
  assert.deepEqual(f, { s: 4.5, y: 7 });
  assert.equal(await page.text('[data-qval="интернет"]'), "4.5");
});

test("a finger tap on a cell of «Места × группы» shows what the number is, and a tap elsewhere hides it", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.querySelector("#heat td.cell:not(.none)")`, 4000, "heat table");
  await tapSel("#heat tbody tr:nth-child(2) td.cell:not(.none)");
  const t = await tip();
  assert.ok(t.shown, "no explanation appears on tap");
  assert.match(t.text, /·.+:\s*\d/, "place · group: score");
  await tapSel("#v-rank h1");
  assert.equal((await tip()).shown, false, "the tooltip stays after tapping elsewhere");
});

test("scrolling the page with a finger that starts on the table does not leave a tooltip floating over other content", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.querySelector("#heat td.cell:not(.none)")`, 4000, "heat table");
  const from = await spot("#heat tbody tr:nth-child(2) td.cell:not(.none)");
  const y0 = await page.eval("scrollY");
  await fingerSwipe(from, [from[0], from[1] - 300]);
  assert.ok((await page.eval("scrollY")) > y0 + 100, "the page scrolled");
  const t = await tip();
  await page.shot("c3-ios-tip-after-scroll");
  assert.equal(t.shown, false, `after a scroll the tooltip «${t.text}» floats detached from its cell`);
});

test("opening a place from the ranking by tapping its score bar does not leave the bar's tooltip over the dossier", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.querySelector("#rank a.row .track .bar")`, 4000, "ranking");
  await tapSel("#rank a.row .track .bar");
  assert.ok(await until(`location.hash.startsWith("#/place/") && !document.getElementById("v-place").hidden`), "the dossier opens");
  await sleep(300);
  const t = await tip();
  await page.shot("c3-ios-tip-on-dossier");
  assert.equal(t.shown, false, `the ranking tooltip «${t.text}» stays on top of the dossier text until the next tap`);
});

test("after a finger tap in «Места × группы» the place name does not stay underlined; with a mouse on a computer it still underlines on hover", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.querySelector("#heat tbody tr:nth-child(2) td.cell")`, 4000, "heat table");
  await tapSel("#heat tbody tr:nth-child(2) td.cell");
  await sleep(300);
  const deco = () => page.eval(`getComputedStyle(document.querySelector("#heat tbody tr:nth-child(2) th.rowh a")).textDecorationLine`);
  const phone = await deco();
  await as(UA);
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.querySelector("#heat tbody tr:nth-child(2) td.cell")`, 4000, "heat table");
  const at = await spot("#heat tbody tr:nth-child(2) td.cell");
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] });
  await sleep(200);
  const desk = await deco();
  assert.equal(desk, "underline", "on a computer the row name underlines under the mouse");
  assert.notEqual(phone, "underline", "on iPhone :hover sticks after a tap — wrap hover styles in @media (hover: hover)");
});

/* ---------- map: drag, pinch, pins, card ---------- */

test("a finger drag on the map moves the map, not the page", { skip }, async () => {
  await openMap();
  const c0 = await mapCenter();
  await fingerSwipe([195, 330], [195, 560]);
  const c1 = await mapCenter();
  const r = await page.eval(`({ y: scrollY, top: document.documentElement.scrollTop, hash: location.hash })`);
  assert.ok(Math.abs(c1[0] - c0[0]) > 0.2, "the map did not move: " + JSON.stringify([c0, c1]));
  assert.deepEqual(r, { y: 0, top: 0, hash: "#/map" });
});

test("pinching the map zooms the map, not the whole page, and a phone shows no +/− buttons", { skip }, async () => {
  await openMap();
  const z0 = (await mapCenter())[2];
  await page.send("Input.synthesizePinchGesture", { x: 195, y: 420, scaleFactor: 2.5, gestureSourceType: "touch" });
  assert.ok(await until(`(async () => (${APP}).mapView.map.getZoom() > ${z0})()`, 3000), "the map did not zoom in");
  assert.equal(await page.eval("visualViewport.scale"), 1, "the page itself got zoomed");
  assert.equal(await page.eval(`!!document.querySelector(".leaflet-control-zoom")`), false);
});

test("a finger tap on a place pin opens its card; a long press does not select the pin text and the next tap still works", { skip }, async () => {
  await openMap();
  await openValenciaCard();
  await tapSel("#sheetClose");
  assert.equal(await sheetTitle(), "");
  await fingerTap(await pinAt("Валенсия"), { hold: 900 });
  assert.equal(await page.eval("String(getSelection())"), "", "a long press selects text on the map");
  await page.eval(`document.getElementById("sheetClose").click()`);
  await sleep(200);
  await fingerTap(await pinAt("Валенсия"));
  assert.ok(await until(`document.getElementById("sheetTitle")?.textContent === "Валенсия" && !document.getElementById("sheet").hidden`), "the tap after a long press does not open the card");
  assert.deepEqual(page.takeErrors(), []);
});

test("swiping the place card down by its grip folds it out of the way, like any iPhone bottom sheet", { skip }, async () => {
  await openMap();
  await openValenciaCard();
  const before = await page.eval(`(() => { const g = document.getElementById("sheetGrip").getBoundingClientRect(); return { grip: [g.left + g.width / 2, g.top + g.height / 2], top: document.getElementById("sheet").getBoundingClientRect().top }; })()`);
  await fingerSwipe(before.grip, [before.grip[0], before.grip[1] + 260], { steps: 14, ms: 300 });
  const after = await page.eval(`(() => { const s = document.getElementById("sheet"); return { hidden: s.hidden, peek: s.classList.contains("peek"), top: s.getBoundingClientRect().top }; })()`);
  await page.shot("c3-ios-grip-swipe");
  assert.ok(after.hidden || after.peek || after.top >= before.top + 100, `the card ignores a downward swipe on its grip (only taps work): ${JSON.stringify({ before: before.top, after })}`);
});

test("scrolling the list inside the place card with a finger scrolls the card, not the map or the page", { skip }, async () => {
  await openMap();
  await openValenciaCard();
  await tapSel('#sheet [data-act="simplace"]');
  await page.waitFor(`!!document.querySelector("#simPlaceBox .sim-row")`, 6000, "similar places in the card");
  await sleep(900);
  await page.eval(`document.getElementById("sheetBody").scrollTop = 0`);
  await sleep(100);
  const c0 = await mapCenter();
  const box = await page.eval(`(() => { const b = document.getElementById("sheetBody"), r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, room: b.scrollHeight - b.clientHeight }; })()`);
  assert.ok(box.room > 60, "the card has something to scroll: " + JSON.stringify(box));
  await fingerSwipe([200, box.bottom - 50], [200, box.top + 50]);
  const r = await page.eval(`({ st: document.getElementById("sheetBody").scrollTop, y: scrollY })`);
  const c1 = await mapCenter();
  assert.ok(r.st > 40, "the card did not scroll: " + JSON.stringify(r));
  assert.equal(r.y, 0, "the page moved");
  assert.deepEqual(c1.map(v => Math.round(v * 1e4)), c0.map(v => Math.round(v * 1e4)), "the map moved under the card");
});

test("when Safari's toolbar shows or hides, the map still fills exactly the space between the header and the tabs", { skip }, async () => {
  await openMap();
  const out = [];
  for (const h of [844, 760, 844]) {
    await page.viewport(390, h);
    await sleep(500);
    const r = await page.eval(`(async () => { const m = document.getElementById("map").getBoundingClientRect(), a = document.querySelector(".appbar").getBoundingClientRect(), n = document.querySelector(".bottomnav").getBoundingClientRect(); return { top: Math.round(m.top), bottom: Math.round(m.bottom), bar: Math.round(a.bottom), nav: Math.round(n.top), navEnd: Math.round(n.bottom), h: innerHeight, leaflet: (${APP}).mapView.map.getSize().y, el: Math.round(m.height) }; })()`);
    if (r.top !== r.bar || r.bottom !== r.nav || r.navEnd !== r.h || Math.abs(r.leaflet - r.el) > 1) out.push(`${h}px: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(out, []);
});

test("on the map search a phone user is told to tap «Искать везде» (no Enter key hint), and tapping a suggestion closes the keyboard and opens the card", { skip }, async () => {
  await openMap();
  await focusField("#searchInput");
  await page.type("Херцег");
  await page.waitFor(`[...document.querySelectorAll("#searchResults button")].some(b => /Искать «Херцег» везде/.test(b.innerText))`, 4000, "remote suggestion");
  const hint = await page.eval(`[...document.querySelectorAll("#searchResults button")].find(b => /везде/.test(b.innerText)).innerText`);
  assert.match(hint, /нажмите/i);
  assert.doesNotMatch(hint, /Enter/);
  await fingerTap(await page.eval(`(() => { const b = [...document.querySelectorAll("#searchResults button")].find(b => /везде/.test(b.innerText)); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`));
  await page.waitFor(`[...document.querySelectorAll("#searchResults button")].some(b => /Херцег-Нови/.test(b.innerText))`, 4000, "OpenStreetMap results");
  await fingerTap(await page.eval(`(() => { const b = [...document.querySelectorAll("#searchResults button")].find(b => /Херцег-Нови/.test(b.innerText)); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`));
  assert.ok(await until(`!document.getElementById("sheet").hidden && /Херцег-Нови/.test(document.getElementById("sheetTitle")?.textContent || "")`), "the card opens");
  assert.notEqual(await page.eval("document.activeElement.id"), "searchInput", "the keyboard stays up over the card");
});

/* ---------- sideways with a notch ---------- */

test("sideways on an iPhone with a notch, the card's close button, the map note and the map credits stay clear of the notch", { skip }, async () => {
  await page.viewport(844, 390);
  await insets(SIDEWAYS);
  const gaps = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.closest("[hidden]")) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(innerWidth - r.right) }; })()`);
  const out = [];
  const need = (what, g) => { if (g && (g.left < SIDEWAYS.left || g.right < SIDEWAYS.right)) out.push(`${what}: ${g.left}px from the left, ${g.right}px from the right`); };
  await openMap();
  need("map credits", await gaps(".leaflet-control-attribution"));
  await page.eval(`document.querySelector('.leaflet-marker-icon[title="Валенсия"]').click()`);
  await page.waitFor(`!document.getElementById("sheet").hidden`, 3000, "card");
  need("card close ×", await gaps("#sheetClose"));
  await page.shot("c3-ios-sideways-card");
  await openApp(page, srv.url, { hash: "#/map", token: false });
  await page.waitFor(`!document.getElementById("mapNote").hidden`, 4000, "map note");
  need("note «Данные не подключены»", await gaps("#mapNote"));
  assert.deepEqual(out, [], "these sit under the 47 px notch / rounded corner");
});

test("sideways, each tab label sits right next to its own icon, not halfway to the next tab's icon", { skip }, async () => {
  await page.viewport(844, 390);
  await openApp(page, srv.url, { hash: "#/rank" });
  const r = await page.eval(`[...document.querySelectorAll(".bottomnav a")].map(a => { const i = a.querySelector("svg").getBoundingClientRect(), t = a.querySelector("span").getBoundingClientRect(); const dx = Math.max(0, t.left - i.right, i.left - t.right), dy = Math.max(0, t.top - i.bottom, i.top - t.bottom); return [a.innerText.trim(), Math.round(Math.hypot(dx, dy))]; })`);
  await page.shot("c3-ios-sideways-tabs");
  const far = r.filter(([, d]) => d > 12);
  assert.deepEqual(far, [], "gap between icon and label in px: " + JSON.stringify(r));
});

/* ---------- the installed app and other iPhone browsers ---------- */

test("links that leave the app (map credits, GitHub, Numbeo, Википедия) open in a new window, so the installed app stays where it was", { skip }, async () => {
  const bad = [];
  const scan = async where => {
    const r = await page.eval(`[...document.querySelectorAll("a[href]")].filter(a => !a.closest("[hidden]")).filter(a => { try { const u = new URL(a.href); return /^https?:$/.test(u.protocol) && u.origin !== location.origin; } catch (e) { return false; } }).map(a => [a.textContent.trim().slice(0, 30), a.target, a.rel])`);
    r.filter(([, t, rel]) => t !== "_blank" || !/noopener/.test(rel)).forEach(([text, t, rel]) => bad.push(`${where}: «${text}» target=${t || "—"} rel=${rel || "—"}`));
  };
  await openMap();
  await scan("map");
  for (const hash of ["#/settings", "#/place/porto"]) {
    await page.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(500);
    await scan(hash);
  }
  assert.deepEqual([...new Set(bad)], [], "in the Home Screen app a plain link replaces the app with the other site and there is no Back button");
});

test("in the installed app a place opened from the ranking has a way back to the ranking, at the same spot (there is no browser Back button)", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank", local: { "test:standalone": 1 } });
  assert.equal(await page.eval("navigator.standalone"), true);
  await page.waitFor(`document.querySelectorAll("#heat th.rowh a").length > 2`, 4000, "heat table");
  const at = await spot("#heat th.rowh a", 2);
  const yRank = await page.eval("scrollY");
  assert.ok(yRank > 300, "the table is further down the ranking");
  await fingerTap(at);
  assert.ok(await until(`location.hash.startsWith("#/place/") && !document.getElementById("v-place").hidden`), "the dossier opens");
  await sleep(300);
  const BACK = `[...document.querySelectorAll("#v-place a, #v-place button")].findIndex(e => /^\\s*←|назад/i.test(e.innerText) && e.getClientRects().length)`;
  const i = await page.eval(BACK);
  assert.ok(i >= 0, "no back link on the dossier");
  const label = await page.eval(`document.querySelectorAll("#v-place a, #v-place button")[${i}].innerText.trim()`);
  await tapSel("#v-place a, #v-place button", i);
  await sleep(500);
  const r = await page.eval(`({ hash: location.hash, y: scrollY })`);
  assert.equal(r.hash, "#/rank", `«${label}» leads to ${r.hash}, not back to the ranking the place was opened from`);
  assert.ok(Math.abs(r.y - yRank) < 200, `the ranking reopens at ${r.y}px instead of at the table (${yRank}px)`);
});

test("after «Скачать копию данных» on an iPhone the app says the copy is ready and where the file went", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", local: { "test:standalone": 1 } });
  await page.eval(`(() => { const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__download = this.download; return; } return orig.call(this); }; navigator.share = async () => { window.__shared = true; }; navigator.canShare = () => true; })()`);
  const before = await page.text("#v-settings");
  await tapSel("#exportBtn");
  const said = await until(`(() => { const t = document.getElementById("toast"); const shown = !t.hidden && /Файл|Загрузк|скачан|сохран|копи/i.test(t.textContent); const box = document.getElementById("exportBtn").closest(".panel").innerText; return shown || /Файлы|Загрузк|скачан|готов/i.test(box); })()`, 2500);
  const r = await page.eval(`({ file: window.__download || "", shared: !!window.__shared, toast: document.getElementById("toast").textContent })`);
  assert.ok(r.file || r.shared, "nothing was offered to save");
  assert.ok(said, `nothing on screen says what happened (on iPhone the file silently lands in Файлы → Загрузки): toast «${r.toast}»; settings text unchanged: ${before === (await page.text("#v-settings"))}`);
});

test("in iPhone Chrome or an in-app browser the install hint says how to get the app from there, not only «Safari → Поделиться»", { skip }, async () => {
  const hint = async ua => {
    await as(ua);
    await openApp(page, srv.url, { hash: "#/settings" });
    return page.eval(`(() => { const h = [...document.querySelectorAll("#v-settings h2")].find(x => /экран «Домой»/.test(x.textContent)); return h ? { first: h === document.querySelector("#v-settings h2"), text: h.closest(".block").innerText } : null; })()`);
  };
  const chrome = await hint(CRIOS);
  const inapp = await hint(INAPP);
  assert.ok(chrome && chrome.first && inapp && inapp.first, "the install hint comes first on any iPhone browser");
  assert.match(chrome.text, /Chrome|откро\w* в Safari|открой\w* в Safari/i, "Chrome on iPhone: " + chrome.text);
  assert.match(inapp.text, /(откро|открой)\w*[^.]{0,60}Safari/i, "an in-app browser (Telegram, Instagram) cannot add to the Home Screen; the hint must say to open the page in Safari first: " + inapp.text);
});

test("the rating form's save bar says, in plain text, how many ★ answers a place needs to enter the ranking (hover titles never show on iPhone)", { skip }, async () => {
  await openRate();
  await tapSel('[data-score="интернет"][data-v="4"]');
  const bar = await page.text(".savebar");
  const title = await page.eval(`document.getElementById("fCounts").title`);
  assert.match(title, /рейтинг/, "precondition: the rule is in the title");
  assert.match(bar, /рейтинг|нужно\s*(хотя бы\s*)?\d|минимум\s*\d/i, "the visible bar shows only «" + bar.replace(/\s+/g, " ") + "»; the rule is in a title attribute an iPhone never displays");
});

test("the app keeps iPhone's own zoom and text size: pinch-zoom is allowed and text is not inflated when the phone turns sideways", { skip }, async () => {
  await page.viewport(844, 390);
  await openApp(page, srv.url, { hash: "#/rank" });
  const r = await page.eval(`({ vp: document.querySelector('meta[name="viewport"]').content, adjust: getComputedStyle(document.body).webkitTextSizeAdjust || getComputedStyle(document.body).textSizeAdjust, h1: getComputedStyle(document.querySelector("#v-rank h1")).fontSize })`);
  assert.doesNotMatch(r.vp, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/, "zoom must stay available for reading small print");
  assert.equal(r.adjust, "100%", "without text-size-adjust: 100% iOS enlarges text sideways");
});

test("swiping the «Места × группы» table sideways with a finger scrolls the table, keeps the place names in view and does not leave the page", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!document.getElementById("heat")`, 4000, "heat table");
  await page.eval(`document.getElementById("heat").scrollIntoView({ block: "center" })`);
  await sleep(150);
  const box = await page.eval(`(() => { const s = document.getElementById("heat").closest(".scroll"), r = s.getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + 60, room: s.scrollWidth - s.clientWidth, y0: scrollY }; })()`);
  assert.ok(box.room > 50, "the table is wider than the phone");
  await fingerSwipe([box.x, box.y], [box.x - 220, box.y + 4]);
  const r = await page.eval(`(() => { const s = document.getElementById("heat").closest(".scroll"), th = document.querySelector("#heat tbody th.rowh"), b = th.getBoundingClientRect(), h = document.elementFromPoint(b.left + 10, b.top + b.height / 2); return { sl: s.scrollLeft, sx: scrollX, hash: location.hash, nameVisible: !!h && th.contains(h) }; })()`);
  assert.ok(r.sl > 50, "the table did not scroll: " + JSON.stringify(r));
  assert.equal(r.sx, 0);
  assert.equal(r.hash, "#/rank");
  assert.ok(r.nameVisible, "the place column scrolled away");
});
