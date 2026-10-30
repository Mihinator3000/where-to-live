import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, mockFiles } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page, UA;

// Extra knobs for this file only: records GitHub calls in window.__gh, answers GitHub with the HTTP status in
// localStorage "test:status", and pretends the app was opened from the home screen when "test:standalone" is set.
const PROBE = `(() => {
  const inner = window.fetch;
  window.__gh = [];
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.github.com/")) {
      window.__gh.push((init.method || "GET") + " " + new URL(url).pathname);
      const st = localStorage.getItem("test:status");
      if (st) { await new Promise(r => setTimeout(r, 50)); return new Response(JSON.stringify({ message: "test" }), { status: Number(st), headers: { "Content-Type": "application/json" } }); }
    }
    return inner(input, init);
  };
  if (localStorage.getItem("test:standalone")) Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
})();`;

before(async () => {
  srv = await serve();
  page = await launch();
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  UA = await page.eval("navigator.userAgent");
});
after(async () => { await page?.close(); await srv?.close(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEW = { map: "v-map", rank: "v-rank", places: "v-places", place: "v-place", rate: "v-rate", settings: "v-settings" };
const js = v => JSON.stringify(v);

const syncText = () => page.text("#syncText");
const syncDot = () => page.eval(`document.getElementById("syncDot").className`);
const stored = k => page.eval(`JSON.parse(localStorage.getItem(${js("wtl:" + k)}))`);
const lostCount = () => page.eval(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length`);
const pendingCount = () => page.eval(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length`);
const pressed = sel => page.eval(`[...document.querySelectorAll(${js(sel + " button")})].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.innerText.trim()).join(",")`);
const tokenField = () => page.eval(`document.querySelector('#tokenForm [name="token"]').value`);
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const remoteDoc = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const comeBack = () => page.eval(`document.dispatchEvent(new Event("visibilitychange"))`);
const screenText = () => page.eval(`[document.querySelector(".appbar"), document.querySelector(".view:not([hidden])")].map(e => e.innerText).join("\\n")`);
const bodyIsDark = () => page.eval(`(() => { const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number); return r + g + b < 200; })()`);

async function go(hash) {
  await page.eval(`location.hash = ${js(hash)}`);
  await page.waitFor(`!document.getElementById(${js(VIEW[hash.split("/")[1]])}).hidden`, 4000, "view " + hash);
  await sleep(150);
}

async function reload() {
  await page.eval(`window.__stale = 1`);
  await page.send("Page.reload");
  await page.waitFor(`!window.__stale && document.readyState === "complete" && document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app reloaded");
  await sleep(150);
}

// Another device commits a file: the mock repo changes and its head moves.
const editRemote = (path, doc) => page.eval(`(() => {
  const f = JSON.parse(localStorage.getItem("mock:files"));
  ${doc == null ? `delete f[${js(path)}];` : `f[${js(path)}] = ${js(JSON.stringify(doc, null, 1) + "\n")};`}
  localStorage.setItem("mock:files", JSON.stringify(f));
  localStorage.setItem("mock:head", "h" + (Number((localStorage.getItem("mock:head") || "h0").slice(1)) + 1));
})()`);

const vikaRating = id => ({ id, place: "batumi", who: "Вика", start: "2026-09-01", end: "2026-09-10", days: 10, season: "пик", mode: "отпуск", scores: { "интернет": 4, "улица": 4 }, conf: {}, notes: {}, review: "", deleted: false, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });

async function submitToken(value) {
  if (value != null) await page.fill('#tokenForm [name="token"]', value);
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`!/Проверяю ключ|Загружаю данные/.test(document.getElementById("tokenMsg").innerText)`, 6000, "token check finished");
}

async function saveCardOffline(id, field, value) {
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.fill(`#placeForm [name="${field}"]`, value);
  await page.tap({ text: "Сохранить карточку" });
  assert.match(await toastText(/Нет связи/), /отправится позже/);
}

const CAPTURE_DOWNLOAD = `(() => {
  window.__dl = [];
  const orig = URL.createObjectURL; let last = null;
  URL.createObjectURL = b => { last = b; return orig.call(URL, b); };
  HTMLAnchorElement.prototype.click = function () { const a = this, b = last; if (b) b.text().then(t => window.__dl.push({ name: a.download, type: b.type, text: t })); };
})()`;

const AUDIT = `(() => {
  const out = { unnamed: [], small: [], covered: [], overflow: document.documentElement.scrollWidth - innerWidth };
  const vis = e => { if (e.closest("[hidden], .leaflet-container")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = e => (e.getAttribute("aria-label") || e.title || e.innerText || e.value || e.placeholder || (e.id && document.querySelector('label[for="' + e.id + '"]')?.innerText) || e.closest("label")?.innerText || "").trim();
  const desc = e => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : "")) + " «" + name(e).slice(0, 30) + "»";
  const view = document.querySelector(".view:not([hidden])");
  view.querySelectorAll("details").forEach(d => { d.open = true; });
  const els = [...document.querySelectorAll(".appbar button, .appbar a, .bottomnav a")].concat([...view.querySelectorAll("button, a[href], input, select, textarea, summary")]).filter(vis);
  for (const e of els) {
    if (!name(e) && e.type !== "hidden") out.unnamed.push(desc(e));
    const inline = e.tagName === "A" && getComputedStyle(e).display === "inline" || e.classList.contains("linkbtn");
    const r = e.getBoundingClientRect();
    if (!inline && !["checkbox", "radio", "range"].includes(e.type) && Math.min(r.width, r.height) < 24) out.small.push(desc(e) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    if (!e.closest(".appbar, .bottomnav, .savebar, #sheet, .map-top")) e.scrollIntoView({ block: "center" });
    const b = e.getBoundingClientRect();
    const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(b.top + b.height / 2, 1), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !(e.tagName === "INPUT" && hit.closest("label") === e.closest("label"))) out.covered.push(desc(e) + " under " + (hit.id ? "#" + hit.id : hit.className || hit.tagName));
  }
  scrollTo(0, 0);
  return out;
})()`;

/* ---------- who am I on this device ---------- */

test("choosing who I am in settings marks that person and is remembered after a reload", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  assert.equal(await pressed("#meSeg"), "Михаил");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  assert.equal(await pressed("#meSeg"), "Вика");
  assert.equal(await stored("me"), "Вика");
  await reload();
  assert.equal(await pressed("#meSeg"), "Вика");
  assert.deepEqual(page.takeErrors(), []);
});

test("switching the device person hides the other person's ratings and shows the new person's own", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/tbilisi" });
  let t = await page.text("#v-place");
  assert.match(t, /Вика: оценка скрыта/);
  assert.doesNotMatch(t, /Пыльно и шумно/);
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  await go("#/place/tbilisi");
  t = await page.text("#v-place");
  assert.match(t, /Пыльно и шумно/, "Вика sees her own review");
  assert.doesNotMatch(t, /оценка скрыта/);
  await go("#/place/valensiya");
  assert.match(await page.text("#v-place"), /Михаил: оценка скрыта/, "Михаил's rating is hidden from Вика until she rates");
  await go("#/place/porto");
  t = await page.text("#v-place");
  assert.match(t, /Красиво, но сыро/);
  assert.match(t, /Много холмов/, "a place both rated shows both");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Михаил"]' });
  await go("#/place/tbilisi");
  assert.match(await page.text("#v-place"), /Вика: оценка скрыта/, "switching back hides it again");
});

test("the rating form uses the person chosen in settings", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  assert.equal(await pressed("#fWho"), "Михаил");
  await go("#/settings");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  await go("#/rate");
  assert.equal(await pressed("#fWho"), "Вика", "«Кто оценивает» still shows the previous person, a new rating would be saved under the wrong name");
});

test("the «Кто вы на этом устройстве?» banner sets the person and hides the partner's rating at once", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/tbilisi", me: null });
  assert.match(await page.text("#v-place .banner"), /Кто вы на этом устройстве\?/);
  await page.tap({ text: "Михаил", within: "#v-place .banner" });
  assert.match(await toastText(/Это устройство/), /Это устройство: Михаил/);
  assert.equal(await stored("me"), "Михаил");
  const t = await page.text("#v-place");
  assert.doesNotMatch(t, /Кто вы на этом устройстве/);
  assert.match(t, /Вика: оценка скрыта/);
  assert.doesNotMatch(t, /Пыльно и шумно/);
});

test("answering «Кто вы» on the rating screen also fills «Кто оценивает»", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate", me: null });
  assert.equal(await pressed("#fWho"), "");
  await page.tap({ text: "Вика", within: "#rateBanner" });
  assert.match(await toastText(/Это устройство/), /Вика/);
  assert.equal(await pressed("#fWho"), "Вика", "the banner went away but the form still has nobody selected");
});

/* ---------- access key ---------- */

test("a valid key pasted with spaces is trimmed, checked, saved and loads our data", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  assert.equal(await syncText(), "Не подключено");
  assert.equal(await page.visible("#forget"), false);
  await submitToken("  github_pat_TEST_fresh  ");
  assert.match(await page.text("#tokenMsg"), /Подключено: мест 6, оценок 4/);
  assert.match(await toastText(/Подключено/), /данные загружены/);
  assert.equal(await stored("token"), "github_pat_TEST_fresh");
  assert.equal(await tokenField(), "", "the key is not left in the field");
  assert.equal(await syncText(), "Подключено");
  assert.equal(await syncDot(), "dot live");
  assert.equal(await page.visible("#forget"), true);
  assert.match(await page.text("#tokenForm .lbl"), /уже сохранён/);
  await go("#/rank");
  const t = await page.text("#v-rank");
  assert.doesNotMatch(t, /Данные не подключены/);
  assert.match(t, /Порту/);
  assert.deepEqual(page.takeErrors(), []);
});

test("a wrong key on a new device is not saved, stays in the field to fix, and the app stays disconnected", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  await submitToken("github_pat_NOPE");
  const msg = await page.text("#tokenMsg");
  assert.match(msg, /Ключ не подошёл, он не сохранён/);
  assert.doesNotMatch(msg, /Остался прежний ключ/, "there was no previous key");
  assert.equal(await page.eval(`document.getElementById("tokenMsg").classList.contains("err")`), true);
  assert.equal(await stored("token"), null);
  assert.equal(await tokenField(), "github_pat_NOPE");
  assert.equal(await syncText(), "Не подключено");
});

test("a new valid key replaces the saved one", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await submitToken("github_pat_TEST_second");
  assert.match(await toastText(/Подключено/), /данные загружены/);
  assert.equal(await stored("token"), "github_pat_TEST_second");
  assert.equal(await syncText(), "Подключено");
});

test("pressing «Сохранить и проверить» with an empty field keeps the saved key and reloads the data", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  assert.match(await page.text("#tokenMsg"), /оценок 4/);
  await editRemote("ratings/r9.json", vikaRating("r9"));
  await submitToken(null);
  assert.match(await page.text("#tokenMsg"), /Подключено: мест 6, оценок 5/);
  assert.equal(await stored("token"), "github_pat_TEST_e2e");
});

test("pressing «Сохранить и проверить» with an empty field on a new device asks for a key", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`document.getElementById("tokenMsg").innerText.trim() !== ""`, 1500).catch(() => {});
  assert.match(await page.text("#tokenMsg"), /ключ/i, "the button does nothing visible: no message, still «Не подключено»");
  assert.equal(await stored("token"), null);
});

test("a key checked while offline is not saved, the old key stays and the typed key is kept", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await submitToken("github_pat_TEST_new");
  const msg = await page.text("#tokenMsg");
  assert.match(msg, /Нет связи, ключ не проверен и не сохранён/);
  assert.match(msg, /Остался прежний ключ/);
  assert.equal(await stored("token"), "github_pat_TEST_e2e");
  assert.equal(await tokenField(), "github_pat_TEST_new");
});

test("the offline key message says «Нет связи» once", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await submitToken("github_pat_TEST_new");
  const msg = await page.text("#tokenMsg");
  assert.equal((msg.match(/Нет связи/g) || []).length, 1, msg);
});

test("a pasted key survives tapping the person and theme buttons on the same page", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_typed");
  await page.tap({ sel: '#meSeg [data-me="Вика"]' });
  assert.equal(await tokenField(), "github_pat_TEST_typed", "choosing «Вика» wiped the pasted key");
  await page.tap({ sel: '#themeSeg [data-theme="dark"]' });
  assert.equal(await tokenField(), "github_pat_TEST_typed", "choosing a theme wiped the pasted key");
  await page.tap({ sel: "#themeBtn" });
  assert.equal(await tokenField(), "github_pat_TEST_typed", "the top theme button wiped the pasted key");
});

test("a data repository without the owner part is refused instead of silently disconnecting", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ text: "Технические подробности" });
  const before = await page.eval(`document.querySelector('#tokenForm [name="repo"]').value`);
  await page.fill('#tokenForm [name="repo"]', "where-to-live-data");
  await submitToken(null);
  assert.match(await page.text("#tokenMsg"), /\S/, "no message at all after saving");
  assert.equal(await stored("repo") || before, before, "the broken repo name was saved");
  assert.notEqual(await syncText(), "Не подключено", "with a saved key the app now says «Не подключено» and the sync button does nothing");
});

test("a changed data repository is saved and used in the key instructions", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ text: "Технические подробности" });
  assert.match(await page.eval(`document.querySelector('#tokenForm [name="repo"]').value`), /^[\w.-]+\/where-to-live-data$/);
  await page.fill('#tokenForm [name="repo"]', " Test-Owner/where-to-live-copy ");
  await submitToken(null);
  assert.match(await page.text("#tokenMsg"), /Подключено/);
  assert.equal(await stored("repo"), "Test-Owner/where-to-live-copy");
  await go("#/map");
  await go("#/settings");
  assert.equal(await page.eval(`document.querySelector('#tokenForm [name="repo"]').value`), "Test-Owner/where-to-live-copy");
  assert.match(await page.eval(`document.getElementById("tokenForm").textContent`), /where-to-live-copy/, "the how-to steps name the repo");
});

/* ---------- forget the key ---------- */

test("«Забыть ключ» disarms itself after a few seconds when the second tap does not come", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ sel: "#forget" });
  assert.match(await page.text("#forget"), /Точно забыть\? Нажмите ещё раз/);
  await page.waitFor(`document.getElementById("forget").innerText.trim() === "Забыть ключ на этом устройстве"`, 7000, "button disarmed");
  assert.equal(await stored("token"), "github_pat_TEST_e2e");
  await page.tap({ sel: "#forget" });
  assert.match(await page.text("#forget"), /Точно забыть/, "the first tap after disarming asks again");
  assert.equal(await stored("token"), "github_pat_TEST_e2e");
});

test("forgetting the key disconnects the device and removes the cached data", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ sel: "#forget" });
  await page.tap({ sel: "#forget" });
  assert.match(await toastText(/Ключ и кэш удалены/), /с этого устройства/);
  assert.equal(await stored("token"), null);
  assert.equal(await stored("cache"), null);
  assert.equal(await syncText(), "Не подключено");
  assert.equal(await page.visible("#forget"), false);
  assert.equal(await page.text("#tokenMsg"), "");
  assert.doesNotMatch(await page.text("#tokenForm .lbl"), /уже сохранён/);
  await go("#/rank");
  const t = await page.text("#v-rank");
  assert.match(t, /Мест: 0 · оценок: 0/);
  assert.match(t, /Данные не подключены/);
  await page.tap({ sel: "#syncBtn" });
  assert.equal(await page.eval("location.hash"), "#/settings");
});

test("replacing the key with «Забыть ключ» keeps a half-filled rating", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.waitFor(`(JSON.parse(localStorage.getItem("wtl:draft")) || {}).place === "batumi"`, 3000, "draft saved");
  await go("#/settings");
  await page.tap({ sel: "#forget" });
  await page.tap({ sel: "#forget" });
  await toastText(/Ключ и кэш удалены/);
  await reload();
  await submitToken("github_pat_TEST_replacement");
  assert.match(await page.text("#tokenMsg"), /Подключено/);
  await go("#/rate");
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "batumi", "the unsaved rating was thrown away together with the key");
  assert.equal(await page.eval(`document.querySelector('[data-score="интернет"][data-v="4"]').getAttribute("aria-pressed")`), "true");
});

test("changes queued offline survive forgetting the key and are sent once a new key is saved", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/batumi" });
  await saveCardOffline("batumi", "questions", "Вопрос из очереди");
  await go("#/settings");
  await page.tap({ sel: "#forget" });
  await page.tap({ sel: "#forget" });
  assert.match(await toastText(/Ключ и кэш удалены/), /Неотправленные правки \(1\) уйдут после нового ключа/);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await submitToken("github_pat_TEST_again");
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue sent");
  assert.equal((await remoteDoc("places/batumi.json")).questions, "Вопрос из очереди");
});

/* ---------- theme ---------- */

test("theme buttons in settings switch the colours, mark the choice and are remembered", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  assert.equal(await pressed("#themeSeg"), "Как в системе");
  assert.equal(await bodyIsDark(), false);
  await page.tap({ sel: '#themeSeg [data-theme="dark"]' });
  assert.equal(await pressed("#themeSeg"), "Тёмная");
  assert.equal(await bodyIsDark(), true);
  assert.equal(await page.eval(`document.getElementById("themeBtn").getAttribute("aria-label")`), "Тема: тёмная");
  await reload();
  assert.equal(await bodyIsDark(), true);
  assert.equal(await pressed("#themeSeg"), "Тёмная");
  await page.tap({ sel: '#themeSeg [data-theme="auto"]' });
  assert.equal(await bodyIsDark(), false);
  assert.equal(await stored("theme"), "auto");
});

test("the top theme button cycles light, dark and system, and the settings buttons follow", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ sel: "#themeBtn" });
  assert.match(await toastText(/Тема: светлая/), /светлая/);
  assert.equal(await pressed("#themeSeg"), "Светлая");
  assert.equal(await bodyIsDark(), false);
  await page.tap({ sel: "#themeBtn" });
  assert.match(await toastText(/Тема: тёмная/), /тёмная/);
  assert.equal(await pressed("#themeSeg"), "Тёмная");
  assert.equal(await bodyIsDark(), true);
  await page.tap({ sel: "#themeBtn" });
  assert.match(await toastText(/как в системе/), /как в системе/);
  assert.equal(await pressed("#themeSeg"), "Как в системе");
  assert.equal(await bodyIsDark(), false);
});

test("«Светлая» overrides a dark phone and «Как в системе» follows it again", { skip }, async () => {
  await page.viewport(390, 844, { dark: true });
  try {
    await openApp(page, srv.url, { hash: "#/settings" });
    assert.equal(await bodyIsDark(), true);
    await page.tap({ sel: '#themeSeg [data-theme="light"]' });
    assert.equal(await bodyIsDark(), false);
    await page.tap({ sel: '#themeSeg [data-theme="auto"]' });
    assert.equal(await bodyIsDark(), true);
  } finally {
    await page.viewport(390, 844, { dark: false });
  }
});

test("a forced dark theme also colours the phone's status bar (theme-color)", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  const bar = () => page.eval(`(() => {
    const m = [...document.querySelectorAll('meta[name="theme-color"]')].find(m => !m.media || matchMedia(m.media).matches);
    const probe = document.createElement("i"); probe.style.color = m.content; document.body.appendChild(probe);
    const c = getComputedStyle(probe).color; probe.remove();
    return { bar: c, page: getComputedStyle(document.body).backgroundColor };
  })()`);
  let r = await bar();
  assert.equal(r.bar, r.page, "light: bar matches the page");
  await page.tap({ sel: '#themeSeg [data-theme="dark"]' });
  r = await bar();
  assert.equal(r.bar, r.page, "dark page under a light status bar");
});

/* ---------- world indicators ---------- */

test("turning world indicators off removes data-only scores everywhere and the choice sticks", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/belgrad" });
  const withData = await page.text("#v-place .bigscore b");
  assert.match(withData, /^\d\.\d$/, "Белград has a score from world data");
  await go("#/settings");
  assert.equal(await page.eval(`document.getElementById("useData").checked`), true);
  await page.tap({ sel: "label.toggle", text: "Учитывать мировые показатели" });
  assert.equal(await page.eval(`document.getElementById("useData").checked`), false);
  assert.equal(await stored("worldData"), false);
  await go("#/place/belgrad");
  assert.equal(await page.text("#v-place .bigscore b"), "—");
  await go("#/rank");
  assert.match(await page.text("#v-rank #rank"), /Ещё без оценок и данных:.*Белград/);
  assert.match(await page.eval(`document.querySelector(".rank-help").textContent`), /Мировые данные сейчас выключены в настройках/);
  await reload();
  await go("#/settings");
  assert.equal(await page.eval(`document.getElementById("useData").checked`), false, "still off after a reload");
  await page.tap({ sel: "label.toggle", text: "Учитывать мировые показатели" });
  await go("#/place/belgrad");
  assert.equal(await page.text("#v-place .bigscore b"), withData, "turning it back on restores the score");
});

/* ---------- copy of the data ---------- */

test("«Скачать JSON» downloads a dated file with places, ratings, weights, queued and unsent changes", { skip }, async () => {
  const files = repo({ weights: [{ id: "vika", who: "Вика", w: { legal: 20, money: 30, climate: 50 }, updatedAt: "2026-10-01T00:00:00.000Z" }] });
  const lost = [{ at: "2026-10-05T10:00:00.000Z", path: "places/porto.json", content: JSON.stringify({ id: "porto", name: "Порту", questions: "Старый вопрос" }), message: "Update place porto" }];
  await openApp(page, srv.url, { hash: "#/place/batumi", files, local: { "wtl:lost": lost } });
  await saveCardOffline("batumi", "questions", "Офлайн-вопрос");
  await go("#/settings");
  await page.eval(CAPTURE_DOWNLOAD);
  await page.tap({ text: "Скачать JSON" });
  await page.waitFor(`window.__dl.length === 1`, 3000, "download");
  const dl = await page.eval(`window.__dl[0]`);
  assert.match(dl.name, /^where-to-live-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(dl.type, "application/json");
  const j = JSON.parse(dl.text);
  assert.ok(!isNaN(Date.parse(j.exported)));
  assert.deepEqual(j.places.map(p => p.id).sort(), ["batumi", "belgrad", "porto", "sankt-peterburg", "tbilisi", "valensiya"]);
  assert.deepEqual(j.ratings.map(r => r.id).sort(), ["r1", "r2", "r3", "r4"], "all ratings, including the partner's hidden one");
  assert.deepEqual(j.weights.map(w => w.who), ["Вика"]);
  assert.equal(j.places.find(p => p.id === "batumi").questions, "Офлайн-вопрос", "a change still waiting in the queue is in the copy");
  assert.equal(j.notSent.length, 1);
  assert.equal(j.notSent[0].path, "places/porto.json");
  await page.eval(`localStorage.removeItem("mock:offline")`);
});

test("«Обновить из GitHub» loads a rating added on another device", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await editRemote("ratings/r9.json", vikaRating("r9"));
  await page.tap({ text: "Обновить из GitHub" });
  await page.waitFor(`/оценок 5/.test(document.getElementById("tokenMsg").innerText)`, 5000, "new count");
  await go("#/rank");
  assert.match(await page.text("#v-rank"), /оценок: 5/);
});

test("«Обновить из GitHub» without a key says that a key is needed", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings", token: false });
  await page.tap({ text: "Обновить из GitHub" });
  const shown = await page.eval(`[document.getElementById("tokenMsg").innerText, document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText].join(" ")`);
  assert.match(shown, /ключ/i, "the button does nothing visible");
});

/* ---------- sync indicator ---------- */

test("without a key the indicator says «Не подключено» and takes me to settings", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map", token: false });
  assert.equal(await syncText(), "Не подключено");
  assert.equal(await syncDot(), "dot");
  assert.equal(await page.eval(`document.getElementById("syncBtn").title`), "Подключить данные");
  await page.tap({ sel: "#syncBtn" });
  assert.equal(await page.eval("location.hash"), "#/settings");
  assert.equal(await page.visible("#tokenForm"), true);
});

test("the indicator says «Обновляю…» while loading and «Подключено» with a green dot after", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:delay", "1500")`);
  try {
    await page.tap({ sel: "#syncBtn" }, 50);
    assert.equal(await syncText(), "Обновляю…");
    assert.equal(await syncDot(), "dot sync");
    await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 8000, "loaded");
    assert.equal(await syncDot(), "dot live");
  } finally {
    await page.eval(`localStorage.removeItem("mock:delay")`);
  }
});

test("after a save the indicator shows when it was saved", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await toastText(/Карточка сохранена/);
  assert.match(await syncText(), /^Сохранено · \d{2}:\d{2}$/);
  assert.equal(await syncDot(), "dot live");
});

test("opening the app offline shows the cached data and says so", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await reload();
  assert.equal(await syncText(), "Офлайн · показан кэш");
  const t = await page.text("#v-rank");
  assert.match(t, /Порту/);
  assert.match(await page.text("#v-rank .banner.err"), /Нет связи/);
});

test("the very first start offline does not claim that a cache is shown", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank", offline: true });
  assert.match(await page.text("#v-rank"), /Мест: 0/);
  assert.doesNotMatch(await syncText(), /показан кэш/, "nothing was ever loaded on this device");
});

test("a saved key that GitHub rejects shows «Ключ не подходит» in red with a way to settings", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank", token: false, local: { "wtl:token": "github_pat_REVOKED" } });
  assert.equal(await syncText(), "Ключ не подходит");
  assert.equal(await syncDot(), "dot err");
  assert.match(await page.text("#v-rank .banner.err"), /Ключ доступа не подходит/);
  await page.tap({ sel: "a", within: "#v-rank .banner.err", text: "настройках" });
  assert.equal(await page.eval("location.hash"), "#/settings");
  assert.match(await page.text("#tokenMsg"), /не подходит/);
});

test("a rejected key is explained once and shown as an error in settings", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank", token: false, local: { "wtl:token": "github_pat_REVOKED" } });
  const banner = await page.text("#v-rank .banner.err");
  assert.equal((banner.match(/не подходит/g) || []).length, 1, banner);
  await go("#/settings");
  assert.equal(await page.eval(`document.getElementById("tokenMsg").classList.contains("err")`), true, "the problem is printed like a normal status line");
});

test("a GitHub server error shows «Ошибка связи» and clears on the next check", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`localStorage.setItem("test:status", "500")`);
  try {
    await page.tap({ sel: "#syncBtn" });
    await page.waitFor(`document.getElementById("syncText").innerText === "Ошибка связи"`, 5000, "error shown");
    assert.equal(await syncDot(), "dot err");
    assert.match(await page.text("#v-rank .banner.err"), /GitHub ответил 500/);
  } finally {
    await page.eval(`localStorage.removeItem("test:status")`);
  }
  await comeBack();
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "recovered");
  assert.equal(await page.visible("#v-rank .banner.err"), false);
});

test("an edit that clashes with another device is not reported as a connection error", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  const porto = await remoteDoc("places/porto.json");
  await editRemote("places/porto.json", Object.assign({}, porto, { questions: "Вопрос с ноутбука" }));
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`document.getElementById("placeMsg").innerText.trim() !== ""`, 6000, "save result");
  assert.match(await page.text("#placeMsg"), /изменили на другом устройстве/);
  assert.notEqual(await syncText(), "Ошибка связи", "the network is fine, only the card changed elsewhere");
  assert.notEqual(await syncDot(), "dot err");
});

test("saving the card again after a clash writes my field over and keeps the other device's change", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  const porto = await remoteDoc("places/porto.json");
  await editRemote("places/porto.json", Object.assign({}, porto, { questions: "Вопрос с ноутбука" }));
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`/изменили на другом устройстве/.test(document.getElementById("placeMsg").innerText)`, 6000, "clash message");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).archetype === "город у океана"`, 6000, "saved over");
  const now = await remoteDoc("places/porto.json");
  assert.equal(now.questions, "Вопрос с ноутбука");
  assert.match(await syncText(), /^Сохранено/);
});

/* ---------- offline queue ---------- */

test("an offline save waits in the queue, survives a reload and is sent when the network is back", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await saveCardOffline("porto", "archetype", "город у океана");
  assert.equal(await syncText(), "В очереди: 1");
  assert.equal(await pendingCount(), 1);
  await comeBack();
  await page.waitFor(`document.getElementById("syncText").innerText === "Офлайн · в очереди: 1"`, 5000, "offline with queue");
  await reload();
  assert.equal(await syncText(), "Офлайн · в очереди: 1");
  assert.match(await page.text("#v-place"), /город у океана/, "my queued change is shown after the reload");
  assert.equal((await remoteDoc("places/porto.json")).archetype, "город у моря");
  await page.eval(`localStorage.removeItem("mock:offline"); window.dispatchEvent(new Event("online"))`);
  assert.match(await toastText(/Отправлено из очереди/), /Отправлено из очереди: 1/);
  assert.equal(await pendingCount(), 0);
  assert.equal((await remoteDoc("places/porto.json")).archetype, "город у океана");
  assert.match(await syncText(), /^Сохранено · /);
});

test("queued changes are sent when I come back to the app", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await saveCardOffline("porto", "questions", "Где парковаться?");
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await comeBack();
  assert.match(await toastText(/Отправлено из очереди/), /: 1/);
  assert.equal((await remoteDoc("places/porto.json")).questions, "Где парковаться?");
});

/* ---------- clashes: «Не отправлено» ---------- */

test("a queued card edit that clashes lands in «Не отправлено» and «Записать мою» writes it over", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await saveCardOffline("porto", "questions", "Мой вопрос с телефона");
  const porto = await remoteDoc("places/porto.json");
  await editRemote("places/porto.json", Object.assign({}, porto, { questions: "Вопрос с ноутбука" }));
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await go("#/rank");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 1`, 6000, "clash recorded");
  await page.waitFor(`document.querySelector("#v-rank .lost")`, 3000, "lost row");
  const banner = await page.text("#v-rank .banner.err");
  assert.match(banner, /Не отправлено: это же изменили на другом устройстве/);
  assert.match(banner, /Карточка «Порту»: Мой вопрос с телефона/);
  await page.tap({ text: "Записать мою", within: "#v-rank .lost" });
  assert.match(await toastText(/Записано поверх/), /Записано поверх/);
  assert.equal(await lostCount(), 0);
  assert.equal((await remoteDoc("places/porto.json")).questions, "Мой вопрос с телефона");
  assert.equal(await page.eval(`!!document.querySelector("#v-rank .lost")`), false);
});

test("«Выбросить» drops my clashed rating and keeps the other device's version", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.tap({ text: "Изменить", within: '#v-place .trip[data-rid="r1"]' });
  await page.waitFor(`location.hash === "#/rate" && !document.getElementById("v-rate").hidden`, 3000, "rating form");
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await page.tap({ sel: '[data-score="интернет"][data-v="2"]' });
  await page.tap({ sel: "#fSave" });
  assert.match(await toastText(/Нет связи/), /отправится позже/);
  const r1 = await remoteDoc("ratings/r1.json");
  await editRemote("ratings/r1.json", Object.assign({}, r1, { review: "Правка с ноутбука" }));
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await go("#/rank");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`document.querySelector("#v-rank .lost")`, 6000, "lost row");
  assert.match(await page.text("#v-rank .lost"), /Оценка: Порту · Михаил/);
  await page.tap({ text: "Выбросить", within: "#v-rank .lost" });
  await page.waitFor(`!document.querySelector("#v-rank .lost")`, 3000, "row gone");
  assert.equal(await lostCount(), 0);
  const now = await remoteDoc("ratings/r1.json");
  assert.equal(now.review, "Правка с ноутбука");
  assert.equal(now.scores["интернет"], 4);
  await go("#/place/porto");
  assert.match(await page.text("#v-place"), /Правка с ноутбука/);
});

test("a change that was not sent is visible on the map and in settings too", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await saveCardOffline("porto", "questions", "Мой вопрос с телефона");
  const porto = await remoteDoc("places/porto.json");
  await editRemote("places/porto.json", Object.assign({}, porto, { questions: "Вопрос с ноутбука" }));
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await go("#/map");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:lost") || "[]").length === 1`, 6000, "clash recorded");
  await sleep(200);
  assert.match(await screenText(), /Не отправлено/, `map shows only «${await syncText()}»: nothing says my edit was not sent`);
  await go("#/settings");
  assert.match(await screenText(), /Не отправлено/, "settings say nothing about the unsent edit");
});

/* ---------- background checks ---------- */

test("coming back to the app picks up a place added on another device", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  const batumi = await remoteDoc("places/batumi.json");
  await editRemote("places/kotor.json", Object.assign({}, batumi, { id: "kotor", name: "Котор", country: "Черногория", cc: "MNE", lat: 42.4247, lon: 18.7712 }));
  await comeBack();
  await page.waitFor(`/Котор/.test(document.getElementById("v-places").innerText)`, 5000, "new place listed");
});

test("coming back to the app only asks for the latest commit when nothing changed", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  const at = (await stored("cache")).at;
  await page.eval(`window.__gh.length = 0`);
  await comeBack();
  await page.waitFor(`window.__gh.some(c => c.endsWith("/commits/main"))`, 4000, "head check");
  await sleep(400);
  assert.deepEqual(await page.eval(`window.__gh.filter(c => c.includes("/graphql"))`), [], "no full reload");
  assert.equal((await stored("cache")).at, at);
  assert.equal(await syncText(), "Подключено");
});

test("a background update does not wipe a key being typed", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.fill('#tokenForm [name="token"]', "github_pat_TEST_half");
  await editRemote("ratings/r9.json", vikaRating("r9"));
  await comeBack();
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:cache")).docs.ratings.length === 5`, 5000, "update loaded");
  await sleep(200);
  assert.equal(await tokenField(), "github_pat_TEST_half");
});

test("another device's card edit shows up on the open place and my later edit keeps it", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  const porto = await remoteDoc("places/porto.json");
  await editRemote("places/porto.json", Object.assign({}, porto, { questions: "Спросить про ипотеку" }));
  await comeBack();
  await page.waitFor(`/Спросить про ипотеку/.test(document.getElementById("v-place").innerText)`, 5000, "dossier updated");
  await page.fill('#placeForm [name="archetype"]', "город у океана");
  await page.tap({ text: "Сохранить карточку" });
  await toastText(/Карточка сохранена/);
  const now = await remoteDoc("places/porto.json");
  assert.equal(now.archetype, "город у океана");
  assert.equal(now.questions, "Спросить про ипотеку");
});

/* ---------- install hint ---------- */

test("on an iPhone browser the install hint comes first and disappears once installed", { skip }, async () => {
  await page.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  try {
    await openApp(page, srv.url, { hash: "#/settings" });
    const heads = () => page.eval(`[...document.querySelectorAll("#v-settings h2")].map(h => h.textContent)`);
    assert.equal((await heads())[0], "Сначала: установите на экран «Домой»");
    assert.match(await page.text("#v-settings"), /Safari → Поделиться → «На экран „Домой“»/);
    await openApp(page, srv.url, { hash: "#/settings", local: { "test:standalone": 1 } });
    assert.ok(!(await heads()).some(h => /экран «Домой»/.test(h)), "no install hint inside the installed app");
  } finally {
    await page.send("Emulation.setUserAgentOverride", { userAgent: UA });
  }
});

test("on a computer the install hint sits lower, after the main settings", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  const heads = await page.eval(`[...document.querySelectorAll("#v-settings h2")].map(h => h.textContent)`);
  assert.ok(heads.indexOf("На экран «Домой»") > heads.indexOf("Вид"), heads.join(" | "));
});

test("on an Android phone the install hint explains Android, not only Safari", { skip }, async () => {
  await page.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36" });
  try {
    await openApp(page, srv.url, { hash: "#/settings" });
    const hint = await page.text("#v-settings .block .help");
    assert.match(hint, /Android|Chrome/, hint);
  } finally {
    await page.send("Emulation.setUserAgentOverride", { userAgent: UA });
  }
});

/* ---------- layout ---------- */

test("settings and sync banners fit phone and desktop in dark mode with every control tappable", { skip }, async () => {
  const lost = [{ at: "2026-10-05T10:00:00.000Z", path: "places/porto.json", content: JSON.stringify({ id: "porto", name: "Порту", questions: "Очень длинный вопрос про сырость и отопление зимой в старом доме у реки" }), message: "Update place porto" }];
  try {
    for (const [w, h] of [[390, 844], [1280, 800]]) {
      await page.viewport(w, h, { dark: true });
      for (const [what, opts] of [["settings without key", { hash: "#/settings", token: false }], ["settings with key", { hash: "#/settings" }], ["rank with «Кто вы» and «Не отправлено»", { hash: "#/rank", me: null, local: { "wtl:lost": lost } }]]) {
        await openApp(page, srv.url, opts);
        const r = await page.eval(AUDIT);
        const where = `${what} at ${w}px`;
        assert.deepEqual(r.unnamed, [], where + ": controls without a name");
        assert.deepEqual(r.small, [], where + ": tap targets under 24px");
        assert.deepEqual(r.covered, [], where + ": covered controls");
        assert.ok(r.overflow <= 1, `${where}: sideways scroll ${r.overflow}px`);
        assert.equal(await page.eval(`document.getElementById("syncText").scrollWidth <= document.getElementById("syncText").clientWidth`), true, where + ": sync text cut off");
      }
    }
    assert.deepEqual(page.takeErrors(), []);
  } finally {
    await page.viewport(390, 844, { dark: false });
  }
});
