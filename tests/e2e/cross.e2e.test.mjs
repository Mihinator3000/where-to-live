import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) await page.viewport(390, 844, { dark: false }); });

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];

const shownView = () => page.eval(`document.querySelector(".view:not([hidden])")?.id || ""`);
const currentNav = (scope = "") => page.eval(`[...document.querySelectorAll(${JSON.stringify(scope + " [aria-current=page]")})].map(a => a.dataset.nav)`);
const h1 = () => page.eval(`document.querySelector(".view:not([hidden]) h1")?.innerText || ""`);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const booted = () => page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 8000, "app booted");
const hashIs = h => page.waitFor(`location.hash === ${JSON.stringify(h)}`, 4000, "hash " + h);

async function key(k, code, vk, text, modifiers = 0, settle = 120) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, text, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(settle);
}
const pressTab = (shift = false) => key("Tab", "Tab", 9, undefined, shift ? 8 : 0, 50);
const pressSpace = () => key(" ", "Space", 32, " ");
const pressEnter = () => key("Enter", "Enter", 13, "\r");
const pressEscape = () => key("Escape", "Escape", 27);
const focused = () => page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return { tag: "BODY" }; return { tag: e.tagName, id: e.id, label: (e.getAttribute("aria-label") || e.innerText || e.value || e.title || "").replace(/\\s+/g, " ").trim().slice(0, 40), pressed: e.getAttribute("aria-pressed") }; })()`);

async function reload() {
  await page.eval("window.__beforeReload = 1");
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 10000, "reloaded");
}

// Opens the app with no saved copy of our data. delay: GitHub answers that late; "hold": GitHub does not answer at all
// until release() — the screen can then be checked while the data is surely still loading.
async function coldOpen(hash, delay) {
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.eval(`localStorage.removeItem("wtl:cache"); ${delay === "hold" ? `localStorage.setItem("mock:hold", "1")` : `localStorage.setItem("mock:delay", "${delay}")`}`);
  await page.goto(srv.url + hash, 0);
}
const release = () => page.eval(`localStorage.removeItem("mock:hold")`);

async function axNodes(sel) {
  const { root } = await page.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await page.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: sel });
  const out = [];
  for (const nodeId of nodeIds) {
    const { nodes } = await page.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const { attributes } = await page.send("DOM.getAttributes", { nodeId });
    const attrs = {};
    for (let i = 0; i < attributes.length; i += 2) attrs[attributes[i]] = attributes[i + 1];
    const n = nodes[0] || {};
    out.push({ name: (n.name && n.name.value) || "", role: (n.role && n.role.value) || "", attrs });
  }
  return out;
}

const SPOTS = [["PRT", "Португалия", 38.72, -9.14], ["ESP", "Испания", 40.42, -3.7], ["GEO", "Грузия", 41.72, 44.78], ["SRB", "Сербия", 44.79, 20.45], ["MNE", "Черногория", 42.44, 19.26], ["TUR", "Турция", 41.01, 28.98], ["ITA", "Италия", 41.9, 12.5], ["GRC", "Греция", 37.98, 23.73], ["HRV", "Хорватия", 45.81, 15.98], ["ARM", "Армения", 40.18, 44.51], ["CYP", "Кипр", 35.17, 33.36], ["BGR", "Болгария", 42.7, 23.32], ["ALB", "Албания", 41.33, 19.82], ["MKD", "Северная Македония", 41.99, 21.43], ["BIH", "Босния и Герцеговина", 43.86, 18.41], ["SVN", "Словения", 46.06, 14.51], ["HUN", "Венгрия", 47.5, 19.04], ["CZE", "Чехия", 50.08, 14.44], ["POL", "Польша", 52.23, 21.01], ["DEU", "Германия", 52.52, 13.4], ["FRA", "Франция", 48.86, 2.35], ["NLD", "Нидерланды", 52.37, 4.9], ["AUT", "Австрия", 48.21, 16.37], ["ROU", "Румыния", 44.43, 26.1], ["KAZ", "Казахстан", 43.24, 76.89], ["UZB", "Узбекистан", 41.3, 69.24], ["ISR", "Израиль", 32.09, 34.78], ["THA", "Таиланд", 13.75, 100.5], ["VNM", "Вьетнам", 21.03, 105.85]];

function bigRepo() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const places = [PLACES[0]];
  SPOTS.forEach(([cc, country, lat, lon], i) => {
    const n = String(i + 1).padStart(2, "0");
    places.push({ id: "test-" + n, name: "Тестоград " + n, country, cc, lat, lon, status: i % 9 === 8 ? "финалист" : "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T });
  });
  const ratings = [];
  for (let i = 0; i < 100; i++) {
    const idx = 1 + (i % SPOTS.length), bias = 1.2 + 3.6 * (idx - 1) / (SPOTS.length - 1);
    const scores = {};
    STAR.forEach(k => { scores[k] = Math.max(1, Math.min(5, Math.round((bias + rnd() - 0.5) * 2) / 2)); });
    const m = String(1 + (i % 12)).padStart(2, "0");
    ratings.push({ id: "rt" + i, place: places[idx].id, who: i % 2 ? "Вика" : "Михаил", start: `2025-${m}-01`, end: `2025-${m}-10`, days: 10, season: "пик", mode: "удалёнка", housing: "центр", retro: false, year: Math.floor(rnd() * 11), veto: "", review: "Синтетический отзыв " + i, scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T });
  }
  return repo({ places, ratings });
}

function strongRepo() {
  const all = v => Object.fromEntries(STAR.map(k => [k, v]));
  return repo({ ratings: RATINGS.map(r => (r.place === "porto" ? Object.assign({}, r, { scores: all(5) }) : r.place === "valensiya" ? Object.assign({}, r, { scores: all(1) }) : r)) });
}

const CONTRAST = sel => `(() => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const x = cv.getContext("2d", { willReadFrequently: true });
  const rgba = c => { x.clearRect(0, 0, 1, 1); x.fillStyle = "rgba(0,0,0,0)"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (t, u) => [0, 1, 2].map(i => t[i] * t[3] + u[i] * (1 - t[3])).concat(1);
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let base = rgba(getComputedStyle(document.body).backgroundColor); for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText.trim() && !e.closest("[hidden]")).map(e => {
    const bg = bgOf(e), fg = over(rgba(getComputedStyle(e).color), bg);
    const a = lum(fg), b = lum(bg);
    return { text: e.innerText.trim(), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
  });
})()`;

const LAYOUT = `(() => {
  const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden"; };
  const clipped = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { if (p.matches("main, .page")) continue; if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "")) + " «" + (e.innerText || e.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 24) + "»";
  const layer = e => e.closest(".appbar, .bottomnav, .savebar, #sheet, .map-top, #layersPanel, #legendBox, #toast") || "flow";
  const out = { overflow: document.documentElement.scrollWidth - innerWidth, off: [], overlap: [] };
  const view = document.querySelector(".view:not([hidden])");
  const all = [...document.querySelectorAll(".appbar *, .bottomnav *")].concat([...view.querySelectorAll("*")]).filter(e => !e.closest(".leaflet-container, svg") && vis(e));
  for (const e of all) { if (clipped(e)) continue; const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) out.off.push(desc(e) + " " + Math.round(r.left) + "→" + Math.round(r.right)); }
  const ctl = all.filter(e => e.matches("button, a, input, select, textarea, summary") && !clipped(e));
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j];
    if (a.contains(b) || b.contains(a) || layer(a) !== layer(b)) continue;
    if (a.closest("label") && a.closest("label") === b.closest("label")) continue;
    const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    if (Math.min(r.right, s.right) - Math.max(r.left, s.left) > 2 && Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) > 2) out.overlap.push(desc(a) + " × " + desc(b));
  }
  return out;
})()`;

const ROUTES = ["#/map", "#/rank", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/place/no-such-place", "#/rate", "#/settings"];

async function layoutSweep(w, h) {
  const problems = [];
  for (const dark of [false, true]) {
    await page.viewport(w, h, { dark });
    for (const route of ROUTES) {
      await openApp(page, srv.url, { hash: route });
      if (route === "#/rate") await page.eval(`document.getElementById("fShowAll").click()`);
      const o = await page.eval(LAYOUT);
      const tag = `${w}×${h} ${dark ? "dark" : "light"} ${route}`;
      if (o.overflow > 1) problems.push(`${tag}: page scrolls sideways by ${o.overflow}px`);
      o.off.slice(0, 3).forEach(x => problems.push(`${tag}: sticks out of the screen: ${x}`));
      o.overlap.slice(0, 3).forEach(x => problems.push(`${tag}: controls overlap: ${x}`));
    }
    await openApp(page, srv.url, { hash: "#/map", intro: true });
    let o = await page.eval(LAYOUT);
    o.off.concat(o.overlap).slice(0, 3).forEach(x => problems.push(`${w}×${h} ${dark ? "dark" : "light"} map with the intro card: ${x}`));
    const close = await page.locate({ sel: "#sheetClose" });
    if (close.error || close.covered) problems.push(`${w}×${h} map: the card's close button is ${close.error || "covered by " + close.covered}`);
    await page.eval(`document.getElementById("sheetClose").click(); document.getElementById("layersBtn").click()`);
    o = await page.eval(LAYOUT);
    o.off.concat(o.overlap).slice(0, 3).forEach(x => problems.push(`${w}×${h} ${dark ? "dark" : "light"} map with layers open: ${x}`));
  }
  assert.deepEqual(page.takeErrors(), [], "no JS errors");
  return problems;
}

async function killableServer() {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(ROOT, path));
    try {
      if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error("no");
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end("not found"); }
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, kill: () => new Promise(r => { server.close(r); sockets.forEach(s => s.destroy()); }) };
}

const swReady = () => page.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active && r.active.state === "activated"))`, 10000, "service worker active");

async function bootTime(hash, readyJs) {
  await page.goto(srv.url + "manifest.webmanifest", 50);
  const t0 = Date.now();
  await page.send("Page.navigate", { url: srv.url + hash });
  await page.waitFor(`document.readyState === "complete" && document.getElementById("syncText").innerText === "Подключено" && (${readyJs})`, 15000, "ready " + hash);
  // ready = also no long task: three timer turns in a row inside the page, each under 50 ms apart
  await page.eval(`new Promise(r => { let n = 0, last = performance.now(); const tick = () => { const now = performance.now(); n = now - last < 50 ? n + 1 : 0; last = now; if (n >= 3) r(); else setTimeout(tick, 0); }; setTimeout(tick, 0); })`);
  return Date.now() - t0;
}

/* ---------- navigation ---------- */

test("bottom navigation opens each screen and marks only that tab as current", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  for (const [label, nav, view, title] of [["Рейтинг", "rank", "v-rank", "Рейтинг"], ["Места", "places", "v-places", "Места"], ["Оценить", "rate", "v-rate", ""], ["Карта", "map", "v-map", ""]]) {
    await page.tap({ sel: ".bottomnav a", text: label });
    assert.equal(await page.eval("location.hash"), "#/" + nav);
    assert.equal(await shownView(), view, `${label} opens its screen`);
    assert.deepEqual(await currentNav(".bottomnav"), [nav], `${label} is the only current tab`);
    if (title) assert.equal(await h1(), title);
  }
  await page.tap({ sel: ".appbar a", text: "Настройки" });
  assert.equal(await shownView(), "v-settings");
  assert.equal(await h1(), "Настройки");
  assert.deepEqual(await currentNav(".bottomnav"), [], "no bottom tab is current on settings");
  assert.deepEqual(await currentNav(".appbar-tools"), ["settings"], "the gear shows it is current");
  assert.deepEqual(page.takeErrors(), []);
});

test("on a desktop the header tabs replace the bottom bar and highlight the current screen", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/map" });
  assert.equal(await page.visible(".bottomnav"), false, "no bottom bar on desktop");
  assert.equal(await page.visible(".tabs"), true, "header tabs on desktop");
  for (const [label, nav, view] of [["Рейтинг", "rank", "v-rank"], ["Места", "places", "v-places"], ["Оценить", "rate", "v-rate"], ["Карта", "map", "v-map"]]) {
    await page.tap({ sel: ".tabs a", text: label });
    assert.equal(await shownView(), view);
    assert.deepEqual(await currentNav(".tabs"), [nav]);
  }
  await page.tap({ sel: ".tabs a", text: "Места" });
  await page.tap({ sel: ".prow", text: "Порту" });
  assert.equal(await h1(), "Порту");
  assert.deepEqual(await currentNav(".tabs"), ["places"], "a dossier keeps «Места» highlighted");
});

test("a fresh load of every deep link opens the right screen", { skip }, async () => {
  const cases = [
    ["#/map", "v-map", "", "map"],
    ["#/rank", "v-rank", "Рейтинг", "rank"],
    ["#/places", "v-places", "Места", "places"],
    ["#/place/porto", "v-place", "Порту", "places"],
    ["#/place/sankt-peterburg", "v-place", "Санкт-Петербург", "places"],
    ["#/rate", "v-rate", "", "rate"],
    ["#/settings", "v-settings", "Настройки", "settings"],
  ];
  for (const [hash, view, title, nav] of cases) {
    await openApp(page, srv.url, { hash });
    assert.equal(await shownView(), view, hash);
    if (title) assert.equal(await h1(), title, hash);
    assert.ok((await currentNav()).includes(nav), `${hash} highlights ${nav}`);
  }
  await openApp(page, srv.url, { hash: "#/place/sankt-peterburg" });
  assert.match(await page.text("#v-place"), /база по определению/);
  await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi", "rate link preselects the place");
  assert.equal(await page.eval("location.hash"), "#/rate");
  assert.deepEqual(page.takeErrors(), []);
});

test("an unknown address falls back to the map and Back does not bounce through it", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`location.hash = "#/no-such-screen"`);
  await hashIs("#/map");
  assert.equal(await shownView(), "v-map");
  await page.eval("history.back()");
  await hashIs("#/rank");
  assert.equal(await shownView(), "v-rank");
});

test("an unknown rating id says so and leaves a clean new-rating form", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.eval(`location.hash = "#/rate/no-such-rating"`);
  assert.match(await toastText(/Оценка не найдена/), /Оценка не найдена/);
  assert.equal(await page.eval("location.hash"), "#/rate");
  assert.equal(await page.text("#fSave"), "Сохранить", "not in edit mode");
  assert.equal(await page.visible("#fDelete"), false);
});

test("a deep link with broken percent-encoding does not break the app", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`location.hash = "#/place/%E0%A4%A"`);
  await sleep(300);
  assert.deepEqual(page.takeErrors(), [], "following the link throws no error");
  assert.notEqual(await shownView(), "v-rank", "the link leads somewhere instead of leaving the old screen up");
  await page.goto(srv.url + "#/place/%E0%A4%A", 300);
  await booted().catch(() => {});
  assert.doesNotMatch(await page.text("#main"), /Не загрузилось/, "a cold start from the link boots normally");
  assert.notEqual(await page.text("#syncText"), "…", "data starts loading");
  assert.deepEqual(page.takeErrors(), []);
});

test("a link to edit my rating opens that rating even when the app starts cold", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await coldOpen("#/rate/r1", 600);
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 8000, "data loaded");
  await sleep(200);
  assert.equal(await page.text("#fSave"), "Сохранить правку", "the form edits the linked rating");
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "porto");
  assert.match(await page.text("#fTop"), /Правка оценки: Порту/);
});

test("on a slow first load a place link and the list do not claim that nothing exists", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await coldOpen("#/place/porto", "hold");
  await page.waitFor(`document.getElementById("syncText")?.innerText === "Обновляю…" && !document.getElementById("v-place").hidden`, 6000, "dossier screen while loading");
  assert.equal(await page.text("#syncText"), "Обновляю…", "still loading");
  assert.doesNotMatch(await page.text("#v-place"), /Место не найдено/, "the dossier does not say the place is missing while loading");
  await release();
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Порту"`, 8000, "dossier filled in");
  await coldOpen("#/places", "hold");
  await page.waitFor(`document.getElementById("syncText")?.innerText === "Обновляю…" && !document.getElementById("v-places").hidden`, 6000, "list screen while loading");
  assert.doesNotMatch(await page.text("#v-places"), /Мест пока нет/, "the list does not say there are no places while loading");
  await release();
  await page.waitFor(`document.querySelectorAll(".prow").length === 6`, 8000, "list filled in");
});

test("Back and Forward walk through the screens I visited, in order", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  await page.tap({ sel: ".bottomnav a", text: "Места" });
  await page.tap({ sel: ".prow", text: "Порту" });
  await page.tap({ sel: "#v-place a.btn", text: "Оценить" });
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "porto");
  const steps = [["back", "#/place/porto", "v-place"], ["back", "#/places", "v-places"], ["back", "#/rank", "v-rank"], ["back", "#/map", "v-map"], ["forward", "#/rank", "v-rank"], ["forward", "#/places", "v-places"], ["forward", "#/place/porto", "v-place"], ["forward", "#/rate", "v-rate"]];
  for (const [dir, hash, view] of steps) {
    await page.eval(`history.${dir}()`);
    await hashIs(hash);
    assert.equal(await shownView(), view, `${dir} → ${hash}`);
  }
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "porto", "the form still has the place");
  assert.deepEqual(page.takeErrors(), []);
});

test("tapping the tab I am already on scrolls the screen back to the top", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places", files: bigRepo() });
  await page.eval("scrollTo(0, 900)");
  assert.ok(await page.eval("scrollY") > 500);
  await page.tap({ sel: ".bottomnav a", text: "Места" });
  assert.equal(await page.eval("scrollY"), 0);
  assert.equal(await page.eval("location.hash"), "#/places");
  assert.equal(await page.eval(`document.querySelectorAll(".prow").length`), 30);
});

test("tapping «Оценить» again keeps a half-filled rating", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.tap({ sel: ".bottomnav a", text: "Оценить" });
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi");
  assert.equal(await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').getAttribute("aria-pressed")`), "true");
  assert.match(await page.text("#fCounts"), /★ 1 из 10/);
});

test("coming back from a place to a long list returns me to where I was in it", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places", files: bigRepo() });
  await page.eval(`[...document.querySelectorAll(".prow")].find(r => r.innerText.includes("Тестоград 20")).scrollIntoView({ block: "center" })`);
  const y = await page.eval("scrollY");
  assert.ok(y > 300, "the list is scrolled");
  await page.tap({ sel: ".prow", text: "Тестоград 20" });
  await hashIs("#/place/test-20");
  await page.eval("history.back()");
  await hashIs("#/places");
  await sleep(300);
  const back = await page.eval("scrollY");
  assert.ok(Math.abs(back - y) < 150, `list scroll position restored (was ${y}, now ${back})`);
});

test("the browser tab title names the current screen or place", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  assert.match(await page.eval("document.title"), /Порту/, "dossier title names the place");
  assert.match(await page.eval("document.title"), /Где жить/);
  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  assert.match(await page.eval("document.title"), /Рейтинг/);
  await page.tap({ sel: ".appbar a", text: "Настройки" });
  assert.match(await page.eval("document.title"), /Настройки/);
});

/* ---------- header buttons ---------- */

test("the theme button cycles light, dark and system, recolours the page and remembers the choice", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  const bg = () => page.eval(`getComputedStyle(document.body).backgroundColor`);
  const system = await bg();
  for (const [attr, name, color] of [["light", "светлая", "rgb(241, 243, 244)"], ["dark", "тёмная", "rgb(15, 17, 19)"], [null, "как в системе", system]]) {
    await page.tap({ sel: "#themeBtn" });
    assert.equal(await page.eval(`document.documentElement.getAttribute("data-theme")`), attr);
    assert.equal(await page.eval(`document.getElementById("themeBtn").getAttribute("aria-label")`), "Тема: " + name);
    assert.equal(await bg(), color);
    assert.match(await toastText(new RegExp(name)), new RegExp("Тема: " + name));
  }
  await page.tap({ sel: "#themeBtn" });
  await page.tap({ sel: "#themeBtn" });
  await reload();
  await booted();
  assert.equal(await page.eval(`document.documentElement.getAttribute("data-theme")`), "dark", "dark theme survives a reload");
  assert.equal(await bg(), "rgb(15, 17, 19)");
});

test("the theme switch in settings and the header button stay in sync", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  const pressed = () => page.eval(`[...document.querySelectorAll("#themeSeg button")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.innerText)`);
  assert.deepEqual(await pressed(), ["Как в системе"]);
  await page.tap({ sel: "#themeBtn" });
  assert.deepEqual(await pressed(), ["Светлая"], "header button updates the settings switch");
  await page.tap({ sel: "#themeSeg button", text: "Тёмная" });
  assert.equal(await page.eval(`document.getElementById("themeBtn").getAttribute("aria-label")`), "Тема: тёмная", "settings switch updates the header button");
  assert.equal(await page.eval(`document.documentElement.getAttribute("data-theme")`), "dark");
});

test("the sync button refreshes data with a key and leads to settings without one", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  assert.equal(await page.text("#syncText"), "Подключено");
  await page.eval(`localStorage.setItem("mock:delay", "600")`);
  await page.tap({ sel: "#syncBtn" }, 50);
  assert.equal(await page.text("#syncText"), "Обновляю…", "shows that it is refreshing");
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "refreshed");
  assert.equal(await page.eval("location.hash"), "#/rank", "stays on the screen");
  await openApp(page, srv.url, { hash: "#/rank", token: false });
  assert.equal(await page.text("#syncText"), "Не подключено");
  await page.tap({ sel: "#syncBtn" });
  assert.equal(await shownView(), "v-settings", "without a key the button opens settings");
});

test("the sync button's accessible name says what it does, not only the status", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  const [sync] = await axNodes("#syncBtn");
  assert.equal(sync.role, "button");
  assert.match(sync.name, /обнов/i, `screen readers hear «${sync.name}»`);
});

test("choosing the dark theme in the app also darkens the browser bar colour", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await page.tap({ sel: "#themeBtn" });
  await page.tap({ sel: "#themeBtn" });
  assert.equal(await page.eval(`document.documentElement.getAttribute("data-theme")`), "dark");
  const bar = await page.eval(`[...document.querySelectorAll('meta[name="theme-color"]')].find(m => !m.media || matchMedia(m.media).matches)?.content`);
  assert.equal(bar, await page.eval(`(() => { const c = getComputedStyle(document.querySelector(".appbar")).backgroundColor.match(/\\d+/g).slice(0, 3); return "#" + c.map(x => (+x).toString(16).padStart(2, "0")).join(""); })()`), "theme-color follows the app theme, not only the system one");
  assert.equal(bar, "#181b1e");
});

/* ---------- layout ---------- */

for (const [w, h] of [[320, 568], [390, 844], [768, 1024], [1280, 800]]) {
  test(`at ${w}×${h} every screen fits in light and dark: no sideways scroll, nothing sticks out or overlaps`, { skip }, async () => {
    const problems = await layoutSweep(w, h);
    assert.deepEqual(problems, []);
  });
}

test("score numbers on map pins are readable in light and dark themes", { skip }, async () => {
  const files = strongRepo();
  const bad = [];
  for (const dark of [false, true]) {
    await page.viewport(1280, 800, { dark });
    await openApp(page, srv.url, { hash: "#/map", files });
    await page.waitFor(`document.querySelectorAll(".pin:not(.thin):not(.base):not(.cluster)").length >= 2`, 4000, "filled pins");
    const pins = await page.eval(CONTRAST(".pin:not(.cluster)"));
    assert.ok(pins.length >= 3);
    pins.filter(p => p.ratio < 4.5).forEach(p => bad.push(`${dark ? "dark" : "light"} pin ${p.text}: ${p.ratio}:1`));
  }
  assert.deepEqual(bad, [], "pin text needs at least 4.5:1 contrast");
});

test("numbers in the places × groups table are readable in light and dark themes", { skip }, async () => {
  const files = strongRepo();
  const bad = [];
  for (const dark of [false, true]) {
    await page.viewport(1280, 800, { dark });
    await openApp(page, srv.url, { hash: "#/rank", files });
    const cells = await page.eval(CONTRAST(".heat td.cell:not(.none)"));
    assert.ok(cells.length > 20);
    cells.filter(c => c.ratio < 4.5).forEach(c => bad.push(`${dark ? "dark" : "light"} ${c.text}: ${c.ratio}:1`));
  }
  assert.deepEqual([...new Set(bad)], [], "heat-table numbers need at least 4.5:1 contrast");
});

test("world-data score chips in a dossier are readable in light and dark themes", { skip }, async () => {
  const bad = [];
  for (const dark of [false, true]) {
    await page.viewport(1280, 800, { dark });
    await openApp(page, srv.url, { hash: "#/place/porto" });
    const chips = await page.eval(CONTRAST(".world-row .s"));
    assert.ok(chips.length > 5);
    chips.filter(c => c.ratio < 4.5).forEach(c => bad.push(`${dark ? "dark" : "light"} ${c.text}: ${c.ratio}:1`));
  }
  assert.deepEqual([...new Set(bad)], [], "score chips need at least 4.5:1 contrast");
});

/* ---------- keyboard ---------- */

test("Tab walks the header first and then the page, with a visible focus ring on every stop", { skip }, async () => {
  await page.viewport(1280, 800);
  for (const route of ["#/rank", "#/settings", "#/place/porto"]) {
    await openApp(page, srv.url, { hash: route });
    await page.eval("document.activeElement.blur()");
    const stops = [];
    for (let i = 0; i < 24; i++) {
      await pressTab();
      stops.push(await page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body) return { label: "BODY" }; const cs = getComputedStyle(e); return { label: (e.getAttribute("aria-label") || e.innerText || e.value || "").replace(/\\s+/g, " ").trim().slice(0, 30), date: e.type === "date", ring: e.matches(":focus-visible") && ((cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1) || cs.boxShadow !== "none") }; })()`));
    }
    assert.deepEqual(stops.slice(0, 9).map(s => s.label), ["Перейти к содержимому", "Где жить", "Карта", "Рейтинг", "Места", "Оценить", "Подключено", "Тема: как в системе", "Настройки"], route + " header order");
    assert.ok(stops.slice(8).every(s => s.label !== "BODY"), route + ": focus never falls back to the page body");
    assert.deepEqual(stops.filter(s => !s.ring && !s.date).map(s => s.label), [], route + ": every focused control shows a focus ring");
  }
});

test("on a phone, Tab reaches the page content and then every bottom tab", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  await page.eval("document.activeElement.blur()");
  const seen = [];
  for (let i = 0; i < 30; i++) {
    await pressTab();
    const f = await page.eval(`(() => { const e = document.activeElement; return e.closest(".bottomnav") ? "nav:" + e.innerText.trim() : e.closest(".view") ? "view" : "other"; })()`);
    seen.push(f);
    if (f === "nav:Оценить") break;
  }
  assert.ok(seen.includes("view"), "content is reachable");
  assert.deepEqual(seen.filter(s => s.startsWith("nav:")), ["nav:Карта", "nav:Рейтинг", "nav:Места", "nav:Оценить"]);
});

test("tabbing down a long list never leaves the focused row hidden behind the bottom bar", { skip }, async () => {
  await page.viewport(768, 1024);
  await openApp(page, srv.url, { hash: "#/places", files: bigRepo() });
  await page.eval("document.activeElement.blur()");
  const hidden = [];
  for (let i = 0; i < 40; i++) {
    await pressTab();
    const r = await page.eval(`(() => { const e = document.activeElement; if (!e || e === document.body || e.closest(".appbar, .bottomnav")) return ""; const b = e.getBoundingClientRect(); const x = Math.min(Math.max(b.left + 8, 1), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1); const hit = document.elementFromPoint(x, y); const bar = hit && hit.closest(".appbar, .bottomnav"); return bar ? (e.innerText || e.tagName).split("\\n")[0] + " under " + bar.className : ""; })()`);
    if (r) hidden.push(r);
  }
  assert.deepEqual(hidden, [], "focused rows must scroll clear of the fixed bars");
});

test("Enter on a focused ranking row opens that place", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  const name = await page.eval(`(() => { const r = [...document.querySelectorAll("#v-rank a.row")].find(a => a.innerText.includes("Порту")); r.focus(); return r.getAttribute("href"); })()`);
  await pressEnter();
  await hashIs(name);
  assert.equal(await h1(), "Порту");
});

test("Enter on a focused place pin opens its card on the map", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/map" });
  assert.ok(await page.eval(`(() => { const m = document.querySelector('.leaflet-marker-icon[title="Порту"]'); if (!m) return false; m.focus(); return document.activeElement === m && m.tabIndex === 0; })()`), "the pin is keyboard-focusable");
  await pressEnter();
  await page.waitFor(`!document.getElementById("sheet").hidden`, 1500, "card opened").catch(() => {});
  assert.equal(await page.visible("#sheet"), true, "Enter opens the place card");
  assert.equal(await page.text("#sheetBody h3"), "Порту");
});

test("Escape closes the layers panel and puts focus back on «Слои»", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/map" });
  await page.eval(`document.getElementById("layersBtn").focus()`);
  await pressEnter();
  assert.equal(await page.visible("#layersPanel"), true);
  assert.equal(await page.eval(`document.getElementById("layersBtn").getAttribute("aria-expanded")`), "true");
  await pressTab();
  assert.equal((await focused()).id, "lyCountry", "Tab moves into the panel");
  await pressEscape();
  assert.equal(await page.visible("#layersPanel"), false, "Escape closes it");
  assert.equal(await page.eval(`document.getElementById("layersBtn").getAttribute("aria-expanded")`), "false");
  assert.equal((await focused()).id, "layersBtn", "focus returns to the button that opened the panel");
});

test("Escape closes search suggestions even after Tab moved into them", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/map" });
  await page.eval(`document.getElementById("searchInput").focus()`);
  await page.type("Пор");
  assert.equal(await page.visible("#searchResults"), true);
  await pressTab();
  assert.match((await focused()).label, /Порту/, "Tab moves to the first suggestion");
  await pressEscape();
  assert.equal(await page.visible("#searchResults"), false, "Escape hides the suggestions");
  assert.equal((await focused()).id, "searchInput", "focus goes back to the search box");
});

test("pressing a segmented button with the keyboard keeps focus on that button", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.eval(`document.querySelector('#meSeg [data-me="Вика"]').focus()`);
  await pressSpace();
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:me"))`), "Вика", "Space picks the option");
  assert.deepEqual(await focused().then(f => [f.label, f.pressed]), ["Вика", "true"], "«Кто я» keeps focus");
  await page.eval(`document.querySelector('#themeSeg [data-theme="dark"]').focus()`);
  await pressEnter();
  assert.equal(await page.eval(`document.documentElement.getAttribute("data-theme")`), "dark", "Enter picks the option");
  assert.deepEqual(await focused().then(f => [f.label, f.pressed]), ["Тёмная", "true"], "«Вид» keeps focus");
  await page.eval(`location.hash = "#/rank"`);
  await page.waitFor(`document.querySelector("#presets")`, 3000);
  await page.eval(`document.querySelector('#presets [data-p="Своё"]').focus()`);
  await pressSpace();
  assert.deepEqual(await focused().then(f => [f.label, f.pressed]), ["Своё", "true"], "ranking presets keep focus");
});

/* ---------- accessibility ---------- */

test("map pins are announced by the place name, not only by the score", { skip }, async () => {
  await page.viewport(1280, 800);
  await openApp(page, srv.url, { hash: "#/map", files: strongRepo() });
  const pins = (await axNodes(".leaflet-marker-icon")).filter(p => p.attrs.title && !p.attrs.title.includes(","));
  assert.ok(pins.length >= 4);
  assert.deepEqual(pins.filter(p => !p.name.includes(p.attrs.title)).map(p => `«${p.name}» for ${p.attrs.title}`), []);
});

test("every segmented control is a named group with exactly the chosen option pressed", { skip }, async () => {
  const problems = [];
  const check = async where => {
    for (const g of await axNodes(".view:not([hidden]) .seg[role=group], #layersPanel:not([hidden]) .seg[role=group]")) if (!g.name) problems.push(`${where}: group #${g.attrs.id || "?"} has no name`);
    const groups = await page.eval(`[...document.querySelectorAll(".view:not([hidden]) .seg, #layersPanel:not([hidden]) .seg")].filter(s => !s.closest("#rateForm")).map(s => ({ id: s.id, pressed: [...s.querySelectorAll("button")].filter(b => b.getAttribute("aria-pressed") === "true").length, missing: [...s.querySelectorAll("button")].filter(b => !b.hasAttribute("aria-pressed")).length }))`);
    groups.forEach(g => { if (g.pressed !== 1 || g.missing) problems.push(`${where}: #${g.id} has ${g.pressed} pressed, ${g.missing} without aria-pressed`); });
  };
  await openApp(page, srv.url, { hash: "#/settings" });
  await check("settings");
  await openApp(page, srv.url, { hash: "#/rank" });
  await check("ranking");
  await openApp(page, srv.url, { hash: "#/map" });
  await page.tap({ sel: "#layersBtn" });
  await check("layers");
  await openApp(page, srv.url, { hash: "#/rate" });
  await check("rating form");
  assert.deepEqual(problems, []);
});

test("the rating screen has a page heading like the other screens", { skip }, async () => {
  for (const route of ["#/rank", "#/places", "#/place/porto", "#/settings", "#/rate"]) {
    await openApp(page, srv.url, { hash: route });
    assert.equal(await page.eval(`document.querySelectorAll(".view:not([hidden]) h1").length`), 1, route + " has one h1");
  }
});

test("toasts are announced politely and never block taps on what is under them", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  assert.equal(await page.eval(`document.getElementById("toast").getAttribute("role")`), "status");
  await page.tap({ sel: "#themeBtn" });
  await toastText(/Тема/);
  const at = await page.locate({ sel: "#searchInput" });
  await page.click(at.x, at.y);
  await sleep(150);
  assert.equal((await focused()).id, "searchInput", "tapping the search box while a toast is shown still focuses it");
});

test("save messages on a place page are announced to screen readers", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  const live = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && (["status", "alert"].includes(e.getAttribute("role")) || !!e.closest("[aria-live]")); })()`);
  assert.equal(await live("#factsMsg"), true, "numbers form message is a live region");
  assert.equal(await live("#placeMsg"), true, "place card message is a live region");
  await page.tap({ text: "Сохранить цифры" });
  assert.match(await page.text("#factsMsg"), /Ничего не изменилось/);
});

/* ---------- robustness ---------- */

test("no errors or unhandled rejections on any screen without a key, offline, with an empty or a wrong-key repo", { skip }, async () => {
  const states = [
    ["no key", { token: false }],
    ["offline, nothing cached", { offline: true }],
    ["empty repo", { files: {} }],
    ["no repo", { files: null }],
    ["device owner not chosen", { me: "" }],
    ["wrong key", { local: { "wtl:token": "github_pat_BAD" } }],
  ];
  const routes = ["#/map", "#/rank", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/place/nope", "#/rate", "#/rate/new/porto", "#/rate/r1", "#/rate/nope", "#/settings", "#/zzz"];
  const errors = [];
  for (const [name, opts] of states) {
    await openApp(page, srv.url, Object.assign({ hash: "#/map" }, opts));
    for (const r of routes) {
      await page.eval(`location.hash = ${JSON.stringify(r)}`);
      await sleep(120);
    }
    await sleep(300);
    page.takeErrors().forEach(e => errors.push(`${name}: ${e}`));
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.text("#syncText"), "Ключ не подходит", "a wrong key is reported");
});

/* ---------- service worker and manifest ---------- */

test("the manifest is valid, installable and its icons load at the declared sizes", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await swReady();
  const m = await page.send("Page.getAppManifest");
  assert.deepEqual(m.errors, []);
  assert.deepEqual((await page.send("Page.getInstallabilityErrors")).installabilityErrors, []);
  const man = await page.eval(`fetch("manifest.webmanifest").then(r => r.json())`);
  assert.equal(man.display, "standalone");
  assert.equal(man.lang, "ru");
  assert.ok(new URL(man.start_url, srv.url).href.startsWith(new URL(man.scope, srv.url).href), "start_url is inside scope");
  const sizes = await page.eval(`Promise.all(${JSON.stringify(man.icons)}.map(i => new Promise(r => { const img = new Image(); img.onload = () => r([i.sizes, img.naturalWidth + "x" + img.naturalHeight]); img.onerror = () => r([i.sizes, "error"]); img.src = i.src; })))`);
  sizes.forEach(([declared, real]) => { assert.notEqual(real, "error"); if (declared !== "any") assert.equal(real, declared); });
});

test("after two visits the app opens offline from its cache with our data", { skip }, async () => {
  const site = await killableServer();
  try {
    await openApp(page, site.url, { hash: "#/place/porto" });
    await swReady();
    await reload();
    await booted();
    await page.waitFor(`!!localStorage.getItem("wtl:cache") && document.querySelector("#v-place h1")?.innerText === "Порту"`, 6000, "second visit ready");
    await page.idle(300);
    await site.kill();
    await page.eval(`localStorage.setItem("mock:offline", "1")`);
    await reload();
    await booted();
    assert.equal(await h1(), "Порту", "the dossier opens from the cache");
    assert.equal(await page.text("#syncText"), "Нет связи");
    await page.eval(`location.hash = "#/places"`);
    await page.waitFor(`document.querySelectorAll(".prow").length === 6`, 3000, "cached list");
    assert.deepEqual(page.takeErrors(), []);
  } finally { await site.kill(); }
});

test("after a single visit the app opens offline with its fonts and city climate", { skip }, async () => {
  const site = await killableServer();
  try {
    await openApp(page, site.url, { hash: "#/place/porto" });
    await swReady();
    assert.equal(await page.eval(`!!document.querySelector(".clim svg")`), true, "online the dossier has a climate chart");
    await site.kill();
    await page.eval(`localStorage.setItem("mock:offline", "1")`);
    await reload();
    await booted();
    await page.eval(`document.fonts.ready.then(() => 1)`);
    await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Порту" && !!document.querySelector(".clim svg") && !!document.getElementById("simBox") && !/Считаю/.test(document.getElementById("simBox").innerText)`, 6000, "dossier offline").catch(() => {});
    assert.equal(await h1(), "Порту");
    assert.deepEqual(await page.eval(`[...new Set([...document.fonts].filter(f => f.status === "error").map(f => f.family))]`), [], "no font fails to load offline");
    assert.equal(await page.eval(`!!document.querySelector(".clim svg")`), true, "the climate chart is there offline");
    assert.doesNotMatch(await page.text("#simBox"), /мало данных/, "similar places still work offline");
  } finally { await site.kill(); }
});

/* ---------- speed ---------- */

test("with 30 places and 100 ratings the map, the list and a dossier are ready in under 2 s", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map", files: bigRepo() });
  const f = await page.slowdown();
  for (const [hash, ready] of [["#/map", `document.querySelectorAll(".leaflet-marker-icon").length > 5`], ["#/places", `document.querySelectorAll(".prow").length === 30`], ["#/place/test-10", `document.querySelector("#v-place h1")?.innerText === "Тестоград 10"`]]) {
    const ms = await bootTime(hash, ready);
    assert.ok(ms < 2000 * f, `${hash} ready in ${ms} ms (machine ${f.toFixed(1)}× slower than idle)`);
  }
});

test("with 30 places and 100 ratings the ranking opens and answers the first tap within 2 s", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map", files: bigRepo() });
  await page.goto(srv.url + "manifest.webmanifest", 50);
  const f = await page.slowdown();
  const t0 = Date.now();
  await page.send("Page.navigate", { url: srv.url + "#/rank" });
  await page.waitFor(`document.readyState === "complete" && document.getElementById("syncText").innerText === "Подключено" && document.querySelectorAll("#v-rank .row").length > 20`, 15000, "ranking shown");
  await page.eval(`document.querySelector('#presets [data-p="Своё"]').click()`);
  assert.equal(await page.eval(`document.querySelector('#presets [data-p="Своё"]').getAttribute("aria-pressed")`), "true");
  const ms = Date.now() - t0;
  assert.ok(ms < 2000 * f, `ranking usable after ${ms} ms (machine ${f.toFixed(1)}× slower than idle)`);
});

test("with 30 places switching to «Рейтинг» and moving a weight slider each respond in under 300 ms", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places", files: bigRepo() });
  await page.waitFor(`document.querySelectorAll(".prow").length === 30`, 6000, "list");
  await page.idle(300);
  const f = await page.slowdown();
  const open = await page.eval(`(async () => { const a = document.querySelector('.bottomnav a[data-nav="rank"]'); const t = performance.now(); const done = new Promise(r => addEventListener("hashchange", () => r(performance.now() - t), { once: true })); a.click(); return Math.round(await done); })()`);
  assert.equal(await shownView(), "v-rank");
  const slide = await page.eval(`(() => { const i = document.querySelector("#wgrid input[type=range]"); const t = performance.now(); i.value = 40; i.dispatchEvent(new Event("input", { bubbles: true })); return Math.round(performance.now() - t); })()`);
  assert.ok(open < 300 * f, `opening the ranking took ${open} ms (machine ${f.toFixed(1)}× slower than idle)`);
  assert.ok(slide < 300 * f, `one slider step took ${slide} ms (machine ${f.toFixed(1)}× slower than idle)`);
});
