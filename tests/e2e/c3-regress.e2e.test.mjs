// Cycle 3 · review of cycles 1–2 and one language across the app.
// Regression checks for code paths the last two cycles added (update notice, deploy stamp, offline notes,
// banners, new templates) and crawl-based rules for terms, numbers, quotes and capitals on every screen.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, CHROME } from "./cdp.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = "(await import('./js/app.js')).state";
let site, page;

/* ---------- a site server that can serve a "new deploy" of single files ---------- */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const SW_SRC = readFileSync(join(ROOT, "sw.js"), "utf8");
const VERSION = SW_SRC.match(/^const VERSION = "([^"]+)";/m)[1];

function testSite() {
  const over = {}, sockets = new Set();
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const rel = path.slice(1);
    let body;
    if (over[rel] != null) body = Buffer.from(over[rel]);
    else {
      const file = normalize(join(ROOT, path));
      try { if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error("no"); body = await readFile(file); } catch { res.writeHead(404).end("not found"); return; }
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(rel)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${server.address().port}/`, over,
    reset() { for (const k of Object.keys(over)) delete over[k]; },
    close: () => new Promise(done => { server.close(done); sockets.forEach(s => s.destroy()); }),
  })));
}

before(async () => { site = await testSite(); if (!skip) page = await launch(); });
after(async () => { await page?.close(); await site?.close(); });
beforeEach(async () => {
  site?.reset();
  if (!page) return;
  await page.viewport(390, 844, { dark: false });
  page.takeErrors();
});

/* ---------- data ---------- */

const T = "2026-10-01T00:00:00.000Z";
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район", retro: true, year: 6, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const full = v => Object.fromEntries(STAR.map((k, i) => [k, v[i % v.length]]));
const RICH_PLACES = PLACES.map(p => (p.id === "sankt-peterburg" ? Object.assign({}, p, { facts: { rent: { v: 700, src: "Циан", at: "2026-09-01" }, basket: { v: 40, src: "Перекрёсток", at: "2026-09-01" } } }) : p)).concat([
  place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { status: "финалист", archetype: "курорт", facts: { rent: { v: 900, src: "Avito", at: "2026-09-10" }, dinner: { v: 45, src: "", at: "2026-09-10" }, tds: { v: 320, src: "TDS", at: "2026-09-10" } }, questions: "Где зимовать?" }),
  place("antaliya", "Анталья", "Турция", "TUR", 36.8969, 30.7133, { status: "отсев", reason: "Жарко летом" }),
  place("limassol", "Лимасол", "Кипр", "CYP", 34.6786, 33.0413),
  place("kotor-x", "Котор", "Черногория", "MNE", null, null),
  place("bar", "Бар", "Черногория", "MNE", 42.0931, 19.1003, { ext: { "улица": { res: 2 }, "шум": { res: 4.5 } } }),
]);
const RICH_RATINGS = RATINGS.concat([
  rating("r5", "budva", "Михаил", full([4, 4.5, 3.5, 5]), { review: "Море рядом.", notes: { city: "Тесно летом" }, surprises: "Дорого", conf: { "интернет": "A" } }),
  rating("r6", "budva", "Вика", full([4, 3, 1, 5]), { review: "Шумно.", season: "худший", mode: "смешанно", start: "2026-01-10", end: "2026-01-25" }),
  rating("r7", "limassol", "Вика", full([3, 3.5]), { veto: "Слишком жарко" }),
  rating("r8", "bar", "Михаил", full([3.5, 4])),
  rating("r9", "bar", "Вика", full([2, 4.5])),
  rating("r10", "porto", "Михаил", full([4, 4]), { start: "2026-09-01", end: "2026-09-05", retro: false, year: 8 }),
]);
const WEIGHTS = [
  { id: "mikhail", who: "Михаил", w: { legal: 20, money: 15, work: 5, health: 10, safety: 10, climate: 10, housing: 5, city: 10, nature: 5, people: 5, links: 5 }, updatedAt: T },
  { id: "vika", who: "Вика", w: { legal: 5, money: 5, work: 5, health: 15, safety: 15, climate: 15, housing: 10, city: 10, nature: 10, people: 5, links: 5 }, updatedAt: T },
];
const RICH = { places: RICH_PLACES, ratings: RICH_RATINGS, weights: WEIGHTS };
const richFiles = (extra = {}) => Object.assign(repo(RICH), extra);

/* ---------- helpers ---------- */

const booted = (timeout = 10000) => page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, timeout, "app booted");
const VIEWS = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };
const frames = () => page.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
// Opens a screen by its address and waits until it is shown, its data requests are done and it is drawn.
const hash = async h => {
  await page.eval(`location.hash = ${JSON.stringify(h)}`);
  await page.waitFor(`(() => { const v = document.getElementById(${JSON.stringify(VIEWS[h.split("/")[1]])}); return !!v && !v.hidden && v.innerText.trim() !== ""; })()`, 4000, "screen " + h);
  await page.idle(150);
  await frames();
};
const viewText = () => page.eval(`document.querySelector(".view:not([hidden])").innerText`);
const visibleText = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && !e.closest("[hidden]") ? e.innerText : ""; })()`);
const status = () => page.eval(`document.getElementById("syncText").innerText`);

async function reload() {
  await page.eval("window.__beforeReload = 1");
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 15000, "reloaded");
  await booted();
}

// A launch that is already controlled by the offline copy, like every launch after the first one.
async function controlledLaunch(opts = {}) {
  await openApp(page, site.url, Object.assign({ files: richFiles() }, opts));
  await page.waitFor(`!!navigator.serviceWorker.controller && caches.keys().then(k => k.includes(${JSON.stringify(VERSION)}))`, 15000, "offline copy installed");
  await reload();
  await page.waitFor(`!!navigator.serviceWorker.controller`, 5000, "controlled after reload");
}

// Publish a new sw.js and let the browser pick it up, as after a deploy.
async function deployUpdate(version) {
  site.over["sw.js"] = SW_SRC.replace(/^const VERSION = "[^"]+";/m, `const VERSION = "${version}";`);
  await page.eval(`navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {})`);
  await page.waitFor(`caches.keys().then(k => k.length === 1 && k[0] === ${JSON.stringify(version)})`, 20000, "new version active");
  await sleep(300);
}

const covering = async target => { const r = await page.locate(target); assert.ok(!r.error, `${JSON.stringify(target)}: ${r.error}`); return r.covered; };

// The Pages workflow steps, run as GitHub runs them, in a scratch copy of the site.
const PAGES = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
const STAMP_STEP = "Stamp the offline copy with the site's content";
function stepRun(name) {
  const lines = PAGES.split("\n"), i = lines.findIndex(l => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `pages.yml has no step «${name}»`);
  const j = lines.findIndex((l, k) => k > i && /^\s+run: \|\s*$/.test(l));
  const ind = lines[j + 1].match(/^\s*/)[0].length, out = [];
  for (let k = j + 1; k < lines.length && (!lines[k].trim() || lines[k].match(/^\s*/)[0].length >= ind); k++) out.push(lines[k].slice(ind));
  return out.join("\n");
}
function runPages(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wtl-c3-pages-"));
  try {
    const collect = stepRun("Collect site");
    for (const f of collect.match(/cp -R (.+) _site\//)[1].trim().split(/\s+/)) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
    for (const [k, v] of Object.entries(over)) writeFileSync(join(dir, k), v);
    let ok = true;
    try { execFileSync("bash", ["-e", "-c", collect + "\n" + stepRun(STAMP_STEP)], { cwd: dir, stdio: "pipe", env: Object.assign({}, process.env, { LC_ALL: "C" }) }); } catch { ok = false; }
    return { ok, sw: readFileSync(join(dir, "_site/sw.js"), "utf8") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ---------- crawl: every screen, dossier and map card, with their texts ---------- */

const COLLECT = `(() => {
  document.querySelectorAll("details").forEach(d => { if (!d.open && d.id !== "wdetails") d.open = true; });
  const out = [], seen = new Set();
  const vis = e => { if (e.closest("[hidden]") || e.closest(".sr-only")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const zone = e => { const d = e.closest("details"); const s = d && d.querySelector(":scope > summary"); return s ? s.innerText.trim() : ""; };
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const e = n.parentElement;
    if (!e || !n.textContent.trim() || !vis(e) || e.closest("script, style, .leaflet-tile-pane, textarea, input")) continue;
    const blk = e.closest("p, li, button, a, label, summary, h1, h2, h3, h4, td, th, small, option, .banner, .msg, .chip, .q-hint, .desc, .lbl, span, div");
    if (!blk || seen.has(blk)) continue;
    seen.add(blk);
    out.push({ k: "text", t: blk.innerText.replace(/\\s+/g, " ").trim(), z: zone(blk) });
  }
  document.querySelectorAll("[title], [aria-label], [placeholder], [data-tip]").forEach(e => { if (e.closest("[hidden]")) return; ["title", "aria-label", "placeholder", "data-tip"].forEach(a => { const v = e.getAttribute(a); if (v) out.push({ k: a, t: v, z: zone(e) }); }); });
  const t = document.getElementById("toast"); if (t && t.textContent) out.push({ k: "toast", t: t.textContent, z: "" });
  return out.filter(x => x.t);
})()`;

async function grab(bag, where) { for (const it of await page.eval(COLLECT)) bag.push(Object.assign({ where }, it)); }

async function crawlOne(bag, tag, opts, { sheets = true } = {}) {
  await openApp(page, site.url, Object.assign({ hash: "#/map", intro: true }, opts));
  await page.waitFor(`!!document.querySelector('[data-act="introok"]')`, 4000, "help card");
  await page.idle(200);
  await frames();
  await grab(bag, tag + " map + help");
  await page.eval(`document.querySelector('[data-act="introok"]')?.click()`);
  for (const h of ["#/rank", "#/places", "#/rate", "#/settings"]) { await hash(h); if (h === "#/rank") await page.eval(`document.getElementById("wdetails") && (document.getElementById("wdetails").open = true)`); await grab(bag, tag + " " + h); }
  const ids = await page.eval(`(async () => ${S}.M.places.map(p => p.id))()`);
  for (const id of ids) { await hash("#/place/" + id); await sleep(250); await grab(bag, tag + " dossier " + id); }
  if (!sheets) return;
  await hash("#/map");
  for (const id of ids) {
    await page.eval(`(async () => ${S}.mapView.hooks.onPlace(${JSON.stringify(id)}))()`); await sleep(150);
    await page.eval(`document.querySelector('[data-act="simplace"]')?.click()`); await page.waitFor(`!/Считаю/.test(document.getElementById("sheetBody").innerText)`, 4000, "similar places").catch(() => {}); await page.idle(150);
    await grab(bag, tag + " map card " + id);
  }
  for (const iso of ["PRT", "RUS"]) {
    await page.eval(`(async () => ${S}.mapView.hooks.onCountry(${JSON.stringify(iso)}, { lat: 41, lng: -8 }))()`); await sleep(150);
    await page.eval(`document.querySelector('[data-act="simcountry"]')?.click()`); await sleep(300);
    await grab(bag, tag + " country " + iso);
  }
  await page.eval(`document.getElementById("sheetClose").click()`);
  await page.eval(`(() => { const i = document.getElementById("searchInput"); i.focus(); i.value = "Ереван"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(300);
  await grab(bag, tag + " search");
  await page.eval(`document.querySelector('#searchResults button[data-i]')?.click()`); await sleep(400);
  await grab(bag, tag + " city card");
  await page.eval(`document.getElementById("sheetClose").click()`);
  await page.eval(`document.getElementById("layersBtn").click()`); await sleep(150);
  for (const [sel, v] of [["#lyCountry", "wgi_pv"], ["#lyCity", "tx_jul"], ["#lyCity", "predict"]]) {
    await page.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s || ![...s.options].some(o => o.value === ${JSON.stringify(v)} && !o.disabled)) return; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`); await page.idle(200); await frames();
    await grab(bag, tag + " layers " + v);
  }
}

let crawlP = null;
const crawled = () => (crawlP ||= (async () => {
  const bag = [];
  await crawlOne(bag, "Михаил", { files: richFiles({ "ratings/zz-broken.json": "{ oops" }), me: "Михаил" });
  await crawlOne(bag, "Вика", { files: richFiles(), me: "Вика" }, { sheets: false });
  await crawlOne(bag, "без ключа", { files: null, token: false, me: "" }, { sheets: false });
  await crawlOne(bag, "без связи", { files: richFiles(), offline: true }, { sheets: false });
  return bag;
})());
const where = (bag, pred) => [...new Map(bag.filter(pred).map(x => [x.t, x])).values()].map(x => `${x.where}: «${x.t.slice(0, 160)}»`);

/* ======================================================================== */
/* 1. Deploy stamp (pages.yml) and the update notice                        */
/* ======================================================================== */

test("the Pages stamp step turns the offline copy's version into «<version>-<12 hex>» and its own check passes", () => {
  const { ok, sw } = runPages();
  assert.ok(ok, "the stamp step failed on the current sw.js: the deploy would stop");
  const v = (sw.match(/^const VERSION = "([^"]+)";/m) || [])[1];
  assert.match(v || "", new RegExp(`^${VERSION}-[0-9a-f]{12}$`), `stamped version is «${v}»`);
  assert.equal(sw.replace(/^const VERSION = "[^"]+";/m, ""), SW_SRC.replace(/^const VERSION = "[^"]+";/m, ""), "the stamp must change nothing but the VERSION line");
});

test("the stamp step stops the deploy instead of shipping an unstamped offline copy when sw.js writes VERSION differently", () => {
  for (const line of [`const VERSION = '${VERSION}';`, `const VERSION = "${VERSION}"`, `const VERSION="${VERSION}";`]) {
    const { ok } = runPages({ "sw.js": SW_SRC.replace(/^const VERSION = "[^"]+";/m, line) });
    assert.equal(ok, false, `with «${line}» the stamp silently did nothing and installed phones would never see the deploy`);
  }
});

test("settings show the stamped version of a deployed site", { skip }, async () => {
  const { sw } = runPages();
  const v = sw.match(/^const VERSION = "([^"]+)";/m)[1];
  site.over["sw.js"] = sw;
  await openApp(page, site.url, { hash: "#/settings", files: richFiles() });
  await page.waitFor(`caches.keys().then(k => k.includes(${JSON.stringify(v)}))`, 15000, "stamped copy installed");
  await hash("#/rank"); await hash("#/settings");
  await page.waitFor(`document.getElementById("appVersion")?.innerText !== "—"`, 5000).catch(() => {});
  assert.equal(await visibleText("#appVersion"), v.replace(/^wtl-/, ""));
});

test("on a phone the update notice does not cover «Сохранить» of a half-filled rating", { skip }, async () => {
  await controlledLaunch({ hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await deployUpdate("wtl-c3-upd1");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  await page.shot("c3-regress-update-rate");
  const hit = await covering({ sel: "#fSave" });
  assert.equal(hit, "", `«Сохранить» is under the update notice (${hit}): the only way to save the rating is to reload first`);
});

test("at the bottom of a dossier the update notice does not cover «Сохранить карточку»", { skip }, async () => {
  await controlledLaunch({ hash: "#/place/budva" });
  await deployUpdate("wtl-c3-upd2");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`); await sleep(200);
  const hit = await covering({ text: "Сохранить карточку" });
  await page.shot("c3-regress-update-dossier");
  assert.equal(hit, "", `«Сохранить карточку» stays under the update notice even when scrolled to the very end (${hit})`);
});

test("on a computer the update notice covers neither «Сохранить» of the rating form nor the last button of a dossier", { skip }, async () => {
  await page.viewport(1280, 800, { dark: true });
  await controlledLaunch({ hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await deployUpdate("wtl-c3-upd3");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  const a = await covering({ sel: "#fSave" });
  await hash("#/place/budva");
  await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`); await sleep(200);
  const b = await covering({ text: "Сохранить карточку" });
  await page.shot("c3-regress-update-desktop");
  assert.deepEqual([a, b], ["", ""], "a button is under the update notice on a 1280 px screen");
});

test("on the map the update notice covers neither the search, «?» and «Слои» nor the search results, and «Позже» hides it", { skip }, async () => {
  await controlledLaunch({ hash: "#/map" });
  await deployUpdate("wtl-c3-upd-map");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  await page.shot("c3-regress-update-map");
  const hits = {};
  for (const sel of ["#searchInput", "#mapHelpBtn", "#layersBtn"]) hits[sel] = await covering({ sel });
  assert.deepEqual(hits, { "#searchInput": "", "#mapHelpBtn": "", "#layersBtn": "" }, "the update notice sits on top of the map controls, so the map cannot be searched until a reload");
  await page.tap({ sel: "#searchInput" });
  await page.type("Бат");
  await page.waitFor(`!document.getElementById("searchResults").hidden && document.querySelector("#searchResults button")`, 4000, "search results");
  assert.equal(await covering({ sel: "#searchResults button" }), "", "the first search result is under the update notice");
  await page.fill("#searchInput", "");
  await page.eval(`document.getElementById("searchInput").blur(); document.getElementById("searchResults").hidden = true`);
  await page.tap({ sel: "#updateLater" });
  assert.equal(await page.eval(`document.getElementById("updateBar").hidden`), true, "«Позже» must hide the notice for now");
});

test("an update that arrives during the very first session is announced too", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: richFiles() });
  await page.waitFor(`!!navigator.serviceWorker.controller && caches.keys().then(k => k.includes(${JSON.stringify(VERSION)}))`, 15000, "offline copy installed");
  assert.equal(await page.eval(`document.getElementById("updateBar").hidden`), true, "the first install itself is not an update");
  await deployUpdate("wtl-c3-first");
  const told = await page.waitFor(`!document.getElementById("updateBar").hidden`, 4000).catch(() => false);
  assert.ok(told, "a phone that installed the app and kept it open runs old code on new files after a deploy, and nothing says so until a cold start");
});

test("«Обновить» right after typing keeps the whole review in the rating draft", { skip }, async () => {
  await controlledLaunch({ hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await deployUpdate("wtl-c3-upd4");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  await page.eval(`window.__beforeReload = 1; (() => { const t = document.getElementById("fReview"); t.focus(); t.value = "Тёплое море, но шумно"; t.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("updateBtn").click(); })()`);
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 15000, "reloaded");
  await booted();
  if (!(await page.eval("location.hash")).startsWith("#/rate")) await hash("#/rate");
  await page.waitFor(`document.getElementById("fPlace")?.value === "batumi"`, 5000, "draft back");
  assert.equal(await page.eval(`document.getElementById("fReview").value`), "Тёплое море, но шумно", "the notice promises «черновики сохранятся», but the last words typed before «Обновить» are gone");
});

test("«Обновить» with an unsaved edit in a dossier card does not silently throw the edit away", { skip }, async () => {
  await controlledLaunch({ hash: "#/place/budva" });
  await deployUpdate("wtl-c3-upd5");
  await page.waitFor(`!document.getElementById("updateBar").hidden`, 5000, "update notice");
  await page.fill('#placeForm [name="questions"]', "Где зимовать?\nЕсть ли педиатр рядом?");
  await page.eval("window.__beforeReload = 1");
  await page.eval(`document.getElementById("updateBtn").click()`);
  await page.waitFor(`window.__beforeReload !== 1 || !!document.getElementById("updateBtn")?.dataset.armed`, 6000, "reloaded or warned").catch(() => {});
  const stayed = await page.eval("window.__beforeReload === 1").catch(() => false);
  let kept = false, warned = false;
  if (stayed) warned = /сохран|не сохран|потеря/i.test(await page.eval(`[...document.querySelectorAll("#updateBar, #toast, .msg, .banner")].filter(e => !e.closest("[hidden]")).map(e => e.innerText).join(" ")`));
  else {
    await booted();
    if (!(await page.eval("location.hash")).startsWith("#/place/budva")) await hash("#/place/budva");
    await page.waitFor(`document.querySelector('#placeForm [name="questions"]')`, 5000);
    kept = /педиатр/.test(await page.eval(`document.querySelector('#placeForm [name="questions"]').value`));
  }
  assert.ok(kept || warned, "the notice says «черновики … сохранятся», yet the typed question vanished after the reload without a word");
});

/* ======================================================================== */
/* 2. Edge paths the last cycles added                                      */
/* ======================================================================== */

test("offline on the very first start, the map does not claim to show a saved copy of our data", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map", offline: true, files: richFiles() });
  await sleep(300);
  assert.match(await status(), /данных нет/i);
  const note = await visibleText("#mapNote");
  assert.ok(note, "the map says nothing about the missing connection");
  assert.doesNotMatch(note, /сохранённая копия/i, `«${note}» — there is no saved copy yet: nothing was ever loaded on this device`);
  assert.match(note, /загруз|появятся|ещё не/i, "the note should say our places appear once the data loads");
});

test("without a key the ranking neither counts «Мест: 0 · оценок: 0» nor tells me to add places on the map", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: null, token: false, me: "" });
  await sleep(300);
  const head = await page.eval(`document.querySelector("#v-rank header").innerText`);
  const list = await visibleText("#rank");
  assert.doesNotMatch(head, /Мест: 0/, `header «${head}» reads as if our data had loaded and was empty`);
  assert.doesNotMatch(list, /добавьте первое/i, `«${list.trim()}» — without a key a place cannot be added; the places tab says «Места появятся после подключения данных»`);
  assert.match(list, /ключ|подключ/i, "the ranking list should say the places appear once the data is connected");
});

test("after «Забыть ключ» the ranking does not claim that we have no places and no ratings", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings", files: richFiles() });
  await page.tap({ text: "Забыть ключ на этом устройстве" });
  await page.tap({ text: "Точно забыть? Нажмите ещё раз" });
  await hash("#/rank");
  const head = await page.eval(`document.querySelector("#v-rank header").innerText`);
  assert.doesNotMatch(head, /Мест: 0 · оценок: 0/, `after forgetting the key the ranking says «${head}», as if the data were empty`);
});

test("the status at the top names a lost connection with the same words as the banners", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: richFiles() });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.eval(`(async () => { await ${S}.data.poll(); })()`);
  await page.waitFor(`document.getElementById("syncText").innerText !== "Подключено"`, 5000, "offline noticed");
  await hash("#/places"); await hash("#/rank");
  const st = await status(), banner = await visibleText("#v-rank .banner");
  assert.match(banner, /Нет связи/);
  assert.match(st, /Нет связи/, `the banner says «Нет связи», the status says «${st}»: two words for one state`);
});

test("a clash on the place numbers writes euro amounts the same way as the hints next to the fields", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/place/budva", files: richFiles() });
  const files = await mockFiles(page), doc = JSON.parse(files["places/budva.json"]);
  doc.facts.rent = { v: 1000, src: "Вика", at: "2026-10-30" };
  files["places/budva.json"] = JSON.stringify(doc, null, 1) + "\n";
  await page.eval(`localStorage.setItem("mock:files", ${JSON.stringify(JSON.stringify(files))}); localStorage.setItem("mock:head", "h7")`);
  await page.fill('#factsForm [name="fact_rent"]', "950");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`/другом устройстве/.test(document.getElementById("factsMsg").innerText)`, 8000, "clash message");
  const all = await page.eval(`[document.getElementById("v-place").innerText].concat([...document.querySelectorAll("#v-place [title]")].map(e => e.title)).join("\\n")`);
  const before = all.match(/€\d+/g) || [], afterSign = all.match(/\d+[\s\u00a0]€/g) || [];
  assert.ok(before.length + afterSign.length > 2, "no euro amounts found");
  assert.ok(!(before.length && afterSign.length), `euro amounts are written both ways on one screen: ${before.slice(0, 3).join(", ")} and ${afterSign.slice(0, 3).join(", ")}`);
});

test("every button that adds a found town to our places has one label, and the rating form names that label", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map", files: richFiles() });
  await page.eval(`(async () => { await ${S}.world.loadCities(); })()`);
  const search = q => page.eval(`(() => { const i = document.getElementById("searchInput"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await search("Херцег-Нови");
  await page.waitFor(`(async () => ${S}.searchItems.some(x => x.type === "city"))()`, 5000, "city suggestion");
  const ci = await page.eval(`(async () => ${S}.searchItems.findIndex(x => x.type === "city"))()`);
  await page.tap({ sel: `#searchResults button[data-i="${ci}"]` });
  await page.waitFor(`document.querySelector('#sheet [data-act="addcity"]')`, 5000, "city card");
  const cityBtn = await page.eval(`document.querySelector('#sheet [data-act="addcity"]').innerText.trim()`);
  await search("Херцег");
  await page.key("Enter");
  await page.waitFor(`(async () => ${S}.searchItems.some(x => x.type === "geo"))()`, 6000, "OpenStreetMap result");
  const gi = await page.eval(`(async () => ${S}.searchItems.findIndex(x => x.type === "geo"))()`);
  await page.tap({ sel: `#searchResults button[data-i="${gi}"]` });
  await page.waitFor(`document.querySelector('#sheet [data-act="addgeo"]')`, 5000, "OpenStreetMap card");
  const geoBtn = await page.eval(`document.querySelector('#sheet [data-act="addgeo"]').innerText.trim()`);
  await hash("#/rate");
  const hint = await visibleText("#fPlaceHint");
  assert.equal(geoBtn, cityBtn, `the same action is «${cityBtn}» on a city card and «${geoBtn}» on an OpenStreetMap card`);
  assert.ok(hint.includes(`«${cityBtn}»`), `the rating form tells to press a button that is not named «${cityBtn}»: «${hint}»`);
});

test("the button on a country card that only looks up the town at that point does not say it adds one", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map", files: richFiles() });
  await page.eval(`(async () => ${S}.mapView.hooks.onCountry("MNE", { lat: 42.45, lng: 18.54 }))()`); await sleep(200);
  const label = await page.eval(`document.querySelector('#sheet [data-act="addhere"]').innerText.trim()`);
  const before = Object.keys(await mockFiles(page)).length;
  await page.tap({ text: label, within: "#sheet" });
  await page.waitFor(`document.querySelector('#sheet [data-act="addgeo"]')`, 6000, "town card");
  const added = Object.keys(await mockFiles(page)).length - before;
  assert.equal(added, 0);
  assert.doesNotMatch(label, /^Добавить/, `«${label}» adds nothing: it opens another card with its own «Добавить…» button`);
});

test("the rating form says the review is visible on screens where it really appears", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rate", files: richFiles() });
  const label = await page.eval(`document.querySelector('label[for="fReview"] .lbl').innerText`);
  await hash("#/place/porto");
  const cardSection = await page.eval(`(() => { const h = [...document.querySelectorAll("#v-place h2")].find(h => h.innerText.trim().toLowerCase() === "карточка места"); return h ? h.closest("section").innerText : ""; })()`);
  const reviewShownInCard = /Красиво, но сыро/.test(cardSection);
  assert.ok(reviewShownInCard || !/карточк/i.test(label), `the label says «${label}», but the dossier section «Карточка места» has no reviews: reviews are in the trips list of the dossier and on the map card`);
});

test("place and rating texts with HTML in them stay plain text in every new banner, card and message", { skip, timeout: 120000 }, async () => {
  const X = '<img src=x onerror="window.__xss=1"><b class="xss">x</b>';
  const places = RICH_PLACES.map(p => (p.id === "budva" ? Object.assign({}, p, { name: "Будва" + X, country: "Черногория" + X, archetype: X, questions: "Вопрос" + X, facts: { rent: { v: 900, src: X, at: "2026-09-10" } } }) : p.id === "antaliya" ? Object.assign({}, p, { reason: X }) : p));
  const ratings = RICH_RATINGS.map(r => (r.id === "r5" ? Object.assign({}, r, { review: X, surprises: X, notes: { city: X } }) : r.id === "r7" ? Object.assign({}, r, { veto: X }) : r));
  const files = Object.assign(repo({ places, ratings, weights: WEIGHTS }), { [`ratings/${'"><b class=xss>'}.json`]: "{ broken" });
  const lost = [{ at: T, path: "places/budva.json", content: JSON.stringify(Object.assign({}, places.find(p => p.id === "budva"), { questions: X })), patch: { questions: X, "facts.rent": { v: 5000, src: X } }, base: { questions: "" }, message: "Update place budva" }];
  await openApp(page, site.url, { hash: "#/map", files, local: { "wtl:lost": lost, "wtl:revealed": ["limassol"] } });
  const injected = [], count = () => page.eval(`document.querySelectorAll(".xss, img[src='x']").length`);
  for (const h of ["#/rank", "#/places", "#/place/budva", "#/place/antaliya", "#/place/limassol", "#/rate/r5", "#/settings"]) {
    await hash(h); await sleep(200);
    if (h === "#/rank") { const b = await visibleText("#v-rank"); assert.match(b, /Не отправлено: это же изменили/, "the unsent-change banner was not shown"); assert.match(b, /Не удалось прочитать файл/, "the broken-file banner was not shown"); }
    if (await count()) injected.push(h);
  }
  await hash("#/map");
  for (const id of ["budva", "antaliya", "limassol"]) { await page.eval(`(async () => ${S}.mapView.hooks.onPlace(${JSON.stringify(id)}))()`); await sleep(200); if (await count()) injected.push("map card " + id); }
  await page.eval(`(() => { const i = document.getElementById("searchInput"); i.focus(); i.value = "Будва"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(300);
  if (await count()) injected.push("search");
  await page.eval(`document.getElementById("layersBtn").click()`); await sleep(150);
  if (await count()) injected.push("layers");
  assert.deepEqual(injected, [], "a text from our data was inserted as HTML on these screens");
});

test("in «Цифры места» the 1–5 value made from a number has one name: the intro, the badge, the hints and the table mark agree", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/place/budva", files: richFiles() });
  const t = await page.eval(`[document.getElementById("factsForm").innerText].concat([...document.querySelectorAll("#factsForm [title], #factsForm [aria-label], .subtable .c[title]")].map(e => e.title || e.getAttribute("aria-label")), [...document.querySelectorAll("#v-place p")].filter(p => /«ц»/.test(p.innerText)).map(p => p.innerText)).join("\\n")`);
  const asOcenka = /получившаяся оценка|[Оо]ценка \d/.test(t), asBall = /[Бб]алл/.test(t);
  assert.ok(asOcenka || asBall, "the section does not name the computed value at all");
  assert.ok(!(asOcenka && asBall), `the same coloured badge is «оценка» in the intro and the tooltip but «балл» in the hints and the table: ${(t.match(/[^.\n]*[Бб]алл[^.\n]*/g) || []).slice(0, 3).join(" | ")}`);
});

test("a change waiting in the queue is never called «Не отправлено», the words kept for changes that clashed with another device", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rate", files: richFiles() });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`location.hash.startsWith("#/place/batumi")`, 8000, "dossier after save");
  await sleep(300);
  const texts = [await status(), await page.eval(`document.getElementById("toast").textContent`), await visibleText("#placeBanner"), await page.eval(`[...document.querySelectorAll(".trip .chip")].map(c => c.innerText + " " + c.title).join(" ")`)];
  await hash("#/rank");
  texts.push(await visibleText("#v-rank .banner"));
  const all = texts.join(" | ");
  assert.match(all, /очеред/i, "nothing says the rating waits in the queue");
  assert.match(all, /ждёт отправки/i);
  assert.doesNotMatch(all, /Не отправлено/i, `a queued rating is described with the clash words: ${all}`);
});

test("after a clash found while sending the queue on the map, the toast points to «Не отправлено» at the top and that status opens the red banner", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/place/budva", files: richFiles() });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.fill('#placeForm [name="archetype"]', "город у моря");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`/Нет связи|ждёт|позже/.test(document.getElementById("placeMsg").innerText)`, 8000, "queued");
  const files = await mockFiles(page), doc = JSON.parse(files["places/budva.json"]);
  doc.archetype = "горы";
  files["places/budva.json"] = JSON.stringify(doc, null, 1) + "\n";
  await page.eval(`localStorage.setItem("mock:files", ${JSON.stringify(JSON.stringify(files))}); localStorage.setItem("mock:head", "h9"); localStorage.removeItem("mock:offline")`);
  await hash("#/map");
  await page.eval(`(async () => { await ${S}.data.refresh(); })()`);
  await page.waitFor(`/Не отправлено/.test(document.getElementById("toast").textContent)`, 8000, "clash toast");
  const toast = await page.eval(`document.getElementById("toast").textContent`);
  assert.match(toast, /«Не отправлено» вверху/);
  assert.match(await status(), /^Не отправлено: 1/);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`location.hash === "#/rank"`, 4000, "ranking opened");
  const b = await visibleText("#v-rank .banner.err");
  for (const re of [/Не отправлено/, /на другом устройстве/, /Тип места: «город у моря» \(сейчас «горы»\)/]) assert.match(b, re, `«${b}»`);
});

test("on the map the status button never says it shows unsent changes while a tap on it only refreshes", { skip }, async () => {
  const lost = [{ at: T, path: "places/porto.json", content: null, patch: { archetype: "мегаполис" }, base: { archetype: "город у моря" }, message: "Update place porto" }];
  await openApp(page, site.url, { hash: "#/rank", files: richFiles(), local: { "wtl:lost": lost } });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.eval(`(async () => { await ${S}.data.poll(); })()`);
  await page.waitFor(`document.getElementById("syncText").innerText !== "Подключено" && !/^Не отправлено/.test(document.getElementById("syncText").innerText)`, 5000, "offline noticed");
  await hash("#/map");
  const said = await page.eval(`document.getElementById("syncAction").textContent + " " + document.getElementById("syncText").textContent`);
  await page.tap({ sel: "#syncBtn" });
  await page.idle(200);
  const went = await page.eval("location.hash");
  if (/неотправлен/i.test(said)) assert.equal(went, "#/rank", `the button is announced as «${said}», but tapping it stays on the map and only retries the connection`);
});

/* ======================================================================== */
/* 3. One language: crawl over every screen with three datasets             */
/* ======================================================================== */

test("crawl: no screen, dossier, map card or layer note shows undefined, NaN, null, [object Object], «· ·» or empty brackets", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.ok(bag.length > 2000, "the crawl collected too little");
  const bad = where(bag, x => /\bundefined\b|\bNaN\b|\bnull\b|\[object |·\s*·|\(\s*\)|«\s*»|\s[,.;:](?=\s|$)/.test(x.t));
  assert.deepEqual(bad, []);
  assert.deepEqual(page.takeErrors(), []);
});

test("crawl: the access key is «ключ доступа» everywhere; the word «токен» appears only inside «Технические подробности»", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.ok(bag.some(x => /ключ доступа/i.test(x.t)));
  assert.deepEqual(where(bag, x => /токен/i.test(x.t) && x.z !== "Технические подробности"), []);
});

test("crawl: our data on GitHub is «хранилище» in every message; «репозиторий» appears only inside «Технические подробности»", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.ok(bag.some(x => /zz-broken/.test(x.t)), "the broken-file banner was not shown");
  assert.deepEqual(where(bag, x => /репозитор/i.test(x.t) && x.z !== "Технические подробности"), [], "a message for the user says «репозиторий» while the rest of the app says «хранилище»");
});

test("crawl: «хранилище» always means our data on GitHub, never the phone's or the browser's own memory", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  const bad = where(bag, x => x.k === "text" && x.t.split(/(?<=[.!?])\s+/).some(s => /хранилищ/i.test(s) && /«Домой»|браузер|телефон|приложени[ея] с экрана/i.test(s)));
  assert.deepEqual(bad, [], "the same word names two different storages; elsewhere the phone's storage is «память браузера»");
});

test("crawl: quotes in visible texts are «ёлочки» (with „лапки“ inside), never straight double quotes", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.deepEqual(where(bag, x => x.k === "text" && /"/.test(x.t)), []);
});

test("crawl: decimals use a point everywhere on screen, as in scores like 3.5: population, indicator names and values included", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.ok(bag.some(x => /\d\.\d/.test(x.t)), "no decimal numbers found");
  assert.ok(bag.some(x => /млн жителей/.test(x.t)), "a city of over a million was not shown");
  const bad = where(bag, x => (x.k === "text" || x.k === "title" || x.k === "data-tip") && /\d,\d/.test(x.t.replace(/\d{1,3}(,\d{3})+(?!\d)/g, "")));
  assert.deepEqual(bad, [], "these decimals use a comma while the app writes 3.5, 1.5, 13.4 °C");
});

test("crawl: «мало своих оценок» and «только мировые данные» are the only two reasons a place is pale, worded the same in the ranking, the table, the list and on map cards", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  const reasons = new Set(bag.filter(x => x.k === "text" && /^(только мировые данные|мало своих оценок|своих ответов на ★: \d+ из \d+)$/.test(x.t)).map(x => x.t.replace(/\d+/g, "N")));
  assert.ok(reasons.has("только мировые данные"));
  const odd = where(bag, x => x.k === "text" && /только (по )?мировым? данн|только данные|по одним мировым/i.test(x.t) && !/только мировые данные|только по мировым данным|только по данным страны|только по мировым данным и цифрам места/i.test(x.t));
  assert.deepEqual(odd, []);
});

test("crawl: the computed score of a place is always «итог», never «общая оценка», «итоговый балл» or «рейтинг места»", { skip, timeout: 400000 }, async () => {
  const bag = await crawled();
  assert.ok(bag.some(x => /итог/i.test(x.t)));
  assert.deepEqual(where(bag, x => /общ\w+ (оценк|балл)|итогов\w+ (оценк|балл)|рейтинг места|балл места/i.test(x.t)), []);
});

test("the action that reloads our data from GitHub has one name in the header and in settings", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings", files: richFiles() });
  const header = (await page.eval(`document.getElementById("syncAction").textContent + "|" + document.getElementById("syncBtn").title`)).replace(/:/g, "").split("|");
  const button = await visibleText("#refreshBtn");
  assert.ok(button, "settings have no refresh button");
  assert.ok(header.includes(button.trim()), `the header calls it «${header[1]}», settings call it «${button.trim()}»`);
});

/* ======================================================================== */
/* 4. Capitals, ё, CSS                                                      */
/* ======================================================================== */

test("every segmented choice starts with a capital letter, as «Как в системе» and «Поровну» do", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rate", files: richFiles() });
  const labels = [];
  for (const h of ["#/rate", "#/settings", "#/rank"]) { await hash(h); labels.push(...(await page.eval(`[...document.querySelectorAll(".view:not([hidden]) .seg button")].map(b => b.innerText.trim())`))); }
  await hash("#/map");
  await page.eval(`document.getElementById("layersBtn").click()`); await sleep(100);
  await page.select("#lyCountry", "Уровень цен");
  labels.push(...(await page.eval(`[...document.querySelectorAll("#layersPanel .seg button")].map(b => b.innerText.trim())`)));
  assert.ok(labels.includes("Как в системе") && labels.includes("Поровну"));
  assert.deepEqual(labels.filter(t => /^[a-zа-яё]/.test(t)), [], "these choices start with a small letter while the other choice groups start with a capital");
});

test("no word of the interface is spelled both with ё and with е", () => {
  const files = ["js/app.js", "js/form.js", "js/views.js", "js/map.js", "js/data.js", "js/store.js", "js/calc.js", "js/similar.js", "js/world.js", "js/geo.js", "js/boot.js", "index.html"];
  const words = new Map();
  const strip = s => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  for (const f of files) for (const m of strip(readFileSync(join(ROOT, f), "utf8")).matchAll(/[А-Яа-яЁё]{3,}/g)) { const w = m[0].toLowerCase(); if (!words.has(w)) words.set(w, f); }
  const schema = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf8"));
  for (const c of schema.cats.concat(schema.groups, schema.facts)) for (const t of [c.name, c.hint, c.unit].filter(Boolean)) for (const m of t.matchAll(/[А-Яа-яЁё]{3,}/g)) { const w = m[0].toLowerCase(); if (!words.has(w)) words.set(w, "schema.json"); }
  const both = [...words.keys()].filter(w => w.includes("ё") && words.has(w.replace(/ё/g, "е")) && !["всё", "всё-таки"].includes(w)).map(w => `${w} (${words.get(w)}) / ${w.replace(/ё/g, "е")} (${words.get(w.replace(/ё/g, "е"))})`);
  assert.deepEqual(both, []);
});

test("the stylesheet has no rules for classes or ids the app never renders", () => {
  const css = readFileSync(join(ROOT, "css/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}");
  const src = ["index.html", ...["app", "form", "views", "map", "boot", "util", "calc", "similar", "world"].map(f => `js/${f}.js`)].map(f => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const names = new Set([...css.matchAll(/(?<![\w-])\.([a-zA-Z_][\w-]*)/g)].map(m => m[1]).filter(c => !c.startsWith("leaflet")));
  const ids = new Set([...css.matchAll(/#([a-zA-Z_][\w-]*)/g)].map(m => m[1]));
  const used = n => new RegExp(`(?<![\\w-])${n.replace(/[-]/g, "\\-")}(?![\\w-])`).test(src);
  const dead = [...names].filter(n => !used(n)).map(n => "." + n).concat([...ids].filter(n => !used(n)).map(n => "#" + n));
  assert.deepEqual(dead, [], "dead CSS left over from earlier versions");
});
