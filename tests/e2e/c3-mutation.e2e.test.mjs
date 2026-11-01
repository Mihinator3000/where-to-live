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
const today = () => page.eval(`(async () => (await import("./js/util.js")).todayISO())()`);
const daysAgo = n => page.eval(`(async () => (await import("./js/util.js")).todayISO(new Date(Date.now() - ${n} * 864e5)))()`);

async function open(opts = {}) {
  await page.viewport(390, 844);
  await openApp(page, srv.url, Object.assign({ hash: "#/rate" }, opts));
  if ((opts.hash || "#/rate").startsWith("#/rate")) await page.waitFor(`document.getElementById("fSave")`, 4000, "rate form");
  page.takeErrors();
}
async function press(sel) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel });
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const ratingsOn = async place => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);
async function saveAndLand(placeId) {
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 6000, `the dossier of ${placeId} after saving; message: " + document.getElementById("fMsg").innerText + "`);
}

/* ---------- trip dates in the rating form ---------- */

test("a day trip (left the same day she arrived) saves as a 1-day trip, not as «Уехали раньше, чем Приехали»", { skip }, async () => {
  await open();
  await page.select("#fPlace", "Батуми");
  const d = await daysAgo(12);
  await page.fill("#fStart", d);
  await page.fill("#fEnd", d);
  await score("интернет", 4);
  await saveAndLand("batumi");
  const [r] = await ratingsOn("batumi");
  assert.equal(r.start, d);
  assert.equal(r.end, d);
  assert.equal(r.days, 1);
});

test("a trip that started today can be rated today", { skip }, async () => {
  await open();
  await page.select("#fPlace", "Батуми");
  const d = await today();
  await page.fill("#fStart", d);
  await page.fill("#fEnd", d);
  await score("шум", 3);
  await saveAndLand("batumi");
  assert.equal((await ratingsOn("batumi"))[0].start, d);
});

test("a trip that ended more than a month ago is ticked «По памяти» by itself, a trip from three weeks ago is not", { skip }, async () => {
  await open();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fStart", await daysAgo(50));
  await page.fill("#fEnd", await daysAgo(40));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), true, "40 days ago is «больше месяца назад»");
  await page.fill("#fStart", await daysAgo(30));
  await page.fill("#fEnd", await daysAgo(21));
  assert.equal(await page.eval(`document.getElementById("fRetro").checked`), false);
});

/* ---------- unsaved edits and new ratings of the same place ---------- */

const pressed = (k, v) => page.eval(`document.querySelector('[data-score="${k}"][data-v="${v}"]').getAttribute("aria-pressed") === "true"`);
const editing = () => page.eval(`!!document.querySelector(".edit-head")`);

test("an unsaved change to my old rating survives starting a new rating of that place, and «Оценить» does not reopen the old one", { skip }, async () => {
  await open({ me: "Михаил", hash: "#/rate/r1" });
  await page.waitFor(`document.querySelector(".edit-head")`, 5000, "edit form of r1");
  await score("интернет", 2);
  await page.goto(srv.url + "#/rate/new/porto", 300);
  await page.waitFor(`!document.querySelector(".edit-head")`, 4000, "a new rating form");
  assert.equal(await pressed("интернет", 2), false, "the new rating starts clean");
  await page.goto(srv.url + "#/rate/r1", 300);
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form of r1 again");
  assert.equal(await pressed("интернет", 2), true, "the unsaved change to the old rating comes back");
  await page.goto(srv.url + "#/rate/new/porto", 300);
  await sleep(300);
  assert.equal(await editing(), false, "«Оценить» for Порту opens a new rating, not the edit of the old one");
});

test("a next-trip question typed before choosing the right place is kept when she switches the place", { skip }, async () => {
  await open();
  await page.select("#fPlace", "Батуми");
  await page.fill("#fQuestions", "Где ближайший стоматолог?");
  await sleep(400);
  await page.select("#fPlace", "Тбилиси");
  await sleep(300);
  assert.equal(await page.eval(`document.getElementById("fQuestions").value`), "Где ближайший стоматолог?", "the question must not vanish when the place changes");
});

/* ---------- who this phone belongs to ---------- */

test("filling in a rating for the partner on my phone does not make the phone hers", { skip }, async () => {
  await open({ me: "Михаил" });
  await press(`[data-who="Вика"]`);
  await page.select("#fPlace", "Батуми");
  await score("шум", 2);
  await saveAndLand("batumi");
  assert.equal((await ratingsOn("batumi"))[0].who, "Вика");
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:me"))`), "Михаил", "this phone still belongs to Михаил");
});

/* ---------- the place card when the other phone changed it ---------- */

function partnerEdits(change) {
  return page.eval(`(() => {
    const f = JSON.parse(localStorage.getItem("mock:files"));
    const p = JSON.parse(f["places/porto.json"]);
    (${change})(p);
    f["places/porto.json"] = JSON.stringify(p, null, 1) + "\\n";
    localStorage.setItem("mock:files", JSON.stringify(f));
    localStorage.setItem("mock:head", "h-partner-" + Date.now());
  })()`);
}
const backgroundCheck = () => page.eval(`(async () => { const m = await import("./js/app.js"); await m.state.data.poll(); })()`);
const Q = `#placeForm textarea[name="questions"]`;

test("adding a question to the card while the partner's new question arrives in the background keeps both questions", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.waitFor(`document.querySelector(${JSON.stringify(Q)})`, 5000, "card form");
  await page.fill(Q, "Проверить сырость зимой\nГде ближайший стоматолог?");
  await partnerEdits(`p => { p.questions = "Проверить сырость зимой\\nСколько стоит садик?"; }`);
  await backgroundCheck();
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText.trim() !== ""`, 6000, "save message");
  const msg = await page.text("#placeMsg");
  const q = JSON.parse((await mockFiles(page))["places/porto.json"]).questions;
  assert.doesNotMatch(msg, /изменили на другом устройстве/, "a new line next to the partner's new line is not a clash");
  assert.match(q, /садик/, "the partner's question stays in the card");
  assert.match(q, /стоматолог/, "my question is saved");
});

test("when the partner rewrote the questions, the clash message shows their lines apart, not glued into one sentence", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.waitFor(`document.querySelector(${JSON.stringify(Q)})`, 5000, "card form");
  await page.fill(Q, "Где ближайший стоматолог?");
  await partnerEdits(`p => { p.questions = "Сырость зимой — проверили, норм\\nСколько стоит садик?"; }`);
  await backgroundCheck();
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`/другом устройстве/.test(document.getElementById("placeMsg").innerText)`, 6000, "clash message");
  const msg = await page.text("#placeMsg");
  assert.match(msg, /садик/, "the message quotes what is there now");
  assert.doesNotMatch(msg, /норм Сколько/, "two questions must not read as one sentence");
});

/* ---------- «Не отправлено» for a deleted trip ---------- */

test("an unsent deletion of a trip says what «Записать мою» and «Выбросить» do to the trip", { skip }, async () => {
  const r1 = RATINGS[0];
  const lost = [{ at: "2026-10-31T10:01:00.000Z", path: `ratings/${r1.id}.json`, message: `Delete rating ${r1.id}`, content: JSON.stringify(Object.assign({}, r1, { deleted: true })), baseOid: null, patch: { deleted: true }, base: { deleted: false } }];
  await open({ hash: "#/rank", local: { "wtl:lost": lost } });
  await page.waitFor(`document.querySelector("[data-lostapply]")`, 5000, "the «Не отправлено» banner");
  const row = await page.eval(`document.querySelector(".lost").innerText.replace(/\\s+/g, " ")`);
  assert.match(row, /удален/i, "fixture: the row says it is a deletion");
  assert.match(row, /удалит|удалить/i, `the row must say that writing mine deletes the trip, now: «${row}»`);
  assert.match(row, /оставит|оставить|останется/i, `the row must say that the other button keeps the trip, now: «${row}»`);
});
