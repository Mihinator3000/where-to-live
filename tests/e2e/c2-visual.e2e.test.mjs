import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); await insets(); } });

/* ---------- data sets ---------- */

const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const SPOTS = [["PRT", "Португалия", 38.72, -9.14], ["ESP", "Испания", 40.42, -3.7], ["GEO", "Грузия", 41.72, 44.78], ["SRB", "Сербия", 44.79, 20.45], ["MNE", "Черногория", 42.44, 19.26], ["TUR", "Турция", 41.01, 28.98], ["ITA", "Италия", 41.9, 12.5], ["GRC", "Греция", 37.98, 23.73], ["HRV", "Хорватия", 45.81, 15.98], ["ARM", "Армения", 40.18, 44.51], ["CYP", "Кипр", 35.17, 33.36], ["BGR", "Болгария", 42.7, 23.32], ["ALB", "Албания", 41.33, 19.82], ["MKD", "Северная Македония", 41.99, 21.43], ["BIH", "Босния и Герцеговина", 43.86, 18.41], ["SVN", "Словения", 46.06, 14.51], ["HUN", "Венгрия", 47.5, 19.04], ["CZE", "Чехия", 50.08, 14.44], ["POL", "Польша", 52.23, 21.01], ["DEU", "Германия", 52.52, 13.4], ["FRA", "Франция", 48.86, 2.35], ["NLD", "Нидерланды", 52.37, 4.9], ["AUT", "Австрия", 48.21, 16.37], ["ROU", "Румыния", 44.43, 26.1], ["KAZ", "Казахстан", 43.24, 76.89], ["UZB", "Узбекистан", 41.3, 69.24], ["ISR", "Израиль", 32.09, 34.78], ["THA", "Таиланд", 13.75, 100.5], ["VNM", "Вьетнам", 21.03, 105.85]];
const LONG = ["Санта-Крус-де-Тенерифе и окрестности северного побережья", "Херцег-Нови, район Топла над старым городом у моря", "Кастельдефельс — пригород Барселоны с длинным пляжем", "Белград, Земун и Нови-Београд вдоль Дуная"];
const SANTA = LONG[0];

function richRepo() {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const fact = (v, src) => ({ v, src, at: "2026-09-10" });
  const spb = Object.assign({}, PLACES[0], { facts: { rent: fact(600, "Циан"), dinner: fact(40, "кафе"), basket: fact(45, "Перекрёсток"), utilities: fact(95, "квитанция"), tds: fact(60, "TDS-метр") } });
  const places = [spb];
  SPOTS.forEach(([cc, country, lat, lon], i) => {
    const n = String(i + 1).padStart(2, "0");
    const name = (i < LONG.length ? LONG[i] : `Длинноназванный городок номер ${n} на побережье`).slice(0, 60);
    places.push({
      id: "pl-" + n, name, country, cc, lat, lon, status: i % 7 === 6 ? "отсев" : i % 5 === 4 ? "финалист" : "кандидат", archetype: i % 2 ? "город у моря" : "мегаполис",
      reason: i % 7 === 6 ? "Слишком жарко летом и далеко от аэропорта" : "", questions: i % 3 === 0 ? "Проверить сырость зимой, шум от дороги и как ходят автобусы в межсезон" : "",
      ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T,
      facts: { rent: fact(400 + Math.round(rnd() * 900), "idealista, 20 объявлений"), dinner: fact(20 + Math.round(rnd() * 50), "3 ужина"), basket: fact(30 + Math.round(rnd() * 40), "Lidl"), utilities: fact(50 + Math.round(rnd() * 150), "хозяин"), tds: fact(50 + Math.round(rnd() * 450), "TDS") },
    });
  });
  const ratings = [];
  for (let i = 0; i < 120; i++) {
    const idx = 1 + (i % SPOTS.length), bias = 1.2 + 3.6 * (idx - 1) / (SPOTS.length - 1);
    const scores = {};
    STAR.forEach(k => { scores[k] = Math.max(1, Math.min(5, Math.round((bias + rnd() - 0.5) * 2) / 2)); });
    if (i % 4 === 0) { scores["продукты"] = 3.5; scores["эстетика"] = 2; }
    const m = String(1 + (i % 12)).padStart(2, "0");
    ratings.push({
      id: "rt" + i, place: places[idx].id, who: i % 2 ? "Вика" : "Михаил", start: `2025-${m}-01`, end: `2025-${m}-10`, days: 10,
      season: ["пик", "межсезон", "худший"][i % 3], mode: ["отпуск", "удалёнка", "смешанно"][i % 3], housing: ["жилой район", "центр", "туристическая зона"][i % 3],
      retro: i % 5 === 0, year: Math.floor(rnd() * 11), veto: i === 7 ? "Слишком шумно ночью, не выспаться" : "",
      review: `Синтетический отзыв номер ${i}: тихо, зелено, но дорого и сыро зимой.`, scores, conf: i % 3 ? { "интернет": "A" } : {},
      notes: i % 4 ? {} : { city: "Длинный комментарий про город и быт, чтобы проверить перенос строк в карточке поездки." },
      surprises: i % 6 ? "" : "Неожиданно много собак на улицах", deleted: false, createdAt: T, updatedAt: T,
    });
  }
  return repo({ places, ratings });
}

const DATA = { empty: () => repo({ places: [], ratings: [] }), standard: () => repo(), rich: richRepo };
const ROUTES = {
  empty: ["#/rank", "#/places", "#/place/sankt-peterburg", "#/rate", "#/settings"],
  standard: ["#/rank", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/rate", "#/settings"],
  rich: ["#/rank", "#/places", "#/place/pl-01", "#/place/pl-07", "#/place/sankt-peterburg", "#/rate", "#/settings"],
};

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPHONE = { top: 47, bottom: 34, left: 0, right: 0 };
const IPHONE_SIDEWAYS = { top: 0, bottom: 21, left: 47, right: 47 };
const insets = async i => { try { await page.send("Emulation.setSafeAreaInsetsOverride", { insets: i || { top: 0, bottom: 0, left: 0, right: 0 } }); } catch (e) { if (i) throw e; } };
const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

async function go(hash) {
  const view = VIEW[hash.replace(/^#\//, "").split("/")[0]];
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`!document.getElementById(${JSON.stringify(view)}).hidden`, 4000, "view " + hash);
  if (view === "v-rate") await page.eval(`(() => { const b = document.getElementById("fShowAll"); if (b && !b.hidden) b.click(); })()`);
  await sleep(200);
}

async function open(ds, hash = "#/map", opts = {}) {
  await openApp(page, srv.url, Object.assign({ hash, files: DATA[ds]() }, opts));
  await sleep(200);
}

async function openSheetFor(q) {
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
  await page.waitFor(`!document.getElementById("searchResults").hidden && !!document.querySelector("#searchResults button[data-i]")`, 4000, "suggestions for " + q);
  await page.tap({ sel: "#searchResults button", nth: 0 });
  await page.waitFor(`!document.getElementById("sheet").hidden && !!document.querySelector("#sheetBody h3")`, 4000, "sheet");
  await sleep(1000);
}

const VIS_FN = `const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };`;

const COLOR_FNS = `
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (t, u) => [0, 1, 2].map(i => t[i] * t[3] + u[i] * (1 - t[3])).concat(1);
  const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let base = rgba(getComputedStyle(document.body).backgroundColor); for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const p = lum(a), q = lum(b); return Math.round((Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05) * 100) / 100; };
  const opacityOf = e => { let o = 1; for (let a = e; a; a = a.parentElement) o *= Number(getComputedStyle(a).opacity); return o; };
  const textRatio = e => { const bg = bgOf(e); let fg = over(rgba(getComputedStyle(e).color), bg); const o = opacityOf(e); if (o < 1) fg = over(fg.slice(0, 3).concat(o), bg); return ratio(fg, bg); };
`;

const LAYOUT = `(() => {
  ${VIS_FN}
  const clipped = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { if (p.matches("main, .page")) continue; if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\\s+/)[0] : "")) + " «" + (e.innerText || e.getAttribute("aria-label") || e.value || "").replace(/\\s+/g, " ").trim().slice(0, 24) + "»";
  const layer = e => e.closest(".appbar, .bottomnav, .savebar, #sheet, .map-top, #layersPanel, #legendBox, #toast, #mapNote") || "flow";
  const out = { overflow: document.documentElement.scrollWidth - innerWidth, off: [], overlap: [] };
  const view = document.querySelector(".view:not([hidden])");
  const all = [...document.querySelectorAll(".appbar *, .bottomnav *")].concat([...view.querySelectorAll("*")]).filter(e => !e.closest(".leaflet-container, svg") && vis(e));
  for (const e of all) { if (clipped(e)) continue; const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) out.off.push(desc(e) + " " + Math.round(r.left) + "→" + Math.round(r.right)); }
  const ctl = all.filter(e => e.matches("button, a, input, select, textarea, summary") && !clipped(e));
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    const a = ctl[i], b = ctl[j];
    if (a.contains(b) || b.contains(a) || layer(a) !== layer(b)) continue;
    if (a.closest("label") && a.closest("label") === b.closest("label")) continue;
    const hit = [...a.getClientRects()].some(r => [...b.getClientRects()].some(s => Math.min(r.right, s.right) - Math.max(r.left, s.left) > 2 && Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) > 2));
    if (hit) out.overlap.push(desc(a) + " × " + desc(b));
  }
  return out;
})()`;

const CONTRAST_SWEEP = `(() => {
  ${VIS_FN}
  ${COLOR_FNS}
  const roots = [document.querySelector(".appbar"), document.querySelector(".bottomnav"), document.querySelector(".view:not([hidden])"), ...["sheet", "layersPanel", "legendBox", "mapNote", "searchResults"].map(id => document.getElementById(id))].filter(r => r && !r.hidden && getComputedStyle(r).display !== "none");
  const out = [];
  for (const root of roots) for (const e of [root, ...root.querySelectorAll("*")]) {
    if (e.closest("svg, .leaflet-container, option, .row.pale, .world-row.off") || !vis(e)) continue;
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.data.trim())) continue;
    if (e.matches(":disabled") || e.closest(":disabled")) continue;
    const cs = getComputedStyle(e), fs = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
    const need = fs >= 24 || (fs >= 18.66 && bold) ? 3 : 4.5, r = textRatio(e);
    if (r < need) out.push((e.id ? "#" + e.id : e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\\s+/).join(".") : "")) + " «" + e.innerText.replace(/\\s+/g, " ").trim().slice(0, 30) + "» " + r + ":1");
  }
  return [...new Set(out)];
})()`;

const NUMBER_SPLITS = `(() => {
  const out = [];
  const roots = [document.querySelector(".view:not([hidden])"), document.getElementById("sheet")].filter(r => r && !r.hidden);
  for (const root of roots) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      const el = n.parentElement;
      if (!el || el.closest("[hidden], svg, .leaflet-container, select, option, textarea, input")) continue;
      const re = /[−-]?[€$]?\\d+(?:[.,]\\d+)?(?:\\s?(?:%|€|°C|°|ч\\b|км|мм|мкг\\/м³|ppm|\\/10|дн\\.|млн|тыс\\.))?/g;
      let m;
      while ((m = re.exec(n.data))) {
        if (m[0].length < 2) continue;
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const tops = [...new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top)))];
        if (tops.length > 1) out.push("«" + m[0] + "» in «" + el.innerText.replace(/\\s+/g, " ").trim().slice(0, 50) + "»");
      }
    }
  }
  return out;
})()`;

const rect = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`);
const inside = (a, b, tol = 1) => a.top >= b.top - tol && a.bottom <= b.bottom + tol && a.left >= b.left - tol && a.right <= b.right + tol;

async function layoutProblems(tag) {
  const o = await page.eval(LAYOUT);
  const p = [];
  if (o.overflow > 1) p.push(`${tag}: page scrolls sideways by ${o.overflow}px`);
  o.off.slice(0, 3).forEach(x => p.push(`${tag}: sticks out of the screen: ${x}`));
  o.overlap.slice(0, 3).forEach(x => p.push(`${tag}: controls overlap: ${x}`));
  return p;
}

async function sweep(w, h, side) {
  const problems = [];
  for (const dark of [false, true]) for (const ds of ["empty", "standard", "rich"]) {
    await page.viewport(w, h, { dark });
    await open(ds, "#/map", { intro: true });
    if (side) await insets(IPHONE_SIDEWAYS);
    const tag = `${w}×${h} ${dark ? "dark" : "light"} ${ds}`;
    problems.push(...await layoutProblems(`${tag} map with the intro card`));
    await page.eval(`document.getElementById("sheetClose").click(); document.getElementById("layersBtn").click()`);
    await sleep(150);
    problems.push(...await layoutProblems(`${tag} map with «Слои» open`));
    await page.eval(`document.getElementById("lyClose")?.click()`);
    for (const route of ROUTES[ds]) {
      await go(route);
      problems.push(...await layoutProblems(`${tag} ${route}`));
    }
  }
  assert.deepEqual(page.takeErrors(), [], "no JS errors");
  return problems;
}

/* ---------- layout sweeps: every width, both themes, three data sets ---------- */

for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]]) {
  test(`at ${w}×${h} every screen fits with no data, the usual data and 30 long-named places, light and dark: no sideways scroll, nothing sticks out, no controls overlap`, { skip, timeout: 120000 }, async () => {
    assert.deepEqual(await sweep(w, h, false), []);
  });
}

test("on a phone turned sideways (844×390) every screen fits with all three data sets, light and dark", { skip, timeout: 120000 }, async () => {
  assert.deepEqual(await sweep(844, 390, true), []);
});

test("no number is split from its unit or broken across two lines, on 320, 360 and 390 px phones", { skip, timeout: 120000 }, async () => {
  const found = [];
  for (const w of [320, 360, 390]) {
    await page.viewport(w, 740);
    for (const ds of ["standard", "rich"]) {
      await open(ds, "#/rank");
      for (const route of ROUTES[ds]) {
        await go(route);
        (await page.eval(NUMBER_SPLITS)).forEach(x => found.push(`${w}px ${ds} ${route}: ${x}`));
      }
    }
  }
  assert.deepEqual([...new Set(found.map(x => x.replace(/^\d+px \w+ #\/place\/[\w-]+/, "dossier")))], [], "a value and its unit must stay on one line (use a non-breaking space)");
});

/* ---------- contrast ---------- */

test("all text on every screen and map card reads at 4.5:1 (large text 3:1) in light and dark, with every data set", { skip, timeout: 120000 }, async () => {
  const bad = [];
  for (const [w, h] of [[390, 844], [1280, 800]]) for (const dark of [false, true]) for (const ds of ["empty", "standard", "rich"]) {
    await page.viewport(w, h, { dark });
    await open(ds, "#/map", { intro: true });
    const tag = `${w}px ${dark ? "dark" : "light"} ${ds}`;
    (await page.eval(CONTRAST_SWEEP)).forEach(x => bad.push(`${tag} intro: ${x}`));
    await page.eval(`document.getElementById("sheetClose").click(); document.getElementById("layersBtn").click()`);
    await sleep(150);
    (await page.eval(CONTRAST_SWEEP)).forEach(x => bad.push(`${tag} layers: ${x}`));
    await page.eval(`document.getElementById("lyClose")?.click()`);
    for (const route of ROUTES[ds]) {
      await go(route);
      (await page.eval(CONTRAST_SWEEP)).forEach(x => bad.push(`${tag} ${route}: ${x}`));
    }
  }
  assert.deepEqual(bad, []);
});

test("ranking rows with few of our own ratings stay readable: their chips and «из 5» reach 4.5:1 in light and dark", { skip }, async () => {
  const bad = [];
  for (const dark of [false, true]) {
    await page.viewport(390, 844, { dark });
    await open("standard", "#/rank");
    const rows = await page.eval(`(() => { ${VIS_FN} ${COLOR_FNS} return [...document.querySelectorAll("#rank .row.pale *")].filter(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.data.trim())).map(e => ({ text: e.innerText.trim().slice(0, 30), r: textRatio(e) })); })()`);
    assert.ok(rows.length > 5, "the usual data has rows with few own ratings");
    rows.filter(x => x.r < 4.5).forEach(x => bad.push(`${dark ? "dark" : "light"} «${x.text}» ${x.r}:1`));
  }
  assert.deepEqual([...new Set(bad)], [], "faded rows must still be readable (fade the bar, not the text)");
});

test("text fields, date fields and selects show their edge (at least 3:1 against the card) in light and dark", { skip }, async () => {
  const bad = [];
  const EDGES = sel => `(() => { ${COLOR_FNS} return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getBoundingClientRect().width > 0 && !e.closest("[hidden]")).map(e => { const outside = bgOf(e.parentElement), cs = getComputedStyle(e); return { name: e.id || e.name, edge: ratio(over(rgba(cs.borderTopColor), outside), outside), fill: ratio(over(rgba(cs.backgroundColor), outside), outside) }; }); })()`;
  for (const dark of [false, true]) {
    await page.viewport(390, 844, { dark });
    await open("standard", "#/places");
    for (const [route, sel] of [["#/places", "#placeFilter"], ["#/place/porto", "#factsForm input[type=text], #placeForm input[type=text], #placeForm select, #placeForm textarea"], ["#/rate", "#fPlace, #fStart, #fEnd, #fReview, #fVeto"], ["#/settings", "#tokenForm input[type=password]"]]) {
      await go(route);
      const fields = await page.eval(EDGES(sel));
      assert.ok(fields.length > 0, "fields on " + route);
      fields.filter(f => Math.max(f.edge, f.fill) < 3).forEach(f => bad.push(`${dark ? "dark" : "light"} ${route} ${f.name}: edge ${f.edge}:1`));
    }
  }
  assert.deepEqual([...new Set(bad.map(x => x.replace(/ (fact|src)_\w+:/, " $1_*:")))], [], "an empty field must be visible as a field");
});

/* ---------- iPhone safe areas ---------- */

test("on an iPhone with a notch and a home indicator the header clears the status bar, tab labels clear the home indicator and no screen ends under the tab bar", { skip, timeout: 90000 }, async () => {
  const bad = [];
  for (const ds of ["standard", "rich"]) {
    await open(ds, "#/rank");
    await insets(IPHONE);
    await sleep(150);
    for (const route of ROUTES[ds]) {
      await go(route);
      const r = await page.eval(`(() => {
        ${VIS_FN}
        const nav = document.querySelector(".bottomnav").getBoundingClientRect(), brand = document.querySelector(".brand").getBoundingClientRect();
        const labels = [...document.querySelectorAll(".bottomnav span")].map(s => s.getBoundingClientRect().bottom);
        const save = document.querySelector(".view:not([hidden]) .savebar");
        scrollTo(0, document.documentElement.scrollHeight);
        const limit = save ? save.getBoundingClientRect().top : nav.top;
        const els = [...document.querySelector(".view:not([hidden])").querySelectorAll("button, a, input, select, textarea, summary, p, li, h2, h3, .row, .prow, .trip")].filter(e => vis(e) && !e.closest(".savebar"));
        const last = Math.max(...els.map(e => e.getBoundingClientRect().bottom));
        const out = { brandTop: brand.top, labelBottom: Math.max(...labels), lastBottom: last, limit, saveBottom: save ? save.getBoundingClientRect().bottom : 0, navTop: nav.top };
        scrollTo(0, 0);
        return out;
      })()`);
      if (r.brandTop < IPHONE.top) bad.push(`${ds} ${route}: the brand sits under the status bar (top ${r.brandTop})`);
      if (r.labelBottom > 844 - IPHONE.bottom + 1) bad.push(`${ds} ${route}: tab labels sit on the home indicator`);
      if (r.lastBottom > r.limit + 1) bad.push(`${ds} ${route}: the end of the page stays under the ${r.limit === r.navTop ? "tab bar" : "save bar"} (${Math.round(r.lastBottom)} > ${Math.round(r.limit)})`);
      if (r.saveBottom && r.saveBottom > r.navTop + 1) bad.push(`${ds} ${route}: the save bar slides under the tab bar`);
    }
  }
  assert.deepEqual(bad, []);
});

test("on an iPhone turned sideways the header, the map search and page content stay clear of the notch", { skip }, async () => {
  await page.viewport(844, 390);
  const bad = [];
  for (const route of ["#/map", "#/rank", "#/place/porto", "#/rate", "#/settings"]) {
    await open("standard", route);
    await insets(IPHONE_SIDEWAYS);
    await sleep(250);
    const r = await page.eval(`(() => { const b = s => { const e = [...document.querySelectorAll(s)].find(x => x.getBoundingClientRect().width > 0); return e ? e.getBoundingClientRect() : null; }; return { brand: b(".brand").left, tools: b(".appbar-tools").right, search: b("#searchInput")?.left ?? null, h1: b(".view:not([hidden]) h1")?.left ?? null, firstTab: b(".bottomnav a svg").left, lastTab: [...document.querySelectorAll(".bottomnav a svg")].pop().getBoundingClientRect().right }; })()`);
    const L = IPHONE_SIDEWAYS.left, R = 844 - IPHONE_SIDEWAYS.right;
    if (r.brand < L) bad.push(`${route}: «Где жить» starts under the notch (x=${Math.round(r.brand)})`);
    if (r.tools > R) bad.push(`${route}: the header buttons end under the rounded corner (x=${Math.round(r.tools)})`);
    if (r.search != null && r.search < L) bad.push(`${route}: the search box starts under the notch (x=${Math.round(r.search)})`);
    if (r.h1 != null && r.h1 < L) bad.push(`${route}: the page title starts under the notch (x=${Math.round(r.h1)})`);
  }
  assert.deepEqual(bad, [], "use env(safe-area-inset-left/right) for side padding");
});

test("a map card never slides under the tab bar or the header, on small, large and sideways phones", { skip, timeout: 90000 }, async () => {
  const bad = [];
  for (const [w, h, i] of [[320, 568, { top: 20, bottom: 0, left: 0, right: 0 }], [390, 844, IPHONE], [430, 932, IPHONE], [844, 390, IPHONE_SIDEWAYS]]) {
    await page.viewport(w, h);
    await open("standard", "#/map");
    await insets(i);
    await openSheetFor("Порту");
    const s = await rect("#sheet"), nav = await rect(".bottomnav"), bar = await rect(".appbar");
    if (s.bottom > nav.top + 1) bad.push(`${w}×${h}: the card goes ${Math.round(s.bottom - nav.top)}px under the tab bar`);
    if (s.top < bar.bottom - 1) bad.push(`${w}×${h}: the card goes under the header`);
  }
  assert.deepEqual(bad, []);
});

/* ---------- ranking ---------- */

test("on a phone the places × groups table shows some scores next to long place names, not only the names", { skip }, async () => {
  await open("rich", "#/rank");
  const r = await page.eval(`(() => {
    const panel = document.getElementById("heat").parentElement, p = panel.getBoundingClientRect();
    const count = () => { const row = document.querySelector(".heat tbody tr:nth-child(3)"), name = row.querySelector("th").getBoundingClientRect(); return [...row.querySelectorAll("td.cell")].filter(c => { const r = c.getBoundingClientRect(); return r.left >= name.right - 1 && r.right <= p.right + 1; }).length; };
    const nameW = document.querySelector(".heat tbody th.rowh").getBoundingClientRect().width;
    const first = count();
    panel.scrollLeft = panel.scrollWidth;
    const end = count();
    panel.scrollLeft = 0;
    return { first, end, share: nameW / p.width };
  })()`);
  assert.ok(r.first >= 3, `only ${r.first} score cells are visible beside the names before scrolling`);
  assert.ok(r.end >= 3, `only ${r.end} score cells are visible after scrolling sideways: the sticky name column covers them`);
  assert.ok(r.share <= 0.5, `the name column takes ${Math.round(r.share * 100)}% of the table width on a phone`);
});

test("place names in «Места × группы» are never cut inside a word on 320 and 390 px phones", { skip }, async () => {
  const bad = [];
  for (const w of [320, 390]) {
    for (const dark of [false, true]) {
      await page.viewport(w, 844, { dark });
      await open("standard", "#/rank");
      const words = await page.eval(`(() => { const out = []; for (const a of document.querySelectorAll("#heat th.rowh > a")) for (const n of a.childNodes) { if (n.nodeType !== 3) continue; const re = /[^\\s\\-–—]+/g; let m; while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); out.push([m[0], new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top))).size]); } } return out; })()`);
      assert.ok(words.length >= 7, "the standard data has 7 places in the table");
      words.filter(([, lines]) => lines > 1).forEach(([word, lines]) => bad.push(`${w}px ${dark ? "dark" : "light"}: «${word}» is split over ${lines} lines`));
    }
  }
  assert.deepEqual(bad, []);
});

test("SPb's «по определению» under 3.0 fits inside the score column of the ranking on a phone", { skip }, async () => {
  for (const w of [320, 390]) {
    await page.viewport(w, 844);
    await open("standard", "#/rank");
    const r = await page.eval(`(() => { const row = [...document.querySelectorAll("#rank .row")].find(x => /Санкт-Петербург/.test(x.innerText)), s = row.querySelector(".score"), sm = s.querySelector("small"); return { text: s.innerText.replace(/\\s+/g, " "), sw: sm.scrollWidth, cw: sm.clientWidth, right: sm.getBoundingClientRect().right, col: s.getBoundingClientRect().right }; })()`);
    assert.match(r.text, /3\.0/);
    assert.ok(r.sw <= r.cw + 1, `${w}px: «${r.text}» is ${r.sw}px wide in a ${r.cw}px column`);
  }
});

test("the flags explain what «красный флаг» and «разногласие» mean before the list, not after 40 flags", { skip }, async () => {
  await open("rich", "#/rank");
  const r = await page.eval(`(() => { const f = document.querySelector("#v-rank .flags"), legend = [...f.querySelectorAll("p")].find(p => /Красный флаг —/.test(p.innerText)), first = f.querySelector(".flag"); return { n: f.querySelectorAll(".flag").length, legendTop: legend ? legend.getBoundingClientRect().top : null, firstTop: first.getBoundingClientRect().top }; })()`);
  assert.ok(r.n >= 20, "the rich data has many flags");
  assert.ok(r.legendTop != null, "the flags explain their colours");
  assert.ok(r.legendTop < r.firstTop, `the explanation comes after all ${r.n} flags instead of before them`);
});

test("flag texts line up in one column whatever the width of the flag badge", { skip }, async () => {
  await open("rich", "#/rank");
  const r = await page.eval(`(() => { const f = document.querySelector("#v-rank .flags"); return { kinds: [...new Set([...f.querySelectorAll(".flag .sev")].map(s => s.className))].length, xs: [...new Set([...f.querySelectorAll(".flag .t")].map(t => Math.round(t.getBoundingClientRect().left)))] }; })()`);
  assert.ok(r.kinds >= 2, "the rich data has two kinds of flags");
  assert.equal(r.xs.length, 1, `flag texts start at different x positions (${r.xs.join(", ")}) after «красный флаг» and «разногласие»`);
});

test("flags of one place are grouped under its name instead of repeating the long name on every line", { skip }, async () => {
  await open("rich", "#/rank");
  const r = await page.eval(`(() => { const f = document.querySelector("#v-rank .flags"); return { flags: [...f.querySelectorAll(".flag")].filter(x => x.innerText.includes(${JSON.stringify(SANTA)})).length, times: f.innerText.split(${JSON.stringify(SANTA)}).length - 1 }; })()`);
  assert.ok(r.flags >= 5 || r.times >= 1, "the place has several flags");
  assert.ok(r.times <= 1, `«${SANTA}» is repeated ${r.times} times in the flags list`);
});

test("with no places the ranking does not draw an empty 1–5 axis and points to the map to add the first place", { skip }, async () => {
  await open("empty", "#/rank");
  const axis = await page.eval(`(() => { const a = document.querySelector("#rank .rank-axis"); return !!a && a.getBoundingClientRect().height > 0 && !a.closest("[hidden]"); })()`);
  assert.equal(axis, false, "an axis «1 2 3·СПб 4 5» over no rows looks broken");
  assert.ok(await page.eval(`!!document.querySelector('#rank a[href="#/map"]')`), "the empty list says where to add a place: «Мест пока нет — добавьте первое через поиск на карте»");
});

/* ---------- places list ---------- */

test("the SPb row in the places list names it the reference point once, without «база» twice or «оценок нет»", { skip }, async () => {
  await open("standard", "#/places");
  const row = await page.eval(`[...document.querySelectorAll("#plist .prow")].find(r => /Санкт-Петербург/.test(r.innerText)).innerText.replace(/\\s+/g, " ")`);
  assert.ok((row.match(/база/g) || []).length <= 1, `«${row}» says «база» twice`);
  assert.doesNotMatch(row, /оценок нет/, `«${row}»: SPb is never rated, so «оценок нет» reads like something is missing`);
  assert.match(row, /отсч[её]т|сравнива|3\.0/i, `«${row}» does not say that SPb is what everything is compared with`);
});

test("the facts under each place in the list are visibly separated, not run together like «Португалия кандидат оценок: 2»", { skip }, async () => {
  await open("standard", "#/places");
  const r = await page.eval(`(() => { const m = [...document.querySelectorAll("#plist .prow")].find(r => /Порту/.test(r.innerText)).querySelector(".meta"); const items = [...m.children]; const has = (s, p) => { const b = getComputedStyle(s, p).content; return !!b && b !== "none" && b !== "normal" && b !== '""'; }; const sep = items.slice(1).every((s, i) => has(s, "::before") || has(items[i], "::after")); return { text: m.innerText.replace(/\\s+/g, " "), sep }; })()`);
  assert.ok(r.sep || /Португалия\s*[·•|,;]\s*кандидат\s*[·•|,;]\s*оценок/.test(r.text), `«${r.text}» has no separators between country, status and ratings`);
});

test("when a place's facts in the list wrap onto a second line, that line does not start with a «·»", { skip }, async () => {
  const bad = [];
  for (const [ds, w] of [["standard", 390], ["standard", 320], ["rich", 390]]) {
    await page.viewport(w, 844);
    await open(ds, "#/places");
    const rows = await page.eval(`[...document.querySelectorAll("#plist .prow .meta")].map(m => { const items = [...m.children], tops = items.map(s => Math.round(s.getBoundingClientRect().top)); const dot = (s, p) => /[·•|]/.test(getComputedStyle(s, p).content || ""); return { name: m.closest(".prow").querySelector("b")?.innerText || "", lines: new Set(tops).size, lead: items.filter((s, i) => i > 0 && tops[i] > tops[i - 1] && dot(s, "::before")).map(s => s.innerText), seps: items.slice(1).filter((s, i) => dot(s, "::before") || dot(items[i], "::after")).length, n: items.length }; })`);
    assert.ok(rows.some(r => r.lines > 1), `${ds} ${w}px: no place's facts wrap, the check proves nothing`);
    rows.forEach(r => {
      if (r.lead.length) bad.push(`${ds} ${w}px ${r.name}: a line starts with «· ${r.lead[0]}»`);
      if (r.seps < r.n - 1) bad.push(`${ds} ${w}px ${r.name}: ${r.n} facts but only ${r.seps} separators`);
    });
  }
  assert.deepEqual(bad, []);
});

test("a cell of «Места × группы» that reads 3.0 is coloured exactly like 3 (as on pins and in the list), not tinted red or blue", { skip }, async () => {
  await open("rich", "#/rank");
  const r = await page.eval(`(async () => {
    const u = await import("./js/util.js");
    const mid = u.heatHex(3), tints = [2.951, 2.96, 2.99, 3.01, 3.04, 3.049].filter(v => u.heatHex(v) !== mid).map(v => v + " → " + u.heatHex(v));
    const edge = [2.94, 3.05].filter(v => u.heatHex(v) === mid);
    const cells = [...document.querySelectorAll("#heat td.cell")].filter(c => c.innerText.trim() === "3.0").map(c => getComputedStyle(c).backgroundColor);
    const probe = document.createElement("i"); probe.style.color = mid; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove();
    return { tints, edge, cells: cells.length, off: [...new Set(cells.filter(c => c !== want))], want };
  })()`);
  assert.deepEqual(r.tints, [], "values that are shown as 3.0 get a red or blue tint");
  assert.deepEqual(r.edge, [], "2.9 and 3.1 must still be coloured");
  assert.ok(r.cells > 0, "the rich data shows some 3.0 cells (SPb row at least)");
  assert.deepEqual(r.off, [], `cells reading 3.0 are not the neutral ${r.want}`);
});

test("a long places list shows its status groups with headings: finalists, candidates, dropped", { skip }, async () => {
  await open("rich", "#/places");
  const r = await page.eval(`(() => {
    const list = document.getElementById("plist"), kids = [...list.children];
    const heads = kids.filter(k => !k.classList.contains("prow")).map(k => k.innerText.trim());
    const firstOf = st => kids.findIndex(k => k.classList.contains("prow") && k.querySelector(".meta").innerText.includes(st));
    const headBefore = (re, st) => kids.slice(0, firstOf(st)).some(k => !k.classList.contains("prow") && re.test(k.innerText));
    return { heads, fin: headBefore(/финалист/i, "финалист"), out: headBefore(/отсев/i, "отсев"), cand: headBefore(/кандидат/i, "кандидат") };
  })()`);
  assert.ok(r.fin && r.cand && r.out, `30 places are sorted by status with no headings, so the order looks random (headings: ${JSON.stringify(r.heads)})`);
});

test("with no places yet the places screen does not offer a filter over an empty list", { skip }, async () => {
  await open("empty", "#/places");
  assert.match(await page.text("#plist"), /Мест пока нет/);
  const filter = await page.eval(`(() => { const f = document.getElementById("placeFilter"); return !!f && !f.disabled && !f.closest("[hidden]") && f.getBoundingClientRect().height > 0; })()`);
  assert.equal(filter, false, "«Фильтр по названию или стране» above «Мест пока нет» suggests there is something to filter");
});

test("chips never stick out of their row or card on a 320 px phone with 60-character names", { skip, timeout: 60000 }, async () => {
  await page.viewport(320, 568);
  const bad = [];
  const CHIPS = `(() => { const out = []; const roots = [document.querySelector(".view:not([hidden])"), document.getElementById("sheet")].filter(r => r && !r.hidden); for (const root of roots) for (const c of root.querySelectorAll(".chip, .sev, .badge")) { if (c.closest("[hidden], .scroll") || !c.getBoundingClientRect().width) continue; const box = c.parentElement.closest(".row, .prow, .trip, .flag, .place-head, .sheet-body, .panel, .fact"); if (!box) continue; const r = c.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.right > b.right + 1 || r.left < b.left - 1) out.push("«" + c.innerText.slice(0, 30) + "» " + Math.round(r.right) + " > " + Math.round(b.right)); } return out; })()`;
  await open("rich", "#/rank");
  for (const route of ROUTES.rich) { await go(route); (await page.eval(CHIPS)).forEach(x => bad.push(route + ": " + x)); }
  await go("#/map");
  await openSheetFor("Санта");
  (await page.eval(CHIPS)).forEach(x => bad.push("place card: " + x));
  assert.deepEqual(bad, []);
});

/* ---------- dossier ---------- */

test("in a dossier's subcategory table water hardness is not marked with a euro sign", { skip }, async () => {
  await open("rich", "#/place/pl-01");
  const row = await page.eval(`[...document.querySelectorAll(".subtable tbody tr")].find(r => /Жёсткость воды/.test(r.innerText))?.innerText.replace(/\\s+/g, " ")`);
  assert.ok(row, "the water hardness row is shown");
  assert.doesNotMatch(row, /€/, `«${row}»: water hardness is ppm, not euros`);
});

test("the note under the subcategory table explains the mark on scores that come from the place's numbers", { skip }, async () => {
  await open("rich", "#/place/pl-01");
  const r = await page.eval(`(() => { const t = document.querySelector(".subtable"); const marked = [...t.querySelectorAll("td.n .c")].filter(c => !/^[ABCD]$/.test(c.innerText.trim())).length; const note = [...t.closest(".block").querySelectorAll("p")].map(p => p.innerText).join(" "); return { marked, note }; })()`);
  assert.ok(r.marked >= 4, "scores from place numbers carry a mark");
  assert.match(r.note, /цифр\S* места/i, `«4.0€» next to rent reads like a price of 4 euros; the note only explains A/C/D: «${r.note}»`);
});

test("on a phone the subcategory table shows its flags and group notes without scrolling sideways", { skip }, async () => {
  await open("rich", "#/place/pl-01");
  const r = await page.eval(`(() => { const panel = document.querySelector(".subtable").closest(".panel"), p = panel.getBoundingClientRect(); const flags = [...panel.querySelectorAll(".sev")]; const hidden = flags.filter(f => f.getBoundingClientRect().right > p.right + 1).length; const notes = [...panel.querySelectorAll("tr.grp td")].filter(td => td.getBoundingClientRect().right > p.right + 1).length; return { flags: flags.length, hidden, notes, sw: panel.scrollWidth, cw: panel.clientWidth }; })()`);
  assert.ok(r.flags >= 5, "the place has flagged subcategories");
  assert.equal(r.hidden, 0, `${r.hidden} of ${r.flags} red-flag marks sit off-screen in the «Флаг» column (table ${r.sw}px in a ${r.cw}px card)`);
  assert.equal(r.notes, 0, "group notes like «шкала абсолютная: 5 — как у гражданина…» are cut at the card edge");
});

/* ---------- map ---------- */

test("after «Похожие» on a place card the similar places come into view", { skip }, async () => {
  for (const [ds, q] of [["standard", "Порту"], ["rich", "Санта"]]) {
    await open(ds, "#/map");
    await openSheetFor(q);
    await page.tap({ sel: "#sheetBody button", text: "Похожие" });
    await page.waitFor(`!!document.querySelector("#simPlaceBox .sim-row")`, 6000, "similar places");
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) { ok = inside(await rect("#simPlaceBox .sim-row"), await rect("#sheetBody")); if (!ok) await sleep(100); }
    assert.ok(ok, `${ds}: the similar places appear below the fold of the card; nothing visible changes after the tap`);
  }
});

test("on small and sideways phones a place card's «Досье» and «Оценить» are reachable without scrolling inside the card", { skip }, async () => {
  const bad = [];
  for (const [w, h] of [[320, 568], [360, 640], [844, 390]]) {
    await page.viewport(w, h);
    await open("standard", "#/map");
    await openSheetFor("Порту");
    const btn = await page.eval(`(() => { const b = [...document.querySelectorAll("#sheetBody a.btn")].find(a => a.innerText.trim() === "Досье"); const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`);
    if (!inside(btn, await rect("#sheetBody"))) bad.push(`${w}×${h}: «Досье» is below the visible part of the card`);
  }
  assert.deepEqual(bad, []);
});

test("on a small or sideways phone the first-visit card shows its «Понятно» button without scrolling", { skip }, async () => {
  const bad = [];
  for (const [w, h] of [[320, 568], [844, 390]]) {
    await page.viewport(w, h);
    await open("standard", "#/map", { intro: true });
    const b = await rect('#sheetBody [data-act="introok"]');
    if (!b || !inside(b, await rect("#sheetBody"))) bad.push(`${w}×${h}: «Понятно» is hidden below the card's fold`);
  }
  assert.deepEqual(bad, []);
});

test("the «similar» button looks the same on place, city and country cards", { skip }, async () => {
  await open("standard", "#/map");
  await openSheetFor("Порту");
  const placeCls = await page.eval(`[...document.querySelectorAll("#sheetBody button")].find(b => b.innerText.trim() === "Похожие").className`);
  await page.tap({ sel: "#sheetBody button", text: "Похожие" });
  await page.waitFor(`!!document.querySelector("#simPlaceBox [data-city]")`, 6000, "similar cities");
  await page.eval(`document.querySelector("#simPlaceBox [data-city]").click()`);
  await page.waitFor(`[...document.querySelectorAll("#sheetBody button")].some(b => b.innerText.trim() === "Похожие города")`, 4000, "city card");
  const cityCls = await page.eval(`[...document.querySelectorAll("#sheetBody button")].find(b => b.innerText.trim() === "Похожие города").className`);
  await page.eval(`document.getElementById("sheetClose").click(); document.getElementById("searchInput").value = ""`);
  await openSheetFor("Португалия");
  const countryCls = await page.eval(`[...document.querySelectorAll("#sheetBody button")].find(b => b.innerText.trim() === "Похожие страны")?.className`);
  assert.equal(cityCls, placeCls, "«Похожие города» and «Похожие» use the same style");
  assert.equal(countryCls, placeCls, `«Похожие страны» is «${countryCls}» while «Похожие» on a place is «${placeCls}»`);
});

test("in dark mode the hover label of a world city is dark too, not a white box", { skip }, async () => {
  await page.viewport(1280, 800, { dark: true });
  await open("standard", "#/map", { local: { "wtl:layers": { country: "", mode: "rel", city: "t_jul", places: true, visited: true } } });
  await page.waitFor(`(async () => { const { state } = await import("./js/app.js"); let n = 0; state.mapView.cityLayer.eachLayer(() => n++); return n > 50; })()`, 10000, "world cities on the map");
  const r = await page.eval(`(async () => { ${COLOR_FNS} const { state } = await import("./js/app.js"); let el = null; state.mapView.cityLayer.eachLayer(l => { if (!el) { l.openTooltip(); el = l.getTooltip().getElement(); } }); const bg = over(rgba(getComputedStyle(el).backgroundColor), [0, 0, 0, 1]); const fg = over(rgba(getComputedStyle(el).color), bg); return { text: el.innerText, bgLum: Math.round(lum(bg) * 100) / 100, r: ratio(fg, bg) }; })()`);
  assert.ok(r.r >= 4.5, `«${r.text}» contrast ${r.r}:1`);
  assert.ok(r.bgLum < 0.3, `«${r.text}» shows on a white label (luminance ${r.bgLum}) over the dark map`);
});

test("in dark mode every world city dot stands out from the dark map (fill or outline at least 3:1)", { skip }, async () => {
  await page.viewport(1280, 800, { dark: true });
  await open("standard", "#/map", { local: { "wtl:layers": { country: "", mode: "rel", city: "t_jul", places: true, visited: true } } });
  await page.waitFor(`(async () => { const { state } = await import("./js/app.js"); let n = 0; state.mapView.cityLayer.eachLayer(() => n++); return n > 50; })()`, 10000, "world cities on the map");
  const r = await page.eval(`(async () => { ${COLOR_FNS} const { state } = await import("./js/app.js"); const map = bgOf(document.getElementById("map")); let n = 0; const low = new Set(); state.mapView.cityLayer.eachLayer(l => { n++; const o = l.options, fill = over(rgba(o.fillColor).slice(0, 3).concat(o.fillOpacity), map), stroke = over(rgba(o.color), map); const best = Math.max(ratio(fill, map), o.weight >= 0.8 ? ratio(stroke, map) : 1); if (best < 3) low.add(o.fillColor + " " + best + ":1"); }); return { n, low: [...low] }; })()`);
  assert.ok(r.n > 50);
  assert.deepEqual(r.low, [], "the darkest city colours vanish into the dark map; give them a light outline in dark mode");
});

test("place labels on the map are capped in width so a 60-character name does not run across the whole phone", { skip }, async () => {
  await open("rich", "#/map", { local: { "wtl:view": { c: { lat: 42.5, lng: 19.5 }, z: 7 } } });
  await page.waitFor(`[...document.querySelectorAll(".pin-label")].some(t => getComputedStyle(t).opacity !== "0")`, 4000, "labels shown");
  const widths = await page.eval(`[...document.querySelectorAll(".pin-label")].filter(t => getComputedStyle(t).opacity !== "0").map(t => ({ w: Math.round(t.getBoundingClientRect().width), name: t.innerText.slice(0, 30) }))`);
  const wide = widths.filter(x => x.w > 220);
  assert.deepEqual(wide.map(x => `${x.name}… ${x.w}px`), [], "long labels cover neighbouring pins; cut them with an ellipsis");
});

test("with «Слои» open the map legend is not half-covered by the panel", { skip }, async () => {
  await open("standard", "#/map");
  await page.tap({ sel: "#layersBtn" });
  await page.select("#lyCountry", "Уровень цен");
  await page.waitFor(`!document.getElementById("legendBox").hidden`, 3000, "legend");
  const r = await page.eval(`(() => { const a = document.getElementById("layersPanel").getBoundingClientRect(), b = document.getElementById("legendBox").getBoundingClientRect(); const legendShown = !document.getElementById("legendBox").hidden && b.height > 0; const ov = legendShown ? Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) : 0; return { ov: Math.round(ov), legend: Math.round(b.width * b.height) }; })()`);
  assert.equal(r.ov, 0, `the panel covers ${Math.round(r.ov / r.legend * 100)}% of the legend, leaving cut words like «Уро…»`);
});

test("in dark mode the map tiles are dimmed and inverted, and in light mode they are not", { skip }, async () => {
  for (const dark of [false, true]) {
    await page.viewport(390, 844, { dark });
    await open("standard", "#/map");
    const f = await page.eval(`getComputedStyle(document.querySelector(".basemap")).filter`);
    if (dark) assert.match(f, /invert\(1\)/, "dark tiles"); else assert.doesNotMatch(f, /invert/, "light tiles");
    assert.match(f, /grayscale/);
  }
});

test("the toast appears below the header and fully on screen, on a notched iPhone and on a desktop", { skip }, async () => {
  for (const [w, h, i] of [[390, 844, IPHONE], [1280, 800, null]]) {
    await page.viewport(w, h);
    await open("standard", "#/rank");
    if (i) await insets(i);
    await page.tap({ sel: "#themeBtn" });
    await page.waitFor(`!document.getElementById("toast").hidden`, 2000, "toast");
    const t = await rect("#toast"), bar = await rect(".appbar");
    assert.ok(t.top >= bar.bottom, `${w}px: the toast overlaps the header`);
    assert.ok(t.left >= 0 && t.right <= w, `${w}px: the toast sticks out of the screen`);
  }
});

/* ---------- rating form ---------- */

test("on a computer the rating form's choice buttons are compact pills, not grey bars across the whole card", { skip }, async () => {
  await page.viewport(1280, 800);
  await open("standard", "#/rate");
  const bad = [];
  for (const [route, ids] of [["#/rate", ["fWho"]], ["#/settings", ["meSeg", "themeSeg"]]]) {
    await go(route);
    const r = await page.eval(`${JSON.stringify(ids)}.map(id => { const s = document.getElementById(id), bs = [...s.querySelectorAll("button")]; const need = bs.reduce((a, b) => a + b.getBoundingClientRect().width, 0) + 4 * bs.length + 8; return { id, w: Math.round(s.getBoundingClientRect().width), need: Math.round(need) }; })`);
    r.filter(x => x.w > x.need + 24).forEach(x => bad.push(`${route} #${x.id}: ${x.w}px wide for ${x.need}px of buttons`));
  }
  assert.deepEqual(bad, [], "the same control is compact in «Рейтинг» but stretched here");
});

test("the rating form's title sits as close to its first card as other screens' titles", { skip }, async () => {
  await open("standard", "#/settings");
  const gap = async (first) => page.eval(`(() => { const v = document.querySelector(".view:not([hidden])"), h = v.querySelector("h1").getBoundingClientRect(), n = v.querySelector(${JSON.stringify(first)}).getBoundingClientRect(); return Math.round(n.top - h.bottom); })()`);
  const settings = await gap("section.block");
  await go("#/rate");
  const rate = await gap(".fcard");
  assert.ok(rate <= settings + 4, `empty placeholders above the first card add ${rate - settings}px: ${rate}px under «Оценить поездку» vs ${settings}px in settings`);
});

test("when saving without a place, the «Место» field it jumps to is fully visible between the header and the save bar", { skip }, async () => {
  await open("standard", "#/rate");
  await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`);
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`/Выберите место/.test(document.getElementById("fMsg").innerText)`, 3000, "error");
  await sleep(300);
  const f = await rect("#fPlace"), bar = await rect(".appbar"), save = await rect(".savebar");
  assert.ok(f.top >= bar.bottom && f.bottom <= save.top, `the field is at ${Math.round(f.top)}–${Math.round(f.bottom)}, header ends at ${bar.bottom}, save bar starts at ${Math.round(save.top)}`);
});

test("on a phone turned sideways the rating form leaves at least half of the screen for the questions", { skip }, async () => {
  await page.viewport(844, 390);
  await open("standard", "#/rate");
  await insets(IPHONE_SIDEWAYS);
  await sleep(250);
  const r = await page.eval(`(() => { const bar = document.querySelector(".appbar").getBoundingClientRect(), save = document.querySelector(".savebar").getBoundingClientRect(), nav = document.querySelector(".bottomnav").getBoundingClientRect(); return { free: Math.round(save.top - bar.bottom), h: innerHeight, nav: Math.round(nav.height), save: Math.round(save.height) }; })()`);
  assert.ok(r.free >= r.h / 2, `only ${r.free}px of ${r.h}px are left between the header, the save bar (${r.save}px) and the tab bar (${r.nav}px)`);
});

/* ---------- settings ---------- */

test("settings name the copy and refresh buttons in plain words, without «JSON» or «GitHub»", { skip }, async () => {
  await open("standard", "#/settings");
  const r = await page.eval(`({ exp: document.getElementById("exportBtn").innerText.trim(), ref: document.getElementById("refreshBtn").innerText.trim() })`);
  assert.doesNotMatch(r.exp, /JSON/i, `«${r.exp}» is a technical label`);
  assert.match(r.exp, /скача|сохран/i);
  assert.doesNotMatch(r.ref, /GitHub/i, `«${r.ref}» is a technical label`);
  assert.match(r.ref, /обнов|загруз/i);
});

test("the world-data switch in settings says what it includes instead of pointing to a «Данные» column a newcomer has not seen", { skip }, async () => {
  await open("standard", "#/settings");
  const label = await page.eval(`document.getElementById("useData").closest("label").innerText.trim()`);
  assert.doesNotMatch(label, /колонк/i, `«${label}»`);
  assert.match(label, /стран/i, `«${label}» should name country indicators`);
  assert.match(label, /климат/i, `«${label}» should name city climate`);
});

test("tapping the refresh button at the bottom of settings on a phone shows what happened where I am looking", { skip }, async () => {
  await open("standard", "#/settings");
  await page.tap({ sel: "#refreshBtn" }, 50);
  let seen = "";
  for (let i = 0; i < 40 && !seen; i++) {
    seen = await page.eval(`(() => { const t = document.getElementById("toast"); if (!t.hidden && /обнов|загруж|актуал|нов/i.test(t.innerText)) return "toast: " + t.innerText; const b = document.getElementById("refreshBtn"); if (/обновляю|загружаю|…/i.test(b.innerText)) return "button: " + b.innerText; const box = b.closest(".panel"); const m = [...box.querySelectorAll(".msg, [role=status]")].find(x => x.innerText.trim()); if (m) return "message: " + m.innerText; return ""; })()`);
    if (!seen) await sleep(100);
  }
  assert.ok(seen, "after the tap only the tiny header status flickers; the result is written in the key section far above, off-screen");
});
