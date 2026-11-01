import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { PLACES, mockFiles } from "./fixtures.mjs";

// Persona «сезон целиком»: Михаил and Вика go through a whole scouting season on their two phones,
// from an almost empty data repository (only SPb) to a decision. Both phones share one mocked GitHub
// repository; each phone keeps its own app storage (key, who I am, drafts, revealed places, chosen weights).
// Synthetic data only; GitHub and Nominatim are mocked.

const skip = !CHROME && "no Chrome";
let srv, page, UA;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

before(async () => {
  srv = await serve();
  page = await launch();
  UA = await page.eval("navigator.userAgent");
  await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE });
});
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- season data ---------- */
const T = "2026-10-01T00:00:00.000Z";
const SPB = PLACES[0];
const place = (id, name, country, cc, lat, lon, x = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, x);
const SIX = [
  place("budva", "Будва", "Черногория", "MNE", 42.287, 18.839),
  place("portu", "Порту", "Португалия", "PRT", 41.148, -8.611),
  place("belgrad", "Белград", "Сербия", "SRB", 44.804, 20.465),
  place("tbilisi", "Тбилиси", "Грузия", "GEO", 41.691, 44.834),
  place("hertseg-novi", "Херцег-Нови", "Черногория", "MNE", 42.4531, 18.5375),
  place("bar", "Бар", "Черногория", "MNE", 42.0931, 19.1003),
];
const NAME = Object.fromEntries(SIX.map(p => [p.id, p.name]));

const TRIP = {
  vPortu: { id: "r-v-portu", place: "portu", who: "Вика", start: "2026-06-01", end: "2026-06-14", season: "пик", mode: "удалёнка", housing: "жилой район", year: 7, review: "Красиво, но влажно и много холмов.", scores: { "интернет": 4, "улица": 4.5, "шум": 3, "пешком": 4.5, "эстетика": 5, "язык": 2.5, "чистота": 4 } },
  vBudva: { id: "r-v-budva", place: "budva", who: "Вика", start: "2026-07-10", end: "2026-07-24", season: "пик", mode: "смешанно", housing: "туристическая зона", year: 6, review: "Летом шумно у моря.", scores: { "интернет": 3, "улица": 4, "шум": 2, "пешком": 4, "море": 5, "чистота": 3 } },
  vBelgrad: { id: "r-v-belgrad", place: "belgrad", who: "Вика", start: "2024-05-02", end: "2024-05-09", season: "межсезон", mode: "отпуск", housing: "центр", retro: true, year: 4, review: "", scores: { "улица": 3.5, "эстетика": 3, "язык": 4 } },
  mTbilisi: { id: "r-m-tbilisi", place: "tbilisi", who: "Михаил", start: "2026-09-05", end: "2026-09-26", season: "межсезон", mode: "удалёнка", housing: "жилой район", year: 5, review: "Душевно, но тяжело с жильём.", scores: { "интернет": 3.5, "улица": 3, "шум": 2.5, "пешком": 4, "эстетика": 3.5, "язык": 2, "чистота": 2.5, "фонд": 2 } },
  mPortu: { id: "r-m-portu", place: "portu", who: "Михаил", start: "2026-06-01", end: "2026-06-14", season: "пик", mode: "удалёнка", housing: "жилой район", year: 8, review: "Хочу сюда снова.", scores: { "интернет": 4.5, "улица": 4, "шум": 3.5, "пешком": 4, "эстетика": 4.5, "язык": 3, "фонд": 2.5 } },
  mBudva: { id: "r-m-budva", place: "budva", who: "Михаил", start: "2026-07-10", end: "2026-07-24", season: "пик", mode: "смешанно", housing: "туристическая зона", year: 5, review: "", scores: { "интернет": 2.5, "улица": 4, "шум": 2.5, "пешком": 4.5, "море": 4.5, "эстетика": 4 } },
  mHn: { id: "r-m-hn", place: "hertseg-novi", who: "Михаил", start: "2024-08-01", end: "2024-08-15", season: "пик", mode: "отпуск", housing: "жилой район", retro: true, year: 6, review: "", scores: { "улица": 4, "шум": 3.5, "пешком": 3, "море": 4.5, "эстетика": 4.5 } },
};
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
const ratingDoc = t => Object.assign({ retro: false, veto: "", review: "", conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, t, { days: t.start ? days(t.start, t.end) : null, scores: Object.assign({}, t.scores) });

function files({ places = [SPB, ...SIX], ratings = [], weights = [] } = {}) {
  const f = {};
  places.forEach(p => { f[`places/${p.id}.json`] = JSON.stringify(p, null, 1) + "\n"; });
  ratings.forEach(r => { f[`ratings/${r.id}.json`] = JSON.stringify(ratingDoc(r), null, 1) + "\n"; });
  weights.forEach(w => { f[`weights/${w.id}.json`] = JSON.stringify(w, null, 1) + "\n"; });
  return f;
}
const VIKA3 = [TRIP.vPortu, TRIP.vBudva, TRIP.vBelgrad];
const ALL7 = [...VIKA3, TRIP.mTbilisi, TRIP.mPortu, TRIP.mBudva, TRIP.mHn];
const withFacts = (p, facts) => Object.assign({}, p, { facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { v, src: "объявления", at: "2026-10-02" }])) });
const LATE_PLACES = [SPB, ...SIX.map(p => p.id === "portu" ? withFacts(p, { rent: 950, dinner: 45 }) : p.id === "budva" ? withFacts(p, { rent: 750 }) : p.id === "tbilisi" ? withFacts(p, { rent: 480, tds: 180 }) : p.id === "bar" ? Object.assign({}, p, { status: "отсев", reason: "мёртвый зимой, всё закрыто" }) : p)];
const LATE_RATINGS = [TRIP.vPortu, Object.assign({}, TRIP.vBudva, { veto: "толпы и шум всё лето" }), TRIP.mTbilisi, TRIP.mPortu, Object.assign({}, TRIP.mBudva, { scores: Object.assign({}, TRIP.mBudva.scores, { "улица": 3.5 }), year: 4 }), TRIP.mHn];
const W_MIKHAIL = { id: "mihail", who: "Михаил", w: { legal: 6, money: 30, work: 12, health: 6, safety: 6, climate: 6, housing: 12, city: 6, nature: 6, people: 5, links: 5 }, updatedAt: T };
const W_VIKA = { id: "vika", who: "Вика", w: { legal: 5, money: 5, work: 5, health: 10, safety: 10, climate: 20, housing: 5, city: 10, nature: 20, people: 5, links: 5 }, updatedAt: T };

/* ---------- two phones on one repository ---------- */
const KEY = { "Михаил": "github_pat_TEST_mikhail_phone", "Вика": "github_pat_TEST_vika_phone" };
const connected = who => ({ "wtl:token": JSON.stringify(KEY[who]), "wtl:me": JSON.stringify(who), "wtl:introSeen": "true" });
let phones = {}, current = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `(await import("./js/app.js")).state`;

async function season(repoFiles, { cold = false, local = {} } = {}) {
  phones = cold ? { "Михаил": {}, "Вика": {} } : { "Михаил": connected("Михаил"), "Вика": connected("Вика") };
  for (const who of Object.keys(local)) Object.entries(local[who]).forEach(([k, v]) => { phones[who]["wtl:" + k] = JSON.stringify(v); });
  current = null;
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.eval(`(async () => {
    localStorage.clear(); sessionStorage.clear();
    for (const k of await caches.keys()) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    localStorage.setItem("mock:files", ${JSON.stringify(JSON.stringify(repoFiles))});
  })()`);
  page.takeErrors();
}

const BOOTED = `(async () => { const t = document.getElementById("syncText"); if (!t || ["…", "Обновляю…"].includes(t.innerText)) return false; const s = ${APP}; return !!(s.M && s.world.cities); })()`;

// Close the app on the current phone and open it on `who`'s phone (or reopen it on the same phone «the next day»).
async function onPhone(who, hash = "#/map", { w = 390, h = 844, dark = false } = {}) {
  await sleep(350);
  await page.goto(srv.url + "manifest.webmanifest", 50);
  if (current) phones[current] = await page.eval(`Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith("wtl:")).map(k => [k, localStorage.getItem(k)]))`);
  await page.eval(`(() => { Object.keys(localStorage).filter(k => k.startsWith("wtl:")).forEach(k => localStorage.removeItem(k)); const s = ${JSON.stringify(phones[who])}; Object.keys(s).forEach(k => localStorage.setItem(k, s[k])); })()`);
  current = who;
  await page.send("Emulation.setUserAgentOverride", { userAgent: w < 800 ? IPHONE : UA });
  await page.viewport(w, h, { dark });
  await page.goto(srv.url + hash, 200);
  await page.waitFor(BOOTED, 10000, `app booted on ${who}'s phone`);
}

/* ---------- small helpers ---------- */
const hash = () => page.eval("location.hash");
const files$ = () => mockFiles(page);
const ratingFiles = async () => Object.entries(await files$()).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v));
const liveRatings = async () => (await ratingFiles()).filter(r => !r.deleted);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 8000, "toast " + re);
// «Цифры сохранены» stays under the button until the dossier is drawn again; the toast with it lasts only 3.5 s.
const factsSaved = () => page.waitFor(`/Цифры сохранены/.test(document.getElementById("factsMsg") ? document.getElementById("factsMsg").innerText : "") || /Цифры сохранены/.test(document.getElementById("toast").innerText)`, 15000, "numbers saved");
async function stays(js, ms = 1500) { try { await page.waitFor(js, ms); return false; } catch { return true; } }

async function press(sel, settle = 200) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}

async function nav(name) {
  const wide = page.vp.w >= 860;
  await page.tap({ sel: wide ? ".appbar .tabs a" : ".bottomnav a", text: name });
  const want = { "Карта": "#/map", "Рейтинг": "#/rank", "Места": "#/places", "Оценить": "#/rate" }[name];
  await page.waitFor(`location.hash === ${JSON.stringify(want)}`, 3000, "screen " + name);
  if (name === "Карта") await page.waitFor(`(async () => !!(${APP}).mapView)()`, 5000, "map ready");
}

async function openSettings() {
  await page.tap({ sel: '.appbar a[data-nav="settings"]' });
  await page.waitFor(`location.hash === "#/settings" && !!document.getElementById("tokenMsg")`, 3000, "settings");
}

async function openDossier(id) {
  await page.goto(srv.url + "#/place/" + id, 250);
  await page.waitFor(`document.querySelector("#v-place h1") && document.querySelector("#v-place h1").innerText === ${JSON.stringify(NAME[id] || id)}`, 4000, "dossier of " + id);
}

/* ---------- what each screen shows ---------- */
async function rankHead() {
  const t = await page.text("#v-rank header");
  const m = [/Мест: (\d+)/, /оценок: (\d+)/, /разведок: (\d+)/].map(re => t.match(re));
  return m.every(Boolean) ? { places: +m[0][1], ratings: +m[1][1], trips: +m[2][1], text: t } : { text: t };
}
const rankRows = () => page.eval(`Object.fromEntries([...document.querySelectorAll("#rank a.row")].map(a => [a.querySelector(".name b").innerText.trim(), { pos: a.querySelector(".pos").innerText.trim(), score: a.querySelector(".score").childNodes[0].textContent.trim(), chips: [...a.querySelectorAll(".chip")].map(c => c.innerText.trim()), dots: [...a.querySelectorAll(".track .dot")].map(d => d.getAttribute("data-tip")), pale: a.classList.contains("pale") }]))`);
const mainOrder = () => page.eval(`[...document.querySelectorAll("#rank a.row:not(.pale)")].map(a => a.querySelector(".name b").innerText.trim()).filter(n => n !== "Санкт-Петербург")`);
const placeRows = () => page.eval(`Object.fromEntries([...document.querySelectorAll("#plist a.prow")].map(a => [a.querySelector("b").innerText.trim(), { score: a.querySelector(".score").innerText.trim(), meta: a.querySelector(".meta").innerText.replace(/\\s+/g, " ").trim() }]))`);
const pins = () => page.eval(`(async () => Object.fromEntries((${APP}).mapView.placeList.map(p => [p.name, { text: p.text, out: !!p.out, thin: !!p.thin, base: !!p.base }])))()`);
async function dossierView(id) {
  await openDossier(id);
  return page.eval(`(() => { const v = document.getElementById("v-place"); return { score: v.querySelector(".bigscore b").innerText.trim(), tail: v.querySelector(".bigscore span").innerText.replace(/\\s+/g, " ").trim(), head: v.querySelector(".panel.pad").innerText.replace(/\\s+/g, " "), trips: v.querySelector(".trips").innerText.replace(/\\s+/g, " "), text: v.innerText.replace(/\\s+/g, " ") }; })()`);
}
const statusCounts = async () => { const t = await page.text("#tokenMsg"); const m = t.match(/мест (\d+) и СПб, оценок (\d+)/); return m ? { places: +m[1], ratings: +m[2], text: t } : { text: t }; };

// Visit the ranking, the places list, the map, settings and every dossier of the current phone,
// and check that they tell the same story: same totals, same positions, same hidden and same «out» places.
async function agree(label, { counts, hidden = {}, out = {} } = {}) {
  const errs = [];
  await nav("Рейтинг");
  const head = await rankHead(), rows = await rankRows(), rankText = (await page.text("#rank")).replace(/\s+/g, " ");
  await nav("Места");
  const list = await placeRows();
  await nav("Карта");
  const pin = await pins();
  await openSettings();
  const st = await statusCounts();
  const ids = await page.eval(`(async () => (${APP}).M.places.filter(p => p.status !== "база").map(p => p.id))()`);
  const dos = {};
  for (const id of ids) dos[NAME[id] || id] = await dossierView(id);
  if (counts) {
    if (head.places !== counts.places || head.ratings !== counts.ratings || head.trips !== counts.trips) errs.push(`ranking header: ${head.text.replace(/\s+/g, " ")} — expected ${JSON.stringify(counts)}`);
    if (st.places !== counts.places || st.ratings !== counts.ratings) errs.push(`settings status: ${st.text} — expected ${counts.places} places and ${counts.ratings} ratings`);
  }
  const partner = current === "Михаил" ? "Вика" : "Михаил";
  for (const [name, d] of Object.entries(dos)) {
    const L = list[name], R = rows[name], P = pin[name];
    if (!L) { errs.push(`${name}: missing from the places list`); continue; }
    if (L.score !== d.score) errs.push(`${name}: places list ${L.score} vs dossier ${d.score}`);
    if (P && P.text !== d.score && !(P.text === "" && d.score === "—")) errs.push(`${name}: map pin «${P.text}» vs dossier ${d.score}`);
    if (R && R.score !== d.score) errs.push(`${name}: ranking ${R.score} vs dossier ${d.score}`);
    const no = (d.tail.match(/№(\d+) в рейтинге/) || [])[1];
    const pos = R && !R.pale ? R.pos : undefined;
    if (no !== pos) errs.push(`${name}: dossier says «${d.tail}», ranking position ${pos || "—"}`);
    const isOut = /в рейтинг не входит/.test(d.tail);
    if (isOut !== !R) errs.push(`${name}: dossier out=${isOut}, ranking row ${R ? "present" : "absent"}`);
    if (isOut && !new RegExp(`Отсев:.*${name}`).test(rankText)) errs.push(`${name}: out of the ranking but not listed under «Отсев»`);
    if (isOut !== /отсев|вето/.test(L.meta)) errs.push(`${name}: dossier out=${isOut}, places list «${L.meta}»`);
    if (P && isOut !== P.out) errs.push(`${name}: dossier out=${isOut}, pin faded=${P.out}`);
    if (name in out && out[name] !== isOut) errs.push(`${name}: expected ${out[name] ? "" : "not "}out of the ranking`);
    const isHidden = /скрыт[аы], пока вы не оцените/.test(d.head);
    if (isHidden !== /скрыта до вашей/.test(L.meta)) errs.push(`${name}: dossier hidden=${isHidden}, places list «${L.meta}»`);
    if (R && isHidden !== R.chips.some(c => /скрыт/.test(c))) errs.push(`${name}: dossier hidden=${isHidden}, ranking chips ${JSON.stringify(R.chips)}`);
    if (isHidden && R && R.dots.some(t => t.startsWith(partner))) errs.push(`${name}: ${partner}'s dot shows although her/his rating is hidden`);
    if (isHidden && new RegExp(partner + " \\d+/10").test(L.meta + d.trips)) errs.push(`${name}: ${partner}'s year answer shows although hidden`);
    if (name in hidden && hidden[name] !== isHidden) errs.push(`${name}: expected ${hidden[name] ? "" : "not "}hidden on ${current}'s phone`);
    const yR = R && (R.chips.find(c => c.startsWith("год здесь")) || ""), yL = (L.meta.match(/(?:год здесь|здесь год): [^·]*(· [А-Я][а-я]+ \d+\/10)?/) || [""])[0].trim().replace(/^здесь год/, "год здесь");
    if (R && yR !== yL) errs.push(`${name}: year chip «${yR}» in the ranking vs «${yL}» in the places list`);
  }
  assert.deepEqual(errs, [], `${label} (${current}'s phone)`);
  return { rows, list, dos, head };
}

/* ---------- map search ---------- */
async function search(q, remote = false) {
  if ((await hash()) !== "#/map") await nav("Карта");
  await page.waitFor(`(async () => !!(${APP}).world.cities)()`, 8000, "world cities");
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
  await page.waitFor(`!document.getElementById("searchResults").hidden`, 3000, "suggestions for " + q);
  if (remote) {
    await page.tap({ text: "везде", within: "#searchResults" });
    await page.waitFor(`!/Ищу/.test(document.getElementById("searchResults").innerText) && /OpenStreetMap|Ничего|уже есть/.test(document.getElementById("searchResults").innerText)`, 8000, "OSM results for " + q);
  }
  return page.eval(`[...document.querySelectorAll("#searchResults .grp, #searchResults button")].map(e => e.classList.contains("grp") ? "# " + e.textContent.trim() : e.innerText.replace(/\\s+/g, " ").trim())`);
}

async function pick(title, sub) {
  const i = await page.eval(`[...document.querySelectorAll("#searchResults button[data-i]")].findIndex(b => b.childNodes[0].textContent.trim() === ${JSON.stringify(title)} && (b.querySelector("small") || {}).innerText.includes(${JSON.stringify(sub)}))`);
  assert.ok(i >= 0, `no «${title} · ${sub}» among the suggestions`);
  await page.tap({ sel: `#searchResults button[data-i]`, nth: i });
  await page.waitFor(`!document.getElementById("sheet").hidden && (document.querySelector("#sheetBody h3") || {}).innerText === ${JSON.stringify(title)}`, 5000, "sheet of " + title);
}

async function addFromSheet(name) {
  await page.tap({ sel: "#sheetBody button[data-act]", text: "Добавить" });
  const t = await toastText(/Добавлено|уже есть/);
  assert.equal(t, "Добавлено: " + name);
  await page.waitFor(`/кандидат/.test(document.getElementById("sheetBody").innerText) && !!document.querySelector('#sheetBody a[href^="#/place/"]')`, 5000, "place sheet of " + name);
  return page.eval(`(() => { const b = document.getElementById("sheetBody"); return { score: (b.querySelector(".bigscore b") || {}).innerText, line: b.innerText.replace(/\\s+/g, " "), id: decodeURIComponent(b.querySelector('a[href^="#/place/"]').getAttribute("href").slice(8)) }; })()`);
}

/* ---------- rating form ---------- */
async function fillTrip(t, { place = true } = {}) {
  if (place) await page.select("#fPlace", t.place);
  if (t.start) { await page.fill("#fStart", t.start); await page.fill("#fEnd", t.end); }
  for (const k of ["season", "mode", "housing"]) if (t[k]) await press(`[data-opt="${k}"][data-val="${t[k]}"]`, 60);
  for (const [k, v] of Object.entries(t.scores)) await press(`[data-score="${k}"][data-v="${v}"]`, 50);
  if (t.year != null) await press(`[data-year="${t.year}"]`, 50);
  if (t.review) await page.fill("#fReview", t.review);
  if (t.veto) await page.fill("#fVeto", t.veto);
}
async function saveTrip(placeId) {
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 8000, "dossier after saving " + placeId);
  return toastText(/Сохранено|Нет связи/);
}
const formWho = () => page.eval(`(document.querySelector('#fWho [aria-pressed="true"]') || {}).innerText || ""`);
const formPlace = () => page.eval(`document.getElementById("fPlace").value`);
async function editMyTrip(placeId) {
  await openDossier(placeId);
  await page.tap({ text: "Изменить", within: ".trips" });
  await page.waitFor(`!!document.querySelector(".edit-head")`, 4000, "edit form");
}

/* =====================================================================
   Long stories
   ===================================================================== */

test("season start: both phones connect to an almost empty repository, add six places from map search in Latin and Cyrillic, and both phones list the same six places with the same scores on every screen", { skip, timeout: 120000 }, async () => {
  await season(files({ places: [SPB] }), { cold: true });
  // Михаил's phone, first start
  await onPhone("Михаил", "#/map");
  await page.waitFor(`!document.getElementById("sheet").hidden && /Как пользоваться/.test(document.getElementById("sheetBody").innerText)`, 5000, "intro");
  await page.tap({ text: "Понятно", within: "#sheet" });
  assert.equal(await page.text("#syncText"), "Не подключено");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  await page.tap({ sel: "#meSeg button", text: "Михаил" });
  await page.fill('#tokenForm [name="token"]', KEY["Михаил"]);
  await page.tap({ text: "Сохранить и проверить", within: "#tokenForm" });
  const msg = await page.waitFor(`(() => { const t = document.getElementById("tokenMsg").innerText; return /Подключено/.test(t) && t; })()`, 8000, "connected");
  assert.match(msg, /мест 0 и СПб, оценок 0/);
  assert.match(msg, /добавьте первое место/);
  await page.tap({ sel: "#tokenMsg a", text: "добавьте первое место" });
  await page.waitFor(`location.hash === "#/map"`, 3000, "map");

  // six places, three typed in Latin and three in Cyrillic
  const added = {};
  const steps = [
    ["Budva", false, "Будва", "Черногория"],
    ["Porto", false, "Порту", "Португалия"],
    ["Belgrade", false, "Белград", "Сербия"],
    ["Тбилиси", false, "Тбилиси", "Грузия"],
    ["Херцег", true, "Херцег-Нови", "Черногория"],
    ["Бар", true, "Бар", "Черногория"],
  ];
  for (const [q, remote, name, country] of steps) {
    const sugg = await search(q, remote);
    assert.ok(!sugg.includes("# Наши места") || !sugg[sugg.indexOf("# Наши места") + 1].startsWith(name), `${name} is offered as ours before it was added: ${sugg.join(" | ")}`);
    await pick(name, country);
    const a = await addFromSheet(name);
    added[name] = a;
    assert.match(a.line, new RegExp(`${country}.*кандидат`));
    assert.match(a.line, /из 5, где 3 — как в СПб · только мировые данные/, `the new place's card does not say its number is only world data: ${a.line}`);
    const p = (await pins())[name];
    assert.equal(p && p.text, a.score, `${name}: the pin shows ${p && p.text}, the card ${a.score}`);
    await nav("Места");
    const row = (await placeRows())[name];
    assert.ok(row, `${name} is not in the places list right after adding`);
    assert.equal(row.score, a.score, `${name}: places list ${row.score} vs map card ${a.score}`);
    assert.match(row.meta, /кандидат.*только мировые данные/);
  }
  const ids = Object.fromEntries(Object.entries(added).map(([n, a]) => [n, a.id]));
  assert.deepEqual(ids, Object.fromEntries(SIX.map(p => [p.name, p.id])), "place ids differ from what later chapters expect");

  // the same town typed again in Latin is ours now and is not added twice
  const again = await search("Budva");
  const gi = again.indexOf("# Наши места");
  assert.ok(gi >= 0 && again[gi + 1].startsWith("Будва"), `«Budva» is not offered as our place: ${again.join(" | ")}`);
  assert.ok(!again.some((s, i) => s.startsWith("Будва") && i > gi + 1), `«Budva» is also offered as a new city: ${again.join(" | ")}`);
  const f = await files$();
  assert.equal(Object.keys(f).filter(k => k.startsWith("places/")).length, 7, "six new place files next to SPb");
  assert.deepEqual(Object.keys(f).filter(k => k.startsWith("ratings/")), []);

  const m = await agree("six places, no ratings", { counts: { places: 6, ratings: 0, trips: 0 } });
  await nav("Рейтинг");
  await page.shot("c2-season-1-rank-six-places");
  assert.match(await page.text("#rank .empty-row"), /Своих оценок пока нет/);
  assert.ok(await page.eval(`!!document.querySelector('#rank .empty-row a[href="#/rate"]')`), "the empty ranking does not lead to the rating form");
  Object.values(m.dos).forEach(d => assert.match(d.head, /Мы здесь ещё не были/));

  // Вика's phone, first start
  await onPhone("Вика", "#/map");
  await page.waitFor(`!document.getElementById("sheet").hidden`, 5000, "intro on Vika's phone");
  await page.tap({ text: "Понятно", within: "#sheet" });
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  await page.tap({ sel: "#meSeg button", text: "Вика" });
  await page.fill('#tokenForm [name="token"]', KEY["Вика"]);
  await page.tap({ text: "Сохранить и проверить", within: "#tokenForm" });
  const vmsg = await page.waitFor(`(() => { const t = document.getElementById("tokenMsg").innerText; return /Подключено/.test(t) && t; })()`, 8000, "connected");
  assert.match(vmsg, /мест 6 и СПб, оценок 0/);
  assert.match(vmsg, /рейтинг|карта/);
  const v = await agree("Vika sees the six places", { counts: { places: 6, ratings: 0, trips: 0 } });
  for (const name of Object.keys(m.list)) assert.equal(v.list[name].score, m.list[name].score, `${name}: ${v.list[name].score} on Vika's phone, ${m.list[name].score} on Mikhail's`);
  await nav("Оценить");
  assert.equal(await formWho(), "Вика");
  const opts = await page.eval(`[...document.getElementById("fPlace").options].map(o => o.text)`);
  assert.deepEqual(opts.slice(1).map(o => o.split(" · ")[0]).sort(), SIX.map(p => p.name).sort());
  assert.deepEqual(page.takeErrors(), []);
});

test("Вика's first three trips: each saved trip shows the same score and № on her ranking, places list and dossier, while Михаил's phone counts them and keeps every score hidden", { skip, timeout: 120000 }, async () => {
  await season(files());
  await onPhone("Вика", "#/places");
  // trip 1: Порту, from its dossier
  await page.tap({ sel: "#plist a.prow", text: "Порту" });
  await page.waitFor(`location.hash === "#/place/portu"`, 3000, "dossier");
  await page.tap({ sel: "#v-place a.btn", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace").value === "portu"`, 4000, "form for Порту");
  assert.equal(await formWho(), "Вика");
  await fillTrip(TRIP.vPortu, { place: false });
  assert.equal(await page.text('[data-qval="улица"]'), "4.5", "the half point is shown next to the question");
  assert.match(await page.text("#fCounts"), /главные ★ 7 из 10/);
  let t = await saveTrip("portu");
  assert.match(t, /Сохранено/);
  assert.match(t, /Михаил не увидит/);
  await page.waitFor(`!!document.querySelector(".trip.flash")`, 3000, "the new trip is highlighted");
  await page.shot("c2-season-2-vika-first-trip-saved");
  let d = await dossierView("portu");
  assert.match(d.trips, /Вика · 1–14 июня 2026/);
  assert.match(d.trips, /главные вопросы ★: 7 из 10/);
  assert.match(d.trips, /Вика\s*7\/10/);
  assert.match(d.tail, /№1 в рейтинге/);
  await nav("Рейтинг");
  let head = await rankHead();
  assert.deepEqual([head.places, head.ratings, head.trips], [6, 1, 1], head.text);
  let rows = await rankRows();
  assert.equal(rows["Порту"].pos, "1");
  assert.equal(rows["Порту"].score, d.score);
  assert.deepEqual(rows["Порту"].dots.map(x => x.split(":")[0]), ["Вика"]);

  // trip 2: Будва, from the «Оценить» tab
  await nav("Оценить");
  assert.equal(await formPlace(), "", "a fresh form after saving");
  await fillTrip(TRIP.vBudva);
  t = await saveTrip("budva");
  assert.match(t, /Рейтинг обновился/);

  // trip 3: Белград, two years ago, by memory
  await nav("Оценить");
  await fillTrip(TRIP.vBelgrad);
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), true, "a 2024 trip is not marked «по памяти» by itself");
  t = await saveTrip("belgrad");
  assert.match(t, /половин|нужн|хотя бы|ещё \d/, "three ★ answers are not enough, and the message should say what is");
  d = await dossierView("belgrad");
  assert.match(d.trips, /по памяти/);
  assert.match(d.tail, /не в рейтинге/);
  assert.doesNotMatch(d.tail, /№\d/);
  await page.shot("c2-season-2-belgrad-three-stars");
  const saved = await liveRatings();
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.find(r => r.place === "portu").scores, TRIP.vPortu.scores);
  assert.equal(saved.find(r => r.place === "belgrad").retro, true);

  await agree("Vika after three trips", { counts: { places: 6, ratings: 3, trips: 3 }, hidden: { "Порту": false, "Будва": false, "Белград": false } });

  // Михаил opens his app: the trips are counted but nothing of Vika's scores is visible
  await onPhone("Михаил", "#/rank");
  await agree("Mikhail before rating anything", { counts: { places: 6, ratings: 3, trips: 3 }, hidden: { "Порту": true, "Будва": true, "Белград": true } });
  await nav("Рейтинг");
  assert.deepEqual(await mainOrder(), [], "Михаил's main ranking already lists places he has not rated");
  await page.shot("c2-season-2-mikhail-rank-all-hidden");
  // the map card of Порту keeps her review and year to herself
  await search("Порту");
  await pick("Порту", "Португалия");
  const sheet = (await page.text("#sheetBody")).replace(/\s+/g, " ");
  assert.match(sheet, /Оценка Вики скрыта/);
  assert.doesNotMatch(sheet, /влажно|7\/10/);
  // the subcategory table shows dots instead of her numbers
  await openDossier("portu");
  const cells = await page.eval(`[...document.querySelectorAll(".subtable tbody tr:not(.grp)")].map(r => r.children[3] && r.children[3].innerText.trim())`);
  assert.ok(cells.length > 5, "the subcategory table is empty");
  assert.deepEqual([...new Set(cells)], ["·"], "Vika's column shows numbers on Mikhail's phone");
  assert.deepEqual(page.takeErrors(), []);
});

test("Михаил's four trips, one resumed from yesterday's draft: rating a place reveals Вика's rating of it and nothing else, and both phones agree on counts, scores and positions", { skip, timeout: 150000 }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/places");
  // starts Тбилиси, answers three questions and leaves
  await page.tap({ sel: "#plist a.prow", text: "Тбилиси" });
  await page.waitFor(`location.hash === "#/place/tbilisi"`, 3000, "dossier");
  await page.tap({ sel: "#v-place a.btn", text: "Оценить" });
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  const part = { ...TRIP.mTbilisi, scores: { "интернет": 3.5, "улица": 3, "шум": 2.5 }, year: null, review: "" };
  await fillTrip(part, { place: false });
  await nav("Карта");
  // the next day
  await onPhone("Михаил", "#/rate");
  assert.equal(await formPlace(), "tbilisi", "yesterday's draft is gone");
  assert.match(await page.text("#fCounts"), /главные ★ 3 из 10/);
  assert.equal(await page.eval(`document.getElementById("fStart").value`), "2026-09-05");
  await page.shot("c2-season-3-draft-next-day");
  assert.equal((await liveRatings()).length, 3, "a draft must not be written to the repository");
  await fillTrip({ ...TRIP.mTbilisi, start: "", season: "", mode: "", housing: "", scores: { "пешком": 4, "эстетика": 3.5, "язык": 2, "чистота": 2.5, "фонд": 2 } }, { place: false });
  let t = await saveTrip("tbilisi");
  assert.match(t, /Рейтинг обновился/);
  assert.match(t, /Вика не увидит/);
  const tb = (await liveRatings()).find(r => r.place === "tbilisi");
  assert.deepEqual(tb.scores, TRIP.mTbilisi.scores, "the resumed draft lost or changed answers");
  assert.equal(tb.start, "2026-09-05");
  await nav("Рейтинг");
  let head = await rankHead();
  assert.deepEqual([head.ratings, head.trips], [4, 4], head.text);
  assert.deepEqual(await mainOrder(), ["Тбилиси"]);

  // Порту from the map card: Vika's rating opens up
  await search("Порту");
  await pick("Порту", "Португалия");
  assert.match(await page.text("#sheetBody"), /Оценка Вики скрыта/);
  await page.tap({ sel: "#sheetBody a", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace").value === "portu"`, 4000, "form for Порту");
  assert.doesNotMatch(await page.text("#v-rate"), /влажно/, "Vika's review leaks into the form");
  await fillTrip(TRIP.mPortu, { place: false });
  t = await saveTrip("portu");
  assert.doesNotMatch(t, /не увидит/, "Vika has rated Порту, she will see this rating");
  let d = await dossierView("portu");
  assert.match(d.trips, /Михаил · 1–14 июня 2026/);
  assert.match(d.trips, /Вика · 1–14 июня 2026/);
  assert.match(d.trips, /Красиво, но влажно/);
  assert.match(d.head, /Из чего итог: Михаил \d\.\d · Вика \d\.\d/);
  assert.doesNotMatch(d.head, /скрыт/);
  await nav("Рейтинг");
  head = await rankHead();
  assert.deepEqual([head.ratings, head.trips], [5, 4], "a trip we made together is one scouting trip: " + head.text);
  assert.deepEqual((await rankRows())["Порту"].dots.map(x => x.split(":")[0]).sort(), ["Вика", "Михаил"]);

  // Будва from the «Оценить» tab, Херцег-Нови by memory with halves
  await nav("Оценить");
  await fillTrip(TRIP.mBudva);
  await saveTrip("budva");
  await nav("Оценить");
  await fillTrip(TRIP.mHn);
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), true);
  t = await saveTrip("hertseg-novi");
  d = await dossierView("hertseg-novi");
  assert.match(d.trips, /по памяти/);
  assert.match(d.trips, /сезон: пик · не работали · жилой район · по памяти/);
  assert.equal((await liveRatings()).length, 7);

  const mik = await agree("Mikhail after his four trips", { counts: { places: 6, ratings: 7, trips: 5 }, hidden: { "Порту": false, "Будва": false, "Белград": true, "Тбилиси": false, "Херцег-Нови": false } });
  await onPhone("Вика", "#/rank");
  const vik = await agree("Vika after Mikhail's trips", { counts: { places: 6, ratings: 7, trips: 5 }, hidden: { "Порту": false, "Будва": false, "Белград": false, "Тбилиси": true, "Херцег-Нови": true } });
  for (const n of ["Порту", "Будва"]) assert.equal(vik.list[n].score, mik.list[n].score, `${n}: both rated it, yet the phones show ${vik.list[n].score} and ${mik.list[n].score}`);
  assert.deepEqual(page.takeErrors(), []);
});

test("mid-season changes — an edited trip, a deleted trip, place numbers, a rejection and a veto — look the same on every screen of both phones", { skip, timeout: 150000 }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/places");
  // 1. Михаил corrects his Будва trip
  await editMyTrip("budva");
  assert.match(await page.text(".edit-head"), /Правка оценки: Будва · Михаил · 10–24 июля 2026/);
  await press(`[data-score="улица"][data-v="3.5"]`);
  await press(`[data-year="4"]`);
  assert.equal(await page.text("#fSave"), "Сохранить правку");
  let t = await saveTrip("budva");
  assert.match(t, /Сохранено/);
  let r = (await liveRatings()).filter(x => x.place === "budva" && x.who === "Михаил");
  assert.equal(r.length, 1, "editing created a second trip");
  assert.equal(r[0].id, TRIP.mBudva.id);
  assert.equal(r[0].scores["улица"], 3.5);
  assert.equal(r[0].year, 4);
  await nav("Рейтинг");
  let head = await rankHead();
  assert.deepEqual([head.ratings, head.trips], [7, 5], "an edit changed the counts: " + head.text);
  assert.match((await rankRows())["Будва"].chips.join(" "), /Михаил 4\/10/);

  // 2. place numbers for three places
  const typeFacts = async (id, facts) => {
    await openDossier(id);
    for (const [k, v] of Object.entries(facts)) { await page.fill(`#factsForm [name="fact_${k}"]`, String(v)); await page.fill(`#factsForm [name="src_${k}"]`, "объявления"); }
    await page.tap({ text: "Сохранить цифры", within: "#factsForm" });
    await factsSaved();
  };
  await typeFacts("portu", { rent: 950, dinner: 45 });
  let d = await dossierView("portu");
  assert.match(await page.eval(`[...document.querySelectorAll("#factsForm .badge")].map(b => b.innerText).join(" ")`), /\d\.\d \d\.\d/, "two score badges for rent and dinner");
  assert.match(await page.eval(`[...document.querySelectorAll(".subtable tr")].find(r => /Аренда на год/.test(r.innerText)).innerText`), /\d\.\dц/, "the rent score carries the «ц» mark of a score from the place's numbers");
  await typeFacts("budva", { rent: 750 });
  await typeFacts("tbilisi", { rent: 480, tds: 180 });

  // 3. Бар is rejected with a reason
  await openDossier("bar");
  await page.select('#placeForm [name="status"]', "отсев");
  assert.equal(await page.visible("#reasonBox"), true, "choosing «отсев» does not ask for a reason");
  await page.fill('#placeForm [name="reason"]', "мёртвый зимой, всё закрыто");
  await page.tap({ text: "Сохранить карточку", within: "#placeForm" });
  await toastText(/Карточка сохранена/);
  d = await dossierView("bar");
  assert.match(d.tail, /в рейтинг не входит: отсев/);
  assert.match(d.head, /Причина отсева: мёртвый зимой/);
  await agree("Mikhail after edits, numbers and the rejection", { counts: { places: 6, ratings: 7, trips: 5 }, out: { "Бар": true, "Будва": false } });

  // 4. Вика deletes her Белград trip and vetoes Будва
  await onPhone("Вика", "#/places");
  await editMyTrip("belgrad");
  await press("#fDelete");
  assert.equal(await page.text("#fDelete"), "Точно удалить?");
  await press("#fDelete");
  await page.waitFor(`location.hash === "#/place/belgrad"`, 6000, "back to the dossier");
  assert.match(await toastText(/удален/), /Оценка удалена/);
  d = await dossierView("belgrad");
  assert.match(d.head, /Мы здесь ещё не были|только по мировым данным/);
  assert.doesNotMatch(d.trips, /Вика ·/);
  await nav("Рейтинг");
  head = await rankHead();
  assert.deepEqual([head.ratings, head.trips], [6, 4], "after deleting a trip: " + head.text);
  await editMyTrip("budva");
  await page.fill("#fVeto", "толпы и шум всё лето");
  await saveTrip("budva");
  d = await dossierView("budva");
  assert.match(d.head, /Не в рейтинге: вето Вики — толпы и шум всё лето/);
  assert.match(d.tail, /в рейтинг не входит: вето/);
  // her phone shows the numbers Михаил typed
  await openDossier("portu");
  assert.equal(await page.eval(`document.querySelector('#factsForm [name="fact_rent"]').value`), "950");
  const vik = await agree("Vika after the deletion and her veto", { counts: { places: 6, ratings: 6, trips: 4 }, out: { "Бар": true, "Будва": true }, hidden: { "Тбилиси": true, "Херцег-Нови": true, "Белград": false } });
  assert.match(vik.list["Будва"].meta, /вето/);

  // 5. Михаил's phone shows the same picture
  await onPhone("Михаил", "#/rank");
  const mik = await agree("Mikhail after Vika's changes", { counts: { places: 6, ratings: 6, trips: 4 }, out: { "Бар": true, "Будва": true }, hidden: { "Белград": false } });
  await nav("Рейтинг");
  const rank = (await page.text("#rank")).replace(/\s+/g, " ");
  assert.match(rank, /Отсев: .*Бар — мёртвый зимой, всё закрыто/);
  assert.match(rank, /Будва — вето Вики: толпы и шум всё лето/);
  assert.equal(mik.list["Порту"].score, vik.list["Порту"].score, "Порту: both phones see the same trips and numbers");
  assert.deepEqual(page.takeErrors(), []);
});


test("end of season: both save weights; each phone's ranking, places, dossiers and pins follow its own weights, and with «Оба» both phones show the same order and numbers", { skip, timeout: 150000 }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS }));
  await onPhone("Михаил", "#/rank");
  // Михаил gives money more weight and saves it as his
  await page.tap({ sel: "#wsum" });
  assert.match(await page.text("#wsum"), /своих весов ещё никто не сохранил/);
  await page.fill("#w-money", "30");
  assert.match(await page.text("#wsum"), /«Своё»/);
  await press("#wsaveBtn");
  assert.match(await toastText(/Сохранено|Нет связи/), /веса «Михаил»/);
  const wf = JSON.parse((await files$())["weights/mihail.json"] || "null");
  assert.ok(wf && wf.who === "Михаил" && wf.w.money === 30, "Mikhail's weights were not saved as 30 points for money");
  assert.equal(Object.values(wf.w).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText + (b.getAttribute("aria-pressed") === "true" ? "*" : ""))`), ["Поровну", "Михаил*", "Своё"]);
  const mik = await agree("Mikhail with his own weights", { counts: { places: 6, ratings: 6, trips: 4 }, out: { "Бар": true, "Будва": true } });

  // Вика sees his preset, makes hers, and «Оба» appears
  await onPhone("Вика", "#/rank");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText)`), ["Поровну", "Михаил", "Своё"]);
  await page.tap({ sel: "#presets button", text: "Михаил" });
  assert.match(await page.eval(`document.getElementById("wsaveBtn").textContent`), /Сохранить веса «Михаил» как мои \(Вика\)/);
  await page.tap({ sel: "#presets button", text: "Поровну" });
  if (!(await page.eval(`document.getElementById("wdetails").open`))) await page.tap({ sel: "#wsum" });
  await page.fill("#w-nature", "25");
  await page.fill("#w-climate", "20");
  await press("#wsaveBtn");
  assert.match(await toastText(/Сохранено|Нет связи/), /веса «Вика»/);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText)`), ["Поровну", "Михаил", "Вика", "Оба", "Своё"]);
  await agree("Vika with her own weights", { counts: { places: 6, ratings: 6, trips: 4 } });

  // for the decision Вика opens Михаил's hidden trips and both choose «Оба»
  for (const id of ["tbilisi", "hertseg-novi"]) {
    await openDossier(id);
    await page.tap({ text: "Показать всё равно", within: "#v-place .panel.pad" });
    await page.waitFor(`!/скрыт[аы], пока вы не оцените/.test(document.querySelector("#v-place .panel.pad").innerText)`, 3000, "revealed " + id);
  }
  await nav("Рейтинг");
  await page.tap({ sel: "#presets button", text: "Оба" });
  const vOrder = await mainOrder(), vRows = await rankRows();
  const vik = await agree("Vika deciding with «Оба»", { hidden: { "Тбилиси": false, "Херцег-Нови": false } });
  await onPhone("Михаил", "#/rank");
  await page.tap({ sel: "#presets button", text: "Оба" });
  const mOrder = await mainOrder(), mRows = await rankRows();
  await page.shot("c2-season-5-decision-rank-mikhail");
  const mik2 = await agree("Mikhail deciding with «Оба»");
  assert.deepEqual(mOrder, vOrder, "with «Оба» on both phones the ranking order differs");
  assert.ok(mOrder.length >= 3, "three places should be in the main ranking: " + mOrder.join(", "));
  for (const n of mOrder) assert.equal(mRows[n].score, vRows[n].score, `${n}: ${mRows[n].score} on Mikhail's phone, ${vRows[n].score} on Vika's`);
  for (const n of Object.keys(mik2.list)) assert.equal(mik2.list[n].score, vik.list[n].score, `${n} in the places list: ${mik2.list[n].score} vs ${vik.list[n].score}`);
  assert.notDeepEqual(Object.values(mik.list).map(x => x.score), Object.values(mik2.list).map(x => x.score), "switching to «Оба» changed nothing, the test does not prove the weights are used");
  assert.deepEqual(page.takeErrors(), []);
});

/* =====================================================================
   Checkpoints along the season
   ===================================================================== */

const VETOED_BELGRAD = [TRIP.vPortu, TRIP.vBudva, Object.assign({}, TRIP.vBelgrad, { veto: "грязно и шумно, жить не хочу" })];
const rankAll = async () => { await nav("Рейтинг"); return (await page.text("#rank")).replace(/\s+/g, " "); };
const sheetOf = async name => { await search(name); await pick(name, (SIX.find(p => p.name === name) || {}).country || ""); return (await page.text("#sheetBody")).replace(/\s+/g, " "); };

test("on Михаил's phone, when only Вика has rated, the ranking does not claim there are no ratings yet and points to the places waiting for his rating", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/rank");
  const head = await rankHead();
  assert.equal(head.ratings, 3);
  const note = (await page.text("#rank .empty-row")).replace(/\s+/g, " ");
  assert.doesNotMatch(note, /Своих оценок пока нет|оцените первую поездку/, `the header counts 3 ratings, but the note under it says «${note}»`);
  assert.match(note, /Вик[аиы][^.]*скрыт|скрыт[^.]*Вик[аиы]/, `the note does not say Vika's ratings wait for his own: «${note}»`);
});

test("a veto saved on a place we both rated is confirmed as taking it out of the ranking, not as «Рейтинг обновился»", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Вика", "#/places");
  await editMyTrip("budva");
  await page.fill("#fVeto", "толпы и шум всё лето");
  const t = await saveTrip("budva");
  assert.doesNotMatch(t, /Рейтинг обновился|В рейтинг место попадёт/, `after a veto the toast says «${t}»`);
  assert.match(t, /вето|не входит|убран|исключ/i, `the toast does not say the veto took Будва out: «${t}»`);
  assert.match(await rankAll(), /Отсев:.*Будва — вето Вики/);
});

test("when Михаил rates a place Вика vetoed while it was hidden, the confirmation tells him the place is out because of her veto", { skip }, async () => {
  await season(files({ ratings: VETOED_BELGRAD }));
  await onPhone("Михаил", "#/rate/new/belgrad");
  await page.waitFor(`document.getElementById("fPlace").value === "belgrad"`, 4000, "form");
  await fillTrip({ start: "2026-08-03", end: "2026-08-10", season: "пик", mode: "отпуск", housing: "центр", year: 3, scores: { "интернет": 3, "улица": 3, "шум": 2, "пешком": 4, "эстетика": 3, "язык": 4 } }, { place: false });
  const t = await saveTrip("belgrad");
  const d = await dossierView("belgrad");
  assert.match(d.head, /вето Вики/, "the dossier shows the veto once he has rated");
  assert.doesNotMatch(t, /Рейтинг обновился|В рейтинг место попадёт/, `the toast promises a ranking place for a vetoed place: «${t}»`);
  assert.match(t, /вето/i, `the toast does not mention Vika's veto: «${t}»`);
});

test("rating a rejected place does not promise that the ranking was updated or that the place will get in", { skip }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS }));
  await onPhone("Михаил", "#/rate/new/bar");
  await page.waitFor(`document.getElementById("fPlace").value === "bar"`, 4000, "form");
  await fillTrip({ start: "2026-02-10", end: "2026-02-20", season: "худший", mode: "удалёнка", housing: "жилой район", year: 2, scores: { "интернет": 3, "улица": 3, "шум": 4, "пешком": 2, "эстетика": 2.5, "море": 4 } }, { place: false });
  const t = await saveTrip("bar");
  assert.match((await dossierView("bar")).tail, /в рейтинг не входит: отсев/);
  assert.doesNotMatch(t, /Рейтинг обновился|В рейтинг место попадёт/, `the toast after rating a rejected place: «${t}»`);
  assert.match(t, /отсев|не входит/i, `the toast does not say Бар stays out as rejected: «${t}»`);
});

test("a veto Вика saves on a place Михаил has not rated shows on his phone as a veto, or she is told he will not see it until he rates", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Вика", "#/rate/new/tbilisi");
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  const label = (await page.eval(`document.querySelector('label[for="fVeto"]').innerText`)).replace(/\s+/g, " ");
  assert.match(label, /для обоих/, "the veto label promises removal for both of us");
  await fillTrip({ start: "2026-08-01", end: "2026-08-08", season: "худший", mode: "отпуск", housing: "центр", year: 1, scores: { "улица": 3, "шум": 2 }, veto: "летом жара, жить невозможно" }, { place: false });
  const t = await saveTrip("tbilisi");
  await onPhone("Михаил", "#/rank");
  const rank = await rankAll();
  const meta = (await placeRowsVia())["Тбилиси"].meta;
  await nav("Карта");
  const pin = (await pins())["Тбилиси"];
  const seen = /Отсев:.*Тбилиси — вето Вики/.test(rank) && /вето/.test(meta) && pin.out;
  const told = /вето[^.]*(Михаил|не увидит)|Михаил[^.]*вето/.test(t + " " + label);
  assert.ok(seen || told, `Vika was told «${label}» and «${t}», yet on Mikhail's phone Тбилиси is «${meta}», pin faded=${pin.out}, ranking: ${rank.match(/Тбилиси[^·]{0,60}/)?.[0]}`);
});

async function placeRowsVia() { await nav("Места"); return placeRows(); }

test("next day the resumed rating form says it holds an unsaved draft, not a saved rating", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/rate/new/tbilisi");
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  await fillTrip({ start: "2026-09-05", end: "2026-09-26", scores: { "интернет": 3.5, "улица": 3, "шум": 2.5 } }, { place: false });
  await nav("Карта");
  await onPhone("Михаил", "#/rate");
  assert.equal(await formPlace(), "tbilisi");
  const top = (await page.eval(`[...document.querySelectorAll("#fTop, #rateForm .fcard:first-of-type, #rateForm .savebar")].map(e => e.innerText).join(" ")`)).replace(/\s+/g, " ");
  assert.match(top, /черновик|не сохранен|не отправлен/i, `the form shows yesterday's three answers as if it were a fresh or saved rating; nothing says they are an unsaved draft`);
});

test("next day, choosing Порту in a form that still holds yesterday's Тбилиси answers does not silently move those answers to Порту", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/rate/new/tbilisi");
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  await fillTrip({ start: "2026-09-05", end: "2026-09-26", season: "межсезон", scores: { "интернет": 3.5, "улица": 3, "шум": 2.5 } }, { place: false });
  await nav("Карта");
  await onPhone("Михаил", "#/rate");
  await page.select("#fPlace", "portu");
  await sleep(400);
  const state = await page.eval(`({ answers: [...document.querySelectorAll('[data-score][aria-pressed="true"]')].map(b => b.dataset.score), start: document.getElementById("fStart").value, chips: document.getElementById("fTop").innerText.replace(/\\s+/g, " "), msg: document.getElementById("fMsg").innerText })`);
  const parked = /Тбилиси/.test(state.chips) && !state.answers.length;
  const asked = /перенест|Тбилиси/.test(state.msg + " " + state.chips) && /Порту|перенест/.test(state.msg + " " + state.chips);
  assert.ok(parked || asked, `yesterday's Тбилиси answers (${state.answers.join(", ")}) and dates (${state.start}) now belong to Порту without a word; drafts line: «${state.chips}»`);
});

test("next day, after choosing Порту the form says that yesterday's Тбилиси answers wait in a draft, so they do not just vanish", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/rate/new/tbilisi");
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  await fillTrip({ start: "2026-09-05", end: "2026-09-26", scores: { "интернет": 3.5, "улица": 3 } }, { place: false });
  await nav("Карта");
  await onPhone("Михаил", "#/rate");
  assert.equal(await formPlace(), "tbilisi");
  await page.select("#fPlace", "portu");
  await sleep(400);
  const st = await page.eval(`({ answers: document.querySelectorAll('[data-score][aria-pressed="true"]').length, msg: document.getElementById("fMsg").innerText.replace(/\\s+/g, " "), live: document.getElementById("fMsg").getAttribute("role") || document.getElementById("fMsg").getAttribute("aria-live") || "" })`);
  assert.equal(await formPlace(), "portu");
  assert.equal(st.answers, 0, "the Тбилиси answers moved to Порту");
  assert.match(st.msg, /Тбилиси/, `the form went blank with no word about yesterday's answers; message: «${st.msg}»`);
  assert.match(st.msg, /черновик/i, `the message does not say where the answers are: «${st.msg}»`);
  assert.ok(st.live, "the message is not announced to VoiceOver");
  await page.select("#fPlace", "budva");
  await sleep(300);
  assert.doesNotMatch(await page.text("#fMsg"), /Тбилиси/, "the note about Тбилиси stays after an unrelated change of place");
});

test("the dossier of a place with an unsaved draft says so, and «Оценить» there continues that draft", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Михаил", "#/rate/new/tbilisi");
  await page.waitFor(`document.getElementById("fPlace").value === "tbilisi"`, 4000, "form");
  await fillTrip({ start: "2026-09-05", end: "2026-09-26", scores: { "интернет": 3.5, "улица": 3, "шум": 2.5 } }, { place: false });
  await onPhone("Михаил", "#/places");
  const d = await dossierView("tbilisi");
  await nav("Рейтинг");
  assert.equal((await rankHead()).ratings, 3, "a draft must not be counted");
  assert.equal((await placeRowsVia())["Тбилиси"].meta.includes("только мировые данные"), true, "a draft must not change the places list");
  assert.equal((await liveRatings()).length, 3);
  await openDossier("tbilisi");
  await page.tap({ sel: "#v-place a.btn", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate"`, 3000, "form");
  assert.match(await page.text("#fCounts"), /главные ★ 3 из 10/, "«Оценить» in the dossier did not continue the draft");
  assert.match(d.text, /черновик/i, `the dossier says «${d.trips}» although three answers wait in an unsaved draft`);
});

test("a place with 3 of 10 ★ answers says on its dossier, its ranking row and its map card how many more answers it needs to enter the ranking", { skip }, async () => {
  await season(files({ ratings: VIKA3 }));
  await onPhone("Вика", "#/rank");
  const NEED = /(ещё|нужно|нужны|не хватает)[^.·]{0,30}\d|хотя бы (на )?(\d|половин)|\d+ из \d+ нужно|половин[уы] главных/i;
  const miss = [];
  const d = await dossierView("belgrad");
  if (!NEED.test(d.tail)) miss.push(`dossier: «${d.tail}»`);
  await nav("Рейтинг");
  const row = (await rankRows())["Белград"];
  const sub = await page.eval(`(() => { const r = [...document.querySelectorAll("#rank a.row")].find(a => /Белград/.test(a.innerText)); let e = r; while (e && !(e.classList && e.classList.contains("rank-sub"))) e = e.previousElementSibling; return e ? e.innerText : ""; })()`);
  if (!NEED.test(row.chips.join(" ") + " " + sub)) miss.push(`ranking: chips ${JSON.stringify(row.chips)} under «${sub}»`);
  const sheet = await sheetOf("Белград");
  if (!NEED.test(sheet)) miss.push(`map card: «${sheet.slice(0, 160)}»`);
  assert.deepEqual(miss, [], "the user sees «3 из 10» but not that 5 are needed");
});

test("two ratings of one trip whose dates differ by a day count as one scouting trip", { skip }, async () => {
  await season(files({ ratings: [TRIP.vBudva, Object.assign({}, TRIP.mBudva, { start: "2026-07-11" })] }));
  await onPhone("Михаил", "#/rank");
  const head = await rankHead();
  assert.equal(head.ratings, 2);
  assert.equal(head.trips, 1, `Vika arrived on 10 July and Mikhail wrote 11 July for the same trip, yet the header says «${head.text.replace(/\s+/g, " ")}»`);
});

test("with different saved weights on the two phones, the dossier and the places list say whose weights their totals use", { skip }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS, weights: [W_MIKHAIL, W_VIKA] }), { local: { "Михаил": { preset: "Михаил" }, "Вика": { preset: "Вика", revealed: ["tbilisi", "hertseg-novi"] } } });
  await onPhone("Михаил", "#/places");
  const mList = await placeRows();
  const mD = await dossierView("portu");
  const mHead = (await page.text("#v-places header")).replace(/\s+/g, " ");
  await onPhone("Вика", "#/places");
  const vList = await placeRows();
  const vD = await dossierView("portu");
  const vHead = (await page.text("#v-places header")).replace(/\s+/g, " ");
  assert.notEqual(mList["Порту"].score, vList["Порту"].score, "precondition: the two phones show different totals for Порту");
  const miss = [];
  if (!/вес[аы]?[^.]{0,20}«Михаил»|«Михаил»[^.]{0,20}вес/.test(mD.head)) miss.push(`Mikhail's dossier: «${mD.tail}»`);
  if (!/вес[аы]?[^.]{0,20}«Вика»|«Вика»[^.]{0,20}вес/.test(vD.head)) miss.push(`Vika's dossier: «${vD.tail}»`);
  if (!/вес/.test(mHead)) miss.push(`Mikhail's places list: «${mHead}»`);
  if (!/вес/.test(vHead)) miss.push(`Vika's places list: «${vHead}»`);
  assert.deepEqual(miss, [], `Порту is ${mList["Порту"].score} on Mikhail's phone and ${vList["Порту"].score} on Vika's, and nothing outside the ranking says why`);
});

test("a finalist is marked as one in the ranking, where the decision is made", { skip }, async () => {
  const places = LATE_PLACES.map(p => p.id === "portu" ? Object.assign({}, p, { status: "финалист" }) : p);
  await season(files({ places, ratings: LATE_RATINGS }));
  await onPhone("Михаил", "#/places");
  assert.match((await placeRows())["Порту"].meta, /финалист/);
  await nav("Рейтинг");
  const row = (await rankRows())["Порту"];
  assert.ok(row.chips.some(c => /финалист/.test(c)), `the ranking row of a finalist shows only ${JSON.stringify(row.chips)}`);
});

test("the dossier says what «заполнено N%» next to the total is a share of", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/place/portu");
  const d = await dossierView("portu");
  assert.match(d.tail, /заполнено \d+%/);
  assert.match(d.text, /заполнено[^.]{0,40}(групп|данн)|(групп|данн)[^.]{0,40}заполнено|доля групп/i, `«${d.tail}»: nothing on the dossier says what is «заполнено»`);
});

test("Вика revealing Михаил's two places with «Показать всё равно» puts them into her ranking at the same № as on his phone", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/rank");
  const m = await rankRows();
  await onPhone("Вика", "#/rank");
  assert.ok(!(await mainOrder()).includes("Тбилиси"), "Тбилиси is hidden from Vika at first");
  for (const id of ["tbilisi", "hertseg-novi"]) {
    await openDossier(id);
    await page.tap({ text: "Показать всё равно", within: "#v-place .panel.pad" });
    await page.waitFor(`!/скрыт[аы], пока вы не оцените/.test(document.querySelector("#v-place .panel.pad").innerText)`, 3000, "revealed");
  }
  await nav("Рейтинг");
  const v = await rankRows();
  for (const n of ["Порту", "Будва", "Тбилиси", "Херцег-Нови"]) {
    assert.equal(v[n].pos, m[n].pos, `${n}: №${v[n].pos} on Vika's phone, №${m[n].pos} on Mikhail's`);
    assert.equal(v[n].score, m[n].score, `${n}: ${v[n].score} vs ${m[n].score}`);
  }
  assert.deepEqual(v["Тбилиси"].dots.map(x => x.split(":")[0]), ["Михаил"]);
});

test("a rent typed on Михаил's phone shows the same badge, subcategory score and total on Вика's phone", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/place/portu");
  await page.fill('#factsForm [name="fact_rent"]', "950");
  await page.fill('#factsForm [name="src_rent"]', "idealista, 20 объявлений");
  await page.tap({ text: "Сохранить цифры", within: "#factsForm" });
  await factsSaved();
  const read = async () => { const d = await dossierView("portu"); return { score: d.score, badge: await page.eval(`(document.querySelector("#factsForm .badge") || {}).innerText || ""`), cell: await page.eval(`[...document.querySelectorAll(".subtable tr")].find(r => /Аренда на год/.test(r.innerText)).innerText.replace(/\\s+/g, " ")`), src: await page.eval(`document.querySelector('#factsForm [name="src_rent"]').value`) }; };
  const m = await read();
  assert.match(m.badge, /^\d\.\d$/);
  assert.ok(m.cell.includes(m.badge), `the rent badge ${m.badge} and the subcategory row «${m.cell}» disagree`);
  await onPhone("Вика", "#/places");
  const v = await read();
  assert.deepEqual(v, m, "the two phones show the rent differently");
  assert.equal((await placeRowsVia())["Порту"].score, m.score);
});

test("rejecting a place on Вика's phone shows the reason on Михаил's ranking, places list, map card and dossier", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Вика", "#/place/belgrad");
  await page.select('#placeForm [name="status"]', "отсев");
  await page.fill('#placeForm [name="reason"]', "дорого и далеко от моря");
  await page.tap({ text: "Сохранить карточку", within: "#placeForm" });
  await toastText(/Карточка сохранена/);
  await onPhone("Михаил", "#/rank");
  assert.match(await rankAll(), /Отсев:.*Белград — дорого и далеко от моря/);
  assert.match((await placeRowsVia())["Белград"].meta, /отсев/);
  assert.match(await sheetOf("Белград"), /Отсев: дорого и далеко от моря/);
  const d = await dossierView("belgrad");
  assert.match(d.head, /Причина отсева: дорого и далеко от моря/);
  assert.match(d.tail, /в рейтинг не входит: отсев/);
});

test("Вика's veto on a place we both rated reaches Михаил's map card with who vetoed and why", { skip }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS }));
  await onPhone("Михаил", "#/map");
  const s = await sheetOf("Будва");
  assert.match(s, /вето/);
  assert.match(s, /Вето Вики: толпы и шум всё лето/);
  await nav("Карта");
  assert.equal((await pins())["Будва"].out, true, "the Будва pin is not faded");
});

test("a red flag in Вика's hidden rating is only counted on Михаил's phone, and appears with her number once he rates the place", { skip }, async () => {
  const vBudva = Object.assign({}, TRIP.vBudva, { scores: Object.assign({}, TRIP.vBudva.scores, { "шум": 1.5 }) });
  await season(files({ ratings: [TRIP.vPortu, vBudva] }));
  await onPhone("Михаил", "#/rank");
  let flags = (await page.text("#v-rank .flags")).replace(/\s+/g, " ");
  assert.doesNotMatch(flags, /Будва|1\.5/, "Vika's flag leaks before Mikhail rated Будва: " + flags);
  assert.match(flags, /появятся после вашей оценки/);
  await nav("Оценить");
  await fillTrip(TRIP.mBudva);
  await saveTrip("budva");
  await nav("Рейтинг");
  flags = (await page.text("#v-rank .flags")).replace(/\s+/g, " ");
  assert.match(flags, /Будва .{0,30}Шум ночью у жилья/, "flags are grouped under the place name");
  assert.match(flags, /Вика ставит 1\.5/);
  assert.doesNotMatch(flags, /скрыт/);
});

test("the «год здесь» answers read the same on the map card, the ranking, the places list and the dossier", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/rank");
  const r = (await rankRows())["Порту"].chips.find(c => c.startsWith("год здесь"));
  assert.equal(r, "год здесь: Михаил 8/10 · Вика 7/10");
  assert.match((await placeRowsVia())["Порту"].meta, /прожили бы здесь год: Михаил 8\/10 · Вика 7\/10/);
  assert.match(await sheetOf("Порту"), /прожили бы здесь год: Михаил 8\/10 · Вика 7\/10/);
  const d = await dossierView("portu");
  assert.match(d.trips, /Прожили бы здесь год\? Михаил 8\/10 Вика 7\/10/);
});

test("a trip Михаил edits shows its new review and answers on Вика's phone the next time she opens the app", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Вика", "#/place/portu");
  const before = await dossierView("portu");
  await onPhone("Михаил", "#/places");
  await editMyTrip("portu");
  await page.fill("#fReview", "Хочу сюда снова, но зимой сыро.");
  await press(`[data-score="фонд"][data-v="2"]`);
  await saveTrip("portu");
  const m = await dossierView("portu");
  await onPhone("Вика", "#/rank");
  const v = await dossierView("portu");
  assert.match(v.trips, /Хочу сюда снова, но зимой сыро/);
  assert.equal(v.score, m.score);
  assert.equal((v.trips.match(/Михаил ·/g) || []).length, 1, "the edit shows up as a second trip");
  assert.notEqual(v.trips, before.trips, "Vika's dossier did not change after Mikhail's edit");
  await nav("Рейтинг");
  assert.equal((await rankHead()).ratings, 7, "an edit changed the number of ratings");
});

test("on a 1280 desktop in dark mode the end-of-season screens agree with each other and with the phone", { skip, timeout: 120000 }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS, weights: [W_MIKHAIL, W_VIKA] }), { local: { "Михаил": { preset: "Оба" } } });
  await onPhone("Михаил", "#/rank");
  const phone = await agree("phone", { counts: { places: 6, ratings: 6, trips: 4 }, out: { "Бар": true, "Будва": true } });
  await onPhone("Михаил", "#/rank", { w: 1280, h: 800, dark: true });
  const desk = await agree("desktop dark", { counts: { places: 6, ratings: 6, trips: 4 }, out: { "Бар": true, "Будва": true } });
  for (const n of Object.keys(phone.list)) assert.equal(desk.list[n].score, phone.list[n].score, `${n}: ${desk.list[n].score} on the computer, ${phone.list[n].score} on the phone`);
  await nav("Рейтинг");
  await page.shot("c2-season-desktop-dark-rank");
  const lay = await page.eval(`(() => ({ over: document.documentElement.scrollWidth - innerWidth, rows: [...document.querySelectorAll("#rank a.row")].map(a => { const n = a.querySelector(".name").getBoundingClientRect(), s = a.querySelector(".score").getBoundingClientRect(); return Math.abs(n.top - s.top) < 30; }) }))()`);
  assert.ok(lay.over <= 1, "the page scrolls sideways");
  assert.ok(lay.rows.every(Boolean), "a ranking row wraps its score below the name");
  await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE });
});

test("each person's own total reads the same on the map card, in the ranking dots and in the dossier's «Из чего итог»", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Вика", "#/rank");
  const dots = Object.fromEntries((await rankRows())["Порту"].dots.map(t => t.split(": ")));
  assert.deepEqual(Object.keys(dots).sort(), ["Вика", "Михаил"]);
  const sheet = await sheetOf("Порту");
  const d = await dossierView("portu");
  for (const [who, v] of Object.entries(dots)) {
    assert.match(sheet, new RegExp(`${who} ${v.replace(".", "\\.")}`), `${who}: ${v} on the ranking dot, map card «${sheet.slice(0, 200)}»`);
    assert.match(d.head, new RegExp(`${who} ${v.replace(".", "\\.")}`), `${who}: ${v} on the ranking dot, dossier «${d.head.slice(0, 200)}»`);
  }
});

test("a place Михаил adds mid-season shows up on Вика's map, places list and rating form with the same world-data score", { skip }, async () => {
  await season(files({ ratings: ALL7 }));
  await onPhone("Михаил", "#/map");
  await search("Kotor");
  await pick("Котор", "Черногория");
  const a = await addFromSheet("Котор");
  assert.match(a.line, /только мировые данные/);
  await nav("Рейтинг");
  assert.equal((await rankHead()).places, 7);
  await onPhone("Вика", "#/map");
  assert.equal((await pins())["Котор"].text, a.score, "the new pin on Vika's map");
  const row = (await placeRowsVia())["Котор"];
  assert.equal(row.score, a.score);
  assert.match(row.meta, /кандидат.*только мировые данные/);
  await nav("Рейтинг");
  assert.equal((await rankHead()).places, 7);
  await nav("Оценить");
  assert.ok(await page.eval(`[...document.getElementById("fPlace").options].some(o => o.text === "Котор · Черногория")`), "Котор is not offered in Vika's rating form");
});

test("the rating form's place list marks a rejected place, so nobody rates Бар by mistake thinking it is still a candidate", { skip }, async () => {
  await season(files({ places: LATE_PLACES, ratings: LATE_RATINGS }));
  await onPhone("Михаил", "#/rate");
  const opts = await page.eval(`[...document.getElementById("fPlace").options].map(o => o.text)`);
  const bar = opts.find(o => o.startsWith("Бар"));
  assert.ok(bar, "Бар is not offered at all: " + opts.join(" | "));
  assert.match(bar, /отсев/, `the option reads «${bar}», the same as live candidates like «${opts.find(o => o.startsWith("Порту"))}»`);
});
