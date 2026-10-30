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
const BOOTED = `document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`;
const isoDaysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function fresh(opts = {}, vp = {}) {
  await page.viewport(vp.w || 390, vp.h || 844, { dark: !!vp.dark });
  await openApp(page, srv.url, opts);
  page.takeErrors();
}

async function reload() {
  await page.eval(`window.__before = 1`);
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__before && document.readyState === "complete" && ${BOOTED}`, 10000, "app reloaded");
  await page.waitFor(`document.getElementById("fSave")`, 4000, "rate form");
}

async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const val = sel => page.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
const pressed = sel => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.dataset.val || b.dataset.v || b.dataset.who || b.dataset.year || b.dataset.l || b.innerText)`);
const qval = k => page.eval(`document.querySelector('[data-qval="${k}"]').textContent`);
const shownQuestions = () => page.eval(`[...document.querySelectorAll("[data-q]")].filter(q => !q.closest("[hidden]")).map(q => q.dataset.q)`);
const chips = () => page.eval(`[...document.querySelectorAll(".draft-chip .linkbtn")].map(b => b.innerText.trim())`);
const hash = () => page.eval("location.hash");
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const docAt = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async place => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);
const pending = () => page.eval(`JSON.parse(localStorage.getItem("wtl:pending") || "[]")`);

async function stays(js, ms = 1500) {
  try { await page.waitFor(js, ms); return false; } catch { return true; }
}

async function saveAndLand(placeId) {
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 6000, "dossier of " + placeId);
}

async function openEdit(placeId, nth = 0) {
  await page.goto(srv.url + "#/place/" + placeId, 300);
  await page.tap({ text: "Изменить", nth });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
}

function otherDevice(path, change) {
  return page.eval(`(() => {
    const f = JSON.parse(localStorage.getItem("mock:files"));
    const d = JSON.parse(f[${JSON.stringify(path)}]);
    (${change})(d);
    f[${JSON.stringify(path)}] = JSON.stringify(d, null, 1) + "\\n";
    localStorage.setItem("mock:files", JSON.stringify(f));
    localStorage.setItem("mock:head", "h" + (Number((localStorage.getItem("mock:head") || "h0").slice(1)) + 7));
  })()`);
}

const fullRating = (extra = {}) => Object.assign({
  id: "r9", place: "batumi", who: "Михаил", start: "2026-05-02", end: "2026-05-16", days: 15, season: "межсезон", mode: "отпуск", housing: "туристическая зона",
  retro: false, year: 0, veto: "Сырость в квартирах", review: "Шумно у моря.", scores: { "шум": 1.5, "море": 4, "доставка": 2.5 }, conf: { "шум": "A", "море": "D" },
  notes: { housing: "Окна не держат шум." }, surprises: "Дорогое такси.", deleted: false, createdAt: T, updatedAt: T,
}, extra);

const CONTRAST = sel => `(() => {
  const parse = c => c.match(/[\\d.]+/g).map(Number);
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = e => { for (let x = e; x; x = x.parentElement) { const p = parse(getComputedStyle(x).backgroundColor); if (p.length < 4 || p[3] > 0.5) return p; } return [255, 255, 255]; };
  const e = document.querySelector(${JSON.stringify(sel)});
  const a = lum(parse(getComputedStyle(e).color)), b = lum(bgOf(e));
  return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
})()`;

/* ---------- who and where ---------- */

test("the place list offers every candidate sorted by name, but not SPb", { skip }, async () => {
  await fresh({ hash: "#/rate" });
  const opts = await page.eval(`[...document.getElementById("fPlace").options].map(o => o.text)`);
  assert.equal(opts[0], "— выберите —");
  assert.deepEqual(opts.slice(1), ["Батуми · Грузия", "Белград · Сербия", "Валенсия · Испания", "Порту · Португалия", "Тбилиси · Грузия"]);
  assert.ok(!opts.some(o => /Санкт-Петербург/.test(o)), "SPb is the yardstick, not something to rate");
});

test("who is rating starts as this device's person and the switch is what gets saved", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi", me: "Вика" });
  assert.deepEqual(await pressed("[data-who]"), ["Вика"]);
  await press('[data-who="Михаил"]');
  assert.deepEqual(await pressed("[data-who]"), ["Михаил"]);
  await score("интернет", 4);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.who, "Михаил");
});

test("answering «Кто вы на этом устройстве?» on the rate screen also fills «Кто оценивает»", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi", me: null });
  assert.match(await page.text("#rateBanner"), /Кто вы на этом устройстве/);
  assert.deepEqual(await pressed("[data-who]"), [], "nobody is preselected yet");
  await press('[data-setme="Вика"]');
  assert.doesNotMatch(await page.text("#rateBanner"), /Кто вы на этом устройстве/);
  assert.deepEqual(await pressed("[data-who]"), ["Вика"], "I just said I am Вика, the form should not ask again");
});

/* ---------- saving what was typed ---------- */

test("every answer typed into the form is saved exactly as entered", { skip }, async () => {
  await fresh({ hash: "#/rate" });
  await press('[data-who="Вика"]');
  await page.select("#fPlace", "Валенсия");
  await page.fill("#fStart", "2025-02-03");
  await page.fill("#fEnd", "2025-03-02");
  await press('[data-opt="season"][data-val="худший"]');
  await page.tap({ sel: '[data-opt="mode"]', text: "работали часть дней" });
  await press('[data-opt="housing"][data-val="центр"]');
  await score("интернет", 4.5);
  await score("улица", 2);
  await score("море", 5);
  await press('[data-conf="море"]');
  await press('[data-confset="море"][data-l="A"]');
  await press('[data-addnote="nature"]');
  await page.type("  Пляж в десяти минутах  ");
  await press('[data-year="7"]');
  await page.fill("#fReview", "  Тепло зимой, но сыро в квартирах.  ");
  await page.fill("#fSurprises", "Отопления нет вообще");
  await saveAndLand("valensiya");
  assert.match(await toastText(), /Сохранено/);
  const r = (await ratingsOn("valensiya")).find(x => x.who === "Вика");
  assert.ok(r, "Вика's rating is in the repo");
  assert.deepEqual(
    { start: r.start, end: r.end, days: r.days, season: r.season, mode: r.mode, housing: r.housing, retro: r.retro, year: r.year, review: r.review, surprises: r.surprises, veto: r.veto, scores: r.scores, conf: r.conf, notes: r.notes },
    { start: "2025-02-03", end: "2025-03-02", days: 28, season: "худший", mode: "смешанно", housing: "центр", retro: true, year: 7, review: "Тепло зимой, но сыро в квартирах.", surprises: "Отопления нет вообще", veto: "", scores: { "интернет": 4.5, "улица": 2, "море": 5 }, conf: { "море": "A" }, notes: { nature: "Пляж в десяти минутах" } },
  );
  assert.deepEqual(page.takeErrors(), []);
});

test("season, work and housing buttons switch off when tapped again", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press('[data-opt="season"][data-val="пик"]');
  await press('[data-opt="season"][data-val="межсезон"]');
  assert.deepEqual(await pressed('[data-opt="season"]'), ["межсезон"], "only one season at a time");
  await press('[data-opt="season"][data-val="межсезон"]');
  assert.deepEqual(await pressed('[data-opt="season"]'), []);
  await press('[data-opt="housing"][data-val="жилой район"]');
  await press('[data-opt="housing"][data-val="жилой район"]');
  await score("шум", 3);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.season, "");
  assert.equal(r.housing, "");
});

test("a half point shows as a decimal next to the question and is saved as a number", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("чистота", 2.5);
  assert.equal(await qval("чистота"), "2.5");
  assert.equal(await page.eval(`document.querySelector('[data-score="чистота"][data-v="2.5"]').getAttribute("aria-label")`), "2,5");
  await score("чистота", 3.5);
  assert.equal(await qval("чистота"), "3.5", "a second value replaces the first");
  await saveAndLand("batumi");
  assert.deepEqual((await ratingsOn("batumi"))[0].scores, { "чистота": 3.5 });
});

test("tapping the chosen score again clears the answer and its source", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('[data-conf="улица"]')).visibility`), "hidden", "no source to pick before there is an answer");
  await score("улица", 3.5);
  await press('[data-conf="улица"]');
  await press('[data-confset="улица"][data-l="C"]');
  assert.match(await page.text("#fCounts"), /★ 1 из 10/);
  await score("улица", 3.5);
  assert.equal(await qval("улица"), "");
  assert.match(await page.text("#fCounts"), /★ 0 из 10/);
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('[data-conf="улица"]')).visibility`), "hidden");
  await score("улица", 3.5);
  assert.equal(await page.text('[data-conf="улица"]'), "откуда знаем: видели как туристы", "the old source does not come back with a new answer");
});

test("the source picker shows the default, saves a changed source and leaves the default out", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await score("язык", 2);
  assert.equal(await page.text('[data-conf="интернет"]'), "откуда знаем: видели как туристы");
  await press('[data-conf="интернет"]');
  assert.equal(await page.visible('[data-confpick="интернет"]'), true);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-confset="интернет"]')].map(b => b.innerText)`), ["проверили в быту", "видели как туристы", "со слов живущих", "по сайтам и рейтингам"]);
  assert.deepEqual(await pressed('[data-confset="интернет"]'), ["B"]);
  await press('[data-confset="интернет"][data-l="D"]');
  assert.equal(await page.visible('[data-confpick="интернет"]'), false, "the picker closes after a choice");
  assert.equal(await page.text('[data-conf="интернет"]'), "откуда знаем: по сайтам и рейтингам");
  await saveAndLand("batumi");
  assert.deepEqual((await ratingsOn("batumi"))[0].conf, { "интернет": "D" });
});

test("capped questions only go up to 3, which means «как СПб»", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press("#fShowAll");
  for (const k of ["доставка", "вне_сезона", "религиозность"]) {
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('[data-score="${k}"]')].map(b => b.innerText)`), ["1", "1½", "2", "2½", "3"], k);
    assert.match(await page.text(`[data-q="${k}"] .pick-ends`), /сильно хуже[\s\S]*как СПб/, k);
  }
  await score("доставка", 2.5);
  await saveAndLand("batumi");
  assert.deepEqual((await ratingsOn("batumi"))[0].scores, { "доставка": 2.5 });
});

test("the 0–10 «год здесь» scale saves zero as an answer and clears on a second tap", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  assert.equal(await page.eval(`document.querySelectorAll("[data-year]").length`), 11);
  await press('[data-year="0"]');
  assert.deepEqual(await pressed("[data-year]"), ["0"]);
  await press('[data-year="0"]');
  assert.deepEqual(await pressed("[data-year]"), []);
  await press('[data-year="0"]');
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.year, 0, "«ни за что» is a real answer, not an empty one");
});

test("a group comment opens on demand, takes the typing and is saved trimmed", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  assert.equal(await page.visible("#note-housing"), false);
  await press('[data-addnote="housing"]');
  assert.equal(await page.eval("document.activeElement.id"), "note-housing", "the cursor lands in the comment");
  assert.equal(await page.visible('[data-addnote="housing"]'), false, "the add button is replaced by the box");
  await page.type("  Слышно соседей сверху.  ");
  await score("шум", 2);
  await saveAndLand("batumi");
  assert.deepEqual((await ratingsOn("batumi"))[0].notes, { housing: "Слышно соседей сверху." });
  assert.match(await page.text("#v-place"), /Комментарии/);
});

test("the star counter counts main and extra answers separately, and so do the groups", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  assert.equal(await page.text("#fCounts"), "главные ★ 0 из 10");
  await score("пешком", 4);
  await score("чистота", 3);
  await press("#fShowAll");
  await score("магазины", 4.5);
  assert.equal(await page.text("#fCounts"), "главные ★ 2 из 10 · ещё 1");
  assert.equal(await page.text("#gc-city"), "· 3 из 8");
});

/* ---------- main questions only ---------- */

test("«Только главные вопросы» shows the 10 star questions until «Показать остальные» is tapped", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  assert.equal(await page.eval(`document.getElementById("fOnlyStar").checked`), true);
  assert.equal((await shownQuestions()).length, 10);
  const label = await page.text("#fShowAll");
  const more = Number(label.match(/ещё (\d+)/)[1]);
  await press("#fShowAll");
  assert.equal((await shownQuestions()).length, 10 + more, "the button reveals exactly as many as it promised");
  assert.equal(await page.visible("#fShowAll"), false);
  assert.equal(await page.eval(`document.getElementById("fOnlyStar").checked`), false, "the checkbox follows the button");
  await press('label[for="fOnlyStar"]');
  assert.equal((await shownQuestions()).length, 10);
  assert.equal(await page.visible("#fShowAll"), true);
});

test("the choice to see all questions is remembered after a reload", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press('label[for="fOnlyStar"]');
  assert.equal(await page.eval(`document.getElementById("fOnlyStar").checked`), false);
  await reload();
  assert.equal(await page.eval(`document.getElementById("fOnlyStar").checked`), false);
  assert.ok((await shownQuestions()).length > 10);
});

test("an answered extra question stays visible when going back to main questions", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press("#fShowAll");
  await score("доставка", 2);
  await press('label[for="fOnlyStar"]');
  const shown = await shownQuestions();
  assert.ok(shown.includes("доставка"), "my answer is not hidden");
  assert.ok(!shown.includes("банк"), "unanswered extras are hidden");
  assert.equal(await page.text("#gc-city"), "· 1 из 4", "3 star questions of the group plus my answered extra");
});

test("clearing an extra answer in main-questions mode does not make the question vanish under the finger", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press("#fShowAll");
  await score("доставка", 2);
  await press('label[for="fOnlyStar"]');
  await score("доставка", 2);
  assert.equal(await qval("доставка"), "");
  assert.equal(await page.visible('[data-q="доставка"]'), true, "the question I just touched should stay so I can pick another value");
});

/* ---------- dates ---------- */

test("a trip that ended over a month ago is marked «по памяти» by itself, a fresh one is not", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await page.fill("#fStart", isoDaysAgo(12));
  await page.fill("#fEnd", isoDaysAgo(3));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false);
  await page.fill("#fStart", isoDaysAgo(60));
  await page.fill("#fEnd", isoDaysAgo(45));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), true);
  assert.equal(await page.eval(`document.getElementById("fEnd").min`), isoDaysAgo(60), "the date picker does not offer a departure before arrival");
});

test("the «по памяти» flag can be overridden by hand and the override is saved", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await page.fill("#fStart", isoDaysAgo(70));
  await page.fill("#fEnd", isoDaysAgo(50));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), true);
  await press('label[for="fRetro"]');
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false);
  await score("улица", 4);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.retro, false);
  assert.equal(r.days, 21);
});

test("choosing or correcting the place keeps the trip dates, season, work and housing already entered", { skip }, async () => {
  await fresh({ hash: "#/rate" });
  await page.fill("#fStart", "2026-03-01");
  await page.fill("#fEnd", "2026-03-10");
  await press('[data-opt="season"][data-val="межсезон"]');
  await press('[data-opt="mode"][data-val="удалёнка"]');
  await press('[data-opt="housing"][data-val="центр"]');
  await page.select("#fPlace", "Батуми");
  assert.equal(await val("#fStart"), "2026-03-01", "arrival date survives picking the place");
  assert.equal(await val("#fEnd"), "2026-03-10");
  assert.deepEqual(await pressed("[data-opt]"), ["межсезон", "удалёнка", "центр"]);
  await page.select("#fPlace", "Тбилиси");
  assert.equal(await val("#fStart"), "2026-03-01", "and survives correcting a wrong place");
  assert.deepEqual(await pressed("[data-opt]"), ["межсезон", "удалёнка", "центр"]);
});

/* ---------- validation and messages ---------- */

test("saving without a place says so and brings the place field into view", { skip }, async () => {
  await fresh({ hash: "#/rate" });
  await score("интернет", 4);
  await press("#fSave");
  assert.equal(await page.text("#fMsg"), "Выберите место.");
  const r = await page.eval(`(() => { const p = document.getElementById("fPlace").getBoundingClientRect(); const bar = document.querySelector(".savebar").getBoundingClientRect(); return { top: p.top, bottom: p.bottom, barTop: bar.top }; })()`);
  assert.ok(r.top >= 52 && r.bottom <= r.barTop, `place field visible between the top bar and the save bar: ${JSON.stringify(r)}`);
  assert.equal(await hash(), "#/rate");
});

test("saving with nobody chosen as rater asks who is rating", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi", me: null });
  await score("интернет", 4);
  await press("#fSave");
  assert.equal(await page.text("#fMsg"), "Выберите, кто оценивает.");
  assert.equal((await ratingsOn("batumi")).length, 0);
});

test("an empty form is not saved and the message says what is missing", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press('[data-opt="season"][data-val="пик"]');
  await press("#fSave");
  assert.equal(await page.text("#fMsg"), "Поставьте хотя бы одну оценку, ответьте «Прожили бы здесь год?» или напишите отзыв.");
  assert.equal(await page.eval(`document.getElementById("fMsg").classList.contains("err")`), true);
  assert.deepEqual(await mockLog(page), []);
});

test("the error message goes away as soon as I answer something", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await press("#fSave");
  assert.notEqual(await page.text("#fMsg"), "");
  await score("шум", 2);
  assert.equal(await page.text("#fMsg"), "");
});

test("a review alone is enough to save a rating", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await page.fill("#fReview", "Были один день, город понравился.");
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.review, "Были один день, город понравился.");
  assert.deepEqual(r.scores, {});
});

test("a veto alone is enough to save a rating", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await page.fill("#fVeto", "Жара +40 всё лето");
  await press("#fSave");
  assert.notEqual(await page.text("#fMsg"), "Поставьте хотя бы одну оценку, ответьте «Прожили бы здесь год?» или напишите отзыв.", "«место отпадает совсем» is a complete answer");
  await page.waitFor(`location.hash === "#/place/batumi"`, 5000, "dossier");
  assert.equal((await ratingsOn("batumi"))[0].veto, "Жара +40 всё лето");
});

test("pressing Enter in the veto field does not save a half-filled rating", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await press("#fVeto");
  await page.type("шумно ночью");
  await page.key("Enter");
  assert.ok(await stays(`location.hash !== "#/rate"`), "the form is still open after Enter");
  assert.equal((await ratingsOn("batumi")).length, 0, "nothing was saved behind my back");
  assert.equal(await val("#fVeto"), "шумно ночью");
});

test("while saving the button says so and a second tap does not save twice", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.eval(`localStorage.setItem("mock:delay", "900")`);
  await press("#fSave", 60);
  assert.equal(await page.text("#fSave"), "Сохраняю…");
  assert.equal(await page.eval(`document.getElementById("fSave").disabled`), true);
  await page.tap({ sel: "#fSave" }, 60);
  await page.waitFor(`location.hash === "#/place/batumi"`, 8000, "dossier");
  await page.eval(`localStorage.removeItem("mock:delay")`);
  assert.equal((await ratingsOn("batumi")).length, 1);
  assert.equal((await mockLog(page)).filter(e => e.op === "add").length, 1);
});

test("without a key saving is off and the save bar says why", { skip }, async () => {
  await fresh({ hash: "#/rate", token: false });
  assert.match(await page.text("#rateBanner"), /Данные не подключены/);
  assert.equal(await page.eval(`!!document.querySelector('#rateBanner a[href="#/settings"]')`), true);
  await score("интернет", 4);
  assert.equal(await page.eval(`document.getElementById("fSave").disabled`), true);
  assert.match(await page.text(".savebar"), /ключ|настройк|подключ/i, "a phone shows no tooltip, so the reason must be readable next to the greyed button");
});

/* ---------- offline ---------- */

test("a rating saved offline shows in the dossier at once and can still be corrected before it is sent", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await score("интернет", 4);
  await page.fill("#fReview", "Сеть падала дважды.");
  await saveAndLand("batumi");
  assert.match(await toastText(/Нет связи/), /отправится позже/);
  assert.match(await page.text("#v-place"), /Сеть падала дважды/);
  assert.match(await page.text("#syncText"), /в очереди: 1|В очереди: 1/);
  await page.tap({ text: "Изменить" });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  assert.equal(await qval("интернет"), "4");
  await score("интернет", 2.5);
  await saveAndLand("batumi");
  assert.equal((await ratingsOn("batumi")).length, 0, "nothing reached the repo yet");
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1, "one rating, not two");
  assert.deepEqual(rs[0].scores, { "интернет": 2.5 });
  assert.equal(rs[0].review, "Сеть падала дважды.");
});

/* ---------- editing ---------- */

test("editing a rating loads every saved answer back into the form", { skip }, async () => {
  await fresh({ hash: "#/place/batumi", files: repo({ ratings: RATINGS.concat([fullRating()]) }) });
  await openEdit("batumi");
  assert.match(await page.text(".edit-head"), /Правка оценки: Батуми · Михаил · 2–16 мая 2026/);
  assert.equal(await page.eval(`document.getElementById("fPlace").disabled`), true);
  assert.equal(await page.text("#fSave"), "Сохранить правку");
  assert.equal(await val("#fPlace"), "batumi");
  assert.equal(await val("#fStart"), "2026-05-02");
  assert.equal(await val("#fEnd"), "2026-05-16");
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false);
  assert.deepEqual(await pressed("[data-opt]"), ["межсезон", "отпуск", "туристическая зона"]);
  assert.deepEqual(await pressed("[data-year]"), ["0"]);
  assert.equal(await qval("шум"), "1.5");
  assert.equal(await qval("море"), "4");
  assert.equal(await qval("доставка"), "2.5");
  assert.ok((await shownQuestions()).includes("доставка"), "an answered extra question is shown even in main-questions mode");
  assert.equal(await page.text('[data-conf="шум"]'), "откуда знаем: проверили в быту");
  assert.equal(await page.text('[data-conf="море"]'), "откуда знаем: по сайтам и рейтингам");
  assert.equal(await val("#note-housing"), "Окна не держат шум.");
  assert.equal(await page.visible("#note-housing"), true);
  assert.equal(await val("#fReview"), "Шумно у моря.");
  assert.equal(await val("#fSurprises"), "Дорогое такси.");
  assert.equal(await val("#fVeto"), "Сырость в квартирах");
});

test("saving an edit rewrites the same rating and keeps everything I did not touch", { skip }, async () => {
  await fresh({ hash: "#/place/batumi", files: repo({ ratings: RATINGS.concat([fullRating()]) }) });
  await openEdit("batumi");
  await score("шум", 2);
  await saveAndLand("batumi");
  assert.match(await toastText(), /Сохранено/);
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1, "no second rating appeared");
  const r = rs[0];
  assert.equal(r.id, "r9");
  assert.equal(r.createdAt, T);
  assert.ok(r.updatedAt > T);
  assert.deepEqual(r.scores, { "шум": 2, "море": 4, "доставка": 2.5 });
  assert.deepEqual(r.conf, { "шум": "A", "море": "D" });
  assert.deepEqual(r.notes, { housing: "Окна не держат шум." });
  assert.equal(r.year, 0);
  assert.equal(r.veto, "Сырость в квартирах");
  assert.equal((await mockLog(page)).filter(e => e.op === "add").map(e => e.path).join(), "ratings/r9.json");
});

test("«Новая оценка» parks the unsaved edit as a draft that can be reopened", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await score("шум", 2);
  await press("#fNew");
  assert.equal(await page.visible(".edit-head"), false);
  assert.equal(await val("#fPlace"), "");
  assert.equal(await page.eval(`document.getElementById("fPlace").disabled`), false);
  assert.equal(await page.text("#fSave"), "Сохранить");
  assert.deepEqual(await chips(), ["правка: Порту (6 ответов)"]);
  await page.tap({ sel: ".draft-chip .linkbtn" });
  assert.match(await page.text(".edit-head"), /Правка оценки: Порту/);
  assert.equal(await qval("шум"), "2", "my unsaved change is still there");
});

test("«Отменить правку» throws the changes away and leaves the saved rating untouched", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  const before = await docAt("ratings/r1.json");
  await openEdit("porto");
  await score("шум", 2);
  await page.fill("#fReview", "Передумал");
  await press("#fCancel");
  assert.equal(await page.text("#fMsg"), "Правка отменена");
  assert.equal(await page.visible(".edit-head"), false);
  assert.deepEqual(await chips(), [], "no draft is left behind");
  assert.equal(await val("#fReview"), "");
  assert.deepEqual(await docAt("ratings/r1.json"), before);
  assert.deepEqual(await mockLog(page), []);
});

test("deleting a rating needs a second tap, and the first tap wears off", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await press("#fDelete");
  assert.equal(await page.text("#fDelete"), "Точно удалить?");
  assert.equal((await docAt("ratings/r1.json")).deleted, false);
  await page.waitFor(`document.getElementById("fDelete").innerText === "Удалить оценку"`, 7000, "delete disarmed");
  await press("#fDelete");
  await press("#fDelete");
  await page.waitFor(`location.hash === "#/place/porto"`, 5000, "dossier");
  assert.match(await toastText(), /Оценка удалена/);
  assert.equal((await docAt("ratings/r1.json")).deleted, true);
  assert.doesNotMatch(await page.text("#v-place"), /Красиво, но сыро/);
});

test("a rating deleted offline disappears at once and the deletion is sent later", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await press("#fDelete");
  await press("#fDelete");
  assert.match(await toastText(/Нет связи/), /удаление отправится позже/);
  assert.equal(await hash(), "#/place/porto");
  assert.doesNotMatch(await page.text("#v-place"), /Красиво, но сыро/);
  assert.equal((await pending()).length, 1);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await docAt("ratings/r1.json")).deleted, true);
});

test("«Очистить форму» needs a second tap and keeps the chosen place", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("шум", 2);
  await page.fill("#fReview", "Отзыв");
  await press('[data-year="5"]');
  await press("#fReset");
  assert.equal(await page.text("#fReset"), "Точно стереть все ответы?");
  assert.equal(await qval("шум"), "2", "one tap erases nothing");
  await press("#fReset");
  assert.equal(await page.text("#fMsg"), "Форма очищена");
  assert.equal(await qval("шум"), "");
  assert.equal(await val("#fReview"), "");
  assert.deepEqual(await pressed("[data-year]"), []);
  assert.equal(await val("#fPlace"), "batumi");
  assert.equal(await page.text("#fReset"), "Очистить форму");
});

test("the «у вас уже есть оценка» banner opens my earlier rating and keeps the new draft", { skip }, async () => {
  await fresh({ hash: "#/rate/new/porto" });
  assert.match(await page.text("#fTop"), /У вас уже есть оценка этого места за 1–20 августа 2026/);
  await score("шум", 2);
  await page.tap({ text: "исправьте прежнюю" });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  assert.equal(await page.text("#fSave"), "Сохранить правку");
  assert.equal(await qval("эстетика"), "5", "my earlier answers are loaded");
  assert.deepEqual(await chips(), ["Порту (1 ответ)"], "the new trip I started is parked, not lost");
});

/* ---------- drafts ---------- */

test("drafts for different places are kept apart and the chips switch between them", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Про Батуми");
  await page.goto(srv.url + "#/rate/new/valensiya", 300);
  assert.equal(await val("#fReview"), "", "a new place starts clean");
  await score("море", 5);
  assert.deepEqual(await chips(), ["Батуми (1 ответ)"]);
  await page.tap({ sel: ".draft-chip .linkbtn" });
  assert.equal(await val("#fPlace"), "batumi");
  assert.equal(await val("#fReview"), "Про Батуми");
  assert.equal(await qval("интернет"), "4");
  assert.equal(await qval("море"), "");
  assert.deepEqual(await chips(), ["Валенсия (1 ответ)"]);
});

test("two unsaved drafts for the same place can both be reached from the chips", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.goto(srv.url + "#/rate/new/porto", 300);
  await score("улица", 2);
  await score("шум", 2);
  await page.select("#fPlace", "Батуми");
  assert.equal(await page.text("#fCounts"), "главные ★ 2 из 10");
  assert.deepEqual(await chips(), ["Батуми (1 ответ)"]);
  await page.tap({ sel: ".draft-chip .linkbtn" });
  assert.equal(await page.text("#fCounts"), "главные ★ 1 из 10");
  assert.deepEqual(await chips(), ["Батуми (2 ответа)"], "the chip leads to the other draft, not to the one I am in");
});

test("an unsaved rating survives a reload", { skip }, async () => {
  await fresh({ hash: "#/rate" });
  await page.select("#fPlace", "Валенсия");
  await page.fill("#fStart", "2026-07-01");
  await page.fill("#fEnd", "2026-07-10");
  await press('[data-opt="season"][data-val="пик"]');
  await score("море", 5);
  await press('[data-addnote="nature"]');
  await page.type("Пляж в 10 минутах");
  await press('[data-year="8"]');
  await page.fill("#fReview", "Хорошо летом");
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes("Хорошо летом")`, 3000, "draft written");
  await reload();
  assert.equal(await val("#fPlace"), "valensiya");
  assert.equal(await val("#fStart"), "2026-07-01");
  assert.deepEqual(await pressed('[data-opt="season"]'), ["пик"]);
  assert.equal(await qval("море"), "5");
  assert.equal(await val("#note-nature"), "Пляж в 10 минутах");
  assert.equal(await page.visible("#note-nature"), true);
  assert.deepEqual(await pressed("[data-year]"), ["8"]);
  assert.equal(await val("#fReview"), "Хорошо летом");
});

test("an edit in progress survives a reload and is still saved as the same rating", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await score("шум", 1.5);
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes('"шум":1.5')`, 3000, "draft written");
  await reload();
  assert.match(await page.text(".edit-head"), /Правка оценки: Порту/);
  assert.equal(await qval("шум"), "1.5");
  await saveAndLand("porto");
  const r = await docAt("ratings/r1.json");
  assert.equal(r.scores["шум"], 1.5);
  assert.equal((await ratingsOn("porto")).length, 2, "still Михаил's and Вика's ratings only");
});

/* ---------- clashes ---------- */

test("after a clash, reopening the rating from the dossier shows the newer version and saving works", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await otherDevice("ratings/r1.json", `d => { d.review = "Изменено на телефоне"; }`);
  await score("интернет", 2);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText`, 6000, "clash message");
  assert.match(await page.text("#fMsg"), /изменили на другом устройстве/);
  await page.goto(srv.url + "#/place/porto", 300);
  await page.tap({ text: "Изменить" });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  assert.equal(await val("#fReview"), "Изменено на телефоне", "the reopened form shows what the other device saved");
  if (await qval("интернет") !== "2") await score("интернет", 2);
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/porto" || /изменили/.test(document.getElementById("fMsg").innerText)`, 6000, "second save");
  assert.equal(await page.text("#fMsg"), "", "following the advice must not clash again");
  const r = await docAt("ratings/r1.json");
  assert.equal(r.scores["интернет"], 2);
  assert.equal(r.review, "Изменено на телефоне");
});

test("reopening an edit parked as a draft after another device changed it does not overwrite that change", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await page.fill("#fReview", "Моя правка");
  await press("#fNew");
  await otherDevice("ratings/r1.json", `d => { d.surprises = "с другого устройства"; }`);
  await page.eval(`(async () => { await (await import("./js/app.js")).state.data.refresh(); })()`);
  await openEdit("porto");
  assert.equal(await val("#fSurprises"), "с другого устройства", "the reopened form is the newer version");
  assert.deepEqual(await chips(), ["правка: Порту (5 ответов)"], "my unsaved edit is kept as a draft");
  await score("интернет", 2);
  await saveAndLand("porto");
  const r = await docAt("ratings/r1.json");
  assert.equal(r.surprises, "с другого устройства");
  assert.equal(r.scores["интернет"], 2);
});

test("answering «Кто вы» on the rate screen keeps the place I picked", { skip }, async () => {
  await fresh({ hash: "#/rate/new/porto", me: null });
  await page.select("#fPlace", "Батуми");
  await score("интернет", 4);
  await press('[data-setme="Михаил"]');
  assert.equal(await val("#fPlace"), "batumi");
  assert.equal(await qval("интернет"), "4");
});

test("a clash is explained in plain words, not as a connection error or a file path", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await openEdit("porto");
  await otherDevice("ratings/r1.json", `d => { d.year = 2; }`);
  await score("интернет", 2);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText`, 6000, "clash message");
  assert.notEqual(await page.text("#syncText"), "Ошибка связи", "the network is fine");
  const all = (await page.text("#rateBanner")) + "\n" + (await page.text("#fMsg"));
  assert.doesNotMatch(all, /ratings\/|\.json/, "no repo paths in what the user reads");
});

test("a new rating with questions still saves when the place card was edited on another device", { skip }, async () => {
  await fresh({ hash: "#/rate/new/porto" });
  await score("интернет", 4);
  await page.fill("#fQuestions", "Где стирать зимой?");
  await otherDevice("places/porto.json", `d => { d.archetype = "город у реки"; }`);
  await press("#fSave");
  await page.waitFor(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText`, 6000, "save finished");
  assert.equal(await page.text("#fMsg"), "", "there is no earlier rating of mine to «reopen from the dossier»");
  assert.equal(await hash(), "#/place/porto");
  const p = await docAt("places/porto.json");
  assert.equal(p.archetype, "город у реки", "the other device's change is kept");
  assert.equal(p.questions, "Проверить сырость зимой\nГде стирать зимой?");
  assert.equal((await ratingsOn("porto")).length, 3);
});

test("an edit link opened before the data has loaded still opens that rating", { skip }, async () => {
  await fresh({ hash: "#/rate/r1" });
  await page.waitFor(`document.querySelector(".edit-head")`, 3000, "edit form for r1");
  assert.match(await page.text(".edit-head"), /Порту/);
  assert.notEqual(await page.eval(`!document.getElementById("toast").hidden && document.getElementById("toast").innerText`), "Оценка не найдена");
});

/* ---------- layout ---------- */

async function placeJustAboveSaveBar(sel) {
  return page.eval(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)}), bar = document.querySelector(".savebar");
    window.scrollBy(0, e.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 4);
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 4 };
  })()`);
}
const underSaveBar = sel => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(), bar = document.querySelector(".savebar").getBoundingClientRect(); return r.bottom > bar.top + 1 ? { bottom: Math.round(r.bottom), barTop: Math.round(bar.top) } : null; })()`);

test("on a phone the source picker opened near the bottom is not hidden behind the save bar", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  const p = await placeJustAboveSaveBar('[data-conf="интернет"]');
  await page.click(p.x, p.y);
  await page.waitFor(`!document.querySelector('[data-confpick="интернет"]').hidden`, 2000, "picker open");
  await page.waitFor(`true`);
  assert.equal(await underSaveBar('[data-confpick="интернет"]'), null, "the options I just opened are visible");
});

test("on a phone a group comment opened near the bottom is not hidden behind the save bar", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  const p = await placeJustAboveSaveBar('[data-addnote="work"]');
  await page.click(p.x, p.y);
  await page.waitFor(`document.activeElement && document.activeElement.id === "note-work"`, 2000, "comment focused");
  await page.type("Коворкинг рядом");
  assert.equal(await underSaveBar("#note-work"), null, "I can see what I am typing");
});

for (const [w, h, dark] of [[390, 844, false], [390, 844, true], [1280, 800, false]]) {
  test(`at ${w}px${dark ? " in dark mode" : ""} the edit form has no sideways scroll and nothing hides behind the save bar at the end`, { skip }, async () => {
    await fresh({ hash: "#/place/porto" }, { w, h, dark });
    await openEdit("porto");
    await press("#fShowAll");
    assert.ok((await page.eval("document.documentElement.scrollWidth - innerWidth")) <= 1, "no sideways scroll");
    const r = await page.eval(`(() => { const bar = document.querySelector(".savebar").getBoundingClientRect(), nav = document.querySelector(".bottomnav"); const navTop = getComputedStyle(nav).display === "none" ? innerHeight : nav.getBoundingClientRect().top; return { barBottom: bar.bottom, navTop, barRight: bar.right, w: innerWidth }; })()`);
    assert.ok(r.barBottom <= r.navTop, `save bar sits above the bottom nav: ${JSON.stringify(r)}`);
    assert.ok(r.barRight <= r.w, "save bar fits the screen");
    await page.eval(`scrollTo(0, document.documentElement.scrollHeight)`);
    for (const sel of ["#fReset", "#fCancel", "#fDelete", "#fVeto"]) {
      const hit = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}), r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === e || e.contains(h) ? "" : (h && (h.id || h.className || h.tagName)); })()`);
      assert.equal(hit, "", `${sel} is reachable at the end of the page`);
    }
    assert.deepEqual(page.takeErrors(), []);
  });
}

test("on a desktop the 0–10 «год здесь» scale sits on one line", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" }, { w: 1280, h: 800 });
  const tops = await page.eval(`[...new Set([...document.querySelectorAll("[data-year]")].map(b => Math.round(b.getBoundingClientRect().top)))]`);
  assert.equal(tops.length, 1, `0…10 is one scale, not two rows (rows at ${tops.join(", ")})`);
});

test("in dark mode the error under the save button and «Удалить оценку» are readable", { skip }, async () => {
  await fresh({ hash: "#/place/porto" }, { dark: true });
  await openEdit("porto");
  const del = await page.eval(CONTRAST("#fDelete"));
  await press("#fReset");
  await press("#fReset");
  await press("#fSave");
  assert.equal(await page.text("#fMsg"), "Поставьте хотя бы одну оценку, ответьте «Прожили бы здесь год?» или напишите отзыв.");
  const msg = await page.eval(CONTRAST("#fMsg"));
  assert.ok(msg >= 4.5, `error text contrast ${msg}:1 is below 4.5:1`);
  assert.ok(del >= 4.5, `«Удалить оценку» contrast ${del}:1 is below 4.5:1`);
});

test("a review with HTML-like text is saved verbatim and shown as plain text", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  const text = `<img src=x onerror="alert(1)"> «шум» & <b>ветер</b>`;
  await page.fill("#fReview", text);
  await page.fill("#fVeto", "<script>x</script>");
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.review, text);
  assert.equal(r.veto, "<script>x</script>");
  assert.ok((await page.text("#v-place")).includes(`<b>ветер</b>`), "shown as typed, not rendered");
  assert.equal(await page.eval(`document.querySelectorAll("#v-place img[src=x], #v-place .review b").length`), 0);
  assert.deepEqual(page.takeErrors(), []);
});
