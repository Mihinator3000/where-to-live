import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles, mockLog } from "./fixtures.mjs";

// Lens: errors and recovery. Everything that can go wrong (GitHub down, odd replies, a revoked key, a lost repository,
// rate limits, a reply lost after the commit went through, OpenStreetMap down, world files missing, broken files in the
// data repo, full or blocked storage, impatient taps, leaving a screen mid-save), judged by a non-technical user who
// must know two things: is my data safe, and what do I do now.

const skip = !CHROME && "no Chrome";
let srv, page;

// Fault injection on top of the shared mock. Rules live in localStorage "c2:rules" (a JSON list), each matching a URL
// part (and optionally a request-body part or an Authorization part). A rule can let the request through first
// ("after": the commit lands, the reply is lost), delay it, hang it forever, fail it like a dropped network, or answer
// with any status, body, content type and headers; "times" makes it one-shot. "c2:quota" (a RegExp source) makes
// localStorage writes of matching wtl: keys throw QuotaExceededError; "c2:nols" makes every wtl: key throw SecurityError
// like a browser that blocks site storage. Every GitHub request is counted in window.__c2calls.
const FAULT = `(() => {
  if (location.hostname !== "127.0.0.1") return;
  const inner = window.fetch;
  const ls = window.localStorage;
  const S = Storage.prototype, set0 = S.setItem, get0 = S.getItem, del0 = S.removeItem;
  const knob = k => get0.call(ls, k);
  const rules = () => { try { return JSON.parse(knob("c2:rules") || "[]"); } catch (e) { return []; } };
  window.__c2calls = [];
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init && typeof init.body === "string" ? init.body : "";
    const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || "");
    if (url.startsWith("https://api.github.com/")) window.__c2calls.push(url.replace("https://api.github.com", "") + (body.includes("createCommitOnBranch") ? " commit" : ""));
    const rs = rules();
    const i = rs.findIndex(r => url.includes(r.url) && (!r.body || body.includes(r.body)) && (!r.auth || auth.includes(r.auth)));
    if (i < 0) return inner(input, init);
    const r = rs[i];
    if (r.times != null) { r.times--; if (r.times <= 0) rs.splice(i, 1); set0.call(ls, "c2:rules", JSON.stringify(rs)); }
    if (r.after) await inner(input, init);
    if (r.delay) await new Promise(res => setTimeout(res, r.delay));
    if (r.hang) return new Promise(() => {});
    if (r.net) throw new TypeError("Failed to fetch");
    return new Response(r.text != null ? r.text : JSON.stringify(r.json || { message: "Server Error" }), { status: r.status || 200, headers: Object.assign({ "Content-Type": r.type || "application/json" }, r.headers || {}) });
  };
  S.setItem = function (k, v) {
    if (this === ls && String(k).startsWith("wtl:")) {
      if (knob("c2:nols")) throw new DOMException("The operation is insecure.", "SecurityError");
      const q = knob("c2:quota");
      if (q && new RegExp(q).test(k)) throw new DOMException("Exceeded the quota.", "QuotaExceededError");
    }
    return set0.call(this, k, v);
  };
  S.getItem = function (k) {
    if (this === ls && String(k).startsWith("wtl:") && knob("c2:nols")) throw new DOMException("The operation is insecure.", "SecurityError");
    return get0.call(this, k);
  };
  S.removeItem = function (k) {
    if (this === ls && String(k).startsWith("wtl:") && knob("c2:nols")) throw new DOMException("The operation is insecure.", "SecurityError");
    return del0.call(this, k);
  };
  const seen = window.__toasts = [];
  addEventListener("DOMContentLoaded", () => {
    const t = document.getElementById("toast");
    if (t) new MutationObserver(() => { if (!t.hidden && t.innerText) seen.push(t.innerText); }).observe(t, { childList: true, characterData: true, subtree: true, attributes: true });
  });
})();`;

before(async () => { srv = await serve(); page = await launch(); await page.send("Page.addScriptToEvaluateOnNewDocument", { source: FAULT }); });
after(async () => { await page?.close(); await srv?.close(); });
beforeEach(async () => { if (page) { await page.viewport(390, 844, { dark: false }); page.takeErrors(); } });

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = "2026-10-01T00:00:00.000Z";
const GH = "/graphql";
const COMMIT = "createCommitOnBranch";
const HTML = "text/html; charset=utf-8";
const NOT_FOUND = { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'Mihinator3000/where-to-live-data'." }] };
const nowSec = () => Math.floor(Date.now() / 1000);
const limited = (resetIn = 2400) => ({ url: GH, status: 403, json: { message: "API rate limit exceeded for user ID 1.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api" }, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(nowSec() + resetIn) } });

async function open(opts = {}, vp = {}) {
  await page.viewport(vp.w || 390, vp.h || 844, { dark: !!vp.dark });
  await openApp(page, srv.url, opts);
  await page.waitFor(`document.getElementById("syncText").innerText !== "Обновляю…"`, 8000, "first load settled");
  await sleep(150);
  page.takeErrors();
}
const rules = list => page.eval(`localStorage.setItem("c2:rules", ${JSON.stringify(JSON.stringify(list))})`);
const knob = (k, v) => page.eval(v == null ? `localStorage.removeItem(${JSON.stringify(k)})` : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const qval = k => page.eval(`document.querySelector('[data-qval="${k}"]').textContent`);
const val = sel => page.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
const hash = () => page.eval("location.hash");
const syncText = () => page.text("#syncText");
const files = () => mockFiles(page);
const doc = async path => { const f = (await files())[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async place => Object.entries(await files()).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);
const pending = () => page.eval(`JSON.parse(localStorage.getItem("wtl:pending") || "[]")`);
const commits = async () => (await mockLog(page)).filter(e => e.op === "add" || e.op === "del");
const toasts = () => page.eval(`window.__toasts.slice()`);
const toastText = (re = /./, timeout = 6000) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, timeout, "toast " + re);
const banners = () => page.eval(`[...document.querySelectorAll(".view:not([hidden]) .banner")].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
const errBanner = async () => (await banners()).find(b => /GitHub|Ключ|ключ|связ|Хранилищ|хранилищ|запрос/.test(b)) || "";
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const go = async (h, settle = 350) => { await page.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(settle); };
const fMsg = () => page.text("#fMsg");
async function seen(js, timeout = 3000) { try { await page.waitFor(js, timeout); return true; } catch { return false; } }
async function reload() {
  await page.eval(`window.__before = 1`);
  await page.send("Page.reload", {});
  await page.waitFor(`!window.__before && document.readyState === "complete" && document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app reloaded");
  await sleep(200);
}
async function openEdit(placeId) {
  await go("#/place/" + placeId, 400);
  await page.tap({ text: "Изменить", within: "#v-place" });
  await page.waitFor(`document.querySelector(".edit-head") && !document.getElementById("fDelete").hidden`, 4000, "edit form");
}
async function typeSearch(q) {
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type(q);
}
async function searchEverywhere(q) {
  await typeSearch(q);
  await page.key("Enter");
}
const results = () => page.text("#searchResults");

// What a user must never read: an HTTP status code, a JS/JSON parser message, or untranslated English.
const NAMES = /GitHub|OpenStreetMap|Nominatim|Claude|Safari|github_pat_\S*|where-to-live-data|Mihinator3000\/\S*|Contents: Read and write|Repository access|Only select repositories/g;
function plain(text, what) {
  assert.ok(text && text.trim(), `${what}: nothing is said at all`);
  assert.doesNotMatch(text, /\b[45]\d\d\b/, `${what}: shows a raw HTTP code: «${text}»`);
  assert.doesNotMatch(text, /JSON|Response|Unexpected token|Failed to|TypeError|SyntaxError|undefined|null\b|NaN/, `${what}: shows a programmer's error: «${text}»`);
  const english = (text.replace(NAMES, "").match(/[A-Za-z]{3,}(?:\s+[A-Za-z]{2,})*/g) || []);
  assert.deepEqual(english, [], `${what}: English words «${english.join(" / ")}» in «${text}»`);
}

/* =================== first load fails =================== */

test("when GitHub answers the first load with an error page, the banner says what happened and what to do, without an HTTP code", { skip }, async () => {
  await open({ hash: "#/rank", local: { "c2:rules": [{ url: GH, status: 502, text: "<html><body><h1>502 Bad Gateway</h1></body></html>", type: HTML }] } });
  assert.equal(await syncText(), "Ошибка связи");
  const b = await errBanner();
  assert.match(b, /GitHub/, `«${b}»`);
  assert.match(b, /попроб|нажмите|подожд|позже/i, `no next step: «${b}»`);
  plain(b, "load error banner");
});

test("when GitHub sends a web page or a cut-off reply instead of data, the banner speaks Russian, not a JSON parser error", { skip }, async () => {
  for (const [what, text] of [["captive Wi-Fi page", "<!DOCTYPE html><html><body>Войдите в сеть кафе</body></html>"], ["cut-off reply", '{"data":{"repository":{"ref"']]) {
    await open({ hash: "#/rank", local: { "c2:rules": [{ url: GH, status: 200, text, type: what.includes("page") ? HTML : "application/json" }] } });
    assert.equal(await syncText(), "Ошибка связи", what);
    const b = await errBanner();
    assert.match(b, /попроб|нажмите|подожд|позже/i, `${what}: no next step: «${b}»`);
    plain(b, what);
    assert.deepEqual(page.takeErrors(), [], what);
  }
});

test("after a failed first load the ranking does not claim «Мест: 0 · оценок: 0»", { skip }, async () => {
  await open({ hash: "#/rank", local: { "c2:rules": [{ url: GH, status: 500, json: { message: "Server Error" } }] } });
  assert.equal(await syncText(), "Ошибка связи");
  const head = await page.text("#v-rank header");
  assert.doesNotMatch(head, /Мест: 0\b|оценок: 0\b|0 из 20/, `nothing was loaded, yet the header counts zero: «${head}»`);
});

test("after a failed first load, tapping the status tries again and our data appears once GitHub answers", { skip }, async () => {
  await open({ hash: "#/rank", local: { "c2:rules": [{ url: GH, status: 503, text: "<html>Service Unavailable</html>", type: HTML, times: 1 }] } });
  assert.equal(await syncText(), "Ошибка связи");
  assert.doesNotMatch(await page.text("#rank"), /Порту/);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 6000, "loaded on retry");
  assert.match(await page.text("#rank"), /Порту/);
  assert.equal(await errBanner(), "", "the error banner is gone");
});

test("a GitHub rate limit says when it will be lifted, from GitHub's reset time, instead of «через минуту»", { skip }, async () => {
  const rule = limited(2400);
  await open({ hash: "#/rank", local: { "c2:rules": [rule] } });
  const b = await errBanner();
  assert.match(b, /огранич|лимит|много запросов/i, `«${b}»`);
  const at = await page.eval(`new Date(${rule.headers["x-ratelimit-reset"]} * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })`);
  assert.doesNotMatch(b, /через минуту/, `GitHub said the limit lasts 40 more minutes: «${b}»`);
  assert.ok(b.includes(at) || /\b(39|40)\s*мин/.test(b), `the banner does not say «до ${at}» or «через 40 мин»: «${b}»`);
  plain(b, "rate limit banner");
});

test("a data repository that was renamed or deleted is not reported as a bad key, and the message names the repository", { skip }, async () => {
  await open({ hash: "#/rank", local: { "c2:rules": [{ url: GH, status: 200, json: NOT_FOUND }] } });
  const status = await syncText(), b = await errBanner();
  assert.doesNotMatch(status, /Ключ не подходит/, "GitHub can not tell a missing repository from a key without access, so «the key does not fit» sends the user to make a new key for nothing");
  assert.doesNotMatch(b, /^Ключ доступа не подходит/, `«${b}»`);
  assert.match(b, /where-to-live-data/, `the banner does not say which repository is missing: «${b}»`);
  assert.match(b, /переимен|удал/i, `«${b}»`);
  assert.match(b, /настройк/i, `«${b}»`);
});

/* =================== a save fails =================== */

test("a rating save that fails with a GitHub server error keeps every answer on the phone, says so in plain words and sends it once GitHub answers", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Ветрено, но уютно.");
  await rules([{ url: GH, body: COMMIT, status: 500, json: { message: "Server Error" }, times: 1 }]);
  await press("#fSave");
  const m = await toastText(/GitHub/);
  assert.equal((await ratingsOn("batumi")).length, 0);
  const q = await pending();
  assert.equal(q.length, 1, "the answers wait in the queue on the phone");
  assert.match(q[0].content, /Ветрено, но уютно/);
  assert.match(m, /сохранена/i, `«${m}»`);
  assert.match(m, /отправлю сам/i, `«${m}»`);
  plain(m, "save toast");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 8000, "queue sent once GitHub answers");
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("a rating save answered with a web page instead of data says in Russian that it waits on the phone and keeps the answers", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("шум", 2);
  await rules([{ url: GH, body: COMMIT, status: 200, text: "<html><body>Proxy error</body></html>", type: HTML, times: 1 }]);
  await press("#fSave");
  const m = await toastText(/GitHub/);
  assert.equal((await pending()).length, 1, "the answers wait in the queue on the phone");
  assert.match(m, /сохранена/i, `«${m}»`);
  plain(m, "save toast");
  plain(await errBanner(), "banner after the save");
});

test("a rate-limited save keeps the answers and says when they go out, not «сбой на стороне GitHub»", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  const rule = limited(1800);
  await rules([Object.assign({}, rule, { body: COMMIT })]);
  await press("#fSave");
  const m = await toastText(/GitHub/);
  const at = await page.eval(`new Date(${rule.headers["x-ratelimit-reset"]} * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })`);
  assert.equal((await pending()).length, 1, "the answers wait in the queue on the phone");
  assert.match(m, /сохранена/i, `«${m}»`);
  assert.doesNotMatch(m, /сбой/i, `a rate limit is not a failure on GitHub's side: «${m}»`);
  assert.doesNotMatch(m, /через минуту/, `GitHub said 30 minutes: «${m}»`);
  assert.ok(m.includes(at) || /\b(29|30)\s*мин/.test(m), `does not say «до ${at}»: «${m}»`);
});

test("with a key that can read but not write, the form says the answers stayed and to replace the key in settings, and the status is not «Ошибка связи»", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await rules([{ url: GH, body: COMMIT, status: 403, json: { message: "Resource not accessible by personal access token" } }]);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText.trim() !== ""`, 8000, "save result");
  const m = await fMsg();
  assert.equal(await qval("интернет"), "4");
  assert.equal((await commits()).length, 0);
  assert.match(m, /остал|не сохран/i, `the user does not learn whether the rating is lost: «${m}»`);
  assert.match(m, /настройк/i, `the user is not told where to fix it: «${m}»`);
  assert.notEqual(await syncText(), "Ошибка связи", "this is a key without write rights, not a connection problem");
});

test("a GitHub internal error reported inside a normal reply («Something went wrong…») reaches the user in Russian", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await rules([{ url: GH, body: COMMIT, status: 200, json: { data: null, errors: [{ message: "Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `A1B2:3C4D` when reporting this issue." }] }, times: 1 }]);
  await press("#fSave");
  const m = await toastText(/GitHub/);
  assert.equal((await pending()).length, 1, "the answers wait in the queue on the phone");
  assert.match(m, /сохранена/i, `«${m}»`);
  plain(m, "save toast");
  plain(await errBanner(), "banner after the save");
});

test("after a save that met a GitHub error, the queued rating goes out once GitHub is back, exactly once", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Со второй попытки");
  await rules([{ url: GH, body: COMMIT, status: 502, text: "<html>Bad Gateway</html>", type: HTML, times: 1 }]);
  await press("#fSave");
  await toastText(/GitHub/);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 8000, "queue sent once GitHub answers");
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].review, "Со второй попытки");
  assert.match(await page.text("#v-place"), /Со второй попытки/);
  assert.equal(await errBanner(), "", "the old error banner is gone");
});

test("a save whose reply was lost after GitHub committed it is queued, and sending the queue duplicates neither the rating nor the question", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fQuestions", "Где купить сим-карту?");
  await rules([{ url: GH, body: COMMIT, after: true, net: true, times: 1 }]);
  await press("#fSave");
  assert.match(await toastText(/Нет связи/), /отправится/);
  assert.ok((await pending()).length >= 1);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await ratingsOn("batumi")).length, 1, "one rating, not two");
  assert.equal((await doc("places/batumi.json")).questions, "Где купить сим-карту?");
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("wtl:lost") || "[]")`), [], "nothing reported as clashing with another device");
  assert.doesNotMatch(await syncText(), /Не отправлено|Ошибка/);
});

test("a save that timed out at GitHub's gateway after the commit went through is queued, and sending it duplicates neither the rating nor the question", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fQuestions", "Где купить сим-карту?");
  await rules([{ url: GH, body: COMMIT, after: true, status: 504, text: "<html>504 Gateway Time-out</html>", type: HTML, times: 1 }]);
  await press("#fSave");
  await toastText(/GitHub/);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 8000, "queue sent once GitHub answers");
  assert.equal((await ratingsOn("batumi")).length, 1, "one rating, not two");
  const q = (await doc("places/batumi.json")).questions;
  assert.equal(q, "Где купить сим-карту?", `the question is written into the place card twice: ${JSON.stringify(q)}`);
});

test("a save that gets no answer at all tells the user within 20 seconds instead of «Сохраняю…» forever", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await rules([{ url: GH, body: COMMIT, hang: true }]);
  await press("#fSave", 50);
  assert.equal(await page.text("#fSave"), "Сохраняю…");
  const told = await seen(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText.trim() !== "" || document.getElementById("fSave").innerText !== "Сохраняю…"`, 22000);
  const state = await page.eval(`({ hash: location.hash, btn: document.getElementById("fSave").innerText, msg: document.getElementById("fMsg").innerText, status: document.getElementById("syncText").innerText })`);
  await rules([]);
  assert.ok(told, `after 22 s the user still sees only ${JSON.stringify(state)} and does not know if the rating is safe`);
  if (state.hash === "#/rate") assert.match(state.msg, /долго|не отвеча|медлен|очеред|остал/i, JSON.stringify(state));
});

test("when the key is revoked mid-session the rating waits on the device, the banner says so, and a new key sends it", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await rules([{ url: "https://api.github.com/", auth: "TEST_e2e", status: 401, json: { message: "Bad credentials" } }]);
  await press("#fSave");
  assert.match(await toastText(/Ключ не подходит/), /отправится/);
  assert.equal((await pending()).length, 1);
  assert.equal(await syncText(), "Ключ не подходит");
  const b = await errBanner();
  assert.match(b, /настройк/i, `«${b}»`);
  assert.match(b, /не потеряются|сохранен/i, `«${b}»`);
  await go("#/settings");
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_new_key");
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 8000, "queue sent with the new key");
  assert.equal((await ratingsOn("batumi")).length, 1);
  assert.notEqual(await syncText(), "Ключ не подходит");
});

test("coming back to the app notices a revoked key instead of still showing «Подключено»", { skip }, async () => {
  await open({ hash: "#/rank" });
  assert.equal(await syncText(), "Подключено");
  await rules([{ url: "https://api.github.com/", auth: "TEST_e2e", status: 401, json: { message: "Bad credentials" } }]);
  await comeBack();
  const ok = await seen(`document.getElementById("syncText").innerText === "Ключ не подходит"`, 4000);
  assert.ok(ok, `the background check got 401, yet the status still says «${await syncText()}» and the user saves into a key that no longer works`);
});

test("a rating saved after the data repository disappeared stays on the device and the banner says it is not lost", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Отзыв без хранилища");
  await rules([{ url: GH, status: 200, json: NOT_FOUND }]);
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/batumi" || document.getElementById("fMsg").innerText.trim() !== ""`, 6000, "save result");
  const queued = await pending(), msg = await fMsg();
  assert.ok(queued.length === 1 || (await val("#fReview")) === "Отзыв без хранилища", `the answers are neither queued nor kept in the form (${msg})`);
  if (queued.length) assert.match(await errBanner(), /не потеряются/);
});

/* =================== other saves: card, place, weights, deletion =================== */

test("a card edit that fails after I left the dossier is reported, and my text is not silently thrown away", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.fill('#placeForm [name="questions"]', "Как там с отоплением зимой?");
  await rules([{ url: GH, body: COMMIT, delay: 1200, status: 500, json: { message: "Server Error" } }]);
  await press("#placeForm [type=submit]", 50);
  await go("#/rank", 2500);
  const said = (await toasts()).join(" | ");
  assert.match(said, /не сохран|сохранена на (этом устройстве|телефоне)/i, `the user left the dossier before the error and was never told: toasts «${said}»`);
  await go("#/place/porto", 500);
  const now = await val('#placeForm [name="questions"]');
  const kept = now.includes("отоплением") || /отоплением/.test(await page.text("#v-place"));
  assert.ok(kept, `my unsaved question is gone, the field shows «${now}»`);
});

test("a card save that fails with a GitHub server error says the edit waits on the phone, without an HTTP code", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await rules([{ url: GH, body: COMMIT, status: 500, json: { message: "Server Error" } }]);
  await press("#placeForm [type=submit]");
  await page.waitFor(`document.getElementById("placeMsg").innerText.trim() !== ""`, 6000, "save result");
  const m = await page.text("#placeMsg");
  assert.equal(await val('#placeForm [name="archetype"]'), "город у океана", "typed text kept");
  assert.equal((await pending()).length, 1, "the edit waits in the queue on the phone");
  assert.match(m, /сохранена на (этом устройстве|телефоне)/i, `«${m}»`);
  assert.match(m, /отправлю сам/i, `«${m}»`);
  plain(m, "card save message");
});

test("adding a place while GitHub fails keeps it on the phone and says so, without an HTTP code", { skip }, async () => {
  await open({ hash: "#/map" });
  await typeSearch("Будва");
  await page.tap({ text: "Будва", within: "#searchResults" });
  await page.waitFor(`document.querySelector('#sheet [data-act="addcity"]')`, 4000, "city sheet");
  await rules([{ url: GH, body: COMMIT, status: 500, json: { message: "Server Error" } }]);
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  const t = await toastText(/./);
  assert.equal(await doc("places/budva.json"), null);
  assert.equal((await pending()).length, 1, "the place waits in the queue on the phone");
  assert.match(t, /место сохранено на (этом устройстве|телефоне)/i, `«${t}»`);
  assert.match(t, /отправлю сам/i, `«${t}»`);
  plain(t, "add place toast");
});

test("saving weights while GitHub fails keeps them on the phone and says so", { skip }, async () => {
  await open({ hash: "#/rank", local: { "wtl:wopen": true } });
  await rules([{ url: GH, body: COMMIT, status: 500, json: { message: "Server Error" } }]);
  await press("#wsaveBtn");
  const t = await toastText(/./);
  assert.equal(Object.keys(await files()).filter(k => k.startsWith("weights/")).length, 0);
  assert.equal((await pending()).length, 1, "the weights wait in the queue on the phone");
  assert.match(t, /веса сохранены на (этом устройстве|телефоне)/i, `«${t}»`);
  plain(t, "weights toast");
});

test("deleting a rating while GitHub fails keeps the deletion on the phone and says so, without an HTTP code", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openEdit("porto");
  await rules([{ url: GH, body: COMMIT, status: 500, json: { message: "Server Error" } }]);
  await press("#fDelete");
  await press("#fDelete");
  const m = await toastText(/GitHub/);
  assert.equal((await doc("ratings/r1.json")).deleted, false, "GitHub did not get the deletion yet");
  assert.equal((await pending()).length, 1, "the deletion waits in the queue on the phone");
  assert.match(m, /удаление сохранено на (этом устройстве|телефоне)/i, `«${m}»`);
  plain(m, "delete toast");
});

/* =================== impatient taps =================== */

test("the confirming tap on «Удалить оценку» shows progress, and more taps on a slow network send nothing more and raise no false clash", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openEdit("porto");
  await knob("mock:delay", "1500");
  await press("#fDelete", 60);
  const r = await page.locate({ sel: "#fDelete" });
  await page.click(r.x, r.y);
  await sleep(120);
  const busy = await page.eval(`({ t: document.getElementById("fDelete").innerText, d: document.getElementById("fDelete").disabled })`);
  await page.click(r.x, r.y); await sleep(80);
  await page.click(r.x, r.y); await sleep(80);
  await page.waitFor(`location.hash === "#/place/porto"`, 8000, "back in the dossier");
  await sleep(2500);
  await knob("mock:delay", null);
  assert.ok(busy.d || /Удаляю/.test(busy.t), `while deleting the button still reads «${busy.t}» and can be pressed`);
  assert.equal((await commits()).length, 1, "one deletion commit");
  assert.equal((await doc("ratings/r1.json")).deleted, true);
  assert.doesNotMatch(await fMsg(), /другом устройстве/, "my own extra tap is reported as another device");
});

test("an accidental double tap on «Удалить оценку» only asks for confirmation and deletes nothing", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await openEdit("porto");
  const r = await page.locate({ sel: "#fDelete" });
  await page.click(r.x, r.y);
  await sleep(90);
  await page.click(r.x, r.y);
  await sleep(1200);
  assert.equal((await commits()).length, 0, "a double tap passed the «Точно удалить?» step and the rating was deleted");
  assert.equal((await doc("ratings/r1.json")).deleted, false);
});

test("three quick taps on «Сохранить карточку» on a slow network write the card once", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await knob("mock:delay", "900");
  await press("#placeForm [type=submit]", 30);
  const r = await page.locate({ sel: "#placeForm [type=submit]" });
  await page.click(r.x, r.y); await sleep(40);
  await page.click(r.x, r.y);
  await page.waitFor(`document.getElementById("placeMsg") && /сохранена/.test(document.getElementById("placeMsg").innerText)`, 8000, "saved");
  await sleep(1200);
  await knob("mock:delay", null);
  assert.equal((await commits()).length, 1);
  assert.equal((await doc("places/porto.json")).archetype, "город у океана");
});

test("two quick taps on «Добавить как место» on a slow network add the place once", { skip }, async () => {
  await open({ hash: "#/map" });
  await typeSearch("Будва");
  await page.tap({ text: "Будва", within: "#searchResults" });
  await page.waitFor(`document.querySelector('#sheet [data-act="addcity"]')`, 4000, "city sheet");
  await knob("mock:delay", "900");
  const r = await page.locate({ sel: '#sheet [data-act="addcity"]' });
  await page.click(r.x, r.y); await sleep(40);
  await page.click(r.x, r.y);
  assert.match(await toastText(/Добавлено/), /Будва/);
  await sleep(600);
  await knob("mock:delay", null);
  assert.deepEqual(Object.keys(await files()).filter(k => /budva/.test(k)), ["places/budva.json"]);
  assert.equal((await commits()).length, 1);
});

test("two quick taps on «Сохранить и проверить» check and save the key once", { skip }, async () => {
  await open({ hash: "#/settings", token: false });
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_twice");
  await knob("mock:delay", "600");
  await page.eval(`window.__c2calls.length = 0`);
  const r = await page.locate({ text: "Сохранить и проверить" });
  await page.click(r.x, r.y); await sleep(40);
  await page.click(r.x, r.y);
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 8000, "connected");
  await sleep(800);
  await knob("mock:delay", null);
  const calls = await page.eval(`window.__c2calls.filter(c => c.startsWith("/graphql"))`);
  assert.ok(calls.length <= 2, `the key was checked and the data loaded ${calls.length} times`);
  assert.match(await page.text("#tokenMsg"), /Подключено/);
});

test("two quick taps on «Записать мою» write my unsent version once", { skip }, async () => {
  const porto = PLACES.find(p => p.id === "porto");
  const lost = [{ at: T, path: "places/porto.json", content: JSON.stringify(Object.assign({}, porto, { questions: "Мой вопрос с телефона" }), null, 1) + "\n", baseOid: "old", message: "Update place porto" }];
  await open({ hash: "#/rank", local: { "wtl:lost": lost } });
  await knob("mock:delay", "800");
  const r = await page.locate({ text: "Записать мою" });
  await page.click(r.x, r.y); await sleep(40);
  await page.click(r.x, r.y);
  await toastText(/Записано/);
  await sleep(600);
  await knob("mock:delay", null);
  assert.equal((await commits()).length, 1);
  assert.equal((await doc("places/porto.json")).questions, "Мой вопрос с телефона");
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("wtl:lost") || "[]")`), []);
});

/* =================== leaving mid-save =================== */

test("going back while a rating save fails keeps the answers in «Оценить» and a toast says where they are", { skip }, async () => {
  await open({ hash: "#/place/batumi" });
  await go("#/rate/new/batumi", 400);
  await score("интернет", 4);
  await rules([Object.assign({ delay: 1000 }, { url: GH, body: COMMIT, status: 403, json: { message: "Resource not accessible by personal access token" } })]);
  await press("#fSave", 30);
  await page.eval("history.back()");
  await page.waitFor(`location.hash === "#/place/batumi"`, 3000, "back in the dossier");
  const t = await toastText(/не сохранена/);
  assert.match(t, /Оценить/);
  await go("#/rate", 400);
  assert.equal(await qval("интернет"), "4");
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi");
});

test("reloading while a save still waits for GitHub keeps the answers as a draft", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Перезагрузил посреди сохранения");
  await sleep(400);
  await rules([{ url: GH, body: COMMIT, hang: true }]);
  await press("#fSave", 60);
  await rules([]);
  await reload();
  await go("#/rate", 400);
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi");
  assert.equal(await qval("интернет"), "4");
  assert.equal(await val("#fReview"), "Перезагрузил посреди сохранения");
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/batumi"`, 6000, "saved after the reload");
  assert.equal((await ratingsOn("batumi")).length, 1);
});

test("closing the map card while a place is being added still adds it exactly once and says so", { skip }, async () => {
  await open({ hash: "#/map" });
  await typeSearch("Будва");
  await page.tap({ text: "Будва", within: "#searchResults" });
  await page.waitFor(`document.querySelector('#sheet [data-act="addcity"]')`, 4000, "city sheet");
  await knob("mock:delay", "900");
  await page.tap({ text: "Добавить как место", within: "#sheet" }, 30);
  await page.tap({ sel: "#sheetClose" }, 30);
  assert.match(await toastText(/Добавлено/), /Будва/);
  await knob("mock:delay", null);
  assert.equal((await commits()).length, 1);
  assert.ok(await doc("places/budva.json"));
  assert.deepEqual(page.takeErrors(), []);
});

/* =================== storage full or blocked =================== */

test("when the phone's storage is full, an offline save does not promise the rating is kept on the device and then lose it", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Сохранил без места в памяти");
  await sleep(400);
  await knob("c2:quota", "^wtl:pending$");
  await knob("mock:offline", "1");
  await press("#fSave");
  await page.waitFor(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText.trim() !== ""`, 6000, "save result");
  const said = [(await toasts()).join(" | "), await fMsg()].join(" | ");
  await knob("c2:quota", null);
  await reload();
  const survived = (await pending()).length === 1 || (await page.eval(`JSON.stringify(JSON.parse(localStorage.getItem("wtl:draft") || "{}"))`)).includes("Сохранил без места");
  await knob("mock:offline", null);
  assert.ok(survived || /памят|переполн|места на устройстве|не удалось сохранить на/i.test(said),
    `the app said «${said}», but after a restart the rating is gone: neither queued nor kept as a draft`);
});

test("when the phone's storage is full, the rating form warns that answers will not survive closing the app", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await knob("c2:quota", "^wtl:(draft|drafts)$");
  await score("интернет", 4);
  await page.fill("#fReview", "Черновик без места в памяти");
  await sleep(800);
  const shown = await page.eval(`["fTop", "rateBanner", "fMsg"].map(id => (document.getElementById(id) || {}).innerText || "").concat(window.__toasts || []).join(" | ")`);
  await knob("c2:quota", null);
  assert.match(shown, /памят[ьи] (телефона|браузера|устройства)|переполн|не сохраня[её]тся|места на (устройстве|телефоне)/i, `the draft silently stopped being saved on the phone; the form says only «${shown}»`);
});

test("when the browser blocks site storage, saving a key explains why the device cannot stay connected instead of doing nothing", { skip }, async () => {
  await open({ hash: "#/settings", token: false });
  await knob("c2:nols", "1");
  await reload();
  await go("#/settings", 400);
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_e2e");
  await page.tap({ text: "Сохранить и проверить" });
  await sleep(1500);
  const msg = await page.text("#tokenMsg"), said = (await toasts()).join(" | ");
  const status = await syncText();
  await knob("c2:nols", null);
  assert.ok(msg.trim() || said.trim(), `after «Сохранить и проверить» nothing is said at all and the status stays «${status}»`);
  assert.match(msg + " " + said, /памят|хранилищ|сохранить ключ|частн|блокир|настройк.*браузер/i, `«${msg}» «${said}»`);
});

test("when the browser blocks site storage the map, ranking, rate form and settings still open without errors", { skip }, async () => {
  await open({ hash: "#/map", token: false });
  await knob("c2:nols", "1");
  await reload();
  for (const h of ["#/map", "#/rank", "#/places", "#/rate", "#/settings"]) {
    await go(h, 400);
    assert.ok((await page.eval(`document.querySelector(".view:not([hidden])").innerText.trim().length`)) > 20, h + " is blank");
  }
  const errs = page.takeErrors();
  await knob("c2:nols", null);
  assert.deepEqual(errs, []);
});

test("checking a new key while GitHub is down, sends a web page or is rate-limited does not call the key wrong", { skip }, async () => {
  const cases = [
    ["GitHub down", { url: GH, status: 502, text: "<html>Bad Gateway</html>", type: HTML }],
    ["web page", { url: GH, status: 200, text: "<html>Войдите в сеть</html>", type: HTML }],
    ["rate limit", limited(600)],
  ];
  for (const [what, rule] of cases) {
    await open({ hash: "#/settings", token: false });
    await rules([rule]);
    await page.fill('#tokenForm [name="token"]', "github_pat_TEST_e2e");
    await page.tap({ text: "Сохранить и проверить" });
    await page.waitFor(`!/Проверяю/.test(document.getElementById("tokenMsg").innerText) && document.getElementById("tokenMsg").innerText.trim()`, 6000, what + ": check result");
    const m = await page.text("#tokenMsg");
    assert.doesNotMatch(m, /Ключ не подошёл/, `${what}: the key was never really checked, yet the user is told it is wrong and will go make a new one: «${m}»`);
    assert.match(m, /GitHub/, `${what}: «${m}»`);
    assert.match(m, /позже|ещё раз|попроб/i, `${what}: «${m}»`);
    plain(m, what);
  }
});

/* =================== OpenStreetMap search =================== */

test("an OpenStreetMap search refused with 503 or 429 says to try again later, without the code", { skip }, async () => {
  for (const status of [503, 429]) {
    await open({ hash: "#/map", local: { "c2:rules": [{ url: "nominatim.openstreetmap.org/search", status, text: "<html>busy</html>", type: HTML }] } });
    await searchEverywhere("Херцег");
    await page.waitFor(`!/Ищу в OpenStreetMap/.test(document.getElementById("searchResults").innerText)`, 6000, "search answered");
    const t = await results();
    const note = await page.eval(`document.querySelector("#searchResults .note")?.innerText || ""`);
    assert.match(note, /недоступ|не отвеча|занят/i, `${status}: «${t}»`);
    assert.match(note, /позже|ещё раз|попроб|минут/i, `${status}: no next step in «${note}»`);
    plain(note, `search note on ${status}`);
  }
});

test("an OpenStreetMap search answered with a web page is explained in Russian", { skip }, async () => {
  await open({ hash: "#/map", local: { "c2:rules": [{ url: "nominatim.openstreetmap.org/search", status: 200, text: "<html><body>Access denied</body></html>", type: HTML }] } });
  await searchEverywhere("Херцег");
  await page.waitFor(`!/Ищу в OpenStreetMap/.test(document.getElementById("searchResults").innerText)`, 6000, "search answered");
  const note = await page.eval(`document.querySelector("#searchResults .note")?.innerText || ""`);
  plain(note, "search note");
  assert.deepEqual(page.takeErrors(), []);
});

test("after a failed OpenStreetMap search, pressing Enter again searches again and shows what it found", { skip }, async () => {
  await open({ hash: "#/map", local: { "c2:rules": [{ url: "nominatim.openstreetmap.org/search", net: true, times: 1 }] } });
  await searchEverywhere("Бар");
  await page.waitFor(`/Нет связи|недоступ/.test(document.getElementById("searchResults").innerText)`, 6000, "failure shown");
  await page.tap({ sel: "#searchInput" });
  await page.key("Enter");
  await page.waitFor(`/Бар, Черногория|Черногория/.test(document.getElementById("searchResults").innerText) && !/Ищу в/.test(document.getElementById("searchResults").innerText)`, 6000, "results on retry");
  assert.doesNotMatch(await results(), /Нет связи/);
});

test("a slow OpenStreetMap search says it is searching while it waits", { skip }, async () => {
  await open({ hash: "#/map", local: { "c2:rules": [{ url: "nominatim.openstreetmap.org/search", delay: 2500, status: 200, json: [] }] } });
  await searchEverywhere("Херцег");
  await sleep(600);
  assert.match(await results(), /Ищу в OpenStreetMap/);
  await page.waitFor(`!/Ищу в OpenStreetMap/.test(document.getElementById("searchResults").innerText)`, 6000, "answered");
  assert.match(await results(), /Ничего не нашлось|уже есть/);
});

/* =================== world data files =================== */

const NO_COUNTRIES = [
  { url: "data/world/indicators.json", status: 404, text: "not found", type: "text/plain" },
  { url: "data/world/countries.geojson", status: 404, text: "not found", type: "text/plain" },
];

test("when the country indicators fail to load, the dossier says country data did not load instead of silently leaving it out", { skip }, async () => {
  await open({ hash: "#/place/porto", local: { "c2:rules": NO_COUNTRIES } });
  await page.waitFor(`document.querySelector("#v-place .world")`, 4000, "world block");
  const w = await page.text("#v-place .world");
  assert.match(w, /Январь|°C/, "city climate still shown");
  const all = await page.text("#v-place");
  assert.match(all, /не загрузил|не удалось загрузить|недоступн/i, "country indicators are missing from the dossier and the total without a word");
});

test("when the country borders and indicators fail to load, the map says what is missing", { skip }, async () => {
  await open({ hash: "#/map", local: { "c2:rules": NO_COUNTRIES } });
  await sleep(400);
  await page.tap({ sel: "#layersBtn" });
  const shown = await page.eval(`[document.getElementById("mapNote"), document.getElementById("legendBox"), document.getElementById("layersPanel"), document.getElementById("toast")].filter(e => e && !e.hidden).map(e => e.innerText).join(" | ")`);
  assert.match(shown, /не загрузил|не удалось загрузить|недоступн/i, `tapping a country does nothing and «Раскраска стран» is empty, with no explanation: «${shown.slice(0, 300)}»`);
  assert.deepEqual(page.takeErrors(), []);
});

test("when the cities file fails to load, «Похожие» in the dossier says the city data did not load, not «мало данных»", { skip }, async () => {
  await open({ hash: "#/place/porto", local: { "c2:rules": [{ url: "data/world/cities.json", status: 503, text: "x", type: "text/plain" }] } });
  await page.waitFor(`document.getElementById("simBox") && document.getElementById("simBox").innerText.trim() && !/Ищу|Считаю/.test(document.getElementById("simBox").innerText)`, 5000, "similar block");
  const s = await page.text("#simBox");
  assert.doesNotMatch(s, /мало данных/i, `it is not a lack of data, the file did not load: «${s}»`);
  assert.match(s, /не загрузил|не удалось загрузить|недоступн/i, `«${s}»`);
});

test("with every world file failing, all screens still open without errors and our ratings still count", { skip }, async () => {
  await open({ hash: "#/rank", local: { "c2:rules": NO_COUNTRIES.concat([{ url: "data/world/cities.json", status: 404, text: "x", type: "text/plain" }]) } });
  assert.match(await page.text("#rank"), /Порту|Валенсия|Тбилиси/);
  for (const h of ["#/map", "#/places", "#/place/porto", "#/place/sankt-peterburg", "#/rate/new/porto", "#/settings"]) {
    await go(h, 500);
    assert.ok((await page.eval(`document.querySelector(".view:not([hidden])").innerText.trim().length`)) > 20, h + " is blank");
  }
  await go("#/place/porto", 600);
  assert.match(await page.text("#v-place"), /Красиво, но сыро/);
  assert.deepEqual(page.takeErrors(), []);
});

/* =================== broken files in the data repo =================== */

test("a broken rating file is named, counted as one rating, and the place still shows its other rating", { skip }, async () => {
  const f = repo();
  f["ratings/r2.json"] = f["ratings/r2.json"].slice(0, 60);
  await open({ hash: "#/place/porto", files: f });
  const b = (await banners()).find(x => /r2\.json/.test(x)) || "";
  assert.ok(b, "the broken file is not named");
  assert.match(b, /одна оценка/i, `«${b}»`);
  assert.match(b, /исправ|Claude/i, `«${b}»`);
  assert.match(await page.text("#v-place"), /Красиво, но сыро/, "Михаил's rating of Porto is still there");
  assert.deepEqual(page.takeErrors(), []);
});

test("rating files that are valid JSON but not a rating (a number, null, text, a list) are all named in the notice and break nothing", { skip }, async () => {
  const f = repo();
  f["ratings/zz-num.json"] = "42\n";
  f["ratings/zz-null.json"] = "null\n";
  f["ratings/zz-str.json"] = '"hello"\n';
  f["ratings/zz-list.json"] = "[]\n";
  await open({ hash: "#/rank", files: f });
  const b = (await banners()).find(x => /zz-/.test(x)) || "";
  for (const name of ["zz-num", "zz-null", "zz-str", "zz-list"]) assert.match(b, new RegExp(name), `${name}.json is broken but not named: «${b}»`);
  assert.match(await page.text("#rank"), /Порту/);
  for (const h of ["#/map", "#/places", "#/place/porto"]) await go(h, 400);
  assert.deepEqual(page.takeErrors(), []);
});

/* =================== looks: error states at desktop width and in dark mode =================== */

test("at desktop width in dark mode the error banner and a failed save are readable and nothing scrolls sideways", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" }, { w: 1280, h: 800, dark: true });
  await score("интернет", 4);
  await rules([{ url: GH, body: COMMIT, status: 403, json: { message: "Resource not accessible by personal access token" } }]);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText.trim() !== ""`, 6000, "save result");
  await page.shot("c2-errors-desktop-dark");
  const r = await page.eval(`(() => {
    const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bg = e => { for (; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\\(.*, 0\\)|transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
    const ratio = e => { const a = lum(getComputedStyle(e).color), b = lum(bg(e)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const ban = document.querySelector("#rateBanner .banner.err");
    return { msg: ratio(document.getElementById("fMsg")), ban: ban ? ratio(ban) : 99, sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth };
  })()`);
  assert.ok(r.msg >= 4.5, `error under the button: contrast ${r.msg.toFixed(2)}`);
  assert.ok(r.ban >= 4.5, `error banner: contrast ${r.ban.toFixed(2)}`);
  assert.ok(r.sw <= r.w, `page scrolls sideways (${r.sw} > ${r.w})`);
});
