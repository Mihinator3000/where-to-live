import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES, RATINGS, mockFiles } from "./fixtures.mjs";

// Lens: stability of the test harness and of the app across time zones, locales, reloads and lifecycle events.
// Part 1 checks what every other e2e file silently relies on: openApp starts each test from a clean slate (storage,
// mock knobs, service worker, collected errors, screen size), the mock keeps tests off the real network, and the
// harness helpers fail loudly instead of passing by accident. Part 2 drives the app the way a phone does it: other
// time zones and languages, the app being hidden or reloaded at a bad moment, and a returning visit served from the
// offline copy instead of the network.

const skip = !CHROME && "no Chrome";
let srv, page;
const hosts = [];

// Counts every fetch to GitHub made by the page (wraps the shared mock, which is injected first).
const COUNT = `(() => {
  if (location.hostname !== "127.0.0.1") return;
  const inner = window.fetch;
  window.__gh = [];
  window.fetch = (input, init) => { const u = typeof input === "string" ? input : input.url; if (u.startsWith("https://api.github.com/")) window.__gh.push({ t: performance.now(), u: u.replace("https://api.github.com", "") }); return inner(input, init); };
})();`;

before(async () => {
  srv = await serve();
  page = await launch();
  const orig = page.ws.onmessage;
  page.ws.onmessage = ev => { orig(ev); try { const m = JSON.parse(ev.data); if (m.method === "Network.requestWillBeSent") hosts.push(m.params.request.url); } catch (e) {} };
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: COUNT });
});
after(async () => { await page?.close(); await srv?.close(); });
// No viewport reset here on purpose: two tests below check that openApp itself starts each test on the default phone
// screen. Every test of this file that changes the screen size restores it in a finally block.
beforeEach(async () => {
  if (!page) return;
  await page.send("Emulation.setTimezoneOverride", { timezoneId: "" }).catch(() => {});
  await page.send("Emulation.setLocaleOverride", {}).catch(() => {});
  page.takeErrors();
});

/* ---------- helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = JSON.stringify;
const T = "2026-10-01T00:00:00.000Z";
const booted = () => page.waitFor(`window.__booted && document.getElementById("syncText") && !["…", "Обновляю…"].includes(document.getElementById("syncText").innerText)`, 10000, "app booted");
const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const doc = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async place => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);
const localDay = tz => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const localHour = tz => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const pageKeys = () => page.eval(`Object.keys(localStorage).sort()`);
const swControlled = () => page.eval(`!!navigator.serviceWorker.controller`);
const isDark = () => page.eval(`matchMedia("(prefers-color-scheme: dark)").matches`);

async function inZone(tz, fn) {
  await page.send("Emulation.setTimezoneOverride", { timezoneId: tz });
  try { return await fn(); } finally { await page.send("Emulation.setTimezoneOverride", { timezoneId: "" }).catch(() => {}); }
}

async function inLocale(locale, fn) {
  await page.send("Emulation.setLocaleOverride", { locale });
  try { return await fn(); } finally { await page.send("Emulation.setLocaleOverride", {}).catch(() => {}); }
}

async function press(sel, settle) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}

async function rateTrip(place, start, end) {
  await openApp(page, srv.url, { hash: "#/rate/new/" + place });
  await page.waitFor(`document.getElementById("fStart")`, 5000, "rating form");
  await page.fill("#fStart", start);
  await page.fill("#fEnd", end);
  await press('[data-score="интернет"][data-v="4"]');
  await press('[data-score="улица"][data-v="3.5"]');
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/${place}"`, 6000, "dossier after save");
}

// A real close-and-reopen. page.goto(site + "#/x") while the app is already open on the same site is only a hash
// change (same document, nothing reloads), so every reopen goes through another page first.
async function relaunch(hash, settle = 100) {
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.goto(srv.url + hash, settle);
  await booted();
}

const rankRows = () => page.eval(`[...document.querySelectorAll("#v-rank #rank a.row")].map(r => r.innerText.replace(/\\s+/g, " ").trim())`);
const settledWorld = () => page.waitFor(`(async () => { const s = (await import("./js/app.js")).state; return s.world && s.world.cities && s.world.cities.length > 0; })()`, 10000, "city data loaded");

/* ---------- part 1: every test starts from a clean slate ---------- */

test("openApp removes every app setting, draft, queue and lost change a previous test left on the device", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`(() => {
    const leftovers = { draft: { place: "porto", review: "черновик" }, drafts: { porto: { review: "x" } }, pending: [{ path: "ratings/x.json", content: "{}" }], lost: [{ at: "${T}", path: "places/porto.json" }], revealed: ["tbilisi"], theme: "dark", layers: { mode: "abs" }, preset: "Своё", weights: { legal: 90 }, worldData: false, cache: { head: "h9" } };
    for (const [k, v] of Object.entries(leftovers)) localStorage.setItem("wtl:" + k, JSON.stringify(v));
    localStorage.setItem("c9:anything", "1");
    sessionStorage.setItem("wtl:scroll", "500");
  })()`);
  await openApp(page, srv.url, { hash: "#/rank" });
  const keys = await pageKeys();
  const allowed = new Set(["mock:files", "mock:head", "mock:log", "wtl:token", "wtl:me", "wtl:introSeen", "wtl:cache", "wtl:layers", "wtl:preset", "wtl:weights", "wtl:theme", "wtl:revealed"]);
  assert.deepEqual(keys.filter(k => !allowed.has(k)), [], "keys left from the previous test");
  const left = await page.eval(`["draft", "drafts", "pending", "lost"].filter(k => localStorage.getItem("wtl:" + k) && !/^(\\[\\]|\\{\\}|null)$/.test(localStorage.getItem("wtl:" + k)))`);
  assert.deepEqual(left, [], "a draft, queue or lost change of the previous test is still on the device");
  assert.notEqual(await page.eval(`localStorage.getItem("wtl:theme")`), JSON.stringify("dark"), "the previous test's theme leaked");
  assert.doesNotMatch(String(await page.eval(`localStorage.getItem("wtl:revealed")`)), /tbilisi/, "the previous test's «Показать всё равно» leaked");
  assert.equal(await page.eval(`sessionStorage.length`), 0, "sessionStorage of the previous test leaked");
});

test("openApp resets every mock knob: the network is up, GitHub is fast, the history starts at h0 and the commit log is empty", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await page.eval(`localStorage.setItem("mock:offline", "1"); localStorage.setItem("mock:delay", "9000"); localStorage.setItem("mock:head", "h7"); localStorage.setItem("mock:log", JSON.stringify([{ op: "add", path: "x" }]))`);
  const t0 = Date.now();
  await openApp(page, srv.url, { hash: "#/map" });
  assert.ok(Date.now() - t0 < 8000, "the previous test's 9 s delay still applies");
  assert.equal(await page.eval(`localStorage.getItem("mock:offline")`), null);
  assert.equal(await page.eval(`localStorage.getItem("mock:delay")`), null);
  assert.equal(await page.eval(`localStorage.getItem("mock:head") || "h0"`), "h0");
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`), []);
  assert.match(await page.text("#syncText"), /Подключено|Сохранено/, "the app is connected, not offline");
});

test("openApp hands the app exactly the files the test asked for, nothing from the previous test's saves", { skip }, async () => {
  await rateTrip("batumi", "2026-09-01", "2026-09-10");
  assert.equal((await ratingsOn("batumi")).length, 1);
  await openApp(page, srv.url, { hash: "#/rank" });
  assert.equal((await ratingsOn("batumi")).length, 0, "the rating saved by the previous test is still in the fake GitHub");
  assert.deepEqual(Object.keys(await mockFiles(page)).sort(), Object.keys(repo()).sort());
});

test("openApp returns only after the first GitHub load: the data is on screen and nothing is still loading", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  const st = await page.eval(`(async () => { const d = (await import("./js/app.js")).state.data; return { status: d.status, loaded: !!d.loadedAt, busy: !!d.busy }; })()`);
  assert.deepEqual(st, { status: "live", loaded: true, busy: false });
  assert.match(await page.text("#v-places"), /Порту/);
  assert.match(await page.text("#v-places"), /Тбилиси/);
});

test("openApp boots the app as a first visit: no service worker from the previous test serves the page", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "the app installed its offline copy");
  await openApp(page, srv.url, { hash: "#/rank" });
  assert.equal(await page.eval(`performance.getEntriesByType("navigation")[0].workerStart`), 0, "the page was served by the previous test's service worker");
});

test("an error thrown by the previous test's page is not blamed on the next test", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`setTimeout(() => { throw new Error("left over from the previous test"); }, 0); 1`);
  await sleep(100);
  await openApp(page, srv.url, { hash: "#/rank" });
  assert.deepEqual(page.errors, [], "errors collected before this test's openApp are attributed to it");
});

// These two run in this order: the first is an ordinary test that works on a dark desktop screen, the second is the
// next test, which only calls openApp — like every other test in files without a beforeEach reset.
test("a test can switch to a dark desktop screen before opening the app", { skip }, async () => {
  await page.viewport(1280, 800, { dark: true });
  await openApp(page, srv.url, { hash: "#/rank" });
  assert.deepEqual(await page.eval(`[innerWidth, innerHeight]`), [1280, 800]);
  assert.equal(await isDark(), true);
});

test("the next test that only calls openApp starts on a light 390×844 phone screen, not on the previous test's screen", { skip }, async () => {
  try {
    await openApp(page, srv.url, { hash: "#/rank" });
    assert.deepEqual(await page.eval(`[innerWidth, innerHeight]`), [390, 844], "the previous test's desktop size leaked into this one");
    assert.equal(await isDark(), false, "the previous test's dark mode leaked into this one");
  } finally { await page.viewport(390, 844, { dark: false }); }
});

test("page.viewport(w, h) without options gives a light screen, not the dark mode of an earlier call", { skip }, async () => {
  try {
    await page.viewport(390, 844, { dark: true });
    await page.viewport(1280, 800);
    await openApp(page, srv.url, { hash: "#/rank" });
    assert.equal(await isDark(), false, "dark mode sticks to every later viewport() call");
  } finally { await page.viewport(390, 844, { dark: false }); }
});

test("each test file gets its own browser profile and its own site address, so nothing is shared between files", { skip }, async () => {
  const srv2 = await serve(), page2 = await launch();
  try {
    assert.notEqual(srv2.url, srv.url, "two files would share one site address and its storage");
    await openApp(page, srv.url, { hash: "#/rank", local: { "wtl:revealed": ["tbilisi"] } });
    await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "service worker of file 1");
    await page2.goto(srv.url + "manifest.webmanifest", 50);
    assert.equal(await page2.eval(`localStorage.length`), 0, "the second browser sees the first one's storage");
    assert.equal(await page2.eval(`navigator.serviceWorker.getRegistrations().then(r => r.length)`), 0, "the second browser has the first one's service worker");
    assert.deepEqual(await page2.eval(`caches.keys()`), [], "the second browser has the first one's offline copy");
  } finally { await page2.close(); await srv2.close(); }
});

/* ---------- part 1b: the harness fails loudly ---------- */

test("the harness records uncaught errors, rejected promises and unexpected dialogs, so «no JS errors» checks mean something", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  page.takeErrors();
  await page.eval(`setTimeout(() => { throw new Error("boom-1") }, 0); Promise.reject(new Error("boom-2")); console.error("boom-3"); setTimeout(() => confirm("boom-4?"), 0); 1`);
  await page.waitFor(`true`);
  await sleep(300);
  const e = page.takeErrors().join(" | ");
  for (const w of ["boom-1", "boom-2", "boom-3", "boom-4"]) assert.match(e, new RegExp(w), `${w} was not recorded: ${e}`);
});

test("tapping a button hidden under something else fails instead of clicking whatever lies on top", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`(() => { const d = document.createElement("div"); d.id = "cover"; d.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.01)"; document.body.appendChild(d); })()`);
  await assert.rejects(page.tap({ sel: ".bottomnav a", text: "Места" }), /covered by cover/);
  assert.equal(await page.eval(`location.hash`), "#/rank", "the covered link was followed anyway");
});

test("tapping something that is not on the screen fails with a clear message", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await assert.rejects(page.tap({ text: "Кнопка, которой нет" }), /not found/);
  await assert.rejects(page.select("#nope", "x"), /no option/);
  await assert.rejects(page.fill("#nope", "x"), /not found/);
  await assert.rejects(page.waitFor(`false`, 200, "something that never happens"), /something that never happens/);
});

test("the fake GitHub refuses any key that is not a test key, so a real key can never be used by a test", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank", local: { "wtl:token": "ghp_" + "notATestKey".repeat(3) } });
  await page.waitFor(`/Ключ не подходит/.test(document.getElementById("syncText").innerText)`, 6000, "refused key shown");
  const r = await page.eval(`fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: "Bearer github_pat_11REALKEY" }, body: "{}" }).then(r => r.status)`);
  assert.equal(r, 401);
});

test("a whole session — browsing every screen, saving a rating and searching a town — sends nothing outside this computer", { skip }, async () => {
  hosts.length = 0;
  await rateTrip("batumi", "2026-09-01", "2026-09-10");
  for (const h of ["#/rank", "#/places", "#/place/porto", "#/settings", "#/map"]) { await page.eval(`location.hash = ${js(h)}`); await sleep(250); }
  await page.fill("#searchInput", "");
  await page.tap({ sel: "#searchInput" });
  await page.type("Херцег");
  await page.key("Enter");
  await page.waitFor(`/Херцег-Нови/.test(document.getElementById("searchResults").innerText)`, 6000, "search answered by the fake OpenStreetMap");
  const outside = [...new Set(hosts.map(u => { try { return new URL(u); } catch (e) { return null; } }).filter(u => u && /^https?:$/.test(u.protocol) && u.hostname !== "127.0.0.1" && u.hostname !== "tile.openstreetmap.org").map(u => u.host))];
  assert.deepEqual(outside, [], "requests left the test machine");
});

test("after start-up the app stays quiet: no GitHub requests while I just look at the map for a few seconds", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await sleep(300);
  await page.eval(`window.__gh.length = 0`);
  await sleep(2000);
  assert.deepEqual(await page.eval(`window.__gh.map(c => c.u)`), [], "background requests while idle");
});

/* ---------- part 2: other time zones and languages ---------- */

test("on a phone set to Kiribati time (UTC+14) a trip typed as 1–14 September is saved with exactly those dates and 14 days", { skip }, async () => {
  await inZone("Pacific/Kiritimati", async () => {
    await rateTrip("batumi", "2026-09-01", "2026-09-14");
    const [r] = await ratingsOn("batumi");
    assert.equal(r.start, "2026-09-01");
    assert.equal(r.end, "2026-09-14");
    assert.equal(r.days, 14);
    assert.match(await page.text("#v-place"), /1–14 сентября 2026/);
  });
});

test("on a phone set to Los Angeles time (UTC−8) a trip typed as 1–14 September is saved and shown with the same dates", { skip }, async () => {
  await inZone("America/Los_Angeles", async () => {
    await rateTrip("batumi", "2026-09-01", "2026-09-14");
    const [r] = await ratingsOn("batumi");
    assert.deepEqual([r.start, r.end, r.days], ["2026-09-01", "2026-09-14", 14]);
    assert.match(await page.text("#v-place"), /1–14 сентября 2026/);
  });
});

test("a New Year trip typed in Los Angeles counts 7 days and reads «28 декабря 2025 – 3 января 2026»", { skip }, async () => {
  await inZone("America/Los_Angeles", async () => {
    await rateTrip("batumi", "2025-12-28", "2026-01-03");
    const [r] = await ratingsOn("batumi");
    assert.equal(r.days, 7);
    assert.match(await page.text("#v-place"), /28 декабря 2025 – 3 января 2026/);
  });
});

for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "Pacific/Pago_Pago"]) {
  test(`in ${tz} the rating form's latest arrival day is today on the phone's own calendar`, { skip }, async () => {
    await inZone(tz, async () => {
      await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
      await page.waitFor(`document.getElementById("fStart")`, 5000, "rating form");
      assert.equal(await page.eval(`document.getElementById("fStart").max`), localDay(tz));
    });
  });
}

test("in Kiribati a trip that started today on the phone's calendar is accepted, not refused as «позже сегодняшнего дня»", { skip }, async () => {
  const tz = "Pacific/Kiritimati", today = localDay(tz);
  await inZone(tz, async () => {
    await rateTrip("batumi", today, today);
    const [r] = await ratingsOn("batumi");
    assert.equal(r.start, today);
  });
});

test("in Kiribati the «Сохранено · HH:MM» time at the top is the phone's wall-clock time", { skip }, async () => {
  const tz = "Pacific/Kiritimati";
  await inZone(tz, async () => {
    await rateTrip("batumi", "2026-09-01", "2026-09-10");
    const t = await page.waitFor(`/Сохранено · \\d\\d:\\d\\d/.test(document.getElementById("syncText").innerText) && document.getElementById("syncText").innerText`, 6000, "saved time");
    const h = Number(t.match(/(\d\d):\d\d/)[1]);
    const want = localHour(tz);
    assert.ok(h === want || h === (want + 23) % 24, `shows ${t}, the phone says ${want}:xx`);
  });
});

test("in Kiribati place numbers entered today are stamped with the phone's date and the dossier says so", { skip }, async () => {
  const tz = "Pacific/Kiritimati", today = localDay(tz);
  await inZone(tz, async () => {
    await openApp(page, srv.url, { hash: "#/place/porto" });
    await page.fill('[name="fact_rent"]', "900");
    await page.tap({ text: "Сохранить цифры" });
    await page.waitFor(`JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).facts?.rent?.v === 900`, 6000, "rent saved");
    assert.equal((await doc("places/porto.json")).facts.rent.at, today);
    const [y, m, d] = today.split("-").map(Number);
    const month = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"][m - 1];
    await page.waitFor(`/Вписано ${d} ${month} ${y}/.test(document.getElementById("v-place").innerText)`, 5000, "«Вписано <today>» in the dossier");
  });
});

test("in Kiribati the offline note says the shown data is from today", { skip }, async () => {
  await inZone("Pacific/Kiritimati", async () => {
    await openApp(page, srv.url, { hash: "#/rank" });
    await page.eval(`localStorage.setItem("mock:offline", "1")`);
    await relaunch("#/rank");
    await page.waitFor(`/Нет связи/.test(document.getElementById("v-rank").innerText)`, 8000, "offline banner");
    assert.match(await page.text("#v-rank"), /данные на сегодня в \d\d:\d\d/);
  });
});

test("on a phone set to English, dates, months and numbers in the app stay Russian", { skip }, async () => {
  await inLocale("en-US", async () => {
    await openApp(page, srv.url, { hash: "#/place/porto" });
    const t = await page.text("#v-place");
    assert.match(t, /августа 2026/, "trip dates in Russian");
    assert.doesNotMatch(t, /\b(January|February|March|April|May|June|July|August|September|October|November|December|AM|PM)\b/);
    assert.match(t, /\d+ \d{3}|\d+[.,]\d/, "numbers are printed");
    assert.deepEqual(page.takeErrors(), []);
  });
});

test("on a phone set to English the places list is in Russian alphabetical order, the same as on a Russian phone", { skip }, async () => {
  const names = async () => page.eval(`[...document.querySelectorAll("#v-places a b, #v-places .row b")].map(b => b.innerText.trim()).filter(Boolean)`);
  await inLocale("ru-RU", async () => { await openApp(page, srv.url, { hash: "#/places" }); });
  const ru = await names();
  await inLocale("en-US", async () => { await openApp(page, srv.url, { hash: "#/places" }); });
  const en = await names();
  assert.ok(ru.length >= 5, "places listed: " + ru.join(", "));
  assert.deepEqual(en, ru);
});

test("on a phone set to English with Los Angeles time, a full rating round trip keeps the typed dates", { skip }, async () => {
  await inLocale("en-US", () => inZone("America/Los_Angeles", async () => {
    await rateTrip("batumi", "2026-08-30", "2026-09-02");
    const [r] = await ratingsOn("batumi");
    assert.deepEqual([r.start, r.end, r.days], ["2026-08-30", "2026-09-02", 4]);
    assert.match(await page.text("#v-place"), /30 августа – 2 сентября 2026/);
  }));
});

/* ---------- part 2b: hidden, reloaded or killed at a bad moment ---------- */

test("a review typed right before the phone hides the app is already kept on the phone", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
  await page.waitFor(`document.getElementById("fReview")`, 5000, "rating form");
  await page.eval(`(() => { const e = document.getElementById("fReview"); e.focus(); e.value = "Тихо и зелено"; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await page.eval(`(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })); })()`);
  const kept = await page.eval(`(localStorage.getItem("wtl:draft") || "").includes("Тихо и зелено")`);
  assert.equal(kept, true, "if iOS closes the hidden app now, the review is lost: the draft is written only 300 ms later");
});

test("a score tapped right before a reload is still there after the reload", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
  await page.waitFor(`document.getElementById("fStart")`, 5000, "rating form");
  await press('[data-score="интернет"][data-v="4"]', 0);
  await relaunch("#/rate/new/batumi");
  await page.waitFor(`document.getElementById("fCounts")`, 5000, "rating form again");
  assert.match(await page.text("#fCounts"), /1 из 10/, "the tapped score was lost by the reload");
});

test("closing the app while «Сохраняю…» is shown: after reopening, the app says the rating did not get saved and where it is", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
  await page.waitFor(`document.getElementById("fStart")`, 5000, "rating form");
  await page.fill("#fStart", "2026-09-01");
  await page.fill("#fEnd", "2026-09-10");
  await press('[data-score="интернет"][data-v="4"]');
  await sleep(400);
  await page.eval(`localStorage.setItem("mock:delay", "3000")`);
  await press("#fSave", 300);
  assert.match(await page.text("#fSave"), /Сохраняю/, "precondition: the save is in progress");
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.eval(`localStorage.removeItem("mock:delay")`);
  await page.goto(srv.url + "#/rank", 100);
  await booted();
  await sleep(500);
  assert.equal((await ratingsOn("batumi")).length, 0, "precondition: GitHub never got the rating");
  assert.match(await page.eval(`localStorage.getItem("wtl:draft") || ""`), /интернет/, "the answers are still on the phone");
  const lines = await page.eval(`[document.getElementById("v-rank").innerText, document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText, document.getElementById("syncText").innerText].join("\\n").split("\\n").filter(l => /Батуми/.test(l))`);
  const told = lines.filter(l => /не (успел|сохран|отправ|записал)|черновик/i.test(l));
  assert.ok(told.length > 0, `nothing on the screen says the Batumi rating was left unsaved; the status reads «${await page.text("#syncText")}» as if it were saved. Lines with «Батуми»: ${lines.join(" / ")}`);
  assert.ok(await page.eval(`[...document.querySelectorAll("#v-rank a[href^='#/rate'], #toast a[href^='#/rate']")].length > 0`), "no way to get back to the unsaved rating from here");
});

const mapNote = () => page.eval(`(() => { const n = document.getElementById("mapNote"); return n && !n.hidden ? { text: n.innerText, err: n.classList.contains("err"), link: (n.querySelector("a[href^='#/rate']") || {}).hash || "" } : null; })()`);

async function cutSave(start) {
  await page.eval(`localStorage.setItem("mock:delay", "3000")`);
  await press("#fSave", 300);
  assert.match(await page.text("#fSave"), /Сохраняю/, "precondition: the save is in progress");
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.eval(`localStorage.removeItem("mock:delay")`);
  await relaunch(start);
  await sleep(500);
}

test("a rating save cut off by closing the app is reported on the map, where the installed app reopens, and the link brings the answers back", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate/new/batumi" });
  await page.waitFor(`document.getElementById("fStart")`, 5000, "rating form");
  await press('[data-score="интернет"][data-v="4"]');
  await sleep(400);
  await cutSave("#/map");
  assert.equal((await ratingsOn("batumi")).length, 0, "precondition: GitHub never got the rating");
  const n = await mapNote();
  assert.ok(n, "the app reopens on the map (manifest start_url) and nothing there says the Batumi rating was not saved");
  assert.match(n.text, /Оценка «Батуми» не успела сохраниться/);
  assert.equal(n.err, true, "the note is marked as a problem, like the red banner on other screens");
  assert.equal(n.link, "#/rate/new/batumi");
  await page.shot("c3-stability-map-cut-note");
  await page.tap({ sel: "#mapNote a" });
  await page.waitFor(`location.hash === "#/rate" && document.getElementById("fCounts")`, 5000, "rating form");
  assert.match(await page.text("#fCounts"), /1 из 10/, "the link must open the half-saved answers");
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/batumi"`, 8000, "saved");
  await page.eval(`location.hash = "#/map"`);
  await sleep(500);
  assert.equal(await mapNote(), null, "after the rating is saved the map note goes away");
});

test("an edit of an existing rating cut off by closing the app is reported too, and its link opens the edit, not an empty new rating", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.tap({ text: "Изменить", within: "#v-place .trips" });
  await page.waitFor(`document.querySelector(".edit-head") && !document.getElementById("fDelete").hidden`, 4000, "edit form");
  await press('[data-score="интернет"][data-v="2"]');
  await sleep(400);
  await cutSave("#/rank");
  assert.equal((await doc("ratings/r1.json")).scores["интернет"], 4, "precondition: GitHub never got the edit");
  const banner = await page.eval(`[...document.querySelectorAll("#v-rank .banner.err")].map(b => b.innerText).join(" | ")`);
  assert.match(banner, /Правка оценки «Порту» не успела сохраниться/, "the rating already exists on GitHub, so the old check took it as saved and said nothing");
  assert.equal(await page.eval(`(document.querySelector("#v-rank .banner.err a[href^='#/rate']") || {}).hash`), "#/rate/r1");
  await page.eval(`location.hash = "#/map"`);
  await sleep(500);
  assert.match((await mapNote() || {}).text || "", /Правка оценки «Порту»/, "the map tells it too");
  await page.tap({ sel: "#mapNote a" });
  await page.waitFor(`document.querySelector(".edit-head") && location.hash === "#/rate"`, 5000, "edit form");
  assert.equal(await page.eval(`document.querySelector('[data-score="интернет"][data-v="2"]').getAttribute("aria-pressed")`), "true", "the link opens my unsaved edit");
  await press("#fSave");
  await page.waitFor(`location.hash === "#/place/porto"`, 8000, "saved");
  assert.equal((await doc("ratings/r1.json")).scores["интернет"], 2);
  assert.doesNotMatch(await page.text("#v-place"), /не успела сохраниться/);
});

test("pressing «Обновить» many times in a row sends one check at a time, not a burst", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await sleep(200);
  await page.eval(`window.__gh.length = 0; localStorage.setItem("mock:delay", "600")`);
  for (let i = 0; i < 5; i++) await page.eval(`document.getElementById("syncBtn").click()`);
  await sleep(1500);
  const n = await page.eval(`window.__gh.filter(c => c.u === "/graphql").length`);
  assert.ok(n <= 2, `${n} full downloads for 5 quick taps`);
});

/* ---------- part 2c: a returning visit served from the offline copy ---------- */

test("the ranking on a returning visit (served from the offline copy) is the same as on the first visit", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await settledWorld();
  await sleep(300);
  const first = await rankRows();
  await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "offline copy installed");
  await relaunch("#/rank");
  assert.equal(await swControlled(), true, "the second visit really came from the offline copy");
  await settledWorld();
  await sleep(300);
  assert.ok(first.length >= 2, "ranking rows: " + first.join(" | "));
  assert.deepEqual(await rankRows(), first);
});

test("a dossier opened on a returning visit shows the same total and fill share as on the first visit", { skip }, async () => {
  const big = async () => page.eval(`(() => { const b = document.querySelector("#v-place .bigscore"); return b ? b.parentElement.innerText.replace(/\\s+/g, " ").slice(0, 80) : ""; })()`);
  await openApp(page, srv.url, { hash: "#/place/valensiya" });
  await settledWorld();
  await sleep(300);
  const first = await big();
  await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "offline copy installed");
  await relaunch("#/place/valensiya");
  await settledWorld();
  await sleep(300);
  assert.ok(first, "dossier score shown");
  assert.equal(await big(), first);
});

test("on a returning visit the map shows the same pins as on the first visit", { skip }, async () => {
  const pins = () => page.eval(`[...document.querySelectorAll(".leaflet-marker-icon")].map(m => (m.getAttribute("aria-label") || m.title || m.innerText).trim()).sort()`);
  await openApp(page, srv.url, { hash: "#/map" });
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length >= 5`, 6000, "pins");
  await settledWorld();
  await sleep(300);
  const first = await pins();
  await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "offline copy installed");
  await relaunch("#/map");
  await page.waitFor(`document.querySelectorAll(".leaflet-marker-icon").length >= 5`, 6000, "pins again");
  await settledWorld();
  await sleep(300);
  assert.deepEqual(await pins(), first);
});

test("«Показать всё равно» is still in effect after the app is really closed and reopened", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/tbilisi" });
  assert.match(await page.text("#v-place"), /Вика: оценка скрыта/);
  await page.tap({ text: "Показать всё равно" });
  assert.match(await page.text("#v-place .trips"), /Пыльно и шумно/);
  await page.eval(`window.__sameDocument = true`);
  await relaunch("#/place/tbilisi");
  assert.equal(await page.eval(`window.__sameDocument === true`), false, "the app was not really reopened");
  assert.match(await page.text("#v-place .trips"), /Пыльно и шумно/, "the reveal was forgotten when the app was reopened");
});

test("a returning visit without internet still opens the last screen with our data and says it is offline", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/places" });
  await page.waitFor(`!!navigator.serviceWorker.controller`, 15000, "offline copy installed");
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await relaunch("#/places");
  const t = await page.text("#v-places");
  assert.match(t, /Порту/);
  assert.match(await page.text("#syncText"), /Нет связи/);
  assert.deepEqual(page.takeErrors(), []);
});

/* ---------- part 2d: same result whatever the timing ---------- */

test("the ranking does not depend on how fast GitHub answers", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await settledWorld();
  await sleep(300);
  const fast = await rankRows();
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`localStorage.setItem("mock:delay", "1200")`);
  await relaunch("#/rank");
  await settledWorld();
  await sleep(300);
  assert.deepEqual(await rankRows(), fast);
});

test("switching screens quickly while the first load is still running ends on the last screen with no errors", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/map" });
  await page.goto(srv.url + "manifest.webmanifest", 50);
  await page.eval(`localStorage.setItem("mock:delay", "800")`);
  await page.goto(srv.url + "#/map", 0);
  for (const h of ["#/rank", "#/places", "#/place/porto", "#/settings", "#/rank"]) { await page.eval(`location.hash = ${js(h)}`); await sleep(60); }
  await booted();
  await sleep(300);
  assert.equal(await page.eval(`location.hash`), "#/rank");
  assert.equal(await page.eval(`!document.getElementById("v-rank").hidden`), true, "the ranking is on screen");
  assert.equal(await page.eval(`[...document.querySelectorAll(".view")].filter(v => !v.hidden).length`), 1, "exactly one screen visible");
  assert.match(await page.text("#v-rank"), /Порту|Валенсия/);
  assert.deepEqual(page.takeErrors(), []);
});

test("the place card saved on a slow network is written once even if I leave the dossier before GitHub answers", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.eval(`localStorage.setItem("mock:delay", "1000"); localStorage.removeItem("mock:log")`);
  await page.fill('[name="fact_rent"]', "880");
  await page.tap({ text: "Сохранить цифры" }, 50);
  await page.eval(`location.hash = "#/rank"`);
  await page.waitFor(`JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).facts?.rent?.v === 880`, 8000, "rent saved");
  await sleep(1200);
  const adds = (await page.eval(`JSON.parse(localStorage.getItem("mock:log") || "[]")`)).filter(e => e.path === "places/porto.json");
  assert.equal(adds.length, 1, "the card was written more than once");
  assert.deepEqual(page.takeErrors(), []);
});
