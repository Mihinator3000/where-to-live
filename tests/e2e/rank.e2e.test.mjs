import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, mockFiles, PLACES, RATINGS } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- synthetic data ---------- */
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const SPB = PLACES[0];
const place = (id, name, extra = {}) => Object.assign({ id, name, country: "Тестия", cc: "", lat: null, lon: null, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-08-01", end: "2026-08-20", days: 20, season: "пик", mode: "удалёнка", housing: "жилой район", retro: false, year: 7, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);
const stars = (v, n = STAR.length) => Object.fromEntries(STAR.slice(0, n).map(k => [k, v]));
const sc = o => Object.assign(stars(3.5), o);
const W0 = { legal: 0, money: 0, work: 0, health: 0, safety: 0, climate: 0, housing: 0, city: 0, nature: 0, people: 0, links: 0 };
const MIKHAIL_W = { id: "mihail", who: "Михаил", w: { ...W0, work: 50, health: 10, safety: 10, housing: 10, city: 10, people: 10 } };
const VIKA_W = { id: "vika", who: "Вика", w: { ...W0, nature: 50, health: 10, safety: 10, housing: 10, city: 10, people: 10 } };

// Альфа wins on work (internet), Гамма on nature (sea); Омега is clearly worse whatever the weights.
const DUO = {
  places: [SPB, place("alfa", "Альфа"), place("gamma", "Гамма"), place("omega", "Омега")],
  ratings: [
    rating("a1", "alfa", "Михаил", sc({ "интернет": 5, "море": 2 })), rating("a2", "alfa", "Вика", sc({ "интернет": 5, "море": 2 })),
    rating("g1", "gamma", "Михаил", sc({ "интернет": 2, "море": 4.9 })), rating("g2", "gamma", "Вика", sc({ "интернет": 2, "море": 4.9 })),
    rating("o1", "omega", "Михаил", stars(2)), rating("o2", "omega", "Вика", stars(2.2)),
  ],
};
const duo = (weights = []) => repo({ places: DUO.places, ratings: DUO.ratings, weights });

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open({ w = 390, h = 844, dark = false, hash = "#/rank", ...o } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, Object.assign({ hash }, o));
  page.takeErrors();
}

async function reload() {
  await page.eval("window.__beforeReload = 1; location.reload()");
  await page.waitFor(`!window.__beforeReload && document.readyState === "complete" && document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app reloaded");
  await sleep(150);
}

const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const mainRows = () => page.eval(`[...document.querySelectorAll("#rank a.row:not(.pale)")].filter(r => r.querySelector(".pos").innerText.trim() !== "—").map(r => r.querySelector(".name b").innerText)`);
const paleRows = () => page.eval(`[...document.querySelectorAll("#rank a.row.pale")].map(r => r.querySelector(".name b").innerText)`);
const rowOf = name => page.eval(`(() => { const r = [...document.querySelectorAll("#rank a.row")].find(r => r.querySelector(".name b").innerText === ${JSON.stringify(name)}); return r ? { pos: r.querySelector(".pos").innerText.trim(), score: r.querySelector(".score").innerText.split("\\n")[0].trim(), chips: [...r.querySelectorAll(".chip")].map(c => c.innerText), dots: [...r.querySelectorAll(".dot")].map(d => d.className.replace("dot", "").trim()), href: r.getAttribute("href") } : null; })()`);
const presetNames = () => page.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText.trim())`);
const pressed = () => page.eval(`[...document.querySelectorAll("#presets button[aria-pressed=true]")].map(b => b.innerText.trim()).join(",")`);
const shareNums = () => page.eval(`[...document.querySelectorAll("#wgrid .wrow")].map(r => ({ g: r.querySelector("input").dataset.g, n: Number(r.querySelector(".num").textContent), v: Number(r.querySelector("input").value) }))`);
const heatNames = () => page.eval(`[...document.querySelectorAll(".heat tbody th.rowh")].map(t => t.innerText.trim())`);
const plist = () => page.eval(`[...document.querySelectorAll("#plist a.prow")].map(r => ({ name: r.querySelector("b").innerText, score: r.querySelector(".score").innerText, meta: [...r.querySelectorAll(".meta span")].map(s => s.innerText) }))`);
const files = async prefix => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)]);

async function openWeights() {
  if (!(await page.eval(`document.getElementById("wdetails").open`))) await page.tap({ sel: "#wsum" });
  await page.waitFor(`document.getElementById("wdetails").open`, 2000, "weights panel open");
}

// Taps a weight slider at a fraction of its width, the way a finger would.
async function slide(group, frac) {
  const r = await page.eval(`(() => { const e = document.getElementById("w-${group}"); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); const x = b.left + b.width * ${frac}, y = b.top + b.height / 2; return { x, y, hit: document.elementFromPoint(x, y) === e }; })()`);
  assert.ok(r.hit, `slider ${group} is not covered`);
  await page.click(r.x, r.y);
  await sleep(200);
}

const CONTRAST = sel => `(() => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, bot) => [0, 1, 2].map(i => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  const bgOf = e => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } } let b = rgba(getComputedStyle(document.body).backgroundColor); for (let i = layers.length - 1; i >= 0; i--) b = over(layers[i], b); return b; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.innerText.trim()).map(e => { const bg = bgOf(e); return { t: e.innerText.trim(), r: Math.round(ratio(over(rgba(getComputedStyle(e).color), bg), bg) * 100) / 100 }; });
})()`;

const AUDIT = `(() => {
  const out = { unnamed: [], small: [], covered: [], overflow: document.documentElement.scrollWidth - innerWidth };
  const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = e => (e.getAttribute("aria-label") || e.title || e.innerText || e.value || e.placeholder || (e.id && document.querySelector('label[for="' + e.id + '"]')?.innerText) || e.closest("label")?.innerText || "").trim();
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "")) + " «" + name(e).slice(0, 30) + "»";
  const view = document.querySelector(".view:not([hidden])");
  for (const e of [...view.querySelectorAll("button, a[href], input, select, textarea, summary")].filter(vis)) {
    if (!name(e)) out.unnamed.push(desc(e));
    const inline = e.tagName === "A" && getComputedStyle(e).display === "inline" || e.classList.contains("linkbtn");
    const r = e.getBoundingClientRect();
    if (!inline && !["checkbox", "radio", "range"].includes(e.type) && Math.min(r.width, r.height) < 24) out.small.push(desc(e) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();
    const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !(e.tagName === "INPUT" && hit.closest("label") === e.closest("label"))) out.covered.push(desc(e) + " under " + (hit.id ? "#" + hit.id : hit.className || hit.tagName));
  }
  scrollTo(0, 0);
  return out;
})()`;

/* ---------- ranking: what is listed ---------- */

test("fully answered places are ranked by score with position, score out of 5 and a dot for each of us", { skip }, async () => {
  await open({ files: duo() });
  assert.deepEqual(await mainRows(), ["Альфа", "Гамма", "Омега"]);
  const a = await rowOf("Альфа"), o = await rowOf("Омега");
  assert.equal(a.pos, "1");
  assert.equal(o.pos, "3");
  assert.match(a.score, /^\d\.\d$/);
  assert.ok(Number(a.score) > Number(o.score));
  assert.deepEqual(a.dots, ["m", "v"], "both people's dots on the track");
  assert.equal(o.href, "#/place/omega");
  assert.deepEqual(page.takeErrors(), []);
});

test("SPb is shown as the base: no rank number, a «база» chip and exactly 3.0 by definition", { skip }, async () => {
  await open({ files: duo() });
  const s = await rowOf("Санкт-Петербург");
  assert.equal(s.pos, "—");
  assert.equal(s.score, "3.0");
  assert.deepEqual(s.chips, ["база"]);
  assert.match(await page.text("#rank"), /3\.0\s*всегда/);
  assert.ok(!(await mainRows()).includes("Санкт-Петербург"));
});

test("places with fewer than half of the star questions answered go to the pale block with their answer count", { skip }, async () => {
  await open();
  assert.deepEqual(await mainRows(), []);
  const pale = await paleRows();
  assert.deepEqual([...pale].sort(), ["Батуми", "Белград", "Валенсия", "Порту", "Тбилиси"].sort());
  assert.match(await page.text("#rank"), /Мало своих оценок/i);
  assert.ok((await rowOf("Порту")).chips.includes("своих ответов на ★: 4 из 10"));
  assert.ok((await rowOf("Батуми")).chips.includes("только мировые данные"));
  assert.equal((await rowOf("Порту")).pos, "·", "pale rows have no rank number");
});

test("when we have some answers but no place has half of the star questions yet, the ranking does not say we have no ratings", { skip }, async () => {
  await open();
  const t = await page.text("#rank");
  assert.match(t, /своих ответов на ★: 4 из 10/, "Порту has four of our answers");
  assert.doesNotMatch(t, /Своих оценок пока нет/, "the empty-list message contradicts the rows right below it");
});

test("a place only my partner rated says her rating is hidden, and revealing it in the dossier moves it into the main list", { skip }, async () => {
  const files = repo({ places: [SPB, place("alfa", "Альфа", { cc: "PRT", country: "Португалия" })], ratings: [rating("v1", "alfa", "Вика", stars(4.5))] });
  await open({ files });
  assert.deepEqual(await mainRows(), []);
  assert.ok((await rowOf("Альфа")).chips.includes("оценка Вики скрыта до вашей оценки"));
  await page.tap({ sel: "#rank a.row", text: "Альфа" });
  await page.waitFor(`location.hash === "#/place/alfa"`, 3000, "dossier");
  await page.tap({ text: "Показать всё равно" });
  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  await page.waitFor(`location.hash === "#/rank"`);
  assert.deepEqual(await mainRows(), ["Альфа"]);
  const a = await rowOf("Альфа");
  assert.equal(a.pos, "1");
  assert.ok(!a.chips.some(c => /скрыта/.test(c)));
  assert.deepEqual(a.dots, ["v"]);
});

test("a place only my partner rated is not listed as having no ratings when world data is off", { skip }, async () => {
  await open({ local: { "wtl:worldData": false } });
  const t = await page.text("#rank");
  const unrated = (t.match(/Ещё без оценок и данных:([^\n]*)/) || [, ""])[1];
  assert.match(unrated, /Батуми/, "Батуми really has no ratings");
  assert.doesNotMatch(unrated, /Тбилиси/, "Вика rated Тбилиси — it is hidden, not unrated");
  assert.match(t, /Тбилиси[^\n]*скрыт|скрыт[^\n]*Тбилиси/, "the ranking says Вика's rating of Тбилиси is hidden, like the places list does");
});

test("places with too little data are listed with their fill share and open the dossier", { skip }, async () => {
  await open({ local: { "wtl:worldData": false } });
  const thin = await page.text("#rank");
  for (const re of [/Мало данных/, /меньше 50%/, /Валенсия\D{1,4}45%/, /Порту\D{1,4}36%/]) assert.match(thin, re, `«${thin}»`);
  await page.tap({ sel: "#rank .empty-row a", text: "Порту" });
  await page.waitFor(`location.hash === "#/place/porto"`, 3000, "dossier");
});

test("rejected and vetoed places are not ranked but listed under «Отсев» with the reason", { skip }, async () => {
  const files = repo({
    places: [...DUO.places, place("delta", "Дельта", { status: "отсев", reason: "дорого" }), place("eta", "Эта", { status: "отсев" }), place("zeta", "Зета")],
    ratings: [...DUO.ratings, rating("z1", "zeta", "Михаил", stars(4.8), { veto: "шумно" })],
  });
  await open({ files });
  const rows = await page.eval(`[...document.querySelectorAll("#rank a.row b")].map(b => b.innerText)`);
  for (const n of ["Дельта", "Эта", "Зета"]) assert.ok(!rows.includes(n), n + " is not ranked");
  const t = await page.text("#rank");
  assert.match(t, /Отсев: .*Дельта — дорого/);
  assert.match(t, /Эта — без причины/);
  assert.match(t, /Зета — вето Михаила: шумно/);
  await page.tap({ sel: "#rank .empty-row a", text: "Зета" });
  await page.waitFor(`location.hash === "#/place/zeta"`, 3000, "dossier");
});

test("the counts line shows places, ratings and scouting trips, counting a trip we made together once", { skip }, async () => {
  await open();
  assert.match(await page.text("#v-rank header"), /Мест: 5 · оценок: 4 · поездок-разведок: 3 из 20/);
});

test("tapping a ranking row on a phone opens that place's dossier", { skip }, async () => {
  await open({ files: duo() });
  await page.tap({ sel: "#rank a.row", text: "Гамма" });
  await page.waitFor(`location.hash === "#/place/gamma"`, 3000, "dossier");
  assert.match(await page.text("#v-place"), /Гамма/);
  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  await page.tap({ sel: "#rank a.row", text: "Санкт-Петербург" });
  await page.waitFor(`location.hash === "#/place/sankt-peterburg"`, 3000, "SPb dossier");
});

/* ---------- presets ---------- */

test("with no saved weights only «Поровну» and «Своё» are offered and the panel says nobody has saved weights", { skip }, async () => {
  await open({ files: duo() });
  assert.deepEqual(await presetNames(), ["Поровну", "Своё"]);
  assert.equal(await pressed(), "Поровну");
  assert.match(await page.text("#wsum"), /«Поровну» · своих весов ещё никто не сохранил/);
});

test("a person who saved weights gets a preset, and «Оба» appears once both of us have", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W]) });
  assert.deepEqual(await presetNames(), ["Поровну", "Михаил", "Своё"]);
  await open({ files: duo([MIKHAIL_W, VIKA_W]) });
  assert.deepEqual(await presetNames(), ["Поровну", "Михаил", "Вика", "Оба", "Своё"]);
  assert.doesNotMatch(await page.text("#wsum"), /никто не сохранил/);
});

test("picking a person's preset re-ranks the places by that person's weights and marks the button", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W, VIKA_W]) });
  await page.tap({ sel: "#presets button", text: "Вика" });
  assert.equal(await pressed(), "Вика");
  assert.match(await page.text("#wsum"), /«Вика»/);
  assert.deepEqual(await mainRows(), ["Гамма", "Альфа", "Омега"], "Вика weighs nature, Гамма has the sea");
  await page.tap({ sel: "#presets button", text: "Михаил" });
  assert.equal(await pressed(), "Михаил");
  assert.deepEqual(await mainRows(), ["Альфа", "Гамма", "Омега"], "Михаил weighs work, Альфа has the internet");
  await page.tap({ sel: "#presets button", text: "Оба" });
  assert.equal(await pressed(), "Оба");
  await openWeights();
  const n = Object.fromEntries((await shareNums()).map(x => [x.g, x.n]));
  assert.equal(n.work, 25, "«Оба» averages both people's weights");
  assert.equal(n.nature, 25);
  assert.deepEqual(page.takeErrors(), []);
});

test("the chosen preset is still selected after reopening the app", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W, VIKA_W]) });
  await page.tap({ sel: "#presets button", text: "Вика" });
  await reload();
  assert.equal(await pressed(), "Вика");
  assert.deepEqual(await mainRows(), ["Гамма", "Альфа", "Омега"]);
});

test("on a new device the default preset is the same on first open and after reopening", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W, VIKA_W]) });
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "loaded");
  const first = await pressed();
  const firstScores = await page.eval(`[...document.querySelectorAll("#rank a.row .score")].map(s => s.innerText.split("\\n")[0]).join(",")`);
  await reload();
  const again = await pressed();
  assert.equal(first, again, `first open shows «${first}», reopening shows «${again}» — nobody changed anything`);
  assert.equal(await page.eval(`[...document.querySelectorAll("#rank a.row .score")].map(s => s.innerText.split("\\n")[0]).join(",")`), firstScores);
});

test("a range chip shows when a place's position depends on the weights, and the help explains it", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W, VIKA_W]) });
  assert.ok((await rowOf("Альфа")).chips.includes("№1–2 в зависимости от весов"));
  assert.ok((await rowOf("Гамма")).chips.includes("№1–2 в зависимости от весов"));
  assert.ok(!(await rowOf("Омега")).chips.some(c => c.startsWith("№")), "Омега is last whatever the weights");
  await page.tap({ sel: ".rank-help summary" });
  assert.match(await page.text(".rank-help"), /в зависимости от весов» — место может сдвинуться/);
});

test("a fill chip shows how much of the weighted groups has data when it is below 70%", { skip }, async () => {
  await open({ files: duo() });
  assert.ok((await rowOf("Альфа")).chips.includes("заполнено 64%"), "no world data: 7 of 11 groups answered");
  await open({ files: duo([MIKHAIL_W]) });
  await page.tap({ sel: "#presets button", text: "Михаил" });
  assert.ok(!(await rowOf("Альфа")).chips.some(c => c.startsWith("заполнено")), "Михаил's weights only use answered groups");
});

/* ---------- weights panel ---------- */

test("the weights panel opens on tap and stays open after reopening; closing it is remembered too", { skip }, async () => {
  await open({ files: duo() });
  const sliderShown = () => page.eval(`(() => { const e = document.getElementById("w-legal"); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === e; })()`);
  assert.equal(await page.eval(`document.getElementById("wdetails").open`), false);
  assert.equal(await sliderShown(), false, "sliders are tucked away at first");
  await page.tap({ sel: "#wsum" });
  assert.equal(await sliderShown(), true, "sliders show after tapping the summary");
  await reload();
  assert.equal(await page.eval(`document.getElementById("wdetails").open`), true, "still open after reopening");
  await page.tap({ sel: "#wsum" });
  await reload();
  assert.equal(await page.eval(`document.getElementById("wdetails").open`), false, "still closed after reopening");
});

test("«Поровну» gives every group the same share and the shares add up to 100", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  const s = await shareNums();
  assert.equal(s.length, 11);
  assert.equal(s.reduce((a, x) => a + x.n, 0), 100);
  assert.ok(s.every(x => x.n === 9 || x.n === 10), JSON.stringify(s.map(x => x.n)));
  assert.ok(s.every(x => x.n === x.v), "number next to each slider matches the slider");
});

test("moving a slider rebalances the other groups to keep 100, switches to «Своё» and re-ranks at once", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  assert.deepEqual(await mainRows(), ["Альфа", "Гамма", "Омега"]);
  await slide("nature", 0.8);
  const s = await shareNums();
  const nature = s.find(x => x.g === "nature");
  assert.ok(nature.n >= 75 && nature.n <= 85, "nature ≈ 80, got " + nature.n);
  assert.equal(s.reduce((a, x) => a + x.n, 0), 100, "shares still add up to 100");
  assert.ok(s.every(x => x.n === x.v), "every number matches its slider");
  assert.equal(await pressed(), "Своё");
  assert.equal(await page.text("#wsum"), "Веса групп: «Своё»");
  assert.deepEqual(await mainRows(), ["Гамма", "Альфа", "Омега"], "Гамма has the sea");
  assert.deepEqual(page.takeErrors(), []);
});

test("pushing one group to 100 zeroes the rest, and lowering it again spreads the freed points evenly", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  await page.fill("#w-work", "100");
  let s = await shareNums();
  assert.deepEqual(s.filter(x => x.g !== "work").map(x => x.n), Array(10).fill(0));
  assert.equal(s.find(x => x.g === "work").n, 100);
  assert.match(await page.text("#rank"), /Альфа/);
  await page.fill("#w-work", "30");
  s = await shareNums();
  assert.equal(s.reduce((a, x) => a + x.n, 0), 100);
  assert.deepEqual(s.filter(x => x.g !== "work").map(x => x.n), Array(10).fill(7));
  assert.ok(!/NaN/.test(await page.text("#rank")));
});

test("my own weights are kept under «Своё» after switching presets and after reopening", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W]), local: { "wtl:wopen": true } });
  await slide("nature", 0.7);
  const mine = (await shareNums()).map(x => x.n);
  await page.tap({ sel: "#presets button", text: "Михаил" });
  assert.notDeepEqual((await shareNums()).map(x => x.n), mine);
  await page.tap({ sel: "#presets button", text: "Своё" });
  assert.deepEqual((await shareNums()).map(x => x.n), mine);
  await reload();
  assert.equal(await pressed(), "Своё");
  assert.deepEqual((await shareNums()).map(x => x.n), mine);
});

test("«Сохранить как мои веса» saves exactly the shown shares for me and makes my preset active", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  await slide("nature", 0.6);
  const shown = Object.fromEntries((await shareNums()).map(x => [x.g, x.n]));
  assert.equal(await page.text("#wsaveBtn"), "Сохранить как мои веса (Михаил)");
  await page.tap({ sel: "#wsaveBtn" });
  assert.match(await toastText(/Сохранено/), /Сохранено: это теперь веса «Михаил»/);
  const saved = await files("weights/");
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], "weights/mihail.json");
  assert.equal(saved[0][1].who, "Михаил");
  assert.deepEqual(saved[0][1].w, shown);
  assert.equal(await pressed(), "Михаил");
  assert.deepEqual(await presetNames(), ["Поровну", "Михаил", "Своё"]);
  assert.deepEqual(Object.fromEntries((await shareNums()).map(x => [x.g, x.n])), shown, "the preset shows what was saved");
  assert.deepEqual(page.takeErrors(), []);
});

test("when Вика saves her weights after Михаил, «Оба» appears", { skip }, async () => {
  await open({ files: duo([MIKHAIL_W]), me: "Вика", local: { "wtl:wopen": true } });
  await slide("people", 0.5);
  await page.tap({ text: "Сохранить как мои веса (Вика)" });
  await toastText(/Сохранено/);
  assert.deepEqual(await presetNames(), ["Поровну", "Михаил", "Вика", "Оба", "Своё"]);
  assert.equal(await pressed(), "Вика");
  assert.equal((await files("weights/vika.json"))[0][1].who, "Вика");
});

test("weights saved offline are queued, already work as my preset, and are sent when the network is back", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  await slide("nature", 0.8);
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.tap({ sel: "#wsaveBtn" });
  assert.match(await toastText(/Нет связи/), /веса[^.]*отправятся, когда появится связь/);
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("wtl:pending")).map(p => p.path)`), ["weights/mihail.json"]);
  assert.equal(await pressed(), "Михаил");
  assert.deepEqual(await mainRows(), ["Гамма", "Альфа", "Омега"]);
  assert.equal((await files("weights/")).length, 0);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await files("weights/mihail.json")).length, 1);
});

test("without a key the sliders still work but nothing offers to save", { skip }, async () => {
  await open({ token: false, local: { "wtl:wopen": true } });
  assert.match(await page.text("#v-rank"), /Данные не подключены/);
  assert.equal(await page.eval(`!!document.getElementById("wsaveBtn")`), false);
  await slide("climate", 0.5);
  assert.equal((await shareNums()).reduce((a, x) => a + x.n, 0), 100);
  assert.equal(await pressed(), "Своё");
});

test("when the device does not know who I am, the panel says so and the banner button turns on saving", { skip }, async () => {
  await open({ files: duo(), me: "", local: { "wtl:wopen": true } });
  assert.equal(await page.eval(`!!document.getElementById("wsaveBtn")`), false);
  assert.match(await page.text("#wdetails"), /выберите в настройках, кто вы/);
  await page.tap({ sel: "[data-setme]", text: "Михаил" });
  assert.match(await toastText(/Это устройство/), /Это устройство: Михаил/);
  assert.equal(await page.text("#wsaveBtn"), "Сохранить как мои веса (Михаил)");
});

/* ---------- heat matrix ---------- */

test("heat matrix has SPb first, then candidates by score, a column per group, and names open the dossier", { skip }, async () => {
  const files = repo({ places: [...DUO.places, place("delta", "Дельта", { status: "отсев" })], ratings: DUO.ratings });
  await open({ files });
  assert.deepEqual(await heatNames(), ["Санкт-Петербург", "Альфа", "Гамма", "Омега"]);
  assert.equal(await page.eval(`document.querySelectorAll(".heat thead th").length`), 12);
  assert.equal(await page.eval(`document.querySelectorAll(".heat tbody tr")[0].querySelectorAll("td")[1].innerText`), "3.0", "SPb money is 3.0");
  assert.equal(await page.eval(`document.querySelector(".heat thead th[title='Природа и досуг']").innerText`), "Природа");
  await page.tap({ sel: ".heat th.rowh a", text: "Омега" });
  await page.waitFor(`location.hash === "#/place/omega"`, 3000, "dossier");
});

test("after moving a slider the heat matrix rows follow the new ranking order", { skip }, async () => {
  await open({ files: duo(), local: { "wtl:wopen": true } });
  assert.deepEqual((await heatNames()).slice(1), await mainRows());
  await slide("nature", 0.85);
  assert.deepEqual(await mainRows(), ["Гамма", "Альфа", "Омега"]);
  assert.deepEqual((await heatNames()).slice(1), ["Гамма", "Альфа", "Омега"], "the matrix still shows the old order");
});

test("on a phone the heat matrix scrolls sideways inside its panel, the page does not, and place names stay in view", { skip }, async () => {
  await open({ files: duo() });
  const r = await page.eval(`(() => {
    const p = document.querySelector(".heat").closest(".scroll"); p.scrollIntoView({ block: "center" });
    const wide = p.scrollWidth > p.clientWidth; p.scrollLeft = p.scrollWidth;
    const th = document.querySelectorAll(".heat th.rowh")[1], b = th.getBoundingClientRect(), pb = p.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { wide, page: document.documentElement.scrollWidth - innerWidth, inside: b.left >= pb.left - 1, visible: !!hit && th.contains(hit) };
  })()`);
  assert.ok(r.wide, "11 groups do not fit 390px");
  assert.ok(r.page <= 1, "page scrolls sideways by " + r.page);
  assert.ok(r.inside && r.visible, "the sticky name column stays visible: " + JSON.stringify(r));
});

test("heat matrix numbers stay readable (contrast at least 3:1) in light and dark mode", { skip }, async () => {
  const vals = [1, 1.5, 2, 2.5, 3.5, 4, 4.5, 5];
  const files = repo({
    places: [SPB, ...vals.map((v, i) => place("h" + i, "Место " + v))],
    ratings: vals.flatMap((v, i) => [rating("hm" + i, "h" + i, "Михаил", stars(v)), rating("hv" + i, "h" + i, "Вика", stars(v))]),
  });
  const bad = [];
  for (const dark of [false, true]) {
    await open({ files, w: 1280, h: 900, dark });
    const res = await page.eval(CONTRAST(".heat td.cell:not(.none)"));
    assert.ok(res.length > 40);
    res.filter(x => x.r < 3).forEach(x => bad.push(`${dark ? "dark" : "light"} ${x.t}: ${x.r}`));
  }
  await page.viewport(390, 844, { dark: false });
  assert.deepEqual([...new Set(bad)], [], "cells with text contrast below 3:1");
});

/* ---------- flags ---------- */

test("flags list red flags, disagreements and vetoes with a count, most severe first, linking to the place", { skip }, async () => {
  const files = repo({
    places: [...DUO.places, place("zeta", "Зета"), place("kappa", "Каппа")],
    ratings: [...DUO.ratings, rating("z1", "zeta", "Михаил", { "шум": 1 }, { veto: "стройка под окном" }), rating("k1", "kappa", "Михаил", { "интернет": 4.5 }), rating("k2", "kappa", "Вика", { "интернет": 2.5 })],
  });
  await open({ files });
  const flags = await page.eval(`[...document.querySelectorAll(".flags .flag")].map(f => { let g = f.previousElementSibling; while (g && !g.classList.contains("flag-place")) g = g.previousElementSibling; return { sev: f.querySelector(".sev").className.replace("sev", "").trim(), label: f.querySelector(".sev").innerText, place: g && g.innerText, head: f.querySelector("a").innerText, text: f.querySelector("small").innerText, href: f.querySelector("a").getAttribute("href") }; })`);
  assert.deepEqual(flags, [
    { sev: "crit", label: "красный флаг", place: "Зета", head: "вето — Михаил", text: "стройка под окном", href: "#/place/zeta" },
    { sev: "crit", label: "красный флаг", place: "Зета", head: "Шум ночью у жилья", text: "Михаил ставит 1.0", href: "#/place/zeta" },
    { sev: "serious", label: "разногласие", place: "Каппа", head: "Интернет дома", text: "Михаил 4.5, Вика 2.5", href: "#/place/kappa" },
  ]);
  assert.equal(await page.eval(`[...document.querySelectorAll("#v-rank .sec-head")].find(h => /флаги/i.test(h.innerText)).querySelector(".muted").innerText`), "3 флага");
  await page.tap({ sel: ".flags .flag a", text: "Интернет дома" });
  await page.waitFor(`location.hash === "#/place/kappa"`, 3000, "dossier");
});

test("with no flags the list explains what would show up there", { skip }, async () => {
  await open({ files: duo() });
  const none = await page.text(".flags");
  for (const re of [/Флагов нет/, /≤\s?1\.5/, /расхожден[^.]*1\.5/, /вето/]) assert.match(none, re, `«${none}»`);
});

test("flags from places I have not rated are hidden behind a note until I reveal that place", { skip }, async () => {
  const files = repo({ places: [SPB, place("alfa", "Альфа", { cc: "PRT", country: "Португалия" })], ratings: [rating("v1", "alfa", "Вика", { "улица": 1, "шум": 1 })] });
  await open({ files });
  assert.equal(await page.eval(`document.querySelectorAll(".flags .flag").length`), 0);
  const note = await page.text(".flags");
  for (const re of [/Флаги/, /не оценили/, /после вашей оценки/]) assert.match(note, re, `«${note}»`);
  await page.tap({ sel: "#rank a.row", text: "Альфа" });
  await page.waitFor(`location.hash === "#/place/alfa"`, 3000, "dossier");
  await page.tap({ text: "Показать всё равно" });
  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  assert.equal(await page.eval(`document.querySelectorAll(".flags .flag").length`), 2);
  assert.doesNotMatch(await page.text(".flags"), /скрыты/);
});

test("flag links are comfortable tap targets on a phone (at least 24px tall)", { skip }, async () => {
  const files = repo({ places: [...DUO.places, place("zeta", "Зета")], ratings: [...DUO.ratings, rating("z1", "zeta", "Михаил", { "шум": 1 }, { veto: "шумно" })] });
  await open({ files });
  const sizes = await page.eval(`[...document.querySelectorAll(".flags .flag a")].map(a => Math.round(a.getBoundingClientRect().height))`);
  assert.equal(sizes.length, 2);
  assert.ok(sizes.every(h => h >= 24), "flag link heights: " + sizes.join(", "));
});

/* ---------- edge datasets ---------- */

test("with no places the ranking explains it is empty and the heat matrix is not a table of bare headers", { skip }, async () => {
  await open({ files: repo({ places: [], ratings: [] }) });
  const head = await page.text("#v-rank header");
  for (const re of [/Мест: 0/, /оценок: 0/, /0 из 20/]) assert.match(head, re, `«${head}»`);
  const empty = await page.text("#rank");
  for (const re of [/попадёт сюда/, /половин[уаы] главных вопросов ★/]) assert.match(empty, re, `«${empty}»`);
  const heat = await page.eval(`({ head: document.querySelectorAll(".heat thead th").length, rows: document.querySelectorAll(".heat tbody tr").length })`);
  assert.ok(heat.rows > 0 || heat.head === 0, `heat matrix shows ${heat.head} column headers over ${heat.rows} rows`);
  assert.deepEqual(page.takeErrors(), []);
});

test("with only SPb the ranking shows SPb as the base and nothing ranked", { skip }, async () => {
  await open({ files: repo({ places: [SPB], ratings: [] }) });
  assert.deepEqual(await mainRows(), []);
  assert.deepEqual(await paleRows(), []);
  assert.equal((await rowOf("Санкт-Петербург")).score, "3.0");
  assert.deepEqual(await heatNames(), ["Санкт-Петербург"]);
  await page.goto(srv.url + "#/places", 300);
  assert.deepEqual(await plist(), [{ name: "Санкт-Петербург", score: "3.0", meta: ["Россия", "точка отсчёта: с ним сравниваем все места"] }]);
});

const MANY = (() => {
  const ccs = ["PRT", "ESP", "GEO", "SRB", "MNE", "TUR", "CYP", "GRC", "ITA", "ARM"];
  const places = [SPB], ratings = [];
  for (let i = 0; i < 26; i++) {
    const id = "p" + String(i).padStart(2, "0");
    places.push(place(id, "Город " + String.fromCharCode(1040 + i) + (i === 4 ? " с очень длинным названием на побережье залива" : ""), { cc: ccs[i % ccs.length], country: i === 5 ? "Объединённые Арабские Эмираты" : "Страна " + (i % 4), status: i % 9 === 0 ? "финалист" : i === 13 ? "отсев" : "кандидат", reason: i === 13 ? "визы" : "" }));
    const v = 2 + (i % 7) * 0.4;
    if (i % 4 !== 3) ratings.push(rating("m" + i, id, "Михаил", stars(v, i % 5 === 1 ? 3 : 10), { year: i % 11 }));
    if (i % 4 !== 2) ratings.push(rating("v" + i, id, "Вика", stars(v + 0.3, i % 5 === 1 ? 3 : 10), { year: (i + 3) % 11 }));
  }
  return { places, ratings, weights: [MIKHAIL_W, VIKA_W] };
})();

test("with 26 places every place shows up exactly once on the ranking page and once in the places list", { skip }, async () => {
  await open({ files: repo(MANY) });
  const names = await page.eval(`[...document.querySelectorAll("#rank a.row .name b, #rank .empty-row a")].map(e => e.innerText)`);
  const all = MANY.places.map(p => p.name);
  assert.deepEqual([...names].sort(), [...all].sort());
  assert.match(await page.text("#v-rank header"), /Мест: 26 ·/);
  await page.goto(srv.url + "#/places", 300);
  assert.deepEqual((await plist()).map(r => r.name).sort(), [...all].sort());
  assert.deepEqual(page.takeErrors(), []);
});

for (const [w, h] of [[390, 844], [1280, 800]]) {
  for (const dark of [false, true]) {
    test(`ranking and places with 26 places at ${w}px${dark ? " in dark mode" : ""}: every control is named, tappable, not covered, no sideways scroll`, { skip }, async () => {
      await open({ files: repo(MANY), w, h, dark, local: { "wtl:wopen": true } });
      let r = await page.eval(AUDIT);
      assert.deepEqual(r.unnamed, [], "rank: controls without a name");
      assert.deepEqual(r.small, [], "rank: tap targets smaller than 24px");
      assert.deepEqual(r.covered, [], "rank: covered controls");
      assert.ok(r.overflow <= 1, "rank: page scrolls sideways by " + r.overflow);
      await page.goto(srv.url + "#/places", 300);
      r = await page.eval(AUDIT);
      assert.deepEqual([r.unnamed, r.small, r.covered], [[], [], []], "places list controls");
      assert.ok(r.overflow <= 1, "places: page scrolls sideways by " + r.overflow);
      assert.deepEqual(page.takeErrors(), []);
      await page.viewport(390, 844, { dark: false });
    });
  }
}

test("names and reasons with markup are shown as plain text on the ranking and in the places list", { skip }, async () => {
  const odd = `<img src=x>Рига "Старая" & Co`;
  const files = repo({
    places: [SPB, place("riga", odd, { cc: "PRT" }), place("out", "Отсев <b>жирный</b>", { status: "отсев", reason: "<i>курсив</i>" })],
    ratings: [rating("r1", "riga", "Михаил", stars(1.2)), rating("r2", "riga", "Вика", stars(1.4))],
  });
  await open({ files });
  assert.equal(await page.eval(`document.querySelectorAll("#v-rank img, #v-rank .empty-row b, #v-rank .empty-row i, #v-rank .name b b").length`), 0);
  assert.equal(await page.eval(`document.querySelector('#rank a.row[href="#/place/riga"] .name b').innerText`), odd);
  assert.ok((await heatNames()).includes(odd));
  assert.match(await page.text(".flags"), /<img src=x>Рига "Старая" & Co\nкрасный флаг\nИнтернет дома/);
  assert.match(await page.text("#rank"), /Отсев <b>жирный<\/b> — <i>курсив<\/i>/);
  await page.goto(srv.url + "#/places", 300);
  assert.equal(await page.eval(`document.querySelectorAll("#v-places img").length`), 0);
  assert.ok((await plist()).some(r => r.name === odd));
  assert.deepEqual(page.takeErrors(), []);
});

/* ---------- places list ---------- */

test("places list puts finalists first, then candidates, the base and rejected places, alphabetically within each", { skip }, async () => {
  const files = repo({
    places: [SPB, place("b", "Бета"), place("a", "Альфа"), place("f", "Фи", { status: "финалист" }), place("c", "Цэ", { status: "финалист" }), place("o", "Омега", { status: "отсев" }), place("e", "Эпсилон", { status: "отсев" })],
    ratings: [],
  });
  await open({ files, hash: "#/places" });
  assert.deepEqual((await plist()).map(r => r.name), ["Фи", "Цэ", "Альфа", "Бета", "Санкт-Петербург", "Омега", "Эпсилон"]);
});

test("each place row shows its score, country, status and how many ratings it has", { skip }, async () => {
  const files = repo({ places: [...PLACES, place("zeta", "Зета", { cc: "PRT", country: "Португалия" })], ratings: [...RATINGS, rating("z1", "zeta", "Михаил", stars(4), { veto: "шумно" })] });
  await open({ files, hash: "#/places" });
  const by = Object.fromEntries((await plist()).map(r => [r.name, r]));
  assert.match(by["Порту"].score, /^\d\.\d$/);
  assert.deepEqual(by["Порту"].meta, ["Португалия", "кандидат", "оценок: 2", "прожили бы здесь год: Михаил 7/10 · Вика 6/10"]);
  assert.deepEqual(by["Батуми"].meta, ["Грузия", "кандидат", "только мировые данные"]);
  assert.deepEqual(by["Тбилиси"].meta, ["Грузия", "кандидат", "оценка Вики скрыта до вашей оценки"]);
  assert.equal(by["Санкт-Петербург"].score, "3.0");
  assert.equal(by["Зета"].meta[1], "вето", "a vetoed place says so instead of «кандидат»");
});

test("tapping a place in the list opens its dossier", { skip }, async () => {
  await open({ hash: "#/places" });
  await page.tap({ sel: "#plist a.prow", text: "Белград" });
  await page.waitFor(`location.hash === "#/place/belgrad"`, 3000, "dossier");
  assert.match(await page.text("#v-place"), /Белград/);
});

test("the filter matches names and countries regardless of case, and explains with a map link when nothing matches", { skip }, async () => {
  await open({ hash: "#/places" });
  await page.tap({ sel: "#placeFilter" });
  await page.type("ГРУЗ");
  assert.deepEqual((await plist()).map(r => r.name), ["Батуми", "Тбилиси"]);
  await page.fill("#placeFilter", "  порту ");
  assert.deepEqual((await plist()).map(r => r.name), ["Порту"]);
  await page.fill("#placeFilter", "Атлантида");
  assert.deepEqual(await plist(), []);
  const nothing = await page.text("#plist");
  for (const re of [/Ничего не нашлось/, /поиск на карте/]) assert.match(nothing, re, `«${nothing}»`);
  await page.tap({ sel: "#plist a", text: "поиск на карте" });
  await page.waitFor(`location.hash === "#/map"`, 3000, "map");
});

test("the filter is kept when coming back from a place", { skip }, async () => {
  await open({ hash: "#/places" });
  await page.fill("#placeFilter", "порт");
  await page.tap({ sel: "#plist a.prow", text: "Порту" });
  await page.waitFor(`location.hash === "#/place/porto"`);
  await page.eval("history.back()");
  await page.waitFor(`location.hash === "#/places" && !!document.getElementById("placeFilter")`, 3000, "back to list");
  assert.equal(await page.eval(`document.getElementById("placeFilter").value`), "порт");
  assert.deepEqual((await plist()).map(r => r.name), ["Порту"]);
});

test("the filter treats е and ё as the same letter", { skip }, async () => {
  const files = repo({ places: [SPB, place("koeln", "Кёльн", { country: "Германия" }), place("perm", "Пермь")], ratings: [] });
  await open({ files, hash: "#/places" });
  await page.tap({ sel: "#placeFilter" });
  await page.type("кельн");
  assert.deepEqual((await plist()).map(r => r.name), ["Кёльн"], "most people type «е» for «ё»");
});

test("with no places the list invites adding one on the map, and without a key it points to settings", { skip }, async () => {
  await open({ files: repo({ places: [], ratings: [] }), hash: "#/places" });
  const noPlaces = await page.text("#plist");
  for (const re of [/Мест пока нет/, /поиск[^.]*карте/]) assert.match(noPlaces, re, `«${noPlaces}»`);
  await open({ token: false, hash: "#/places" });
  const nokey = await page.text("#plist");
  for (const re of [/подключ/, /ключ/, /настройках/]) assert.match(nokey, re, `«${nokey}»`);
  await page.tap({ sel: "#plist a", text: "настройках" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
});

test("offline before anything was loaded, the places list does not claim there are no places", { skip }, async () => {
  await open({ offline: true, hash: "#/places" });
  assert.match(await page.text("#v-places"), /Нет связи/);
  const t = await page.text("#plist");
  assert.doesNotMatch(t, /Мест пока нет|Добавьте первое/, "inviting to add a first place while offline leads to duplicates: " + t);
});
