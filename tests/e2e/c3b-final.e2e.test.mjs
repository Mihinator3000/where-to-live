import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, repo, PLACES } from "./fixtures.mjs";

// Cycle 3b, last walkthrough findings: one name for the data repo, one «Кто вы» picker on the rate screen, «Отсев и вето»
// in the ranking, the extra answers in the save bar, tap targets of summaries and «Похожие», and no «·» left dangling at
// the end of a line in «Места». Synthetic data only; GitHub is mocked.

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const js = JSON.stringify;

async function open(opts = {}, [w, h] = [390, 844]) {
  await page.viewport(w, h);
  await openApp(page, srv.url, opts);
  await sleep(250);
  page.takeErrors();
}
async function press(sel, settle = 200) {
  const ok = await page.eval(`(() => { const e = document.querySelector(${js(sel)}); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
  if (!ok) throw new Error("press: not found " + sel);
  return page.tap({ sel }, settle);
}
const oneLine = s => String(s).replace(/\s+/g, " ").trim();

test("the repo-not-found banner names «хранилище» and «Технические подробности», and that block opens with the «Хранилище» field", { skip }, async () => {
  await open({ hash: "#/places", files: null });
  await page.waitFor(`/не найдено/.test(document.querySelector("#v-places .banner.err")?.innerText || "")`, 10000, "access banner");
  const banner = oneLine(await page.text("#v-places .banner.err"));
  assert.match(banner, /название хранилища/, `«${banner}»`);
  assert.match(banner, /Технические подробности/, `«${banner}»`);
  await page.eval(`location.hash = "#/settings"`);
  await sleep(400);
  const lbl = await page.eval(`document.querySelector('input[name="repo"]').closest("label").querySelector(".lbl").innerText`);
  assert.match(lbl, /^Хранилище с данными/, `«${lbl}»`);
  assert.equal(await page.eval(`document.querySelector('input[name="repo"]').closest("details").open`), true, "the field the banner sends me to is hidden in a closed block");
});

test("a repo name in the wrong shape is reported as «Хранилище укажите…»", { skip }, async () => {
  await open({ hash: "#/settings" });
  await page.eval(`(() => { const d = document.querySelector('input[name="repo"]').closest("details"); d.open = true; })()`);
  await page.fill('input[name="repo"]', "просто имя");
  await page.fill('input[name="token"]', "github_pat_TEST_e2e");
  await press('#v-settings form button[type="submit"]', 400);
  assert.match(await page.text("#tokenMsg"), /^Хранилище укажите как владелец\/имя/);
});

test("without «Кто я» the rate screen has one picker, «Кто оценивает», while other screens keep the «Кто вы» banner", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", me: null });
  assert.equal(await page.eval(`document.querySelectorAll("#v-rate [data-setme]").length`), 0);
  assert.equal(await page.eval(`document.querySelectorAll("#fWho [data-who]").length`), 2);
  await page.eval(`location.hash = "#/places"`);
  await sleep(400);
  assert.match(await page.text("#v-places"), /Кто вы на этом устройстве/);
});

test("the ranking lists vetoed and dropped places under «Отсев и вето», the same name as in «Места»", { skip }, async () => {
  await open({ hash: "#/rank", files: repo({ places: PLACES.map(p => p.name === "Белград" ? Object.assign({}, p, { status: "отсев", reason: "дорого" }) : p) }) });
  const rank = oneLine(await page.text("#v-rank"));
  assert.match(rank, /Отсев и вето: /, rank.slice(-300));
  assert.doesNotMatch(rank, /Отсев: /);
  await page.eval(`location.hash = "#/places"`);
  await sleep(400);
  assert.match(await page.text("#plist"), /отсев и вето/i);
});

test("the save bar names answers outside ★ instead of an unexplained «ещё N», and stays one row beside the button", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi" });
  const star = await page.eval(`document.querySelector('.q[data-star="1"]')?.dataset.q || ""`);
  const plain = await page.eval(`document.querySelector('.q[data-star="0"]')?.dataset.q || ""`);
  assert.ok(star && plain, "need one ★ question and one other");
  await press(`[data-score="${star}"][data-v="4"]`);
  await page.eval(`(() => { const b = document.getElementById("fShowAll"); if (b && !b.hidden) b.click(); const o = document.getElementById("fOnlyStar"); if (o && o.checked) o.click(); })()`);
  await sleep(200);
  await press(`[data-score="${plain}"][data-v="3"]`);
  const t = await page.text("#fCounts");
  assert.match(t, /и 1 ответ без ★/, `«${t}»`);
  assert.doesNotMatch(t, /ещё \d/, `«${t}»`);
  const r = await page.eval(`(() => { const c = document.getElementById("fCounts").getBoundingClientRect(), b = document.querySelector(".savebar .btn:not(.ghost)").getBoundingClientRect(); return { c: Math.round(c.top + c.height / 2), b: Math.round(b.top), bb: Math.round(b.bottom) }; })()`);
  assert.ok(r.c >= r.b && r.c <= r.bb, `the counter is not beside the save button: ${js(r)}`);
});

test("summaries and «Похожие» rows are at least 40 px tall to tap; summaries inside a sentence keep at least 24 px", { skip }, async () => {
  await open({ hash: "#/place/porto" });
  await sleep(300);
  const r = await page.eval(`(() => {
    const vis = e => e.getClientRects().length > 0;
    const sums = [...document.querySelectorAll("#v-place summary")].filter(s => vis(s) && !s.closest("details.inline")).map(s => ({ t: s.innerText.trim().slice(0, 30), h: Math.round(s.getBoundingClientRect().height) }));
    const sims = [...document.querySelectorAll("#v-place .sim-row button, #v-place .sim-row a")].filter(vis).map(s => ({ t: s.innerText.trim().slice(0, 30), h: Math.round(s.getBoundingClientRect().height) }));
    return { sums, sims };
  })()`);
  assert.ok(r.sums.length, "no summary on the dossier, the check proves nothing");
  assert.deepEqual(r.sums.filter(s => s.h < 40), [], "summaries under 40 px");
  assert.deepEqual(r.sims.filter(s => s.h < 40), [], "«Похожие» rows under 40 px");
  const inline = await page.eval(`[...document.querySelectorAll("details.inline summary")].filter(e => e.getClientRects().length).map(s => Math.round(s.getBoundingClientRect().height))`);
  assert.deepEqual(inline.filter(h => h < 24), [], "an inline summary under the 24 px minimum");
});

test("in «Места» no line of a place's facts ends with a dangling «·»; the year answers sit on their own line", { skip }, async () => {
  const bad = [];
  let yr = 0;
  for (const w of [390, 320]) {
    await open({ hash: "#/places" }, [w, 844]);
    const rows = await page.eval(`[...document.querySelectorAll("#plist .prow .meta")].map(m => { const items = [...m.children], tops = items.map(s => Math.round(s.getBoundingClientRect().top)); const dot = s => /[·•|]/.test(getComputedStyle(s, "::after").content || "") && getComputedStyle(s, "::after").visibility !== "hidden"; return { name: m.closest(".prow").querySelector("b").innerText, yr: m.classList.contains("yr"), text: m.innerText, tail: items.filter((s, i) => i < items.length - 1 && tops[i + 1] > tops[i] && dot(s)).map(s => s.innerText) }; })`);
    yr += rows.filter(r => r.yr && /прожили бы здесь год/.test(r.text)).length;
    rows.forEach(r => { if (r.tail.length) bad.push(`${w}px ${r.name}: «${r.tail[0]} ·» ends a line`); });
    assert.deepEqual(rows.filter(r => !r.yr && /прожили бы/.test(r.text)).map(r => r.name), [], "the year answers are still mixed into the dotted facts");
  }
  assert.ok(yr > 0, "no place shows year answers, the check proves nothing");
  assert.deepEqual(bad, []);
});

test("without «Кто я», choosing «Кто оценивает» tells the device who it is at once: the form sees that person's rating", { skip }, async () => {
  await open({ hash: "#/rate/new/tbilisi", me: null });
  await press('[data-who="Вика"]', 400);
  assert.match(await page.text("#toast"), /Это устройство: Вика\. Поменять можно в настройках/);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:me"))`), "Вика");
  assert.match(oneLine(await page.text("#v-rate")), /уже есть оценка/i, "Вика's own Тбилиси rating is not offered for editing, a duplicate would be saved");
});

test("without «Кто я», a rating saved from the form is visible right away in the dossier, not «скрыта»", { skip }, async () => {
  await open({ hash: "#/rate/new/batumi", me: null });
  await press('[data-who="Вика"]', 300);
  const stars = await page.eval(`[...document.querySelectorAll('.q[data-star="1"]')].slice(0, 5).map(q => q.dataset.q)`);
  for (const k of stars) await press(`[data-score="${k}"][data-v="4"]`, 100);
  await press("#fSave", 300);
  await page.waitFor(`location.hash.startsWith("#/place/batumi") && document.querySelector("#v-place .trips")`, 15000, "dossier after save");
  await sleep(300);
  const t = oneLine(await page.text("#v-place"));
  assert.doesNotMatch(t, /скрыт/, t.slice(0, 400));
  assert.doesNotMatch(t, /Кто вы на этом устройстве/);
});

test("on «Настройки» with a lost change and no «Кто я» there is one «Кто я» picker, not a second one in the banner", { skip }, async () => {
  await open({ hash: "#/settings", me: null, local: { "wtl:lost": [{ at: "2026-10-01T10:00:00.000Z", path: "places/porto.json", content: "{}\n", baseOid: "old", message: "Update place porto", why: "rejected", reason: "test" }] } });
  assert.equal(await page.eval(`document.querySelectorAll("#v-settings [data-setme]").length`), 0);
  assert.equal(await page.eval(`document.querySelectorAll("#meSeg [data-me]").length`), 2);
});
