import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, settleMap, PLACES } from "./fixtures.mjs";

// Cycle 3b repair: an offline save keeps «Нет связи», the place card on a phone held sideways, the «Слои» panel sideways,
// what a tap on the status says, the status name when GitHub is down, a first start offline, the offline banner with a
// queue, the update bar, shorter help texts, the hidden-rating wording, the year answers, the source hints of figures,
// the settings banner, the flags note, a draft for the partner, the veto in the save bar, a rate limit without a time and
// the interrupted-save notice. Synthetic data only; GitHub is mocked.

const skip = !CHROME && "no Chrome";
let srv, page;

// Fault injection on top of the shared mock: rules in localStorage "c3r:rules" answer matching GitHub requests with a
// status, a JSON body and headers.
const FAULT = `(() => {
  if (location.hostname !== "127.0.0.1") return;
  const ls = window.localStorage, get0 = Storage.prototype.getItem;
  const inner = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    let rules = [];
    try { rules = JSON.parse(get0.call(ls, "c3r:rules") || "[]"); } catch (e) {}
    const r = rules.find(x => url.includes(x.url));
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

async function open(opts = {}, [w, h] = [390, 844]) {
  await page.viewport(w, h);
  await openApp(page, srv.url, opts);
  await sleep(250);
  page.takeErrors();
}
async function relaunch(hash) {
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.goto(srv.url + hash, 100);
}
const settled = () => page.waitFor(`document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "status settled");
const go = async (h, settle = 400) => { await page.eval(`location.hash = ${js(h)}`); await sleep(settle); };
async function press(sel, settle = 200) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);
const syncText = () => page.text("#syncText");
const rules = list => page.eval(`localStorage.setItem("c3r:rules", ${js(js(list))})`);
const oneLine = s => String(s || "").replace(/\s+/g, " ").trim();
const banners = () => page.eval(`[...document.querySelectorAll(".view:not([hidden]) .banner")].map(b => b.innerText.replace(/\\s+/g, " ").trim())`);
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const toastNow = (re = /./, timeout = 6000) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, timeout, "toast " + re);
const rect = sel => page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e || e.closest("[hidden]")) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()`);
const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
// lines a visible element takes, by its height and line height
const linesOf = sel => page.eval(`[...document.querySelectorAll(${js(sel)})].filter(e => !e.closest("[hidden]") && e.getClientRects().length && !(e.closest("details:not([open])") && !e.closest("summary"))).map(e => { const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3; return Math.round(e.getBoundingClientRect().height / lh); })`);
async function saveCard(field, value) {
  await page.fill(`#placeForm [name="${field}"]`, value);
  await press("#placeForm [type=submit]");
  await page.waitFor(`document.getElementById("placeMsg") && document.getElementById("placeMsg").innerText.trim() !== ""`, 8000, "card save result");
  await sleep(200);
}
const offlineBanner = async () => (await banners()).find(x => /^Нет связи/.test(x)) || "";

/* ======================= an offline save keeps «Нет связи» ======================= */

test("an offline save keeps «Нет связи» in the status, the banners and the map note, and the banner promises the send once", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await saveCard("archetype", "город у океана");
  await page.waitFor(`document.getElementById("syncText").innerText === "Нет связи · в очереди: 1"`, 4000, "offline with one change queued").catch(() => {});
  assert.equal(await syncText(), "Нет связи · в очереди: 1", "the phone is still offline, yet the status turned into a plain queue");
  assert.match(oneLine(await page.text("#v-place")), /Нет связи\./, "the dossier lost its offline banner");
  await go("#/rank");
  const b = await offlineBanner();
  assert.match(b, /: 1 правка — отправлю сам, когда появится связь\./, `«${b}»`);
  assert.equal((b.match(/отправ/g) || []).length, 1, `the send is promised twice: «${b}»`);
  await go("#/map", 800);
  assert.ok(await page.visible("#mapNote"), "the map lost its offline note");
  assert.match(await page.text("#mapNote"), /Нет связи/);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:pending")).length`), 1);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 8000, "queue sent when the network is back");
});

test("offline with nothing queued, the banner says once that changes can be saved and will be sent by me", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await comeBack();
  await page.waitFor(`document.getElementById("syncText").innerText === "Нет связи"`, 6000, "offline status");
  await sleep(200);
  const b = await offlineBanner();
  assert.match(b, /Показаны данные на /, `«${b}»`);
  assert.match(b, /Оценки и правки можно сохранять — отправлю сам, когда появится связь\./, `«${b}»`);
  assert.equal((b.match(/отправ/g) || []).length, 1, `«${b}»`);
});

test("a first start offline with no data says nothing is loaded yet instead of offering to save changes", { skip }, async () => {
  await open({ hash: "#/rank", offline: true });
  assert.equal(await syncText(), "Нет связи · данных нет", "precondition");
  const b = await offlineBanner();
  assert.doesNotMatch(b, /можно сохранять/, `there is nothing to rate yet: «${b}»`);
  assert.match(b, /(На телефоне|На этом устройстве) ещё нет наших мест и оценок — загружу их, когда появится связь\./, `«${b}»`);
  await go("#/place/porto");
  const t = oneLine(await page.text("#v-place"));
  assert.match(t, /Место откроется, когда появится связь и загрузятся данные\./, `«${t}»`);
  assert.doesNotMatch(t, /или ключ не подходит/, `«${t}»`);
});

/* ======================= the status ======================= */

test("a tap on the status offline or while GitHub is down says what happened, and the status names GitHub, not «связь»", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await comeBack();
  await page.waitFor(`document.getElementById("syncText").innerText === "Нет связи"`, 6000, "offline status");
  await page.tap({ sel: "#syncBtn" });
  assert.match(await toastNow(/нет связи/i), /^Всё ещё нет связи — проверю сам, когда она появится\.$/);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await rules([{ url: "https://api.github.com/", status: 503, json: { message: "Service unavailable" } }]);
  try {
    await page.tap({ sel: "#syncBtn" });
    await settled();
    assert.equal(await syncText(), "GitHub не отвечает", "the status must not read as a problem with the phone's own connection");
    assert.match(await toastNow(/GitHub/), /^GitHub сейчас не отвечает — попробую снова сам через минуту\.$/);
    const b = (await banners()).find(x => /GitHub/.test(x)) || "";
    assert.match(b, /GitHub сейчас не отвечает/, `the banner and the status use the same words: «${b}»`);
    await sleep(300);
    await page.tap({ sel: "#syncBtn" });
    await settled();
    assert.match(await toastNow(/всё ещё/), /^GitHub всё ещё не отвечает — попробую снова сам через минуту\.$/);
  } finally { await rules([]); }
});

test("a rate limit without a time from GitHub is not shown as GitHub's time, in the status, the banner or the tap toast", { skip }, async () => {
  await open({ hash: "#/rank" });
  await rules([{ url: "https://api.github.com/", status: 429, json: { message: "Too many requests" } }]);
  try {
    await page.tap({ sel: "#syncBtn" });
    await settled();
    assert.equal(await syncText(), "Лимит GitHub", "our own retry time is shown as if GitHub said it");
    const b = (await banners()).find(x => /GitHub/.test(x)) || "";
    assert.match(b, /на несколько минут/, `«${b}»`);
    assert.match(b, /когда GitHub снимет ограничение/, `«${b}»`);
    assert.doesNotMatch(b, /\d\d:\d\d/, `«${b}»`);
    await page.tap({ sel: "#syncBtn" });
    const t = await toastNow(/ограничил/);
    assert.match(t, /^GitHub временно ограничил запросы\. Обновлю данные сам, когда GitHub снимет ограничение\.$/, `«${t}»`);
  } finally { await rules([]); }
});

/* ======================= the interrupted-save notice ======================= */

function cutSaving(id, extra = "") {
  return page.eval(`(() => {
    localStorage.setItem("wtl:saving", JSON.stringify({ id: ${js(id)}, place: "batumi", stamp: new Date().toISOString(), edit: false }));
    ${extra}
  })()`);
}

test("the interrupted-save notice is shown when the first load meets a GitHub error, and says I check when GitHub answers", { skip }, async () => {
  await open({ hash: "#/rank" });
  await rules([{ url: "https://api.github.com/", status: 503, json: { message: "Service unavailable" } }]);
  try {
    await cutSaving("r-cut-503");
    await relaunch("#/rank");
    await page.waitFor(`document.getElementById("syncText").innerText === "GitHub не отвечает"`, 10000, "GitHub down at start");
    const b = (await banners()).find(x => /Батуми/.test(x)) || "";
    assert.match(b, /не знаю, дошла ли до GitHub/, `nothing is said about the rating that may be lost: «${b}»`);
    assert.match(b, /проверю, когда GitHub ответит/, `«${b}»`);
    assert.doesNotMatch(b, /появится связь/, `the phone has a connection: «${b}»`);
  } finally { await rules([]); }
});

test("offline at start, the notice is honest; when the network is back and GitHub has nothing new, it says the save did not get through", { skip }, async () => {
  await open({ hash: "#/rank" });
  await cutSaving("r-cut-offline", `localStorage.setItem("mock:offline", "1");`);
  await relaunch("#/rank");
  await page.waitFor(`/^Нет связи/.test(document.getElementById("syncText").innerText)`, 8000, "offline status");
  const b1 = (await banners()).find(x => /Батуми/.test(x)) || "";
  assert.match(b1, /не знаю, дошла ли до GitHub.*проверю, когда появится связь/, `«${b1}»`);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await comeBack();
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено" || /^Сохранено/.test(document.getElementById("syncText").innerText)`, 8000, "back online");
  await sleep(200);
  const b2 = (await banners()).find(x => /Батуми/.test(x)) || "";
  assert.match(b2, /не успела сохраниться/, `GitHub's data is current and has no such rating: «${b2}»`);
});

/* ======================= the update bar ======================= */

test("the update bar drops its «unsaved edit» warning when I leave the page or tap «Позже»", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const bar = () => page.eval(`({ text: document.querySelector("#updateBar span").innerText, btn: document.getElementById("updateBtn").innerText.trim(), armed: !!document.getElementById("updateBtn").dataset.armed })`);
  await page.eval(`document.getElementById("updateBar").hidden = false`);
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ sel: "#updateBtn" });
  const armed = await bar();
  assert.equal(armed.btn, "Всё равно обновить", "precondition: an unsaved edit arms the button");
  assert.match(armed.text, /не сохранена/);
  await go("#/rank");
  const left = await bar();
  assert.equal(left.btn, "Обновить", "on «Рейтинг» there is no edit to lose");
  assert.equal(left.armed, false);
  assert.match(left.text, /^Вышла новая версия приложения/, `«${left.text}»`);
  await go("#/place/porto");
  await page.fill('#placeForm [name="archetype"]', "город у залива");
  await page.tap({ sel: "#updateBtn" });
  assert.equal((await bar()).btn, "Всё равно обновить");
  await page.tap({ sel: "#updateLater" });
  await page.eval(`document.getElementById("updateBar").hidden = false`);
  const later = await bar();
  assert.equal(later.btn, "Обновить", "after «Позже» the bar comes back armed");
  assert.match(later.text, /^Вышла новая версия приложения/);
});

/* ======================= shorter help ======================= */

test("the weights help names only the buttons that are shown and says when the others appear", { skip }, async () => {
  const help = async () => { await page.eval(`(() => { const d = document.getElementById("wdetails"); if (!d.open) d.querySelector("summary").click(); })()`); await sleep(150); return page.eval(`[...document.querySelectorAll("#wdetails > p")].map(p => p.innerText.trim())`); };
  await open({ hash: "#/rank" });
  const none = await help();
  assert.match(none[0], /^Чьи веса учитывать: «Поровну» — все группы одинаково, «Своё» — ползунки ниже\./, `«${none[0]}»`);
  assert.match(none[0], /Кнопки с нашими именами и «Оба» появятся/, `«${none[0]}»`);
  const files = repo({ weights: [{ id: "mikhail", who: "Михаил", w: { legal: 30, money: 70 }, updatedAt: "2026-10-01T00:00:00.000Z" }] });
  await open({ hash: "#/rank", files });
  const one = await help();
  assert.match(one[0], /«Михаил» — веса Михаила/, `«${one[0]}»`);
  assert.match(one[0], /«Вика» и «Оба» появятся, когда Вика сохранит свои веса\./, `«${one[0]}»`);
  assert.doesNotMatch(one[0], /«Вика» — /, `describes a button that is not shown: «${one[0]}»`);
  const lines = (await linesOf("#wdetails > p")).reduce((a, n) => a + n, 0);
  assert.ok(lines <= 6, `${lines} grey lines before the first slider`);
});

test("«Места» keeps its opening note short and puts the statuses under the list", { skip }, async () => {
  await open({ hash: "#/places" });
  const head = oneLine(await page.text("#v-places header p"));
  assert.doesNotMatch(head, /Статусы/, `«${head}»`);
  const [n] = await linesOf("#v-places header p");
  assert.ok(n <= 4, `${n} lines before the filter: «${head}»`);
  const after = await page.eval(`(document.getElementById("plist").nextElementSibling || {}).innerText || ""`);
  assert.match(after, /^Статусы: кандидат/, `«${after}»`);
});

test("the rating form shows the scale in one short note and folds the rest under «Как оценивать»", { skip }, async () => {
  await open({ hash: "#/rate" });
  const who = await page.eval(`Math.round(document.getElementById("fWho").getBoundingClientRect().top)`);
  const ps = await page.eval(`[...document.querySelectorAll("#rateForm .fcard .help > span, #rateForm .fcard .help summary")].filter(e => e.getBoundingClientRect().bottom <= ${who}).map(e => { const cs = getComputedStyle(e), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3; return Math.round(e.getBoundingClientRect().height / lh); })`);
  const total = ps.reduce((a, n) => a + n, 0);
  assert.ok(total <= 5, `${total} lines of help before «Кто оценивает»`);
  const help = oneLine(await page.text("#rateForm .fcard .help"));
  assert.match(help, /Шкала 1–5 относительно СПб: 3 — как в СПб, 5 — сильно лучше для нас/, `«${help}»`);
  assert.doesNotMatch(help, /Аренду/, "the rent note is visible before the first question");
  await page.tap({ text: "Как оценивать", within: "#rateForm .fcard" });
  assert.match(oneLine(await page.text("#rateForm .fcard .help")), /«Цифры места»/);
});

/* ======================= wording ======================= */

test("a hidden partner rating reads «скрыта до вашей оценки», not a cut-off «до вашей»", { skip }, async () => {
  await open({ hash: "#/rank" });
  const chips = await page.eval(`[...document.querySelectorAll("#rank .row")].filter(r => /Тбилиси/.test(r.innerText)).map(r => r.querySelector(".chips").innerText)[0] || ""`);
  assert.match(chips, /оценка Вики скрыта до вашей оценки/, `«${chips}»`);
  await go("#/places");
  assert.match(oneLine(await page.text("#plist")), /оценка Вики скрыта до вашей оценки/);
});

test("the year answers use the form's words «прожили бы здесь год» in the places list and on the map card", { skip }, async () => {
  await open({ hash: "#/places" });
  const list = oneLine(await page.text("#plist"));
  assert.match(list, /прожили бы здесь год: Михаил 7\/10 · Вика 6\/10/, `«${list}»`);
  assert.doesNotMatch(list, /прожили бы год здесь/);
  await go("#/map", 600);
  await page.waitFor(`!!document.querySelector('.leaflet-marker-icon[title="Порту"]')`, 6000, "pin");
  await page.eval(`document.querySelector('.leaflet-marker-icon[title="Порту"]').click()`);
  await page.waitFor(`!document.getElementById("sheet").hidden`, 4000, "card");
  const card = oneLine(await page.text("#sheetBody"));
  assert.match(card, /прожили бы здесь год: Михаил 7\/10 · Вика 6\/10/, `«${card}»`);
  await go("#/place/porto");
  assert.match(oneLine(await page.text("#v-place .year")), /^Прожили бы здесь год\?/);
});

test("a hidden year answer in the dossier is small grey text, not a big bold number", { skip }, async () => {
  await open({ hash: "#/place/tbilisi" });
  const r = await page.eval(`(() => { const y = document.querySelector("#v-place .year"); return { bold: [...y.querySelectorAll("b")].map(b => b.innerText), muted: [...y.querySelectorAll(".muted.small")].map(s => s.innerText) }; })()`);
  assert.ok(!r.bold.includes("скрыто"), "«скрыто» is set in the big number font: " + JSON.stringify(r));
  assert.ok(r.muted.includes("скрыто"), JSON.stringify(r));
});

test("«Уже в карточке» in the rating form separates the card's questions", { skip }, async () => {
  const files = repo({ places: PLACES.map(p => p.id === "porto" ? Object.assign({}, p, { questions: "Проверить сырость зимой\nСколько стоит детский сад" }) : p) });
  await open({ hash: "#/rate/new/porto", files });
  assert.equal(await page.text("#fQuestionsNow"), "Уже в карточке: Проверить сырость зимой / Сколько стоит детский сад");
});

test("each figure of a place suggests its own source", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  const ph = await page.eval(`Object.fromEntries([...document.querySelectorAll('#factsForm input[name^="src_"]')].map(i => [i.name.slice(4), i.placeholder]))`);
  assert.equal(ph.rent, "сайт, число объявлений");
  assert.match(ph.tds, /TDS/, JSON.stringify(ph));
  assert.match(ph.utilities, /хозяин/, JSON.stringify(ph));
  assert.match(ph.dinner, /ужин/, JSON.stringify(ph));
  assert.equal(new Set(Object.values(ph)).size, Object.keys(ph).length, "the same hint for different figures: " + JSON.stringify(ph));
});

test("on «Настройки» the refusal banner points to the copy button below instead of linking to the same page", { skip }, async () => {
  const porto = PLACES.find(p => p.id === "porto");
  const lost = [{ path: "places/porto.json", content: JSON.stringify(Object.assign({}, porto, { archetype: "город у океана" })), patch: { archetype: "город у океана" }, base: { archetype: "город у моря" }, message: "Порту: тип места", at: "2026-10-30T10:00:00.000Z", why: "rejected", reason: "GitHub не принял правку: файл слишком большой" }];
  await open({ hash: "#/settings", local: { "wtl:lost": lost } });
  const b = (await banners()).find(x => /не принял/.test(x)) || "";
  assert.match(b, /копия — ниже \(«Скачать копию данных»\)/, `«${b}»`);
  assert.equal(await page.eval(`[...document.querySelectorAll("#v-settings .banner a")].filter(a => a.getAttribute("href") === "#/settings").length`), 0, "a link to the page I am on");
  assert.ok(await page.visible("#exportBtn"), "the copy button is on this page");
  await go("#/rank");
  const r = (await banners()).find(x => /не принял/.test(x)) || "";
  assert.match(r, /копия — в настройках/, `elsewhere the banner still sends to settings: «${r}»`);
});

test("without «Кто я», the flags note says flags are hidden until someone is chosen, without promising they will appear", { skip }, async () => {
  await open({ hash: "#/rank", me: "" });
  const t = oneLine(await page.eval(`document.getElementById("v-rank").textContent`));
  assert.match(t, /Флаги по местам, которые оценил только один из нас, скрыты, пока не выбрано, кто вы на этом устройстве\./, t.slice(0, 400));
  assert.doesNotMatch(t, /появятся, когда вы выберете/);
});

test("a draft Михаил fills in for Вика is named as her rating in the dossier, not «вашей»", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  await press('#fWho [data-who="Вика"]');
  await score("интернет", 4);
  await page.waitFor(`(localStorage.getItem("wtl:draft") || "").includes("интернет")`, 3000, "draft saved");
  await go("#/place/batumi");
  const note = oneLine(await page.eval(`[...document.querySelectorAll("#v-place .banner")].map(b => b.innerText).find(t => /черновик/.test(t)) || ""`));
  assert.match(note, /Есть несохранённый черновик оценки Вики: 1 ответ\./, `«${note}»`);
});

test("with a veto the save bar says the place leaves for «Отсев» instead of «для рейтинга хватает»", { skip }, async () => {
  await open({ hash: "#/rate/new/porto" });
  await score("шум", 3);
  assert.equal(await page.text("#fCounts"), "главные ★ 1 из 10 · для рейтинга хватает", "precondition");
  await page.fill("#fVeto", "Слишком сыро для нас");
  assert.equal(await page.text("#fCounts"), "главные ★ 1 из 10 · с вето место уйдёт в отсев");
  await page.fill("#fVeto", "");
  assert.equal(await page.text("#fCounts"), "главные ★ 1 из 10 · для рейтинга хватает");
});

/* ======================= sideways phone ======================= */

test("sideways, a place card is a side panel: the chosen pin and the search stay visible next to it", { skip, timeout: 90000 }, async () => {
  await open({ hash: "#/map" }, [844, 390]);
  await settleMap(page);
  await page.eval(`document.querySelector('.leaflet-marker-icon[title="Порту"]').click()`);
  await page.waitFor(`!document.getElementById("sheet").hidden`, 4000, "card");
  await settleMap(page);
  const s = await rect("#sheet"), pin = await rect('.leaflet-marker-icon[title="Порту"]'), top = await rect(".map-top"), mv = await rect(".map-view");
  assert.ok(pin.left >= s.right, `the pin (x ${Math.round(pin.left)}–${Math.round(pin.right)}) is under the card (ends at x ${Math.round(s.right)})`);
  assert.ok(pin.top >= mv.top && pin.bottom <= mv.bottom, "the pin is off the map");
  assert.equal(await page.eval(`(() => { const p = document.querySelector('.leaflet-marker-icon[title="Порту"]'), r = p.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === p || p.contains(h)); })()`), true, "something covers the pin");
  assert.ok(!overlap(s, top), "the search box covers the card");
  assert.ok(s.width <= 844 / 2 + 1, `the card takes ${Math.round(s.width)} px of 844`);
  assert.ok(s.bottom <= mv.bottom + 1 && s.top >= mv.top - 1, "the card leaves the map");
  await page.shot("c3r-sideways-card");
  await page.tap({ sel: "#searchInput" });
  await page.fill("#searchInput", "Валенсия");
  await page.waitFor(`!document.getElementById("searchResults").hidden && document.querySelectorAll("#searchResults button").length > 0`, 4000, "search suggestions");
  await page.tap({ within: "#searchResults", text: "Валенсия" });
  await page.waitFor(`!document.getElementById("sheet").hidden && document.getElementById("sheetTitle").innerText === "Валенсия"`, 5000, "card of Валенсия");
  await settleMap(page);
  const s2 = await rect("#sheet"), pin2 = await rect('.leaflet-marker-icon[title="Валенсия"]');
  assert.ok(pin2 && pin2.left >= s2.right, `after a search the pin is under the card: ${JSON.stringify({ pin: pin2, card: s2.right })}`);
  await page.viewport(390, 844);
  await sleep(400);
  const p = await rect("#sheet"), mv2 = await rect(".map-view");
  assert.ok(Math.abs(p.bottom - mv2.bottom) <= 1 && p.width >= 389, "upright, the card is still a bottom sheet");
});

test("sideways, the «Слои» panel keeps its height when a map legend is on", { skip, timeout: 90000 }, async () => {
  await open({ hash: "#/map" }, [844, 390]);
  await page.tap({ text: "Слои" });
  await page.waitFor(`!document.getElementById("layersPanel").hidden`, 3000, "layers");
  await page.select("#lyCity", "Январь, средняя");
  await page.waitFor(`!document.getElementById("legendBox").hidden`, 4000, "legend on");
  await sleep(300);
  const l = await rect("#layersPanel"), mv = await rect(".map-view");
  assert.ok(l.height >= 200, `the panel is ${Math.round(l.height)} px tall on a ${Math.round(mv.height)} px map`);
  assert.ok(l.bottom <= mv.bottom + 1);
  assert.deepEqual(page.takeErrors(), []);
});
