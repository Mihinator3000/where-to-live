// Persona «решаем, где жить»: after several trips both of us rated places; we use the ranking,
// the places list and a few dossiers to decide. Every number on these screens must say what it means.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- synthetic persona data ---------- */
const T = "2026-10-01T00:00:00.000Z";
const STAR = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
const place = (id, name, country, cc, lat, lon, extra = {}) => Object.assign({ id, name, country, cc, lat, lon, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T }, extra);
const rating = (id, placeId, who, scores, extra = {}) => Object.assign({ id, place: placeId, who, start: "2026-06-01", end: "2026-06-21", days: 21, season: "пик", mode: "удалёнка", housing: "жилой район", retro: false, year: 7, veto: "", review: "", scores, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T }, extra);
const st = arr => Object.fromEntries(STAR.map((k, i) => [k, arr[i]]).filter(([, v]) => v != null));

const PLACES = [
  place("sankt-peterburg", "Санкт-Петербург", "Россия", "RUS", 59.93863, 30.31413, { status: "база", archetype: "мегаполис", facts: { basket: { v: 60, src: "Перекрёсток", at: "2026-09-01" } } }),
  place("porto", "Порту", "Португалия", "PRT", 41.14961, -8.61099, { status: "финалист", archetype: "город у моря", questions: "Проверить сырость зимой", facts: { rent: { v: 1100, src: "idealista, 20 объявлений", at: "2026-09-10" }, dinner: { v: 40, src: "3 ужина", at: "2026-09-10" }, basket: { v: 55, src: "Pingo Doce", at: "2026-09-10" } } }),
  place("valensiya", "Валенсия", "Испания", "ESP", 39.46975, -0.37739, { archetype: "город у моря", facts: { rent: { v: 1300, src: "idealista", at: "2026-09-10" }, tds: { v: 420, src: "TDS-метр", at: "2026-09-10" } } }),
  place("tbilisi", "Тбилиси", "Грузия", "GEO", 41.69411, 44.83368, { archetype: "мегаполис" }),
  place("batumi", "Батуми", "Грузия", "GEO", 41.64228, 41.63392, { archetype: "город у моря" }),
  place("belgrad", "Белград", "Сербия", "SRB", 44.80401, 20.46513, { archetype: "мегаполис", status: "отсев", reason: "Смог зимой и далеко от моря" }),
  place("budva", "Будва", "Черногория", "MNE", 42.2864, 18.84, { archetype: "курорт" }),
  place("herceg-novi", "Херцег-Нови", "Черногория", "MNE", 42.4531, 18.5375, { archetype: "малый курорт", facts: { rent: { v: 700, src: "realitica", at: "2026-09-01" }, dinner: { v: 30, src: "4 ужина", at: "2026-09-01" } } }),
  place("antalya", "Анталья", "Турция", "TUR", 36.8969, 30.7133, { archetype: "курорт" }),
  place("limassol", "Лимасол", "Кипр", "CYP", 34.6786, 33.0413, { archetype: "город у моря" }),
];

const RATINGS = [
  rating("p-m", "porto", "Михаил", Object.assign(st([4, 3.5, 4, 3, 4, 4.5, 3.5, 5, 4, 2]), { "продукты": 3.5, "кафе": 4.5, "климат": 3.5 }), { year: 8, review: "Красиво, океан, но сыро в квартирах.", start: "2026-03-01", end: "2026-03-28", days: 28, season: "межсезон" }),
  rating("p-v", "porto", "Вика", Object.assign(st([4, 3, 4.5, 2.5, 3.5, 4, 4, 4.5, 4, 4]), { "продукты": 3, "кафе": 4, "климат": 3 }), { year: 7, review: "Холмы тяжело, но люди милые.", start: "2026-03-01", end: "2026-03-28", days: 28, season: "межсезон" }),
  rating("v-m", "valensiya", "Михаил", Object.assign(st([4.5, 3, 4, 3.5, 3, 4, 3.5, 4, 5, 3]), { "климат": 4.5 }), { year: 8, review: "Пляж в черте города, велодорожки." }),
  rating("v-v", "valensiya", "Вика", Object.assign(st([4, 2, 4, 3.5, 2.5, 4, 3, 4, 5, 3]), { "климат": 4 }), { year: 7, review: "Кожа шелушится от воды." }),
  rating("t-m", "tbilisi", "Михаил", st([4, 3, 3.5, 2.5, 2.5, 3.5, 2, 3.5, 1, 3.5]), { year: 5, start: "2026-04-10", end: "2026-04-30", days: 20, season: "межсезон" }),
  rating("t-v", "tbilisi", "Вика", st([3.5, 3, 3, 2, 2, 3, 1.5, 3, 1, 3]), { year: 4, review: "Пыльно и шумно.", start: "2026-04-10", end: "2026-04-30", days: 20, season: "межсезон" }),
  rating("b-m", "batumi", "Михаил", st([4, 3, 3.5, 2.5, 3, 3.5, 3, 3, 3.5, 3.5]), { year: 5, start: "2026-05-01", end: "2026-05-14", days: 14 }),
  rating("b-v", "batumi", "Вика", st([3.5, 1.5, 3, 2, 3, 3, 3, 3, 3.5, 3]), { year: 2, veto: "Плесень в каждой квартире, кожа не выдержит", start: "2026-05-01", end: "2026-05-14", days: 14 }),
  rating("bg-m", "belgrad", "Михаил", st([4, 3, 3.5, 3, 3, 4, 3, 3.5, null, 4]), { year: 4, start: "2025-12-01", end: "2025-12-15", days: 15, season: "худший" }),
  rating("bg-v", "belgrad", "Вика", st([4, 2.5, 3.5, 3, 3, 4, 3, 3, null, 4]), { year: 3, start: "2025-12-01", end: "2025-12-15", days: 15, season: "худший" }),
  rating("bu-v", "budva", "Вика", st([3, 4, 4, 3, 2, 4, 3, 4, 4.5, 4]), { year: 6, review: "Летом толпы, зимой пусто.", start: "2026-07-01", end: "2026-07-20", days: 20 }),
  rating("hn-m1", "herceg-novi", "Михаил", st([3.5, 4, 4.5, 3, 4, 4, 3.5, 4.5, 4.5, 4]), { year: 8, review: "Тихо, лестницы, море рядом.", start: "2026-08-01", end: "2026-08-25", days: 25 }),
  rating("hn-v", "herceg-novi", "Вика", st([3.5, 4.5, 4.5, 3.5, 4, 4, 4, 5, 4.5, 4]), { year: 9, review: "Лучшее для кожи.", start: "2026-08-01", end: "2026-08-25", days: 25 }),
  rating("hn-m2", "herceg-novi", "Михаил", st([3, 4, 4.5, 2.5, 4.5, 3.5, 3.5, 4, null, 4]), { year: 7, review: "Зимой половина кафе закрыта.", start: "2026-01-10", end: "2026-01-31", days: 21, season: "худший" }),
  rating("an-v", "antalya", "Вика", st([4, 3, 4, 3, 3, 3, 3.5, 3, 4.5, 2.5]), { year: 5, start: "2026-09-01", end: "2026-09-14", days: 14 }),
];

const W0 = { legal: 0, money: 0, work: 0, health: 0, safety: 0, climate: 0, housing: 0, city: 0, nature: 0, people: 0, links: 0 };
const WEIGHTS = [
  { id: "mikhail", who: "Михаил", w: { ...W0, legal: 15, money: 10, work: 25, health: 5, safety: 5, climate: 5, housing: 10, city: 15, nature: 5, people: 3, links: 2 } },
  { id: "vika", who: "Вика", w: { ...W0, legal: 10, money: 5, work: 5, health: 25, safety: 10, climate: 10, housing: 10, city: 5, nature: 15, people: 3, links: 2 } },
];
const FILES = repo({ places: PLACES, ratings: RATINGS, weights: WEIGHTS });

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const citiesLoaded = `import("./js/app.js").then(m => !!m.state.world.cities)`;

async function open({ w = 390, h = 844, dark = false, hash = "#/rank", files = FILES, ...o } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, Object.assign({ hash, files }, o));
  await page.waitFor(citiesLoaded, 8000, "city data loaded");
  await sleep(250);
  if (hash.startsWith("#/rank")) await page.waitFor(`document.querySelectorAll("#rank a.row").length > 3`, 5000, "ranking rows");
  if (hash.startsWith("#/places")) await page.waitFor(`document.querySelectorAll("#plist a.prow").length > 3`, 5000, "places rows");
  if (hash.startsWith("#/place/")) await page.waitFor(`document.querySelector("#v-place h1") && !/Считаю/.test((document.getElementById("simBox") || {}).innerText || "")`, 6000, "dossier ready");
  page.takeErrors();
}

async function goto(hash) {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(350);
  if (hash.startsWith("#/place/")) await page.waitFor(`document.querySelector("#v-place h1")`, 4000, "dossier");
}

const rows = () => page.eval(`[...document.querySelectorAll("#rank a.row")].map(r => ({
  name: r.querySelector(".name b").innerText.trim(),
  pos: r.querySelector(".pos").innerText.trim(),
  pale: r.classList.contains("pale"),
  score: Number(r.querySelector(".score").innerText.split("\\n")[0]),
  unit: (r.querySelector(".score small") || {}).innerText || "",
  chips: [...r.querySelectorAll(".chip")].map(c => c.innerText.trim()),
  dots: [...r.querySelectorAll(".dot")].map(d => ({ who: d.classList.contains("v") ? "Вика" : "Михаил", tip: d.dataset.tip || "" })),
}))`);
const mainOrder = async () => (await rows()).filter(r => !r.pale && /^\d+$/.test(r.pos)).map(r => r.name);
const rowOf = async name => (await rows()).find(r => r.name === name);

async function preset(name) {
  await page.tap({ text: name, within: "#presets" });
  await page.waitFor(`document.querySelector('#presets button[aria-pressed="true"]')?.innerText.trim() === ${JSON.stringify(name)}`, 2000, "preset " + name);
}

async function openDetails(sel) {
  await page.eval(`(() => { const d = document.querySelector(${JSON.stringify(sel)}); if (d) d.open = true; })()`);
  await sleep(100);
}

// Text of a ranking block without the rows / table / flag items (the explanations around them).
const blockNotes = (i, cut) => page.eval(`(() => { const b = document.querySelectorAll("#v-rank .block")[${i}].cloneNode(true); b.querySelectorAll(${JSON.stringify(cut)}).forEach(e => e.remove()); return b.innerText.replace(/\\s+/g, " "); })()`);

const scorePanel = () => page.eval(`document.querySelector("#v-place .panel.pad").innerText.replace(/\\s+/g, " ")`);
const titlesIn = sel => `[...(${sel}).querySelectorAll("[title],[aria-label]")].map(e => (e.title || "") + " " + (e.getAttribute("aria-label") || "")).join(" ")`;

async function slide(group, frac) {
  const r = await page.eval(`(() => { const e = document.getElementById("w-${group}"); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); const x = b.left + b.width * ${frac}, y = b.top + b.height / 2; return { x, y, hit: document.elementFromPoint(x, y) === e }; })()`);
  assert.ok(r.hit, `slider ${group} is not covered`);
  await page.click(r.x, r.y);
  await sleep(250);
}

const rgb = sel => page.eval(`(() => { const e = ${sel}; if (!e) return null; const m = getComputedStyle(e).backgroundColor.match(/[\\d.]+/g).map(Number); return m.slice(0, 3); })()`);
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/* =================== Ranking: which place is best and is it obvious why =================== */

test("our ranking puts Порту first, then Херцег-Нови, Валенсия and Тбилиси; partner-only and data-only places sit below; vetoed and rejected places are under «Отсев» with reasons", { skip }, async () => {
  await open();
  assert.deepEqual(await mainOrder(), ["Порту", "Херцег-Нови", "Валенсия", "Тбилиси"]);
  const pale = (await rows()).filter(r => r.pale).map(r => r.name).sort();
  assert.deepEqual(pale, ["Анталья", "Будва", "Лимасол"].sort());
  const rank = (await page.text("#rank")).replace(/\s+/g, " ");
  assert.match(rank, /Отсев:.*Батуми[^;]*вето[^;]*Плесень в каждой квартире/);
  assert.match(rank, /Белград[^;]*Смог зимой и далеко от моря/);
  assert.ok(!(await rows()).some(r => r.name === "Батуми" || r.name === "Белград"), "out places are not ranked rows");
});

test("every ranked score reads «из 5» and the axis above names 3 as SPb", { skip }, async () => {
  await open();
  for (const r of (await rows()).filter(r => /^\d+$/.test(r.pos))) assert.equal(r.unit.trim(), "из 5", `${r.name} score has its unit`);
  assert.match(await page.text(".rank-axis"), /3\s*·\s*СПб/);
});

test("the «3 · СПб» tick of the axis lines up with the SPb mark of every row, on a phone and on a computer", { skip }, async () => {
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    await open({ w, h });
    const off = await page.eval(`(() => {
      const t = [...document.querySelectorAll(".rank-axis .ticks span")].find(s => /СПб/.test(s.innerText));
      const box = t.parentElement.getBoundingClientRect();
      const tick3 = parseFloat(t.style.left) / 100 * box.width + box.left;
      return [...document.querySelectorAll("#rank a.row .track .base")].map(b => Math.abs(b.getBoundingClientRect().left + 1 - tick3));
    })()`);
    assert.ok(off.length > 4);
    assert.ok(off.every(d => d < 3), `at ${w}px the SPb mark drifts from the axis by ${Math.max(...off).toFixed(1)}px`);
  }
});

test("a place worse than SPb has its bar going left of the SPb mark, a better one to the right", { skip }, async () => {
  await open();
  const geo = await page.eval(`Object.fromEntries([...document.querySelectorAll("#rank a.row")].filter(r => ["Порту", "Тбилиси"].includes(r.querySelector(".name b").innerText)).map(r => { const bar = r.querySelector(".bar"), base = r.querySelector(".base").getBoundingClientRect(), b = bar.getBoundingClientRect(); return [r.querySelector(".name b").innerText, { cls: bar.className, left: b.left - base.left, right: b.right - base.right }]; }))`);
  assert.match(geo["Порту"].cls, /\bup\b/);
  assert.ok(geo["Порту"].left > -3 && geo["Порту"].right > 10, "Порту's bar starts at SPb and goes right");
  assert.match(geo["Тбилиси"].cls, /\bdown\b/);
  assert.ok(geo["Тбилиси"].right < 3 && geo["Тбилиси"].left < -10, "Тбилиси's bar ends at SPb and goes left");
});

test("SPb's base row sits between the places that beat SPb and the places that are worse than SPb", { skip }, async () => {
  await open();
  const rs = (await rows()).filter(r => !r.pale);
  const i = rs.findIndex(r => r.name === "Санкт-Петербург");
  assert.ok(i >= 0);
  const above = rs.slice(0, i).map(r => `${r.name} ${r.score}`), below = rs.slice(i + 1).map(r => `${r.name} ${r.score}`);
  assert.ok(rs.slice(0, i).every(r => r.score >= 3), `rows above SPb include places worse than SPb: ${above.join(", ")}`);
  assert.ok(rs.slice(i + 1).every(r => r.score < 3), `rows below SPb include places better than SPb: ${below.join(", ")}`);
  assert.ok(below.some(x => x.startsWith("Тбилиси")), "Тбилиси (2.7) is listed below SPb (3.0)");
});

test("the ranking says that the dots are each person's own ratings and the bar is the total that also counts world data", { skip }, async () => {
  await open();
  await openDetails(".rank-help");
  const notes = await blockNotes(0, "#rank, #wgrid");
  assert.match(notes, /точк[^.]*(оценк|свои|собствен)/i, `dots are not explained: «${notes.slice(0, 300)}»`);
  assert.match(notes, /полос[^.]*(итог|данн)/i, "the bar is not explained");
});

test("each person's dot sits at that person's own total, and the dossier lists the same two numbers in «Из чего итог»", { skip }, async () => {
  await open();
  const dots = await page.eval(`(() => { const r = [...document.querySelectorAll("#rank a.row")].find(r => r.querySelector(".name b").innerText === "Херцег-Нови"); const tr = r.querySelector(".track").getBoundingClientRect(); return [...r.querySelectorAll(".dot")].map(d => { const b = d.getBoundingClientRect(); const [who, v] = d.dataset.tip.split(": "); return { who, v: Number(v), at: 1 + 4 * ((b.left + b.width / 2 - tr.left) / tr.width) }; }); })()`);
  assert.equal(dots.length, 2);
  dots.forEach(d => assert.ok(Math.abs(d.at - d.v) < 0.08, `${d.who}'s dot sits at ${d.at.toFixed(2)}, not at ${d.v}`));
  await page.tap({ text: "Херцег-Нови", within: "#rank" });
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Херцег-Нови"`, 3000, "dossier");
  const panel = await scorePanel();
  for (const d of dots) assert.match(panel, new RegExp(`${d.who} ${d.v.toFixed(1).replace(".", "\\.")}`), `dossier lists ${d.who} ${d.v}`);
});

test("a place rated only by my partner has no dots in the ranking, so nothing leaks before I rate it", { skip }, async () => {
  await open();
  for (const n of ["Будва", "Анталья"]) {
    const r = await rowOf(n);
    assert.deepEqual(r.dots, [], `${n} shows no person dots`);
    assert.ok(r.chips.some(c => /скрыт/.test(c)), `${n} says a rating is hidden`);
    assert.ok(!r.chips.some(c => /год здесь/.test(c)), `${n} does not leak the partner's year answer`);
  }
});

test("the ranking tells how to see a partner's hidden rating, not only that it is hidden", { skip }, async () => {
  await open();
  await openDetails(".rank-help");
  const t = (await page.eval(`document.querySelector("#v-rank .block").innerText`)).replace(/\s+/g, " ");
  assert.match(t, /Показать всё равно|в досье|откройте (место|досье)/i, "nothing on the ranking explains how to reveal a hidden rating");
});

test("a place with only world data says so the same way in the ranking, the places list and its dossier", { skip }, async () => {
  await open();
  assert.ok((await rowOf("Лимасол")).chips.includes("только мировые данные"));
  await goto("#/places");
  const meta = await page.eval(`[...document.querySelectorAll("#plist a.prow")].find(r => r.querySelector("b").innerText === "Лимасол").innerText`);
  assert.match(meta, /только мировые данные/);
  await goto("#/place/limassol");
  assert.match(await scorePanel(), /Мы здесь ещё не были: итог посчитан только по мировым данным/);
});

test("the year chip in the ranking matches the year answers in the dossier, using the latest trip when one of us went twice", { skip }, async () => {
  await open();
  const chip = (await rowOf("Херцег-Нови")).chips.find(c => c.startsWith("год здесь"));
  assert.equal(chip, "год здесь: Михаил 8/10 · Вика 9/10", "Михаил's August answer (8) is newer than January (7)");
  await goto("#/place/herceg-novi");
  assert.match((await page.text(".year")).replace(/\s+/g, " "), /Михаил 8\/10 Вика 9\/10/);
});

/* =================== Presets and weights =================== */

test("«Михаил» puts Валенсия above Херцег-Нови, «Вика» puts Херцег-Нови above Валенсия, and the table follows", { skip }, async () => {
  await open();
  await preset("Михаил");
  assert.deepEqual((await mainOrder()).slice(1, 3), ["Валенсия", "Херцег-Нови"]);
  const heatRows = () => page.eval(`[...document.querySelectorAll(".heat tbody th.rowh")].map(t => (t.querySelector("a") || t).innerText.trim())`);
  let heat = await heatRows();
  assert.ok(heat.indexOf("Валенсия") < heat.indexOf("Херцег-Нови"), "table rows follow «Михаил»");
  assert.match(await page.text("#wsum"), /«Михаил»/);
  await preset("Вика");
  assert.deepEqual((await mainOrder()).slice(1, 3), ["Херцег-Нови", "Валенсия"]);
  heat = await heatRows();
  assert.ok(heat.indexOf("Херцег-Нови") < heat.indexOf("Валенсия"), "table rows follow «Вика»");
});

test("after switching presets the ranking shows which places moved up or down", { skip }, async () => {
  await open();
  assert.deepEqual((await mainOrder()).slice(1, 3), ["Херцег-Нови", "Валенсия"]);
  await page.tap({ text: "Михаил", within: "#presets" });
  const seen = await page.waitFor(`(() => { const t = document.getElementById("toast"); const s = document.getElementById("rank").innerText + " " + (t && !t.hidden ? t.innerText : ""); return /↑|↓|▲|▼|поднял|опустил|сдвинул/i.test(s) && s; })()`, 1500, "movement indicator").catch(() => "");
  assert.ok(seen, "Валенсия moved from №3 to №2 under «Михаил», but nothing on the screen says what changed");
});

test("the ranking explains what «Поровну», «Оба» and «Своё» mean", { skip }, async () => {
  await open();
  await openDetails("#wdetails");
  await openDetails(".rank-help");
  const notes = await blockNotes(0, "#rank, #presets");
  assert.match(notes, /одинаков|равные доли|поровну между/i, "«Поровну» (same share for every group) is not explained");
  assert.match(notes, /средн/i, "«Оба» (the average of our two saved weights) is not explained");
  assert.match(notes, /«?Своё»?[^.]*(ползун|двига|вручную|сами)/i, "«Своё» (my own slider positions) is not explained");
});

test("moving a slider re-ranks at once and every dossier shows the same position as the new ranking", { skip }, async () => {
  await open();
  await openDetails("#wdetails");
  await slide("nature", 0.9);
  assert.match(await page.text("#wsum"), /«Своё»/);
  const order = await mainOrder();
  assert.equal(order[0], "Валенсия", "a heavy «Природа» weight lifts Валенсия (sea 5) to the top");
  const ids = { "Порту": "porto", "Херцег-Нови": "herceg-novi", "Валенсия": "valensiya", "Тбилиси": "tbilisi" };
  for (const [i, name] of order.entries()) {
    await goto("#/place/" + ids[name]);
    assert.match(await page.text(".bigscore"), new RegExp(`№${i + 1}(?!\\d)`), `${name} dossier shows №${i + 1}`);
  }
});

test("the save button says whose weights it would copy and is not offered for weights that are already mine", { skip }, async () => {
  await open();
  await openDetails("#wdetails");
  await preset("Вика");
  assert.match(await page.text("#wsaveBtn"), /Вика/, "under «Вика» the button reads like it saves my own weights, but it overwrites them with Вика's");
  await preset("Михаил");
  const st = await page.eval(`(() => { const b = document.getElementById("wsaveBtn"); return !b || b.disabled || /уже|сохранен/i.test(b.innerText) ? "ok" : b.innerText; })()`);
  assert.equal(st, "ok", "under my own unchanged weights the panel still offers to save them");
});

test("the weights panel and «Что значат пометки» look tappable: their headers show an open/close arrow", { skip }, async () => {
  await open();
  const cue = await page.eval(`["#wsum", ".rank-help > summary"].map(sel => {
    const s = document.querySelector(sel); const cs = getComputedStyle(s);
    const pseudo = w => { const c = getComputedStyle(s, w).content; return c && c !== "none" && c !== "normal" && c !== '""'; };
    return { sel, ok: cs.display === "list-item" || pseudo("::before") || pseudo("::after") || !!s.querySelector("svg") || /[▸▾▶▼›⌄]/.test(s.innerText) };
  })`);
  for (const c of cue) assert.ok(c.ok, `${c.sel} has no disclosure arrow (display:flex removes the default marker)`);
});

test("the ranking header explains what «из 20» scouting trips means", { skip }, async () => {
  await open();
  await openDetails(".rank-help");
  const t = await page.eval(`(() => { const h = document.querySelector("#v-rank header"); return h.innerText + " " + ${titlesIn("h")} + " " + document.querySelector(".rank-help").innerText; })()`);
  assert.match(t, /поездок-разведок: \d+ из 20/);
  assert.match(t, /бюджет|запланир|в план|задума|всего хотим/i, "«из 20» has no explanation");
});

/* =================== Places × groups (heat matrix) and flags =================== */

test("the places × groups table says each cell is a group score from 1 to 5 with 3 as SPb, and what «—» means", { skip }, async () => {
  await open();
  const notes = await blockNotes(1, "table");
  assert.match(notes, /1[–-]5|из 5/, `no scale next to the table: «${notes}»`);
  assert.match(notes, /СПб/);
  assert.match(notes, /—[^.]*(нет данных|нет оценок|не счита)|нет данных/i, "«—» in the table is not explained");
});

test("in the places × groups table a group we rate badly is red and a strong one is blue, in light and dark mode", { skip }, async () => {
  for (const dark of [false, true]) {
    await open({ dark });
    const cell = (place, col) => `(() => { const hs = [...document.querySelectorAll(".heat thead th")].map(t => t.innerText.trim()); const i = hs.indexOf(${JSON.stringify(col)}); const tr = [...document.querySelectorAll(".heat tbody tr")].find(r => r.querySelector("th").innerText.trim().startsWith(${JSON.stringify(place)})); return tr && tr.children[i]; })()`;
    assert.equal(await page.eval(`${cell("Тбилиси", "Природа")}.innerText.trim()`), "1.0");
    const bad = await rgb(cell("Тбилиси", "Природа")), good = await rgb(cell("Порту", "Связь"));
    assert.ok(bad[0] > bad[2] + 40, `Тбилиси · Природа 1.0 should look red (${bad}) in ${dark ? "dark" : "light"} mode`);
    assert.ok(good[2] > good[0] + 40, `Порту · Связь 5.0 should look blue (${good}) in ${dark ? "dark" : "light"} mode`);
  }
});

test("in the places × groups table, rows scored only by world data are told apart from rows with our ratings", { skip }, async () => {
  await open();
  const list = await page.eval(`[...document.querySelectorAll(".heat tbody tr")].map(tr => { const th = tr.querySelector("th"); return [th.innerText.trim(), /pale|thin|data/.test(tr.className) || /данн|скрыт|мало/i.test(th.innerText + " " + (th.title || "") + " " + ${titlesIn("th")})]; })`);
  const marked = n => (list.find(([t]) => t.startsWith(n)) || [])[1];
  assert.equal(marked("Порту"), false, "a place we rated is not marked");
  for (const n of ["Лимасол", "Будва", "Анталья"]) assert.equal(marked(n), true, `${n}'s row looks like our own rating, but it is world data only`);
});

test("flags put the veto first and show our disagreement on language in Порту with both numbers, linking to the place", { skip }, async () => {
  await open();
  const flags = await page.eval(`(() => { const at = f => { let g = f.previousElementSibling; while (g && !g.classList.contains("flag-place")) g = g.previousElementSibling; return (g ? g.innerText.trim() + ": " : "") + f.querySelector("a").innerText.trim(); }; return [...document.querySelectorAll(".flags .flag")].map(f => ({ sev: f.querySelector(".sev").innerText.trim(), head: at(f), href: f.querySelector("a").getAttribute("href"), text: f.querySelector("small").innerText.trim() })); })()`);
  assert.match(flags[0].head, /Батуми: вето/);
  assert.match(flags[0].text, /Плесень в каждой квартире, кожа не выдержит/);
  const lang = flags.find(f => f.head === "Порту: Язык в быту");
  assert.ok(lang, "the language disagreement in Порту is flagged");
  assert.equal(lang.sev, "разногласие");
  assert.match(lang.text, /Михаил 2\.0, Вика 4\.0/);
  assert.equal(lang.href, "#/place/porto");
  assert.ok(!flags.some(f => /Будва|Анталья/.test(f.head)), "no flags from places whose ratings are hidden from me");
});

test("the number next to «Флаги» says what it counts", { skip }, async () => {
  await open();
  const t = await page.eval(`(() => { const h = [...document.querySelectorAll("#v-rank .sec-head")].find(x => /Флаги/.test(x.textContent)); const s = h.querySelector("span"); return (s.innerText + " " + (s.title || "") + " " + (s.getAttribute("aria-label") || "")).trim(); })()`);
  assert.match(t, /^\d+/);
  assert.match(t, /флаг|шт/i, `the bare number «${t}» has no label`);
});

test("when there are flags, the section still explains what makes a flag", { skip }, async () => {
  await open();
  const notes = await blockNotes(2, ".flag");
  assert.match(notes, /1[.,]5/, `with flags present nothing says what «красный флаг» and «разногласие» mean: «${notes}»`);
});

test("a red flag we both share on the same subcategory is listed once, naming both of us", { skip }, async () => {
  await open();
  const sea = await page.eval(`(() => { const at = f => { let g = f.previousElementSibling; while (g && !g.classList.contains("flag-place")) g = g.previousElementSibling; return (g ? g.innerText.trim() + ": " : "") + f.querySelector("a").innerText.trim(); }; return [...document.querySelectorAll(".flags .flag")].filter(f => at(f) === "Тбилиси: Море и пляжи").map(f => f.querySelector("small").innerText); })()`);
  assert.equal(sea.length, 1, `the same red flag is listed ${sea.length} times: ${JSON.stringify(sea)}`);
  assert.match(sea[0], /Михаил/);
  assert.match(sea[0], /Вика/);
});

/* =================== Places list =================== */

test("the places list shows the same score as the ranking for every place", { skip }, async () => {
  await open();
  const rank = Object.fromEntries((await rows()).filter(r => r.name !== "Санкт-Петербург").map(r => [r.name, r.score.toFixed(1)]));
  await goto("#/places");
  const list = Object.fromEntries(await page.eval(`[...document.querySelectorAll("#plist a.prow")].map(r => [r.querySelector("b").innerText, r.querySelector(".score").innerText.trim()])`));
  for (const [n, s] of Object.entries(rank)) assert.equal(list[n], s, `${n}: list ${list[n]} vs ranking ${s}`);
});

test("the places list explains its numbers: a total out of 5 where 3 is SPb", { skip }, async () => {
  await open({ hash: "#/places" });
  const head = (await page.text("#v-places header")).replace(/\s+/g, " ");
  assert.match(head, /из 5|1[–-]5/, `the list shows bare numbers like 3.6 with no scale: «${head}»`);
  assert.match(head, /СПб/);
});

test("a vetoed place is listed after all live candidates, together with the rejected ones", { skip }, async () => {
  await open({ hash: "#/places" });
  const names = await page.eval(`[...document.querySelectorAll("#plist a.prow")].map(r => r.querySelector("b").innerText)`);
  const live = ["Анталья", "Будва", "Валенсия", "Лимасол", "Тбилиси", "Херцег-Нови"];
  const lastLive = Math.max(...live.map(n => names.indexOf(n)));
  assert.ok(names.indexOf("Батуми") > lastLive, `Батуми (vetoed by Вика) sits among candidates: ${names.join(", ")}`);
});

/* =================== Dossier: why this number =================== */

test("a dossier shows the same score and position as the ranking for the same weights", { skip }, async () => {
  await open();
  const want = Object.fromEntries((await rows()).filter(r => /^\d+$/.test(r.pos)).map(r => [r.name, r]));
  for (const [id, name] of [["porto", "Порту"], ["tbilisi", "Тбилиси"]]) {
    await goto("#/place/" + id);
    const big = (await page.text(".bigscore")).replace(/\s+/g, " ");
    assert.ok(big.startsWith(want[name].score.toFixed(1)), `${name}: «${big}» vs ranking ${want[name].score}`);
    assert.match(big, new RegExp(`№${want[name].pos}(?!\\d)`));
  }
});

test("a place whose position depends on the weights shows the same «№2–3» range in its dossier as in the ranking", { skip }, async () => {
  await open();
  assert.ok((await rowOf("Валенсия")).chips.includes("№2–3 в зависимости от весов"));
  await goto("#/place/valensiya");
  assert.match(await page.text(".bigscore"), /№2[–-]3/, "the dossier says only «№3 в рейтинге» although the ranking says №2–3");
});

test("a vetoed place says right at its score that it is out of the ranking, who vetoed it and why", { skip }, async () => {
  await open({ hash: "#/place/batumi" });
  const panel = await scorePanel();
  assert.match(panel, /вето/i, `the score panel of Батуми looks like a normal candidate: «${panel}»`);
  assert.match(panel, /Плесень в каждой квартире/);
  const chips = await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText.trim())`);
  assert.ok(chips.includes("вето"), `header chips say ${JSON.stringify(chips)}, the places list says «вето»`);
});

test("a rejected place shows its reason at the score and its ranking link leads there", { skip }, async () => {
  await open();
  await page.tap({ text: "Белград", within: "#rank" });
  await page.waitFor(`document.querySelector("#v-place h1")?.innerText === "Белград"`, 3000, "Белград dossier");
  assert.match(await scorePanel(), /Причина отсева: Смог зимой и далеко от моря/);
  assert.ok((await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText)`)).includes("отсев"));
});

test("«Из чего итог» explains why the total can be lower than both of our own scores", { skip }, async () => {
  await open({ hash: "#/place/herceg-novi" });
  const panel = await scorePanel();
  const total = Number((await page.text(".bigscore b")).trim());
  const m = Number(panel.match(/Михаил (\d\.\d)/)[1]), v = Number(panel.match(/Вика (\d\.\d)/)[1]);
  assert.ok(total < m && total < v, "fixture: the total is below both personal scores");
  assert.match(panel, /видно|весят|вес данных|тянут|сниж|занижа/i, `total ${total} is below Михаил ${m} and Вика ${v} with no word why: «${panel}»`);
});

test("when a place has typed numbers, «Из чего итог» does not call them world data", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const line = (await scorePanel()).match(/Из чего итог:[^]*?(?=Вопросы|$)/)[0];
  assert.match(line, /цифр/i, `rent, dinner and basket we typed are counted as «мировые данные»: «${line}»`);
});

test("the rent score in the subcategory table says it comes from the rent we typed", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const row = await page.eval(`(() => { const tr = [...document.querySelectorAll(".subtable tbody tr")].find(r => /^Аренда на год/.test(r.cells[0].innerText.trim())); return tr.innerText.replace(/\\s+/g, " ") + " " + ${titlesIn("tr")}; })()`);
  assert.match(row, /1\.3/);
  assert.match(row, /цифр|€\s?1\s?100|1\s?100\s?€/i, `rent row «${row}» looks like world data`);
});

test("a typed rent shows the same score in its badge and in the subcategory table, and twice SPb's rent lands below 2", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const badge = (await page.eval(`document.querySelector('[name="fact_rent"]').closest(".fact").querySelector(".badge").innerText`)).match(/\d\.\d/)[0];
  const sub = (await page.eval(`(() => { const tr = [...document.querySelectorAll(".subtable tbody tr")].find(r => /^Аренда на год/.test(r.cells[0].innerText.trim())); return tr.cells[1].innerText; })()`)).match(/\d\.\d/)[0];
  assert.equal(badge, "1.3");
  assert.equal(sub, badge);
  assert.match(await page.eval(`document.querySelector('[name="fact_rent"]').closest(".fact").innerText`), /СПб: €550/);
});

test("a world indicator replaced by a typed number is marked as not counted in the total", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const row = await page.eval(`(() => { const r = [...document.querySelectorAll("#v-place .world .world-row")].find(r => /Уровень цен в стране/.test(r.innerText)); return r.innerText.replace(/\\s+/g, " ") + " " + ${titlesIn("r")}; })()`);
  assert.match(row, /цифр|замен|вместо|не входит|не учитыва/i, `«Уровень цен» shows a score badge «for the total», but the typed dinner price replaces it: «${row}»`);
});

test("the score badges in «Цифры места» say they are scores out of 5 compared with SPb", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const r = await page.eval(`(() => { const b = document.querySelector("#factsForm .badge"); const intro = document.querySelector("#factsForm > p").innerText; return { label: (b.title || "") + " " + (b.getAttribute("aria-label") || ""), intro }; })()`);
  assert.ok(/оценк|балл|из 5|1[–-]5/i.test(r.label) || /плашк|цветн|рядом с назван/i.test(r.intro), `«Аренда на год, € в месяц 1.3» — nothing says 1.3 is a score, not euros: ${JSON.stringify(r)}`);
});

test("the date a number was typed is shown in Russian, like trip dates", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const t = await page.eval(`document.querySelector('[name="fact_rent"]').closest(".fact").innerText`);
  assert.match(t, /Вписано \d{1,2} [а-яё]+ \d{4}|Вписано \d{2}\.\d{2}\.\d{4}/, `date shown as ISO: «${t.match(/Вписано[^.]*\./)?.[0]}»`);
});

test("the radar says how to read it: closer to the edge is better", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const t = await page.eval(`(() => { const r = document.querySelector(".radar"); return r.innerText + " " + r.querySelector("svg").getAttribute("aria-label"); })()`).then(s => s.replace(/\s+/g, " "));
  assert.match(t, /(край|наружу|дальше от центра|ближе к краю)[^.]*лучше|лучше[^.]*(край|наружу|дальше от центра)/i, `radar has no scale hint: «${t.slice(-160)}»`);
});

test("with two trips by the same person, the dossier explains how they are combined into one score", { skip }, async () => {
  await open({ hash: "#/place/herceg-novi" });
  assert.equal(await page.eval(`document.querySelectorAll(".trip:not(.hidden-trip)").length`), 3);
  const t = await page.eval(`(document.querySelector(".trips").innerText + " " + [...document.querySelectorAll("#v-place .block p.small")].map(p => p.innerText).join(" ")).replace(/\\s+/g, " ")`);
  assert.match(t, /поездк[^.]*(вес|важнее|сильнее|учитыва|сводятся|средн)/i, "Михаил has a summer and a winter trip here; nothing says how they make one number");
});

test("the dossier names the strongest and weakest groups compared with SPb in words", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const panel = await scorePanel();
  assert.match(panel, /сильн|лучше всего|плюсы|лучше СПб/i, `«why is it №1?» — no words about what is good here: «${panel}»`);
  assert.match(panel, /слаб|хуже всего|минусы|хуже СПб/i, "no words about what is bad here");
});

/* =================== Hidden partner ratings in the dossier =================== */

test("the hidden-rating note at the score offers «Показать всё равно» right there", { skip }, async () => {
  await open({ hash: "#/place/budva" });
  assert.match(await scorePanel(), /скрыт/);
  assert.equal(await page.eval(`!!document.querySelector("#v-place .panel.pad [data-reveal]")`), true, "the reveal button is only far below, after the radar");
});

test("revealing Будва in its dossier gives its ranking row Вика's dot and year answer", { skip }, async () => {
  await open({ hash: "#/place/budva" });
  await page.tap({ text: "Показать всё равно", within: ".trips" });
  await page.waitFor(`/Вика 6\\/10/.test(document.querySelector(".year").innerText.replace(/\\s+/g, " "))`, 3000, "year revealed");
  await goto("#/rank");
  await page.waitFor(`document.querySelectorAll("#rank a.row").length > 3`, 3000);
  const r = await rowOf("Будва");
  assert.deepEqual(r.dots.map(d => d.who), ["Вика"]);
  assert.ok(r.chips.includes("год здесь: Вика 6/10"));
  assert.ok(!r.chips.some(c => /скрыт/.test(c)));
});

test("a hidden partner rating names the partner in the right grammatical case", { skip }, async () => {
  await open();
  const chip = (await rowOf("Будва")).chips.find(c => /скрыт/.test(c));
  assert.ok(!/оценка Вика(?![а-яё])/.test(chip), `«${chip}» — should be «оценка Вики скрыта…»`);
  await goto("#/place/budva");
  assert.ok(!/оценка Вика(?![а-яё])/.test(await scorePanel()), "the dossier says «оценка Вика»");
});

/* =================== Look and feel =================== */

test("in dark and light mode both people's dots stand out from the ranking panel (contrast at least 3:1)", { skip }, async () => {
  for (const dark of [false, true]) {
    await open({ dark });
    const panel = await rgb(`document.querySelector("#rank").closest(".panel")`);
    for (const cls of ["m", "v"]) {
      const c = await rgb(`document.querySelector("#rank .dot.${cls}")`);
      assert.ok(contrast(c, panel) >= 3, `${cls} dot contrast ${contrast(c, panel).toFixed(2)} in ${dark ? "dark" : "light"} mode`);
    }
  }
});

test("on a 1280px screen each ranking row keeps the name, the bar and the score on one line", { skip }, async () => {
  await open({ w: 1280, h: 800 });
  const bad = await page.eval(`[...document.querySelectorAll("#rank a.row")].map(r => { const n = r.querySelector(".name").getBoundingClientRect(), t = r.querySelector(".track").getBoundingClientRect(), s = r.querySelector(".score").getBoundingClientRect(); const mid = t.top + t.height / 2; return { name: r.querySelector(".name b").innerText, ok: n.right <= t.left + 1 && t.right <= s.left + 1 && mid > n.top - 4 && mid < Math.max(n.bottom, s.bottom) + 4 }; }).filter(x => !x.ok).map(x => x.name)`);
  assert.deepEqual(bad, []);
  assert.deepEqual(page.takeErrors(), []);
});

/* =================== cycle 2 regressions =================== */

// Contrast of each heat-table number as the eye sees it: cell and text are blended with the panel by the
// opacity of the cell and its row, so a faded row shows weaker colours than the legend above the table.
const HEAT_SEEN = `(() => {
  const parse = c => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const table = document.querySelector(".heat");
  let panel = [255, 255, 255];
  for (let x = table; x; x = x.parentElement) { const p = parse(getComputedStyle(x).backgroundColor); if (p.length === 3 || p[3] > 0.5) { panel = p.slice(0, 3); break; } }
  return [...document.querySelectorAll(".heat tbody tr")].flatMap(tr => [...tr.querySelectorAll("td.cell:not(.none)")].map(td => {
    let a = 1; for (let x = td; x && x !== table; x = x.parentElement) a *= Number(getComputedStyle(x).opacity);
    const mix = c => c.map((v, i) => v * a + panel[i] * (1 - a));
    const bg = mix(parse(getComputedStyle(td).backgroundColor).slice(0, 3)), fg = mix(parse(getComputedStyle(td).color).slice(0, 3));
    return { row: tr.querySelector("th").innerText.split("\\n")[0].trim(), thin: tr.classList.contains("pale"), text: td.innerText.trim(), opacity: +a.toFixed(2), ratio: +ratio(bg, fg).toFixed(2) };
  }));
})()`;

test("rows with few of our own ratings in the places × groups table keep full colours and readable numbers, in light and dark mode", { skip }, async () => {
  for (const dark of [false, true]) {
    await open({ dark });
    const cells = await page.eval(HEAT_SEEN);
    const thin = cells.filter(c => c.thin);
    assert.ok(thin.length > 10, "fixture: several rows rest mostly on world data");
    assert.deepEqual([...new Set(thin.filter(c => c.opacity < 0.99).map(c => c.row))], [], `${dark ? "dark" : "light"}: faded rows no longer match the «хуже СПб … лучше» key`);
    assert.deepEqual(cells.filter(c => c.ratio < 4.5).map(c => `${c.row} ${c.text}: ${c.ratio}:1`), [], `${dark ? "dark" : "light"}: numbers below 4.5:1 as seen`);
  }
});

test("in the places × groups table, a row's grey note says in words why it rests on world data, without a cryptic «скрыто»", { skip }, async () => {
  await open();
  const notes = await page.eval(`Object.fromEntries([...document.querySelectorAll(".heat tbody th.rowh")].map(th => [th.querySelector("a").innerText.trim(), (th.querySelector("small") || {}).innerText || ""]))`);
  assert.equal(notes["Порту"], "", "a place we both rated needs no note");
  assert.match(notes["Будва"], /оценка Вики скрыта/, `Будва (rated only by Вика): «${notes["Будва"]}»`);
  assert.match(notes["Лимасол"], /только мировые данные/, `Лимасол (no ratings): «${notes["Лимасол"]}»`);
  assert.ok(Object.values(notes).every(n => !/^\s*·?\s*(скрыто|данные)\s*$/.test(n)), "a one-word tag nobody can decode on a phone: " + JSON.stringify(notes));
  const intro = await blockNotes(1, "table");
  assert.match(intro, /скрыт[^.]*пока вы не оцените/i, `the text above the table does not explain hidden ratings: «${intro}»`);
  assert.doesNotMatch(intro, /бледн/i, "the text still talks about pale rows");
});

test("a place whose total shows as 3.0 is listed above SPb's 3.0, never below it", { skip }, async () => {
  const STAR10 = ["интернет", "кожа", "улица", "фонд", "шум", "пешком", "чистота", "эстетика", "море", "язык"];
  const sc = vals => Object.fromEntries(STAR10.map((k, i) => [k, vals[i % vals.length]]));
  const P = [
    place("sankt-peterburg", "Санкт-Петербург", "Россия", "RUS", 59.93863, 30.31413, { status: "база" }),
    place("porto", "Порту", "Португалия", "PRT", 41.14961, -8.61099), place("valensiya", "Валенсия", "Испания", "ESP", 39.46975, -0.37739),
    place("batumi", "Батуми", "Грузия", "GEO", 41.64228, 41.63392), place("belgrad", "Белград", "Сербия", "SRB", 44.80401, 20.46513),
  ];
  const R = [
    rating("a1", "porto", "Михаил", sc([4, 4.5, 3, 5, 2, 4])), rating("a2", "porto", "Вика", sc([3, 4, 3.5, 4, 2.5])),
    rating("b1", "valensiya", "Михаил", sc([2, 2.5, 3, 2, 3])), rating("b2", "valensiya", "Вика", sc([4.5, 5, 4, 5])),
    rating("c1", "batumi", "Михаил", sc([3.5, 2, 1.5, 2.5])), rating("c2", "batumi", "Вика", sc([2, 2.5, 3, 2])),
    rating("d1", "belgrad", "Михаил", sc([5, 5, 4.5, 2])), rating("d2", "belgrad", "Вика", sc([1.5, 2, 2, 1.5])),
  ];
  const one = k => Object.assign({ ...W0 }, Object.fromEntries(Object.keys(W0).map(g => [g, g === k ? 90 : 1])));
  const files = repo({ places: P, ratings: R, weights: [{ id: "mikhail", who: "Михаил", w: one("city") }, { id: "vika", who: "Вика", w: one("work") }] });
  await open({ files });
  for (const name of ["Вика", "Михаил", "Поровну"]) {
    await preset(name);
    const rs = (await rows()).filter(r => !r.pale);
    const spb = rs.findIndex(r => r.pos === "—");
    const below = rs.slice(spb + 1).filter(r => r.score >= 3).map(r => `${r.name} ${r.score.toFixed(1)}`);
    const above = rs.slice(0, spb).filter(r => r.score < 3).map(r => `${r.name} ${r.score.toFixed(1)}`);
    assert.deepEqual(below, [], `«${name}»: shown as 3.0 or more, yet below SPb 3.0`);
    assert.deepEqual(above, [], `«${name}»: shown below 3.0, yet above SPb`);
  }
});

test("«Итог ниже наших оценок» appears only for a gap you can see and names only what the total really includes", { skip }, async () => {
  await open({ hash: "#/place/herceg-novi" });
  const hn = await scorePanel();
  assert.match(hn, /Итог ниже наших оценок/, "fixture: Херцег-Нови's total is well below both of ours");
  assert.doesNotMatch(hn, /живущ/, `no residents' words in this repo, yet the dossier cites them: «${hn}»`);
  await open({ hash: "#/place/valensiya", files: repo() });
  const v = await scorePanel();
  const total = Number((await page.text(".bigscore b")).trim()), mine = Number(v.match(/Михаил (\d\.\d)/)[1]);
  assert.ok(mine - total < 0.2, `fixture: Валенсия ${total} against Михаил ${mine}`);
  assert.doesNotMatch(v, /Итог ниже/, `a ${(mine - total).toFixed(1)} difference does not need a long explanation: «${v}»`);
});

test("dates in «Цифры места» end with one period, not «г..»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const t = await page.eval(`document.getElementById("factsForm").innerText`);
  assert.match(t, /Вписано \d{1,2} [а-яё]+ \d{4}/);
  assert.doesNotMatch(t, /\.\./, `double period: «${(t.match(/[^\n]*\.\.[^\n]*/) || [""])[0]}»`);
});

test("dragging a weight slider marks the places that moved once the finger is lifted", { skip }, async () => {
  await open();
  await openDetails("#wdetails");
  const drag = async (key, values, release) => page.eval(`(() => {
    const r = document.getElementById("w-${key}");
    for (const v of ${JSON.stringify(values)}) { r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); }
    if (${release}) r.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  const before = await mainOrder();
  await drag("health", [20, 40, 60, 80, 95], false);
  const during = await mainOrder();
  assert.notDeepEqual(during, before, "this drag reorders the ranking");
  assert.equal(await page.eval(`document.querySelectorAll("#rank .chip.move").length`), 0, "no arrows flicker while dragging");
  await drag("health", [], true);
  const marks = await page.eval(`[...document.querySelectorAll("#rank .chip.move")].map(c => c.innerText)`);
  assert.ok(marks.length > 0 && marks.every(m => /^[↑↓]\d+$/.test(m)), `arrows after release: ${marks}`);
  assert.ok(marks.some(m => m.startsWith("↑")) && marks.some(m => m.startsWith("↓")), "a place that rose pushed another one down");
  assert.deepEqual(await mainOrder(), during, "release does not reorder again");
  assert.deepEqual(page.takeErrors(), []);
});
