import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS } from "./fixtures.mjs";

// Lens: data integrity between two phones. Михаил's phone (A) and a second device (B: Вика's phone or Михаил's laptop)
// are two separate Chrome instances with their own app storage. The shared GitHub repo lives here in node (`shared`)
// and is handed to a phone right before it talks to GitHub and taken back right after, so each phone sees exactly
// the commits the other one made — like a real remote. Some steps simulate the other device by committing straight
// into `shared` (other()). After every scenario the exact content of the affected files is checked, and the unsent
// list (wtl:lost) and the queue (wtl:pending) on both phones must be empty or explained on screen.

const skip = !CHROME && "no Chrome";
let srv, A, B;

// Per page: window.__toasts collects every toast; localStorage "test:dropReply" = "1" makes the next commit land in the
// repo while its reply is lost (the phone sees «no network», as when the connection drops right after GitHub got it).
const PROBE = `(() => {
  const inner = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const res = await inner(input, init);
    if (url.startsWith("https://api.github.com/") && init.body && String(init.body).includes("createCommitOnBranch") && localStorage.getItem("test:dropReply") === "1") {
      localStorage.removeItem("test:dropReply");
      throw new TypeError("Failed to fetch");
    }
    return res;
  };
  window.__toasts = [];
  document.addEventListener("readystatechange", () => {
    const t = document.getElementById("toast");
    if (!t || t.__seen) return;
    t.__seen = true;
    new MutationObserver(() => { if (!t.hidden && t.textContent) window.__toasts.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
  });
})();`;

before(async () => {
  srv = await serve();
  A = await launch();
  B = await launch();
  for (const p of [A, B]) await p.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
});
after(async () => { await A?.close(); await B?.close(); await srv?.close(); });

const js = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BOOTED = `document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`;
const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };
const T = "2026-10-01T00:00:00.000Z";
const PORTO = PLACES.find(p => p.id === "porto");
const R1 = RATINGS.find(r => r.id === "r1");

/* ---------- the shared repo ---------- */

let shared = null;
const grab = async p => { shared = await p.eval(`({ files: JSON.parse(localStorage.getItem("mock:files")), head: localStorage.getItem("mock:head") || "h0" })`); };
const give = p => p.eval(`localStorage.setItem("mock:files", ${js(JSON.stringify(shared.files))}); localStorage.setItem("mock:head", ${js(shared.head)})`);
const file = path => (shared.files[path] ? JSON.parse(shared.files[path]) : null);
const strip = d => { if (!d) return d; const o = Object.assign({}, d); delete o.updatedAt; return o; };
const ratingsOf = (place, who) => Object.entries(shared.files).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && (!who || r.who === who) && !r.deleted);

// The other device commits straight into the shared repo; the head moves on as after a real commit.
function other(path, change) {
  const cur = file(path);
  const next = change(cur ? structuredClone(cur) : null);
  if (next == null) delete shared.files[path]; else shared.files[path] = JSON.stringify(Object.assign(next, { updatedAt: new Date().toISOString() }), null, 1) + "\n";
  shared.head = "h" + (Number(shared.head.slice(1)) + 10);
}

/* ---------- phones ---------- */

async function phones({ files = repo(), meA = "Михаил", meB = "Вика", hashA = "#/place/porto", hashB = "#/place/porto", w = 390, h = 844, dark = false, local = {} } = {}) {
  for (const p of [A, B]) await p.viewport(w, h, { dark });
  await openApp(A, srv.url, { files, me: meA, hash: hashA, local });
  await openApp(B, srv.url, { files, me: meB, hash: hashB, local });
  shared = { files: structuredClone(files), head: "h0" };
  for (const p of [A, B]) { await p.eval(`window.__toasts.length = 0`); p.takeErrors(); }
}

async function one(opts = {}) {
  await A.viewport(opts.w || 390, opts.h || 844, { dark: !!opts.dark });
  await openApp(A, srv.url, Object.assign({ files: repo(), hash: "#/place/porto" }, opts));
  shared = { files: structuredClone(opts.files || repo()), head: "h0" };
  await A.eval(`window.__toasts.length = 0`);
  A.takeErrors();
}

const stored = (p, k) => p.eval(`JSON.parse(localStorage.getItem(${js("wtl:" + k)}) || "[]")`);
const lost = p => stored(p, "lost");
const pending = p => stored(p, "pending");
const toasts = p => p.eval(`window.__toasts.slice()`);
const syncText = p => p.text("#syncText");
const lostRows = p => p.eval(`[...document.querySelectorAll(".view:not([hidden]) .lost")].map(r => r.querySelector("span").innerText)`);
const viewText = p => p.eval(`document.querySelector(".view:not([hidden])").innerText`);

const offline = p => p.eval(`localStorage.setItem("mock:offline", "1")`);

// The phone gets network back: it sees the current shared repo, sends its queue, and whatever clashed lands in «Не отправлено».
async function online(p) {
  await give(p);
  await p.eval(`localStorage.removeItem("mock:offline"); window.dispatchEvent(new Event("online"))`);
  await p.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0 && ${BOOTED}`, 10000, "queue sent");
  await sleep(350);
  await grab(p);
}

// The phone comes back to the foreground and checks the repo (online).
async function comeBack(p) {
  await give(p);
  await p.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
  await p.waitFor(`import("./js/app.js").then(m => m.state.data.head === localStorage.getItem("mock:head") && ${BOOTED})`, 8000, "phone caught up");
  await sleep(300);
  await grab(p);
}

// An online action on a phone: it sees the current shared repo, and its commits become the shared repo.
async function on(p, fn) {
  await give(p);
  const r = await fn();
  await sleep(150);
  await grab(p);
  return r;
}

async function go(p, hash) {
  await p.eval(`location.hash = ${js(hash)}`);
  await p.waitFor(`!document.getElementById(${js(VIEW[hash.split("/")[1]])}).hidden`, 4000, "view " + hash);
  await sleep(200);
}

async function reload(p) {
  await p.eval(`window.__stale = 1`);
  await p.send("Page.reload");
  await p.waitFor(`!window.__stale && document.readyState === "complete" && ${BOOTED}`, 10000, "app reloaded");
  await p.eval(`window.__toasts = window.__toasts || []`);
  await sleep(250);
}

async function press(p, sel, settle) {
  const ok = await p.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return p.tap({ sel }, settle);
}
const score = (p, k, v) => press(p, `[data-score="${k}"][data-v="${v}"]`);

const queued = (p, n) => p.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length >= ${n}`, 5000, `queue holds ${n}`);

// Saves the place card with the given fields typed in; offline it waits until the change is queued.
async function saveCard(p, edits, { off = false } = {}) {
  const before = (await pending(p)).length;
  for (const [k, v] of Object.entries(edits)) {
    if (k === "status") await p.select('#placeForm [name="status"]', v);
    else await p.fill(`#placeForm [name="${k}"]`, v);
  }
  await p.eval(`document.getElementById("placeMsg").textContent = ""`);
  await p.tap({ text: "Сохранить карточку" });
  if (off) await queued(p, before + 1);
  else await p.waitFor(`document.getElementById("placeMsg").innerText`, 8000, "card save result");
  await sleep(150);
  return p.text("#placeMsg");
}

async function saveNumbers(p, edits, { off = false } = {}) {
  const before = (await pending(p)).length;
  for (const [k, v] of Object.entries(edits)) await p.fill(`#factsForm [name="fact_${k}"]`, v);
  await p.eval(`document.getElementById("factsMsg").textContent = ""`);
  await p.tap({ text: "Сохранить цифры" });
  if (off) await queued(p, before + 1);
  else await p.waitFor(`document.getElementById("factsMsg").innerText`, 8000, "numbers save result");
  await sleep(150);
  return p.text("#factsMsg");
}

// A new rating of a place from the rating form; lands on the dossier.
async function rate(p, placeId, { scores = { "интернет": 4 }, question = "", review = "" } = {}) {
  await go(p, "#/rate/new/" + placeId);
  await p.waitFor(`document.getElementById("fPlace").value === ${js(placeId)}`, 3000, "place picked");
  for (const [k, v] of Object.entries(scores)) await score(p, k, v);
  if (question) await p.fill("#fQuestions", question);
  if (review) await p.fill("#fReview", review);
  await press(p, "#fSave");
  await p.waitFor(`location.hash === "#/place/${placeId}"`, 8000, "dossier of " + placeId);
  await sleep(200);
}

async function editRating(p, placeId, rid, change) {
  await go(p, "#/place/" + placeId);
  await p.tap({ text: "Изменить", within: `#v-place .trip[data-rid="${rid}"]` });
  await p.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  await change();
  await press(p, "#fSave");
  await p.waitFor(`location.hash === "#/place/${placeId}" || document.getElementById("fMsg").innerText`, 8000, "rating save result");
  await sleep(200);
}

async function deleteRating(p, placeId, rid) {
  await go(p, "#/place/" + placeId);
  await p.tap({ text: "Изменить", within: `#v-place .trip[data-rid="${rid}"]` });
  await p.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  await press(p, "#fDelete");
  await press(p, "#fDelete");
  await p.waitFor(`location.hash === "#/place/${placeId}"`, 6000, "back to the dossier");
  await sleep(200);
}

async function saveWeights(p, group, value) {
  await go(p, "#/rank");
  if (!(await p.eval(`document.getElementById("wdetails").open`))) await p.tap({ sel: "#wsum" });
  await p.fill(`#w-${group}`, String(value));
  const shown = await p.eval(`Object.fromEntries([...document.querySelectorAll("#wgrid .wrow")].map(r => [r.querySelector("input").dataset.g, Number(r.querySelector(".num").textContent)]))`);
  await p.tap({ sel: "#wsaveBtn" });
  await p.waitFor(`window.__toasts.some(t => /веса/i.test(t))`, 6000, "weights saved");
  return shown;
}

// «Записать мою» on every unsent row, if any are left (a fix may merge without asking).
async function applyAll(p) {
  for (let i = 0; i < 6 && (await lost(p)).length; i++) {
    const before = (await lost(p)).length;
    await p.tap({ text: "Записать мою", within: ".view:not([hidden]) .lost" });
    await p.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length < ${before}`, 8000, "row applied");
    await sleep(250);
  }
  await grab(p);
}

// Two texts that only added lines must both survive: either nothing clashes, or the unsent row offers a way to keep both.
async function keepBoth(p) {
  if (!(await lost(p)).length) return;
  const rows = await lostRows(p);
  const both = await p.eval(`[...document.querySelectorAll(".view:not([hidden]) .lost button")].map(b => b.innerText.trim()).find(t => /обе|оба|объедин|вместе|добавить мо/i.test(t)) || ""`);
  assert.ok(both, `only «Записать мою» and «Выбросить» are offered for «${rows.join(" / ")}»: either one throws a question away`);
  await p.tap({ text: both, within: ".view:not([hidden]) .lost" });
  await p.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 0`, 8000, "both kept");
  await sleep(250);
  await grab(p);
}

async function discard(p, nth = 0) {
  const before = (await lost(p)).length;
  for (let n = 0; n < 2; n++) {
    await p.tap({ text: n ? "Точно" : "Выбросить", within: `.view:not([hidden]) .lost:nth-of-type(${nth + 1})` });
    await sleep(250);
    if ((await lost(p)).length < before) return;
  }
  throw new Error("«Выбросить» did not drop the row");
}

async function clean(p, what) {
  assert.deepEqual(await pending(p), [], `${what}: changes still wait in the queue`);
  assert.deepEqual((await lost(p)).map(l => l.path), [], `${what}: changes left in «Не отправлено»`);
  assert.doesNotMatch(await syncText(p), /Не отправлено|В очереди|Ошибка/, `${what}: the header still says «${await syncText(p)}»`);
}

/* ---------- 1. two phones, the same place card ---------- */

for (const first of ["A", "B"]) {
  test(`two phones offline change different card fields of one place; ${first === "A" ? "mine" : "Vika's"} arrives first and the card keeps both`, { skip }, async () => {
    await phones();
    await offline(A); await offline(B);
    await saveCard(A, { archetype: "город у океана" }, { off: true });
    await saveCard(B, { questions: "Проверить сырость зимой\nВика: где рынок?" }, { off: true });
    const [p1, p2] = first === "A" ? [A, B] : [B, A];
    await online(p1);
    await online(p2);
    assert.deepEqual(strip(file("places/porto.json")), strip(Object.assign({}, PORTO, { archetype: "город у океана", questions: "Проверить сырость зимой\nВика: где рынок?" })));
    await comeBack(p1);
    for (const [p, who] of [[A, "my phone"], [B, "Vika's phone"]]) {
      await clean(p, who);
      const t = await viewText(p);
      assert.match(t, /город у океана/, `${who} does not show the archetype`);
      assert.match(t, /где рынок/, `${who} does not show Vika's question`);
    }
  });
}

test("numbers typed on one phone and the card on the other, both offline, end up together in the place file", { skip }, async () => {
  await phones();
  await offline(A); await offline(B);
  await saveNumbers(A, { rent: "900", dinner: "30" }, { off: true });
  await saveCard(B, { status: "финалист", archetype: "город у реки" }, { off: true });
  await online(B);
  await online(A);
  const p = file("places/porto.json");
  assert.equal(p.status, "финалист");
  assert.equal(p.archetype, "город у реки");
  assert.equal(p.facts.rent.v, 900);
  assert.equal(p.facts.dinner.v, 30);
  assert.equal(p.questions, PORTO.questions);
  await clean(A, "my phone");
  await clean(B, "Vika's phone");
});

test("when both phones rewrite the same question offline, the second one gets one row that shows both texts, and the first text stays until I decide", { skip }, async () => {
  await phones();
  await offline(A); await offline(B);
  await saveCard(B, { questions: "Вика: узнать про садики" }, { off: true });
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  await online(B);
  await online(A);
  assert.equal(file("places/porto.json").questions, "Вика: узнать про садики", "the second phone wrote over the first without asking");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1, "one unsent row on my phone: " + js(rows));
  assert.match(rows[0], /Порту/);
  assert.match(rows[0], /Михаил: где коворкинг/, "the row does not show my text");
  assert.match(rows[0], /Вика: узнать про садики/, "the row does not show what is there now");
  assert.match(await syncText(A), /Не отправлено: 1/);
  await applyAll(A);
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?");
  await comeBack(B);
  await clean(A, "my phone after «Записать мою»");
  await clean(B, "Vika's phone");
  assert.match(await viewText(B), /Михаил: где коворкинг/, "Vika's phone still shows the replaced text");
});

test("when both phones only add a line to the questions offline, both lines are kept without asking", { skip }, async () => {
  await phones();
  await offline(A); await offline(B);
  await saveCard(B, { questions: PORTO.questions + "\nВика: узнать про садики" }, { off: true });
  await saveCard(A, { questions: PORTO.questions + "\nМихаил: где коворкинг?" }, { off: true });
  await online(B);
  await online(A);
  await keepBoth(A);
  const q = file("places/porto.json").questions;
  assert.match(q, /Вика: узнать про садики/, "Vika's question was lost: " + js(q));
  assert.match(q, /Михаил: где коворкинг\?/, "my question was not added: " + js(q));
  assert.equal((q.match(/Проверить сырость зимой/g) || []).length, 1, "the old line is duplicated: " + js(q));
  await clean(A, "my phone");
});

test("a line Vika typed into the card offline and a question from my rating sent meanwhile are both kept", { skip }, async () => {
  await phones({ meB: "Вика" });
  await offline(B);
  await saveCard(B, { questions: PORTO.questions + "\nВика: узнать про садики" }, { off: true });
  await on(A, () => rate(A, "porto", { scores: { "интернет": 3 }, question: "Михаил: где коворкинг?" }));
  assert.match(file("places/porto.json").questions, /Михаил: где коворкинг/);
  await online(B);
  await keepBoth(B);
  const q = file("places/porto.json").questions;
  assert.match(q, /Вика: узнать про садики/, "Vika's line is missing: " + js(q));
  assert.match(q, /Михаил: где коворкинг/, "my rating's question was overwritten by Vika's card: " + js(q));
});

test("the place renamed and rejected on one phone while the other rates it offline: the rating arrives, the question is appended, the new name and reason stay", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Вика" });
  await offline(A);
  await rate(A, "porto", { scores: { "интернет": 2, "улица": 3 }, question: "Михаил: проверить шум ночью" });
  await on(B, async () => {
    await B.select('#placeForm [name="status"]', "отсев");
    await B.fill('#placeForm [name="reason"]', "сыро зимой");
    await B.fill('#placeForm [name="name"]', "Порту (центр)");
    await B.tap({ text: "Сохранить карточку" });
    await B.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "card saved");
  });
  await online(A);
  assert.deepEqual(strip(file("places/porto.json")), strip(Object.assign({}, PORTO, { name: "Порту (центр)", status: "отсев", reason: "сыро зимой", questions: PORTO.questions + "\nМихаил: проверить шум ночью" })));
  const mine = ratingsOf("porto", "Михаил");
  assert.equal(mine.length, 2, "my new rating did not arrive");
  assert.ok(mine.some(r => r.scores["интернет"] === 2 && r.scores["улица"] === 3));
  await clean(A, "my phone");
  const t = await viewText(A);
  assert.match(t, /Порту \(центр\)/, "my phone still shows the old name");
  assert.match(t, /Причина отсева:\s*сыро зимой/, "my phone does not show why the place was rejected");
});

test("a place rejected on the other phone while my card edit waited offline keeps the rejection and my archetype", { skip }, async () => {
  await phones();
  await offline(A);
  await saveCard(A, { archetype: "город у океана" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { status: "отсев", reason: "дорого" }));
  await online(A);
  const p = file("places/porto.json");
  assert.equal(p.status, "отсев");
  assert.equal(p.reason, "дорого");
  assert.equal(p.archetype, "город у океана");
  await clean(A, "my phone");
});

test("only the field both phones changed waits for a decision; my other field from the same offline save is sent at once", { skip }, async () => {
  await one();
  await offline(A);
  await saveNumbers(A, { rent: "900" }, { off: true });
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  await online(A);
  const p = file("places/porto.json");
  assert.equal(p.facts && p.facts.rent && p.facts.rent.v, 900, "my rent nobody else touched is held back with the clashing question; «Выбросить» would throw it away too");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0], /Аренд/, "the row offers to throw away my rent, which did not clash: " + rows[0]);
});

/* ---------- 2. two phones, the same rating ---------- */

test("one rating edited in different fields on my phone (offline) and my laptop keeps both edits", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил" });
  await offline(A);
  await editRating(A, "porto", "r1", () => score(A, "интернет", 2));
  await on(B, () => editRating(B, "porto", "r1", () => B.fill("#fReview", "Правка с ноутбука: зимой сыро.")));
  assert.equal(file("ratings/r1.json").review, "Правка с ноутбука: зимой сыро.");
  await online(A);
  const rows = await lostRows(A);
  await applyAll(A);
  const r = file("ratings/r1.json");
  assert.equal(r.review, "Правка с ноутбука: зимой сыро.", `the laptop's review was replaced by the old one after «Записать мою» on «${rows.join(" / ")}»`);
  assert.equal(r.scores["интернет"], 2, "my score from the phone is not in the rating");
  assert.equal(r.deleted, false);
  await clean(A, "my phone");
});

test("one rating edited in the same field on two devices: the unsent row shows what the other device wrote", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил" });
  await offline(A);
  await editRating(A, "porto", "r1", () => A.fill("#fReview", "С телефона: красиво, но сыро и шумно."));
  await on(B, () => editRating(B, "porto", "r1", () => B.fill("#fReview", "С ноутбука: зимой холодно в квартире.")));
  await online(A);
  assert.equal(file("ratings/r1.json").review, "С ноутбука: зимой холодно в квартире.");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /Порту/);
  assert.match(rows[0], /холодно в квартире|ноутбук|сейчас|там/i, `I am asked to replace the other version without seeing it: «${rows[0]}»`);
});

test("my offline edit of a rating deleted on the other device is listed as «deleted there», and «Выбросить» leaves it deleted", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил" });
  await offline(A);
  await editRating(A, "porto", "r1", () => score(A, "интернет", 2));
  await on(B, () => deleteRating(B, "porto", "r1"));
  assert.equal(file("ratings/r1.json").deleted, true);
  await online(A);
  const rows = await lostRows(A);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /удал/i, `nothing says the rating was deleted on the other device; «Записать мою» will quietly bring it back: «${rows[0]}»`);
  await discard(A);
  await grab(A);
  assert.equal(file("ratings/r1.json").deleted, true);
  assert.doesNotMatch(await viewText(A), /Красиво, но сыро/, "the deleted trip is still shown");
});

test("«Записать мою» on an edit of a rating deleted elsewhere brings it back with my answers", { skip }, async () => {
  await one();
  await offline(A);
  await editRating(A, "porto", "r1", () => score(A, "интернет", 2));
  other("ratings/r1.json", d => Object.assign(d, { deleted: true }));
  await online(A);
  assert.equal((await lost(A)).length, 1);
  await applyAll(A);
  const r = file("ratings/r1.json");
  assert.equal(r.deleted, false);
  assert.equal(r.scores["интернет"], 2);
  assert.equal(r.review, R1.review);
  await clean(A, "my phone");
  assert.match(await viewText(A), /Красиво, но сыро/);
});

test("Vika's rating deleted on her phone while mine of the same place waited offline: mine arrives and hers stays deleted", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Вика" });
  await offline(A);
  await rate(A, "porto", { scores: { "интернет": 5 }, review: "Михаил: второй заезд." });
  await on(B, () => deleteRating(B, "porto", "r2"));
  await online(A);
  assert.equal(file("ratings/r2.json").deleted, true);
  assert.equal(ratingsOf("porto", "Михаил").length, 2);
  assert.equal(ratingsOf("porto", "Вика").length, 0);
  await clean(A, "my phone");
});

/* ---------- 3. weights ---------- */

test("weights I saved on my laptop are not silently replaced by older weights my phone queued offline", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил", hashA: "#/rank", hashB: "#/rank", local: { "wtl:wopen": true } });
  await offline(A);
  const old = await saveWeights(A, "legal", 40);
  await queued(A, 1);
  const newer = await on(B, () => saveWeights(B, "nature", 60));
  assert.deepEqual(file("weights/mihail.json").w, newer);
  await online(A);
  const now = file("weights/mihail.json").w, rows = await lostRows(A);
  assert.ok(js(now) === js(newer) || rows.some(r => /Вес/.test(r)), `the phone's older weights ${js(old)} replaced the laptop's newer ones ${js(newer)} without a word`);
});

test("weights saved on my phone right after my laptop saved others are written on the first tap, without a false «try again in a minute»", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил", hashA: "#/rank", hashB: "#/rank", local: { "wtl:wopen": true } });
  await on(B, () => saveWeights(B, "nature", 60));
  const mine = await on(A, () => saveWeights(A, "legal", 40));
  const t = await toasts(A);
  assert.ok(!t.some(x => /не сохранен/i.test(x)), `the explicit tap did not save: «${t.join(" / ")}»`);
  assert.ok(t.some(x => /Сохранено/.test(x)), `no «Сохранено» toast: «${t.join(" / ")}»`);
  assert.deepEqual(file("weights/mihail.json").w, mine, "the phone's weights are not in the repo");
  await clean(A, "my phone");
});

test("Mikhail's and Vika's weights saved offline on their own phones both arrive, and both phones then offer «Оба»", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Вика", hashA: "#/rank", hashB: "#/rank", local: { "wtl:wopen": true } });
  await offline(A); await offline(B);
  const mw = await saveWeights(A, "work", 50);
  const vw = await saveWeights(B, "nature", 50);
  await online(A);
  await online(B);
  assert.deepEqual(file("weights/mihail.json").w, mw);
  assert.deepEqual(file("weights/vika.json").w, vw);
  await comeBack(A);
  for (const p of [A, B]) {
    await clean(p, "phone");
    const names = await p.eval(`[...document.querySelectorAll("#presets button")].map(b => b.innerText.trim())`);
    assert.ok(names.includes("Оба"), "no «Оба» preset: " + js(names));
  }
});

/* ---------- 4. long mixed queues ---------- */

async function addBar(p) {
  await go(p, "#/map");
  await p.fill("#searchInput", "");
  await p.tap({ sel: "#searchInput" });
  await p.type("Бар");
  await p.key("Enter");
  await p.waitFor(`(() => { const r = document.getElementById("searchResults"); return !r.hidden && /Бар, Черногория/.test(r.innerText); })()`, 6000, "search results");
  await p.tap({ text: "Бар, Черногория", within: "#searchResults" });
  await p.waitFor(`document.querySelector("#sheet:not([hidden]) [data-act=addgeo]")`, 5000, "add sheet");
  await sleep(300);
  await p.tap({ sel: "#sheet [data-act=addgeo]" });
  await p.waitFor(`import("./js/app.js").then(m => !!m.state.data.view().places.find(x => x.id === "bar"))`, 6000, "place added");
  await sleep(300);
}

test("a queue of six mixed changes (new place, its rating and card, an edit then a delete of one rating, numbers, weights) arrives once each in its final state", { skip }, async () => {
  await one({ local: { "wtl:wopen": true } });
  await offline(A);
  await addBar(A);
  await rate(A, "bar", { scores: { "интернет": 3, "море": 5 }, question: "Есть ли зимой автобусы?" });
  await saveCard(A, { archetype: "малый курорт" }, { off: true });
  await editRating(A, "porto", "r1", () => score(A, "интернет", 2));
  await deleteRating(A, "porto", "r1");
  await go(A, "#/place/valensiya");
  await saveNumbers(A, { rent: "1100" }, { off: true });
  const w = await saveWeights(A, "climate", 30);
  assert.ok((await pending(A)).length >= 7, "fixture: everything waits in the queue");
  await A.eval(`localStorage.removeItem("mock:log")`);
  await online(A);
  const bar = file("places/bar.json");
  assert.equal(bar.name, "Бар");
  assert.equal(bar.archetype, "малый курорт");
  assert.equal(bar.questions, "Есть ли зимой автобусы?");
  const rb = ratingsOf("bar", "Михаил");
  assert.equal(rb.length, 1);
  assert.deepEqual(rb[0].scores, { "интернет": 3, "море": 5 });
  assert.equal(file("ratings/r1.json").deleted, true);
  assert.equal(file("ratings/r1.json").scores["интернет"], 2, "the deletion carries my last edit");
  assert.equal(file("places/valensiya.json").facts.rent.v, 1100);
  assert.deepEqual(file("weights/mihail.json").w, w);
  const log = await A.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`);
  const perPath = log.reduce((a, e) => (a[e.path] = (a[e.path] || 0) + 1, a), {});
  assert.ok(Object.values(perPath).every(n => n === 1), "some file was written twice: " + js(perPath));
  await clean(A, "my phone");
  const said = (await toasts(A)).find(t => /Отправлено из очереди/.test(t)) || "";
  assert.match(said, /Отправлено из очереди/);
});

test("in a mixed queue that partly clashes, everything else arrives and only the clashing rating waits, listed as a deletion", { skip }, async () => {
  await one({ local: { "wtl:wopen": true } });
  await offline(A);
  await saveCard(A, { archetype: "город у океана" }, { off: true });
  await saveNumbers(A, { rent: "950" }, { off: true });
  await editRating(A, "porto", "r1", () => score(A, "интернет", 2));
  await deleteRating(A, "porto", "r1");
  await rate(A, "batumi", { scores: { "интернет": 4 }, review: "Михаил: море тёплое." });
  const w = await saveWeights(A, "people", 25);
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  other("ratings/r1.json", d => Object.assign(d, { review: "Правка с ноутбука" }));
  await online(A);
  const p = file("places/porto.json");
  assert.equal(p.archetype, "город у океана");
  assert.equal(p.facts.rent.v, 950);
  assert.equal(p.questions, "Вика: узнать про садики");
  assert.equal(ratingsOf("batumi", "Михаил").length, 1);
  assert.deepEqual(file("weights/mihail.json").w, w);
  const r1 = file("ratings/r1.json");
  assert.equal(r1.deleted, false);
  assert.equal(r1.review, "Правка с ноутбука");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1, "only the rating clashed: " + js(rows));
  assert.match(rows[0], /Оценка: Порту/);
  assert.match(rows[0], /удален/i, "the row does not say my change was a deletion");
  await applyAll(A);
  assert.equal(file("ratings/r1.json").deleted, true);
  await clean(A, "my phone");
});

test("one rating with a question saved offline counts as one change in the header and in the «sent» message", { skip }, async () => {
  await one({ hash: "#/place/batumi" });
  await offline(A);
  await rate(A, "batumi", { scores: { "интернет": 4 }, question: "Где зимой купаться?" });
  const header = await syncText(A);
  assert.match(header, /в очереди: 1$/i, `I saved one rating, the header says «${header}»`);
  await A.eval(`window.__toasts.length = 0`);
  await online(A);
  const said = (await toasts(A)).find(t => /Отправлено из очереди/.test(t)) || "";
  assert.match(said, /Отправлено из очереди: 1\b/, `I saved one rating, the message says «${said}»`);
});

test("a reload between every step of an offline session loses nothing, and the other phone's edits made meanwhile survive", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { archetype: "город у океана" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { status: "финалист" }));
  await reload(A);
  await rate(A, "porto", { scores: { "шум": 2 }, question: "Михаил: шумно ли летом?" });
  other("ratings/r2.json", d => Object.assign(d, { review: "Вика: холмы утомляют." }));
  await reload(A);
  await go(A, "#/place/porto");
  await saveNumbers(A, { dinner: "28" }, { off: true });
  await reload(A);
  assert.equal((await pending(A)).length >= 3, true, "the queue survived the reloads");
  await online(A);
  const p = file("places/porto.json");
  assert.deepEqual(strip(Object.assign({}, p, { facts: undefined })), strip(Object.assign({}, PORTO, { status: "финалист", archetype: "город у океана", questions: PORTO.questions + "\nМихаил: шумно ли летом?", facts: undefined })));
  assert.equal(p.facts.dinner.v, 28);
  assert.equal(file("ratings/r2.json").review, "Вика: холмы утомляют.");
  const mine = ratingsOf("porto", "Михаил");
  assert.equal(mine.length, 2);
  await clean(A, "my phone");
});

/* ---------- 5. «Не отправлено»: resolving ---------- */

test("«Записать мою» while the other phone changed another field meanwhile writes mine on the first tap and keeps that change", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  await online(A);
  assert.equal((await lost(A)).length, 1);
  other("places/porto.json", d => Object.assign(d, { archetype: "город у реки" }));
  await give(A);
  await A.eval(`window.__toasts.length = 0`);
  await A.tap({ text: "Записать мою", within: ".view:not([hidden]) .lost" });
  await A.waitFor(`window.__toasts.some(t => /Записано|изменили/.test(t))`, 8000, "result of «Записать мою»");
  await sleep(300);
  await grab(A);
  const said = (await toasts(A)).join(" | ");
  assert.doesNotMatch(said, /Снова изменили/, `the other phone changed only the archetype, yet I am told to tap again: «${said}»`);
  const p = file("places/porto.json");
  assert.equal(p.questions, "Михаил: где коворкинг?");
  assert.equal(p.archetype, "город у реки");
});

test("«Записать мою» while the other phone changed the same field again shows its newest text before mine replaces it", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  await online(A);
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: садики уже нашла, нужна школа" }));
  await give(A);
  await A.tap({ text: "Записать мою", within: ".view:not([hidden]) .lost" });
  await A.waitFor(`window.__toasts.some(t => /изменили/.test(t))`, 8000, "clash again");
  await sleep(300);
  await grab(A);
  assert.equal(file("places/porto.json").questions, "Вика: садики уже нашла, нужна школа", "the first tap wrote over a text I have not seen");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /нужна школа/, `the row still shows the older text: «${rows[0]}»`);
  await applyAll(A);
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?");
});

async function threeRows() {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  await go(A, "#/place/valensiya");
  await saveCard(A, { archetype: "мегаполис у моря" }, { off: true });
  await editRating(A, "porto", "r1", () => A.fill("#fReview", "Михаил: сыро, но красиво."));
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  other("places/valensiya.json", d => Object.assign(d, { archetype: "город у моря и гор" }));
  other("ratings/r1.json", d => Object.assign(d, { review: "С ноутбука: дождливо." }));
  await online(A);
  await go(A, "#/rank");
  assert.equal((await lost(A)).length, 3, "fixture: three unsent rows");
}

test("«Выбросить» on the middle of three unsent rows drops only that one, and the other two can still be written", { skip }, async () => {
  await threeRows();
  const rows = await lostRows(A);
  const mid = rows.findIndex(r => /Валенсия/.test(r));
  assert.ok(mid >= 0, "the Valencia row is listed: " + js(rows));
  await discard(A, mid);
  const left = await lostRows(A);
  assert.equal(left.length, 2);
  assert.ok(left.every(r => !/Валенсия/.test(r)), "the wrong row was dropped: " + js(left));
  await applyAll(A);
  assert.equal(file("places/valensiya.json").archetype, "город у моря и гор");
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?");
  assert.equal(file("ratings/r1.json").review, "Михаил: сыро, но красиво.");
  await clean(A, "my phone");
});

test("«Записать мою» on one row and «Выбросить» on another tapped right after it act on the rows I tapped", { skip }, async () => {
  await threeRows();
  await A.eval(`localStorage.setItem("mock:delay", "900")`);
  const rows = await lostRows(A);
  const porto = rows.findIndex(r => /^Порту/.test(r)), val = rows.findIndex(r => /Валенсия/.test(r));
  await A.tap({ text: "Записать мою", within: `.view:not([hidden]) .lost:nth-of-type(${porto + 1})` }, 60);
  for (let n = 0; n < 3 && (await lost(A)).some(l => l.path === "places/valensiya.json"); n++) {
    const i = (await lostRows(A)).findIndex(r => /Валенсия/.test(r));
    if (i < 0) break;
    await A.eval(`document.querySelectorAll(".view:not([hidden]) .lost")[${i}].querySelectorAll("button")[1].click()`);
    await sleep(120);
  }
  await A.waitFor(`!JSON.parse(localStorage.getItem("wtl:lost") || "[]").some(l => l.path === "places/porto.json")`, 8000, "porto written");
  await A.eval(`localStorage.removeItem("mock:delay")`);
  await sleep(300);
  await grab(A);
  const left = (await lost(A)).map(l => l.path).sort();
  assert.deepEqual(left, ["ratings/r1.json"], "only the rating row should be left");
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?");
  assert.equal(file("places/valensiya.json").archetype, "город у моря и гор");
});

test("unsent rows survive closing the app and still say which place, which field and what is there now", { skip }, async () => {
  await threeRows();
  await reload(A);
  await go(A, "#/rank");
  const rows = await lostRows(A);
  assert.equal(rows.length, 3);
  const has = (...res) => rows.some(r => res.every(re => re.test(r)));
  assert.ok(has(/Порту/, /Вопрос/, /где коворкинг/, /узнать про садики/), "the Porto row lost its place, field, my text or the other text: " + js(rows));
  assert.ok(has(/Валенсия/, /Тип места/, /мегаполис у моря/, /город у моря и гор/), "the Valencia row lost its place, field, my value or the other value: " + js(rows));
  assert.ok(has(/Оценк/, /Порту/, /Михаил/), "the rating row lost its place or person: " + js(rows));
  assert.match(await syncText(A), /Не отправлено: 3/);
});

test("the unsent row for a place renamed on the other phone uses the name the app shows now", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { name: "Порту (центр)", questions: "Вика: узнать про садики" }));
  await online(A);
  await go(A, "#/rank");
  const rows = await lostRows(A);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^Порту \(центр\)/, `the row names a place that no longer exists under that name: «${rows[0]}»`);
});

/* ---------- 6. the same new place on two phones ---------- */

test("the same town added offline on both phones ends up as one place with my card, Vika's question and both ratings", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Вика", hashA: "#/map", hashB: "#/map" });
  await offline(A); await offline(B);
  await addBar(A);
  await go(A, "#/place/bar");
  await saveCard(A, { archetype: "малый курорт" }, { off: true });
  await addBar(B);
  await rate(B, "bar", { scores: { "море": 5 }, question: "Вика: есть ли пляж?" });
  await online(A);
  await online(B);
  const rowsB = await lostRows(B);
  await applyAll(B);
  const placesBar = Object.keys(shared.files).filter(k => /^places\/bar/.test(k));
  assert.deepEqual(placesBar, ["places/bar.json"], "the town exists twice");
  const bar = file("places/bar.json");
  assert.equal(ratingsOf("bar", "Вика").length, 1);
  assert.match(bar.questions, /есть ли пляж/, "Vika's question was lost");
  assert.equal(bar.archetype, "малый курорт", "following «Записать мою» on Vika's phone overwrote my card with her bare copy of the place");
  if (rowsB.length) assert.match(rowsB.join(" "), /уже (есть|добав)|добавил|добавлен/i, `a puzzling row on Vika's phone: «${rowsB.join(" / ")}»`);
});

/* ---------- 7. awkward moments ---------- */

test("a reply lost after GitHub got my rating does not add its question to the card twice when the other phone edits the card meanwhile", { skip }, async () => {
  await one({ hash: "#/place/batumi" });
  await give(A);
  await A.eval(`localStorage.setItem("test:dropReply", "1")`);
  await rate(A, "batumi", { scores: { "интернет": 4 }, question: "Где зимой купаться?" });
  await grab(A);
  assert.match(file("places/batumi.json").questions, /Где зимой купаться/, "fixture: the commit reached GitHub");
  await A.eval(`localStorage.setItem("mock:offline", "1")`);
  other("places/batumi.json", d => Object.assign(d, { archetype: "курорт" }));
  await online(A);
  if ((await lost(A)).length) await applyAll(A);
  const b = file("places/batumi.json");
  assert.equal(b.archetype, "курорт");
  assert.equal((b.questions.match(/Где зимой купаться/g) || []).length, 1, "the question is in the card twice: " + js(b.questions));
  assert.equal(ratingsOf("batumi", "Михаил").length, 1);
});

test("a background check in the middle of a slow card save neither warns about another device nor writes twice", { skip }, async () => {
  await one();
  await give(A);
  await A.eval(`localStorage.setItem("mock:delay", "1200"); localStorage.removeItem("mock:log")`);
  await A.fill('#placeForm [name="archetype"]', "город у океана");
  await A.tap({ text: "Сохранить карточку" }, 100);
  await A.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
  await sleep(400);
  await A.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
  await A.waitFor(`document.getElementById("placeMsg") && document.getElementById("placeMsg").innerText`, 10000, "save result");
  await sleep(1500);
  await A.eval(`localStorage.removeItem("mock:delay")`);
  await grab(A);
  assert.doesNotMatch(await A.text("#placeMsg"), /другом устройстве/);
  assert.equal(file("places/porto.json").archetype, "город у океана");
  const log = await A.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`);
  assert.equal(log.filter(e => e.path === "places/porto.json").length, 1);
});

test("network back and a return to the app at the same moment send the queue once", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { archetype: "город у океана" }, { off: true });
  await rate(A, "batumi", { scores: { "интернет": 4 } });
  await give(A);
  await A.eval(`localStorage.setItem("mock:delay", "700"); localStorage.removeItem("mock:log"); localStorage.removeItem("mock:offline"); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); setTimeout(() => document.dispatchEvent(new Event("visibilitychange")), 300)`);
  await A.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0 && ${BOOTED}`, 12000, "queue sent");
  await sleep(1500);
  await A.eval(`localStorage.removeItem("mock:delay")`);
  await grab(A);
  const log = await A.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`);
  const perPath = log.reduce((a, e) => (a[e.path] = (a[e.path] || 0) + 1, a), {});
  assert.ok(Object.values(perPath).every(n => n === 1), "written twice: " + js(perPath));
  assert.equal(ratingsOf("batumi", "Михаил").length, 1);
  await clean(A, "my phone");
});

test("the same change made on both phones does not end up in «Не отправлено»", { skip }, async () => {
  await phones();
  await offline(A); await offline(B);
  await saveCard(A, { status: "финалист" }, { off: true });
  await saveCard(B, { status: "финалист" }, { off: true });
  await online(A);
  await online(B);
  assert.equal(file("places/porto.json").status, "финалист");
  await clean(A, "my phone");
  await clean(B, "Vika's phone");
});

test("both phones online: my card save after Vika's change of the same field warns with her value, the second tap writes mine, and her phone then shows mine", { skip }, async () => {
  await phones();
  await A.fill('#placeForm [name="archetype"]', "мегаполис");
  await on(B, () => saveCard(B, { archetype: "курорт" }));
  const msg = await on(A, async () => { await A.tap({ text: "Сохранить карточку" }); await A.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "result"); return A.text("#placeMsg"); });
  assert.match(msg, /другом устройстве/);
  assert.match(msg, /курорт/, "the warning does not show Vika's value");
  assert.equal(file("places/porto.json").archetype, "курорт");
  await on(A, async () => { await A.tap({ text: "Сохранить карточку" }); await A.waitFor(`/сохранен/i.test(document.getElementById("placeMsg").innerText)`, 6000, "saved"); });
  assert.equal(file("places/porto.json").archetype, "мегаполис");
  await comeBack(B);
  assert.equal(await B.eval(`document.querySelector('#placeForm [name="archetype"]').value`), "мегаполис", "Vika's phone shows her stale value");
  await clean(A, "my phone");
  await clean(B, "Vika's phone");
});

test("after saving the card while the numbers are half-typed, putting a field back to its old value is saved too", { skip }, async () => {
  await one();
  await give(A);
  await A.fill('#factsForm [name="fact_dinner"]', "35");
  await A.fill('#placeForm [name="archetype"]', "курорт");
  await A.tap({ text: "Сохранить карточку" });
  await A.waitFor(`/сохранен/i.test(document.getElementById("placeMsg").innerText)`, 6000, "first save");
  await A.fill('#placeForm [name="archetype"]', PORTO.archetype);
  await A.eval(`document.getElementById("placeMsg").textContent = ""`);
  await A.tap({ text: "Сохранить карточку" });
  await A.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "second save");
  await sleep(300);
  await grab(A);
  const msg = await A.text("#placeMsg");
  assert.equal(file("places/porto.json").archetype, PORTO.archetype, `the card still says «курорт», the app said «${msg}»`);
});

/* ---------- 8. how the unsent list reads ---------- */

for (const [w, h, dark] of [[390, 844, false], [390, 844, true], [1280, 800, false]]) {
  test(`at ${w}×${h}${dark ? " dark" : ""} three unsent rows of different kinds each read as their own item with two tappable buttons`, { skip }, async () => {
    await A.viewport(w, h, { dark });
    await threeRows();
    await A.viewport(w, h, { dark });
    await A.eval("scrollTo(0, 0)");
    await A.waitFor(`!document.getElementById("toast") || document.getElementById("toast").hidden`, 10000, "toast gone");
    await A.shot(`c2-integrity-lost-${w}${dark ? "-dark" : ""}`);
    const r = await A.eval(`(() => {
      const rows = [...document.querySelectorAll("#v-rank .lost")];
      return { overflow: document.documentElement.scrollWidth - innerWidth, rows: rows.map(row => { const s = row.querySelector("span").getBoundingClientRect(); return { text: row.innerText, spanW: Math.round(s.width), buttons: [...row.querySelectorAll("button")].map(b => { const q = b.getBoundingClientRect(); const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { h: Math.round(q.height), w: Math.round(q.width), free: !!hit && (hit === b || b.contains(hit)) }; }) }; }) };
    })()`);
    assert.ok(r.overflow <= 0, "sideways scroll " + r.overflow);
    assert.equal(r.rows.length, 3);
    for (const row of r.rows) {
      assert.ok(row.spanW >= 150, `a row's text is squeezed to ${row.spanW}px: «${row.text}»`);
      assert.equal(row.buttons.length, 2);
      for (const b of row.buttons) { assert.ok(b.free, "a button is covered"); assert.ok(b.h >= 30, "a button is only " + b.h + "px tall"); }
    }
    assert.deepEqual(A.takeErrors(), []);
  });
}

test("on a phone the two buttons of an unsent row sit together, so «Выбросить» cannot be read as part of the next row", { skip }, async () => {
  await threeRows();
  await A.eval("scrollTo(0, 0)");
  const rows = await A.eval(`[...document.querySelectorAll("#v-rank .lost")].map(row => { const [a, b] = [...row.querySelectorAll("button")].map(x => x.getBoundingClientRect()); return { text: row.querySelector("span").innerText.slice(0, 40), dy: Math.round(Math.abs(a.top - b.top)) }; })`);
  for (const r of rows) assert.ok(r.dy <= 4, `«Записать мою» and «Выбросить» of «${r.text}» are on different lines (${r.dy}px apart): the lone «Выбросить» sits right above the next row`);
});

/* ---------- 9. more two-phone cases ---------- */

test("both of us rate the same place offline with a question each: both ratings and both questions arrive", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Вика" });
  await offline(A); await offline(B);
  await rate(A, "porto", { scores: { "интернет": 3 }, question: "Михаил: где коворкинг?" });
  await rate(B, "porto", { scores: { "интернет": 5 }, question: "Вика: есть ли садики?" });
  await online(A);
  await online(B);
  assert.equal(file("places/porto.json").questions, PORTO.questions + "\nМихаил: где коворкинг?\nВика: есть ли садики?");
  assert.equal(ratingsOf("porto", "Михаил").length, 2);
  assert.equal(ratingsOf("porto", "Вика").length, 2);
  await clean(A, "my phone");
  await clean(B, "Vika's phone");
});

test("a rating open for editing on my phone while my laptop changed another field of it is saved without retyping my answers and keeps both changes", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил" });
  await go(A, "#/place/porto");
  await A.tap({ text: "Изменить", within: '#v-place .trip[data-rid="r1"]' });
  await A.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  await score(A, "интернет", 2);
  await on(B, () => editRating(B, "porto", "r1", () => B.fill("#fReview", "С ноутбука: зимой сыро.")));
  for (let n = 0; n < 2 && (await A.eval(`location.hash`)) === "#/rate"; n++) {
    if (n && !/ещё раз|снова|повторно/i.test(await A.text("#fMsg"))) break;
    await on(A, async () => {
      await A.eval(`document.getElementById("fMsg").textContent = ""`);
      await press(A, "#fSave");
      await A.waitFor(`location.hash === "#/place/porto" || document.getElementById("fMsg").innerText`, 8000, "save result");
      await sleep(200);
    });
  }
  const msg = await A.eval(`location.hash === "#/rate" ? document.getElementById("fMsg").innerText : ""`);
  const r = file("ratings/r1.json");
  assert.equal(r.review, "С ноутбука: зимой сыро.");
  assert.equal(r.scores["интернет"], 2, `my score is not saved; the form says «${msg}»`);
});

test("both devices online: a rating edit that meets the laptop's edit of the same fields names them in plain words, and the second tap writes mine", { skip }, async () => {
  await phones({ meA: "Михаил", meB: "Михаил" });
  await go(A, "#/place/porto");
  await A.tap({ text: "Изменить", within: '#v-place .trip[data-rid="r1"]' });
  await A.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
  await A.fill("#fStart", "2026-08-03");
  await press(A, '[data-opt="season"][data-val="худший"]');
  await press(A, '[data-conf="интернет"]');
  await press(A, '[data-confset="интернет"][data-l="D"]');
  await press(A, '[data-addnote="city"]');
  await A.fill("#note-city", "С телефона: шумно по ночам.");
  await on(B, () => editRating(B, "porto", "r1", async () => {
    await B.fill("#fStart", "2026-07-25");
    await press(B, '[data-opt="season"][data-val="межсезон"]');
    await press(B, '[data-conf="интернет"]');
    await press(B, '[data-confset="интернет"][data-l="A"]');
    await press(B, '[data-addnote="city"]');
    await B.fill("#note-city", "С ноутбука: тихо.");
  }));
  assert.equal(file("ratings/r1.json").start, "2026-07-25");
  const msg = await on(A, async () => {
    await A.eval(`document.getElementById("fMsg").textContent = ""`);
    await press(A, "#fSave");
    await A.waitFor(`location.hash === "#/place/porto" || document.getElementById("fMsg").innerText`, 8000, "save result");
    return A.eval(`location.hash === "#/rate" ? document.getElementById("fMsg").innerText : ""`);
  });
  assert.match(msg, /другом устройстве/, `the first tap did not warn: «${msg}»`);
  assert.doesNotMatch(msg, /\d{4}-\d{2}-\d{2}/, `a raw ISO date in «${msg}»`);
  assert.doesNotMatch(msg, /\bdays\b|\bconf\b|\bnotes\b|\bretro\b/, `a raw field name in «${msg}»`);
  assert.doesNotMatch(msg, /—\s*«?[ABCD]»?(;|\)|$)/, `a bare letter code in «${msg}»`);
  assert.match(msg, /Приехали — 25 июля 2026/, `the other device's arrival date is not readable: «${msg}»`);
  assert.match(msg, /Откуда знаем \(Интернет дома\) — «проверили в быту»/, `«откуда знаем» does not name the question or the answer: «${msg}»`);
  assert.match(msg, /Комментарий: Город и быт — «С ноутбука: тихо\.»/, `the comment does not name its group: «${msg}»`);
  await on(A, async () => {
    await press(A, "#fSave");
    await A.waitFor(`location.hash === "#/place/porto"`, 8000, "saved on the second tap");
  });
  const r = file("ratings/r1.json");
  assert.deepEqual([r.start, r.season, r.conf["интернет"], r.notes.city], ["2026-08-03", "худший", "D", "С телефона: шумно по ночам."]);
  await clean(A, "my phone");
});

test("saving a field again after its older version landed in «Не отправлено» retires that row, so «Записать мою» cannot bring the old text back", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: черновик вопроса" }, { off: true });
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  await online(A);
  assert.equal((await lost(A)).length, 1);
  await on(A, () => saveCard(A, { questions: "Вика: узнать про садики\nМихаил: где коворкинг?" }));
  assert.equal(file("places/porto.json").questions, "Вика: узнать про садики\nМихаил: где коворкинг?");
  const rows = await lostRows(A);
  assert.ok(!rows.some(r => /черновик вопроса/.test(r)), `the stale row still offers to write «черновик вопроса» over the text I just saved: «${rows.join(" / ")}»`);
});

test("when my queued card edit clashes while I am typing on that dossier, the red banner the message points to is on the screen", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  await A.fill('#factsForm [name="fact_rent"]', "800");
  other("places/porto.json", d => Object.assign(d, { questions: "Вика: узнать про садики" }));
  await A.eval(`window.__toasts.length = 0`);
  await online(A);
  const said = (await toasts(A)).find(t => /Не отправлено/.test(t)) || "";
  assert.match(said, /плашк/, "fixture: the message points to the red banner");
  assert.ok(await A.eval(`!!document.querySelector("#v-place .banner.err .lost")`), `the message says «${said}», but the dossier has no red banner with the buttons`);
  assert.equal(await A.eval(`document.querySelector('#factsForm [name="fact_rent"]').value`), "800", "the half-typed rent was wiped");
});

test("typing on in the card after a queued save and saving once the network is back does not blame «another device» for my own earlier edit", { skip }, async () => {
  await one();
  await offline(A);
  await saveCard(A, { questions: "Михаил: где коворкинг?" }, { off: true });
  await A.fill('#placeForm [name="questions"]', "Михаил: где коворкинг?\nМихаил: и где спортзал?");
  await online(A);
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?", "fixture: the queued edit was sent");
  const msg = await on(A, () => saveCard(A, {}));
  assert.doesNotMatch(msg, /другом устройстве/, `only this phone edited the card: «${msg}»`);
  assert.equal(file("places/porto.json").questions, "Михаил: где коворкинг?\nМихаил: и где спортзал?");
});
