import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, PLACES, mockFiles, mockLog } from "./fixtures.mjs";

// Persona: on a trip with a bad network, Mikhail and Vika each with a phone. The other phone is simulated by
// writing straight into the mock repo (mock:files) and moving its head, the way a real commit from another device would.

const skip = !CHROME && "no Chrome";
let srv, page;

// Knobs for this file only:
//   localStorage "test:status"      — every GitHub call answers with this HTTP status (401 = key revoked, 5xx = GitHub down);
//   localStorage "test:writeStatus" — only commits answer with this status, reads still work;
//   localStorage "test:lateReply"   — a commit lands in the repo, but its reply reaches the phone this many ms later
//                                     (the network drops after GitHub got the change);
//   window.__toasts                 — every toast shown on this page, in order.
const PROBE = `(() => {
  const inner = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.github.com/") && localStorage.getItem("mock:offline") !== "1") {
      const write = !!(init.body && String(init.body).includes("createCommitOnBranch"));
      const code = (write && localStorage.getItem("test:writeStatus")) || localStorage.getItem("test:status");
      if (code) {
        await new Promise(r => setTimeout(r, Number(localStorage.getItem("mock:delay") || 60)));
        return new Response(JSON.stringify({ message: "test" }), { status: Number(code), headers: { "Content-Type": "application/json" } });
      }
      const late = write && Number(localStorage.getItem("test:lateReply") || 0);
      if (late) { const res = await inner(input, init); await new Promise(r => setTimeout(r, late)); return res; }
    }
    return inner(input, init);
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
  page = await launch();
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
});
after(async () => { await page?.close(); await srv?.close(); });

const js = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BOOTED = `document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`;
const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };

async function fresh(opts = {}, vp = {}) {
  await page.viewport(vp.w || 390, vp.h || 844, { dark: !!vp.dark });
  await openApp(page, srv.url, opts);
  await page.eval(`window.__toasts.length = 0`);
  page.takeErrors();
}

async function reload() {
  await page.eval(`window.__stale = 1`);
  await page.send("Page.reload");
  await page.waitFor(`!window.__stale && document.readyState === "complete" && ${BOOTED}`, 10000, "app reloaded");
  await sleep(200);
}

async function go(hash) {
  await page.eval(`location.hash = ${js(hash)}`);
  await page.waitFor(`!document.getElementById(${js(VIEW[hash.split("/")[1]])}).hidden`, 4000, "view " + hash);
  await sleep(200);
}

const knob = (k, v) => page.eval(v == null ? `localStorage.removeItem(${js(k)})` : `localStorage.setItem(${js(k)}, ${js(String(v))})`);
const offline = () => knob("mock:offline", "1");
const online = () => page.eval(`localStorage.removeItem("mock:offline"); window.dispatchEvent(new Event("online"))`);
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const syncText = () => page.text("#syncText");
const stored = k => page.eval(`JSON.parse(localStorage.getItem(${js("wtl:" + k)}) || "null")`);
const lost = async () => (await stored("lost")) || [];
const pending = async () => (await stored("pending")) || [];
const remote = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const remoteRatings = async (place, who) => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && (!who || r.who === who) && !r.deleted);
const toasts = () => page.eval(`window.__toasts.slice()`);
const toastSeen = (re, ms = 6000) => page.waitFor(`window.__toasts.find(t => ${re}.test(t))`, ms, "toast " + re);
const screenText = () => page.eval(`[document.querySelector(".appbar"), document.querySelector(".view:not([hidden])")].map(e => e.innerText).join("\\n")`);
const alertsText = () => page.eval(`[document.getElementById("syncText"), ...document.querySelectorAll(".view:not([hidden]) .banner, .view:not([hidden]) .msg")].map(e => e.innerText.trim()).filter(Boolean).join(" / ")`);
const value = sel => page.eval(`document.querySelector(${js(sel)}).value`);
const qval = k => page.eval(`document.querySelector('[data-qval="${k}"]').textContent`);
const queueEmpty = (ms = 8000) => page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0 && ${BOOTED}`, ms, "queue sent");
const lostRow = (nth = 0) => page.eval(`(() => { const r = document.querySelectorAll(".view:not([hidden]) .lost")[${nth}]; return r ? r.innerText : null; })()`);

// The other phone commits a change to one file of the shared repo; the head moves on as after a real commit.
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

async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const score = (k, v) => press(`[data-score="${k}"][data-v="${v}"]`);

async function saveRating(placeId) {
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${placeId}"`, 8000, "dossier of " + placeId);
  await sleep(150);
}

async function editMine(placeId, rid) {
  await go("#/place/" + placeId);
  await page.tap({ text: "Изменить", within: `#v-place .trip[data-rid="${rid}"]` });
  await page.waitFor(`document.querySelector(".edit-head")`, 4000, "edit form");
}

// Network back: wait until the queue is processed; whatever clashed lands in «Не отправлено».
async function backOnline() {
  await online();
  await queueEmpty();
  await sleep(300);
}

// «Записать мою» on every unsent row, if any are left (a fix may merge clashes without asking).
async function applyAllLost() {
  for (let i = 0; i < 5 && (await lost()).length; i++) {
    const before = (await lost()).length;
    await page.tap({ text: "Записать мою", within: ".view:not([hidden]) .lost" });
    await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length < ${before}`, 6000, "row applied");
    await sleep(200);
  }
}

// «Выбросить», confirming with a second tap if the app asks for one.
async function discardFirst() {
  const before = (await lost()).length;
  for (let n = 0; n < 2; n++) {
    await page.tap({ text: "Выбросить", within: ".view:not([hidden]) .lost" });
    await sleep(250);
    if ((await lost()).length < before) return;
  }
  throw new Error("«Выбросить» did not drop the row");
}

// Mikhail's change to the Porto card waits offline while the other phone changes the same card; then the network returns.
async function clashOnPorto(fill, theirs) {
  await fresh({ hash: "#/place/porto" });
  await offline();
  await fill();
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
  await otherPhone("places/porto.json", theirs);
  await backOnline();
}
const fillCard = (field, text) => async () => { await page.fill(`#placeForm [name="${field}"]`, text); await page.tap({ text: "Сохранить карточку" }); };
const fillNumber = (key, v) => async () => { await page.fill(`#factsForm [name="fact_${key}"]`, v); await page.tap({ text: "Сохранить цифры" }); };

const vikaRating = (id, place, extra = {}) => Object.assign({ id, place, who: "Вика", start: "2026-09-01", end: "2026-09-10", days: 10, season: "пик", mode: "отпуск", housing: "жилой район", retro: false, year: 6, veto: "", review: "Вика: тихо по вечерам.", scores: { "интернет": 4, "улица": 4 }, conf: {}, notes: {}, surprises: "", deleted: false, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }, extra);

/* ---------- rating offline, the network comes back ---------- */

test("a rating saved offline survives closing the app and is sent once the network is back", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await offline();
  await score("интернет", 4);
  await page.fill("#fReview", "Сеть в горах пропадала.");
  await saveRating("batumi");
  assert.match(await toastSeen(/Нет связи/), /отправится позже/);
  await reload();
  assert.equal(await syncText(), "Офлайн · в очереди: 1");
  assert.match(await page.text("#v-place"), /Сеть в горах пропадала/, "my queued trip is still shown after the app was closed");
  assert.equal((await remoteRatings("batumi")).length, 0);
  await online();
  assert.match(await toastSeen(/Отправлено из очереди/), /: 1/);
  const rs = await remoteRatings("batumi", "Михаил");
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0].scores, { "интернет": 4 });
  assert.equal(rs[0].review, "Сеть в горах пропадала.");
  assert.equal((await pending()).length, 0);
});

test("a trip saved offline is marked in the dossier as not sent yet, and the mark goes away once it is sent", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await offline();
  await score("интернет", 4);
  await saveRating("batumi");
  const id = JSON.parse((await pending())[0].content).id;
  const trip = () => page.text(`#v-place .trip[data-rid="${id}"]`);
  assert.match(await trip(), /не отправлен|ждёт отправки|в очереди|отправится/i, `the trip card gives no hint that it is only on this phone: «${await trip()}»`);
  await online();
  await queueEmpty();
  await sleep(300);
  assert.doesNotMatch(await trip(), /не отправлен|ждёт отправки|в очереди|отправится/i);
});

test("two ratings saved offline on Vika's phone both arrive, each exactly once", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi", me: "Вика" });
  await offline();
  await score("интернет", 3);
  await saveRating("batumi");
  await go("#/rate/new/belgrad");
  await score("улица", 4);
  await saveRating("belgrad");
  assert.equal((await pending()).length, 2);
  assert.match(await syncText(), /очереди: 2/);
  await online();
  assert.match(await toastSeen(/Отправлено из очереди/), /: 2/);
  assert.equal((await remoteRatings("batumi", "Вика")).length, 1);
  assert.equal((await remoteRatings("belgrad", "Вика")).length, 1);
  assert.equal((await mockLog(page)).filter(e => e.op === "add" && e.path.startsWith("ratings/")).length, 2, "each rating is written once");
});

test("on a computer the offline save message does not say the rating is kept «на телефоне»", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" }, { w: 1280, h: 800 });
  await offline();
  await score("интернет", 4);
  await saveRating("batumi");
  const t = await toastSeen(/Нет связи/);
  assert.doesNotMatch(t, /телефон/, `on a laptop the toast says «${t}»`);
  assert.match(t, /отправится/);
});

test("opened offline, the banner says that new ratings can still be saved and will be sent later", { skip }, async () => {
  await fresh({ hash: "#/rank" });
  await offline();
  await reload();
  const b = await page.text("#v-rank .banner");
  assert.match(b, /сохран|оцен|правк/i, `the offline banner only says «${b}»: can I still rate?`);
  assert.match(b, /отправ.*(позже|когда|появится)|когда появится (сеть|связь)/i, `the offline banner only says «${b}»`);
});

test("opened offline, the app says how fresh the shown data is", { skip }, async () => {
  await fresh({ hash: "#/rank" });
  await offline();
  await reload();
  const t = (await syncText()) + "\n" + (await page.text("#v-rank .banner"));
  assert.match(t, /\d{1,2}:\d{2}|сегодня|вчера|назад/, `nothing tells when the data was last loaded: «${t}»`);
});

test("on an iPhone the sync status is never cut off with «…»", { skip }, async () => {
  const fake = Array.from({ length: 12 }, (_, i) => ({ path: "places/porto.json", content: JSON.stringify(Object.assign({}, PLACES[1], { questions: "Вопрос " + i })), baseOid: undefined, message: "q" + i }));
  for (const [opts, what] of [[{ hash: "#/rank", offline: true, files: null }, "first start offline"], [{ hash: "#/rank", offline: true, local: { "wtl:pending": fake } }, "12 changes queued offline"]]) {
    await fresh(opts);
    const r = await page.eval(`(() => { const e = document.getElementById("syncText"); return { text: e.innerText, cut: e.scrollWidth > e.clientWidth }; })()`);
    assert.equal(r.cut, false, `${what}: «${r.text}» does not fit and is cut`);
  }
});

test("on the very first start without network the app says places will load once online, not that the key may be wrong", { skip }, async () => {
  await fresh({ hash: "#/places", offline: true });
  const list = await page.text("#plist");
  assert.doesNotMatch(list, /ключ не подходит/, `we know it is the network, yet the list says «${list}»`);
  await go("#/rate");
  const t = await page.text("#v-rate");
  assert.match(t, /(мест|список)[^.]{0,60}(загруз|появ)/i, "the rating form has no places and does not say why");
});

/* ---------- slow network during a save ---------- */

test("while the place card is saving on a slow network the button shows it, and a second tap writes nothing more", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await knob("mock:delay", 1500);
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" }, 120);
  const busy = await page.eval(`(() => { const b = document.querySelector("#placeForm [type=submit]"); return { disabled: b.disabled, text: b.innerText, msg: document.getElementById("placeMsg").innerText }; })()`);
  assert.ok(busy.disabled || /сохраня|отправля/i.test(busy.text + " " + busy.msg), `nothing shows that the card is being saved: ${js(busy)}`);
  await page.tap({ text: "Сохран", within: "#placeForm" }, 120).catch(() => {});
  await page.waitFor(`/^Сохранено/.test(document.getElementById("syncText").innerText)`, 8000, "saved");
  await sleep(2000);
  assert.equal((await remote("places/porto.json")).archetype, "город у океана");
  assert.equal((await mockLog(page)).filter(e => e.op === "add").length, 1);
  assert.doesNotMatch((await toasts()).join("\n") + (await page.text("#v-place")), /другом устройстве/);
});

test("saving numbers and then the card right away on a slow network saves both without a false «другом устройстве» warning", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await knob("mock:delay", 1200);
  await page.fill('#factsForm [name="fact_rent"]', "800");
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить цифры" }, 100);
  await page.tap({ text: "Сохранить карточку" }, 100);
  await page.waitFor(`(() => { const m = document.getElementById("placeMsg"); return (m && m.innerText) || !document.querySelector("#placeForm"); })()`, 10000, "card save finished").catch(() => {});
  await sleep(3500);
  const msgs = await page.eval(`["factsMsg", "placeMsg"].map(id => (document.getElementById(id) || {}).innerText || "").join(" | ")`);
  assert.doesNotMatch(msgs, /другом устройстве/, "only this phone was saving: " + msgs);
  const p = await remote("places/porto.json");
  assert.equal(p.facts && p.facts.rent && p.facts.rent.v, 800);
  assert.equal(p.archetype, "город у океана", "the card typed next to the numbers was not saved");
});

test("while a new place is being added on a slow network «Добавить место» shows it, and a second tap adds nothing", { skip }, async () => {
  await fresh({ hash: "#/map" });
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type("Бар");
  await page.key("Enter");
  await page.waitFor(`(() => { const r = document.getElementById("searchResults"); return !r.hidden && /Бар, Черногория/.test(r.innerText); })()`, 6000, "OSM results");
  await page.tap({ text: "Бар, Черногория", within: "#searchResults" });
  await page.waitFor(`document.querySelector("#sheet:not([hidden]) [data-act=addgeo]")`, 5000, "add sheet");
  await sleep(1200);
  await knob("mock:delay", 1500);
  await page.tap({ sel: "#sheet [data-act=addgeo]" }, 120);
  const busy = await page.eval(`(() => { const b = document.querySelector("#sheet [data-act=addgeo]"); return b ? { disabled: b.disabled, text: b.innerText } : { gone: true }; })()`);
  assert.ok(busy.gone || busy.disabled || /добавляю|сохраняю/i.test(busy.text), `nothing shows that the place is being added: ${js(busy)}`);
  await page.tap({ sel: "#sheet [data-act=addgeo]" }, 120).catch(() => {});
  await page.waitFor(`JSON.parse(localStorage.getItem("mock:files"))["places/bar.json"]`, 8000, "place written");
  await sleep(2500);
  assert.equal((await mockLog(page)).filter(e => e.path === "places/bar.json").length, 1);
  assert.doesNotMatch((await toasts()).join("\n"), /уже есть|другом устройстве/, "my own second tap is reported as a duplicate");
});

test("a rating that finishes saving after I moved to another tab confirms it there instead of pulling me back", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await knob("mock:delay", 1500);
  await press("#fSave", 80);
  await page.tap({ sel: '.bottomnav a[data-nav="rank"]' }, 100);
  await page.waitFor(`Object.keys(JSON.parse(localStorage.getItem("mock:files"))).filter(k => k.startsWith("ratings/")).length === 5`, 8000, "rating written");
  await sleep(800);
  assert.equal((await remoteRatings("batumi")).length, 1);
  assert.match((await toasts()).join("\n"), /Сохранено/);
  assert.equal(await page.eval("location.hash"), "#/rank", "the app jumped away from the tab I chose while it was saving");
});

test("a save that fails after I left the rating screen tells me so, and the answers wait in the form", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await knob("mock:delay", 1200);
  await knob("test:writeStatus", 500);
  await press("#fSave", 80);
  await page.tap({ sel: '.bottomnav a[data-nav="map"]' }, 100);
  await page.waitFor(`document.getElementById("syncText").innerText === "Ошибка связи"`, 8000, "save failed");
  await sleep(400);
  const seen = (await toasts()).join("\n");
  assert.match(seen, /не сохран|не отправ|не удалось|не записа/i, `on the map nothing says the rating was not saved; toasts: «${seen}»`);
  await knob("test:writeStatus", null);
  await knob("mock:delay", null);
  await go("#/rate");
  assert.equal(await qval("интернет"), "4", "the answers are still in the form");
});

test("closing the app in the middle of a slow save keeps the answers, and saving again writes one rating", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Тихо и зелено.");
  await sleep(500);
  await knob("mock:delay", 4000);
  await press("#fSave", 150);
  await knob("mock:delay", 100);
  await reload();
  await go("#/rate");
  assert.equal(await qval("интернет"), "4");
  assert.equal(await value("#fReview"), "Тихо и зелено.");
  await saveRating("batumi");
  assert.equal((await remoteRatings("batumi")).length, 1);
});

test("when the reply to a save is lost but GitHub got it, saving again does not create a second copy of the trip", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await page.fill("#fReview", "Тихо и зелено.");
  await sleep(500);
  await knob("test:lateReply", 5000);
  await press("#fSave", 400);
  await page.waitFor(`Object.keys(JSON.parse(localStorage.getItem("mock:files"))).length === 11`, 4000, "the rating reached GitHub");
  await reload();
  await knob("test:lateReply", null);
  assert.equal((await remoteRatings("batumi")).length, 1);
  await go("#/rate");
  if (await qval("интернет") === "4") {
    await press("#fSave");
    await page.waitFor(`location.hash !== "#/rate" || document.getElementById("fMsg").innerText`, 6000, "second save finished");
    await sleep(300);
  }
  const rs = await remoteRatings("batumi");
  assert.equal(rs.length, 1, `the same trip is now saved ${rs.length} times`);
});

/* ---------- both phones edit the same place ---------- */

test("Vika's rent and Mikhail's dinner price typed at the same time on two phones both end up in the place numbers", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await page.fill('#factsForm [name="fact_dinner"]', "40");
  await otherPhone("places/porto.json", `d => Object.assign(d, { facts: { rent: { v: 900, src: "idealista, 20 объявлений", at: "2026-10-29" } } })`);
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText`, 6000, "save result");
  if (/другом устройстве/.test(await page.text("#factsMsg"))) await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`(JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).facts || {}).dinner`, 6000, "dinner saved");
  const p = await remote("places/porto.json");
  assert.equal(p.facts.dinner.v, 40);
  assert.deepEqual(p.facts.rent, { v: 900, src: "idealista, 20 объявлений", at: "2026-10-29" }, "Vika's rent is kept");
  await sleep(300);
  assert.equal(await value('#factsForm [name="fact_rent"]'), "900", "after saving, the form shows Vika's rent too");
});

test("when both phones typed the same number, the warning shows the other phone's value before mine replaces it", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await page.fill('#factsForm [name="fact_rent"]', "800");
  await otherPhone("places/porto.json", `d => Object.assign(d, { facts: { rent: { v: 1150, src: "Вика, агентство", at: "2026-10-29" } } })`);
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText`, 6000, "clash message");
  const around = await page.eval(`document.getElementById("factsMsg").innerText + "\\n" + document.querySelector('[name="fact_rent"]').closest(".fact").innerText`);
  assert.match(around, /1\s?150/, `I am about to overwrite Vika's 1150 without seeing it: «${around}»`);
});

/* ---------- «Не отправлено»: what each button does ---------- */

test("«Записать мою» for numbers queued offline keeps the card change the other phone made meanwhile", { skip }, async () => {
  await clashOnPorto(fillNumber("rent", "900"), `d => Object.assign(d, { questions: "Вика: где ближайшая школа?" })`);
  await applyAllLost();
  const p = await remote("places/porto.json");
  assert.equal(p.facts && p.facts.rent && p.facts.rent.v, 900, "my rent is saved");
  assert.equal(p.questions, "Вика: где ближайшая школа?", "Vika's question was silently replaced by the old text");
});

test("a question from an offline rating that met a card edit on the other phone is added without undoing that edit", { skip }, async () => {
  await fresh({ hash: "#/rate/new/porto", me: "Вика" });
  await offline();
  await score("интернет", 4);
  await page.fill("#fQuestions", "Есть ли садики рядом?");
  await saveRating("porto");
  await otherPhone("places/porto.json", `d => Object.assign(d, { archetype: "город у реки" })`);
  await backOnline();
  await applyAllLost();
  assert.equal((await remoteRatings("porto", "Вика")).length, 2, "Vika's new rating arrived");
  const p = await remote("places/porto.json");
  assert.match(p.questions, /Есть ли садики рядом\?/);
  assert.equal(p.archetype, "город у реки", "Mikhail's archetype was overwritten by the stale card");
});

test("the unsent row for a numbers change says which number I entered", { skip }, async () => {
  await clashOnPorto(fillNumber("rent", "900"), `d => Object.assign(d, { facts: { rent: { v: 1000, src: "", at: "2026-10-29" } } })`);
  const row = await lostRow();
  assert.ok(row, "the clash is listed");
  assert.match(row, /Аренда|аренд/, `the row does not say it is about the rent: «${row}»`);
  assert.match(row, /900/, `the row does not show my value: «${row}»`);
});

test("the unsent banner explains what «Записать мою» and «Выбросить» do to my version and the other phone's", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  const b = await page.text("#v-place .banner.err");
  assert.match(b, /Записать мою/, `the buttons are not named in the explanation: «${b}»`);
  assert.match(b, /Выбросить[^.]*(останется|оставить|сохранится)[^.]*(друг|той)/i, `nothing says what stays after «Выбросить»: «${b}»`);
});

test("«Выбросить» asks for a second tap before my unsent change is gone for good", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  await page.tap({ text: "Выбросить", within: "#v-place .lost" });
  await sleep(250);
  assert.equal((await lost()).length, 1, "one tap threw my change away with no way back");
  assert.match(await lostRow(), /точно|ещё раз|подтверд/i);
  await page.tap({ text: "Выбросить", within: "#v-place .lost" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 0`, 3000, "dropped on the second tap");
});

test("throwing my unsent card edit away writes nothing and leaves the other phone's text on screen", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  const writes = (await mockLog(page)).length;
  await discardFirst();
  await sleep(300);
  assert.equal((await mockLog(page)).length, writes, "nothing is written");
  assert.equal((await remote("places/porto.json")).questions, "Вопрос Вики");
  assert.match(await page.text("#v-place"), /Вопрос Вики/);
  assert.doesNotMatch(await screenText(), /Не отправлено/);
});

test("when «Записать мою» clashes again, the hint names a button that is on the screen", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  await otherPhone("places/porto.json", `d => Object.assign(d, { questions: "Вика передумала" })`);
  await page.tap({ text: "Записать мою", within: "#v-place .lost" });
  const t = await toastSeen(/изменили/);
  const named = [...t.matchAll(/«([^»]+)»/g)].map(m => m[1]);
  assert.ok(named.length, "the hint names what to press");
  for (const n of named) {
    const there = await page.eval(`[...document.querySelectorAll("button, a")].some(e => e.offsetParent && e.innerText.trim().startsWith(${js(n)}))`);
    assert.ok(there, `the toast says «${n}», but there is no such button on the screen: «${t}»`);
  }
  await page.tap({ text: "Записать мою", within: "#v-place .lost" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 0`, 6000, "written on the next tap");
  assert.equal((await remote("places/porto.json")).questions, "Мой вопрос");
});

test("unsent changes stay listed while offline or with a broken key", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  await go("#/rank");
  assert.match(await screenText(), /Не отправлено/);
  await offline();
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`/Офлайн/.test(document.getElementById("syncText").innerText)`, 5000, "offline");
  assert.match(await screenText(), /Не отправлено|Мой вопрос/, "offline the unsent change vanished from every screen");
  await knob("mock:offline", null);
  await knob("test:status", 401);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText === "Ключ не подходит"`, 5000, "key rejected");
  assert.match(await screenText(), /Не отправлено|Мой вопрос/, "with a broken key the unsent change vanished from every screen");
  assert.equal((await lost()).length, 1, "it is still kept on the phone");
});

test("the unsent row for a rating names the trip dates, so two trips to one place can be told apart", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await editMine("porto", "r1");
  await offline();
  await score("интернет", 2);
  await saveRating("porto");
  await otherPhone("ratings/r1.json", `d => Object.assign(d, { scores: Object.assign({}, d.scores, { "интернет": 5 }) })`);
  await backOnline();
  const row = await lostRow();
  assert.ok(row, "the clash is listed");
  assert.match(row, /Порту/);
  assert.match(row, /1–20 августа|август/, `which trip? «${row}»`);
});

test("when part of the queue clashes, the message does not say that everything was sent", { skip }, async () => {
  await fresh({ hash: "#/rate/new/porto", me: "Вика" });
  await offline();
  await score("интернет", 4);
  await page.fill("#fQuestions", "Есть ли садики рядом?");
  await saveRating("porto");
  await otherPhone("places/porto.json", `d => Object.assign(d, { questions: "Вопрос с ноутбука" })`);
  await page.eval(`window.__toasts.length = 0`);
  await backOnline();
  if (!(await lost()).length) return;
  const seen = (await toasts()).join("\n");
  assert.match(seen, /не отправ|изменили на другом/i, `the toasts only say «${seen}» while «Не отправлено: 1» sits in the header`);
});

/* ---------- a rating deleted on the other device ---------- */

test("saving an edit of a rating deleted on my other device says it was deleted and keeps my answers", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await editMine("porto", "r1");
  await otherPhone("ratings/r1.json", `d => Object.assign(d, { deleted: true })`);
  await score("интернет", 2);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText || location.hash !== "#/rate"`, 6000, "save result");
  const msg = await page.text("#fMsg");
  assert.equal(await qval("интернет"), "2", "my answers are still in the form");
  assert.match(msg, /удал/i, `the message does not say the rating was deleted: «${msg}»`);
  assert.doesNotMatch(msg, /откройте[^.]*из досье/i, "the dossier no longer has this rating, so this advice leads nowhere");
});

test("an offline delete that met an edit on the other device is listed as a deletion, and «Записать мою» deletes", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await editMine("porto", "r1");
  await offline();
  await press("#fDelete");
  await press("#fDelete");
  await page.waitFor(`location.hash === "#/place/porto"`, 5000, "dossier");
  await otherPhone("ratings/r1.json", `d => Object.assign(d, { review: "Правка с ноутбука" })`);
  await backOnline();
  assert.match(await lostRow(), /удален/i);
  await page.tap({ text: "Записать мою", within: "#v-place .lost" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 0`, 6000, "applied");
  assert.equal((await remote("ratings/r1.json")).deleted, true);
});

/* ---------- key revoked mid-session ---------- */

test("a rating refused because the key was revoked says next to the button where to fix it and that the answers are kept", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await knob("test:status", 401);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText || location.hash !== "#/rate"`, 6000, "save result");
  const bar = (await page.text(".savebar")) + "\n" + (await toasts()).join("\n");
  assert.match(bar, /настройк/i, `on a phone the top banner is far away; next to the button it only says «${await page.text("#fMsg")}»`);
  assert.match(bar, /(ответ|оценк)[^.]{0,40}(остал|сохран|не потер)|отправится/i, "nothing says whether my answers are safe");
});

test("after a revoked key is replaced, the rating that was refused is still there and is saved once", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await knob("test:status", 401);
  await press("#fSave");
  await page.waitFor(`document.getElementById("syncText").innerText === "Ключ не подходит"`, 6000, "key refused");
  await go("#/settings");
  await knob("test:status", null);
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_new_phone");
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`/Подключено/.test(document.getElementById("tokenMsg").innerText)`, 6000, "new key works");
  if (!(await remoteRatings("batumi")).length) {
    await go("#/rate");
    assert.equal(await qval("интернет"), "4", "the refused answers are still in the form");
    await saveRating("batumi");
  }
  const rs = await remoteRatings("batumi", "Михаил");
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0].scores, { "интернет": 4 });
});

test("a card edit refused for a revoked key is not lost when I go to settings to fix the key", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await knob("test:status", 401);
  await page.fill('#placeForm [name="questions"]', "Где снять зимой?");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "save result");
  await page.tap({ sel: '.appbar a[data-nav="settings"]' });
  await page.waitFor(`!document.getElementById("v-settings").hidden`, 3000, "settings");
  await knob("test:status", null);
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_new_phone");
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`/Подключено/.test(document.getElementById("tokenMsg").innerText)`, 6000, "new key works");
  await sleep(500);
  await go("#/place/porto");
  const kept = (await remote("places/porto.json")).questions === "Где снять зимой?" || (await value('#placeForm [name="questions"]')) === "Где снять зимой?";
  assert.ok(kept, "the question I typed is gone: neither saved nor still in the field");
});

test("with a revoked key, tapping the red «Ключ не подходит» status leads to settings", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await knob("test:status", 401);
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("syncText").innerText === "Ключ не подходит"`, 6000, "key refused");
  await page.tap({ sel: "#syncBtn" });
  await sleep(600);
  assert.equal(await page.eval("location.hash"), "#/settings", "the tap only retried with the same dead key");
});

/* ---------- GitHub down (5xx) ---------- */

test("a GitHub outage during a rating save says in plain words that the answers are kept and what happens next", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await knob("test:writeStatus", 502);
  await press("#fSave");
  await page.waitFor(`document.getElementById("fMsg").innerText || location.hash !== "#/rate"`, 6000, "save result");
  await sleep(200);
  const said = (await page.text("#fMsg")) + "\n" + (await toasts()).join("\n");
  assert.match(said, /остал|сохран[а-я]* на|не потер|отправится/i, `«${said}» — is my rating safe?`);
  assert.match(said, /позже|ещё раз|через минуту|сам[аи]?\b|автоматически/i, `«${said}» — what should I do?`);
});

test("with a revoked key or GitHub down, the screen says my queued changes are kept", { skip }, async () => {
  for (const code of [401, 503]) {
    await fresh({ hash: "#/place/porto" });
    await offline();
    await page.fill('#placeForm [name="archetype"]', "город у океана");
    await page.tap({ text: "Сохранить карточку" });
    await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
    await knob("mock:offline", null);
    await knob("test:status", code);
    await page.tap({ sel: "#syncBtn" });
    await page.waitFor(`["Ключ не подходит", "Ошибка связи"].includes(document.getElementById("syncText").innerText)`, 6000, "failure shown");
    const t = await alertsText();
    assert.match(t, /очеред|ждут? отправки|не отправлен/i, `HTTP ${code}: one change waits on the phone, but the header and banners only say «${t}»`);
    await knob("test:status", null);
  }
});

test("after a GitHub outage ends, the queued change is sent on the next check without any tap", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await offline();
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
  await knob("mock:offline", null);
  await knob("test:status", 503);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.getElementById("syncText").innerText === "Ошибка связи"`, 6000, "outage shown");
  assert.equal((await pending()).length, 1, "the change is still kept");
  await knob("test:status", null);
  await comeBack();
  await queueEmpty();
  assert.match(await toastSeen(/Отправлено из очереди/), /: 1/);
  assert.equal((await remote("places/porto.json")).archetype, "город у океана");
});

/* ---------- nothing is silently lost ---------- */

test("Mikhail's rating queued offline and Vika's rating of the same place sent meanwhile both survive", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await offline();
  await score("интернет", 2);
  await page.fill("#fReview", "Михаил: связь слабая.");
  await saveRating("batumi");
  await otherPhone("ratings/r-vika-batumi.json", `() => (${js(vikaRating("r-vika-batumi", "batumi"))})`);
  await backOnline();
  assert.equal((await remoteRatings("batumi", "Михаил")).length, 1);
  assert.equal((await remoteRatings("batumi", "Вика")).length, 1);
  assert.equal((await lost()).length, 0);
  const t = await page.text("#v-place");
  assert.match(t, /Михаил: связь слабая/);
  assert.match(t, /Вика: тихо по вечерам/, "Vika's trip shows up once I have rated the place myself");
});

test("an edit queued offline twice for the same card is sent as my latest text, once", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await offline();
  await page.fill('#placeForm [name="questions"]', "Черновик вопроса");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
  await page.fill('#placeForm [name="questions"]', "Где парковаться зимой?");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 2`, 4000, "queued twice");
  await backOnline();
  assert.equal((await lost()).length, 0, "my own two edits must not clash with each other");
  assert.equal((await remote("places/porto.json")).questions, "Где парковаться зимой?");
  assert.equal((await mockLog(page)).filter(e => e.path === "places/porto.json").length, 1);
});

/* ---------- how the unsent banner looks ---------- */

for (const [w, h, dark] of [[390, 844, true], [1280, 800, false]]) {
  test(`at ${w}×${h}${dark ? " dark" : ""} the unsent banner fits, its text is readable and both buttons are tappable`, { skip }, async () => {
    await page.viewport(w, h, { dark });
    await openApp(page, srv.url, { hash: "#/place/porto" });
    await offline();
    await page.fill('#placeForm [name="questions"]', "Мой вопрос с довольно длинным текстом, чтобы строка переносилась");
    await page.tap({ text: "Сохранить карточку" });
    await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
    await otherPhone("places/porto.json", `d => Object.assign(d, { questions: "Вопрос Вики" })`);
    await backOnline();
    await go("#/rank");
    await page.eval("scrollTo(0, 0)");
    await page.waitFor(`!document.getElementById("toast") || document.getElementById("toast").hidden`, 6000, "toast gone");
    const r = await page.eval(`(() => {
      const parse = c => c.match(/[\\d.]+/g).map(Number);
      const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = e => { for (let x = e; x; x = x.parentElement) { const p = parse(getComputedStyle(x).backgroundColor); if (p.length < 4 || p[3] > 0.5) return p; } return [255, 255, 255]; };
      const ratio = e => { const a = lum(parse(getComputedStyle(e).color)), b = lum(bgOf(e)); return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2); };
      const row = document.querySelector("#v-rank .lost");
      const out = { overflow: document.documentElement.scrollWidth - innerWidth, text: ratio(row.querySelector("span")), buttons: [] };
      row.querySelectorAll("button").forEach(b => { const q = b.getBoundingClientRect(); const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); out.buttons.push({ name: b.innerText, h: Math.round(q.height), free: !!hit && (hit === b || b.contains(hit)), ratio: ratio(b) }); });
      return out;
    })()`);
    assert.ok(r.overflow <= 0, "sideways scroll " + r.overflow);
    assert.ok(r.text >= 4.5, "row text contrast " + r.text);
    assert.equal(r.buttons.length, 2);
    for (const b of r.buttons) {
      assert.ok(b.free, `«${b.name}» is covered`);
      assert.ok(b.h >= 30, `«${b.name}» is only ${b.h}px tall`);
      assert.ok(b.ratio >= 4.5, `«${b.name}» contrast ${b.ratio}`);
    }
    assert.deepEqual(page.takeErrors(), []);
  });
}

/* ---------- cycle 2: the same field changed on both phones after a background check ---------- */

test("Vika's question that arrived with a background check is not overwritten silently when I save my own", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await page.fill('#placeForm [name="questions"]', "Мой вопрос");
  await otherPhone("places/porto.json", `d => Object.assign(d, { questions: d.questions + "\\nВопрос Вики" })`);
  await page.eval(`import("./js/app.js").then(m => m.state.data.poll())`);
  await page.waitFor(`import("./js/app.js").then(m => /Вопрос Вики/.test((m.state.data.docOf("places/porto.json") || {}).questions || ""))`, 6000, "background check");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText`, 6000, "save result");
  const msg = await page.text("#placeMsg");
  assert.match(msg, /другом устройстве/, `Vika's question is about to be lost without a word: «${msg}»`);
  assert.match(msg, /Вопрос Вики/, `the warning does not show what the other phone wrote: «${msg}»`);
  assert.match((await remote("places/porto.json")).questions, /Вопрос Вики/, "the first tap already overwrote the other phone");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`/сохранен/i.test(document.getElementById("placeMsg").innerText)`, 6000, "second tap saved");
  assert.equal((await remote("places/porto.json")).questions, "Мой вопрос", "after seeing the warning, the second tap writes mine");
});

test("Vika's rent that arrived with a background check is shown before my number replaces it", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await page.fill('#factsForm [name="fact_rent"]', "800");
  await otherPhone("places/porto.json", `d => Object.assign(d, { facts: { rent: { v: 1150, src: "Вика, агентство", at: "2026-10-29" } } })`);
  await comeBack();
  await page.waitFor(`import("./js/app.js").then(m => ((m.state.data.docOf("places/porto.json") || {}).facts || {}).rent)`, 6000, "background check on return to the app");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`document.getElementById("factsMsg").innerText`, 6000, "save result");
  assert.match(await page.text("#factsMsg"), /1\s?150/);
  assert.equal((await remote("places/porto.json")).facts.rent.v, 1150);
});

test("saving the same card field twice while the numbers are half-typed never warns about another device", { skip }, async () => {
  await fresh({ hash: "#/place/porto" });
  await page.fill('#factsForm [name="fact_dinner"]', "35");
  for (const q of ["Первый вопрос", "Второй вопрос"]) {
    await page.fill('#placeForm [name="questions"]', q);
    await page.tap({ text: "Сохранить карточку" });
    await page.waitFor(`/сохранен|другом/i.test(document.getElementById("placeMsg").innerText)`, 6000, "save result");
    const msg = await page.text("#placeMsg");
    assert.doesNotMatch(msg, /другом устройстве/, `my own previous save is reported as another device: «${msg}»`);
    await page.eval(`document.getElementById("placeMsg").textContent = ""`);
  }
  assert.equal((await remote("places/porto.json")).questions, "Второй вопрос");
  assert.equal(await value('#factsForm [name="fact_dinner"]'), "35", "the half-typed number is still there");
});

/* ---------- cycle 2: first start with a key GitHub refuses, or GitHub down ---------- */

for (const [code, re, what] of [[401, /ключ/i, "a refused key"], [503, /GitHub/, "GitHub down"]]) {
  test(`on a first start with ${what}, the ranking, the table and the rating form name the real reason, not the network`, { skip }, async () => {
    await fresh({ hash: "#/rank", offline: true, files: null });
    await knob("mock:offline", null);
    await knob("test:status", code);
    await page.tap({ sel: "#syncBtn" });
    await page.waitFor(`["Ключ не подходит", "Ошибка связи"].includes(document.getElementById("syncText").innerText)`, 6000, "failure shown");
    await sleep(200);
    const rank = await page.text("#rank"), heat = await page.eval(`document.querySelectorAll("#v-rank .block")[1].innerText`);
    for (const [where, t] of [["ranking", rank], ["table", heat]]) {
      assert.doesNotMatch(t, /появится связь|когда будет связь/, `${where} blames the network: «${t}»`);
      assert.match(t, re, `${where} does not say what is wrong: «${t}»`);
    }
    await go("#/rate");
    const hint = await page.text("#fPlaceHint");
    assert.doesNotMatch(hint, /связь/, `the rating form blames the network: «${hint}»`);
    assert.match(hint, re, `the rating form does not say why there are no places: «${hint}»`);
    await knob("test:status", null);
  });
}

test("with no key at all, the rating form says places come after connecting the data and links to settings", { skip }, async () => {
  await fresh({ hash: "#/rate", token: false, files: null });
  const hint = await page.text("#fPlaceHint");
  assert.doesNotMatch(hint, /связь/, `nothing is wrong with the network: «${hint}»`);
  assert.match(hint, /ключ|подключ/i);
  assert.ok(await page.eval(`!!document.querySelector('#fPlaceHint a[href="#/settings"]')`), "no link to settings");
});

/* ---------- cycle 2: long messages stay long enough to read ---------- */

test("a long message after a save stays on screen long enough to read it, a short one goes away quickly", { skip }, async () => {
  await fresh({ hash: "#/rate/new/batumi" });
  await score("интернет", 4);
  await press("#fSave");
  const long = await toastSeen(/Сохранено/);
  assert.ok(long.length > 80, "fixture: the save message is long: " + long);
  await sleep(5000);
  assert.equal(await page.eval(`document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText`), long, "a long message vanished before it could be read");
  await page.waitFor(`document.getElementById("toast").hidden`, 6000, "long toast goes away by itself");
  await page.tap({ sel: "#themeBtn" });
  await toastSeen(/Тема/);
  await sleep(4000);
  assert.equal(await page.eval(`document.getElementById("toast").hidden`), true, "a short message lingers too long");
  await page.tap({ sel: "#themeBtn" });
  await page.tap({ sel: "#themeBtn" });
});

test("the message about a change the other phone made says where to decide, and on the map points to the status button", { skip }, async () => {
  await clashOnPorto(fillCard("questions", "Мой вопрос"), `d => Object.assign(d, { questions: "Вопрос Вики" })`);
  const said = (await toasts()).find(t => /Не отправлено/.test(t)) || "";
  assert.match(said, /плашк/, `«${said}» does not say where the buttons are`);
  assert.ok(said.length <= 110, `the message is too long to read on a phone: ${said.length} characters`);
  assert.ok(await page.eval(`!!document.querySelector(".view:not([hidden]) .banner.err .lost")`), "the red banner with the buttons is on this screen");

  await fresh({ hash: "#/place/porto" });
  await offline();
  await fillCard("archetype", "город у океана")();
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 1`, 4000, "queued");
  await go("#/map");
  await otherPhone("places/porto.json", `d => Object.assign(d, { archetype: "курорт" })`);
  await page.eval(`window.__toasts.length = 0`);
  await backOnline();
  const onMap = (await toasts()).find(t => /Не отправлено/.test(t)) || "";
  assert.match(onMap, /вверху/, `on the map there is no red banner, yet the message says «${onMap}»`);
  assert.match(await syncText(), /Не отправлено/, "the status button the message points to");
});
