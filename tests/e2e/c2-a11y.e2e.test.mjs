import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES } from "./fixtures.mjs";

// Lens: accessibility and keyboard. Uses the site with the keyboard only (Tab, Shift+Tab, Enter, Space, Escape, arrows)
// and as a VoiceOver user (the accessibility tree from Chrome), on every route, sheet, panel, toast and banner.
// Covers focus visibility and order, focus after every action, names and states of controls, live announcements,
// text alternatives for charts and colour-coded marks, reduced motion and page zoom.

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); page.takeErrors(); } });

/* ---------- data ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const all = v => Object.fromEntries(STAR.map(k => [k, v]));
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район", retro: true, year: 6, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);

const BUDVA = place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { status: "отсев", reason: "дорого и шумно" });
const BAR = place("bar", "Бар", "Черногория", "MNE", 42.0931, 19.1003, { status: "финалист", archetype: "малый курорт", facts: { rent: { v: 700, src: "20 объявлений", at: "2026-10-10" } } });

// Порту and Бар: both of us answered every ★ question. Валенсия: few own answers (hollow pin). Тбилиси: only Вика,
// so hidden from Михаил. Батуми: Михаил's veto. Будва: «отсев». Белград: no ratings at all, only world data.
const DATA = repo({
  places: PLACES.concat([BUDVA, BAR]),
  ratings: [
    rating("a1", "porto", "Михаил", all(4), { review: "Красиво, но сыро.", year: 7 }),
    rating("a2", "porto", "Вика", Object.assign(all(3.5), { "эстетика": 5 }), { review: "Много холмов.", year: 6 }),
    rating("a3", "valensiya", "Михаил", { "интернет": 4, "улица": 4, "эстетика": 4 }, { year: 8 }),
    rating("a4", "tbilisi", "Вика", all(3), { review: "Пыльно и шумно." }),
    rating("a5", "batumi", "Михаил", { "интернет": 3, "шум": 1 }, { veto: "слишком шумно ночью", year: 2 }),
    rating("a6", "bar", "Михаил", all(4.5), { year: 8, review: "Тихо, море рядом." }),
    rating("a7", "bar", "Вика", all(3), { year: 5 }),
    rating("a8", "budva", "Михаил", { "интернет": 3 }),
  ],
});

const open = (hash, opts = {}) => openApp(page, srv.url, Object.assign({ files: DATA, hash }, opts));
const APP = `(await import("./js/app.js")).state`;

/* ---------- keyboard ---------- */

async function key(k, code, vk, text, modifiers = 0, settle = 120) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, text, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(settle);
}
const pressTab = (shift = false, settle = 40) => key("Tab", "Tab", 9, undefined, shift ? 8 : 0, settle);
const pressEnter = () => key("Enter", "Enter", 13, "\r");
const pressSpace = () => key(" ", "Space", 32, " ");
const pressEscape = () => key("Escape", "Escape", 27);
const pressRight = () => key("ArrowRight", "ArrowRight", 39);
const pressLeft = () => key("ArrowLeft", "ArrowLeft", 37);

const focused = () => page.eval(`(() => {
  const e = document.activeElement;
  if (!e || e === document.body || e === document.documentElement) return { body: true, label: "BODY" };
  return { body: false, tag: e.tagName, id: e.id, label: (e.getAttribute("aria-label") || e.innerText || e.value || e.title || "").replace(/\\s+/g, " ").trim().slice(0, 50),
    view: (e.closest(".view") || {}).id || "", inSheet: !!e.closest("#sheet"), inMain: !!e.closest("main"), pin: e.matches(".leaflet-marker-icon") ? e.getAttribute("title") : "",
    bar: !!e.closest(".appbar, .bottomnav"), gone: !e.isConnected || !!e.closest("[hidden]") || !e.getClientRects().length };
})()`);
const blur = () => page.eval(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
const focusOn = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); return document.activeElement === e; })()`);
const toastText = re => page.waitFor(`(() => { const t = document.getElementById("toast"); return t && !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const sheetOpen = () => page.eval(`!document.getElementById("sheet").hidden`);
const pinReady = name => page.waitFor(`!!document.querySelector('.leaflet-marker-icon[title=${JSON.stringify(name)}]')`, 5000, "pin " + name);

async function openPinCardByKeyboard(name) {
  await pinReady(name);
  assert.ok(await focusOn(`.leaflet-marker-icon[title="${name}"]`), "the pin takes keyboard focus");
  await pressEnter();
  await page.waitFor(`!document.getElementById("sheet").hidden && document.getElementById("sheetBody").innerText.includes(${JSON.stringify(name)})`, 3000, "card for " + name);
}

/* ---------- accessibility tree ---------- */

async function axAll(sel) {
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await page.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: sel });
  const out = [];
  for (const nodeId of nodeIds) {
    const { nodes } = await page.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const n = nodes[0] || {};
    const prop = k => { const p = (n.properties || []).find(x => x.name === k); return p ? String(p.value.value) : undefined; };
    out.push({ ignored: !!n.ignored, role: (n.role && n.role.value) || "", name: (n.name && n.name.value) || "", description: (n.description && n.description.value) || "", value: n.value && n.value.value, pressed: prop("pressed"), checked: prop("checked"), live: prop("live"), expanded: prop("expanded"), invalid: prop("invalid"), valuetext: prop("valuetext") });
  }
  return out;
}
const axOf = async sel => (await axAll(sel))[0];
const describedBy = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return ""; return [e.getAttribute("aria-describedby"), e.getAttribute("aria-errormessage")].join(" ").split(/\\s+/).filter(Boolean).map(id => (document.getElementById(id) || {}).textContent || "").join(" "); })()`);
const liveText = (exclude = "") => page.eval(`[...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role=status], [role=alert], [role=log]')].filter(e => !${JSON.stringify(exclude)} || !e.matches(${JSON.stringify(exclude || "x")})).map(e => e.textContent).join(" | ")`);

const HEADINGS = `[...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
  .filter(e => !e.closest("[hidden]") && e.getClientRects().length && !(e.closest("details:not([open])") && !e.closest("summary")))
  .map(e => ({ lvl: Number(e.getAttribute("aria-level")) || Number(e.tagName[1]) || 2, text: e.textContent.replace(/\\s+/g, " ").trim().slice(0, 40) }))`;

const RING = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return { label: "BODY" };
  const cs = getComputedStyle(e);
  const label = (e.getAttribute("aria-label") || e.innerText || e.value || e.tagName).replace(/\\s+/g, " ").trim().slice(0, 30);
  const ring = e.matches(":focus-visible") && ((cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1) || cs.boxShadow !== "none");
  let ratio = null;
  if (ring && cs.outlineStyle === "solid") {
    const rgb = s => (s.match(/[\\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const a = lum(rgb(cs.outlineColor)), b = lum(rgb(getComputedStyle(document.body).backgroundColor));
    ratio = Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  }
  return { label, ring, ratio, date: e.type === "date", gone: !!e.closest("[hidden]") || !e.getClientRects().length };
})()`;

const reduceMotion = (dark = false) => page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });

/* ---------- page structure ---------- */

test("every screen has exactly one page heading, the map and a missing place included", { skip }, async () => {
  const bad = [];
  for (const route of ["#/map", "#/rank", "#/places", "#/place/porto", "#/place/nope", "#/rate", "#/settings"]) {
    await open(route);
    const n = await page.eval(`[...document.querySelectorAll("h1, [role=heading][aria-level='1']")].filter(e => !e.closest("[hidden]") && e.getClientRects().length).length`);
    if (n !== 1) bad.push(`${route}: ${n} h1`);
  }
  assert.deepEqual(bad, [], "VoiceOver users jump between screens by the page heading (rotor → Заголовки)");
});

test("headings never skip a level: the rating form and the map card read as a tidy outline", { skip }, async () => {
  const problems = [];
  const check = async where => {
    const hs = await page.eval(HEADINGS);
    if (!hs.length) { problems.push(`${where}: no headings`); return; }
    if (hs[0].lvl !== 1) problems.push(`${where}: starts with h${hs[0].lvl} «${hs[0].text}»`);
    hs.forEach((h, i) => { if (i && h.lvl > hs[i - 1].lvl + 1) problems.push(`${where}: h${hs[i - 1].lvl} «${hs[i - 1].text}» → h${h.lvl} «${h.text}»`); });
  };
  for (const route of ["#/rank", "#/places", "#/place/porto", "#/rate", "#/settings"]) { await open(route); await check(route); }
  await open("#/map");
  await openPinCardByKeyboard("Порту");
  await page.eval(`document.querySelector('#sheetBody [data-act="simplace"]').click()`);
  await page.waitFor(`document.getElementById("simPlaceBox").innerText.length > 20`, 5000, "similar places");
  await check("#/map with the Порту card and its similar places");
  assert.deepEqual(problems, []);
});

test("the first Tab stop is a «skip to content» link that moves focus into the screen without changing it", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/rank");
  await blur();
  await pressTab();
  const f = await focused();
  assert.match(f.label, /к содерж|к основн|пропуст|сразу к/i, `first Tab stop is «${f.label}», keyboard users tab through the whole header on every screen`);
  await pressEnter();
  await sleep(200);
  assert.equal(await page.eval("location.hash"), "#/rank", "the skip link must not break hash routing");
  const after = await focused();
  assert.ok(after.inMain && !after.bar, "focus lands inside the screen content");
});

test("switching screens with the keyboard moves focus to the new screen, also after saving a rating", { skip }, async () => {
  await open("#/map");
  assert.ok(await focusOn('.bottomnav a[data-nav="rank"]'));
  await pressEnter();
  await page.waitFor(`location.hash === "#/rank" && !document.getElementById("v-rank").hidden`, 4000, "ranking shown");
  await sleep(200);
  let f = await focused();
  assert.equal(f.view, "v-rank", `after opening «Рейтинг» focus stays on «${f.label}» in the bar, VoiceOver does not hear the new screen`);
  await pressTab();
  f = await focused();
  assert.equal(f.view, "v-rank", "the next Tab continues inside the ranking, not along the bottom bar");

  await open("#/rate/new/belgrad");
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  assert.ok(await focusOn("#fSave"));
  await pressEnter();
  await page.waitFor(`location.hash.startsWith("#/place/belgrad") && !document.getElementById("v-place").hidden`, 6000, "dossier after save");
  await sleep(300);
  f = await focused();
  assert.equal(f.view, "v-place", `after «Сохранить» focus is «${f.label}» on the hidden form instead of the place page`);
});

/* ---------- map ---------- */

test("on the map, Tab reaches the search box and «Слои» before the map and every pin", { skip }, async () => {
  await open("#/map");
  await pinReady("Порту");
  await blur();
  const kinds = [];
  for (let i = 0; i < 30; i++) {
    await pressTab();
    const k = await page.eval(`(() => { const e = document.activeElement; return e.id === "searchInput" ? "search" : e.id === "layersBtn" ? "layers" : e.id === "map" ? "map" : e.matches(".leaflet-marker-icon") ? "pin" : e.closest(".bottomnav") ? "nav" : "other"; })()`);
    kinds.push(k);
    if (k === "nav") break;
  }
  const first = k => kinds.indexOf(k);
  assert.ok(first("search") >= 0, "the search box is reachable");
  const mapStart = Math.min(...["map", "pin"].map(first).filter(i => i >= 0));
  assert.ok(first("search") < mapStart && first("layers") < mapStart, `Tab order: ${kinds.join(" → ")}; with 30 places the search box is 30+ Tabs away`);
});

test("Enter on a pin opens the card and moves focus into it; the card is announced by the place name", { skip }, async () => {
  await open("#/map");
  await openPinCardByKeyboard("Порту");
  await sleep(200);
  const f = await focused();
  assert.ok(f.inSheet, `focus stays on «${f.label}»: the opened card is behind every other pin and the search box`);
  const sheet = await axOf("#sheet");
  assert.ok(["dialog", "region", "complementary"].includes(sheet.role), `the card is exposed as «${sheet.role || "generic"}», not as a dialog or region`);
  assert.match(sheet.name, /Порту/, "the card is named after the place");
});

test("closing the place card with Escape or × puts focus back on the pin that opened it", { skip }, async () => {
  await open("#/map");
  await openPinCardByKeyboard("Порту");
  assert.ok(await focusOn('#sheetBody [data-act="simplace"]'), "a button inside the card takes focus");
  await pressEscape();
  assert.equal(await sheetOpen(), false, "Escape closes the card");
  let f = await focused();
  assert.equal(f.pin, "Порту", `after Escape focus is «${f.label}», keyboard users start again from the top of the page`);

  await openPinCardByKeyboard("Порту");
  assert.ok(await focusOn("#sheetClose"));
  await pressEnter();
  assert.equal(await sheetOpen(), false, "× closes the card");
  f = await focused();
  assert.equal(f.pin, "Порту", `after × focus is «${f.label}»`);
});

test("choosing a search suggestion with Enter keeps focus in the opened card, and Escape returns to the search box", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  assert.ok(await focusOn("#searchInput"));
  await page.type("Пор");
  await page.waitFor(`!document.getElementById("searchResults").hidden`, 3000, "suggestions");
  await pressTab();
  assert.match((await focused()).label, /Порту/, "Tab moves to the first suggestion");
  await pressEnter();
  await page.waitFor(`!document.getElementById("sheet").hidden && document.getElementById("sheetBody").innerText.includes("Порту")`, 3000, "card opened");
  await sleep(200);
  const f = await focused();
  assert.ok(f.inSheet, `after Enter focus is «${f.label}»: the next Tab goes to «Слои», the card is unreachable`);
  await pressEscape();
  assert.equal(await sheetOpen(), false);
  assert.equal((await focused()).id, "searchInput", "Escape returns to where the search started");
});

test("the outcome of a search after Enter is announced politely", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  assert.ok(await focusOn("#searchInput"));
  await page.type("Ыыжжщщ");
  await pressEnter();
  await page.waitFor(`/Ничего не нашлось/.test(document.getElementById("searchResults").innerText)`, 4000, "no results note");
  assert.match(await liveText(), /Ничего не нашлось/, "a screen reader user hears nothing after pressing Enter in the search box");
});

test("pins say in words when a place is out, vetoed or has few own ratings, not only by shape and paleness", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  await pinReady("Порту");
  await page.eval(`(async () => { ${APP}.mapView.map.setView([42.2, 19], 8, { animate: false }); })()`);
  await page.waitFor(`!!document.querySelector('.leaflet-marker-icon[title="Будва"]') && !!document.querySelector('.leaflet-marker-icon[title="Бар"]')`, 3000, "separate pins");
  const label = name => page.eval(`document.querySelector('.leaflet-marker-icon[title=${JSON.stringify(name)}]').getAttribute("aria-label")`);
  const problems = [];
  const want = async (name, re, what) => { const l = await label(name); if (!re.test(l)) problems.push(`${name}: «${l}» does not say ${what}`); };
  await want("Будва", /отсев/i, "«отсев» (pale pin)");
  await want("Батуми", /вето/i, "«вето» (pale pin)");
  await want("Валенсия", /мало/i, "that own ratings are few (hollow pin)");
  assert.doesNotMatch(await label("Порту"), /мало|отсев|вето/i, "a fully rated place has no warning");
  assert.deepEqual(problems, []);
});

test("a cluster of pins is reachable by Tab, says how many places and which, and Enter zooms in", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  await pinReady("Порту");
  await page.eval(`(async () => { ${APP}.mapView.map.setView([42, 30], 3, { animate: false }); })()`);
  await page.waitFor(`[...document.querySelectorAll(".leaflet-marker-icon")].some(e => /рядом/.test(e.getAttribute("aria-label") || ""))`, 3000, "a cluster");
  const c = await page.eval(`(() => { const e = [...document.querySelectorAll(".leaflet-marker-icon")].find(e => /рядом/.test(e.getAttribute("aria-label") || "")); e.id = "testCluster"; return { tab: e.tabIndex, role: e.getAttribute("role"), label: e.getAttribute("aria-label") }; })()`);
  assert.equal(c.tab, 0, "keyboard-focusable");
  assert.equal(c.role, "button");
  assert.match(c.label, /^\d+ мест[ао]? рядом: .+, .+\. Приблизить$/);
  const z0 = await page.eval(`(async () => ${APP}.mapView.map.getZoom())()`);
  assert.ok(await focusOn("#testCluster"));
  await pressEnter();
  await page.waitFor(`(async () => ${APP}.mapView.map.getZoom() > ${z0})()`, 3000, "zoomed in");
});

test("the map zoom buttons on a computer are named in Russian", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  const names = (await axAll(".leaflet-control-zoom a")).map(n => n.name);
  assert.equal(names.length, 2, "zoom buttons are shown on a computer");
  assert.deepEqual(names.filter(n => !/[а-яё]/i.test(n)), [], "VoiceOver reads «Zoom in / Zoom out» with a Russian voice");
});

test("Tab never gets stuck: from the top of each screen, an open map card included, it reaches the last bottom tab", { skip }, async () => {
  const stuck = [];
  for (const route of ["#/map", "#/rank", "#/place/porto", "#/settings", "#/rate"]) {
    await open(route);
    if (route === "#/map") { await pinReady("Порту"); await page.eval(`document.querySelector('.leaflet-marker-icon[title="Порту"]').click()`); await page.waitFor(`!document.getElementById("sheet").hidden`, 3000); }
    await blur();
    let reached = false, sawSheet = false;
    for (let i = 0; i < 260 && !reached; i++) {
      await pressTab(false, 15);
      const s = await page.eval(`(() => { const e = document.activeElement; return { last: e.matches('.bottomnav a[data-nav="rate"]'), sheet: !!e.closest("#sheet") }; })()`);
      reached = s.last; sawSheet ||= s.sheet;
    }
    if (!reached) stuck.push(route);
    if (route === "#/map" && !sawSheet) stuck.push("#/map: the open card was skipped");
  }
  assert.deepEqual(stuck, []);
});

/* ---------- rating form ---------- */

test("each score question is a named group and the chosen half-point is announced as selected", { skip }, async () => {
  await open("#/rate/new/belgrad");
  const g = await axOf('[data-q="интернет"] .pick');
  assert.ok(["group", "radiogroup"].includes(g.role));
  assert.match(g.name, /Интернет/);
  assert.ok(await focusOn('[data-score="интернет"][data-v="3.5"]'));
  await pressSpace();
  const btns = await axAll('[data-score="интернет"]');
  const on = btns.filter(b => b.pressed === "true" || b.checked === "true");
  assert.equal(on.length, 1, "exactly one answer is selected");
  assert.match(on[0].name, /3[,.]5|3½/, "the selected answer is read as 3,5");
  assert.equal(await page.text('[data-qval="интернет"]'), "3.5", "the chosen value is also shown next to the question");
  const year = await axOf(".pick.y");
  assert.match(year.name, /год/i, "the 0–10 year question is a named group");
  const who = await axAll("#fWho button");
  assert.deepEqual(who.map(b => [b.name, b.pressed]), [["Михаил", "true"], ["Вика", "false"]], "who rates: the device owner is pre-selected and announced");
});

test("arrow keys move between the answers of one score question", { skip }, async () => {
  await open("#/rate/new/belgrad");
  assert.ok(await focusOn('[data-score="интернет"][data-v="3"]'));
  await pressRight();
  let f = await page.eval(`[document.activeElement.dataset.score, document.activeElement.dataset.v].join(" ")`);
  assert.equal(f, "интернет 3.5", "→ goes to the next half-point; now every answer is its own Tab stop (≈110 Tabs from the first question to «Сохранить»)");
  await pressLeft();
  f = await page.eval(`[document.activeElement.dataset.score, document.activeElement.dataset.v].join(" ")`);
  assert.equal(f, "интернет 3", "← goes back");
});

test("a rejected save moves focus to the field to fix, marks it invalid and attaches the message to it", { skip }, async () => {
  await open("#/rate");
  assert.ok(await focusOn("#fSave"));
  await pressEnter();
  assert.match(await page.text("#fMsg"), /Выберите место/);
  let f = await focused();
  assert.equal(f.id, "fPlace", `focus stays on «${f.label}» while the problem is the place list far above`);
  assert.equal(await page.eval(`document.getElementById("fPlace").getAttribute("aria-invalid")`), "true", "the place list is marked invalid");
  assert.match(await describedBy("#fPlace"), /Выберите место/, "the message is attached to the place list");

  await page.select("#fPlace", "Белград");
  await page.fill("#fStart", "2026-08-10");
  await page.fill("#fEnd", "2026-08-01");
  assert.ok(await focusOn("#fSave"));
  await pressEnter();
  assert.match(await page.text("#fMsg"), /раньше/);
  f = await focused();
  assert.equal(f.id, "fEnd", "focus goes to «Уехали»");
  assert.equal(await page.eval(`document.getElementById("fEnd").getAttribute("aria-invalid")`), "true");
  assert.match(await describedBy("#fEnd"), /раньше/);
  assert.notEqual(await page.eval(`document.getElementById("fPlace").getAttribute("aria-invalid")`), "true", "the fixed place list is no longer marked invalid");
});

test("choosing «откуда знаем» with the keyboard keeps focus on that question", { skip }, async () => {
  await open("#/rate/new/belgrad");
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  assert.ok(await focusOn('[data-conf="интернет"]'));
  await pressEnter();
  assert.equal(await page.visible('[data-confpick="интернет"]'), true, "the choices open");
  await pressTab();
  assert.match((await focused()).label, /проверили в быту/);
  await pressEnter();
  assert.match(await page.text('[data-conf="интернет"]'), /проверили в быту/, "the choice is saved");
  const f = await focused();
  assert.ok(!f.body && !f.gone && (await page.eval(`!!document.activeElement.closest('[data-q="интернет"]')`)), `focus is «${f.label}»: after every choice the keyboard user is thrown to the top of the page`);
});

test("Escape closes the «откуда знаем» choices and returns focus to their button", { skip }, async () => {
  await open("#/rate/new/belgrad");
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  assert.ok(await focusOn('[data-conf="интернет"]'));
  await pressEnter();
  await pressTab();
  await pressEscape();
  assert.equal(await page.visible('[data-confpick="интернет"]'), false, "Escape closes the choices");
  assert.equal(await page.eval(`document.querySelector('[data-conf="интернет"]').getAttribute("aria-expanded")`), "false");
  assert.equal(await page.eval(`document.activeElement === document.querySelector('[data-conf="интернет"]')`), true, "focus returns to «откуда знаем»");
});

test("each «×» next to an unsaved draft says which draft it throws away", { skip }, async () => {
  await open("#/rate/new/batumi");
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  await page.eval(`location.hash = "#/rate/new/tbilisi"`);
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 3000);
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="2"]').click()`);
  await page.eval(`location.hash = "#/rate/new/belgrad"`);
  await page.waitFor(`document.querySelectorAll(".draft-chip").length === 2`, 3000, "two drafts");
  const chips = await page.eval(`[...document.querySelectorAll(".draft-chip")].map(c => ({ draft: c.querySelector("[data-draft]").innerText.split(" (")[0], x: c.querySelector("[data-dropdraft]").getAttribute("aria-label") || c.querySelector("[data-dropdraft]").innerText }))`);
  assert.deepEqual(chips.filter(c => !c.x.includes(c.draft)).map(c => `${c.draft}: «${c.x}»`), [], "VoiceOver hears two identical «Выбросить черновик» buttons");
});

/* ---------- place dossier ---------- */

test("every «Откуда» field in «Цифры места» says which number it belongs to", { skip }, async () => {
  await open("#/place/porto");
  const names = (await axAll('#factsForm input[name^="src_"]')).map(n => n.name);
  assert.equal(names.length, 5);
  assert.equal(new Set(names).size, names.length, `source fields are read as: ${names.join(" | ")}`);
});

test("a wrong number or an empty place name is flagged on that field, focused and described", { skip }, async () => {
  await open("#/place/porto");
  await page.fill('#factsForm [name="fact_rent"]', "дорого");
  assert.ok(await focusOn("#factsForm [type=submit]"));
  await pressEnter();
  assert.match(await page.text("#factsMsg"), /Не число/);
  assert.equal(await page.eval(`document.activeElement.name || ""`), "fact_rent", "focus goes to the rent field");
  assert.equal(await page.eval(`document.querySelector('[name="fact_rent"]').getAttribute("aria-invalid")`), "true");
  assert.match(await describedBy('[name="fact_rent"]'), /Не число/);

  await page.fill('#placeForm [name="name"]', "");
  assert.ok(await focusOn("#placeForm [type=submit]"));
  await pressEnter();
  assert.match(await page.text("#placeMsg"), /не может быть пустым/);
  assert.equal(await page.eval(`document.activeElement.name || ""`), "name", "focus goes to «Название»");
  assert.equal(await page.eval(`document.querySelector('#placeForm [name="name"]').getAttribute("aria-invalid")`), "true");
  assert.match(await describedBy('#placeForm [name="name"]'), /пуст/);
});

test("saving the place numbers with the keyboard keeps focus in that form", { skip }, async () => {
  await open("#/place/porto");
  await page.fill('#factsForm [name="fact_rent"]', "900");
  assert.ok(await focusOn("#factsForm [type=submit]"));
  await pressEnter();
  await page.waitFor(`/сохранены/.test((document.getElementById("factsMsg") || {}).innerText || "")`, 5000, "saved");
  const f = await focused();
  assert.ok(!f.body && (await page.eval(`!!document.activeElement.closest("#factsForm")`)), `after «Сохранить цифры» focus is «${f.label}», the keyboard user starts over from the header`);
});

test("«Показать всё равно» with the keyboard leaves focus on the place page", { skip }, async () => {
  await open("#/place/tbilisi");
  assert.ok(await focusOn("[data-reveal]"));
  await pressEnter();
  await page.waitFor(`!document.querySelector("[data-reveal]")`, 3000, "revealed");
  const f = await focused();
  assert.ok(!f.body && f.view === "v-place", `after revealing focus is «${f.label}»`);
});

test("the radar chart has a text alternative with each person's group scores", { skip }, async () => {
  await open("#/place/porto");
  const want = await page.eval(`(async () => { const s = ${APP}; const { fmt } = await import("./js/calc.js"); const M = s.M, p = M.PLACE.porto; return M.PEOPLE.map(w => ({ w, vals: [...new Set(M.GROUPS.map(g => M.groupScore(p, g.key, w)).filter(v => v != null).map(fmt))] })); })()`);
  const text = await page.eval(`(() => {
    const box = document.querySelector(".dossier"), svg = box.querySelector(".radar svg");
    const refs = a => (svg.getAttribute(a) || "").split(/\\s+/).filter(Boolean).map(id => (document.getElementById(id) || {}).textContent || "").join(" ");
    const clone = box.cloneNode(true);
    clone.querySelectorAll("svg, .trips, [aria-hidden=true]").forEach(e => e.remove());
    return [svg.getAttribute("aria-label"), refs("aria-labelledby"), refs("aria-describedby"), [...svg.querySelectorAll(":scope > title, :scope > desc")].map(e => e.textContent).join(" "), clone.textContent].join(" ").replace(/\\s+/g, " ").replace(/(\\d),(\\d)/g, "$1.$2");
  })()`);
  const missing = [];
  want.forEach(({ w, vals }) => { if (!text.includes(w)) missing.push(w); vals.forEach(v => { if (!text.includes(v)) missing.push(`${w} ${v}`); }); });
  if (!/Работа/.test(text)) missing.push("group names");
  assert.deepEqual(missing, [], `a screen reader gets only: «${text.slice(0, 160)}»`);
});

test("the climate chart has a text alternative with the monthly temperatures", { skip }, async () => {
  await open("#/place/porto");
  await page.waitFor(`!!document.querySelector(".clim svg")`, 4000, "climate chart");
  const text = await page.eval(`(() => {
    const c = document.querySelector(".clim"), svg = c.querySelector("svg");
    const refs = a => (svg.getAttribute(a) || "").split(/\\s+/).filter(Boolean).map(id => (document.getElementById(id) || {}).textContent || "").join(" ");
    const clone = c.cloneNode(true); clone.querySelectorAll("svg, [aria-hidden=true]").forEach(e => e.remove());
    return [svg.getAttribute("aria-label"), refs("aria-labelledby"), refs("aria-describedby"), [...svg.querySelectorAll(":scope > title, :scope > desc")].map(e => e.textContent).join(" "), clone.textContent, (c.nextElementSibling || {}).textContent || ""].join(" ").replace(/\\s+/g, " ");
  })()`);
  assert.match(text, /янв/i, `months are not spelled out; a screen reader gets only: «${text.slice(0, 160)}»`);
  assert.ok((text.match(/[−-]?\d+([.,]\d)?\s*°/g) || []).length >= 12, `no temperature per month; a screen reader gets only: «${text.slice(0, 160)}»`);
});

test("a hidden partner score in the subcategory table is read as «скрыто», not as a dot", { skip }, async () => {
  await open("#/place/tbilisi");
  const cells = await axAll(".subtable td.n.muted");
  assert.ok(cells.length > 0, "Вика's scores are hidden from Михаил");
  assert.deepEqual([...new Set(cells.map(c => c.name).filter(n => !/скрыт/i.test(n)))], [], "VoiceOver reads the hidden score as «точка»");
});

/* ---------- ranking ---------- */

test("each ranking row tells a screen reader each person's score, not only the dots", { skip }, async () => {
  await open("#/rank");
  const per = await page.eval(`(async () => { const s = ${APP}; const { normalize, fmt } = await import("./js/calc.js"); const W = normalize(s.schema.groups, s.weights); const row = s.M.ranking(W).rated.find(r => r.p.id === "bar"); return Object.entries(row.per).filter(([, v]) => v != null).map(([w, v]) => [w, fmt(v)]); })()`);
  assert.equal(per.length, 2, "both of us rated Бар");
  const ax = await axOf('#rank a.row[href="#/place/bar"]');
  const said = (ax.name + " " + ax.description).replace(/(\d),(\d)/g, "$1.$2");
  const missing = per.filter(([w, v]) => !new RegExp(w + "[^0-9]{0,15}" + v.replace(".", "\\.")).test(said));
  assert.deepEqual(missing, [], `the row is read as «${said}»`);
});

test("weight sliders are named by the group alone and announce the share as points out of 100", { skip }, async () => {
  await open("#/rank", { local: { "wtl:wopen": true } });
  const groups = await page.eval(`(async () => ${APP}.schema.groups.map(g => g.name))()`);
  const sl = await axAll("#wgrid input[type=range]");
  assert.equal(sl.length, groups.length);
  // Chrome's CDP tree reports the raw number as «valuetext» for native sliders and ignores aria-valuetext, so the announced text is read from the attribute
  const attr = await page.eval(`[...document.querySelectorAll("#wgrid input[type=range]")].map(e => e.getAttribute("aria-valuetext") || "")`);
  const bad = sl.map((s, i) => (s.name.trim() !== groups[i] ? `name «${s.name}»` : "") + (/из 100|очк/.test(s.valuetext || "") || /из 100|очк/.test(attr[i]) ? "" : ` value «${s.valuetext}»`)).filter(Boolean);
  assert.deepEqual(bad, [], "now a slider reads «Работа 9, ползунок, 9» and the number in the name goes stale while dragging");
});

test("arrow keys on a weight slider change it, rebalance the rest to 100 and switch to «Своё»", { skip }, async () => {
  await open("#/rank", { local: { "wtl:wopen": true } });
  const v0 = Number(await page.eval(`document.getElementById("w-legal").value`));
  assert.ok(await focusOn("#w-legal"));
  await pressRight();
  await page.waitFor(`Number(document.getElementById("w-legal").value) === ${v0 + 1}`, 2000, "slider moved");
  const sum = await page.eval(`[...document.querySelectorAll("#wgrid input[type=range]")].reduce((a, e) => a + Number(e.value), 0)`);
  assert.ok(Math.abs(sum - 100) <= 1, `shares add up to ${sum}`);
  assert.equal(await page.eval(`document.querySelector('#presets [data-p="Своё"]').getAttribute("aria-pressed")`), "true");
  assert.equal((await focused()).id, "w-legal", "focus stays on the slider");
});

test("saving weights with the keyboard does not throw focus to the top of the page", { skip }, async () => {
  await open("#/rank", { local: { "wtl:wopen": true } });
  assert.ok(await focusOn("#wsaveBtn"));
  await pressEnter();
  await toastText(/Сохранено/);
  const f = await focused();
  assert.ok(!f.body && f.view === "v-rank", `after «Сохранить как мои веса» focus is «${f.label}»`);
});

test("on the ranking, colour is never the only carrier: groups, cells, pale rows and flags all have words", { skip }, async () => {
  await open("#/rank");
  const groups = await page.eval(`(async () => ${APP}.M.GROUPS.map(g => g.name))()`);
  const heads = (await axAll("#heat thead th")).slice(1);
  assert.deepEqual(heads.map((h, i) => (h.name + " " + h.description).includes(groups[i])), groups.map(() => true), "every column header gives the full group name");
  const cells = await page.eval(`[...document.querySelectorAll("#heat td.cell")].map(c => c.innerText.trim())`);
  assert.deepEqual(cells.filter(t => !/^(\d\.\d|—)$/.test(t)), [], "every heat cell shows its number");
  const paleHeat = await page.eval(`[...document.querySelectorAll("#heat tr.pale")].map(r => (r.querySelector(".tag") || {}).innerText || "")`);
  assert.ok(paleHeat.length && paleHeat.every(Boolean), "pale table rows say why");
  const paleRows = await page.eval(`[...document.querySelectorAll("#rank a.row.pale")].map(r => r.querySelector(".chips").innerText.trim())`);
  assert.ok(paleRows.length && paleRows.every(Boolean), "pale ranking rows say why");
  const flags = await page.eval(`[...document.querySelectorAll(".flag .sev")].map(e => e.innerText.trim())`);
  assert.ok(flags.length && flags.every(Boolean), "every flag has a text label");
});

test("each «Записать мою» and «Выбросить» button says which unsent change it acts on", { skip }, async () => {
  const lost = [
    { path: "ratings/a1.json", content: JSON.stringify({ id: "a1", place: "porto", who: "Михаил", start: "2026-08-01", end: "2026-08-20", scores: { "интернет": 5 } }), at: T },
    { path: "ratings/a3.json", content: JSON.stringify({ id: "a3", place: "valensiya", who: "Михаил", start: "2026-08-01", end: "2026-08-20", scores: { "интернет": 5 } }), at: T },
  ];
  await open("#/rank", { local: { "wtl:lost": lost } });
  await page.waitFor(`document.querySelectorAll("[data-lostapply]").length === 2`, 3000, "lost banner");
  const places = ["Порту", "Валенсия"];
  const missing = [];
  for (const sel of ["[data-lostapply]", "[data-lostdrop]"]) {
    (await axAll(sel)).forEach((b, i) => { const t = (b.name + " " + b.description).trim(); if (!t.includes(places[i])) missing.push(`«${t}» for ${places[i]}`); });
  }
  assert.deepEqual(missing, [], "VoiceOver hears «Записать мою, Выбросить, Записать мою, Выбросить» with no place");
});

/* ---------- announcements ---------- */

test("the toast live region stays in the accessibility tree between messages, so each new one is heard", { skip }, async () => {
  await open("#/map");
  const before = await axOf("#toast");
  assert.ok(before && !before.ignored, "before the first message the toast is display:none, so VoiceOver does not track it as a live region");
  assert.equal(before.live, "polite");
  await page.tap({ sel: "#themeBtn" });
  await toastText(/Тема/);
  const shown = await axOf("#toast");
  assert.equal(shown.ignored, false);
  assert.match(shown.name + (await page.text("#toast")), /Тема/);
});

test("changes of the sync status are announced politely", { skip }, async () => {
  await open("#/rate/new/belgrad");
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  await page.eval(`document.getElementById("fSave").click()`);
  await page.waitFor(`/В очереди/.test(document.getElementById("syncText").innerText)`, 6000, "queued status");
  assert.match(await liveText("#toast"), /В очереди/, "the status in the header changes silently; only sighted users see «В очереди: 1»");
});

test("messages under the rating form and in settings are polite live regions", { skip }, async () => {
  const live = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && (["status", "alert"].includes(e.getAttribute("role")) || !!e.closest('[aria-live]:not([aria-live="off"])')); })()`);
  await open("#/rate");
  assert.equal(await live("#fMsg"), true, "rating form message");
  await open("#/settings");
  assert.equal(await live("#tokenMsg"), true, "key check message");
});

/* ---------- visual ---------- */

test("on a phone in dark mode every Tab stop shows a focus ring that stands out from the page", { skip }, async () => {
  await page.viewport(390, 844, { dark: true });
  const bad = [];
  for (const route of ["#/map", "#/rate", "#/places", "#/place/tbilisi"]) {
    await open(route);
    if (route === "#/map") { await pinReady("Порту"); await page.eval(`document.querySelector('.leaflet-marker-icon[title="Порту"]').click()`); await page.waitFor(`!document.getElementById("sheet").hidden`, 3000); }
    await blur();
    for (let i = 0; i < 45; i++) {
      await pressTab(false, 25);
      const s = await page.eval(RING);
      if (s.label === "BODY") break;
      if (s.gone) bad.push(`${route}: «${s.label}» is focused while hidden`);
      else if (!s.ring && !s.date) bad.push(`${route}: «${s.label}» has no ring`);
      else if (s.ratio != null && s.ratio < 3) bad.push(`${route}: «${s.label}» ring contrast ${s.ratio}:1`);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});

test("with reduced motion, zooming to a cluster or to a country jumps there without a flight", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("#/map");
  await reduceMotion();
  await pinReady("Порту");
  await page.eval(`(async () => { ${APP}.mapView.map.setView([42, 30], 3, { animate: false }); })()`);
  await page.waitFor(`[...document.querySelectorAll(".leaflet-marker-icon")].some(e => /рядом/.test(e.getAttribute("aria-label") || ""))`, 3000, "a cluster");
  const arm = () => page.eval(`(async () => { const m = ${APP}.mapView.map; window.__dt = null; const t0 = performance.now(); m.once("moveend", () => { window.__dt = Math.round(performance.now() - t0); }); })()`);
  await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].find(e => /рядом/.test(e.getAttribute("aria-label") || "")).focus()`);
  await arm();
  await pressEnter();
  const cluster = await page.waitFor(`window.__dt != null && window.__dt`, 4000, "cluster zoom finished").catch(() => -1);

  await page.eval(`(async () => { ${APP}.mapView.map.setView([42, 30], 3, { animate: false }); })()`);
  assert.ok(await focusOn("#searchInput"));
  await page.type("Грузия");
  await page.waitFor(`[...document.querySelectorAll("#searchResults button")].some(b => /страна/.test(b.innerText))`, 3000, "country suggestion");
  await page.eval(`[...document.querySelectorAll("#searchResults button")].find(b => /страна/.test(b.innerText)).focus()`);
  await arm();
  await pressEnter();
  const country = await page.waitFor(`window.__dt != null && window.__dt`, 4000, "country zoom finished").catch(() => -1);
  const quick = ms => ms >= 0 && ms < 300;
  assert.deepEqual({ cluster: quick(cluster), country: quick(country) }, { cluster: true, country: true }, `animated flights: cluster ${cluster} ms, country ${country} ms`);
});

test("with reduced motion, the just-saved trip is not pulsed", { skip }, async () => {
  await open("#/rate/new/belgrad");
  await reduceMotion();
  await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').click()`);
  await page.eval(`document.getElementById("fSave").click()`);
  await page.waitFor(`location.hash.startsWith("#/place/belgrad") && !!document.querySelector(".trip.flash")`, 6000, "flashed trip");
  const anim = await page.eval(`(() => { const cs = getComputedStyle(document.querySelector(".trip.flash")); return cs.animationName === "none" || parseFloat(cs.animationDuration) === 0 ? "none" : cs.animationName + " " + cs.animationDuration; })()`);
  assert.equal(anim, "none", "the saved trip still pulses with a 2.4 s ring");
});

test("at 200% page zoom on an iPhone (195 CSS px) the header keeps «Настройки» on screen and the status readable", { skip }, async () => {
  await page.viewport(195, 422);
  const bad = [];
  for (const route of ["#/map", "#/places", "#/rate"]) {
    await open(route);
    const r = await page.eval(`(() => {
      const out = [], vw = innerWidth;
      if (document.documentElement.scrollWidth > vw + 1) out.push("page scrolls sideways");
      [["тема", document.getElementById("themeBtn")], ["настройки", document.querySelector('.appbar a[href="#/settings"]')], ["статус", document.getElementById("syncBtn")]].forEach(([n, e]) => { const b = e.getBoundingClientRect(); if (b.width && (b.right > vw + 1 || b.left < -1)) out.push(n + " off screen " + Math.round(b.left) + "–" + Math.round(b.right)); });
      const t = document.getElementById("syncText");
      if (t.getClientRects().length && t.scrollWidth > t.clientWidth + 1) out.push("status «" + t.textContent + "» cut to " + t.clientWidth + " px");
      return out;
    })()`);
    r.forEach(x => bad.push(`${route}: ${x}`));
  }
  assert.deepEqual(bad, []);
});

test("at 200% zoom on a computer (640 CSS px) no screen scrolls sideways and every control stays on screen", { skip }, async () => {
  await page.viewport(640, 400);
  const bad = [];
  for (const route of ["#/map", "#/rank", "#/places", "#/place/porto", "#/rate", "#/settings"]) {
    await open(route);
    const r = await page.eval(`(() => {
      const out = [], vw = innerWidth;
      if (document.documentElement.scrollWidth > vw + 1) out.push("page scrolls sideways: " + document.documentElement.scrollWidth);
      [...document.querySelectorAll("a, button, input, select, textarea")].filter(e => !e.closest("[hidden], .leaflet-container, .scroll") && !(e.closest("details:not([open])") && !e.closest("summary")) && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && e.type !== "hidden")
        .forEach(e => { const b = e.getBoundingClientRect(); if (b.right > vw + 1 || b.left < -1) out.push("off screen: " + (e.id || e.getAttribute("aria-label") || e.innerText || e.tagName).slice(0, 30)); });
      return out;
    })()`);
    r.forEach(x => bad.push(`${route}: ${x}`));
  }
  assert.deepEqual(bad, []);
});

test("every visible input, list and text box on every screen has a name for screen readers", { skip }, async () => {
  const bad = [];
  const sweep = async where => {
    const sel = ".view:not([hidden]) input:not([type=hidden]), .view:not([hidden]) select, .view:not([hidden]) textarea, #layersPanel:not([hidden]) input, #layersPanel:not([hidden]) select";
    const vis = await page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => !e.closest("[hidden]") && !(e.closest("details:not([open])")) && e.getClientRects().length > 0)`);
    const ax = await axAll(sel);
    ax.forEach((n, i) => { if (vis[i] && !n.name.trim()) bad.push(`${where}: ${n.role} without a name`); });
  };
  for (const route of ["#/rate", "#/place/porto", "#/settings", "#/places"]) { await open(route); await sweep(route); }
  await open("#/rank", { local: { "wtl:wopen": true } });
  await sweep("#/rank");
  await open("#/map");
  await page.tap({ sel: "#layersBtn" });
  await sweep("#/map layers");
  assert.deepEqual(bad, []);
});
