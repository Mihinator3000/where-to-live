// Persona «свежий взгляд»: a friend of Вика who has never seen the app and is not technical is asked to help rate.
// She reads every sentence on every screen of an iPhone (390×844) and asks: what is this screen for, what do I tap next,
// what does this word mean, did my tap do anything. The goal is clear AND short: explain jargon where it first appears,
// say the same thing with the same words on every screen, and keep opening paragraphs short enough to read on a phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, settleMap } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- synthetic data: a couple after a dozen scouting trips ---------- */
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-06-01", end: "2026-06-21", days: 21, season: "пик", mode: "удалёнка", housing: "жилой район", retro: false, year: 7, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);
const st = arr => Object.fromEntries(STAR.map((k, i) => [k, arr[i]]).filter(([, v]) => v != null));

const PLACES = [
  place("sankt-peterburg", "Санкт-Петербург", "Россия", "RUS", 59.93863, 30.31413, { status: "база", archetype: "мегаполис", facts: { basket: { v: 60, src: "Перекрёсток", at: "2026-09-01" } } }),
  place("porto", "Порту", "Португалия", "PRT", 41.14961, -8.61099, { status: "финалист", archetype: "город у моря", questions: "Проверить сырость зимой", facts: { rent: { v: 1100, src: "idealista", at: "2026-09-10" }, dinner: { v: 40, src: "3 ужина", at: "2026-09-10" }, basket: { v: 55, src: "Pingo Doce", at: "2026-09-10" } } }),
  place("valensiya", "Валенсия", "Испания", "ESP", 39.46975, -0.37739, { archetype: "город у моря", facts: { rent: { v: 1300, src: "idealista", at: "2026-09-10" }, tds: { v: 420, src: "TDS-метр", at: "2026-09-10" } } }),
  place("tbilisi", "Тбилиси", "Грузия", "GEO", 41.69411, 44.83368, { archetype: "мегаполис" }),
  place("batumi", "Батуми", "Грузия", "GEO", 41.64228, 41.63392, { archetype: "город у моря" }),
  place("belgrad", "Белград", "Сербия", "SRB", 44.80401, 20.46513, { archetype: "мегаполис", status: "отсев", reason: "Смог зимой и далеко от моря" }),
  place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { archetype: "курорт" }),
  place("herceg-novi", "Херцег-Нови", "Черногория", "MNE", 42.4531, 18.5375, { archetype: "малый курорт", facts: { rent: { v: 700, src: "realitica", at: "2026-09-01" }, dinner: { v: 30, src: "4 ужина", at: "2026-09-01" } } }),
  place("antalya", "Анталья", "Турция", "TUR", 36.8969, 30.7133, { archetype: "курорт" }),
  place("limassol", "Лимасол", "Кипр", "CYP", 34.6786, 33.0413, { archetype: "город у моря" }),
  place("kotor", "Котор", "Черногория", "MNE", 42.4247, 18.7712, { archetype: "малый курорт" }),
];

const RATINGS = [
  rating("p-m", "porto", "Михаил", Object.assign(st([4, 3.5, 4, 3, 4, 4.5, 3.5, 5, 4, 2]), { "продукты": 3.5, "кафе": 4.5, "климат": 3.5 }), { year: 8, review: "Красиво, океан, но сыро в квартирах.", start: "2026-03-01", end: "2026-03-28", days: 28, season: "межсезон", conf: { "интернет": "A" }, notes: { city: "Много холмов" } }),
  rating("p-v", "porto", "Вика", Object.assign(st([4, 3, 4.5, 2.5, 3.5, 4, 4, 4.5, 4, 4]), { "продукты": 3, "кафе": 4, "климат": 3 }), { year: 7, review: "Холмы тяжело, но люди милые.", start: "2026-03-01", end: "2026-03-28", days: 28, season: "межсезон" }),
  rating("v-m", "valensiya", "Михаил", Object.assign(st([4.5, 3, 4, 3.5, 3, 4, 3.5, 4, 5, 3]), { "климат": 4.5 }), { year: 8, review: "Пляж в черте города, велодорожки." }),
  rating("v-v", "valensiya", "Вика", Object.assign(st([4, 2, 4, 3.5, 2.5, 4, 3, 4, 5, 3]), { "климат": 4 }), { year: 7, review: "Кожа шелушится от воды." }),
  rating("t-m", "tbilisi", "Михаил", st([4, 3, 3.5, 2.5, 2.5, 3.5, 2, 3.5, 1, 3.5]), { year: 5, start: "2026-04-10", end: "2026-04-30", days: 20, season: "межсезон" }),
  rating("t-v", "tbilisi", "Вика", st([3.5, 3, 3, 2, 2, 3, 1.5, 3, 1, 3]), { year: 4, review: "Пыльно и шумно.", start: "2026-04-10", end: "2026-04-30", days: 20, season: "межсезон" }),
  rating("b-m", "batumi", "Михаил", st([4, 3, 3.5, 2.5, 3, 3.5, 3, 3, 3.5, 3.5]), { year: 5, start: "2026-05-01", end: "2026-05-14", days: 14 }),
  rating("b-v", "batumi", "Вика", st([3.5, 1.5, 3, 2, 3, 3, 3, 3, 3.5, 3]), { year: 2, veto: "Плесень в каждой квартире, кожа не выдержит", start: "2026-05-01", end: "2026-05-14", days: 14 }),
  rating("bg-m", "belgrad", "Михаил", st([4, 3, 3.5, 3, 3, 4, 3, 3.5, null, 4]), { year: 4, start: "2025-12-01", end: "2025-12-15", days: 15, season: "худший", retro: true }),
  rating("bg-v", "belgrad", "Вика", st([4, 2.5, 3.5, 3, 3, 4, 3, 3, null, 4]), { year: 3, start: "2025-12-01", end: "2025-12-15", days: 15, season: "худший", retro: true }),
  rating("bu-v", "budva", "Вика", st([3, 4, 4, 3, 2, 4, 3, 4, 4.5, 4]), { year: 6, review: "Летом толпы, зимой пусто.", start: "2026-07-01", end: "2026-07-20", days: 20 }),
  rating("hn-m1", "herceg-novi", "Михаил", st([3.5, 4, 4.5, 3, 4, 4, 3.5, 4.5, 4.5, 4]), { year: 8, review: "Тихо, лестницы, море рядом.", start: "2026-08-01", end: "2026-08-25", days: 25 }),
  rating("hn-v", "herceg-novi", "Вика", st([3.5, 4.5, 4.5, 3.5, 4, 4, 4, 5, 4.5, 4]), { year: 9, review: "Лучшее для кожи.", start: "2026-08-01", end: "2026-08-25", days: 25 }),
  rating("hn-m2", "herceg-novi", "Михаил", st([3, 4, 4.5, 2.5, 4.5, 3.5, 3.5, 4, null, 4]), { year: 7, review: "Зимой половина кафе закрыта.", start: "2026-01-10", end: "2026-01-31", days: 21, season: "худший" }),
  rating("an-v", "antalya", "Вика", st([4, 3, 4, 3, 3, 3, 3.5, 3, 4.5, 2.5]), { year: 5, start: "2026-09-01", end: "2026-09-14", days: 14 }),
  rating("ko-m", "kotor", "Михаил", st([3.5, 3, null, null, null, null, null, 4, null, null]), { year: 6, start: "2026-08-26", end: "2026-08-28", days: 3 }),
];

const W0 = { legal: 0, money: 0, work: 0, health: 0, safety: 0, climate: 0, housing: 0, city: 0, nature: 0, people: 0, links: 0 };
const WEIGHTS = [
  { id: "mikhail", who: "Михаил", w: { ...W0, legal: 15, money: 10, work: 25, health: 5, safety: 5, climate: 5, housing: 10, city: 15, nature: 5, people: 3, links: 2 } },
  { id: "vika", who: "Вика", w: { ...W0, legal: 10, money: 5, work: 5, health: 25, safety: 10, climate: 10, housing: 10, city: 5, nature: 15, people: 3, links: 2 } },
];
const FILES = repo({ places: PLACES, ratings: RATINGS, weights: WEIGHTS });

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `import("./js/app.js").then(m => m.state)`;
const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
const NOT_LETTER = "(?:^|[^а-яёa-z])";

async function open({ w = 390, h = 844, dark = false, hash = "#/map", files = FILES, ...o } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, Object.assign({ hash, files }, o));
  await page.waitFor(`${APP}.then(s => !!s.world.cities)`, 8000, "city data loaded");
  if (hash.startsWith("#/map")) await page.waitFor(`${APP}.then(s => !!s.mapView)`, 8000, "map ready");
  const loaded = o.token !== false && files;
  if (hash.startsWith("#/rank")) await page.waitFor(loaded ? `document.querySelectorAll("#rank a.row").length > 3` : `!!document.getElementById("rank")`, 5000, "ranking rows");
  if (hash.startsWith("#/places")) await page.waitFor(loaded ? `document.querySelectorAll("#plist a.prow").length > 3` : `!!document.getElementById("plist")`, 5000, "places rows");
  if (hash.startsWith("#/place/")) await dossierReady();
  if (hash.startsWith("#/rate")) await page.waitFor(`document.getElementById("fPlace") && document.getElementById("fPlace").options.length > 3`, 5000, "rating form");
  await sleep(200);
  page.takeErrors();
}

const dossierReady = () => page.waitFor(`document.querySelector("#v-place h1") && !/Считаю/.test((document.getElementById("simBox") || {}).innerText || "")`, 8000, "dossier ready");

async function goto(hash) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(300);
  if (hash.startsWith("#/place/")) await dossierReady();
  if (hash.startsWith("#/rank")) await page.waitFor(`document.querySelectorAll("#rank a.row").length > 3`, 5000, "ranking rows");
}

// Opens a map card the way a user does: type in the search box and tap the suggestion.
async function card(name, query = name) {
  await page.tap({ sel: "#searchInput" });
  await page.fill("#searchInput", query);
  await page.waitFor(`!document.getElementById("searchResults").hidden && document.querySelectorAll("#searchResults button").length > 0`, 4000, "search suggestions for " + query);
  await page.tap({ within: "#searchResults", text: name });
  await page.waitFor(`!document.getElementById("sheet").hidden && (document.getElementById("sheetTitle") || {}).innerText === ${JSON.stringify(name)}`, 5000, "card " + name);
  await sleep(250);
}

const openAllDetails = sel => page.eval(`document.querySelectorAll(${JSON.stringify(sel + " details")}).forEach(d => { d.open = true; })`);

// Number of rendered text lines of each matching visible element, with where it sits on the screen.
const LINES = `(els => els.filter(e => { if (e.closest("[hidden]")) return false; const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; for (let d = e.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) if (!d.open && !e.closest("summary")) return false; return true; }).map(e => { const cs = getComputedStyle(e); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3; const r = e.getBoundingClientRect(); return { text: e.innerText.replace(/\\s+/g, " ").trim(), lines: Math.round(r.height / lh), top: Math.round(r.top), bottom: Math.round(r.bottom) }; }))`;
const lines = sel => page.eval(`${LINES}([...document.querySelectorAll(${JSON.stringify(sel)})])`);
const navTop = () => page.eval(`(() => { const n = document.querySelector(".bottomnav"); const r = n && n.getBoundingClientRect(); return r && r.height ? r.top : innerHeight; })()`);
const show = list => list.map(x => `${x.lines} lines: «${x.text.slice(0, 90)}…»`).join("\n");

// What a phone user gets by tapping the word `needle` inside `scope`: the app's #tip bubble, if the word sits in a [data-tip]
// element outside a link. A `title` tooltip does not count — a phone never shows it.
async function tipOnTap(scope, needle) {
  const found = await page.eval(`(() => {
    const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) if (!d.open && !e.closest("summary")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const has = e => (e.textContent || "").includes(${JSON.stringify(needle)});
    const els = [...document.querySelectorAll(${JSON.stringify(scope)} + " *")].filter(e => vis(e) && has(e) && ![...e.children].some(has));
    const t = els.map(e => e.closest("[data-tip]")).find(x => x && !x.closest("a[href]"));
    document.querySelectorAll("[data-c3tip]").forEach(x => x.removeAttribute("data-c3tip"));
    if (!t) return false;
    t.setAttribute("data-c3tip", "1");
    return true;
  })()`);
  if (!found) return "";
  await page.tap({ sel: "[data-c3tip]" }, 150);
  return page.eval(`document.getElementById("tip").hidden ? "" : document.getElementById("tip").innerText`);
}

/* ======================= map ======================= */

test("after «Понятно» the map keeps a visible way to reopen its help, on a phone and on a computer in dark mode", { skip }, async () => {
  for (const [w, h, dark] of [[390, 844, false], [1280, 800, true]]) {
    await open({ w, h, dark, intro: true });
    await page.waitFor(`!document.getElementById("sheet").hidden`, 4000, "first-visit help");
    await page.tap({ text: "Понятно" });
    await page.waitFor(`document.getElementById("sheet").hidden`, 3000, "help closed");
    const help = await page.eval(`(() => {
      const ok = e => { if (e.closest("[hidden], #sheet, #layersPanel, .leaflet-marker-pane, .leaflet-control-attribution")) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; };
      const b = [...document.querySelectorAll("#v-map button, #v-map a, #v-map [role=button]")].filter(ok).find(e => /как пользоваться|справк|помощь|подсказ|^\\?$|что здесь/i.test([e.innerText, e.getAttribute("aria-label"), e.title].filter(Boolean).join(" ").trim()));
      return b ? (b.id ? "#" + b.id : "") : null;
    })()`);
    assert.ok(help !== null, `${w}px: once the first-visit help is closed, the map shows only «Найти город или место» and «Слои»; what the circles, the numbers and the hollow and pale pins mean can only be found again under Настройки → «Как пользоваться картой»`);
    await page.eval(`(() => { const b = [...document.querySelectorAll("#v-map button, #v-map a, #v-map [role=button]")].find(e => !e.closest("#sheet, #layersPanel") && /как пользоваться|справк|помощь|подсказ|^\\?$|что здесь/i.test([e.innerText, e.getAttribute("aria-label"), e.title].filter(Boolean).join(" ").trim())); b.click(); })()`);
    await page.waitFor(`!document.getElementById("sheet").hidden`, 3000, "help reopened");
    assert.match(oneLine(await page.text("#sheetBody")), /Кружк[^.]{0,80}(наш|мест)/, "the reopened help explains the pins");
    assert.match(await page.eval("location.hash"), /#\/map/, "the help opens on the map, not in settings");
  }
});

test("on Вика's phone the first-visit help does not speak about Вика in the third person («мы с Викой»)", { skip }, async () => {
  await open({ me: "Вика", intro: true });
  await page.waitFor(`!document.getElementById("sheet").hidden`, 4000, "first-visit help");
  const t = oneLine(await page.text("#sheetBody"));
  assert.match(t, /выбира/, "precondition: the help says what the app is for");
  assert.doesNotMatch(t, /с Викой/, `Вика (or her friend on her phone) reads «Здесь мы с Викой выбираем, где жить» — written as if Михаил is always the reader: «${t.slice(0, 120)}»`);
});

test("the SPb card on the map says in words what «база» means instead of «база» twice", { skip }, async () => {
  await open();
  await card("Санкт-Петербург", "Санкт");
  const t = oneLine(await page.text("#sheetBody")) + " " + await tipOnTap("#sheetBody", "база");
  assert.match(t, /база/, "precondition: the card calls SPb «база»");
  assert.match(t, /(точк\S* отсчёта|сравнива|относительно|эталон|с ним|мерк)/i, `a newcomer sees «база» as a chip and again under 3.0, with no word on what it means: «${t}»`);
});

test("a map card that counts answers on ★ says the ★ are the main questions", { skip }, async () => {
  await open();
  await card("Котор");
  const t = oneLine(await page.text("#sheetBody")) + " " + await tipOnTap("#sheetBody", "★");
  assert.match(t, /★/, "precondition: Котор's card counts answers on ★");
  assert.match(t, /главн\S* вопрос/i, `«своих ответов на ★: 3 из 10» — nothing on the card says what ★ is: «${t}»`);
});

test("a country found by search does not offer «Добавить город в этой точке» for a point hidden under its card or outside the country", { skip }, async () => {
  await open();
  await card("Испания");
  await settleMap(page);
  const has = await page.eval(`[...document.querySelectorAll("#sheetBody button")].some(b => /в этой точке/.test(b.innerText) && b.offsetParent)`);
  if (!has) return;
  const r = await page.eval(`${APP}.then(s => {
    const mv = s.mapView, t = mv.temp;
    if (!t) return { none: true };
    const ll = t.getLatLng(), p = mv.map.latLngToContainerPoint(ll), mr = document.getElementById("map").getBoundingClientRect();
    const f = s.world.geo.features.find(x => x.properties.iso3 === "ESP");
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const inside = polys.some(poly => inRing(poly[0], ll.lng, ll.lat) && !poly.slice(1).some(h => inRing(h, ll.lng, ll.lat)));
    return { lat: ll.lat, lon: ll.lng, y: Math.round(p.y + mr.top), sheetTop: Math.round(document.getElementById("sheet").getBoundingClientRect().top), searchBottom: Math.round(document.querySelector(".map-top").getBoundingClientRect().bottom), inside };
  })`);
  assert.ok(!r.none, "the card offers «в этой точке» but no point is marked on the map at all");
  assert.ok(r.y > r.searchBottom && r.y < r.sheetTop - 8, `«Добавить город в этой точке»: the point (${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}) is drawn at y=${r.y}, under the card that starts at y=${r.sheetTop} — the user cannot see which point is meant`);
  assert.ok(r.inside, `the point (${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}) is the middle of Spain's bounding box with the Canary Islands, which is not in Spain — a city added «here» would be in the sea or in Morocco`);
});

test("indicator names on a country card are plain words: no WGI, UHC, V-Dem or INFORM, and PM2.5 says it is air pollution", { skip }, async () => {
  await open();
  await card("Испания");
  const names = await page.eval(`[...document.querySelectorAll("#sheetBody .world-row > span:first-child")].map(s => { const c = s.cloneNode(true); c.querySelectorAll("small").forEach(x => x.remove()); return c.textContent.trim(); })`);
  assert.ok(names.length > 5, "precondition: the card lists Spain's indicators");
  const acr = names.filter(n => /\b(WGI|UHC|V-Dem|INFORM)\b/.test(n));
  assert.deepEqual(acr, [], "source acronyms in the indicator names mean nothing to a newcomer (the source is already in the grey line below): " + acr.join("; "));
  const pm = names.filter(n => /PM2\.5/.test(n) && !/воздух|загрязн|смог|пыл/i.test(n));
  assert.deepEqual(pm, [], "«PM2.5, среднегодовое» — a newcomer does not know this is air pollution");
});

test("the note above world data on a country card fits in four lines on a phone", { skip }, async () => {
  await open();
  await card("Испания");
  const ps = await lines("#sheetBody .world > p");
  assert.ok(ps.length, "precondition: the world data note is shown");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "the note before the first indicator is a block of grey text:\n" + show(long));
});

test("tapping the status «Подключено» in the header shows that the data was checked, instead of nothing visible happening", { skip }, async () => {
  await open({ hash: "#/rank" });
  assert.equal(await page.text("#syncText"), "Подключено", "precondition");
  await page.tap({ sel: "#syncBtn" }, 50);
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    seen.add(await page.eval(`"status: " + document.getElementById("syncText").innerText`));
    const t = await page.eval(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText`);
    if (t) seen.add("toast: " + t);
    await sleep(100);
  }
  const all = [...seen].join(" | ");
  assert.match(all, /(обновлен|актуальн|свеж|нового нет|изменений нет|без изменений|проверено)/i, `after the tap the screen looks exactly the same, so a newcomer does not know whether anything happened: ${all}`);
});

test("a map card whose only rating is hidden says why its total is world data only, next to «оценок: 1»", { skip }, async () => {
  await open();
  await card("Будва");
  const chips = oneLine(await page.text("#sheetBody .chips"));
  const score = oneLine(await page.eval(`(() => { const b = document.querySelector("#sheetBody .bigscore"), parts = [b.innerText]; for (let n = b.nextElementSibling; n && !n.matches(".btns"); n = n.nextElementSibling) parts.push(n.innerText); return parts.join(" "); })()`));
  assert.match(chips, /оценок: 1/, "precondition: the card counts Вика's hidden rating");
  assert.match(score, /только мировые данные/, "precondition: the score line says the total is world data only");
  assert.match(score, /скрыт/, `the card reads «оценок: 1» and right under it «${score}» — one rating exists, yet the total is «только мировые данные»; why is said only at the very bottom, below the buttons`);
});

test("«год здесь» is said in words a newcomer understands on the map card and in the places list", { skip }, async () => {
  await open();
  await card("Порту");
  const sheet = oneLine(await page.text("#sheetBody")) + " " + await tipOnTap("#sheetBody", "год здесь");
  assert.match(sheet, /8\/10/, "precondition: the card shows Михаил's 0–10 answer");
  assert.match(sheet, /прожили бы/i, `«${sheet.match(/год здесь[^·]*·[^·]*/)?.[0] || sheet}» — what is «год здесь: Михаил 8/10»? The answer «Прожили бы здесь год?» is only in a mouse tooltip`);
  await goto("#/places");
  const list = oneLine(await page.text("#v-places"));
  assert.match(list, /год здесь|здесь год/, "precondition: the places list shows the year answers");
  assert.match(list, /прожили бы/i, "the places list shows «год здесь: Михаил 8/10 · Вика 7/10» under each place and never says what was asked");
});

test("«Оценить» on a map card opens the rating form with that place already chosen", { skip }, async () => {
  await open();
  await card("Лимасол");
  await page.tap({ within: "#sheetBody", text: "Оценить" });
  await page.waitFor(`location.hash.startsWith("#/rate") && document.getElementById("fPlace").value === "limassol"`, 4000, "rating form for Лимасол");
  assert.match(await page.eval(`document.getElementById("fPlace").selectedOptions[0].text`), /Лимасол/);
  assert.equal(await page.eval(`document.querySelector('#fWho [aria-pressed="true"]').innerText`), "Михаил", "the person of this device is chosen too");
});

/* ======================= ranking ======================= */

test("the ranking says in its first lines what the order is: best places for us first", { skip }, async () => {
  await open({ hash: "#/rank" });
  const t = oneLine(await page.eval(`document.querySelector("#v-rank > header").innerText + " " + (document.querySelector("#v-rank section.block > p") || {}).innerText`));
  assert.match(t, /(сверху|наверху|по убыванию|от лучш|в порядке|первыми)/i, `the first lines show counts and how to read a bar, but never say that the list goes from best to worst for us: «${t}»`);
});

test("on a phone no explanation in the first screen of the ranking is longer than four lines", { skip }, async () => {
  await open({ hash: "#/rank" });
  const nav = await navTop();
  const ps = (await lines("#v-rank > header p, #v-rank section.block > p, #v-rank .rank > .empty-row")).filter(p => p.top < nav);
  assert.ok(ps.length, "precondition");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "a wall of grey text between the weight buttons and the first place:\n" + show(long));
});

test("«Что значат пометки» reads as a list of short entries, not one long paragraph", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.tap({ text: "Что значат пометки" });
  const items = await page.eval(`${LINES}([...document.querySelectorAll(".rank-help p, .rank-help li, .rank-help dd, .rank-help dt, .rank-help div")].filter(e => !e.querySelector("p, li, dd, div")))`);
  assert.ok(items.length, "precondition: the help opens");
  const long = items.filter(x => x.lines > 4);
  assert.deepEqual(long.map(x => x.lines), [], "the opened help is one paragraph of grey text — a newcomer looking for one word has to read all of it:\n" + show(long));
  assert.ok(items.length >= 5, `the help explains about ten marks; expected one entry per mark, got ${items.length}`);
});

test("no sentence is set in capitals: capitalised headings on the ranking, the places list, a dossier and a map card stay under 40 characters", { skip }, async () => {
  const caps = async where => (await page.eval(`[...document.querySelectorAll(".view:not([hidden]) *, #sheet:not([hidden]) *")].filter(e => e.children.length === 0 || e.matches("h2, h3, h4, .rank-sub, .plist-h")).filter(e => getComputedStyle(e).textTransform === "uppercase" && e.offsetParent && e.innerText.trim()).map(e => e.innerText.replace(/\\s+/g, " ").trim())`)).filter(t => t.length > 40).map(t => `${where}: «${t}» (${t.length})`);
  await open({ hash: "#/rank" });
  const bad = await caps("ranking");
  await goto("#/places"); bad.push(...await caps("places"));
  await goto("#/place/porto"); bad.push(...await caps("Порту"));
  await goto("#/map"); await page.waitFor(`${APP}.then(s => !!s.mapView)`, 5000);
  await card("Порту");
  await page.tap({ within: "#sheetBody", text: "Похожие" });
  await page.waitFor(`/%/.test((document.getElementById("simPlaceBox") || {}).innerText || "")`, 5000, "similar places");
  bad.push(...await caps("Порту card"));
  assert.deepEqual(bad, [], "a long rule in capitals is hard to read on a phone; keep the heading short and put the rule under it in normal case");
});

test("the ranking explains every special word it shows on the ranking itself: база, мировые данные, ★, отсев, Оба, Своё, №2–3 and «год здесь»", { skip }, async () => {
  await open({ hash: "#/rank", dark: true });
  await openAllDetails("#v-rank");
  const t = oneLine(await page.text("#v-rank"));
  const need = {
    "база": /база[^.]{0,80}(точк\S* отсчёта|сравнива|относительно)/i,
    "мировые данные": /мировые данные[^.]{0,80}(показател|климат)/i,
    "★": /главн\S* вопрос\S* ★/i,
    "отсев": /отсев[^.]{0,80}(отказал|вето)/i,
    "Оба": /«Оба»\s*—\s*средн/i,
    "Своё": /«Своё»\s*—\s*ползунк/i,
    "№2–3": /в зависимости от весов»?\s*—\s*место может сдвинуться/i,
    "год здесь": /год здесь»?\s*—\s*«?прожили/i,
  };
  const missing = Object.keys(need).filter(k => !need[k].test(t));
  assert.deepEqual(missing, [], "words on the ranking without an explanation on the ranking");
});

test("below the first screen, the ranking's notes on the table and on the flags are at most four lines each on a phone", { skip }, async () => {
  await open({ hash: "#/rank" });
  const ps = await lines("#v-rank section.block:not(:first-of-type) > p, #v-rank .flags > p");
  assert.ok(ps.length >= 2, "precondition: the table and the flags each have a note");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "after the list comes more grey text — the heat-table rule and the flag legend:\n" + show(long));
});

test("without a key the ranking does not claim we have no places, no ratings and no flags", { skip }, async () => {
  await open({ hash: "#/rank", token: false });
  await page.waitFor(`/не подключены/.test(document.getElementById("v-rank").innerText)`, 4000, "not-connected banner");
  const head = oneLine(await page.text("#v-rank > header"));
  const list = oneLine(await page.text("#rank"));
  const flags = oneLine(await page.text("#v-rank .flags"));
  const bad = [];
  if (/Мест: 0|оценок: 0/.test(head)) bad.push(`header «${head}»`);
  if (/Мест пока нет|добавьте первое/.test(list)) bad.push(`list «${list}»`);
  if (/Флагов нет/.test(flags)) bad.push(`flags «${flags}»`);
  assert.deepEqual(bad, [], "the banner says the data is not connected, but the screen also says there are no places (and to add the first one, which needs a key), zero ratings and no flags — a friend with a new phone concludes the app is empty");
  assert.match(list, /подключ/, `the empty list should say places appear after connecting the data: «${list}»`);
});

test("the ranking does not title its list «Места», the name of another tab", { skip }, async () => {
  await open({ hash: "#/rank" });
  const h2 = await page.eval(`[...document.querySelectorAll("#v-rank h2")].map(h => h.innerText.trim())`);
  const tabs = await page.eval(`[...document.querySelectorAll(".bottomnav a span")].map(s => s.innerText.trim().toLowerCase())`);
  const same = h2.filter(t => tabs.includes(t.toLowerCase()));
  assert.deepEqual(same, [], "inside «Рейтинг» the first section is called «МЕСТА» — the same word as the «Места» tab, so a newcomer is not sure which screen she is on");
});

/* ======================= places ======================= */

test("the places screen explains «вето» when a vetoed place is in the list", { skip }, async () => {
  await open({ hash: "#/places" });
  assert.match(await page.text("#plist"), new RegExp(NOT_LETTER + "вето", "i"), "precondition: Батуми is listed with «вето»");
  const head = oneLine(await page.eval(`(() => { const v = document.getElementById("v-places").cloneNode(true); v.querySelector("#plist").remove(); return v.innerText || v.textContent; })()`));
  assert.match(head, /вето[^.]{0,80}(не хочет|против|отказ|запрет|убира|не поедет|не подход|не готов)|(не хочет|против|запрет)[^.]{0,60}вето/i, `«Статусы: кандидат…, финалист…, отсев…» — «вето» under Батуми and in «Отсев и вето» is never explained: «${head}»`);
});

test("the places screen does not name the weights «Оба» without saying what they are", { skip }, async () => {
  await open({ hash: "#/places" });
  const p = oneLine(await page.eval(`document.querySelector("#v-places header p").innerText`));
  const named = p.match(/весам «([^»]+)»/);
  if (!named) return;
  assert.match(p, new RegExp(`«${named[1]}»[^.]{0,60}(средн|обоих|наших|ползунк|поровну)`, "i"), `«по весам «${named[1]}» из «Рейтинга»» — a newcomer knows neither «веса» nor «${named[1]}» here: «${p}»`);
});

test("places, a dossier, the rating form and settings each say what they are for within the first screen", { skip }, async () => {
  const first = async (sel, re) => {
    const nav = await navTop();
    return page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(e => e.offsetParent && e.getBoundingClientRect().top < ${nav} && ${re}.test(e.innerText))`);
  };
  await open({ hash: "#/places" });
  assert.ok(await first("#v-places header p", "/где были|куда смотрим/i"), "places: what the list is");
  await goto("#/place/porto");
  assert.ok(await first("#v-place .bigscore span", "/из 5[^.]*как в СПб/"), "dossier: what the big number is");
  await goto("#/rate");
  assert.ok(await first("#rateForm .help span", "/оценива/i"), "rating form: who rates and how");
  await goto("#/settings");
  assert.ok(await first("#v-settings h2", "/кто я|подключени/i"), "settings: what is set here");
});

test("on a phone places, dossiers, settings and the first-visit help keep each opening paragraph within four lines", { skip }, async () => {
  const check = async (where, sel) => { const nav = await navTop(); return (await lines(sel)).filter(p => p.top < nav && p.lines > 4).map(p => `${where}: ${p.lines} lines «${p.text.slice(0, 80)}»`); };
  await open({ hash: "#/places" });
  const bad = await check("places", "#v-places header p");
  for (const id of ["porto", "kotor", "budva"]) { await goto("#/place/" + id); bad.push(...await check(id, "#v-place .panel p, #v-place .bigscore span")); }
  await goto("#/settings");
  bad.push(...await check("settings", "#v-settings p"));
  await open({ intro: true });
  await page.waitFor(`!document.getElementById("sheet").hidden`, 4000);
  bad.push(...await check("intro", "#sheetBody .help > span"));
  assert.deepEqual(bad, []);
});

/* ======================= dossier ======================= */

test("a dossier that marks main questions with ★ says in words what ★ means", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openAllDetails("#v-place");
  const t = oneLine(await page.text("#v-place")) + " " + await tipOnTap("#v-place .subtable", "★");
  assert.match(t, /★/, "precondition: the dossier shows ★ next to questions and in «★ заполнено»");
  assert.match(t, /главн\S* вопрос/i, "«★ заполнено: 10 из 10» and «★ Интернет дома» — only a mouse tooltip says ★ is a main question, a phone never shows it");
});

test("a dossier says what its «Данные» column and radar line are: world data and the place's own numbers", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openAllDetails("#v-place");
  const t = oneLine(await page.text("#v-place")) + " " + await tipOnTap("#v-place .radar .legend", "Данные");
  assert.match(t, /Данные/, "precondition: the radar legend and the table use «Данные»");
  assert.match(t, /«Данные»[^.]{0,80}(миров|показател|климат)|Данные\s*[—:]\s*(миров|показател)/, "«Данные» — which data? «Из чего итог» says «мировые данные и цифры места», the legend and both tables just say «Данные»");
});

test("a dossier's score does not show «заполнено N% групп» without saying what is counted", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const cap = oneLine(await page.text("#v-place .bigscore span"));
  const tip = await tipOnTap("#v-place .bigscore", "заполнено");
  assert.ok(!/заполнено \d+% групп/.test(cap) || /(оценк|данн)[^·]{0,40}\d+% групп|\d+% групп[^·]{0,40}(оценк|данн)/.test(cap) || /оценк|данн/.test(tip), `«${cap}» — «заполнено 100% групп»: filled with what? Only a mouse tooltip says «оценки или мировые данные»`);
});

test("«Цифры места» do not tell a newcomer to ask «Claude»", { skip }, async () => {
  await open({ hash: "#/place/limassol" });
  const t = oneLine(await page.text("#factsForm"));
  assert.doesNotMatch(t, /Claude/, "«Можно попросить Claude найти цифры по объявлениям» — Вика's friend does not know who Claude is");
});

test("SPb's dossier says what «база» means right at its score and does not promise features that are not there", { skip }, async () => {
  await open({ hash: "#/place/sankt-peterburg" });
  const cap = oneLine(await page.text("#v-place .bigscore")) + " " + await tipOnTap("#v-place .bigscore", "база");
  assert.match(cap, /(точк\S* отсчёта|сравнива|относительно)/i, `the score reads «${cap}» — «база по определению» is jargon`);
  const t = oneLine(await page.text("#v-place .trips"));
  assert.doesNotMatch(t, /Позже сюда придут|риски варианта|по бытовым группам/, `«${t}» — a roadmap note and jargon instead of a plain sentence`);
});

test("the SPb radar legend lists only the lines drawn on it and says «СПб = 3» once", { skip }, async () => {
  await open({ hash: "#/place/sankt-peterburg" });
  const drawn = await page.eval(`[...document.querySelectorAll(".radar svg path[stroke]")].map(p => p.getAttribute("stroke"))`);
  const legend = oneLine(await page.text(".radar .legend"));
  assert.ok(!drawn.includes("var(--m)") && !drawn.includes("var(--v)"), "precondition: SPb has no lines of our own");
  assert.doesNotMatch(legend, /Михаил|Вика/, `legend «${legend}» names Михаил and Вика, but SPb is never rated — a newcomer looks for their lines`);
  assert.ok((legend.match(/СПб = 3/g) || []).length <= 1, `«${legend}»: «СПб = 3» twice in one legend`);
});

test("every dossier's radar legend names only the lines drawn on it and says «СПб = 3» once", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const bad = [];
  for (const id of ["porto", "kotor", "budva", "limassol"]) {
    if (id !== "porto") await goto("#/place/" + id);
    const r = await page.eval(`(() => {
      const drawn = new Set([...document.querySelectorAll(".radar svg circle[r='4.5']")].map(c => c.getAttribute("fill")));
      const legend = [...document.querySelectorAll(".radar .legend span")].map(s => ({ cls: s.querySelector("i") ? s.querySelector("i").className : "", text: s.innerText.trim() }));
      const color = { m: "var(--m)", v: "var(--v)", res: "var(--res)", data: "var(--data)" };
      const named = legend.map(l => Object.keys(color).find(k => l.cls.split(" ").includes(k))).filter(Boolean);
      return { extra: named.filter(k => !drawn.has(color[k])).map(k => legend.find(l => l.cls.split(" ").includes(k)).text), spb: (legend.map(l => l.text).join(" ").match(/СПб = 3/g) || []).length };
    })()`);
    if (r.extra.length) bad.push(`${id}: legend names ${r.extra.join(", ")} but no such line is drawn`);
    if (r.spb > 1) bad.push(`${id}: «СПб = 3» ${r.spb} times in the legend`);
  }
  assert.deepEqual(bad, [], "a newcomer looks for every coloured line the legend promises (Котор: only Михаил rated; Будва: Вика's rating is hidden; Лимасол: nobody rated)");
});

test("on a phone the notes inside a dossier are at most four lines each, and the 15-item shopping list is folded", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const ps = await lines("#v-place section.block > p, #factsForm > p, #factsForm .fact > span.small");
  assert.ok(ps.length >= 5, "precondition: the subcategory note, the «Цифры места» note and the hints under each number");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "the dossier is long already; these notes are blocks of grey text a newcomer will not read on a phone:\n" + show(long));
});

test("a dossier whose climate comes from the place's own town does not say «0 км»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const head = oneLine(await page.eval(`[...document.querySelectorAll("#v-place .sec-head")].find(h => /Мировые данные/i.test(h.innerText)).innerText`));
  assert.match(head, /климат/, "precondition: the world data header names the climate town");
  assert.doesNotMatch(head, /(^|[^\d.,])0 км/, `«${head}» — «Порту, 0 км» reads like a puzzle; the distance only matters when the climate is taken from another town`);
});

test("a place only my partner rated says once that her rating is hidden and offers «Показать всё равно» once", { skip }, async () => {
  await open({ hash: "#/place/budva" });
  const reveal = await page.eval(`[...document.querySelectorAll("#v-place [data-reveal]")].filter(b => b.offsetParent).length`);
  const mine = await page.eval(`[...document.querySelectorAll("#v-place p, #v-place .trip")].filter(e => e.offsetParent && /Ваших оценок/.test(e.innerText)).map(e => e.innerText.trim())`);
  assert.ok(reveal <= 1, `«Оценка Вики скрыта… Показать всё равно» at the score and again «Вика: оценка скрыта… Показать всё равно» below — ${reveal} times on one screen`);
  assert.ok(mine.length <= 1, `«Ваших оценок…» said ${mine.length} times: ${mine.join(" | ")}`);
});

test("the place card asks for the kind of place in plain words, not «Архетип»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const lbl = oneLine(await page.eval(`document.querySelector('#placeForm [name="archetype"]').closest("label").querySelector(".lbl").innerText`));
  assert.match(lbl, /тип места|какое (это )?место|что за место/i, `field label «${lbl}» — a newcomer does not know the word «архетип»; «Тип места» says the same`);
});

/* ======================= rating form ======================= */

test("on a phone the rating form's notes before «Кто оценивает» take at most eight lines, none longer than four", { skip }, async () => {
  await open({ hash: "#/rate" });
  const who = await page.eval(`Math.round(document.getElementById("fWho").getBoundingClientRect().top)`);
  const ps = (await lines("#rateForm .help > span, #fTop .banner")).filter(p => p.bottom <= who);
  assert.ok(ps.length, "precondition");
  const total = ps.reduce((a, p) => a + p.lines, 0);
  const long = ps.filter(p => p.lines > 4);
  assert.ok(total <= 8 && !long.length, `${total} lines of rules before the first choice:\n${show(ps)}\n— «Откуда знаем» explains a button that only appears after an answer, and the rent note belongs to the dossier`);
});

test("on a phone the hints under «Сезон», «Работали из поездки?» and «Где жили» are at most four lines each", { skip }, async () => {
  await open({ hash: "#/rate" });
  const ps = await page.eval(`${LINES}([...document.querySelectorAll("#rateForm .field > span.small")].filter(e => e.closest(".fcard") === document.getElementById("fWho").closest(".fcard")))`);
  assert.ok(ps.length >= 3, "precondition: the trip questions have hints");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "before the first star question the form already asks six things, each with a paragraph of rules:\n" + show(long));
});

test("the rating form says the rent and prices are typed in «Цифры места» of the place's dossier, not in «его карточку»", { skip }, async () => {
  await open({ hash: "#/rate" });
  const t = oneLine(await page.eval(`[...document.querySelectorAll("#rateForm .help span")].map(s => s.textContent).join(" ")`));
  assert.match(t, /Аренд/, "precondition: the form says rent is not asked here");
  assert.match(t, /«Цифры места»/, `«${t.match(/Аренд[^.]*\./)[0]}» — the dossier has a «Карточка места» section (name, status) and a separate «Цифры места» section; the note sends the user to the wrong one`);
});

test("the rating form explains its own words where they appear: ★, откуда знаем, по памяти, межсезон, вето", { skip }, async () => {
  await open({ hash: "#/rate" });
  const t = oneLine(await page.text("#rateForm"));
  assert.match(t, /главные вопросы ★/i, "★");
  assert.match(t, /По памяти:[^.]{0,40}больше месяца/, "по памяти");
  assert.match(t, /Межсезон\s*—\s*между/, "межсезон");
  assert.match(t, /Вето:[^.]{0,60}убира\S* из рейтинга/, "вето");
  await page.tap({ within: '[data-q="интернет"]', text: "4" });
  const conf = await page.eval(`document.querySelector('[data-conf="интернет"]').innerText`);
  assert.match(conf, /откуда знаем: видели как туристы/i, "after an answer, the «откуда знаем» button names its current choice in words");
  await page.tap({ sel: '[data-conf="интернет"]' });
  const choices = await page.eval(`[...document.querySelectorAll('[data-confpick="интернет"] button')].map(b => b.innerText)`);
  assert.deepEqual(choices, ["проверили в быту", "видели как туристы", "со слов живущих", "по сайтам и рейтингам"]);
});

/* ======================= settings and shared words ======================= */

test("world data is called «мировые данные» in settings and in the no-key banner, as in the first-visit help and the ranking", { skip }, async () => {
  await open({ hash: "#/settings" });
  const lbl = oneLine(await page.eval(`document.getElementById("useData").closest("label").innerText`));
  assert.match(lbl, /мировые данные/i, `the ranking help says «Мировые данные… их можно выключить в настройках», but the switch in settings reads «${lbl.slice(0, 60)}…»`);
  await open({ hash: "#/rank", token: false });
  const b = oneLine(await page.text("#v-rank .banner"));
  assert.doesNotMatch(b, /мировые показатели/i, `no-key banner: «${b}»`);
});

test("the switch that changes every total is not filed under «Вид» next to the colour theme", { skip }, async () => {
  await open({ hash: "#/settings" });
  const sec = await page.eval(`document.getElementById("useData").closest("section").querySelector("h2").innerText.trim()`);
  assert.doesNotMatch(sec, /^вид$/i, "«Вид» means how the app looks; turning world data off changes every score and the ranking, a newcomer would never look for it there");
  const note = oneLine(await page.eval(`(() => { const s = document.getElementById("useData").closest("section"); return [...s.querySelectorAll("p")].map(p => p.innerText).join(" "); })()`));
  assert.doesNotMatch(note, /методик|подкатегори/i, `«${note}» — «по правилам методики», «итог подкатегории» are words of the author, not of the reader`);
});

test("turning world data off in settings says right away that the totals changed", { skip }, async () => {
  await open({ hash: "#/settings" });
  assert.equal(await page.eval(`document.getElementById("useData").checked`), true, "precondition: world data is on");
  await page.tap({ sel: "#useData" }, 50);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const t = await page.eval(`[document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText, ...[...document.getElementById("useData").closest("section").querySelectorAll("[role=status], [aria-live]")].map(e => e.innerText)].filter(Boolean).join(" | ")`);
    if (t) seen.add(t);
    await sleep(100);
  }
  const all = [...seen].join(" | ");
  assert.match(all, /(итог|рейтинг|оценк)[^|]*(пересчит|без мировых|только по наш|изменил)|(пересчит|без мировых)[^|]*(итог|рейтинг)/i, `the tick goes off and nothing else happens on the screen, although every score and the ranking just changed: «${all}»`);
});

test("on a phone the paragraphs about the app in settings are at most four lines each (the list of data sources aside)", { skip }, async () => {
  await open({ hash: "#/settings" });
  const ps = (await lines("#v-settings section.block .panel p, #v-settings section.block .help > span")).filter(p => !/©|CC BY|GeoNames|World Bank|Код:/.test(p.text));
  assert.ok(ps.length >= 4, "precondition");
  const long = ps.filter(p => p.lines > 4);
  assert.deepEqual(long.map(p => p.lines), [], "settings explain the app in long paragraphs:\n" + show(long));
});

/* ======================= cycle 3 review: back link and wording ======================= */

const backLink = () => page.eval(`(() => { const a = document.querySelector("#v-place [data-back]"); return a ? a.innerText.trim() + " " + a.getAttribute("href") : ""; })()`);

test("a dossier opened after saving a rating in «Оценить» links back to «Все места», not to the ranking visited before, and the earlier dossier keeps «← Рейтинг»", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.tap({ text: "Порту", within: "#rank" });
  await dossierReady();
  assert.equal(await backLink(), "← Рейтинг #/rank", "fixture: opened from the ranking");
  await page.tap({ sel: '.bottomnav a[data-nav="rate"]' });
  await page.waitFor(`!document.getElementById("v-rate").hidden && document.getElementById("fPlace")`, 4000, "rating form");
  await page.select("#fPlace", "Котор");
  await page.eval(`document.querySelector('[data-score="улица"][data-v="4"]').scrollIntoView({ block: "center" })`);
  await page.tap({ sel: '[data-score="улица"][data-v="4"]' });
  await page.eval(`document.getElementById("fSave").scrollIntoView({ block: "center" })`);
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`location.hash === "#/place/kotor"`, 8000, "dossier after saving");
  await dossierReady();
  assert.equal(await backLink(), "← Все места #/places", "the user came from the rating form, yet the dossier offers «← Рейтинг»");
  await page.eval("history.back()"); await sleep(300);
  await page.eval("history.back()"); await sleep(400);
  await page.waitFor(`location.hash === "#/place/porto"`, 4000, "back on Порту");
  await dossierReady();
  assert.equal(await backLink(), "← Рейтинг #/rank", "going back in history to the dossier opened from the ranking keeps its own way back");
});

test("SPb is «он» everywhere, the places header says how weights work in one clear phrase, and the dossier's questions are separated", { skip }, async () => {
  const files = repo({ places: PLACES.map(p => p.id === "porto" ? Object.assign({}, p, { questions: "Проверить сырость зимой\nВопрос Вики\nМой вопрос" }) : p), ratings: RATINGS, weights: WEIGHTS });
  await open({ hash: "#/place/sankt-peterburg", files });
  const spb = oneLine(await page.text("#v-place .bigscore"));
  assert.match(spb, /с ним сравниваем все места/, `«${spb}»`);
  assert.doesNotMatch(spb, /с ней/);
  await goto("#/places");
  const head = oneLine(await page.text("#v-places header"));
  assert.doesNotMatch(head, /весят поровну|, меняются в/, `«${head}»`);
  assert.match(head, /веса меняются в «Рейтинге»/, `«${head}»`);
  await goto("#/place/porto");
  const q = oneLine(await page.eval(`[...document.querySelectorAll("#v-place .panel.pad .small")].map(e => e.innerText).find(t => /Вопросы к следующей поездке/.test(t)) || ""`));
  assert.match(q, /Вопросы к следующей поездке/, `«${q}»`);
  assert.match(q, /Проверить сырость зимой \/ Вопрос Вики \/ Мой вопрос$/, "the lines run together into one sentence");
});
