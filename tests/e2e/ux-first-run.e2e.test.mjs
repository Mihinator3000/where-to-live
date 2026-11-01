import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, mockFiles, settleMap } from "./fixtures.mjs";

// Persona «первый запуск»: someone opens the site for the first time on an iPhone, knows nothing,
// has no key and no data yet. Synthetic data only; GitHub and Nominatim are mocked.

const skip = !CHROME && "no Chrome";
let srv, page, UA;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

before(async () => { srv = await serve(); page = await launch(); UA = await page.eval("navigator.userAgent"); });
after(async () => { await page?.close(); await srv?.close(); });

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = `(await import("./js/app.js")).state`;
const VIS = `(e => { if (!e || e.closest("[hidden]")) return false; for (let d = e.closest("details"); d; d = d.parentElement.closest("details")) if (!d.open && !(e.closest("summary") && e.closest("summary").parentElement === d)) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })`;

async function asIPhone(fn) {
  await page.send("Emulation.setUserAgentOverride", { userAgent: IPHONE });
  try { return await fn(); } finally { await page.send("Emulation.setUserAgentOverride", { userAgent: UA }); }
}

// A brand-new device: no key, nobody chosen, intro not seen, nothing in the data repository unless given.
async function cold({ w = 390, h = 844, dark = false, ...opts } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, Object.assign({ files: null, token: false, me: "", intro: true }, opts));
  if (!opts.hash || opts.hash === "#/map") await page.waitFor(`(async () => !!(${APP}).mapView)()`, 8000, "map ready");
}

async function open({ w = 390, h = 844, dark = false, ...opts } = {}) {
  await page.viewport(w, h, { dark });
  await openApp(page, srv.url, opts);
}

const sheetOpen = () => page.eval(`!document.getElementById("sheet").hidden`);
const sheetText = () => page.eval(`document.getElementById("sheet").hidden ? "" : document.getElementById("sheetBody").innerText`);
const sheetTitle = () => page.eval(`document.getElementById("sheet").hidden ? "" : (document.querySelector("#sheetBody h3") || {}).innerText || ""`);
const waitIntro = () => page.waitFor(`!document.getElementById("sheet").hidden && /Как пользоваться/.test((document.querySelector("#sheetBody h3") || {}).innerText || "")`, 6000, "intro sheet");
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const viewText = id => page.eval(`document.getElementById(${JSON.stringify(id)}).innerText`);
const stored = k => page.eval(`JSON.parse(localStorage.getItem("wtl:" + ${JSON.stringify(k)}) || "null")`);
const hrefsIn = sel => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel + " a[href]")})].filter(${VIS}).map(a => a.getAttribute("href"))`);

async function pasteKey(key) {
  await page.fill('#tokenForm [name="token"]', key);
  await page.tap({ text: "Сохранить и проверить", within: "#tokenForm" });
  return page.waitFor(`(() => { const t = document.getElementById("tokenMsg").innerText; return t && !/Проверяю|Загружаю/.test(t) && t; })()`, 8000, "key checked");
}

const keyStepsDetails = `[...document.querySelectorAll("#tokenForm details")].find(d => /Как получить ключ/.test(d.querySelector("summary").innerText))`;

/* ---------- 1. the very first screen ---------- */

test("on the very first visit the intro says what the app is for, not only how the map works", { skip }, async () => {
  await cold();
  await waitIntro();
  const t = await sheetText();
  assert.match(t, /(выб(ор|ира|ер|рать)|сравн[а-яё]+|решить|решаем)[^.]{0,60}(где жить|куда переехать|места? для жизни|переезд)/i,
    "a first-time user cannot tell what the app is for; the intro only explains pins and buttons: " + t);
});

test("the first-visit intro explains what «мировые данные» are where it first mentions them", { skip }, async () => {
  await cold();
  await waitIntro();
  const t = await sheetText();
  assert.match(t, /мировы[ем] данны[ем]/i, "the intro mentions world data");
  assert.match(t, /(показател[а-яё]* стран|статистик|климат)/i, "«мировые данные» are used but never explained: " + t);
});

test("on a phone the first-visit intro fits on screen and leaves the search box and «Слои» uncovered", { skip }, async () => {
  await cold();
  await waitIntro();
  const fit = await page.eval(`(() => { const b = document.getElementById("sheetBody"); return b.scrollHeight <= b.clientHeight + 1; })()`);
  assert.equal(fit, true, "the intro has to be scrolled to reach its end");
  const ok = await page.locate({ text: "Понятно", within: "#sheet" });
  assert.equal(ok.covered, "", "«Понятно» is covered");
  assert.equal((await page.locate({ sel: "#searchInput" })).covered, "", "the search box is under the intro");
  assert.equal((await page.locate({ sel: "#layersBtn" })).covered, "", "«Слои» is under the intro");
});

test("the intro's link to settings opens them, and the intro does not pop up again on the map", { skip }, async () => {
  await cold();
  await waitIntro();
  await page.tap({ sel: "a", text: "настройках", within: "#sheet" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  assert.equal(await page.visible('#tokenForm [name="token"]'), true, "the key field is on the settings screen");
  await page.tap({ sel: ".bottomnav a", text: "Карта" });
  await sleep(400);
  assert.equal(await sheetOpen(), false, "the intro came back after the user already followed it");
});

test("after «Понятно» the map help can be opened again", { skip }, async () => {
  await cold();
  await waitIntro();
  await page.tap({ text: "Понятно", within: "#sheet" });
  const HELP = /как пользоваться|подсказк|справк|помощь|что здесь/i;
  const findHelp = () => page.eval(`(() => { const vis = ${VIS}; const e = [...document.querySelectorAll("button, a, [role=button], summary")].filter(vis).find(e => ${HELP}.test([e.innerText, e.getAttribute("aria-label"), e.title].join(" "))); if (!e) return false; document.querySelectorAll("[data-test-help]").forEach(x => x.removeAttribute("data-test-help")); e.setAttribute("data-test-help", "1"); return true; })()`);
  let found = await findHelp();
  if (!found) { await page.goto(srv.url + "#/settings", 300); found = await findHelp(); }
  assert.ok(found, "once dismissed, the only explanation of pins, colours and «Слои» is gone for good: no help button on the map or in settings");
  await page.tap({ sel: "[data-test-help]" });
  await page.waitFor(`location.hash === "#/map" || location.hash === ""`, 3000, "map");
  await waitIntro();
});

test("with the intro already seen and no key, the map itself still says how to connect the data", { skip }, async () => {
  await cold({ intro: false });
  assert.equal(await sheetOpen(), false);
  const hints = await page.eval(`(() => { const vis = ${VIS}; return [...document.querySelectorAll("#v-map *, .appbar *")].filter(e => !e.closest("#syncBtn") && !e.closest(".leaflet-container") && vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && /ключ|подключ/i.test(n.textContent))).map(e => e.textContent.trim()); })()`);
  assert.ok(hints.length, "an empty map with only a small grey «Не подключено» in the corner: nothing tells a newcomer to paste a key");
});

test("the header status of a new device says «Не подключено» and opens the key form", { skip }, async () => {
  await cold({ intro: false });
  assert.equal(await page.text("#syncText"), "Не подключено");
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  assert.equal(await page.visible('#tokenForm [name="token"]'), true);
});

test("on a 1280 desktop the first-run intro sits beside the map and the header fits", { skip }, async () => {
  await cold({ w: 1280, h: 800 });
  await waitIntro();
  const r = await page.eval(`(() => { const s = document.getElementById("sheet").getBoundingClientRect(); return { left: s.left, width: s.width, over: document.documentElement.scrollWidth - innerWidth, tabs: [...document.querySelectorAll(".appbar .tabs a")].filter(${VIS}).map(a => a.innerText), cut: document.getElementById("syncText").scrollWidth > document.getElementById("syncText").clientWidth }; })()`);
  assert.ok(r.left < 40 && r.width < 520, `intro is not a side panel: ${JSON.stringify(r)}`);
  assert.deepEqual(r.tabs, ["Карта", "Рейтинг", "Места", "Оценить"]);
  assert.equal(r.cut, false, "header status is cut off");
  assert.ok(r.over <= 1, "page scrolls sideways");
  assert.match(await sheetText(), /вставьте ключ доступа в настройках/);
});

test("the header status is never cut off on a phone, even on the very first offline start", { skip }, async () => {
  const cut = [];
  try {
    for (const w of [375, 390]) {
      await open({ w, h: 812, offline: true, hash: "#/places" });
      await page.eval(`document.fonts.ready.then(() => true)`);
      const r = await page.eval(`(() => { const t = document.getElementById("syncText"); return { text: t.innerText, sw: t.scrollWidth, cw: t.clientWidth }; })()`);
      if (r.sw > r.cw) cut.push(`${w}px: «${r.text}» needs ${r.sw}px, has ${r.cw}px`);
    }
  } finally { await page.eval(`localStorage.removeItem("mock:offline")`); }
  assert.deepEqual(cut, [], "status ends in «…»");
});

/* ---------- 2. every tab without a key ---------- */

test("without a key the ranking, places and rating screens each say the data is not connected and link to settings", { skip }, async () => {
  await cold({ intro: false, files: repo() });
  for (const h of ["rank", "places", "rate"]) {
    await page.goto(srv.url + "#/" + h, 300);
    const t = await viewText("v-" + h);
    assert.match(t, /не подключены|после подключения данных/i, h + ": nothing says the data is not connected");
    assert.ok((await hrefsIn("#v-" + h)).includes("#/settings"), h + ": no link to settings");
  }
});

test("without a key the ranking does not send me to add a place on the map, which needs a key too", { skip }, async () => {
  await cold({ intro: false, hash: "#/rank" });
  const t = await viewText("v-rank");
  assert.doesNotMatch(t, /добавьте место через поиск/i, "the empty matrix invites adding a place, but without a key adding only bounces back to settings");
});

test("without a key the places screen says how to connect once, not twice", { skip }, async () => {
  await cold({ intro: false, hash: "#/places" });
  const t = await viewText("v-places");
  const n = (t.match(/вставьте ключ/gi) || []).length;
  assert.equal(n, 1, "the same instruction is repeated in the banner and in the empty list: " + t);
});

/* ---------- 3. settings and the access key ---------- */

test("on a device without a key the steps to get one are open without an extra tap, and fold away once a key is saved", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings" });
  assert.equal(await page.eval(`${keyStepsDetails}.open`), true, "«Как получить ключ» is folded on a new device although it is the one thing a newcomer must read");
  await open({ hash: "#/settings" });
  assert.equal(await page.eval(`${keyStepsDetails}.open`), false, "with a saved key the steps should stay folded");
});

test("«Как получить ключ» and «Технические подробности» show an arrow so they look tappable", { skip }, async () => {
  const flat = [];
  const check = async where => {
    const r = await page.eval(`(() => [...document.querySelectorAll("main summary")].filter(${VIS}).map(s => {
      const st = getComputedStyle(s);
      const marker = st.display === "list-item" && st.listStyleType !== "none";
      const pseudo = ["::before", "::after"].some(p => { const c = getComputedStyle(s, p).content; return c && c !== "none" && c !== "normal"; });
      const icon = !!s.querySelector("svg, img, [class*=chev], [class*=arrow]");
      return { t: s.innerText.trim().slice(0, 40), ok: marker || pseudo || icon };
    }))()`);
    r.filter(x => !x.ok).forEach(x => flat.push(`${where}: «${x.t}»`));
  };
  await cold({ intro: false, hash: "#/settings" });
  await check("settings");
  assert.deepEqual(flat, [], "these look like plain text, nothing says they open (display:flex on summary removes the default marker)");
});

test("the GitHub link in the key steps pre-fills a key for this phone: name, description, owner, no expiry, read and write", { skip }, async () => {
  await asIPhone(async () => {
    await cold({ intro: false, hash: "#/settings" });
    await page.eval(`${keyStepsDetails}.open = true`);
    const a = await page.eval(`(() => { const a = [...document.querySelectorAll("#tokenForm details a")].find(a => /github\\.com\\/settings\\/personal-access-tokens/.test(a.href)); return a && { href: a.href, target: a.target, rel: a.rel, text: a.innerText }; })()`);
    assert.ok(a, "no link to create a key");
    const u = new URL(a.href);
    assert.match(u.searchParams.get("name"), /^where-to-live-phone-\d{4}-\d{2}-\d{2}$/);
    assert.ok(u.searchParams.get("description"), "no description");
    assert.equal(u.searchParams.get("target_name"), "Mihinator3000");
    assert.equal(u.searchParams.get("expires_in"), "none");
    assert.equal(u.searchParams.get("contents"), "write");
    assert.equal(a.target, "_blank");
    assert.match(a.rel, /noopener/);
  });
});

test("the key steps name the data repository, the GitHub buttons to press and where to paste the key", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings" });
  const t = await page.eval(`${keyStepsDetails}.textContent`);
  assert.match(t, /where-to-live-data/);
  assert.match(t, /Only select repositories/);
  assert.match(t, /Generate token/);
  assert.match(t, /вставьте сюда/);
  assert.match(t, /Вики/, "nothing says the partner needs her own key");
});

test("the key field is a password field the iPhone can offer to keep in Keychain", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings" });
  const f = await page.eval(`(() => { const t = document.querySelector('#tokenForm [name="token"]'), u = document.querySelector('#tokenForm [name="username"]'); return { type: t.type, ac: t.autocomplete, user: !!u && u.autocomplete === "username" && !!u.value, cap: t.getAttribute("autocapitalize"), spell: t.spellcheck }; })()`);
  assert.deepEqual(f, { type: "password", ac: "current-password", user: true, cap: "off", spell: false });
});

test("a key that works but cannot see the data repository says which step to redo", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: null });
  const msg = await pasteKey("github_pat_TEST_no_repo_access");
  assert.equal(await stored("token"), null, "a key without access must not be saved");
  assert.match(msg, /where-to-live-data/, "the message does not name the repository the key must see: " + msg);
  assert.match(msg, /(Repository access|Only select repositories|шаг 2)/i, "the message does not say which step of «Как получить ключ» to redo: " + msg);
});

test("a mistyped key is refused with a hint about what to check", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo() });
  const msg = await pasteKey("github_pat_typo123");
  assert.match(msg, /Ключ не подошёл, он не сохранён/);
  assert.match(msg, /(целиком|github_pat_|истёк|срок|скопир)/i, "the user is not told what could be wrong with the key: " + msg);
  assert.equal(await page.eval(`document.querySelector('#tokenForm [name="token"]').value`), "github_pat_typo123", "the typed key is lost and must be pasted again");
});

test("after the first key is accepted, settings point to the next step with a link into the app", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo() });
  const msg = await pasteKey("github_pat_TEST_first_key");
  assert.match(msg, /Подключено/);
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "connected");
  await sleep(300);
  const links = (await hrefsIn("#v-settings")).filter(h => /^#\/(map|rank|places|rate)/.test(h));
  assert.ok(links.length, "connected — and then? the page only says «Подключено: мест 6, оценок 4.» with no way on: " + msg);
});

test("after the first key is accepted on a device that does not know who I am, settings ask me to choose", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo() });
  await pasteKey("github_pat_TEST_first_key");
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "connected");
  await sleep(300);
  const t = await viewText("v-settings");
  assert.match(t, /(выберите|укажите|отметьте|нажмите)[^.]{0,30}кто (вы|я)/i, "nothing says that choosing Михаил or Вика is the next step");
});

test("connecting to an empty data repository says how to add the first place", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo({ places: [], ratings: [] }) });
  const msg = await pasteKey("github_pat_TEST_first_key");
  assert.match(msg, /Подключено/);
  await sleep(300);
  const t = await viewText("v-settings");
  assert.match(t, /(добав[а-яё]+|найдите)[^.]{0,60}мест/i, "with 0 places the only message is «мест 0, оценок 0»: " + msg);
  assert.ok((await hrefsIn("#v-settings")).includes("#/map"), "no link to the map where places are added");
});

test("the iPhone install steps also name the menu items of an English iPhone", { skip }, async () => {
  await asIPhone(async () => {
    await cold({ intro: false, hash: "#/settings" });
    const t = await page.eval(`document.querySelector("#v-settings .block .help").innerText`);
    assert.match(t, /Поделиться/);
    assert.match(t, /Share/, "on an English iPhone there is no «Поделиться»: " + t);
    assert.match(t, /Add to Home Screen/, "on an English iPhone there is no «На экран „Домой“»: " + t);
  });
});

test("the iPhone install hint says the key is pasted inside the installed app, after installing", { skip }, async () => {
  await asIPhone(async () => {
    await cold({ intro: false, hash: "#/settings" });
    const heads = await page.eval(`[...document.querySelectorAll("#v-settings h2")].map(h => h.textContent)`);
    assert.ok(heads.indexOf("Сначала: установите на экран «Домой»") < heads.indexOf("Подключение к данным"), heads.join(" | "));
    assert.match(await page.eval(`document.querySelector("#v-settings .block .help").innerText`), /ключ доступа вставляется уже в нём/);
  });
});

test("the main settings speak plain Russian: no token or repository jargon outside «Технические подробности»", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings" });
  const t = await page.eval(`(() => { const root = document.getElementById("v-settings").cloneNode(true);
    root.querySelectorAll("details").forEach(d => { if (/Технические/.test(d.querySelector("summary").textContent)) d.remove(); });
    [...root.querySelectorAll("h2")].filter(h => /Источники/.test(h.textContent)).forEach(h => h.closest("section").remove());
    return root.textContent; })()`);
  const jargon = t.match(/токен|репозитори|fine-grained|api\.github\.com|PAT\b/gi);
  assert.equal(jargon, null, "jargon on the main settings: " + (jargon || []).join(", "));
});

test("in dark mode the not-connected banner, the key steps and their link are readable", { skip }, async () => {
  const CONTRAST = `(() => { const lum = c => { const m = (c.match(/[\\d.]+/g) || []).map(Number); const [r, g, b] = m.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = e => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
    return e => { const fg = getComputedStyle(e).color, bg = bgOf(e); if (!/^rgb/.test(fg) || !/^rgb/.test(bg)) return 99; const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }; })()`;
  const low = [];
  try {
    await cold({ intro: false, dark: true, hash: "#/rank" });
    for (const [what, sel] of [["banner", "#v-rank .banner"], ["banner link", "#v-rank .banner a"]]) {
      const c = await page.eval(`(${CONTRAST})(document.querySelector(${JSON.stringify(sel)}))`);
      if (c < 4.5) low.push(`${what}: ${c.toFixed(2)}`);
    }
    await page.goto(srv.url + "#/settings", 300);
    await page.eval(`${keyStepsDetails}.open = true`);
    for (const [what, sel] of [["key intro", "#tokenForm > p.small"], ["key steps", "#tokenForm ol li"], ["key steps link", "#tokenForm ol li a"], ["«Как получить ключ»", "#tokenForm summary"], ["«Кто я» hint", "#v-settings .block .small.muted"]]) {
      const c = await page.eval(`(${CONTRAST})(document.querySelector(${JSON.stringify(sel)}))`);
      if (c < 4.5) low.push(`${what}: ${c.toFixed(2)}`);
    }
  } finally { await page.viewport(390, 844, { dark: false }); }
  assert.deepEqual(low, [], "text below 4.5:1 contrast");
});

/* ---------- 4. the first sync ---------- */

test("pasting the first key loads our places: the header turns «Подключено» and every place gets a pin", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo() });
  await pasteKey("github_pat_TEST_first_key");
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "connected");
  assert.match(await page.eval(`document.getElementById("syncDot").className`), /live/);
  await page.tap({ sel: ".bottomnav a", text: "Карта" });
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length > 0`, 5000, "pins");
  const titles = await page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(m => m.title).filter(Boolean)`);
  const clusters = await page.eval(`document.querySelectorAll(".leaflet-marker-icon:not([title])").length`);
  assert.ok(titles.length + clusters > 0, "no pins after the first sync");
  assert.ok(titles.includes("Санкт-Петербург"), "SPb pin missing: " + titles.join(", "));
});

test("on a phone the first sync with no saved map position shows all our places, not just the ones near the default view", { skip }, async () => {
  await cold({ intro: false, files: repo() });
  assert.equal(await page.eval(`localStorage.getItem("wtl:view")`), null, "precondition: the map has never been moved on this device");
  await page.goto(srv.url + "#/settings", 300);
  await pasteKey("github_pat_TEST_first_key");
  await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 5000, "connected");
  await page.tap({ sel: ".bottomnav a", text: "Карта" });
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length > 0`, 5000, "pins");
  await settleMap(page);
  const out = await page.eval(`(async () => { const s = ${APP}; const m = s.mapView.map, box = document.getElementById("map").getBoundingClientRect(), top = document.querySelector(".map-top").getBoundingClientRect().bottom;
    return s.M.places.filter(p => { const pt = m.latLngToContainerPoint([p.lat, p.lon]); const y = box.top + pt.y; return pt.x < 8 || pt.x > box.width - 8 || y < top || y > box.bottom - 8; }).map(p => p.name); })()`);
  assert.deepEqual(out, [], "after connecting, these places are off-screen or under the search bar, so a newcomer sees almost nothing of our data");
});

test("while the first key is being checked the button shows it is busy and a second tap does not check again", { skip }, async () => {
  await cold({ intro: false, hash: "#/settings", files: repo() });
  await page.eval(`localStorage.setItem("mock:delay", "900"); window.__gql = 0; const f = window.fetch; window.fetch = (i, o) => { if (String(i && i.url || i).includes("/graphql")) window.__gql++; return f(i, o); };`);
  try {
    await page.fill('#tokenForm [name="token"]', "github_pat_TEST_slow");
    await page.tap({ text: "Сохранить и проверить", within: "#tokenForm" }, 150);
    const b = await page.eval(`(() => { const b = document.querySelector('#tokenForm button[type="submit"]'); return { disabled: b.disabled, text: b.innerText, msg: document.getElementById("tokenMsg").innerText }; })()`);
    assert.match(b.msg, /Проверяю ключ/);
    const first = await page.eval(`window.__gql`);
    await page.eval(`document.querySelector('#tokenForm button[type="submit"]').click()`);
    await page.waitFor(`document.getElementById("syncText").innerText === "Подключено"`, 10000, "connected");
    await page.idle(400);
    const calls = await page.eval(`window.__gql`);
    assert.ok(b.disabled || /Проверяю/.test(b.text), `the button still reads «${b.text}» and can be pressed while the key is checked`);
    assert.ok(calls <= first + 1, `a second tap started another check: ${calls} GitHub queries`);
  } finally { await page.eval(`localStorage.removeItem("mock:delay")`); }
});

test("after the first sync without a chosen person, every data screen asks «Кто вы» (the rate screen through «Кто оценивает») and one answer clears it everywhere", { skip }, async () => {
  await open({ me: "", hash: "#/rank" });
  for (const h of ["rank", "places", "place/porto"]) {
    await page.goto(srv.url + "#/" + h, 300);
    assert.match(await viewText(h.startsWith("place/") ? "v-place" : "v-" + h), /Кто вы на этом устройстве\?/, h);
  }
  await page.goto(srv.url + "#/rate", 300);
  const rate = await viewText("v-rate");
  assert.doesNotMatch(rate, /Кто вы на этом устройстве/, "a second picker above «Кто оценивает»");
  assert.match(rate, /Кто оценивает/);
  await page.goto(srv.url + "#/places", 300);
  await page.tap({ text: "Вика", within: "#v-places .banner" });
  assert.match(await toastText(/Это устройство/), /Вика/);
  for (const h of ["rank", "rate", "place/porto"]) {
    await page.goto(srv.url + "#/" + h, 300);
    assert.doesNotMatch(await viewText(h.startsWith("place/") ? "v-place" : "v-" + h), /Кто вы на этом устройстве/, h);
  }
  await page.goto(srv.url + "#/settings", 300);
  assert.equal(await page.eval(`(document.querySelector('#meSeg [aria-pressed="true"]') || {}).innerText || ""`), "Вика");
});

/* ---------- 5. words a newcomer meets for the first time ---------- */

test("the ranking explains «база»: SPb is the yardstick every place is compared with", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.eval(`document.querySelector(".rank-help").open = true`);
  const t = await page.eval(`document.getElementById("v-rank").innerText + "\\n" + [...document.querySelectorAll("#v-rank [title]")].map(e => e.title).join("\\n")`);
  assert.match(t, /(база[^.]{0,80}(точк[аиу] отсчёта|сравнива|относительно|эталон))|((точк[аиу] отсчёта|сравнива[а-яё]+ с|эталон)[^.]{0,80}база)/i, "«база» is shown on SPb but never explained");
});

test("the ranking help says what «мировые данные» and «отсев» mean", { skip }, async () => {
  await open({ hash: "#/rank" });
  await page.tap({ text: "Что значат пометки" });
  const t = await page.eval(`document.querySelector(".rank-help").innerText`);
  assert.match(t, /мировы[еи] данны[еми][^.]{0,100}(показател|климат|статистик)/i, "the pale block says «итог в основном по мировым данным» but nothing says what they are: " + t);
  assert.match(t, /отсев[^.]{0,100}(отказал|не подход|вычеркн|не участву|в рейтинг не|вето)/i, "«Отсев» is a ranking section with no explanation: " + t);
});

test("the places screen explains the statuses «кандидат» and «отсев»", { skip }, async () => {
  await open({ hash: "#/places", files: repo({ places: PLACES.map(p => p.id === "belgrad" ? Object.assign({}, p, { status: "отсев", reason: "визы" }) : p) }) });
  const t = await page.eval(`(() => { const v = document.getElementById("v-places").cloneNode(true); v.querySelector("#plist").remove(); return [v.textContent.replace(/\\s+/g, " ").trim(), ...[...document.querySelectorAll("#v-places [title]")].map(e => e.title)].join(" | "); })()`);
  assert.match(await page.text("#plist"), /кандидат/, "precondition: «кандидат» is shown under places");
  assert.match(t, /кандидат[^.]{0,80}(смотрим|рассматрива|присматрива|выбира|думаем|не были)/i, "«кандидат» under every place is not explained");
  assert.match(t, /отсев[^.]{0,80}(отказал|не подход|вычеркн|не рассматрива|вето)/i, "«отсев» is not explained");
});

test("the layers panel says what «Прогноз для нас» is even before it can be chosen", { skip }, async () => {
  await open();
  await page.waitFor(`(async () => !!(${APP}).mapView)()`, 8000, "map ready");
  await page.tap({ sel: "#layersBtn" });
  const opt = await page.eval(`(() => { const o = [...document.querySelectorAll("#lyCity option")].find(o => o.value === "predict"); return { disabled: o.disabled, text: o.textContent }; })()`);
  assert.equal(opt.disabled, true, "precondition: not enough rated places for the forecast yet");
  const desc = await page.eval(`[...document.querySelectorAll("#layersPanel .desc")].map(e => e.innerText).join(" ")`);
  assert.match(desc, /Прогноз[^.]{0,120}(понрав|оценённ|оценили|наших оценок|похожи[хм])/i, "«Прогноз для нас» is offered with no word on what it predicts: " + desc);
});

test("the rating form explains the star and the 1–5 scale against SPb before the first question", { skip }, async () => {
  await open({ hash: "#/rate" });
  const head = await page.eval(`document.querySelector("#rateForm .fcard").innerText`);
  assert.match(head, /Шкала 1–5 относительно СПб/);
  assert.match(head, /3 — как в СПб/);
  assert.match(head, /Только главные вопросы ★ \(10\)/);
});

/* ---------- 6. empty states with the data connected ---------- */

test("with places but no ratings yet, the empty ranking links to the rating form", { skip }, async () => {
  await open({ hash: "#/rank", files: repo({ ratings: [] }) });
  assert.match(await page.text("#rank"), /Своих оценок пока нет/);
  const links = await hrefsIn("#rank");
  assert.ok(links.some(h => h.startsWith("#/rate")), "«Своих оценок пока нет» with no way to the rating form: " + links.join(", "));
});

test("with no places at all, the ranking still links to the map to add the first one", { skip }, async () => {
  await open({ hash: "#/rank", files: repo({ places: [], ratings: [] }) });
  assert.ok((await hrefsIn("#v-rank")).includes("#/map"));
  assert.match(await viewText("v-rank"), /добавьте место через поиск на карте/i);
});

test("with no places at all, the places list links to the map where places are added", { skip }, async () => {
  await open({ hash: "#/places", files: repo({ places: [], ratings: [] }) });
  assert.match(await page.text("#plist"), /Мест пока нет\. Добавьте первое через поиск на карте\./);
  assert.ok((await hrefsIn("#plist")).includes("#/map"), "the empty list names the map but does not link to it");
});

test("with no places at all, the rating form says to add a place first and links to the map", { skip }, async () => {
  await open({ hash: "#/rate", files: repo({ places: [], ratings: [] }) });
  assert.equal(await page.eval(`document.getElementById("fPlace").options.length`), 1, "only the «— выберите —» option");
  assert.match(await page.text("#fPlaceHint"), /найдите на карте/);
  assert.ok((await hrefsIn("#fPlaceHint")).includes("#/map"));
});

/* ---------- 7. the whole first run ---------- */

test("first run end to end: dismiss the intro, connect, choose who I am, add a town from search, rate it and find it in the dossier and ranking", { skip }, async () => {
  await cold({ files: repo() });
  await waitIntro();
  await page.tap({ text: "Понятно", within: "#sheet" });
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`location.hash === "#/settings"`, 3000, "settings");
  await page.tap({ sel: "#meSeg button", text: "Михаил" });
  assert.equal(await stored("me"), "Михаил");
  const msg = await pasteKey("github_pat_TEST_first_run");
  assert.match(msg, /Подключено/);
  await page.tap({ sel: ".bottomnav a", text: "Карта" });
  await page.waitFor(`(async () => !!(${APP}).mapView)()`, 5000, "map");
  await sleep(300);
  assert.equal(await sheetOpen(), false, "the intro came back after connecting");

  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type("Херцег");
  await page.tap({ text: "везде", within: "#searchResults" });
  await page.waitFor(`/OpenStreetMap/i.test(document.getElementById("searchResults").innerText) && !/Ищу/.test(document.getElementById("searchResults").innerText)`, 6000, "OSM results");
  await page.tap({ text: "Херцег-Нови, Черногория", within: "#searchResults" });
  await page.waitFor(`(document.querySelector("#sheetBody h3") || {}).innerText === "Херцег-Нови"`, 4000, "geo sheet");
  await page.tap({ text: "Добавить как место", within: "#sheet" });
  assert.match(await toastText(/Добавлено/), /Херцег-Нови/);
  await page.waitFor(`/кандидат/.test(document.getElementById("sheetBody").innerText) && !!document.querySelector('#sheetBody a[href^="#/rate/new/"]')`, 4000, "place sheet");

  await page.tap({ sel: "#sheetBody a", text: "Оценить" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fPlace").value !== ""`, 4000, "rate form with the place");
  const pid = await page.eval(`document.getElementById("fPlace").value`);
  assert.match(await page.eval(`document.getElementById("fPlace").selectedOptions[0].text`), /Херцег-Нови/);
  assert.equal(await page.eval(`(document.querySelector('#fWho [aria-pressed="true"]') || {}).innerText || ""`), "Михаил");
  for (const [k, v] of [["интернет", 4], ["улица", 4], ["шум", 3], ["пешком", 5], ["эстетика", 5]]) await page.tap({ sel: `[data-score="${k}"][data-v="${v}"]` }, 80);
  assert.match(await page.text("#fCounts"), /★ 5 из 10/);
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`location.hash.startsWith("#/place/")`, 6000, "dossier");
  assert.match(await toastText(/Сохранено/), /Рейтинг обновился/);
  assert.equal(await page.text("#v-place h1"), "Херцег-Нови");
  assert.match(await page.text("#v-place .trips"), /Михаил/);

  const files = await mockFiles(page);
  const rating = Object.entries(files).filter(([p]) => p.startsWith("ratings/")).map(([, t]) => JSON.parse(t)).find(r => r.place === pid);
  assert.ok(files[`places/${pid}.json`], "the place was not written to the data repository");
  assert.ok(rating, "the rating was not written");
  assert.equal(rating.who, "Михаил");
  assert.deepEqual(rating.scores, { "интернет": 4, "улица": 4, "шум": 3, "пешком": 5, "эстетика": 5 });

  await page.tap({ sel: ".bottomnav a", text: "Рейтинг" });
  assert.match(await page.text("#rank"), /Херцег-Нови/);
  assert.deepEqual(page.takeErrors(), []);
});
