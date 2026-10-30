import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles, mockLog } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

const T = "2026-10-01T00:00:00.000Z";
const PORTO = PLACES.find(p => p.id === "porto");
const NOWHERE = { id: "nigdevil", name: "Нигдевиль", country: "", cc: null, lat: null, lon: null, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T };
const MOUNTAIN = Object.assign({}, NOWHERE, { id: "gornaya", name: "Горная деревня", country: "Черногория", cc: "MNE" });
const withPlaces = (...extra) => repo({ places: PLACES.map(p => extra.find(x => x.id === p.id) || p).concat(extra.filter(x => !PLACES.some(p => p.id === x.id))) });
const portoWith = patch => withPlaces(Object.assign({}, PORTO, patch));
const cacheOf = (places = PLACES, ratings = RATINGS) => ({ docs: { places, ratings, weights: [] }, oids: {}, head: "h0", at: T });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const doc = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const savedPlace = (id, cond, what = cond) => page.waitFor(`(() => { const f = JSON.parse(localStorage.getItem("mock:files") || "{}")["places/${id}.json"]; return !!f && (${cond})(JSON.parse(f)); })()`, 6000, what);
const value = sel => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.value : null; })()`);
const factBlock = key => page.eval(`(() => { const i = document.querySelector('#factsForm [name="fact_${key}"]'); const b = i && i.closest(".fact"); return b ? { text: b.innerText, badge: b.querySelector(".badge") ? b.querySelector(".badge").innerText : null } : null; })()`);
const similarReady = () => page.waitFor(`document.getElementById("simBox") && !/Считаю/.test(document.getElementById("simBox").innerText)`, 8000, "similar places computed");
const remoteEdit = (id, patch) => page.eval(`(() => {
  const f = JSON.parse(localStorage.getItem("mock:files")); const p = JSON.parse(f["places/${id}.json"]);
  Object.assign(p, ${JSON.stringify(patch)}); f["places/${id}.json"] = JSON.stringify(p, null, 1) + "\\n";
  localStorage.setItem("mock:files", JSON.stringify(f));
  localStorage.setItem("mock:head", "h" + (Number((localStorage.getItem("mock:head") || "h0").slice(1)) + 10));
})()`);

async function openDossier(id, opts = {}) {
  await openApp(page, srv.url, Object.assign({ hash: "#/place/" + id }, opts));
  if (await page.eval(`!!document.getElementById("simBox")`)) await similarReady();
  return page;
}

const LAYOUT = `(() => {
  const out = { small: [], covered: [], overflow: document.documentElement.scrollWidth - innerWidth };
  const vis = e => { if (e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase()) + " «" + (e.innerText || e.name || "").trim().slice(0, 30) + "»";
  for (const e of [...document.querySelectorAll("#v-place button, #v-place a[href], #v-place input, #v-place select, #v-place textarea, #v-place summary")].filter(vis)) {
    const inline = e.tagName === "A" && getComputedStyle(e).display === "inline" || e.classList.contains("linkbtn");
    const r = e.getBoundingClientRect();
    if (!inline && !["checkbox", "radio"].includes(e.type) && Math.min(r.width, r.height) < 24) out.small.push(desc(e) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1));
    if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !(e.tagName === "INPUT" && hit.closest("label") === e.closest("label"))) out.covered.push(desc(e) + " under " + (hit.id ? "#" + hit.id : hit.className || hit.tagName));
  }
  scrollTo(0, 0);
  return out;
})()`;

const CONTRAST = `(sel => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgb = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = a => { const [r, g, b] = a.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  return [...document.querySelectorAll(sel)].filter(e => e.innerText.trim()).map(e => { const cs = getComputedStyle(e); const a = lum(rgb(cs.backgroundColor)), b = lum(rgb(cs.color)); return { text: e.innerText.trim(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }; });
})`;

/* ---------- header and navigation ---------- */

test("the header shows name, country, status, archetype and the questions for the next trip", { skip }, async () => {
  await openDossier("porto");
  assert.equal(await page.text("#v-place h1"), "Порту");
  const chips = await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText)`);
  assert.deepEqual(chips, ["Португалия", "кандидат", "город у моря"]);
  assert.match(await page.text("#v-place .panel.pad"), /Вопросы к следующей поездке: Проверить сырость зимой/);
  assert.deepEqual(page.takeErrors(), []);
});

test("«← Все места» goes back to the places list", { skip }, async () => {
  await openDossier("porto");
  await page.tap({ text: "← Все места" });
  await page.waitFor(`location.hash === "#/places" && !document.getElementById("v-places").hidden`, 4000, "places list");
  assert.match(await page.text("#v-places"), /Порту/);
});

test("«На карте» opens the map with this place's card", { skip }, async () => {
  await openDossier("porto");
  await page.tap({ text: "На карте", within: ".place-head" });
  await page.waitFor(`location.hash === "#/map" && !document.getElementById("sheet").hidden`, 5000, "map sheet");
  assert.equal(await page.text("#sheetBody h3"), "Порту");
  assert.match(await page.text("#sheetBody"), /оценок: 2/);
  assert.deepEqual(page.takeErrors(), []);
});

test("«Оценить» opens the rating form with this place already chosen", { skip }, async () => {
  await openDossier("batumi");
  await page.tap({ text: "Оценить", within: ".place-head" });
  await page.waitFor(`location.hash === "#/rate" && !document.getElementById("v-rate").hidden`, 4000, "rate form");
  assert.equal(await value("#fPlace"), "batumi");
});

test("the base city scores 3.0 by definition and cannot be rated", { skip }, async () => {
  await openDossier("sankt-peterburg");
  assert.match(await page.text(".bigscore"), /^3\.0\s+база по определению/);
  assert.equal(await page.eval(`[...document.querySelectorAll(".place-head a")].some(a => /Оценить/.test(a.innerText))`), false);
  assert.match(await page.text(".trips"), /СПб — точка отсчёта/);
  assert.deepEqual(page.takeErrors(), []);
});

test("a place without coordinates or country has no map button and says similar places cannot be compared", { skip }, async () => {
  await openDossier("nigdevil", { files: withPlaces(NOWHERE) });
  assert.equal(await page.text("#v-place h1"), "Нигдевиль");
  assert.equal(await page.eval(`[...document.querySelectorAll(".place-head a")].some(a => /На карте/.test(a.innerText))`), false);
  assert.match(await page.text("#simBox"), /нет координат и страны/);
  assert.match(await page.text("#v-place"), /Мировых данных по этому месту нет/);
  assert.deepEqual(page.takeErrors(), []);
});

test("an unknown place shows a not-found message with a way back to all places", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/net-takogo" });
  assert.match(await page.text("#v-place"), /Место не найдено/);
  await page.tap({ text: "Все места", within: "#v-place" });
  await page.waitFor(`location.hash === "#/places"`, 4000, "places list");
});

test("without a key, a shared place link says data is not connected instead of claiming the place does not exist", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto", token: false });
  const t = await page.text("#v-place");
  assert.match(t, /Данные не подключены/);
  assert.doesNotMatch(t, /Место не найдено/, "the place may well exist — we just cannot read the data yet");
});

/* ---------- big score ---------- */

test("the big score says what the total is made of", { skip }, async () => {
  await openDossier("porto");
  assert.match(await page.text(".bigscore"), /^\d\.\d\s+из 5, где 3 — как в СПб · заполнено \d+%/);
  assert.match(await page.text("#v-place .panel.pad"), /Из чего итог: Михаил \d\.\d · Вика \d\.\d · мировые данные \d\.\d/);
});

test("a place with enough of our own answers shows its position in the ranking", { skip }, async () => {
  const more = Object.assign({}, RATINGS.find(r => r.id === "r3"), { id: "r5", start: "2026-05-01", end: "2026-05-10", scores: { "интернет": 4, "кожа": 4, "улица": 4, "фонд": 3, "шум": 3, "пешком": 4 } });
  await openDossier("valensiya", { files: repo({ ratings: RATINGS.concat([more]) }) });
  assert.match(await page.text(".bigscore"), /№1 в рейтинге/);
});

test("a place kept out of the main ranking for too few own answers says so next to its score", { skip }, async () => {
  await openDossier("porto");
  const t = await page.text(".bigscore");
  assert.doesNotMatch(t, /№\d/, "Porto has only 4 of 10 ★ answers, so it is not ranked");
  assert.match(t, /своих (ответов|оценок)/, `the score line should explain why there is no rank, got: ${t}`);
});

test("a place we have not visited says its total comes from world data only", { skip }, async () => {
  await openDossier("belgrad");
  assert.match(await page.text("#v-place .panel.pad"), /Мы здесь ещё не были: итог посчитан только по мировым данным/);
  assert.match(await page.text(".trips"), /Своих оценок пока нет/);
});

/* ---------- radar, trips, year ---------- */

test("the radar legend names both people, world data and the SPb ring, and residents only when there are any", { skip }, async () => {
  await openDossier("porto");
  const legend = await page.text(".radar .legend");
  for (const w of ["Михаил", "Вика", "Данные", "СПб = 3"]) assert.ok(legend.includes(w), `legend has ${w}`);
  assert.ok(!legend.includes("Живущие"));
  assert.match(await page.eval(`document.querySelector(".radar svg").getAttribute("aria-label")`), /Порту/);
  await openDossier("porto", { files: portoWith({ ext: { "интернет": { res: 4 } } }) });
  assert.ok((await page.text(".radar .legend")).includes("Живущие"));
});

test("the year question shows both people's latest answers out of 10", { skip }, async () => {
  await openDossier("porto");
  const y = (await page.text(".year")).replace(/\s+/g, " ");
  assert.match(y, /Прожили бы здесь год\?/);
  assert.match(y, /Михаил 7\/10/);
  assert.match(y, /Вика 6\/10/);
});

test("only my own trips have «Изменить», and it opens that rating for editing", { skip }, async () => {
  await openDossier("porto");
  const trips = await page.eval(`[...document.querySelectorAll(".trip")].map(t => [t.querySelector(".who").innerText.split("·")[0].trim(), !!t.querySelector('a[href^="#/rate/"]')])`);
  assert.deepEqual(trips.sort(), [["Вика", false], ["Михаил", true]]);
  await page.tap({ text: "Изменить", within: ".trips" });
  await page.waitFor(`location.hash === "#/rate" && document.querySelector(".edit-head")`, 5000, "edit form");
  assert.match(await page.text(".edit-head"), /Правка оценки: Порту · Михаил/);
  assert.equal(await value("#fReview"), "Красиво, но сыро.");
  assert.equal(await page.text("#fSave"), "Сохранить правку");
});

test("trip comments and surprises are folded and open on tap; a veto is shown on the trip", { skip }, async () => {
  const r = Object.assign({}, RATINGS.find(x => x.id === "r1"), { notes: { city: "Узкие крутые улицы" }, surprises: "Дома не отапливаются", veto: "сырость в квартирах" });
  await openDossier("porto", { files: repo({ ratings: RATINGS.map(x => (x.id === "r1" ? r : x)) }) });
  const trip = '.trip[data-rid="r1"]';
  assert.match(await page.text(trip), /вето: сырость в квартирах/);
  assert.equal(await page.eval(`document.querySelector('${trip} details').open`), false, "comments start folded");
  await page.tap({ text: "Комментарии", within: trip });
  assert.equal(await page.eval(`document.querySelector('${trip} details').open`), true);
  assert.equal(await page.visible(`${trip} pre`), true);
  assert.match(await page.text(`${trip} pre`), /Город и быт: Узкие крутые улицы[\s\S]*Дома не отапливаются/);
});

test("a partner's rating stays hidden in year, review, radar and table until revealed, and the reveal is remembered", { skip }, async () => {
  await openDossier("tbilisi");
  assert.match((await page.text(".year")).replace(/\s+/g, " "), /Вика скрыто/);
  assert.match(await page.text("#v-place .panel.pad"), /оценка Вика скрыта до вашей/);
  assert.match(await page.text(".trips"), /Ваших оценок здесь пока нет/);
  assert.equal(await page.eval(`[...document.querySelectorAll(".radar svg path")].some(p => p.getAttribute("stroke") === "var(--v)")`), false);
  assert.equal(await page.eval(`[...document.querySelectorAll(".subtable td.n")].some(td => td.title.includes("скрыто"))`), true);
  await page.tap({ text: "Показать всё равно", within: ".trips" });
  assert.match((await page.text(".year")).replace(/\s+/g, " "), /Вика 4\/10/);
  assert.match(await page.text(".trips"), /Пыльно и шумно/);
  assert.equal(await page.eval(`[...document.querySelectorAll(".radar svg path")].some(p => p.getAttribute("stroke") === "var(--v)")`), true);
  await page.goto(srv.url + "#/places", 200);
  await page.goto(srv.url + "#/place/tbilisi", 400);
  assert.match(await page.text(".trips"), /Пыльно и шумно/, "still revealed after reload");
  assert.deepEqual(page.takeErrors(), []);
});

test("revealing a partner's rating does not wipe what I am typing in the place card", { skip }, async () => {
  await openDossier("tbilisi");
  await page.fill('#placeForm [name="questions"]', "Где снять квартиру без посредника?");
  await page.fill('[name="fact_dinner"]', "28");
  await page.tap({ text: "Показать всё равно", within: ".trips" });
  assert.equal(await value('#placeForm [name="questions"]'), "Где снять квартиру без посредника?", "unsaved card text is lost");
  assert.equal(await value('[name="fact_dinner"]'), "28", "unsaved number is lost");
});

/* ---------- subcategories ---------- */

test("«Показать пустые» lists every subcategory and stays on after a background sync", { skip }, async () => {
  await openDossier("porto");
  const rows = () => page.eval(`document.querySelectorAll(".subtable tbody tr:not(.grp)").length`);
  const before = await rows();
  await page.tap({ text: "Показать пустые" });
  const all = await rows();
  assert.ok(all > before, `${all} rows with empty ones vs ${before}`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 5000, "sync done");
  await sleep(200);
  assert.equal(await rows(), all);
  assert.equal(await page.eval(`document.getElementById("showEmpty").checked`), true);
  await page.tap({ text: "Показать пустые" });
  assert.equal(await rows(), before);
});

test("a place with nothing to show explains how to see the empty list, and the toggle shows it", { skip }, async () => {
  await openDossier("nigdevil", { files: withPlaces(NOWHERE) });
  assert.match(await page.text(".subtable"), /Включите «Показать пустые»/);
  await page.tap({ text: "Показать пустые" });
  assert.ok(await page.eval(`document.querySelectorAll(".subtable tbody tr:not(.grp)").length`) > 20);
});

/* ---------- world data ---------- */

test("world data shows a 12-month climate chart against SPb with a legend and the climate city", { skip }, async () => {
  await openDossier("porto");
  await page.waitFor(`document.querySelector(".clim svg")`, 5000, "climate chart");
  assert.equal(await page.eval(`[...document.querySelectorAll(".clim svg text")].filter(t => /^[а-я]{3}$/.test(t.textContent)).length`), 12);
  assert.equal(await page.eval(`document.querySelectorAll(".clim polyline").length`), 2);
  assert.equal(await page.eval(`document.querySelectorAll(".clim polyline[stroke-dasharray]").length`), 1, "SPb line is dashed");
  const legend = await page.eval(`document.querySelector(".clim").nextElementSibling.innerText`);
  assert.match(legend, /Порту, средняя °C/);
  assert.match(legend, /СПб, °C/);
  assert.match(legend, /осадки, мм/);
  assert.match(await page.eval(`document.querySelectorAll(".sec-head")[1].innerText`), /климат: Порту, 0 км · Csb/);
});

test("the base city's climate chart has no second SPb line", { skip }, async () => {
  await openDossier("sankt-peterburg");
  await page.waitFor(`document.querySelector(".clim svg")`, 5000, "climate chart");
  assert.equal(await page.eval(`document.querySelectorAll(".clim polyline").length`), 1);
  assert.doesNotMatch(await page.eval(`document.querySelector(".clim").nextElementSibling.innerText`), /СПб, °C/);
});

test("tapping a month on the climate chart shows its temperature and rainfall", { skip }, async () => {
  await openDossier("porto");
  const r = await page.eval(`(() => { const c = document.querySelectorAll(".clim circle[data-tip]")[6]; c.scrollIntoView({ block: "center" }); const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await page.click(r.x, r.y);
  await sleep(150);
  assert.match(await page.eval(`document.getElementById("tip").hidden ? "" : document.getElementById("tip").innerText`), /^июл: \d+(\.\d)? °C, осадки \d+ мм$/);
});

test("external links point to Numbeo, Weather Spark and Wikipedia for this place and open in a new tab", { skip }, async () => {
  await openDossier("porto");
  const links = await page.eval(`Object.fromEntries([...document.querySelectorAll("#v-place a[target=_blank]")].map(a => [a.innerText, { href: a.href, rel: a.rel }]))`);
  assert.equal(links["Numbeo: цены"].href, "https://www.numbeo.com/cost-of-living/city_result.jsp?country=Portugal&city=Porto");
  assert.equal(links["Weather Spark: погода"].href, "https://weatherspark.com/search?q=Porto");
  assert.equal(decodeURIComponent(new URL(links["Википедия"].href).searchParams.get("search")), "Порту Португалия");
  assert.equal(new URL(links["Википедия"].href).host, "ru.wikipedia.org");
  for (const l of Object.values(links)) assert.match(l.rel, /noopener/);
});

test("the Numbeo link never searches for a Russian name or an empty country", { skip }, async () => {
  for (const p of [NOWHERE, MOUNTAIN]) {
    await openDossier(p.id, { files: withPlaces(p) });
    const href = await page.eval(`(() => { const a = [...document.querySelectorAll("#v-place a")].find(a => /Numbeo/.test(a.innerText)); return a ? a.href : null; })()`);
    if (href == null) continue;
    const u = new URL(href);
    assert.doesNotMatch(u.searchParams.get("city") || "", /[а-яё]/i, `${p.name}: Numbeo only knows Latin city names, link ${href} lands on its generic page`);
    assert.ok(u.searchParams.get("country"), `${p.name}: Numbeo link without a country`);
  }
});

/* ---------- similar places ---------- */

test("similar places are split into the home country and abroad, and tapping one opens that city on the map", { skip }, async () => {
  await openDossier("porto");
  const heads = await page.eval(`[...document.querySelectorAll("#simBox .sim-h")].map(h => h.textContent)`);
  assert.deepEqual(heads, ["В стране: Португалия", "В других странах"]);
  const first = await page.eval(`document.querySelector("#simBox [data-city]").firstChild.textContent`);
  assert.match(await page.text("#simBox .sim-row .pct"), /^\d+%$/);
  await page.tap({ sel: "#simBox [data-city]" });
  await page.waitFor(`location.hash === "#/map" && !document.getElementById("sheet").hidden && document.querySelector("#sheetBody h3")`, 5000, "city sheet");
  assert.equal(await page.text("#sheetBody h3"), first);
  assert.deepEqual(page.takeErrors(), []);
});

test("«Показать на карте» colours the map by similarity to this place", { skip }, async () => {
  await openDossier("porto");
  await page.tap({ text: "Показать на карте", within: "#simBox" });
  await page.waitFor(`location.hash === "#/map" && !document.getElementById("legendBox").hidden`, 5000, "map legend");
  assert.match(await page.text("#legendBox"), /Похожие на «Порту»/);
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("wtl:layers")).simTo`), { type: "place", id: "porto" });
  assert.deepEqual(page.takeErrors(), []);
});

test("when nothing similar is found, «Показать на карте» is not offered", { skip }, async () => {
  await openDossier("gornaya", { files: withPlaces(MOUNTAIN) });
  const rows = await page.eval(`document.querySelectorAll("#simBox [data-city]").length`);
  const btn = await page.visible("#simMap");
  assert.ok(rows > 0 || !btn, `found ${rows} similar places but still offers «Показать на карте», which opens an empty layer`);
});

/* ---------- place numbers ---------- */

test("numbers typed with spaces, a comma or a euro sign are saved as plain numbers with their source", { skip }, async () => {
  await openDossier("porto");
  await page.fill('[name="fact_dinner"]', " 42,5 € ");
  await page.fill('[name="src_dinner"]', "5 ужинов в Рибейре");
  await page.fill('[name="fact_utilities"]', "1 200");
  await page.fill('[name="fact_basket"]', "€61");
  await page.tap({ text: "Сохранить цифры" });
  assert.match(await toastText(/Цифры сохранены/), /Цифры сохранены/);
  const f = (await doc("places/porto.json")).facts;
  assert.equal(f.dinner.v, 42.5);
  assert.equal(f.dinner.src, "5 ужинов в Рибейре");
  assert.match(f.dinner.at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(f.utilities.v, 1200);
  assert.equal(f.basket.v, 61);
  await page.waitFor(`document.querySelector('#factsForm [name="fact_dinner"]').value === "42.5"`, 4000, "form shows the saved number");
  assert.match((await factBlock("dinner")).text, /Вписано \d{4}-\d{2}-\d{2}/);
});

test("water hardness is scored by absolute points, not against SPb", { skip }, async () => {
  await openDossier("porto");
  await page.fill('[name="fact_tds"]', "250");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.querySelector("#factsForm [name=fact_tds]").closest(".fact").querySelector(".badge")`, 5000, "tds badge");
  assert.equal((await factBlock("tds")).badge, "2.3", "250 ppm is halfway between 2.5 at 200 and 2.0 at 300");
  await page.fill('[name="fact_tds"]', "80");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.querySelector("#factsForm [name=fact_tds]").closest(".fact").querySelector(".badge").innerText === "3.0"`, 5000, "soft water = 3");
});

test("a price copied with a European thousands dot is not saved as a tiny number", { skip }, async () => {
  await openDossier("porto");
  await page.fill('[name="fact_rent"]', "1.050 €");
  await page.fill('[name="src_rent"]', "idealista");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText || (JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).facts || {}).rent`, 6000, "saved or refused");
  const rent = ((await doc("places/porto.json")).facts || {}).rent;
  if (rent) assert.equal(rent.v, 1050, "idealista shows 1.050 € for one thousand fifty euros; saving 1.05 € makes Porto the cheapest place ever (score 5.0)");
  else assert.match(await page.text("#factsMsg"), /\S/);
});

test("clearing a saved number removes it and its score", { skip }, async () => {
  await openDossier("porto", { files: portoWith({ facts: { rent: { v: 800, src: "idealista", at: "2026-10-01" }, dinner: { v: 40, src: "", at: "2026-10-01" } } }) });
  assert.equal((await factBlock("rent")).badge, "2.1");
  await page.fill('[name="fact_rent"]', "");
  await page.tap({ text: "Сохранить цифры" });
  await savedPlace("porto", "p => !p.facts.rent", "rent removed");
  assert.deepEqual(Object.keys((await doc("places/porto.json")).facts), ["dinner"], "other numbers are kept");
  await page.waitFor(`!document.querySelector("#factsForm [name=fact_rent]").closest(".fact").querySelector(".badge")`, 4000, "badge gone");
  assert.doesNotMatch((await factBlock("rent")).text, /Вписано/);
});

test("changing only the source of a saved number keeps the number", { skip }, async () => {
  await openDossier("porto", { files: portoWith({ facts: { rent: { v: 800, src: "idealista", at: "2026-01-01" } } }) });
  await page.fill('[name="src_rent"]', "imovirtual, 25 объявлений");
  await page.tap({ text: "Сохранить цифры" });
  await savedPlace("porto", `p => p.facts.rent.src === "imovirtual, 25 объявлений"`, "source saved");
  assert.equal((await doc("places/porto.json")).facts.rent.v, 800);
});

test("a source typed without a number is not thrown away under a «saved» message", { skip }, async () => {
  await openDossier("porto");
  await page.fill('[name="src_rent"]', "idealista, 15 объявлений");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText || !document.getElementById("toast").hidden`, 6000, "some reaction");
  const toast = await page.eval(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText`);
  assert.doesNotMatch(toast, /Цифры сохранены/, "nothing was saved, the typed source was dropped");
  assert.equal(await value('[name="src_rent"]'), "idealista, 15 объявлений", "the typed source is still there to finish");
  assert.equal((await mockLog(page)).length, 0, "no empty commit");
});

test("saving with nothing changed says so and writes nothing", { skip }, async () => {
  await openDossier("porto");
  await page.tap({ text: "Сохранить цифры" });
  assert.equal(await page.text("#factsMsg"), "Ничего не изменилось.");
  await page.tap({ text: "Сохранить карточку" });
  assert.equal(await page.text("#placeMsg"), "Ничего не изменилось.");
  assert.equal((await mockLog(page)).length, 0);
});

test("SPb numbers show the default references and become the reference for other places", { skip }, async () => {
  await openDossier("sankt-peterburg");
  assert.match(await page.text("#v-place"), /Цифры СПб — ориентиры для сравнения/i);
  const ph = await page.eval(`Object.fromEntries(["rent", "dinner", "utilities"].map(k => [k, document.querySelector('[name="fact_' + k + '"]').placeholder]))`);
  assert.deepEqual(ph, { rent: "по умолчанию 550", dinner: "по умолчанию 35", utilities: "по умолчанию 90" });
  assert.equal(await page.eval(`document.querySelectorAll("#factsForm .badge").length`), 0, "SPb itself gets no score badges");
  await page.fill('[name="fact_rent"]', "600");
  await page.tap({ text: "Сохранить цифры" });
  await savedPlace("sankt-peterburg", "p => p.facts && p.facts.rent && p.facts.rent.v === 600", "SPb rent saved");
  await page.goto(srv.url + "#/place/porto", 400);
  assert.match((await factBlock("rent")).text, /СПб: €600\./);
  await page.fill('[name="fact_rent"]', "900");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`(document.querySelector("#factsForm [name=fact_rent]").closest(".fact").querySelector(".badge") || {}).innerText === "2.0"`, 5000, "1.5× the new SPb rent = 2.0");
});

test("a basket price tells why it has no score while SPb's basket is empty", { skip }, async () => {
  await openDossier("porto");
  await page.fill('[name="fact_basket"]', "48");
  await page.tap({ text: "Сохранить цифры" });
  await savedPlace("porto", "p => p.facts && p.facts.basket", "basket saved");
  await page.waitFor(`/Вписано/.test(document.querySelector("#factsForm [name=fact_basket]").closest(".fact").innerText)`, 4000, "re-rendered");
  const b = await factBlock("basket");
  assert.ok(b.badge || /СПб/.test(b.text), `basket 48 € got no score and no hint that SPb's basket has to be filled in first: «${b.text.slice(-80)}»`);
});

test("score badges stay readable in light and dark mode", { skip }, async () => {
  const files = portoWith({ facts: { rent: { v: 2000, src: "", at: "2026-10-01" }, dinner: { v: 12, src: "", at: "2026-10-01" }, tds: { v: 250, src: "", at: "2026-10-01" } } });
  const bad = [];
  try {
    for (const dark of [false, true]) {
      await page.viewport(390, 844, { dark });
      await openDossier("porto", { files });
      for (const x of await page.eval(`${CONTRAST}("#factsForm .badge, .world-row .s")`)) if (x.ratio < 3) bad.push(`${dark ? "dark" : "light"} ${x.text}: ${x.ratio.toFixed(2)}:1`);
    }
  } finally { await page.viewport(390, 844, { dark: false }); }
  assert.deepEqual(bad, [], "badge text contrast below 3:1");
});

/* ---------- place card ---------- */

test("the place card saves name, archetype and multi-line questions without changing the file", { skip }, async () => {
  await openDossier("porto");
  await page.fill('#placeForm [name="name"]', "  Порту, центр  ");
  await page.fill('#placeForm [name="archetype"]', "столица");
  await page.fill('#placeForm [name="questions"]', "Проверить сырость зимой\nГде парковаться?");
  await page.tap({ text: "Сохранить карточку" });
  assert.match(await toastText(/Карточка сохранена/), /Карточка сохранена/);
  const p = await doc("places/porto.json");
  assert.equal(p.name, "Порту, центр");
  assert.equal(p.archetype, "столица");
  assert.equal(p.questions, "Проверить сырость зимой\nГде парковаться?");
  assert.equal(p.status, "кандидат");
  assert.ok(!Object.keys(await mockFiles(page)).some(k => k.startsWith("places/") && k !== "places/porto.json" && /port/.test(k)), "renaming does not create a second file");
  await page.waitFor(`document.querySelector("#v-place h1").innerText === "Порту, центр"`, 4000, "header renamed");
});

test("rejecting a place saves the reason and shows it under the score", { skip }, async () => {
  await openDossier("valensiya");
  assert.equal(await page.visible("#reasonBox"), false);
  await page.select('#placeForm [name="status"]', "отсев");
  assert.equal(await page.visible("#reasonBox"), true);
  await page.fill('#placeForm [name="reason"]', "Слишком жарко летом");
  await page.tap({ text: "Сохранить карточку" });
  await savedPlace("valensiya", `p => p.status === "отсев" && p.reason === "Слишком жарко летом"`, "rejection saved");
  await page.waitFor(`/Причина отсева: Слишком жарко летом/.test(document.querySelector("#v-place .panel.pad").innerText)`, 4000, "reason under the score");
  assert.ok((await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText)`)).includes("отсев"));
});

test("the reason field hides again when the status goes back from отсев", { skip }, async () => {
  await openDossier("valensiya");
  await page.select('#placeForm [name="status"]', "отсев");
  assert.equal(await page.visible("#reasonBox"), true);
  await page.select('#placeForm [name="status"]', "финалист");
  assert.equal(await page.visible("#reasonBox"), false);
});

test("the archetype field suggests the usual archetypes", { skip }, async () => {
  await openDossier("porto");
  const opts = await page.eval(`(() => { const i = document.querySelector('#placeForm [name="archetype"]'); return i.list ? [...i.list.options].map(o => o.value) : []; })()`);
  assert.deepEqual(opts, ["курорт", "малый курорт", "город у моря", "мегаполис", "столица", "горы"]);
});

test("the base city's card has no status field and saving it keeps the base status", { skip }, async () => {
  await openDossier("sankt-peterburg");
  assert.equal(await page.eval(`!!document.querySelector('#placeForm [name="status"]')`), false);
  await page.fill('#placeForm [name="questions"]', "Сравнить коммуналку зимой");
  await page.tap({ text: "Сохранить карточку" });
  await savedPlace("sankt-peterburg", `p => p.questions === "Сравнить коммуналку зимой"`, "SPb card saved");
  assert.equal((await doc("places/sankt-peterburg.json")).status, "база");
});

test("clearing the name is refused with a clear message instead of «Ничего не изменилось»", { skip }, async () => {
  await openDossier("porto");
  await page.fill('#placeForm [name="name"]', "");
  await page.tap({ text: "Сохранить карточку" });
  const msg = await page.text("#placeMsg");
  assert.notEqual(msg, "Ничего не изменилось.", "the field visibly changed, the message contradicts it");
  assert.match(msg, /назван/i);
  assert.equal((await doc("places/porto.json")).name, "Порту");
});

/* ---------- both forms, sync, offline ---------- */

test("unsaved text in both forms survives a background sync and is saved on top of the other device's change", { skip }, async () => {
  await openDossier("porto");
  await page.fill('#placeForm [name="questions"]', "Набираю вопрос");
  await page.fill('[name="fact_dinner"]', "42");
  await remoteEdit("porto", { archetype: "мегаполис" });
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 5000, "sync done");
  assert.equal(await value('#placeForm [name="questions"]'), "Набираю вопрос");
  assert.equal(await value('[name="fact_dinner"]'), "42");
  await page.tap({ text: "Сохранить карточку" });
  await savedPlace("porto", `p => p.questions === "Набираю вопрос"`, "card saved");
  assert.equal(await value('[name="fact_dinner"]'), "42", "the other form is not reset by saving the card");
  await page.tap({ text: "Сохранить цифры" });
  await savedPlace("porto", "p => p.facts && p.facts.dinner && p.facts.dinner.v === 42", "numbers saved");
  const p = await doc("places/porto.json");
  assert.equal(p.archetype, "мегаполис", "the other device's change is kept");
  assert.equal(p.questions, "Набираю вопрос");
  assert.deepEqual(page.takeErrors(), []);
});

test("a card another device just changed is saved on the second tap, keeping both changes", { skip }, async () => {
  await openDossier("porto");
  await remoteEdit("porto", { archetype: "мегаполис" });
  await page.fill('#placeForm [name="questions"]', "Мой вопрос");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "clash message");
  assert.match(await page.text("#placeMsg"), /изменили на другом устройстве/);
  assert.equal(await value('#placeForm [name="questions"]'), "Мой вопрос");
  await page.tap({ text: "Сохранить карточку" });
  await savedPlace("porto", `p => p.questions === "Мой вопрос"`, "saved on second tap");
  assert.equal((await doc("places/porto.json")).archetype, "мегаполис");
});

test("a clash with another device is not reported as a network error", { skip }, async () => {
  await openDossier("porto");
  await remoteEdit("porto", { archetype: "мегаполис" });
  await page.fill('#placeForm [name="questions"]', "Мой вопрос");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "clash message");
  assert.doesNotMatch(await page.text("#syncText"), /Ошибка связи/, "the network is fine; the card just changed elsewhere");
});

test("saving the card offline queues it, shows it right away and sends it when the network is back", { skip }, async () => {
  await openDossier("porto");
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.fill('#placeForm [name="archetype"]', "малый курорт");
  await page.tap({ text: "Сохранить карточку" });
  assert.match(await toastText(/Нет связи/), /отправится позже/);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:pending")).length`), 1);
  assert.ok((await page.eval(`[...document.querySelectorAll(".place-head .chip")].map(c => c.innerText)`)).includes("малый курорт"));
  assert.match(await page.text("#syncText"), /В очереди: 1/);
  assert.equal((await doc("places/porto.json")).archetype, "город у моря");
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await doc("places/porto.json")).archetype, "малый курорт");
});

test("opened offline from the cache, the dossier still shows the place and its trips", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places", offline: true, local: { "wtl:cache": cacheOf() } });
  await page.goto(srv.url + "#/place/porto", 400);
  assert.match(await page.text("#syncText"), /Офлайн/);
  assert.equal(await page.text("#v-place h1"), "Порту");
  assert.match(await page.text(".trips"), /Красиво, но сыро/);
});

/* ---------- read-only ---------- */

test("without a key the dossier is read-only: inputs disabled, no save buttons, no edit links", { skip }, async () => {
  await openDossier("porto", { token: false, local: { "wtl:cache": cacheOf() } });
  assert.match(await page.text("#v-place"), /Данные не подключены/);
  assert.equal(await page.text("#v-place h1"), "Порту");
  const enabled = await page.eval(`[...document.querySelectorAll("#factsForm input, #placeForm input, #placeForm select, #placeForm textarea")].filter(i => !i.disabled && i.type !== "hidden").map(i => i.name)`);
  assert.deepEqual(enabled, []);
  assert.equal(await page.eval(`document.querySelectorAll("#v-place button[type=submit]").length`), 0);
  assert.equal(await page.eval(`[...document.querySelectorAll(".trips a")].some(a => /Изменить/.test(a.innerText))`), false);
  assert.equal(await page.eval(`document.getElementById("showEmpty").disabled`), false, "viewing options still work");
  assert.deepEqual(page.takeErrors(), []);
});

/* ---------- layout ---------- */

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`at ${w}px the dossier variants have no sideways scroll and no tiny or covered controls`, { skip }, async () => {
    const files = withPlaces(NOWHERE);
    const out = [];
    try {
      await page.viewport(w, h);
      for (const [id, opts] of [["tbilisi", {}], ["nigdevil", { files }], ["porto", { token: false, local: { "wtl:cache": cacheOf() } }]]) {
        await openDossier(id, Object.assign({ files }, opts));
        const r = await page.eval(LAYOUT);
        if (r.overflow > 1) out.push(`${id}: page scrolls sideways by ${r.overflow}px`);
        r.small.forEach(x => out.push(`${id}: small ${x}`));
        r.covered.forEach(x => out.push(`${id}: covered ${x}`));
      }
    } finally { await page.viewport(390, 844); }
    assert.deepEqual(out, []);
    assert.deepEqual(page.takeErrors(), []);
  });
}
