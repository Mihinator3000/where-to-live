import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { launch, CHROME } from "./cdp.mjs";
import { openApp, repo, PLACES } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let site, page;

/* ---------- a test site that can go down, fail single files, delay them and serve a "new deploy" ---------- */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const SW_SRC = readFileSync(join(ROOT, "sw.js"), "utf8");
const VERSION = SW_SRC.match(/const VERSION = "([^"]+)"/)[1];
const SHELL = [...SW_SRC.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
const SHELL_FILES = SHELL.map(p => (p === "./" ? "index.html" : p));
const NEW_VERSION = "wtl-v99-test";

function testSite() {
  const log = [], over = {}, fail = new Set(), delay = {}, sockets = new Set();
  const st = { down: false, gzip: false };
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    log.push(path);
    if (st.down) { req.socket.destroy(); return; }
    if (path.endsWith("/")) path += "index.html";
    const rel = path.slice(1);
    if (fail.has(rel)) { req.socket.destroy(); return; }
    if (delay[rel]) await new Promise(r => setTimeout(r, delay[rel]));
    let body;
    if (over[rel] != null) body = Buffer.from(over[rel]);
    else {
      const file = normalize(join(ROOT, path));
      try { if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error("no"); body = await readFile(file); } catch { res.writeHead(404).end("not found"); return; }
    }
    const hd = { "Content-Type": TYPES[extname(rel)] || "application/octet-stream", "Cache-Control": "no-store" };
    if (st.gzip && /text|json|javascript|svg/.test(hd["Content-Type"]) && /gzip/.test(req.headers["accept-encoding"] || "")) { body = gzipSync(body); hd["Content-Encoding"] = "gzip"; }
    res.writeHead(200, hd);
    res.end(body);
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${server.address().port}/`, log, over, fail, delay, st,
    setDown(v) { st.down = v; if (v) sockets.forEach(s => s.destroy()); },
    reset() { st.down = false; st.gzip = false; log.length = 0; fail.clear(); for (const k of Object.keys(over)) delete over[k]; for (const k of Object.keys(delay)) delete delay[k]; },
    close: () => new Promise(r => { server.close(r); sockets.forEach(s => s.destroy()); }),
  })));
}

before(async () => { site = await testSite(); page = await launch(); });
after(async () => { await page?.close(); await site?.close(); });
beforeEach(async () => {
  site?.reset();
  if (!page) return;
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.send("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
  await page.viewport(390, 844, { dark: false });
  page.takeErrors();
});

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const h1 = () => page.eval(`document.querySelector(".view:not([hidden]) h1")?.innerText || ""`);
const shownView = () => page.eval(`document.querySelector(".view:not([hidden])")?.id || ""`);
const booted = (timeout = 10000) => page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, timeout, "app booted");
const swReady = () => page.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!(r && r.active && r.active.state === "activated" && !r.installing))`, 15000, "service worker active");
const cacheKeys = () => page.eval(`caches.keys()`);
const cachedPaths = name => page.eval(`caches.open(${JSON.stringify(name)}).then(c => c.keys()).then(ks => ks.map(k => k.url.split("#")[0]))`).then(urls => urls.map(u => u.replace(site.url, "") || "./"));
const softWait = (js, timeout) => page.waitFor(js, timeout).catch(() => false);

async function reload() {
  await page.eval("window.__beforeReload = 1");
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete"`, 15000, "reloaded");
}

async function relaunch(hash = "#/map") {
  await page.goto("about:blank", 300);
  await page.send("Page.navigate", { url: site.url + hash });
  await page.waitFor(`location.href.startsWith(${JSON.stringify(site.url)}) && document.readyState === "complete"`, 15000, "relaunched");
}

async function goOffline() {
  site.setDown(true);
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
}

async function goOnline() {
  site.setDown(false);
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.eval(`localStorage.removeItem("mock:offline")`);
}

function deploy({ sw = true } = {}) {
  if (sw) site.over["sw.js"] = SW_SRC.replace(/const VERSION = "[^"]+"/, `const VERSION = "${NEW_VERSION}"`);
  site.over["js/views.js"] = readFileSync(join(ROOT, "js/views.js"), "utf8") + '\nexport const DEPLOY_MARK = "v99";\n';
  site.over["js/app.js"] = 'import { DEPLOY_MARK } from "./views.js";\nwindow.__deploy = DEPLOY_MARK;\n' + readFileSync(join(ROOT, "js/app.js"), "utf8");
}
const newCodeRunning = () => page.eval(`window.__deploy === "v99"`);

// The Pages workflow, run as GitHub runs it: «Collect site» and the stamp step from pages.yml, in a scratch copy of the repo.
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
function deployedSw(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wtl-pages-"));
  try {
    const collect = stepRun("Collect site");
    for (const f of collect.match(/cp -R (.+) _site\//)[1].trim().split(/\s+/)) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
    for (const [k, v] of Object.entries(over)) writeFileSync(join(dir, k), v);
    execFileSync("bash", ["-e", "-c", collect + "\n" + stepRun(STAMP_STEP)], { cwd: dir, stdio: "pipe", env: Object.assign({}, process.env, { LC_ALL: "C" }) });
    return readFileSync(join(dir, "_site/sw.js"), "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const versionOf = src => (src.match(/^const VERSION = "([^"]+)";/m) || [])[1];
const newWorld = () => { const ind = JSON.parse(readFileSync(join(ROOT, "data/world/indicators.json"), "utf8")); ind.generated = "2099-01-05"; ind.countries.PRT.homicide = [9.9, 2099]; return JSON.stringify(ind); };

const newSwInstalled = () => page.waitFor(`(async () => { const r = await navigator.serviceWorker.getRegistration(); const k = await caches.keys(); return !!r && !r.installing && k.includes(${JSON.stringify(NEW_VERSION)}) && (await (await caches.open(${JSON.stringify(NEW_VERSION)})).keys()).length >= ${SHELL.length}; })()`, 15000, "new version installed");

const appStarted = () => page.waitFor(`(() => { const v = document.querySelector(".view:not([hidden])"); return !!v && v.innerText.trim().length > 20 && !["…", ""].includes(document.getElementById("syncText").innerText); })()`, 10000, "app started").then(() => true, () => false);

const SPOTS = [["PRT", "Португалия", 38.72, -9.14], ["ESP", "Испания", 40.42, -3.7], ["GEO", "Грузия", 41.72, 44.78], ["SRB", "Сербия", 44.79, 20.45], ["MNE", "Черногория", 42.44, 19.26], ["TUR", "Турция", 41.01, 28.98], ["ITA", "Италия", 41.9, 12.5], ["GRC", "Греция", 37.98, 23.73], ["HRV", "Хорватия", 45.81, 15.98], ["ARM", "Армения", 40.18, 44.51], ["CYP", "Кипр", 35.17, 33.36], ["BGR", "Болгария", 42.7, 23.32], ["ALB", "Албания", 41.33, 19.82], ["MKD", "Северная Македония", 41.99, 21.43], ["BIH", "Босния и Герцеговина", 43.86, 18.41], ["SVN", "Словения", 46.06, 14.51], ["HUN", "Венгрия", 47.5, 19.04], ["CZE", "Чехия", 50.08, 14.44], ["POL", "Польша", 52.23, 21.01], ["DEU", "Германия", 52.52, 13.4], ["FRA", "Франция", 48.86, 2.35], ["NLD", "Нидерланды", 52.37, 4.9], ["AUT", "Австрия", 48.21, 16.37], ["ROU", "Румыния", 44.43, 26.1], ["KAZ", "Казахстан", 43.24, 76.89], ["UZB", "Узбекистан", 41.3, 69.24], ["ISR", "Израиль", 32.09, 34.78], ["THA", "Таиланд", 13.75, 100.5], ["VNM", "Вьетнам", 21.03, 105.85]];
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "schema.json"), "utf8"));
const FORM_KEYS = SCHEMA.cats.filter(c => c.form !== false).map(c => c.key);
const STAR_KEYS = SCHEMA.cats.filter(c => c.star).map(c => c.key);

function hugeRepo(nPlaces = 100, nRatings = 300) {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const places = [PLACES[0]];
  for (let i = 1; i < nPlaces; i++) {
    const [cc, country, lat, lon] = SPOTS[i % SPOTS.length];
    const n = String(i).padStart(3, "0");
    places.push({ id: "big-" + n, name: "Городок " + n, country, cc, lat: lat + (rnd() - 0.5) * 3, lon: lon + (rnd() - 0.5) * 3, status: i % 11 === 0 ? "финалист" : i % 13 === 0 ? "отсев" : "кандидат", archetype: i % 2 ? "город у моря" : "мегаполис", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T });
  }
  const ratings = [];
  for (let i = 0; i < nRatings; i++) {
    const idx = 1 + (i % (nPlaces - 1)), bias = 1.4 + 3.2 * rnd(), scores = {};
    STAR_KEYS.forEach(k => { if (rnd() < 0.85) scores[k] = Math.max(1, Math.min(5, Math.round((bias + rnd() - 0.5) * 2) / 2)); });
    FORM_KEYS.forEach(k => { if (!scores[k] && rnd() < 0.5) scores[k] = Math.max(1, Math.min(5, Math.round((bias + rnd() * 2 - 1) * 2) / 2)); });
    const m = String(1 + (i % 12)).padStart(2, "0"), y = 2024 + (i % 3);
    ratings.push({ id: "big-r" + i, place: places[idx].id, who: i % 2 ? "Вика" : "Михаил", start: `${y}-${m}-01`, end: `${y}-${m}-12`, days: 12, season: "пик", mode: "удалёнка", housing: "центр", retro: false, year: Math.floor(rnd() * 11), veto: "", review: "Синтетический отзыв " + i + ": тихо, чисто, но дорого.", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T });
  }
  return repo({ places, ratings });
}
let HUGE = null;
const huge = () => (HUGE ||= hugeRepo());

const READY = {
  "#/rank": `document.querySelectorAll("#rank .row").length > 50`,
  "#/places": `document.querySelectorAll(".prow").length > 50`,
  "#/map": `document.querySelectorAll(".leaflet-marker-icon").length > 3`,
};

async function launchTime(hash) {
  await page.goto(site.url + "manifest.webmanifest", 50);
  const t0 = Date.now();
  await page.send("Page.navigate", { url: site.url + hash });
  await page.waitFor(`document.readyState === "complete" && (${READY[hash]})`, 30000, "content of " + hash);
  return Date.now() - t0;
}

const hexOf = rgb => { const m = String(rgb).match(/\d+/g); return m ? "#" + m.slice(0, 3).map(x => Number(x).toString(16).padStart(2, "0")).join("") : String(rgb).toLowerCase(); };
const activeThemeColor = () => page.eval(`[...document.querySelectorAll('meta[name="theme-color"]')].find(m => !m.media || matchMedia(m.media).matches)?.content.toLowerCase()`);

const SCORE_WATCH = `(() => {
  window.__scoreSnaps = [];
  const grab = () => {
    const rows = [...document.querySelectorAll("#rank .row .score, #plist .prow .score")].map(e => e.innerText.replace(/\\s+/g, " ").trim()).filter(t => !/по определению|база/.test(t));
    if (!rows.length || !rows.every(t => /\\d/.test(t))) return;
    const t = (document.getElementById("rank") ? "rank:" : "places:") + rows.join(",");
    const last = window.__scoreSnaps[window.__scoreSnaps.length - 1];
    if (last !== t) window.__scoreSnaps.push(t);
  };
  new MutationObserver(grab).observe(document, { childList: true, subtree: true, characterData: true });
})()`;

/* ---------- what the service worker keeps for offline use ---------- */

test("every file the service worker pre-caches exists in the site and is listed once", () => {
  const missing = SHELL_FILES.filter(p => !existsSync(join(ROOT, p)));
  assert.deepEqual(missing, [], "files listed in sw.js SHELL that are not in the site: install would fail and the app would never work offline");
  assert.equal(new Set(SHELL).size, SHELL.length, "no duplicates in SHELL");
  assert.match(VERSION, /^wtl-/, "the cache name starts with wtl- so old versions get cleaned up");
});

test("every module the app imports is pre-cached, so a launch without internet never misses code", () => {
  const seen = new Set(), queue = ["js/app.js"];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(f), spec)));
    }
  }
  assert.ok(seen.size >= 10, "found the app's module graph: " + [...seen].join(", "));
  assert.deepEqual([...seen].filter(f => !SHELL_FILES.includes(f)), [], "modules missing from SHELL");
});

test("every stylesheet, script, font, icon and the manifest linked by the page are pre-cached", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const linked = [...html.matchAll(/(?:href|src)="([^"#:][^"]*)"/g)].map(m => posix.normalize(m[1]));
  const fonts = [...readFileSync(join(ROOT, "css/fonts.css"), "utf8").matchAll(/url\(([^)]+)\)/g)].map(m => posix.normalize(posix.join("css", m[1].replace(/['"]/g, ""))));
  const man = JSON.parse(readFileSync(join(ROOT, "manifest.webmanifest"), "utf8"));
  const icons = man.icons.map(i => posix.normalize(i.src));
  const all = [...new Set([...linked, ...fonts, ...icons])];
  assert.ok(fonts.length >= 20 && linked.length >= 6, `found links: ${linked.length}, fonts: ${fonts.length}`);
  assert.deepEqual(all.filter(f => !SHELL_FILES.includes(f)), [], "linked files missing from SHELL");
});

test("the first visit installs the offline copy: every pre-cached file is in the cache of the current version", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  await swReady();
  assert.deepEqual(await cacheKeys(), [VERSION], "exactly one cache, named after the current version");
  const cached = await cachedPaths(VERSION);
  assert.deepEqual(SHELL.filter(p => !cached.includes(p)), [], "files not cached after the first visit");
  assert.deepEqual(page.takeErrors(), []);
});

test("using every screen downloads no app file outside the offline copy, and our data never lands in it", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  await swReady();
  site.log.length = 0;
  for (const h of ["#/rank", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/rate", "#/rate/new/porto", "#/rate/r1", "#/settings", "#/map"]) {
    await page.eval(`location.hash = ${JSON.stringify(h)}`);
    await sleep(350);
  }
  await page.tap({ text: "Слои" });
  await page.eval(`(() => { const s = [...document.querySelectorAll("#layersPanel select")].find(s => [...s.options].some(o => /климат|январ|июл/i.test(o.text))); if (s) { s.value = [...s.options].find(o => /январ|июл|климат/i.test(o.text)).value; s.dispatchEvent(new Event("change", { bubbles: true })); } })()`);
  await sleep(600);
  await page.tap({ sel: "#searchInput" });
  await page.type("Бар");
  await sleep(800);
  const outside = [...new Set(site.log)].map(p => p.slice(1) || "./").filter(p => !SHELL.includes(p) && !SHELL_FILES.includes(p) && p !== "sw.js");
  assert.deepEqual(outside, [], "same-origin files fetched at runtime that are not pre-cached, so they break offline");
  const cached = await cachedPaths(VERSION);
  assert.deepEqual(cached.filter(p => !SHELL.includes(p)), [], "the offline cache holds only app files (no GitHub data, no search results)");
  assert.deepEqual(page.takeErrors(), []);
});

/* ---------- offline ---------- */

test("without internet every screen opens from the offline copy with our data and says it is offline, light and dark", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  await swReady();
  await goOffline();
  await relaunch("#/map");
  await booted();
  assert.equal(await page.eval("navigator.onLine"), false);
  const problems = [];
  for (const dark of [false, true]) {
    await page.viewport(390, 844, { dark });
    for (const [hash, check] of [
      ["#/map", `document.querySelectorAll(".leaflet-marker-icon").length >= 5`],
      ["#/rank", `document.querySelector("#v-rank h1")?.innerText === "Рейтинг" && document.querySelectorAll("#rank .row").length >= 5 && /Нет связи/.test(document.getElementById("v-rank").innerText)`],
      ["#/places", `document.querySelectorAll(".prow").length === 6 && /Нет связи/.test(document.getElementById("v-places").innerText)`],
      ["#/place/porto", `document.querySelector("#v-place h1")?.innerText === "Порту" && /Нет связи/.test(document.getElementById("v-place").innerText)`],
      ["#/place/sankt-peterburg", `document.querySelector("#v-place h1")?.innerText === "Санкт-Петербург"`],
      ["#/rate/new/batumi", `document.querySelector("#v-rate h1")?.innerText === "Оценить поездку" && document.getElementById("fPlace").value === "batumi" && /Нет связи/.test(document.getElementById("v-rate").innerText)`],
      ["#/settings", `document.querySelector("#v-settings h1")?.innerText === "Настройки"`],
    ]) {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      const ok = await softWait(check, 4000);
      if (!ok) problems.push(`${dark ? "dark" : "light"} ${hash}: ${(await page.eval(`document.querySelector(".view:not([hidden])")?.innerText.slice(0, 160) || "(nothing)"`)).replace(/\s+/g, " ")}`);
      const sync = await page.text("#syncText");
      if (!/^Нет связи/.test(sync)) problems.push(`${hash}: status says «${sync}»`);
    }
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(page.takeErrors(), []);
});

test("without internet no picture, icon or font is broken on any screen, and missing map tiles stay invisible", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/place/porto" });
  await swReady();
  await goOffline();
  await relaunch("#/map");
  await booted();
  const broken = [];
  for (const hash of ["#/map", "#/rank", "#/places", "#/place/porto", "#/rate", "#/settings"]) {
    await page.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(500);
    await page.eval(`document.fonts.ready.then(() => 1)`);
    (await page.eval(`[...document.images].filter(i => !i.closest(".leaflet-tile-pane") && i.complete && i.naturalWidth === 0 && getComputedStyle(i).visibility !== "hidden").map(i => i.src)`)).forEach(s => broken.push(`${hash}: image ${s}`));
  }
  await page.eval(`location.hash = "#/map"`);
  await sleep(500);
  const tiles = await page.eval(`[...document.querySelectorAll(".leaflet-tile")].map(i => ({ shown: getComputedStyle(i).visibility !== "hidden" && getComputedStyle(i).opacity !== "0", ok: i.naturalWidth > 0 }))`);
  assert.ok(tiles.every(t => t.ok || !t.shown), "a failed map tile must not show a broken-image icon");
  assert.equal(await page.eval(`!!document.querySelector("#map canvas")`), true, "country outlines are still drawn without the tile server");
  const fontErr = await page.eval(`[...new Set([...document.fonts].filter(f => f.status === "error").map(f => f.family + " " + f.weight))]`);
  assert.deepEqual(broken.concat(fontErr.map(f => "font " + f)), []);
  assert.deepEqual(page.takeErrors(), []);
});

test("on the map without internet the screen itself says there is no connection and our data is the saved copy", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  await swReady();
  await goOffline();
  await relaunch("#/map");
  await booted();
  await sleep(400);
  await page.shot("c2-offline-map");
  const txt = await page.eval(`[...document.querySelectorAll("#v-map .map-note, #v-map .banner, #v-map #legendBox, #v-map #mapNote, #v-map [role=status]")].filter(e => !e.closest("[hidden]")).map(e => e.innerText).join(" ")`);
  assert.match(txt, /нет связи|офлайн|без интернета/i, "only a grey «Офлайн» in the header; the empty grey map background is not explained: " + JSON.stringify(txt));
});

test("the installed app opened offline from its home-screen link with extra parameters still starts", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  await goOffline();
  await page.goto("about:blank", 200);
  await page.send("Page.navigate", { url: site.url + "?source=homescreen#/rank" });
  await booted();
  assert.equal(await h1(), "Рейтинг");
  assert.equal(await page.text("#syncText"), "Нет связи");
  assert.deepEqual(page.takeErrors(), []);
});

test("a data file missing from the offline copy does not break the app: the dossier and the map still open", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/place/porto" });
  await swReady();
  await page.eval(`caches.open(${JSON.stringify(VERSION)}).then(c => c.delete("data/world/cities.json"))`);
  await goOffline();
  await relaunch("#/place/porto");
  await booted();
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Порту"`, 5000, "dossier");
  await page.eval(`location.hash = "#/map"`);
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length >= 5`, 5000, "pins");
  assert.deepEqual(page.takeErrors(), []);
});

test("without internet a missing app file fails as an error instead of returning the page, and index.html still opens the app", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  await goOffline();
  await relaunch("#/rank");
  await booted();
  const r = await page.eval(`fetch("js/not-there.js").then(r => "status " + r.status + " " + (r.headers.get("content-type") || ""), e => "error")`);
  assert.equal(r, "error", "an uncached file offline must fail, not come back as something else");
  await page.goto("about:blank", 200);
  await page.send("Page.navigate", { url: site.url + "index.html#/places" });
  await booted();
  await page.waitFor(`document.querySelectorAll(".prow").length === 6`, 5000, "places from cache");
  assert.deepEqual(page.takeErrors(), []);
});

test("the offline copy is set up on the first launch even while our data is still loading from GitHub", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await page.goto(site.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); localStorage.removeItem("wtl:cache"); localStorage.setItem("mock:delay", "8000"); })()`);
  try {
    await page.send("Page.navigate", { url: site.url + "#/rank" });
    await sleep(3000);
    const reg = await page.eval(`navigator.serviceWorker.getRegistration().then(r => !!r)`);
    assert.equal(reg, true, "the service worker is registered only after GitHub answers; if the first launch is closed before that, the app will not open offline");
  } finally { await page.eval(`localStorage.removeItem("mock:delay")`).catch(() => {}); }
});

test("with 100 places and 300 ratings, a launch without internet on a 4× slower phone shows the ranking within 2 s", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: huge() });
  await swReady();
  await goOffline();
  await relaunch("#/rank");
  await booted();
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("about:blank", 100);
  const t0 = Date.now();
  await page.send("Page.navigate", { url: site.url + "#/rank" });
  await page.waitFor(READY["#/rank"], 15000, "ranking offline");
  const ms = Date.now() - t0;
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 3000, "offline status after the mock's delay").catch(() => {});
  assert.equal(await page.text("#syncText"), "Нет связи");
  assert.ok(ms < 2000, `ranking offline after ${ms} ms`);
});

test("settings tell the user that the app keeps working without internet", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await swReady();
  await page.eval(`location.hash = "#/settings"`);
  await sleep(300);
  const t = await page.text("#v-settings");
  assert.match(t, /без интернета|без связи|офлайн/i, "nothing says the app works offline after the first visit — useful to know before a trip");
});

/* ---------- updates after a new deploy ---------- */

test("after a new version is deployed, the old offline copy is removed and only the new one stays", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  deploy();
  await relaunch("#/rank");
  await booted();
  await newSwInstalled();
  await relaunch("#/rank");
  await booted();
  await page.waitFor(`caches.keys().then(k => k.length === 1 && k[0] === ${JSON.stringify(NEW_VERSION)})`, 10000, "old cache removed");
  const cached = await cachedPaths(NEW_VERSION);
  assert.deepEqual(SHELL.filter(p => !cached.includes(p)), []);
});

test("every deploy gives the offline copy a version of the site's content: new world data or new code means a new version, an unchanged site keeps it", () => {
  assert.ok(PAGES.indexOf(STAMP_STEP) > PAGES.indexOf("name: Collect site") && PAGES.indexOf(STAMP_STEP) < PAGES.indexOf("upload-pages-artifact"), "the stamp must run after the site is collected and before it is uploaded");
  const same1 = versionOf(deployedSw()), same2 = versionOf(deployedSw());
  const data = versionOf(deployedSw({ "data/world/indicators.json": newWorld() }));
  const code = versionOf(deployedSw({ "js/views.js": readFileSync(join(ROOT, "js/views.js"), "utf8") + "\n// next release\n" }));
  assert.ok(same1 && same1.startsWith(VERSION + "-") && same1 !== VERSION, `the deployed version «${same1}» is not «${VERSION}» plus a stamp`);
  assert.equal(same1, same2, "two deploys of the same site must not make every phone download the app again");
  assert.notEqual(data, same1, "a monthly world-data deploy keeps the old version: installed phones would keep the old indicators forever");
  assert.notEqual(code, same1, "a code deploy without a manual VERSION bump keeps the old version: installed phones would keep the old code");
  assert.notEqual(code, data);
});

test("new monthly world data reaches a phone that already has the app: after the update the app uses the new indicators, not the copy cached months ago", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  const world = () => page.eval(`import("./js/app.js").then(m => m.state.world.generated)`);
  const before = await world();
  assert.notEqual(before, "2099-01-05");
  const body = newWorld(), sw = deployedSw({ "data/world/indicators.json": body }), v = versionOf(sw);
  site.over["data/world/indicators.json"] = body;
  site.over["sw.js"] = sw;
  await relaunch("#/rank");
  await booted();
  await page.waitFor(`(async () => { const r = await navigator.serviceWorker.getRegistration(); const k = await caches.keys(); return !!r && !r.installing && k.includes(${JSON.stringify(v)}) && (await (await caches.open(${JSON.stringify(v)})).keys()).length >= ${SHELL.length}; })()`, 15000, "the deployed version installed");
  await relaunch("#/rank");
  await booted();
  await page.waitFor(`import("./js/app.js").then(m => m.state.world.generated === "2099-01-05")`, 8000, "new world data").catch(() => {});
  assert.equal(await world(), "2099-01-05", `the app still shows world data of ${before} after the monthly deploy`);
  assert.deepEqual(await cacheKeys(), [v], "the old offline copy is removed");
  assert.deepEqual(page.takeErrors(), []);
});

test("after a new version is deployed, the next launch runs the new code without errors", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  deploy();
  await relaunch("#/rank");
  await booted();
  await newSwInstalled();
  await sleep(500);
  await relaunch("#/rank");
  await booted();
  assert.equal(await newCodeRunning(), true, "the second launch after a deploy runs the new version");
  assert.equal(await h1(), "Рейтинг");
  assert.deepEqual(page.takeErrors(), []);
});

test("when a new version has been downloaded, the user is told and can switch to it right away (or gets it automatically)", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  await relaunch("#/rank");
  await booted();
  deploy();
  await relaunch("#/rank");
  await booted();
  await newSwInstalled();
  const told = await softWait(`window.__deploy === "v99" || [...document.querySelectorAll("body *")].some(e => !e.closest("#syncBtn") && !e.closest("[hidden]") && e.children.length === 0 && /нов\\S* верси|обновлени\\S* приложени|приложение обновил/i.test(e.innerText || ""))`, 6000);
  await page.shot("c2-update-ready");
  assert.ok(told, "the new version sits in the cache, the old one keeps running, and nothing tells the user; on an iPhone home-screen app there is no reload button");
});

test("a deploy whose download broke halfway does not leave a blank app on the next launch, online or offline", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  await relaunch("#/rank");
  await booted();
  deploy();
  site.fail.add("js/views.js");
  await relaunch("#/rank");
  await booted();
  await softWait(`(async () => { const r = await navigator.serviceWorker.getRegistration(); return !r.installing; })()`, 8000);
  await softWait(`(async () => { for (const k of await caches.keys()) { const res = await (await caches.open(k)).match("js/app.js"); if (res && /DEPLOY_MARK/.test(await res.text())) return true; } return false; })()`, 4000);
  site.fail.clear();
  page.takeErrors();
  await goOffline();
  await relaunch("#/rank");
  const offlineOk = await appStarted();
  const offlineErr = page.takeErrors();
  await page.shot("c2-half-deploy-offline");
  await goOnline();
  await relaunch("#/rank");
  const onlineOk = await appStarted();
  const onlineErr = page.takeErrors();
  assert.ok(offlineOk && onlineOk, `the app did not start (offline: ${offlineOk}, online: ${onlineOk}); errors: ${JSON.stringify(offlineErr.concat(onlineErr))}`);
  assert.deepEqual(offlineErr.concat(onlineErr).filter(e => /does not provide an export|SyntaxError/.test(e)), [], "old and new app files were mixed");
});

test("the app looks for a new version when it comes back to the screen, not only on a cold start", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  await swReady();
  await sleep(300);
  deploy();
  site.log.length = 0;
  await page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
  let asked = false;
  for (const end = Date.now() + 4000; Date.now() < end && !asked; await sleep(100)) asked = site.log.includes("/sw.js");
  assert.ok(asked, "returning to the app from the background never checks for an update; an iPhone home-screen app can stay on an old version for days: " + JSON.stringify([...new Set(site.log)]));
});

test("an app update never throws away a half-filled rating", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rate" });
  await swReady();
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.fill("#fReview", "Тёплое море, но шумно");
  await sleep(500);
  deploy();
  await page.eval(`navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => {})`);
  await newSwInstalled();
  await sleep(3000);
  await page.waitFor(`document.getElementById("fPlace")`, 8000, "rating form");
  if (!(await page.eval(`location.hash`)).startsWith("#/rate")) await page.eval(`location.hash = "#/rate"`);
  await page.waitFor(`document.getElementById("fPlace")?.value === "batumi"`, 5000, "place kept");
  assert.equal(await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').getAttribute("aria-pressed")`), "true");
  assert.equal(await page.eval(`document.getElementById("fReview").value`), "Тёплое море, но шумно");
});

test("settings show which version of the app is running", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await swReady();
  await page.eval(`location.hash = "#/map"`);
  await page.eval(`location.hash = "#/settings"`);
  await sleep(300);
  assert.match(await page.text("#v-settings"), /верси/i, "no way to tell whether the phone already runs the latest version");
});

/* ---------- when the app itself cannot load ---------- */

test("if the app's settings file cannot be downloaded, the screen explains it in Russian and offers to try again", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await page.goto(site.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); })()`);
  site.fail.add("schema.json");
  await page.goto(site.url + "#/rank", 1500);
  await page.shot("c2-boot-fail");
  const t = await page.text("#main");
  assert.doesNotMatch(t, /Failed to fetch|Unexpected token|TypeError|SyntaxError/, "a raw English error is shown: " + t);
  assert.match(t, /связ|интернет/i, "the message should say the connection failed: " + t);
  const retry = await page.locate({ within: "#main", text: "ещё раз" }).then(r => !r.error, () => false) || await page.locate({ within: "#main", text: "Обновить" }).then(r => !r.error, () => false);
  assert.ok(retry, "no button to try again; a home-screen app on iPhone has no reload button");
});

test("if a part of the app's code cannot be downloaded, the screen is not left blank", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await page.goto(site.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); })()`);
  site.fail.add("js/similar.js");
  await page.goto(site.url + "#/rank", 3000);
  await page.shot("c2-module-fail");
  const t = await page.text("#main");
  assert.match(t, /не загрузил|не удалось|нет связи/i, "the whole screen stays empty with «…» in the header: " + JSON.stringify(t));
  page.takeErrors();
});

test("on a slow first visit the screen says the app is loading instead of staying empty", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings" });
  await page.goto(site.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); })()`);
  site.delay["schema.json"] = 4000;
  await page.send("Page.navigate", { url: site.url + "#/rank" });
  await sleep(1800);
  const t = await page.eval(`document.getElementById("main").innerText`);
  await page.shot("c2-slow-boot");
  assert.match(t, /загру/i, "for seconds the page shows only the header with «…» and an empty body: " + JSON.stringify(t));
  await booted();
});

/* ---------- home screen: manifest, icons, colours, notch ---------- */

test("the page carries what iPhone needs for a home-screen app: icon 180×180, title, standalone, notch layout, bar colours for both themes", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  const m = await page.eval(`(() => { const meta = n => document.querySelector('meta[name="' + n + '"]')?.content; return { viewport: meta("viewport"), capable: meta("apple-mobile-web-app-capable"), title: meta("apple-mobile-web-app-title"), touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"), themes: [...document.querySelectorAll('meta[name="theme-color"]')].map(x => [x.media, x.content]), manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href") }; })()`);
  assert.match(m.viewport, /viewport-fit=cover/);
  assert.equal(m.capable, "yes");
  assert.equal(m.title, "Где жить");
  assert.ok(SHELL.includes(m.touch), "the home-screen icon is in the offline copy");
  const size = await page.eval(`new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => r("error"); i.src = ${JSON.stringify(m.touch)}; })`);
  assert.equal(size, "180x180");
  assert.ok(m.themes.some(([media]) => /light/.test(media || "")) && m.themes.some(([media]) => /dark/.test(media || "")), "theme-color for light and for dark: " + JSON.stringify(m.themes));
  const man = await page.eval(`fetch(${JSON.stringify(m.manifest)}).then(r => r.json())`);
  assert.equal(man.display, "standalone");
  assert.equal(man.short_name.length <= 12, true, "the short name fits under the icon");
  assert.ok(man.icons.some(i => i.sizes === "192x192") && man.icons.some(i => i.sizes === "512x512"));
  await page.viewport(390, 844, { dark: true });
  assert.equal(await activeThemeColor(), m.themes.find(([media]) => /dark/.test(media || ""))[1].toLowerCase());
});

test("the colour the phone paints around the app matches the app bar in light and dark", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  const out = [];
  for (const dark of [false, true]) {
    await page.viewport(390, 844, { dark });
    await sleep(150);
    const bar = hexOf(await page.eval(`getComputedStyle(document.querySelector(".appbar")).backgroundColor`));
    const tc = await activeThemeColor();
    if (bar !== tc) out.push(`${dark ? "dark" : "light"}: status bar ${tc}, app bar ${bar}`);
  }
  assert.deepEqual(out, [], "a two-tone strip appears between the phone's status bar and the app bar");
});

test("the installed app's manifest colour matches the light theme the app opens with", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  const man = await page.eval(`fetch("manifest.webmanifest").then(r => r.json())`);
  const light = await page.eval(`document.querySelector('meta[name="theme-color"][media*="light"]')?.content.toLowerCase()`);
  assert.equal(man.theme_color.toLowerCase(), light, "manifest theme_color differs from the page's light theme-color");
});

test("the home-screen icon is a full square without transparent corners (iPhone fills them with black)", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map" });
  const alpha = await page.eval(`new Promise(r => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext("2d"); g.drawImage(i, 0, 0); r([[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]].map(([x, y]) => g.getImageData(x, y, 1, 1).data[3])); }; i.src = document.querySelector('link[rel="apple-touch-icon"]').getAttribute("href"); })`);
  assert.deepEqual(alpha, [255, 255, 255, 255], "corner alpha of apple-touch-icon");
});

test("on an iPhone with a notch, upright, the header, the tabs, the save bar and messages stay clear of the notch and the home bar", { skip }, async () => {
  await page.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, left: 0, right: 0, bottom: 34 } });
  await openApp(page, site.url, { hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  const r = await page.eval(`(() => { const b = s => { const e = document.querySelector(s); if (!e || e.closest("[hidden]")) return null; const x = e.getBoundingClientRect(); return { top: x.top, bottom: x.bottom, left: x.left, right: x.right }; }; return { brand: b(".brand"), settings: b('.appbar a[data-nav="settings"]'), nav: b(".bottomnav"), navLabel: b(".bottomnav a span"), save: b(".savebar"), h: innerHeight }; })()`);
  assert.ok(r.brand.top >= 47 && r.settings.top >= 47, "header content below the notch: " + JSON.stringify(r.brand));
  assert.ok(r.navLabel.bottom <= r.h - 34, "tab labels above the home bar: " + JSON.stringify(r.navLabel));
  assert.ok(r.save.bottom <= r.nav.top, "the save bar is above the tabs");
  await page.eval(`location.hash = "#/map"`);
  await sleep(400);
  const m = await page.eval(`(() => { const s = document.getElementById("searchInput").getBoundingClientRect(), a = document.querySelector(".appbar").getBoundingClientRect(); return { search: s.top, bar: a.bottom }; })()`);
  assert.ok(m.search >= m.bar, "the map search box is not under the header");
  await page.shot("c2-notch-portrait");
});

test("on an iPhone turned sideways, the notch does not cover the header, page titles or the map search", { skip }, async () => {
  await page.viewport(844, 390);
  await page.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 47, right: 47, bottom: 21 } });
  await openApp(page, site.url, { hash: "#/rank" });
  const out = [];
  const check = async (hash, sels) => {
    await page.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(500);
    const r = await page.eval(`(${JSON.stringify(sels)}).map(s => { const e = document.querySelector(s); if (!e) return [s, null]; const x = e.getBoundingClientRect(); return [s, Math.round(x.left), Math.round(innerWidth - x.right)]; })`);
    r.forEach(([s, l, rr]) => { if (l != null && (l < 47 || rr < 47)) out.push(`${hash} ${s}: ${l}px from the left, ${rr}px from the right`); });
  };
  await check("#/rank", [".brand", '.appbar a[data-nav="settings"]', "#v-rank h1"]);
  await check("#/map", ["#searchInput", "#layersBtn"]);
  await page.shot("c2-notch-landscape");
  assert.deepEqual(out, [], "content sits under the 47 px notch area");
});

/* ---------- speed and memory with 100 places and 300 ratings ---------- */

test("with 100 places and 300 ratings a repeat launch on a 4× slower phone shows the ranking within 2 s and the list and the map within 1.5 s", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: huge() });
  await swReady();
  await relaunch("#/rank");
  await booted();
  await sleep(800);
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const t = {};
  for (const hash of ["#/rank", "#/places", "#/map"]) t[hash] = await launchTime(hash);
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  assert.ok(t["#/rank"] < 2000 && t["#/places"] < 1500 && t["#/map"] < 1500, JSON.stringify(t));
});

test("on the first visit over slow mobile internet (Fast 3G) the ranking appears within 4.5 s", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/settings", files: huge() });
  await page.goto(site.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => { for (const k of await caches.keys()) await caches.delete(k); for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); localStorage.removeItem("wtl:cache"); })()`);
  await page.send("Network.clearBrowserCache");
  site.st.gzip = true;
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 562.5, downloadThroughput: 184320, uploadThroughput: 84375 });
  const t0 = Date.now();
  await page.send("Page.navigate", { url: site.url + "#/rank" });
  await page.waitFor(READY["#/rank"], 30000, "ranking");
  const ms = Date.now() - t0;
  const blockers = await page.eval(`performance.getEntriesByType("resource").filter(e => /\\.(js|json|geojson)$/.test(e.name)).map(e => e.name.replace(location.origin, "") + " " + Math.round(e.startTime) + "→" + Math.round(e.responseEnd)).join(", ")`);
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.ok(ms < 4500, `ranking shown after ${ms} ms; requests: ${blockers}`);
});

test("on launch the ranking and the list do not first show numbers that change a moment later", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank" });
  await swReady();
  await sleep(500);
  const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: SCORE_WATCH });
  try {
    const out = {};
    for (const hash of ["#/rank", "#/places"]) {
      await page.goto(site.url + "manifest.webmanifest", 50);
      await page.goto(site.url + hash, 2500);
      out[hash] = await page.eval("window.__scoreSnaps");
    }
    const jumpy = Object.entries(out).filter(([, s]) => s.length > 1).map(([h, s]) => `${h}: first «${s[0]}», then «${s[s.length - 1]}»`);
    assert.deepEqual(jumpy, [], "scores are rendered before the city climate data is loaded and then silently change");
  } finally { await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }); }
});

test("with 100 places, dragging a weight slider keeps up with the finger on a 4× slower phone", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/rank", files: huge() });
  await page.waitFor(READY["#/rank"], 8000, "ranking");
  await sleep(600);
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const ms = await page.eval(`(async () => {
    const i = document.querySelector("#wgrid input[type=range]");
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    await frame();
    const t = performance.now();
    for (let v = 12; v <= 30; v += 2) { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); }
    await frame(); await frame();
    return Math.round(performance.now() - t);
  })()`);
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  assert.match(await page.text("#wsum"), /Своё/);
  assert.ok(ms < 200, `10 slider moves took ${ms} ms: every move rebuilds the whole ranking including the 25-run «№1–3 в зависимости от весов» check`);
});

test("with 100 places each tab opens within half a second on a 4× slower phone", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map", files: huge() });
  await sleep(1200);
  await page.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const t = {};
  for (const hash of ["#/rank", "#/places", "#/place/big-005", "#/map", "#/rate", "#/settings", "#/rank"]) {
    t[hash] = Math.max(t[hash] || 0, await page.eval(`new Promise(r => { const t = performance.now(); addEventListener("hashchange", () => requestAnimationFrame(() => setTimeout(() => r(Math.round(performance.now() - t)), 0)), { once: true }); location.hash = ${JSON.stringify(hash)}; })`));
    await sleep(250);
  }
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  assert.ok(Object.values(t).every(ms => ms < 500), JSON.stringify(t));
  assert.deepEqual(page.takeErrors(), []);
});

test("with 100 places, switching tabs 20 times does not pile up memory, page elements or listeners", { skip }, async () => {
  await openApp(page, site.url, { hash: "#/map", files: huge() });
  await sleep(1200);
  await page.send("HeapProfiler.enable");
  const R = ["#/rank", "#/places", "#/place/big-010", "#/map", "#/rate", "#/settings"];
  const lap = async n => { for (let i = 0; i < n; i++) { await page.eval(`location.hash = ${JSON.stringify(R[i % R.length])}`); await sleep(200); } await page.eval(`location.hash = "#/map"`); await sleep(600); };
  const measure = async () => { await page.send("HeapProfiler.collectGarbage"); await sleep(150); await page.send("HeapProfiler.collectGarbage"); const c = await page.send("Memory.getDOMCounters"); return { heap: await page.eval(`performance.memory.usedJSHeapSize`), nodes: c.nodes, listeners: c.jsEventListeners }; };
  await lap(6);
  const a = await measure();
  await lap(20);
  const b = await measure();
  await page.send("HeapProfiler.disable");
  assert.ok(b.heap < a.heap * 1.2, `JS heap grew from ${Math.round(a.heap / 1024)} to ${Math.round(b.heap / 1024)} KB`);
  assert.ok(b.nodes < a.nodes * 1.1, `page elements grew from ${a.nodes} to ${b.nodes}`);
  assert.ok(b.listeners <= a.listeners + 10, `listeners grew from ${a.listeners} to ${b.listeners}`);
});
