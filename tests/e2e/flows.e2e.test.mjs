import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, CHROME } from "./cdp.mjs";
import { serve } from "./server.mjs";
import { openApp, mockFiles, mockLog } from "./fixtures.mjs";

const skip = !CHROME && "no Chrome";
let srv, page;

before(async () => { srv = await serve(); page = await launch(); });
after(async () => { await page?.close(); await srv?.close(); });

const toastText = (re = /./) => page.waitFor(`(() => { const t = document.getElementById("toast"); return !t.hidden && ${re}.test(t.innerText) && t.innerText; })()`, 6000, "toast " + re);
const doc = async path => { const f = (await mockFiles(page))[path]; return f ? JSON.parse(f) : null; };
const ratingsOn = async place => Object.entries(await mockFiles(page)).filter(([k]) => k.startsWith("ratings/")).map(([, v]) => JSON.parse(v)).filter(r => r.place === place && !r.deleted);

async function fillTrip(place, start = "2026-09-01", end = "2026-09-14") {
  await page.select("#fPlace", place);
  await page.fill("#fStart", start);
  await page.fill("#fEnd", end);
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.tap({ sel: '[data-score="улица"][data-v="3.5"]' });
}

test("rating a trip saves one file and opens the dossier with it", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await fillTrip("Батуми");
  assert.match(await page.text("#fCounts"), /2 из 10/);
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`location.hash === "#/place/batumi"`, 5000, "dossier opened");
  assert.match(await toastText(), /Сохранено/);
  const rs = await ratingsOn("batumi");
  assert.equal(rs.length, 1);
  assert.equal(rs[0].who, "Михаил");
  assert.deepEqual(rs[0].scores, { "интернет": 4, "улица": 3.5 });
  assert.equal(rs[0].days, 14, "both ends count");
  assert.match(await page.text("#v-place"), /Михаил/);
  assert.deepEqual(page.takeErrors(), []);
});

test("a trip that ends before it starts is not saved", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await fillTrip("Батуми", "2026-09-14", "2026-09-01");
  await page.tap({ sel: "#fSave" });
  assert.match(await page.text("#fMsg"), /раньше/);
  assert.equal((await ratingsOn("batumi")).length, 0);
  assert.equal(await page.eval("location.hash"), "#/rate");
});

test("questions for the next trip are appended to the place card", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await fillTrip("Порту");
  await page.fill("#fQuestions", "Где стирать зимой?");
  await page.tap({ sel: "#fSave" });
  await page.waitFor(`location.hash === "#/place/porto"`);
  const p = await doc("places/porto.json");
  assert.equal(p.questions, "Проверить сырость зимой\nГде стирать зимой?");
  assert.equal((await mockLog(page)).filter(e => e.op === "add").length, 2, "rating and place in one commit");
});

test("partner's rating stays hidden until I rate the place, with a way to peek", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/tbilisi" });
  const t = await page.text("#v-place");
  assert.match(t, /Вика: оценка скрыта/);
  assert.doesNotMatch(t, /Пыльно и шумно/);
  await page.tap({ text: "Показать всё равно" });
  assert.match(await page.text("#v-place"), /Пыльно и шумно/);
});

test("ranking only lists places with enough of our own answers", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  const t = await page.text("#v-rank");
  assert.match(t, /мало своих оценок/i);
  const main = await page.eval(`[...document.querySelectorAll("#v-rank .row:not(.pale)")].map(r => r.innerText.split("\\n")[0]).join("|")`);
  assert.doesNotMatch(main, /Белград/, "a place with only world data is not in the main list");
});

test("offline save is queued on the device and sent when the network is back", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.eval(`localStorage.setItem("mock:offline", "1")`);
  await fillTrip("Батуми");
  await page.tap({ sel: "#fSave" });
  assert.match(await toastText(), /Нет связи/);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:pending")).length`), 1);
  assert.equal((await ratingsOn("batumi")).length, 0);
  await page.eval(`localStorage.removeItem("mock:offline")`);
  await page.tap({ sel: "#syncBtn" });
  await page.waitFor(`JSON.parse(localStorage.getItem("wtl:pending") || "[]").length === 0`, 6000, "queue flushed");
  assert.equal((await ratingsOn("batumi")).length, 1);
  assert.match(await toastText(/Отправлено из очереди/), /Отправлено из очереди: 1/);
});

test("rent typed into place numbers turns into a score against SPb", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.fill('[name="fact_rent"]', "825");
  await page.fill('[name="src_rent"]', "idealista, 20 объявлений");
  await page.tap({ text: "Сохранить цифры" });
  assert.match(await toastText(), /Цифры сохранены/);
  const p = await doc("places/porto.json");
  assert.equal(p.facts.rent.v, 825);
  assert.equal(p.facts.rent.src, "idealista, 20 объявлений");
  await page.waitFor(`document.querySelector('#factsForm .badge')`, 4000, "score badge");
  assert.equal(await page.text("#factsForm .badge"), "2.0", "1.5× SPb rent is one point below SPb");
});

test("place card hides the base status and shows the reason only for rejected places", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  const opts = await page.eval(`[...document.querySelectorAll('#placeForm [name="status"] option')].map(o => o.value)`);
  assert.ok(!opts.includes("база"));
  assert.equal(await page.visible("#reasonBox"), false);
  await page.select('#placeForm [name="status"]', "отсев");
  assert.equal(await page.visible("#reasonBox"), true);
});

test("an unsaved draft survives switching places and can be thrown away", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rate" });
  await page.select("#fPlace", "Батуми");
  await page.tap({ sel: '[data-score="интернет"][data-v="4"]' });
  await page.goto(srv.url + "#/rate/new/porto", 400);
  assert.equal(await page.eval(`document.getElementById("fPlace").value`), "porto");
  assert.match(await page.text(".draft-chip .linkbtn"), /Батуми \(1 ответ\)/);
  await page.tap({ sel: ".chipx" });
  assert.match(await page.text(".chipx"), /Выбросить\?/);
  await page.tap({ sel: ".chipx" });
  assert.equal(await page.visible(".draft-chip"), false);
  assert.deepEqual(await page.eval(`JSON.parse(localStorage.getItem("wtl:drafts"))`), {});
});

test("a wrong key is rejected and the old one is kept", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.fill('[name="token"]', "github_pat_WRONG");
  await page.tap({ text: "Сохранить и проверить" });
  await page.waitFor(`/не подошёл/.test(document.getElementById("tokenMsg").innerText)`, 5000, "rejection message");
  assert.match(await page.text("#tokenMsg"), /Остался прежний ключ/);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("wtl:token"))`), "github_pat_TEST_e2e");
});

test("forgetting the key needs a second tap", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/settings" });
  await page.tap({ sel: "#forget" });
  assert.match(await page.text("#forget"), /Точно забыть/);
  assert.ok(await page.eval(`localStorage.getItem("wtl:token") !== null`));
  await page.tap({ sel: "#forget" });
  assert.equal(await page.eval(`localStorage.getItem("wtl:token")`), null);
  assert.match(await toastText(), /Ключ и данные удалены/);
});

test("saved weights become a preset for that person", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/rank" });
  await page.eval(`(() => { const d = document.getElementById("wdetails"); d.open = true; d.dispatchEvent(new Event("toggle")); })()`);
  await page.fill("#wgrid input[type=range]", "80");
  await page.tap({ sel: "#wsaveBtn" });
  await page.waitFor(`Object.keys(JSON.parse(localStorage.getItem("mock:files"))).some(k => k.startsWith("weights/"))`, 5000, "weights file");
  await page.waitFor(`[...document.querySelectorAll("#v-rank button, #v-rank [role=tab]")].some(b => b.innerText.trim() === "Михаил")`, 5000, "preset button");
  assert.deepEqual(page.takeErrors(), []);
});

test("a non-number in place numbers is refused instead of wiping the saved value", { skip }, async () => {
  const files = (await import("./fixtures.mjs")).repo();
  const porto = JSON.parse(files["places/porto.json"]);
  porto.facts = { rent: { v: 700, src: "idealista", at: "2026-10-01" } };
  files["places/porto.json"] = JSON.stringify(porto);
  await openApp(page, srv.url, { hash: "#/place/porto", files });
  await page.fill('[name="fact_rent"]', "около тысячи");
  await page.tap({ text: "Сохранить цифры" });
  assert.match(await page.text("#factsMsg"), /Не число/);
  assert.equal((await doc("places/porto.json")).facts.rent.v, 700);
  await page.fill('[name="fact_rent"]', "1 050 €");
  await page.tap({ text: "Сохранить цифры" });
  await page.waitFor(`JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).facts.rent.v === 1050`, 5000, "rent saved");
});

test("saving numbers keeps unsaved text in the place card", { skip }, async () => {
  await openApp(page, srv.url, { hash: "#/place/porto" });
  await page.fill('#placeForm [name="questions"]', "Черновик вопроса");
  await page.fill('[name="fact_dinner"]', "40");
  await page.tap({ text: "Сохранить цифры" });
  assert.match(await toastText(/Цифры сохранены/), /Цифры сохранены/);
  assert.equal(await page.eval(`document.querySelector('#placeForm [name="questions"]').value`), "Черновик вопроса");
  await page.tap({ text: "Сохранить карточку" });
  await page.waitFor(`JSON.parse(JSON.parse(localStorage.getItem("mock:files"))["places/porto.json"]).questions === "Черновик вопроса"`, 5000, "card saved");
  const p = await doc("places/porto.json");
  assert.equal(p.facts.dinner.v, 40, "the card save did not drop the numbers saved a moment ago");
});
