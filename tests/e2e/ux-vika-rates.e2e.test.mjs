import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDaysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const VIKA = { me: "Вика" };

async function asVika(opts = {}, vp = {}) {
  await page.viewport(vp.w || 390, vp.h || 844, { dark: !!vp.dark });
  await openApp(page, srv.url, Object.assign({ hash: "#/rate" }, VIKA, opts));
  if ((opts.hash || "#/rate") === "#/rate") await page.waitFor(`document.getElementById("fSave")`, 4000, "rate form");
  page.takeErrors();
}

async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
async function tryPress(sel) {
  try { await press(sel); return true; } catch (e) { if (/not found/.test(e.message)) return false; throw e; }
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const val = sel => page.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
const hash = () => page.eval("location.hash");
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const docAt = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async place => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);

async function stays(js, ms = 1500) {
  try { await page.waitFor(js, ms); return false; } catch { return true; }
}

async function saveAndLand(placeId) {
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 6000, "dossier of " + placeId);
}

async function editMine(placeId) {
  await page.goto(srv.url + "#/place/" + placeId, 300);
  await page.tap({ text: "Изменить", within: ".trips" });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
}

async function showAllQuestions() {
  if (await page.visible("#fShowAll")) await press("#fShowAll");
  await page.waitFor(`document.getElementById("fShowAll").hidden`, 3000, "all questions shown");
}

/* Visible running text inside a container: what the user reads, without button captions and field values. */
const prose = sel => page.eval(`(() => {
  const root = document.querySelector(${JSON.stringify(sel)});
  if (!root) return "";
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  for (let n; (n = w.nextNode());) {
    const e = n.parentElement;
    if (!e || e.closest("button, select, option, textarea, [hidden], .draft-chip")) continue;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (getComputedStyle(e).visibility === "hidden") continue;
    out.push(n.textContent);
  }
  return out.join(" ").replace(/\\s+/g, " ").trim();
})()`);

/* The .field wrapper that holds a segmented group with this aria-label. */
const fieldOf = label => `(() => { const g = document.querySelector('[aria-label=${JSON.stringify(label)}]'); return g && g.closest(".field"); })()`;
const fieldProse = label => page.eval(`(() => {
  const f = ${fieldOf(label)};
  if (!f) return "";
  return [...f.querySelectorAll(":scope > *")].filter(e => !e.matches(".seg, .lbl, [role=group]") && !e.hidden).map(e => e.innerText).join(" ").trim();
})()`);

const CONTRAST = sel => `(() => {
  const parse = c => c.match(/[\\d.]+/g).map(Number);
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = e => { for (let x = e; x; x = x.parentElement) { const p = parse(getComputedStyle(x).backgroundColor); if (p.length < 4 || p[3] > 0.5) return p; } return [255, 255, 255]; };
  const e = document.querySelector(${JSON.stringify(sel)});
  const a = lum(parse(getComputedStyle(e).color)), b = lum(bgOf(e));
  return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
})()`;

const T = "2026-10-01T00:00:00.000Z";
const vikaRating = (extra = {}) => Object.assign({
  id: "rv1", place: "batumi", who: "Вика", start: "2026-06-01", end: "2026-06-14", days: 14, season: "пик", mode: "удалёнка", housing: "жилой район",
  retro: false, year: 5, veto: "", review: "Море рядом.", scores: { "море": 4, "шум": 2 }, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: T, updatedAt: T,
}, extra);

/* ---------- who and where ---------- */

test("on Vika's phone the form is already filled in as Вика and the help explains the 1–5 scale against SPb", { skip }, async () => {
  await asVika();
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("[data-who]")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.who)`), ["Вика"]);
  const help = await page.text(".fcard .help");
  assert.match(help, /не глядя/, "says each rates without looking at the other");
  assert.match(help, /3 — как в СПб/, "3 is tied to SPb");
  assert.match(help, /лучше для нас/, "says that higher means better for us");
  assert.match(help, /Пропускайте/, "says unanswered questions may be skipped");
});

test("while editing her own rating Вика cannot hand it over to Михаил by tapping his name", { skip }, async () => {
  await asVika({ hash: "#/place/porto" });
  await editMine("porto");
  assert.match(await page.text(".edit-head"), /Порту · Вика/);
  const before = await docAt("ratings/r1.json");
  await tryPress('[data-who="Михаил"]');
  await score("шум", 2);
  await saveAndLand("porto");
  assert.equal((await docAt("ratings/r2.json")).who, "Вика", "the edited rating still belongs to Вика");
  assert.deepEqual(await docAt("ratings/r1.json"), before, "Михаил's own rating is untouched");
});

test("switching «Кто оценивает» to Михаил on Vika's phone says the rating will be filed under his name", { skip }, async () => {
  await asVika();
  assert.doesNotMatch(await prose("#rateForm"), /Михаил/, "nothing about Михаил while she rates as herself");
  await press('[data-who="Михаил"]');
  assert.match(await prose("#rateForm"), /Михаил/, "a visible note names whose rating this becomes");
});

test("rating a place Михаил has rated shows nothing of his answers in the form", { skip }, async () => {
  const ratings = RATINGS.map(r => (r.id === "r3" ? Object.assign({}, r, { review: "Секретный отзыв про Валенсию", year: 9 }) : r));
  await asVika({ files: repo({ ratings }) });
  await page.select("#fPlace", "Валенсия");
  const text = await page.text("#rateForm");
  assert.doesNotMatch(text, /Секретный отзыв/);
  assert.equal(await page.eval(`document.querySelectorAll('[data-year][aria-pressed="true"]').length`), 0, "his «год здесь» is not preselected");
  assert.equal(await page.eval(`document.querySelectorAll('[data-score][aria-pressed="true"]').length`), 0, "none of his scores are preselected");
});

test("the hint under «Место» names the map button exactly as the map card shows it", { skip }, async () => {
  await asVika();
  const hint = await page.text("#fPlaceHint");
  const quoted = (hint.match(/«([^»]+)»/) || [])[1];
  assert.ok(quoted, "the hint quotes a button name: " + hint);
  await page.goto(srv.url + "#/map", 300);
  await page.tap({ sel: "#searchInput" });
  await page.type("Херцег");
  await page.waitFor(`document.querySelector("#searchResults") && /Херцег/.test(document.querySelector("#searchResults").innerText)`, 5000, "search results");
  await page.tap({ within: "#searchResults", text: "Херцег-Нови" });
  await page.waitFor(`!document.getElementById("sheet").hidden && /Добав/.test(document.getElementById("sheetBody").innerText)`, 5000, "city card");
  const buttons = await page.eval(`[...document.querySelectorAll("#sheetBody button, #sheetBody a")].map(b => b.innerText.trim())`);
  assert.ok(buttons.includes(quoted), `the card has a button «${quoted}»; it has: ${buttons.filter(b => /Добав/.test(b)).join(", ")}`);
});

test("answers started before the place existed carry over when she adds the place on the map and taps «Оценить»", { skip }, async () => {
  await asVika();
  await page.fill("#fStart", "2026-10-01");
  await page.fill("#fEnd", "2026-10-14");
  await score("интернет", 4);
  await score("улица", 2);
  await sleep(400);
  await page.tap({ sel: "#fPlaceHint a" });
  await page.waitFor(`location.hash === "#/map"`, 3000, "map");
  await page.tap({ sel: "#searchInput" });
  await page.type("Херцег");
  await page.waitFor(`document.querySelector("#searchResults") && /Херцег/.test(document.querySelector("#searchResults").innerText)`, 5000, "search results");
  await page.tap({ within: "#searchResults", text: "Херцег-Нови" });
  await page.waitFor(`!document.getElementById("sheet").hidden && /Добав/.test(document.getElementById("sheetBody").innerText)`, 5000, "city card");
  await page.tap({ within: "#sheetBody", sel: "button", text: "Добавить" });
  await page.waitFor(`[...document.querySelectorAll("#sheetBody a")].some(a => a.innerText.trim() === "Оценить")`, 6000, "place added");
  await page.tap({ within: "#sheetBody", sel: "a", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace").value`, 4000, "rate form for the new place");
  const placeId = await val("#fPlace");
  assert.match(await page.eval(`document.getElementById("fPlace").selectedOptions[0].text`), /Херцег-Нови/);
  assert.equal(await val("#fStart"), "2026-10-01", "the dates she typed are still in the form");
  assert.match(await page.text("#fCounts"), /\b2 из 10/, "her two answers are still in the form");
  assert.ok(placeId);
});

/* ---------- dates ---------- */

test("the «Уехали» calendar does not offer days before «Приехали»", { skip }, async () => {
  await asVika();
  await page.fill("#fStart", "2026-09-10");
  assert.equal(await page.eval(`document.getElementById("fEnd").min`), "2026-09-10");
});

test("a year typo that puts the whole trip decades in the future is caught before saving", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fStart", "2062-08-01");
  await page.fill("#fEnd", "2062-08-14");
  await score("интернет", 4);
  await press("#fSave");
  assert.ok(await stays(`location.hash.startsWith("#/place/")`), "the form stays open");
  assert.deepEqual(await ratingsOn("batumi"), [], "nothing is saved");
  assert.match(await page.text("#fMsg"), /(будущ|ещё не|год|дат)/i, "the message points at the dates");
});

test("fixing a date while editing a rating written right after the trip does not turn it into «по памяти»", { skip }, async () => {
  const written = new Date(Date.now() - 88 * 864e5).toISOString();
  const r = vikaRating({ start: isoDaysAgo(103), end: isoDaysAgo(90), days: 14, retro: false, createdAt: written, updatedAt: written });
  await asVika({ files: repo({ ratings: RATINGS.concat(r) }), hash: "#/place/batumi" });
  await editMine("batumi");
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false);
  await page.fill("#fEnd", isoDaysAgo(91));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false, "the trip was rated two days after it ended, not from memory");
  await saveAndLand("batumi");
  const saved = await docAt("ratings/rv1.json");
  assert.equal(saved.end, isoDaysAgo(91));
  assert.equal(saved.retro, false, "the corrected rating keeps its full weight");
});

test("an end-before-start error goes away once she corrects the arrival date, and then it saves", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fStart", "2026-09-20");
  await page.fill("#fEnd", "2026-09-05");
  await score("интернет", 4);
  await press("#fSave");
  assert.match(await page.text("#fMsg"), /«Уехали» раньше, чем «Приехали»/);
  await page.fill("#fStart", "2026-09-01");
  assert.equal(await page.text("#fMsg"), "", "the stale error is gone");
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.start, "2026-09-01");
  assert.equal(r.days, 5);
});

/* ---------- trip context ---------- */

test("the season help explains every choice, including «пик»", { skip }, async () => {
  await asVika();
  const help = await fieldProse("Сезон");
  assert.match(help, /худший/i);
  assert.match(help, /межсезон/i);
  assert.match(help, /пик/i, "«пик» is explained too: " + help);
});

test("«Где жили» says what the choice is for or what each area means", { skip }, async () => {
  await asVika();
  const help = await fieldProse("Где жили");
  assert.ok(help.length > 15, "a short explanation under «Где жили», got: «" + help + "»");
});

test("the work question offers plain answers and the dossier shows how the trip went", { skip }, async () => {
  await asVika();
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-opt="mode"]')].map(b => b.innerText.trim())`), ["не работали", "работали все будни", "работали часть дней"]);
  await page.select("#fPlace", "Батуми");
  await page.fill("#fStart", "2026-09-01");
  await page.fill("#fEnd", "2026-09-14");
  await press('[data-opt="mode"][data-val="отпуск"]');
  await press('[data-opt="season"][data-val="межсезон"]');
  await score("море", 5);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.mode, "отпуск");
  const card = await page.eval(`document.querySelector('.trip[data-rid="${r.id}"]').innerText`);
  assert.match(card, /14 дн\./);
  assert.match(card, /межсезон/);
});

/* ---------- questions and scale ---------- */

test("every question she is asked says what 1 and 3 mean, and what 5 means unless the scale stops at 3", { skip }, async () => {
  await asVika();
  await showAllQuestions();
  const qs = await page.eval(`[...document.querySelectorAll("[data-q]")].map(q => ({ key: q.dataset.q, name: q.querySelector(".q-name").innerText, hint: (q.querySelector(".q-hint") || {}).innerText || "", max: Math.max(...[...q.querySelectorAll("[data-v]")].map(b => Number(b.dataset.v))) }))`);
  assert.ok(qs.length >= 30, "all form questions are on screen: " + qs.length);
  const bad = qs.filter(q => !/1 —/.test(q.hint) || !/3 —/.test(q.hint) || (q.max === 5 && !/5 —/.test(q.hint)) || (q.max === 3 && /[45] —/.test(q.hint)));
  assert.deepEqual(bad.map(q => q.name), []);
});

test("under every scale the ends say which side is worse than SPb and where «как СПб» is", { skip }, async () => {
  await asVika();
  await showAllQuestions();
  const ends = await page.eval(`[...document.querySelectorAll("[data-q]")].map(q => ({ name: q.querySelector(".q-name").innerText, capped: q.classList.contains("capped"), ends: [...q.querySelectorAll(".pick-ends span")].map(s => s.innerText.trim()) }))`);
  const bad = ends.filter(e => !/хуже/.test(e.ends[0]) || !e.ends.some(s => /как СПб/.test(s)) || (e.capped && !/как СПб/.test(e.ends[2])));
  assert.deepEqual(bad.map(e => e.name), []);
});

test("questions meant for one of us say who should answer them", { skip }, async () => {
  await asVika();
  await showAllQuestions();
  const q = key => page.eval(`(() => { const q = document.querySelector('[data-q="${key}"]'); return q.innerText; })()`);
  assert.match(await q("для_девушки"), /отвечает Вика/);
  assert.match(await q("кожа"), /отвечает тот/);
});

test("the internet question avoids tech jargon and gives speeds in plain units", { skip }, async () => {
  await asVika();
  const hint = await page.text('[data-q="интернет"] .q-hint');
  assert.doesNotMatch(hint, /speedtest/i, "no untranslated tool name: " + hint);
  assert.ok(!/\d{3}\+/.test(hint) || /Мбит/.test(hint), "a bare «300+» needs a unit: " + hint);
});

test("«Дороги и вождение» asks about what its hint describes", { skip }, async () => {
  await asVika();
  await showAllQuestions();
  const name = await page.text('[data-q="дороги"] .q-name');
  const hint = await page.text('[data-q="дороги"] .q-hint');
  assert.ok(!/вождени/i.test(name) || /(за рул|водит|вождени|машин)/i.test(hint), `name «${name}» promises driving, hint talks only about walking and taxis: «${hint}»`);
});

test("hints under the questions are readable in light and dark themes", { skip }, async () => {
  for (const dark of [false, true]) {
    await asVika({}, { dark });
    const c = await page.eval(CONTRAST('[data-q="интернет"] .q-hint'));
    assert.ok(c >= 4.5, `${dark ? "dark" : "light"}: hint contrast ${c} is below 4.5:1`);
  }
});

/* ---------- source, main questions, counters, comments ---------- */

test("the form explains what «откуда знаем» means and when to change it", { skip }, async () => {
  await asVika();
  await score("интернет", 4);
  await press('[data-conf="интернет"]');
  assert.equal(await page.visible('[data-confpick="интернет"]'), true);
  assert.match(await prose("#rateForm"), /откуда знаем/i, "running text, not only the pill, explains the source choice");
});

test("a source and a half point she picked show next to her score in the dossier", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await score("интернет", 3.5);
  await press('[data-conf="интернет"]');
  await press('[data-confset="интернет"][data-l="A"]');
  assert.match(await page.text('[data-conf="интернет"]'), /проверили в быту/);
  await saveAndLand("batumi");
  const row = await page.eval(`[...document.querySelectorAll(".subtable tr")].find(r => /Интернет дома/.test(r.innerText)).innerText`);
  assert.match(row, /3\.5\s*A/, "Вика's column shows 3.5 with the letter A: " + row);
  assert.match(await page.text("#v-place"), /A — в быту/, "the letter is explained on the page");
});

test("«Только главные вопросы» says the other questions are optional", { skip }, async () => {
  await asVika();
  const text = [await page.text('label[for="fOnlyStar"]'), await page.text("#fShowAll"), await prose("#rateForm")].join(" ");
  assert.match(text, /(остальн|другие)[^.]{0,60}(по желанию|необязательн|если было|можно пропустить|когда есть что)/i);
});

test("the counter in the save bar says it counts the main ★ questions", { skip }, async () => {
  await asVika();
  await score("интернет", 4);
  const c = await page.eval(`(() => { const e = document.getElementById("fCounts"); return [e.innerText, e.title, e.getAttribute("aria-label") || ""].join(" "); })()`);
  assert.match(c, /1 из 10/);
  assert.match(c, /главн/i, "the counter names what it counts: " + c);
});

test("a group comment says what to write and shows with her trip in the dossier under the group name", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await score("шум", 2);
  await press('[data-addnote="housing"]');
  assert.match(await page.text('[data-notebox="housing"] .lbl'), /почему/);
  await page.type("Окна дребезжат от мопедов");
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  const notes = await page.eval(`document.querySelector('.trip[data-rid="${r.id}"] details pre').textContent`);
  assert.match(notes, /Жильё: Окна дребезжат от мопедов/);
});

test("each «+ комментарий» button says which topic it is about, so the buttons are not eight identical links", { skip }, async () => {
  await asVika();
  const names = await page.eval(`[...document.querySelectorAll("[data-addnote]")].filter(b => !b.closest("[hidden]")).map(b => ({ group: b.closest("[data-group]").querySelector("h3").firstChild.textContent.trim(), name: (b.getAttribute("aria-label") || b.innerText).trim() }))`);
  assert.ok(names.length >= 6, "comment buttons on screen: " + names.length);
  const vague = names.filter(n => !n.name.includes(n.group));
  assert.deepEqual(vague.map(n => `${n.group}: «${n.name}»`), []);
});

/* ---------- final block ---------- */

test("the review label does not promise Михаил sees it on the map before he has rated the place", { skip }, async () => {
  await asVika();
  const label = await page.text('label[for="fReview"]');
  assert.ok(!/виден на карте/i.test(label) || /(после|когда|пока|скрыт)/i.test(label), "the review is blind like the rating: " + label);
});


test("her «Прожили бы здесь год?» answer shows next to her name as N/10", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await press('[data-year="7"]');
  await saveAndLand("batumi");
  assert.match(await page.text("#v-place .year"), /Вика\s*7\s*\/10/);
});

test("the veto field says a veto takes the place out of the ranking for both of us", { skip }, async () => {
  await asVika();
  const text = await page.eval(`(() => { const i = document.getElementById("fVeto"); return i.closest(".field").innerText + " " + i.placeholder; })()`);
  assert.match(text, /(обоих|из рейтинга|рейтинг)/i, "consequence of a veto: " + text);
});

test("a saved veto shows on her trip card and the place is listed as vetoed", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fVeto", "Сырость в каждой квартире");
  await saveAndLand("batumi");
  assert.match(await page.text("#v-place .trips"), /вето: Сырость в каждой квартире/);
  await page.goto(srv.url + "#/places", 300);
  const row = await page.eval(`[...document.querySelectorAll("#v-places a")].find(a => /Батуми/.test(a.innerText)).innerText`);
  assert.match(row, /вето/);
});

test("the next-trip questions field says Михаил will see them right away", { skip }, async () => {
  await asVika();
  const label = await page.text('label[for="fQuestions"]');
  assert.match(label, /(сразу|обоим|Михаил|видн)/i, "questions are not blind, unlike the rating: " + label);
});

test("while editing, the next-trip questions field shows what is already in the place card", { skip }, async () => {
  await asVika({ hash: "#/place/porto" });
  await editMine("porto");
  const shown = [await prose("#rateForm"), await page.eval(`document.getElementById("fQuestions").placeholder + " " + document.getElementById("fQuestions").value`)].join(" ");
  assert.match(shown, /Проверить сырость зимой/, "so she does not type the same question twice");
});

/* ---------- saving ---------- */

test("after saving a place Михаил has not rated, she is told he will not see her rating until he rates it", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await score("интернет", 4);
  await press("#fSave");
  const toast = await toastText(/Сохранено/);
  await page.waitFor(`location.hash === "#/place/batumi"`, 6000, "dossier");
  const all = toast + " " + (await page.text("#v-place"));
  assert.match(all, /(Михаил[^.]{0,60}(не увидит|не видит|увидит|скрыт))|(скрыт[^.]{0,30}Михаил)/i, "toast: " + toast);
});

test("after saving a place Михаил has rated, she sees his trip and is not told hers is hidden from him", { skip }, async () => {
  await asVika({ hash: "#/place/valensiya" });
  assert.match(await page.text("#v-place .trips"), /Михаил: оценка скрыта/);
  await page.goto(srv.url + "#/rate/new/valensiya", 300);
  await page.waitFor(`document.getElementById("fPlace").value === "valensiya"`, 3000, "place preselected");
  await score("интернет", 4);
  await press("#fSave");
  const toast = await toastText(/Сохранено/);
  await page.waitFor(`location.hash === "#/place/valensiya"`, 6000, "dossier");
  const trips = await page.text("#v-place .trips");
  assert.doesNotMatch(trips, /оценка скрыта/);
  assert.match(trips, /Михаил/);
  assert.doesNotMatch(toast + " " + trips, /(Михаил[^.]{0,40}не увидит)|(скрыт[^.]{0,30}от Михаил)/i);
});

test("the save confirmation does not claim the ranking changed while the place is still outside it", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await score("интернет", 4);
  await press("#fSave");
  const toast = await toastText(/Сохранено/);
  await page.waitFor(`location.hash === "#/place/batumi"`, 6000, "dossier");
  assert.match(await page.text("#v-place"), /пока не в рейтинге/, "the dossier knows the place is not ranked yet");
  assert.ok(!/Рейтинг обновился/.test(toast) || /(не в рейтинг|пока не|половин|мало)/i.test(toast), "toast: " + toast);
});

test("after saving she lands on the place with her new trip highlighted and the header shows when it was saved", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fStart", "2026-10-01");
  await page.fill("#fEnd", "2026-10-14");
  await score("море", 4.5);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.who, "Вика");
  const card = await page.eval(`(() => { const t = document.querySelector('.trip[data-rid="${r.id}"]'); return t && { flash: t.classList.contains("flash"), text: t.innerText }; })()`);
  assert.ok(card && card.flash, "her trip is highlighted");
  assert.match(card.text, /Вика/);
  assert.match(card.text, /1–14 октября 2026/);
  assert.match(card.text, /14 дн\./);
  assert.match(await page.text("#syncText"), /^Сохранено · \d\d:\d\d$/);
});

test("after saving, «Оценить» opens a clean form for the next trip, still as Вика", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await score("море", 4);
  await page.fill("#fReview", "Тихо и зелено.");
  await saveAndLand("batumi");
  await page.tap({ sel: ".bottomnav a", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fSave")`, 3000, "rate form");
  assert.equal(await val("#fPlace"), "");
  assert.equal(await val("#fReview"), "");
  assert.match(await page.text("#fCounts"), /\b0 из 10/);
  assert.equal(await page.visible(".edit-head"), false);
  assert.equal(await page.visible(".banner.drafts"), false, "no leftover draft");
  assert.equal(await page.eval(`document.querySelector('[data-who="Вика"]').getAttribute("aria-pressed")`), "true");
});

/* ---------- mistakes ---------- */

test("with only surprises written, the message says what is enough to save", { skip }, async () => {
  await asVika();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fSurprises", "Отопления нет вообще");
  await press("#fSave");
  const landed = !(await stays(`location.hash === "#/place/batumi"`, 1500));
  if (!landed) assert.match(await page.text("#fMsg"), /отзыв/i, "the message names the alternatives: " + (await page.text("#fMsg")));
});

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`at ${w}px a save error is shown in plain sight above the bottom tabs`, { skip }, async () => {
    await asVika({}, { w, h });
    await score("интернет", 4);
    await press("#fSave");
    assert.equal(await page.text("#fMsg"), "Выберите место.");
    const box = await page.eval(`(() => {
      const m = document.getElementById("fMsg").getBoundingClientRect();
      const nav = document.querySelector(".bottomnav"); const n = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : innerHeight;
      const hit = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      return { top: m.top, bottom: m.bottom, navTop: n, onTop: !!hit && (hit.id === "fMsg" || document.getElementById("fMsg").contains(hit)) };
    })()`);
    assert.ok(box.top > 50 && box.bottom <= box.navTop, JSON.stringify(box));
    assert.ok(box.onTop, "nothing covers the message");
    const p = await page.eval(`document.getElementById("fPlace").getBoundingClientRect().top`);
    assert.ok(p > 50 && p < h - 150, "the place field is scrolled into view: " + p);
  });
}

/* ---------- edit and delete ---------- */

test("after deleting her rating, Михаил's rating of that place is hidden again and the dossier says why", { skip }, async () => {
  await asVika({ hash: "#/place/porto" });
  assert.match(await page.text("#v-place .trips"), /Красиво, но сыро/, "she rated Porto, so his review is visible");
  await editMine("porto");
  assert.equal(await page.text("#fSave"), "Сохранить правку");
  await press("#fDelete");
  assert.equal(await page.text("#fDelete"), "Точно удалить?");
  await press("#fDelete");
  await page.waitFor(`location.hash === "#/place/porto"`, 5000, "dossier");
  assert.match(await toastText(/Оценка удалена/), /Оценка удалена/);
  assert.equal((await docAt("ratings/r2.json")).deleted, true);
  const trips = await page.text("#v-place .trips");
  assert.doesNotMatch(trips, /Красиво, но сыро/);
  assert.match(trips, /Михаил: оценка скрыта, пока вы не оцените это место сами/);
});

/* ---------- cycle 2: a place without world data that only the partner rated ---------- */

test("a dossier with no world data and only Vika's hidden rating does not claim there are no ratings at all", { skip }, async () => {
  const T = "2026-10-01T00:00:00.000Z";
  const bare = { id: "derevnya", name: "Деревня", country: "", cc: "", lat: null, lon: null, status: "кандидат", archetype: "", reason: "", questions: "", ext: {}, osm: null, geonameid: null, createdAt: T, updatedAt: T };
  const hers = Object.assign({}, RATINGS.find(r => r.who === "Вика"), { id: "rv-bare", place: "derevnya" });
  await page.viewport(390, 844);
  await openApp(page, srv.url, { hash: "#/place/derevnya", me: "Михаил", files: repo({ places: PLACES.concat(bare), ratings: RATINGS.concat(hers) }) });
  await page.waitFor(`document.querySelector("#v-place .bigscore")`, 4000, "dossier");
  const panel = (await page.text("#v-place .panel.pad")).replace(/\s+/g, " ");
  assert.doesNotMatch(panel, /нет ни наших оценок/, `the panel says there are no ratings and that Вика's rating is hidden: «${panel}»`);
  assert.match(await page.text("#v-place .bigscore"), /Вики скрыта/, "the score line says why there is no total");
  assert.match(await page.text("#v-place .bigscore"), /мировых данных[^.]*нет/, "and that there is no world data either");
  await page.tap({ text: "Показать всё равно", within: "#v-place .panel.pad" });
  await page.waitFor(`/\\d\\.\\d/.test(document.querySelector("#v-place .bigscore b").innerText)`, 4000, "revealed total");
  assert.deepEqual(page.takeErrors(), []);
});
