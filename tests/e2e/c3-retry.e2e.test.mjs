import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, mockFiles, mockLog } from "./fixtures.mjs";

// Lens: GitHub is temporarily unavailable while we save (a timeout, a 5xx, a rate limit, an internal error inside a
// normal reply). Owner's decision: such a save behaves like a save without internet — the change goes into the queue on
// the phone (wtl:pending), the user reads one clear message («GitHub сейчас не отвечает — сохранено в телефоне,
// отправлю сам»), the status shows how many changes wait, and the app sends the queue by itself when GitHub answers
// again (next check, coming back to the app, the online event, or a retry timer ~30 s → 2 min → 5 min; for a rate limit
// not before GitHub's reset time) without duplicating a rating or question lines. A refused key, a key without write
// rights or a missing repository keep their own behaviour and explanations.

const skip = !CHROME && "no Chrome";
let srv, page;

// Fault injection on top of the shared mock (copied from c2-errors and extended). Rules live in localStorage "c3:rules"
// (a JSON list); each matches a URL part (and optionally a request-body part or an Authorization part) and, with
// "until" (ms on the page clock), only applies before that moment. A rule can let the request through first ("after":
// the commit lands, the reply is lost), delay it, hang it forever, fail it like a dropped network, or answer with any
// status, body, content type and headers; "times" makes it one-shot. Every GitHub request is logged with the page clock
// in localStorage "c3:calls" (survives reloads). "c3:fast" = N runs the page clock N times faster: Date moves N× faster
// and every timer of a second or longer fires N× sooner, so a 30 s retry or a 2-minute rate limit pass in a few seconds.
const FAULT = `(() => {
  if (location.hostname !== "127.0.0.1") return;
  const ls = window.localStorage;
  const get0 = Storage.prototype.getItem, set0 = Storage.prototype.setItem;
  const knob = k => get0.call(ls, k);
  const F = Number(knob("c3:fast") || 0);
  if (F > 1) {
    const RD = Date;
    let t0 = Number(knob("c3:t0") || 0);
    if (!t0) { t0 = RD.now(); set0.call(ls, "c3:t0", String(t0)); }
    const now = () => Math.round(t0 + (RD.now() - t0) * F);
    function FD(...a) { if (!new.target) return new RD(now()).toString(); return a.length ? new RD(...a) : new RD(now()); }
    Object.setPrototypeOf(FD, RD);
    FD.prototype = RD.prototype;
    FD.now = now;
    window.Date = FD;
    const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
    const scale = ms => (Number(ms) >= 1000 ? Math.max(150, Number(ms) / F) : ms);
    window.setTimeout = (fn, ms, ...a) => st(fn, scale(ms), ...a);
    window.setInterval = (fn, ms, ...a) => si(fn, scale(ms), ...a);
  }
  const inner = window.fetch;
  const rules = () => { try { return JSON.parse(knob("c3:rules") || "[]"); } catch (e) { return []; } };
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init && typeof init.body === "string" ? init.body : "";
    const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || "");
    if (url.startsWith("https://api.github.com/")) {
      const l = JSON.parse(knob("c3:calls") || "[]");
      l.push({ t: Date.now(), u: url.replace("https://api.github.com", "") + (body.includes("createCommitOnBranch") ? " commit" : "") });
      set0.call(ls, "c3:calls", JSON.stringify(l));
    }
    const rs = rules();
    const i = rs.findIndex(r => url.includes(r.url) && (!r.body || body.includes(r.body)) && (!r.auth || auth.includes(r.auth)) && (!r.until || Date.now() < r.until));
    if (i < 0) return inner(input, init);
    const r = rs[i];
    if (r.times != null) { r.times--; if (r.times <= 0) rs.splice(i, 1); set0.call(ls, "c3:rules", JSON.stringify(rs)); }
    if (r.after) await inner(input, init);
    if (r.delay) await new Promise(res => setTimeout(res, r.delay));
    if (r.hang) return new Promise(() => {});
    if (r.net) throw new TypeError("Failed to fetch");
    return new Response(r.text != null ? r.text : JSON.stringify(r.json || { message: "Server Error" }), { status: r.status || 200, headers: Object.assign({ "Content-Type": r.type || "application/json" }, r.headers || {}) });
  };
  const seen = window.__toasts = [];
  addEventListener("DOMContentLoaded", () => {
    const t = document.getElementById("toast");
    if (t) new MutationObserver(() => { if (!t.hidden && t.innerText && seen[seen.length - 1] !== t.innerText) seen.push(t.innerText); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
  });
})();`;

before(async () => { srv = await serve(); page = await launch(); await page.send("Page.addScriptToEvaluateOnNewDocument", { source: FAULT }); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); page.takeErrors(); } });

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = JSON.stringify;
const GH = "/graphql";
const ALL = "https://api.github.com/";
const COMMIT = "createCommitOnBranch";
const HTML = "text/html; charset=utf-8";
const FAST = 20;
const down503 = (extra = {}) => Object.assign({ url: GH, body: COMMIT, status: 503, text: "<html><body><h1>503 Service Unavailable</h1></body></html>", type: HTML }, extra);
const limitedUntil = (resetSec, extra = {}) => Object.assign({ url: ALL, status: 403, json: { message: "API rate limit exceeded for user ID 1.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api" }, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-used": "5000", "x-ratelimit-reset": String(resetSec) }, until: resetSec * 1000 - 1500 }, extra);

async function open(opts = {}, vp = {}) {
  await page.viewport(vp.w || 390, vp.h || 844, { dark: !!vp.dark });
  const local = Object.assign({}, opts.local || {}, opts.fast ? { "c3:fast": opts.fast === true ? FAST : opts.fast } : {});
  await openApp(page, srv.url, Object.assign({}, opts, { local }));
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 8000, "first load settled");
  await sleep(150);
  await page.eval(`window.__toasts.length = 0; localStorage.setItem("c3:calls", "[]")`);
  page.takeErrors();
}
const rules = list => page.eval(`localStorage.setItem("c3:rules", ${js(js(list))})`);
const knob = (k, v) => page.eval(v == null ? `localStorage.removeItem(${js(k)})` : `localStorage.setItem(${js(k)}, ${js(String(v))})`);
const clock = () => page.eval("Date.now()");
const calls = () => page.eval(`JSON.parse(localStorage.getItem("c3:calls") || "[]")`);
const commitCalls = async () => (await calls()).filter(c => / commit$|\/git\//.test(c.u));
async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const qval = k => page.eval(`document.querySelector('[data-qval="${k}"]').textContent`);
const val = sel => page.eval(`document.querySelector(${js(sel)}).value`);
const hash = () => page.eval("location.hash");
const syncText = () => page.text("#syncText");
const files = () => mockFiles(page);
const doc = async path => { const f = (await files())[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async (place, who) => Object.entries(await files()).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted && (!who || r.who === who));
const pending = () => page.eval(`JSON.parse(localStorage.getItem("wtl:pending") || "[]")`);
const lost = () => page.eval(`JSON.parse(localStorage.getItem("wtl:lost") || "[]")`);
const commits = async () => (await mockLog(page)).filter(e => e.op === "add" || e.op === "del");
const toasts = () => page.eval(`window.__toasts.slice()`);
async function sentToast(timeout = 4000) {
  await seen(`window.__toasts.some(t => /Отправлено из очереди/.test(t))`, timeout);
  return (await toasts()).join(" | ");
}
const banners = () => page.eval(`[...document.querySelectorAll(".view:not([hidden]) .banner")].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
const ghBanner = async () => (await banners()).find(b => /GitHub|очеред|отправ/i.test(b)) || "";
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const online = () => page.eval(`localStorage.removeItem("mock:offline"); window.dispatchEvent(new Event("online"))`);
const go = async (h, settle = 350) => { await page.eval(`location.hash = ${js(h)}`); await sleep(settle); };
const queueEmpty = (timeout = 8000) => page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, timeout, "queue sent");
const queued = (n = 1, timeout = 8000) => page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length >= ${n}`, timeout, `${n} change(s) queued`);
async function seen(js, timeout = 3000) { try { await page.waitFor(js, timeout); return true; } catch { return false; } }
const msgOf = id => page.eval(`(() => { const e = document.getElementById(${js(id)}); return e && !e.closest("[hidden]") ? e.innerText.trim() : ""; })()`);
async function told(...ids) {
  const parts = (await toasts()).slice();
  for (const id of ids) { const m = await msgOf(id); if (m) parts.push(m); }
  return parts.join(" | ");
}
async function reload() {
  await page.eval(`window.__before = 1`);
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__before && document.readyState === "complete" && document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app reloaded");
  await sleep(200);
}
async function openEdit(placeId) {
  await go("#/place/" + placeId, 400);
  await page.tap({ text: "Изменить", within: "#v-place .trips" });
  await page.waitFor(`document.querySelector(".edit-head") && !document.getElementById("fDelete").hidden`, 4000, "edit form");
}
async function typeSearch(q) {
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
}
function otherPhone(path, change) {
  return page.eval(`(() => {
    const f = JSON.parse(localStorage.getItem("mock:files"));
    const cur = f[${js(path)}] ? JSON.parse(f[${js(path)}]) : null;
    const next = (${change})(cur);
    if (next == null) delete f[${js(path)}]; else f[${js(path)}] = JSON.stringify(next, null, 1) + "\\n";
    localStorage.setItem("mock:files", JSON.stringify(f));
    localStorage.setItem("mock:head", "h" + (Number((localStorage.getItem("mock:head") || "h0").slice(1)) + 10));
  })()`);
}
const hhmm = sec => page.eval(`new Date(${sec} * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })`);

// What the user must read after a save that GitHub did not take right now.
const AUTO = /(^|[^а-яё])(сам|сама|сами|само)([^а-яё]|$)|автоматическ|отправлю/i;
const KEPT = /телефон|устройств/i;
const FAILED = /не сохран|не добавлен|не удален|не записан|ещё раз/i;
const NET_BLAME = /(^|\| )Нет связи(?! с GitHub)|нет интернета|появится связь/i;
function waitingTold(text, what) {
  assert.ok(text && text.trim(), `${what}: the user is told nothing at all`);
  assert.match(text, /GitHub/, `${what}: the message does not say the problem is on GitHub's side: «${text}»`);
  assert.match(text, KEPT, `${what}: the message does not say the change is kept on the phone: «${text}»`);
  assert.match(text, AUTO, `${what}: the message does not say the app will send it by itself: «${text}»`);
  assert.doesNotMatch(text, NET_BLAME, `${what}: the internet works, but the message blames the connection: «${text}»`);
  assert.doesNotMatch(text, FAILED, `${what}: the change is kept, but the user reads that it failed or must be repeated: «${text}»`);
  assert.doesNotMatch(text, /\b[45]\d\d\b|Service Unavailable|Bad Gateway|Server Error/, `${what}: raw HTTP error shown: «${text}»`);
}
const QUEUE_WORD = /очеред|ждёт|ждут|не отправ/i;
async function statusCounts(n, where) {
  const s = await syncText();
  assert.match(s, QUEUE_WORD, `${where}: the status says «${s}» and does not say that ${n} change(s) wait on the phone`);
  assert.ok(s.includes(String(n)), `${where}: the status says «${s}», not how many changes wait (${n})`);
}

async function rateBatumi({ review = "", question = "", value = 4 } = {}) {
  await score("интернет", value);
  if (review) await page.fill("#fReview", review);
  if (question) await page.fill("#fQuestions", question);
}
async function saveRating() {
  await press("#fSave");
  await page.waitFor(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText.trim() !== ""`, 25000, "save result");
  await sleep(250);
}
async function saveCard(field, value) {
  await page.fill(`#placeForm [name="${field}"]`, value);
  await press("#placeForm [type=submit]");
  await page.waitFor(`document.getElementById("placeMsg") && document.getElementById("placeMsg").innerText.trim() !== ""`, 8000, "card save result");
  await sleep(200);
}
async function saveFacts(key, value) {
  await page.fill(`#factsForm [name="fact_${key}"]`, value);
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg") && document.getElementById("factsMsg").innerText.trim() !== ""`, 8000, "facts save result");
  await sleep(200);
}
async function openBudva() {
  await typeSearch("Будва");
  await page.tap({ text: "Будва", within: "#searchResults" });
  await page.waitFor(`document.querySelector('#sheet [data-act="addcity"]')`, 4000, "city sheet");
}
async function addBudva() {
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  await page.waitFor(`window.__toasts.length > 0`, 8000, "add place result");
  await sleep(300);
}
async function deleteMine(placeId) {
  await openEdit(placeId);
  await press("#fDelete");
  await press("#fDelete");
  await page.waitFor(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText.trim() !== ""`, 8000, "delete result");
  await sleep(250);
}
async function saveWeights() {
  await press("#wsaveBtn");
  await page.waitFor(`window.__toasts.length > 0`, 8000, "weights save result");
  await sleep(200);
}

/* =================== every kind of save waits on the phone when GitHub answers 503 =================== */

test("a new rating saved while GitHub answers 503 is queued on the phone, the form closes like an offline save, and one message says GitHub will get it automatically", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Ветрено, но уютно." });
  await rules([down503()]);
  await saveRating();
  const said = await told("fMsg");
  assert.equal(await hash(), "#/place/batumi", `the form stayed open with «${await msgOf("fMsg")}» — the rating should be kept on the phone like an offline save`);
  const q = await pending();
  assert.equal(q.filter(c => c.path.startsWith("ratings/")).length, 1, "the rating is in the queue on the phone");
  assert.equal((await ratingsOn("batumi")).length, 0, "GitHub did not take it yet");
  waitingTold(said, "rating save during a 503");
  assert.equal((await toasts()).length, 1, `the user gets several different messages for one save: «${said}»`);
  assert.deepEqual(page.takeErrors(), []);
});

test("the rating waiting for GitHub is shown in the dossier with its review and a «ждёт отправки» mark, and no unsaved draft is left behind", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Ветрено, но уютно." });
  await rules([down503()]);
  await saveRating();
  await page.waitFor(`location.hash === "#/place/batumi"`, 3000, "dossier");
  const t = await page.text("#v-place");
  assert.match(t, /Ветрено, но уютно/, "the queued rating is shown in the dossier");
  assert.match(t, /ждёт отправки/, "the queued rating is marked as not sent yet");
  assert.doesNotMatch(t, /несохранённый черновик/, "a draft is left behind, so pressing «Сохранить» again would make a second rating");
});

test("after a 503 save the status at the top says how many changes wait and is not cut off on an iPhone, on the dossier, the ranking and the map", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi();
  await rules([down503()]);
  await saveRating();
  await queued(1, 1000).catch(() => {});
  const whole = async where => {
    const r = await page.eval(`(() => { const t = document.getElementById("syncText"), b = t.getBoundingClientRect(); return { text: t.innerText, cut: t.scrollWidth > t.clientWidth + 1, right: b.right, w: innerWidth }; })()`);
    assert.ok(!r.cut && r.right <= r.w, `${where}: the status «${r.text}» is cut off at 390 px, so the waiting count cannot be read`);
  };
  await statusCounts(1, "dossier");
  await whole("dossier");
  await go("#/rank");
  await statusCounts(1, "ranking");
  await whole("ranking");
  await go("#/map", 600);
  await statusCounts(1, "map (the map has no banner, the status is the only hint)");
  await whole("map");
  await page.shot("c3-retry-iphone-status-queued");
});

test("editing my rating while GitHub answers 503 queues the edit, and once GitHub is back the file has the new answer and there is still one rating of mine", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openEdit("porto");
  await score("интернет", 2);
  await rules([down503()]);
  await saveRating();
  waitingTold(await told("fMsg"), "rating edit during a 503");
  assert.equal(await hash(), "#/place/porto", "the edit form closes like an offline save");
  assert.ok((await pending()).some(c => c.path === "ratings/r1.json"), "the edit waits in the queue");
  assert.match(await page.text("#v-place"), /ждёт отправки/);
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await doc("ratings/r1.json")).scores["интернет"], 2);
  assert.equal((await ratingsOn("porto", "Михаил")).length, 1);
  assert.deepEqual(await lost(), [], "my own queued edit is not reported as a clash");
});

test("deleting my rating while GitHub answers 503 queues the deletion, the trip disappears, the message names GitHub, and GitHub gets the deletion later", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await deleteMine("porto");
  const said = await told("fMsg");
  waitingTold(said, "rating delete during a 503");
  assert.match(said, /удален/i, `the message does not say it is about the deletion: «${said}»`);
  assert.equal(await hash(), "#/place/porto");
  assert.ok((await pending()).some(c => c.path === "ratings/r1.json"), "the deletion waits in the queue");
  assert.equal(await page.eval(`!!document.querySelector('#v-place .trip[data-rid="r1"]')`), false, "the deleted trip is still shown");
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await doc("ratings/r1.json")).deleted, true);
});

test("a card edit saved while GitHub answers 503 waits on the phone, the message under the button says so, and GitHub gets it later", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  waitingTold(await told("placeMsg"), "card save during a 503");
  assert.equal((await pending()).length, 1);
  assert.equal(await val('#placeForm [name="archetype"]'), "город у океана", "the field still shows my text");
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

test("place numbers saved while GitHub answers 503 wait on the phone, are still in the dossier after leaving it and coming back, and GitHub gets them later", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveFacts("dinner", "35");
  waitingTold(await told("factsMsg"), "numbers save during a 503");
  assert.equal((await pending()).length, 1);
  assert.equal(await val('#factsForm [name="fact_dinner"]'), "35");
  await go("#/rank");
  await go("#/place/porto", 500);
  assert.equal(await val('#factsForm [name="fact_dinner"]'), "35", "the queued number is gone from the dossier after leaving it");
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await doc("places/porto.json")).facts.dinner.v, 35);
});

test("weights saved while GitHub answers 503 wait on the phone, the toast names GitHub instead of «Нет связи», and GitHub gets them later", { skip }, async () => {
  await open({ hash: "#/rank", local: { "wtl:wopen": true } });
  await rules([down503()]);
  await saveWeights();
  waitingTold(await told(), "weights save during a 503");
  assert.equal((await pending()).length, 1);
  await rules([]);
  await comeBack();
  await queueEmpty();
  const w = await doc("weights/mihail.json");
  assert.ok(w && w.who === "Михаил", "the weights file arrived");
});

test("a place added from the map while GitHub answers 503 is kept on the phone, opens in the card, and arrives once later", { skip }, async () => {
  await open({ hash: "#/map" });
  await openBudva();
  await rules([down503()]);
  await addBudva();
  waitingTold(await told(), "add place during a 503");
  assert.ok((await pending()).some(c => c.path === "places/budva.json"), "the new place waits in the queue");
  assert.match(await page.text("#sheet"), /Будва/);
  assert.equal(await page.eval(`!!document.querySelector('#sheet [data-act="addcity"]')`), false, "the card still offers «Добавить как место», inviting a second copy");
  await rules([]);
  await comeBack();
  await queueEmpty();
  const added = Object.keys(await files()).filter(k => /^places\/budva/.test(k));
  assert.deepEqual(added, ["places/budva.json"], "the place arrived exactly once");
});

test("a rating save answered «Something went wrong» inside a normal GitHub reply is queued too and says so in Russian", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi();
  await rules([{ url: GH, body: COMMIT, status: 200, json: { data: null, errors: [{ message: "Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug." }] } }]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `stayed in the form: «${await msgOf("fMsg")}»`);
  assert.equal((await pending()).filter(c => c.path.startsWith("ratings/")).length, 1);
  const said = await told("fMsg");
  waitingTold(said, "rating save with a GitHub internal error");
  assert.doesNotMatch(said, /Something went wrong/);
});

/* =================== it is sent by itself when GitHub answers again =================== */

test("after a 503 the queued rating is sent by itself within about 30 seconds, before the one-minute check, without any tap", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi({ review: "Отправится само" });
  await rules([down503({ times: 1 })]);
  await saveRating();
  const failedAt = (await commitCalls()).slice(-1)[0];
  assert.ok(failedAt, "the save reached GitHub");
  assert.equal((await pending()).filter(c => c.path.startsWith("ratings/")).length, 1, "the rating waits in the queue after the 503");
  await queueEmpty(10000);
  const next = (await commitCalls()).filter(c => c.t > failedAt.t)[0];
  assert.ok(next, "no second commit attempt was logged");
  const gap = Math.round((next.t - failedAt.t) / 1000);
  assert.ok(gap <= 45, `the first automatic retry came after ${gap} s; the owner asked for about 30 s`);
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].review, "Отправится само");
  assert.match(await sentToast(), /Отправлено из очереди/, "the user is not told the queued rating was sent");
});

test("after a 503 the queued change is sent as soon as I come back to the app once GitHub answers", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "queued");
  await rules([]);
  await comeBack();
  await queueEmpty(4000);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
  assert.doesNotMatch(await syncText(), /Ошибка|очеред|не отвеча/i);
  assert.equal(await ghBanner(), "", "the GitHub banner is gone once everything is sent");
});

test("after a 503 the queued change is sent when the phone reports the network is back (online event)", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "queued");
  await rules([]);
  await online();
  await queueEmpty(4000);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

test("tapping the status while GitHub still answers 503 keeps the change in the queue and the status still counts it", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 6000, "retry finished");
  await sleep(300);
  assert.equal((await pending()).length, 1, "the change is still kept");
  await statusCounts(1, "after tapping the status during the outage");
  assert.equal((await doc("places/porto.json")).archetype, "город у моря", "nothing reached GitHub yet");
});

test("during a long GitHub outage the app keeps trying less and less often: no storm of requests, and it sends within minutes once GitHub is back", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  await rules([down503({ url: ALL, body: null })]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "queued");
  const t0 = await clock();
  await page.waitFor(`Date.now() > ${t0 + 8 * 60000}`, 40000, "8 minutes of outage on the page clock");
  const during = (await calls()).filter(c => c.t > t0);
  const tries = during.filter(c => / commit$/.test(c.u));
  assert.ok(during.length >= 3, `the app gave up: only ${during.length} requests in 8 minutes`);
  assert.ok(during.length <= 20, `the app hammers GitHub: ${during.length} requests in 8 minutes`);
  assert.ok(tries.length <= 5, `the app re-sends every ${Math.round(8 * 60 / Math.max(1, tries.length))} s instead of backing off (30 s → 2 min → 5 min): ${tries.length} commit attempts in 8 minutes`);
  await statusCounts(1, "after 8 minutes of outage");
  await rules([]);
  const t1 = await clock();
  await queueEmpty(25000);
  const took = Math.round(((await clock()) - t1) / 60000);
  assert.ok(took <= 6, `sent ${took} minutes after GitHub came back`);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

test("after the queue went out, the next GitHub outage is retried again after about 30 seconds, not after the long pause the previous outage had reached", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  await rules([down503({ url: ALL, body: null, until: (await clock()) + 3 * 60000 })]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `not queued: «${await msgOf("placeMsg")}»`);
  await queueEmpty(30000);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана", "the first outage ended and the change arrived");
  await page.eval(`window.__toasts.length = 0`);
  await rules([down503({ url: ALL, body: null, until: (await clock()) + 50000 })]);
  await saveCard("archetype", "курорт у океана");
  assert.equal((await pending()).length, 1, `the second outage is not queued: «${await msgOf("placeMsg")}»`);
  const failedAt = (await commitCalls()).slice(-1)[0];
  await page.waitFor(`Date.now() > ${failedAt.t + 50000}`, 10000, "50 seconds of the second outage on the page clock");
  const retries = (await commitCalls()).filter(c => c.t > failedAt.t && c.t <= failedAt.t + 50000);
  assert.ok(retries.length >= 1, "no new attempt within 50 s of the second outage: the pause was not reset to ~30 s after the queue went out");
  await queueEmpty(20000);
  assert.equal((await doc("places/porto.json")).archetype, "курорт у океана");
});

/* =================== a commit that landed but whose reply was lost =================== */

test("a rating with a question whose commit landed but GitHub timed out is queued, and the automatic resend duplicates neither the rating nor the question", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi({ review: "Дошло, но ответ потерялся", question: "Где купить сим-карту?" });
  await rules([{ url: GH, body: COMMIT, after: true, hang: true, times: 1 }]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `the timed-out save is not kept on the phone: «${await msgOf("fMsg")}»`);
  assert.ok((await pending()).length >= 1, "queued after the timeout");
  waitingTold(await told("fMsg"), "rating save that timed out");
  await queueEmpty(15000);
  assert.equal((await ratingsOn("batumi")).length, 1, "one rating, not two");
  assert.equal((await doc("places/batumi.json")).questions, "Где купить сим-карту?", "the question is written once");
  assert.deepEqual(await lost(), [], "my own landed commit is not reported as a clash with another device");
  assert.doesNotMatch(await syncText(), /Ошибка|Не отправлено|очеред/i);
});

test("a rating whose commit landed but GitHub answered 504 is queued, and the automatic resend adds no second rating or question line", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi({ question: "Где купить сим-карту?" });
  await rules([{ url: GH, body: COMMIT, after: true, status: 504, text: "<html>504 Gateway Time-out</html>", type: HTML, times: 1 }]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `the 504 save is not kept on the phone: «${await msgOf("fMsg")}»`);
  await queueEmpty(15000);
  assert.equal((await ratingsOn("batumi")).length, 1, "one rating, not two");
  assert.equal((await doc("places/batumi.json")).questions, "Где купить сим-карту?");
  assert.deepEqual(await lost(), []);
});

test("a card question whose commit landed but GitHub answered 502, while Vika edited the card meanwhile, ends with my line once and her edit kept", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  // the first commit lands and its reply is a 502; the automatic resends keep getting 502 (without landing) until the
  // other phone has made its edit, so the change surely waits in the queue meanwhile, however slow the test machine is
  await rules([{ url: GH, body: COMMIT, after: true, status: 502, text: "<html>Bad Gateway</html>", type: HTML, times: 1 }, { url: GH, body: COMMIT, status: 502, text: "<html>Bad Gateway</html>", type: HTML }]);
  await page.fill('#placeForm [name="questions"]', "Проверить сырость зимой\nЕсть ли отопление?");
  await press("#placeForm [type=submit]");
  await page.waitFor(`document.getElementById("placeMsg").innerText.trim() !== "" || JSON.parse(localStorage.getItem("wtl:pending") || "[]").length > 0`, 8000, "card save result");
  assert.equal((await pending()).length, 1, `the 502 card save is not kept on the phone: «${await msgOf("placeMsg")}»`);
  await otherPhone("places/porto.json", `d => Object.assign(d, { archetype: "курорт" })`);
  await rules([]);
  await comeBack();
  await queueEmpty(15000);
  const p = await doc("places/porto.json");
  assert.equal(p.questions, "Проверить сырость зимой\nЕсть ли отопление?", `question lines: ${js(p.questions)}`);
  assert.equal(p.archetype, "курорт", "Vika's edit made meanwhile is kept");
  assert.deepEqual(await lost(), []);
});

test("a place added from the map whose commit landed but timed out arrives once, not as «Будва» and «Будва-2»", { skip }, async () => {
  await open({ hash: "#/map", fast: true });
  await openBudva();
  await rules([{ url: GH, body: COMMIT, after: true, hang: true, times: 1 }]);
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  await page.waitFor(`window.__toasts.length > 0`, 10000, "add result");
  await queueEmpty(15000);
  const added = Object.keys(await files()).filter(k => /^places\/budva/.test(k));
  assert.deepEqual(added, ["places/budva.json"]);
  assert.deepEqual(await lost(), []);
});

/* =================== a GitHub timeout (queued already today) must not be blamed on the internet =================== */

test("deleting my rating when GitHub takes the deletion but never answers says GitHub is slow, not «Нет связи», and the resend leaves it deleted without a clash", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: 5 });
  await rules([{ url: GH, body: COMMIT, after: true, hang: true, times: 1 }]);
  await deleteMine("porto");
  const said = await told("fMsg");
  waitingTold(said, "rating delete that timed out");
  assert.match(said, /удал/i, `the message does not say it is about the deletion: «${said}»`);
  assert.ok((await pending()).some(c => c.path === "ratings/r1.json"), "the deletion waits in the queue");
  await comeBack();
  await queueEmpty();
  assert.equal((await doc("ratings/r1.json")).deleted, true);
  assert.deepEqual(await lost(), [], "my own landed deletion is reported as a clash with another device");
  assert.equal(await page.eval(`!!document.querySelector('#v-place .trip[data-rid="r1"]')`), false, "the deleted trip came back");
});

test("weights saved while GitHub never answers are kept on the phone, the toast names GitHub instead of «Нет связи», and they arrive later", { skip }, async () => {
  await open({ hash: "#/rank", fast: 5, local: { "wtl:wopen": true } });
  await rules([{ url: GH, body: COMMIT, hang: true, times: 1 }]);
  await saveWeights();
  waitingTold(await told(), "weights save that timed out");
  assert.equal((await pending()).length, 1, "the weights wait in the queue");
  await comeBack();
  await queueEmpty();
  const w = await doc("weights/mihail.json");
  assert.ok(w && w.who === "Михаил", "the weights file arrived");
});

test("a place added from the map while GitHub never answers is kept on the phone, the toast names GitHub instead of «Нет связи», and it arrives once", { skip }, async () => {
  await open({ hash: "#/map", fast: 5 });
  await openBudva();
  await rules([{ url: GH, body: COMMIT, hang: true, times: 1 }]);
  await addBudva();
  waitingTold(await told(), "add place that timed out");
  assert.ok((await pending()).some(c => c.path === "places/budva.json"), "the new place waits in the queue");
  await comeBack();
  await queueEmpty();
  const added = Object.keys(await files()).filter(k => /^places\/budva/.test(k));
  assert.deepEqual(added, ["places/budva.json"], "the place arrived exactly once");
});

/* =================== rate limit =================== */

test("a rate-limited rating save is queued, the message gives GitHub's reset time, and nothing is sent to GitHub before that time", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi({ review: "После лимита" });
  const reset = Math.floor((await clock()) / 1000) + 120;
  await rules([limitedUntil(reset)]);
  await saveRating();
  const at = await hhmm(reset);
  assert.equal(await hash(), "#/place/batumi", `the rate-limited save is not kept on the phone: «${await msgOf("fMsg")}»`);
  const said = await told("fMsg");
  assert.match(said, KEPT, `«${said}»`);
  assert.match(said, AUTO, `«${said}»`);
  assert.ok(said.includes(at), `the message does not say «${at}», when GitHub lifts the limit: «${said}»`);
  assert.doesNotMatch(said, /через минуту/, `«${said}»`);
  const failed = (await calls()).slice(-1)[0];
  await queueEmpty(20000);
  const early = (await calls()).filter(c => c.t > failed.t && c.t < reset * 1000 - 1500);
  assert.deepEqual(early.map(c => `${Math.round((reset * 1000 - c.t) / 1000)} s before reset: ${c.u}`), [], "requests sent while GitHub still refuses them (GitHub may block the key for that)");
  const sentAt = (await commitCalls()).slice(-1)[0];
  assert.ok(sentAt.t <= reset * 1000 + 90000, `sent ${Math.round((sentAt.t - reset * 1000) / 1000)} s after the limit was lifted`);
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("coming back to the app or the network event during a rate limit does not knock on GitHub before the reset time", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  const reset = Math.floor((await clock()) / 1000) + 120;
  await rules([limitedUntil(reset)]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `the rate-limited card save is not queued: «${await msgOf("placeMsg")}»`);
  const failed = (await calls()).slice(-1)[0];
  await comeBack();
  await page.eval(`window.dispatchEvent(new Event("online"))`);
  await page.idle(300);
  await page.tap({ sel: "#syncBtn" });
  await page.idle(300);
  await comeBack();
  await page.idle(300);
  const now = await clock();
  assert.ok(now < reset * 1000 - 1500, "fixture: still inside the limit");
  const early = (await calls()).filter(c => c.t > failed.t);
  assert.deepEqual(early.map(c => c.u), [], "requests sent while GitHub still refuses them");
  assert.equal((await pending()).length, 1);
});

test("with a rate-limited queue, the banner gives the reset time and says the queued change goes out after it, not «через минуту»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const reset = Math.floor(Date.now() / 1000) + 1800;
  await rules([limitedUntil(reset, { until: 0 })]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `the rate-limited card save is not queued: «${await msgOf("placeMsg")}»`);
  await go("#/rank");
  const b = await ghBanner();
  const at = await hhmm(reset);
  assert.ok(b.includes(at), `the banner does not say until when: «${b}»`);
  assert.match(b, /1/, `the banner does not say how many changes wait: «${b}»`);
  assert.match(b, AUTO, `«${b}»`);
  assert.doesNotMatch(b, /через минуту/, `GitHub said 30 minutes: «${b}»`);
  await statusCounts(1, "ranking during a rate limit");
});

test("GitHub's GraphQL rate limit (a normal 200 reply with RATE_LIMITED) also waits for the reset time instead of retrying in 30 seconds", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi();
  const reset = Math.floor((await clock()) / 1000) + 120;
  await rules([{ url: GH, status: 200, json: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }] }, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, until: reset * 1000 - 1500 }]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `not kept on the phone: «${await msgOf("fMsg")}»`);
  const said = await told("fMsg");
  const at = await hhmm(reset);
  assert.ok(said.includes(at) || /огранич|лимит/i.test(said), `the message does not say GitHub limited requests: «${said}»`);
  const failed = (await calls()).slice(-1)[0];
  await queueEmpty(20000);
  const early = (await calls()).filter(c => c.t > failed.t && c.t < reset * 1000 - 1500 && c.u.startsWith("/graphql"));
  assert.deepEqual(early.map(c => `${Math.round((reset * 1000 - c.t) / 1000)} s before reset: ${c.u}`), [], "GraphQL requests sent while GitHub still refuses them");
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("a GitHub secondary rate limit (403 with retry-after) is not reported as a key without write rights: the rating is queued and sent after the pause", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi();
  const until = (await clock()) + 60000;
  await rules([{ url: ALL, status: 403, json: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits" }, headers: { "retry-after": "60" }, until }]);
  await saveRating();
  const said = await told("fMsg");
  assert.doesNotMatch(said, /прав на запись|замените ключ/i, `a temporary GitHub limit sends the user to replace a working key: «${said}»`);
  assert.doesNotMatch(await syncText(), /Нет прав/, "the status blames the key");
  assert.equal(await hash(), "#/place/batumi", `not kept on the phone: «${await msgOf("fMsg")}»`);
  const failed = (await calls()).filter(c => / commit$/.test(c.u)).slice(-1)[0];
  await queueEmpty(20000);
  const early = (await calls()).filter(c => c.t > failed.t && c.t < until && / commit$|\/git\//.test(c.u));
  assert.deepEqual(early.map(c => c.u), [], "re-sent before GitHub's retry-after");
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("a 429 «too many requests» with retry-after queues the card edit, says it waits on the phone, and nothing is sent before the pause is over", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  const until = (await clock()) + 90000;
  await rules([{ url: ALL, status: 429, json: { message: "Too Many Requests" }, headers: { "retry-after": "90" }, until }]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `the 429 card save is not queued: «${await msgOf("placeMsg")}»`);
  const said = await told("placeMsg");
  assert.match(said, KEPT, `«${said}»`);
  assert.match(said, AUTO, `«${said}»`);
  assert.doesNotMatch(said, FAILED, `«${said}»`);
  const failed = (await calls()).slice(-1)[0];
  await queueEmpty(20000);
  const early = (await calls()).filter(c => c.t > failed.t && c.t < until);
  assert.deepEqual(early.map(c => `${Math.round((until - c.t) / 1000)} s before the pause ends: ${c.u}`), [], "requests sent while GitHub still asks to wait");
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

/* =================== a queue that mixes causes, more saves, reloads =================== */

test("a second rating saved while the first still waits for GitHub is queued too, and both arrive exactly once", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Первая" });
  await rules([down503()]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `first save not kept: «${await msgOf("fMsg")}»`);
  await go("#/rate/new/belgrad", 500);
  await score("интернет", 3);
  await page.fill("#fReview", "Вторая");
  await saveRating();
  assert.equal(await hash(), "#/place/belgrad", `the second save failed while the first waited: «${await msgOf("fMsg")}»`);
  waitingTold(await told("fMsg"), "second save during the outage");
  await statusCounts(2, "two ratings waiting");
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await ratingsOn("batumi")).length, 1);
  assert.equal((await ratingsOn("belgrad")).length, 1);
  assert.match(await sentToast(), /Отправлено из очереди: 2/);
});

test("editing a rating that still waits for GitHub queues the edit too, and only my latest version arrives, once", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Черновой отзыв" });
  await rules([down503()]);
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `first save not kept: «${await msgOf("fMsg")}»`);
  await openEdit("batumi");
  await page.fill("#fReview", "Исправленный отзыв");
  await saveRating();
  assert.equal(await hash(), "#/place/batumi", `the edit of the queued rating failed: «${await msgOf("fMsg")}»`);
  waitingTold(await told("fMsg"), "edit of a queued rating during the outage");
  assert.match(await page.text("#v-place"), /Исправленный отзыв/);
  await rules([]);
  await comeBack();
  await queueEmpty();
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].review, "Исправленный отзыв");
});

test("a queue with an offline rating and a card edit made while GitHub answered 503 is sent together once GitHub answers, each exactly once", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Без интернета" });
  await knob("mock:offline", "1");
  await saveRating();
  assert.match((await toasts()).join(" | "), /Нет связи/, "offline is still reported as no connection");
  await rules([down503()]);
  await online();
  await page.waitFor(`!["Обновляю…"].includes(document.getElementById("syncText").innerText)`, 6000, "flush attempt");
  await sleep(400);
  assert.equal((await pending()).length, 1, "the offline rating is still kept after the 503");
  await go("#/place/porto", 500);
  await page.eval(`window.__toasts.length = 0`);
  await saveCard("archetype", "город у океана");
  waitingTold(await told("placeMsg"), "card save while an offline item waits and GitHub answers 503");
  await statusCounts(2, "offline rating + card edit");
  await rules([]);
  await comeBack();
  await queueEmpty();
  assert.equal((await ratingsOn("batumi")).length, 1);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
  assert.match(await sentToast(), /Отправлено из очереди: 2/);
});

test("a change queued because of a 503 survives closing the app: after a reload it is still counted and marked, and it is sent once GitHub answers", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Переживёт перезапуск" });
  await rules([down503()]);
  await saveRating();
  assert.equal((await pending()).filter(c => c.path.startsWith("ratings/")).length, 1, `not queued: «${await msgOf("fMsg")}»`);
  await reload();
  assert.equal((await pending()).filter(c => c.path.startsWith("ratings/")).length, 1, "the queue survived the reload");
  await go("#/place/batumi", 500);
  assert.match(await page.text("#v-place"), /Переживёт перезапуск/);
  assert.match(await page.text("#v-place"), /ждёт отправки/);
  await statusCounts(1, "after a reload during the outage");
  await rules([]);
  await comeBack();
  await queueEmpty();
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].review, "Переживёт перезапуск");
});

test("a reload while GitHub is still down does not lose the queue and the boot does not show «не сохранено»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `not queued: «${await msgOf("placeMsg")}»`);
  await reload();
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 6000, "boot sync done");
  await sleep(300);
  assert.equal((await pending()).length, 1);
  const b = await ghBanner();
  assert.match(b, /1/, `the banner after a reload does not say one change waits: «${b}»`);
  assert.match(b, AUTO, `«${b}»`);
  assert.doesNotMatch(b, /не сохран|не добавлен|не удален|не записан|Сохранить.{0,30}ещё раз/i, `«${b}»`);
  assert.equal(await val('#placeForm [name="archetype"]'), "город у океана", "the card shows my queued text after the reload");
});

/* =================== offline still behaves as before =================== */

test("an offline save still says «Нет связи», not that GitHub is down, and is sent on the online event", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Офлайн" });
  await knob("mock:offline", "1");
  await saveRating();
  const said = (await toasts()).join(" | ");
  assert.match(said, /Нет связи/, `«${said}»`);
  assert.doesNotMatch(said, /GitHub/, `offline is not a GitHub outage: «${said}»`);
  assert.match(await syncText(), /очеред/i);
  await online();
  await queueEmpty();
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("while offline the retry timer does not turn the offline message into a GitHub error", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: true });
  await knob("mock:offline", "1");
  await saveCard("archetype", "город у океана");
  const t0 = await clock();
  await page.waitFor(`Date.now() > ${t0 + 3 * 60000}`, 20000, "3 minutes offline on the page clock");
  const s = await syncText();
  assert.match(s, /Офлайн|очеред/i, `«${s}»`);
  assert.doesNotMatch(s, /Ошибка|GitHub/, `offline is shown as a GitHub error: «${s}»`);
  assert.equal((await pending()).length, 1);
  await online();
  await queueEmpty();
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

/* =================== key problems keep their own behaviour =================== */

test("a key without write rights is not queued as a GitHub outage: the answers stay in the form, the key is named, and nothing is retried by itself", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi();
  await rules([{ url: GH, body: COMMIT, status: 403, json: { message: "Resource not accessible by personal access token" } }]);
  await saveRating();
  const m = await msgOf("fMsg");
  assert.equal(await hash(), "#/rate", "stays in the form");
  assert.equal(await qval("интернет"), "4");
  assert.equal((await pending()).length, 0, "not queued");
  assert.match(m, /прав|ключ/i, `«${m}»`);
  assert.doesNotMatch(m, /GitHub (сейчас |временно )?не отвечает/, `a rights problem is reported as an outage: «${m}»`);
  const n = (await commitCalls()).length;
  const t0 = await clock();
  await page.waitFor(`Date.now() > ${t0 + 3 * 60000}`, 20000, "3 minutes on the page clock");
  assert.equal((await commitCalls()).length, n, "the app keeps re-sending with a key that cannot write");
});

test("a revoked key keeps its own message and is not retried with the same key by the GitHub retry timer", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", fast: true });
  await rateBatumi();
  await rules([{ url: ALL, auth: "TEST_e2e", status: 401, json: { message: "Bad credentials" } }]);
  await saveRating();
  const said = await told("fMsg");
  assert.match(said, /Ключ/i, `«${said}»`);
  assert.doesNotMatch(said, /GitHub (сейчас |временно )?не отвечает/, `a revoked key is reported as an outage: «${said}»`);
  assert.equal(await syncText(), "Ключ не подходит");
  const n = (await commitCalls()).length;
  const t0 = await clock();
  await page.waitFor(`Date.now() > ${t0 + 4 * 60000}`, 25000, "4 minutes on the page clock");
  assert.equal((await commitCalls()).length, n, "the retry timer keeps committing with a revoked key");
});

/* =================== how it reads =================== */

test("with a change queued during a 503, the ranking banner says how many wait and that they will be sent by themselves, without asking to save again", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  await go("#/rank");
  const b = await ghBanner();
  assert.ok(b, "no banner on the ranking explains the outage");
  assert.match(b, /GitHub/);
  assert.match(b, /1/, `the banner does not say how many changes wait: «${b}»`);
  assert.match(b, AUTO, `the banner does not say they will be sent by themselves: «${b}»`);
  assert.doesNotMatch(b, /Сохранить.{0,20}ещё раз|сохраните ещё раз/i, `«${b}»`);
  assert.doesNotMatch(b, /\b[45]\d\d\b/, `«${b}»`);
});

test("with exactly one change waiting for GitHub, the banner speaks of one change, not «1 — не потеряются и отправятся»", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: 5 });
  await rules([{ url: GH, body: COMMIT, hang: true, times: 1 }, down503()]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, `not queued: «${await msgOf("placeMsg")}»`);
  await go("#/rank");
  await page.waitFor(`[...document.querySelectorAll(".view:not([hidden]) .banner")].some(b => /GitHub/.test(b.innerText))`, 6000, "outage banner on the ranking");
  const b = await ghBanner();
  assert.match(b, /\b1\b/, `«${b}»`);
  assert.doesNotMatch(b, /\b1\b[^.]{0,40}(потеряются|отправятся|ждут)/, `one change is spoken of in the plural: «${b}»`);
});

test("the «ждёт отправки» mark on a trip queued during a GitHub outage does not blame the internet connection", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi();
  await rules([down503()]);
  await saveRating();
  await page.waitFor(`location.hash === "#/place/batumi"`, 3000, "dossier").catch(() => {});
  const chip = await page.eval(`(() => { const c = [...document.querySelectorAll("#v-place .chip")].find(x => /ждёт отправки/.test(x.innerText)); return c ? (c.title || c.getAttribute("aria-label") || "") : null; })()`);
  assert.ok(chip != null, "no «ждёт отправки» mark on the queued trip");
  assert.doesNotMatch(chip, /появится связь/, `the internet works; the mark says «${chip}»`);
});

test("settings during a GitHub outage with a queued change say that the change waits and will be sent by itself, not only «GitHub не отвечает»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([down503({ url: ALL, body: null })]);
  await saveCard("archetype", "город у океана");
  await go("#/settings", 500);
  const t = await page.eval(`[document.getElementById("tokenMsg"), ...document.querySelectorAll("#v-settings .banner")].filter(Boolean).map(e => e.innerText.replace(/\\s+/g, " ").trim()).join(" | ")`);
  assert.match(t, /очеред|ждёт|ждут|не отправ/i, `the connection part of the settings does not mention the waiting change: «${t}»`);
  assert.match(t, AUTO, `the connection part of the settings does not say the change will be sent by itself: «${t}»`);
});

test("after GitHub is back and the queue is sent, every trace of the outage is gone: status, banner, the «ждёт отправки» mark", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Наконец дошло" });
  await rules([down503()]);
  await saveRating();
  await rules([]);
  await comeBack();
  await queueEmpty();
  await sleep(400);
  const s = await syncText();
  assert.doesNotMatch(s, /Ошибка|очеред|не отвеча|GitHub/i, `«${s}»`);
  assert.equal(await ghBanner(), "");
  await go("#/place/batumi", 500);
  const t = await page.text("#v-place");
  assert.match(t, /Наконец дошло/);
  assert.doesNotMatch(t, /ждёт отправки/);
});

test("at desktop width in dark mode the outage banner with a queued change is readable and nothing scrolls sideways", { skip }, async () => {
  await open({ hash: "#/place/porto" }, { w: 1280, h: 800, dark: true });
  await rules([down503()]);
  await saveCard("archetype", "город у океана");
  await go("#/rank", 500);
  const b = await ghBanner();
  assert.ok(b, "no outage banner on the ranking");
  const look = await page.eval(`(() => {
    const b = [...document.querySelectorAll(".view:not([hidden]) .banner")].find(x => /GitHub|очеред/i.test(x.innerText));
    const cs = getComputedStyle(b), lum = c => { const m = c.match(/\\d+(\\.\\d+)?/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    let bg = cs.backgroundColor, el = b; while (/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg) && el.parentElement) { el = el.parentElement; bg = getComputedStyle(el).backgroundColor; }
    if (/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) bg = getComputedStyle(document.body).backgroundColor;
    const a = lum(cs.color), c = lum(bg);
    return { ratio: (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05), wide: document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  await page.shot("c3-retry-desktop-dark-banner");
  assert.ok(look.ratio >= 4.5, `banner text contrast ${look.ratio.toFixed(2)} in dark mode`);
  assert.equal(look.wide, false, "the page scrolls sideways");
});

test("on an iPhone-size screen the message after a 503 rating save is fully visible and not covered by the tab bar", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi();
  await rules([down503({ delay: 300 })]);
  await press("#fSave");
  await page.waitFor(`!document.getElementById("toast").hidden || document.getElementById("fMsg").innerText.trim() !== ""`, 8000, "a message");
  await page.shot("c3-retry-iphone-after-503");
  const r = await page.eval(`(() => {
    const t = document.getElementById("toast"), m = document.getElementById("fMsg");
    const el = !t.hidden && t.innerText ? t : m;
    const b = el.getBoundingClientRect(), nav = document.querySelector(".bottomnav"), n = nav ? nav.getBoundingClientRect() : { top: innerHeight };
    return { top: b.top, bottom: b.bottom, navTop: n.top, h: innerHeight, text: el.innerText };
  })()`);
  assert.ok(r.top >= 0 && r.bottom <= r.h, `the message is cut off: ${js(r)}`);
  assert.ok(r.bottom <= r.navTop + 1 || r.top >= r.navTop, `the message is under the tab bar: ${js(r)}`);
  assert.deepEqual(page.takeErrors(), []);
});

/* =================== cycle 3 review: a refusal is not an outage =================== */

const RULE_VIOLATION = { data: null, errors: [{ type: "UNPROCESSABLE", message: "Repository rule violations found\n\nCommits must have verified signatures." }] };
const NOT_WAITING = /отправлю сам|отправится сам|когда GitHub ответит|сохранена на (этом устройстве|телефоне)/i;

test("a rating GitHub refuses (repository rule violation) shows GitHub's reason in the form, keeps the answers, queues nothing, and a card save right after goes through", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await rateBatumi({ review: "Отказ по правилам" });
  await rules([{ url: GH, body: COMMIT, status: 200, json: RULE_VIOLATION, times: 1 }]);
  await saveRating();
  const said = await told("fMsg");
  assert.equal(await hash(), "#/rate", `the form must stay open with the answers: «${said}»`);
  assert.match(said, /GitHub не принял правку: Repository rule violations found/, `the user does not learn that GitHub refused it, or why: «${said}»`);
  assert.match(said, /не сохранена/);
  assert.doesNotMatch(said, NOT_WAITING, `a refused save must not promise an automatic send: «${said}»`);
  assert.doesNotMatch(said, /Commits must have/, "only GitHub's first line, not the whole text");
  assert.equal(await val("#fReview"), "Отказ по правилам", "the answers stay in the form");
  assert.deepEqual(await pending(), [], "a permanent refusal is not queued");
  assert.doesNotMatch(await syncText(), /Ждут|GitHub не отвечает/, "the connection works; only this rating was refused");
  await go("#/place/porto", 500);
  await saveCard("archetype", "город у океана");
  assert.doesNotMatch(await msgOf("placeMsg"), /не сохранен|GitHub/, `a later save is held behind the refused one: «${await msgOf("placeMsg")}»`);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
  assert.deepEqual(await pending(), []);
});

test("a card save answered 422 «Validation Failed» says GitHub refused it and why, under the button, without a code and without «отправлю сам»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([{ url: GH, body: COMMIT, status: 422, json: { message: "Validation Failed", errors: [{ code: "custom" }] }, times: 1 }]);
  await saveCard("archetype", "город у океана");
  const m = await msgOf("placeMsg");
  for (const re of [/Карточка не сохранена/, /GitHub не принял/, /Validation Failed/]) assert.match(m, re, `«${m}»`);
  assert.match(m, /в хранилище на GitHub/, `the user is not told what to do if it repeats: «${m}»`);
  assert.doesNotMatch(m, /\b422\b|через минуту/, `«${m}»`);
  assert.doesNotMatch(m, NOT_WAITING, `«${m}»`);
  assert.deepEqual(await pending(), []);
  await saveCard("archetype", "город у океана");
  assert.equal((await doc("places/porto.json")).archetype, "город у океана", "the second tap, once GitHub accepts, saves it");
});

test("a change queued offline that GitHub then refuses moves to «GitHub не принял правку» with the reason and «Отправить снова», does not block a later save, and is sent on «Отправить снова»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await knob("mock:offline", "1");
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "fixture: queued offline");
  await rules([{ url: GH, body: COMMIT, status: 200, json: RULE_VIOLATION, times: 1 }]);
  await online();
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 1`, 8000, "refused change moved out of the queue");
  assert.deepEqual(await pending(), [], "the refused change no longer sits in the queue, retried forever");
  await seen(`window.__toasts.some(t => /не принял/.test(t))`, 4000);
  const said = (await toasts()).join(" | ");
  for (const re of [/Не отправлено: 1\b/, /GitHub не принял/, /Repository rule violations found/]) assert.match(said, re, `«${said}»`);
  await go("#/rank");
  const b = (await banners()).find(x => /не принял/.test(x)) || "";
  assert.match(b, /GitHub не принял правку: Repository rule violations found/, `«${b}»`);
  assert.match(b, /сохранена (на этом устройстве|на телефоне)/, `the banner does not say the change is kept: «${b}»`);
  assert.match(b, /Скачать копию данных/, `the banner does not point to the copy in settings: «${b}»`);
  assert.match(b, /Порту/, "the row names the place");
  assert.doesNotMatch(b, /изменили на другом устройстве/, "a refusal is not a clash with another device");
  await page.shot("c3-retry-refused-banner");
  assert.doesNotMatch(await syncText(), /Ждут GitHub|GitHub не отвечает/);
  await go("#/place/valensiya", 500);
  await saveCard("archetype", "курорт");
  assert.equal((await doc("places/valensiya.json")).archetype, "курорт", "a later save is not held behind the refused change");
  await go("#/rank");
  await page.tap({ text: "Отправить снова", within: "#v-rank" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 0`, 8000, "sent again");
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
  assert.match((await toasts()).join(" | "), /Отправлено/);
});

test("when GitHub keeps failing for 6 tries, the banner, status and settings say GitHub has not taken changes for a long time and point to the copy, and the queue is kept", { skip }, async () => {
  await open({ hash: "#/place/porto", fast: 60 });
  await rules([down503({ url: ALL, body: null })]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "queued");
  await page.waitFor(`(async () => (await import("./js/app.js")).state.data.tries >= 6)()`, 60000, "6 failed tries");
  await go("#/rank");
  const b = await ghBanner();
  assert.match(b, /GitHub давно не принимает правки/, `«${b}»`);
  assert.match(b, /Скачать копию данных/, `the banner does not offer the copy: «${b}»`);
  assert.match(b, /сам/, `the banner does not say the app keeps trying: «${b}»`);
  assert.match(await syncText(), /Давно ждут GitHub: 1/);
  await statusCounts(1, "after 6 failed tries");
  await go("#/settings");
  assert.match(await msgOf("tokenMsg"), /давно не принимает правки[\s\S]*Скачать копию данных/, `«${await msgOf("tokenMsg")}»`);
  assert.equal((await pending()).length, 1, "the change is kept");
  await rules([]);
  await queueEmpty(30000);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

test("tapping the status during a GitHub rate limit says until when, instead of doing nothing", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const reset = Math.floor(Date.now() / 1000) + 1800;
  await rules([limitedUntil(reset, { until: 0 })]);
  await saveCard("archetype", "город у океана");
  assert.equal((await pending()).length, 1, "fixture: the rate-limited save is queued");
  assert.equal(await page.eval(`document.getElementById("syncAction").textContent`), "Ждём GitHub:", "the hidden label must not promise «Обновить данные»");
  await page.eval(`window.__toasts.length = 0; localStorage.setItem("c3:calls", "[]")`);
  await page.tap({ sel: "#syncBtn" });
  await seen(`window.__toasts.some(t => /ограничил/.test(t))`, 3000);
  await page.idle(300);
  const t = (await toasts()).join(" | ");
  assert.match(t, /ограничил запросы до \d\d:\d\d/, `the tap gives no feedback: «${t}»`);
  assert.match(t, /после этого времени/);
  assert.deepEqual((await calls()).map(c => c.u), [], "no request while GitHub limits them");
});

test("a GitHub outage is worded the same in the banner and in settings, in one voice", { skip }, async () => {
  await open({ hash: "#/rank" });
  await rules([{ url: GH, status: 503, text: "<html><body>503 Service Unavailable</body></html>", type: HTML }]);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText === "GitHub не отвечает"`, 6000, "error shown");
  const b = await ghBanner();
  assert.match(b, /^GitHub сейчас не отвечает\./, `«${b}»`);
  assert.doesNotMatch(b, /Приложение сам/, `the banner switches from «я» to «приложение»: «${b}»`);
  await go("#/settings");
  const m = await msgOf("tokenMsg");
  assert.match(m, /^GitHub сейчас не отвечает/, `settings word the same outage differently: «${m}»`);
  assert.doesNotMatch(m, /временно не отвечает/);
});
