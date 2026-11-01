import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp } from "./fixtures.mjs";

// Cycle 3b leftovers in the app (A1–A15): drafts on a shared phone, tap targets and wording in the dossier, the save bar
// rule, GitHub's rate limit with an empty queue, queue and limit messages, the interrupted-save notice, touch tooltips,
// the on-screen keyboard, and a device that does not know who is using it. Synthetic data only; GitHub is mocked.

const skip = !CHROME && "no Chrome";
let srv, page;

// Minimal fault injection on top of the shared mock: rules in localStorage "c3b:rules" answer matching GitHub requests
// (URL part and optional Authorization part) with a status, a JSON body and headers; every GitHub request is logged in
// "c3b:calls".
const FAULT = `(() => {
  if (location.hostname !== "127.0.0.1") return;
  const ls = window.localStorage, get0 = Storage.prototype.getItem, set0 = Storage.prototype.setItem;
  const inner = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || "");
    if (url.startsWith("https://api.github.com/")) { const l = JSON.parse(get0.call(ls, "c3b:calls") || "[]"); l.push(url.replace("https://api.github.com", "")); set0.call(ls, "c3b:calls", JSON.stringify(l)); }
    let rules = [];
    try { rules = JSON.parse(get0.call(ls, "c3b:rules") || "[]"); } catch (e) {}
    const r = rules.find(x => url.includes(x.url) && (!x.auth || auth.includes(x.auth)));
    if (!r) return inner(input, init);
    return new Response(JSON.stringify(r.json || {}), { status: r.status || 200, headers: Object.assign({ "Content-Type": "application/json" }, r.headers || {}) });
  };
})();`;

before(async () => { srv = await serve(); page = await launch(); await page.send("Page.addScriptToEvaluateOnNewDocument", { source: FAULT }); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = JSON.stringify;
const APP = `(await import("./js/app.js")).state`;

async function open(opts = {}) {
  await page.viewport(390, 844);
  await openApp(page, srv.url, opts);
  await sleep(250);
  page.takeErrors();
}
async function relaunch(hash) {
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.goto(srv.url + hash, 100);
}
const booted = () => page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app booted");
const go = async (h, settle = 400) => { await page.eval(`location.hash = ${js(h)}`); await sleep(settle); };
async function press(sel, settle = 200) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const val = sel => page.eval(`document.querySelector(${js(sel)}).value`);
const syncText = () => page.text("#syncText");
const rules = list => page.eval(`localStorage.setItem("c3b:rules", ${js(js(list))})`);
const calls = () => page.eval(`JSON.parse(localStorage.getItem("c3b:calls") || "[]")`);
const clearCalls = () => page.eval(`localStorage.setItem("c3b:calls", "[]")`);
const banners = () => page.eval(`[...document.querySelectorAll(".view:not([hidden]) .banner")].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const hhmm = sec => page.eval(`new Date(${sec} * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })`);
const limitRule = reset => ({ url: "https://api.github.com/", status: 403, json: { message: "API rate limit exceeded for user ID 1." }, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
const toastNow = (re = /./, timeout = 6000) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, timeout, "toast " + re);
// at most one dash per sentence, and no comma between «сам» and «после этого времени»
function plainQueue(text, what) {
  const t = oneLine(text);
  assert.ok(t, `${what}: nothing is said`);
  for (const s of t.split(/(?<=[.!?])\s+/)) assert.ok((s.match(/ — /g) || []).length <= 1, `${what}: two dashes in one sentence: «${s}»`);
  assert.doesNotMatch(t, /сам, после/, `${what}: stray comma: «${t}»`);
}
async function saveCard(field, value) {
  await page.fill(`#placeForm [name="${field}"]`, value);
  await press("#placeForm [type=submit]");
  await page.waitFor(`document.getElementById("placeMsg") && document.getElementById("placeMsg").innerText.trim() !== ""`, 8000, "card save result");
  await sleep(200);
}
const draftOf = (who, place, scores, review, extra = {}) => Object.assign({ id: null, createdAt: null, who, place, start: "", end: "", season: "", mode: "", housing: "", retro: false, year: null, veto: "", review, surprises: "", questions: "", scores, conf: {}, notes: {}, draftId: null, stamp: null, _oid: null }, extra);

/* ======================= A1: drafts on a shared phone ======================= */

test("A1: Вика's unsaved draft does not open in Михаил's form when he switches «Кто я» before opening «Оценить»", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", me: "Вика" });
  await score("интернет", 4);
  await page.fill("#fReview", "ЧЕРНОВИК-ВИКИ");
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes("ЧЕРНОВИК-ВИКИ")`, 3000, "her draft saved on the phone");
  await relaunch("#/settings");
  await booted();
  await page.tap({ text: "Михаил", within: "#meSeg" });
  await go("#/rate");
  assert.notEqual(await val("#fReview"), "ЧЕРНОВИК-ВИКИ", "Михаил sees Вика's answers in his form");
  assert.match(await page.text("#fCounts"), /★ 0 из 10/, "her scores are in his form");
  assert.doesNotMatch(await page.text("#fTop"), /Батуми/, "her draft is offered in his «Несохранённые черновики»");
  await go("#/settings");
  await page.tap({ text: "Вика", within: "#meSeg" });
  await go("#/rate/new/batumi");
  assert.equal(await val("#fReview"), "ЧЕРНОВИК-ВИКИ", "her draft is lost once «Кто я» is back on Вика");
  assert.deepEqual(page.takeErrors(), []);
});

test("A1: a rating Михаил fills in for Вика on his own phone stays in his draft list", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await press('#fWho [data-who="Вика"]');
  await score("интернет", 4);
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes("интернет")`, 3000, "draft saved");
  await go("#/rate/new/porto");
  const top = oneLine(await page.text("#fTop"));
  assert.match(top, /Несохранённые черновики/, `the draft he wrote for Вика disappeared from his list: «${top}»`);
  assert.match(top, /Батуми/, `«${top}»`);
  await relaunch("#/rate");
  await booted();
  assert.match(oneLine(await page.text("#fTop")), /Батуми/, "after reopening the app his draft for Вика is hidden from him");
});

test("A1: «Новая оценка» in an edit does not pick up the partner's unsaved new rating", { skip }, async () => {
  await open({ hash: "#/place/valensiya", local: { "wtl:drafts": { _new: draftOf("Вика", "", { "интернет": 4, "улица": 3 }, "ЧУЖОЙ-НОВЫЙ") } } });
  await page.tap({ text: "Изменить", within: "#v-place .trips" });
  await page.waitFor(`document.querySelector(".edit-head") && !document.getElementById("fDelete").hidden`, 4000, "edit form");
  await press("#fNew");
  assert.notEqual(await val("#fReview"), "ЧУЖОЙ-НОВЫЙ", "«Новая оценка» opened Вика's unsaved draft");
  assert.match(await page.text("#fCounts"), /★ 0 из 10/);
});

/* ======================= A2–A4: dossier ======================= */

test("A2: «Показать всё равно» is at least 40 px tall on a phone and does not push the text around it", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  const m = await page.eval(`(() => {
    const b = document.querySelector("#v-place .panel.pad [data-reveal]"), p = b.closest("p");
    const h = b.getBoundingClientRect().height;
    const c = p.cloneNode(true), cb = c.querySelector("[data-reveal]"), s = document.createElement("span");
    s.textContent = cb.textContent; cb.replaceWith(s); p.after(c);
    const ph = p.getBoundingClientRect().height, ch = c.getBoundingClientRect().height;
    c.remove();
    return { h, ph, ch };
  })()`);
  assert.ok(m.h >= 40, `«Показать всё равно» is only ${Math.round(m.h)} px tall`);
  assert.ok(Math.abs(m.ph - m.ch) <= 2, `the bigger button changes the paragraph height: ${m.ph} vs ${m.ch} px of the same text`);
  assert.ok(await page.locate({ text: "Показать всё равно", within: "#v-place .panel.pad" }).then(r => !r.error && !r.covered));
  await page.shot("c3b-reveal-tap-target");
});

test("A3: a trip card in the dossier says in words what the ★ count is", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const t = oneLine(await page.text("#v-place .trips"));
  assert.doesNotMatch(t, /★ заполнено/, `«${t}»`);
  assert.match(t, /главн\S* вопрос\S* ★: 4 из 10/, `«${t}»`);
});

test("A4: the trips of a place only the partner rated say once that her rating is hidden", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  const lines = await page.eval(`[...document.querySelectorAll("#v-place .trips p, #v-place .trips .trip")].map(e => e.innerText.trim()).filter(t => /скрыт|Ваших оценок/.test(t))`);
  assert.equal(lines.length, 1, `said ${lines.length} times: ${lines.join(" | ")}`);
  assert.match(lines[0], /Вика: оценка скрыта/);
});

/* ======================= A5: the save bar rule ======================= */

test("A5: the save bar says, at any count, how many main answers the place needs for the ranking, counting both of us", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  assert.equal(await page.text("#fCounts"), "главные ★ 0 из 10 · для рейтинга нужно 5", "nothing is said at zero answers");
  for (const [k, v] of [["интернет", 4], ["улица", 4], ["шум", 3]]) await score(k, v);
  assert.equal(await page.text("#fCounts"), "главные ★ 3 из 10 · для рейтинга нужно 5");
  for (const [k, v] of [["пешком", 4], ["чистота", 4]]) await score(k, v);
  assert.equal(await page.text("#fCounts"), "главные ★ 5 из 10 · для рейтинга хватает");
  await go("#/rate/new/porto");
  assert.equal(await page.text("#fCounts"), "главные ★ 0 из 10 · для рейтинга нужно 5, у места уже 4", "Порту already has 4 main answers from both of us; the bar ignores them");
  await score("шум", 3);
  assert.equal(await page.text("#fCounts"), "главные ★ 1 из 10 · для рейтинга хватает");
  await go("#/rate/new/tbilisi");
  assert.equal(await page.text("#fCounts"), "главные ★ 0 из 10 · для рейтинга нужно 5", "Вика's hidden answers on Тбилиси must not leak into the counter");
  assert.match(await page.eval(`document.getElementById("fCounts").title`), /рейтинг/);
});

/* ======================= A6: rate limit with an empty queue ======================= */

test("A6: a rate limit met by the background check with nothing queued shows GitHub's time, no «ждут», and stops asking GitHub", { skip }, async () => {
  await open({ hash: "#/rank" });
  const reset = Math.floor(Date.now() / 1000) + 1800, at = await hhmm(reset);
  await rules([limitRule(reset)]);
  await comeBack();
  await page.waitFor(`/Лимит/.test(document.getElementById("syncText").innerText)`, 5000, "the limit in the status").catch(() => {});
  const s = await syncText();
  assert.match(s, /Лимит GitHub/, `the background check swallowed the rate limit; the status says «${s}»`);
  assert.ok(s.includes(at), `the status does not say until when: «${s}»`);
  assert.doesNotMatch(s, /ждут/i, `nothing is queued: «${s}»`);
  const b = (await banners()).find(x => /GitHub/.test(x)) || "";
  assert.ok(b.includes(at), `the banner does not give GitHub's time: «${b}»`);
  assert.doesNotMatch(b, /ждут|в очереди/i, `nothing is queued: «${b}»`);
  plainQueue(b, "limit banner");
  await clearCalls();
  await comeBack();
  await page.eval(`window.dispatchEvent(new Event("online"))`);
  await page.idle(300);
  await page.tap({ sel: "#syncBtn" });
  assert.match(await toastNow(/ограничил/), /ограничил запросы до \d\d:\d\d/);
  await page.idle(300);
  assert.deepEqual(await calls(), [], "requests sent while GitHub still refuses them");
});

test("A6: a rate-limited refresh with nothing queued is remembered: a second tap on the status does not ask GitHub again", { skip }, async () => {
  await open({ hash: "#/rank" });
  const reset = Math.floor(Date.now() / 1000) + 1800, at = await hhmm(reset);
  await rules([limitRule(reset)]);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`!["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 6000, "refresh done");
  const s = await syncText();
  assert.match(s, /Лимит GitHub/, `the status says «${s}» during a rate limit`);
  assert.ok(s.includes(at), `«${s}»`);
  await clearCalls();
  await page.idle(300);
  await page.tap({ sel: "#syncBtn" });
  await page.idle(300);
  assert.deepEqual(await calls(), [], "every tap knocks on GitHub during the limit");
});

/* ======================= A7, A9: queue and limit wording ======================= */

test("A7: with one change queued offline the banner speaks of one change in the singular, and of two in the plural", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await saveCard("archetype", "город у океана");
  await page.eval(`window.dispatchEvent(new Event("online"))`);
  await page.waitFor(`/^Нет связи/.test(document.getElementById("syncText").innerText)`, 6000, "offline status");
  await go("#/rank");
  const one = (await banners()).find(x => /Нет связи/.test(x)) || "";
  assert.match(one, /: 1 правка — отправлю сам, когда появится связь\./, `«${one}»`);
  plainQueue(one, "offline banner");
  await go("#/place/valensiya");
  await saveCard("archetype", "город у залива");
  await page.eval(`window.dispatchEvent(new Event("online"))`);
  await page.waitFor(`document.getElementById("syncText").innerText === "Нет связи · в очереди: 2"`, 6000, "two changes queued offline");
  await go("#/rank");
  const two = (await banners()).find(x => /Нет связи/.test(x)) || "";
  assert.match(two, /: 2 правки — отправлю сам, когда появится связь\./, `«${two}»`);
});

test("A7: with one change queued under a refused key the banner uses the singular", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await rules([{ url: "https://api.github.com/", auth: "TEST_e2e", status: 401, json: { message: "Bad credentials" } }]);
  await saveCard("archetype", "город у океана");
  await go("#/rank");
  const b = (await banners()).find(x => /Ключ/.test(x)) || "";
  for (const re of [/\b1 правка(?![а-яё])/, /не потеряется/, /отправится/, /ключ/]) assert.match(b, re, `«${b}»`);
});

test("A9: under a rate limit every queued message reads as plain Russian with one dash and names the change", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const reset = Math.floor(Date.now() / 1000) + 1800, at = await hhmm(reset);
  await rules([limitRule(reset)]);
  await saveCard("archetype", "город у океана");
  const msg = await page.text("#placeMsg");
  assert.ok(msg.includes(at), `«${msg}»`);
  plainQueue(msg, "card save message");
  await go("#/rank");
  const b = (await banners()).find(x => /GitHub/.test(x)) || "";
  assert.ok(b.includes(at), `«${b}»`);
  assert.match(b, /1 правка/, `the banner does not name the queued change: «${b}»`);
  plainQueue(b, "limit banner with a queue");
  await page.tap({ sel: "#syncBtn" });
  const t = await toastNow(/ограничил/);
  assert.match(t, /1 правка/, `the status tap toast has no noun: «${t}»`);
  plainQueue(t, "status tap toast");
  await go("#/settings");
  const st = await page.text("#tokenMsg");
  assert.match(st, /1 правка/, `settings: «${st}»`);
  plainQueue(st, "settings status");
});

/* ======================= A8: settings ======================= */

test("A8: settings say that offline only the map background and the place search stop working", { skip }, async () => {
  await open({ hash: "#/settings" });
  const t = oneLine(await page.text("#v-settings"));
  assert.doesNotMatch(t, /Карта и поиск мест без интернета не работают/, "offline the map shows the saved copy, yet settings say it does not work");
  assert.match(t, /Без интернета не работают подложка карты и поиск мест/);
});

/* ======================= A10: interrupted save ======================= */

async function cutRating(extra) {
  const stamp = new Date().toISOString();
  await page.eval(`(() => {
    const f = JSON.parse(localStorage.getItem("mock:files"));
    f["ratings/r-cut.json"] = JSON.stringify({ id: "r-cut", place: "batumi", who: "Михаил", start: null, end: null, days: null, season: "", mode: "", housing: "", retro: false, year: 6, veto: "", review: "", scores: { "интернет": 4 }, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: ${js(stamp)}, updatedAt: ${js(stamp)} }, null, 1) + "\\n";
    localStorage.setItem("mock:files", JSON.stringify(f));
    localStorage.setItem("mock:head", "h9");
    localStorage.setItem("wtl:saving", JSON.stringify({ id: "r-cut", place: "batumi", stamp: ${js(stamp)}, edit: false }));
    ${extra}
  })()`);
}

test("A10: a rating that reached GitHub just before the app closed is not reported as unsaved while the first refresh loads", { skip }, async () => {
  await open({ hash: "#/rank" });
  await cutRating(`localStorage.setItem("mock:delay", "3000");`);
  try {
    await relaunch("#/rank");
    await page.waitFor(`["…", "Обновляю…"].includes(document.getElementById("syncText").innerText) && !document.getElementById("v-rank").hidden && document.querySelector("#v-rank h1")`, 5000, "ranking drawn before the first refresh is done");
    const early = oneLine(await page.text("#v-rank"));
    assert.doesNotMatch(early, /не успела сохраниться/, "the cached copy predates the save, so the app claims a saved rating was lost");
    await booted();
    assert.doesNotMatch(oneLine(await page.text("#v-rank")), /не успела сохраниться|не знаю, дошла/);
  } finally { await page.eval(`localStorage.removeItem("mock:delay")`); }
});

test("A10: offline, the interrupted-save notice says honestly that it is not known whether the rating got through", { skip }, async () => {
  await open({ hash: "#/rank" });
  await cutRating(`localStorage.setItem("mock:offline", "1");`);
  await relaunch("#/rank");
  await page.waitFor(`/^Нет связи/.test(document.getElementById("syncText").innerText)`, 8000, "offline status");
  const b = (await banners()).find(x => /Батуми/.test(x)) || "";
  assert.match(b, /не знаю, дошла ли/i, `«${b}»`);
  assert.match(b, /появится связь/, `«${b}»`);
  assert.doesNotMatch(b, /не успела сохраниться/, `offline the app cannot know that: «${b}»`);
  assert.equal(await page.eval(`(document.querySelector("#v-rank .banner a[href^='#/rate']") || {}).hash`), "#/rate/new/batumi");
});

/* ======================= A11: touch tooltips ======================= */

test("A11: a tap with a slight finger jitter keeps the tooltip it just opened; a real drag hides it", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.eval(`document.querySelector("#rank .bar[data-tip]").scrollIntoView({ block: "center" })`);
  await sleep(300);
  const fire = (type, dx, dy) => page.eval(`(() => {
    const e = document.querySelector("#rank .bar[data-tip]"), r = e.getBoundingClientRect();
    e.dispatchEvent(new PointerEvent(${js(type)}, { bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 7, clientX: r.left + r.width / 2 + ${dx}, clientY: r.top + r.height / 2 + ${dy} }));
  })()`);
  await fire("pointerdown", 0, 0);
  assert.equal(await page.eval(`document.getElementById("tip").hidden`), false, "fixture: the press opens the tooltip");
  await fire("pointermove", 3, 2);
  assert.equal(await page.eval(`document.getElementById("tip").hidden`), false, "a 3 px jitter hid the tooltip the same press opened");
  assert.match(await page.text("#tip"), /Итог/);
  await fire("pointermove", 30, 0);
  assert.equal(await page.eval(`document.getElementById("tip").hidden`), true, "a real finger move must still hide the tooltip");
});

/* ======================= A12: on-screen keyboard ======================= */

const spyScroll = () => page.eval(`(() => { window.__siv = []; if (window.__sivOn) return; window.__sivOn = true; const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { window.__siv.push(this.id || this.className || this.tagName); return o.apply(this, a); }; })()`);
const keyboard = async on => { await page.viewport(390, on ? 480 : 844); await sleep(400); };

test("A12: typing in the map search does not switch the app into typing mode or scroll the fixed search box", { skip }, async () => {
  await open({ hash: "#/map" });
  try {
    await spyScroll();
    await page.eval(`document.getElementById("searchInput").focus()`);
    await sleep(200);
    await keyboard(true);
    assert.equal(await page.eval(`document.documentElement.classList.contains("typing")`), false, "the map search hides the tab bar");
    assert.ok(!(await page.eval(`window.__siv`)).includes("searchInput"), "scrollIntoView on the fixed map search");
  } finally { await keyboard(false); }
});

test("A12: with the keyboard open, moving to the next field centres it too", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  try {
    await spyScroll();
    await page.eval(`document.getElementById("fReview").focus()`);
    await sleep(200);
    await keyboard(true);
    assert.equal(await page.eval(`document.documentElement.classList.contains("typing")`), true, "fixture: typing mode is on");
    await page.eval(`window.__siv = []; document.getElementById("fSurprises").focus()`);
    await sleep(300);
    assert.ok((await page.eval(`window.__siv`)).includes("fSurprises"), "the next field is not centred above the keyboard");
  } finally { await keyboard(false); }
});

/* ======================= A13, A15: a device that does not know who is using it ======================= */

test("A13: without «Кто я» the dossier gives the real reason for hiding: nobody has chosen who they are", { skip }, async () => {
  await open({ hash: "#/place/tbilisi", me: "" });
  const t = oneLine(await page.text("#v-place"));
  assert.doesNotMatch(t, /до вашей оценки|пока вы не оцените/, `«${t.slice(0, 600)}»`);
  assert.match(t, /пока не выбрано, кто вы/);
  const titles = await page.eval(`[...document.querySelectorAll("#v-place [title]")].map(e => e.title).filter(x => /скрыто/.test(x))`);
  assert.ok(titles.length > 0, "fixture: hidden cells have a title");
  assert.deepEqual(titles.filter(x => /пока вы не оцените/.test(x)), [], "hidden cells blame my own missing rating");
});

async function mapCard(name, lat, lon) {
  await go("#/map");
  await page.waitFor(`(async () => { const s = ${APP}; return !!(s.mapView && s.mapView.map); })()`, 8000, "map");
  await page.eval(`(async () => { const s = ${APP}; s.mapView.map.setView([${lat}, ${lon}], 8, { animate: false }); })()`);
  await page.waitFor(`!!document.querySelector('.leaflet-marker-icon[title=${js(name)}]')`, 4000, "pin of " + name);
  await page.tap({ sel: `.leaflet-marker-icon[title="${name}"]` });
  await page.waitFor(`(() => { const h = document.querySelector("#sheetBody h3"); return !document.getElementById("sheet").hidden && h && h.innerText === ${js(name)}; })()`, 4000, "sheet of " + name);
  return oneLine(await page.text("#sheetBody"));
}

test("A15: without «Кто я», every screen that hides ratings shows the «Кто вы» buttons and says why in one line", { skip }, async () => {
  await open({ hash: "#/rank", me: "" });
  for (const [h, v] of [["#/rank", "v-rank"], ["#/places", "v-places"], ["#/place/tbilisi", "v-place"]]) {
    await go(h);
    assert.ok(await page.visible(`#${v} [data-setme]`), `${h}: no «Кто вы» buttons`);
    const t = oneLine(await page.text("#" + v));
    assert.doesNotMatch(t, /пока вы не оцени|Ждут вашей оценки|Ваших оценок/, `${h}: the reason given is my own missing rating: «${t.slice(0, 500)}»`);
    assert.match(t, /не выбрано/, `${h}: «${t.slice(0, 500)}»`);
  }
  const card = await mapCard("Тбилиси", 41.69411, 44.83368);
  assert.ok(await page.visible("#sheetBody [data-setme]"), "the map card hides her rating but offers no «Кто вы» buttons");
  assert.match(card, /пока не выбрано, кто вы/, `«${card}»`);
  assert.deepEqual(page.takeErrors(), []);
});
