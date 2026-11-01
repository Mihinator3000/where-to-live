import "./helpers/env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModel, normalize } from "../js/calc.js";
import { rankHTML, tripsHTML, hiddenNote } from "../js/views.js";
import { makeRemote } from "./helpers/remote.mjs";
import { serialize, GitHubStore } from "../js/store.js";
import { Data } from "../js/data.js";

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8"));
const [ME, PARTNER] = schema.people;
const EQUAL = normalize(schema.groups, {});
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'" };
const text = html => html.replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, m => ENT[m]).replace(/\s+/g, " ").trim();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} expected ${b}, got ${a}`);

const place = (id, name, extra = {}) => Object.assign({ id, name, status: "кандидат", ext: {} }, extra);
const BASE = place("spb", "Санкт-Петербург", { status: "база" });
let rid = 0;
const rating = (placeId, who, scores, extra = {}) => Object.assign({ id: "m" + String(++rid).padStart(4, "0"), place: placeId, who, start: "2026-08-01", end: "2026-08-14", season: "", mode: "", retro: false, year: null, veto: "", review: "", scores, conf: {}, notes: {} }, extra);

function build(data, { me = "", revealed = [], autoData } = {}) {
  const v = { places: data.places || [], ratings: data.ratings || [], weights: data.weights || {} };
  const full = createModel(schema, v, { autoData });
  const hid = new Set(), rev = new Set(revealed);
  if (me) full.places.forEach(p => {
    const rs = full.ratingsOf(p.id);
    if (rev.has(p.id) || rs.some(r => r.who === me)) return;
    rs.forEach(r => { if (r.who !== me) hid.add(p.id + "|" + r.who); });
  });
  const M = hid.size ? createModel(schema, Object.assign({}, v, { ratings: v.ratings.filter(r => !hid.has(r.place + "|" + r.who)) }), { autoData }) : full;
  M.hidden = (id, w) => hid.has(id + "|" + w);
  M.full = full;
  return M;
}

const rows = html => html.split(/<a class="row/).slice(1).map(r => text("<a " + r));
const rowOf = (html, name) => rows(html).find(r => r.includes(name)) || null;

/* ---------- trip weights ---------- */

test("a trip rated from memory («по памяти») pulls the average less than a fresh trip, as the form promises", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [BASE, a], ratings: [
    rating("alpha", ME, { "шум": 5 }, { retro: false }),
    rating("alpha", ME, { "шум": 1 }, { retro: true }),
  ] });
  near(M.personCat("alpha", ME, "шум"), (5 * 1 + 1 * 0.8) / 1.8, "fresh 5 and a memory 1 should average closer to 5:");
  assert.ok(M.personCat("alpha", ME, "шум") > 3, "the fresh trip should win over the one rated from memory");
});

/* ---------- ranking boundaries ---------- */

const cityAndLinks = normalize(schema.groups, { city: 50, links: 50 });
function halfCovered() {
  const a = place("alpha", "Альфа");
  return build({ places: [BASE, a], ratings: [rating("alpha", ME, { "пешком": 4, "чистота": 4, "эстетика": 4, "фонд": 4, "шум": 4 })] });
}

test("a place with exactly half of the weighted groups filled gets its №N in the dossier, the same as its position in the ranking", () => {
  const M = halfCovered();
  assert.equal(M.total(M.PLACE.alpha, cityAndLinks, "final").coverage, 0.5);
  assert.equal(M.ownShare("alpha"), 0.5);
  const html = rankHTML(M, cityAndLinks, {}, true);
  assert.match(rowOf(html, "Альфа"), /^1 /, "the ranking list shows Альфа at position 1");
  assert.equal(M.ranksFor(cityAndLinks).alpha, 1, "the dossier's «№N в рейтинге» must agree with the list");
});

test("a place with exactly half of the weighted groups filled is ranked, not listed as «заполнено меньше 50%»", () => {
  const M = halfCovered();
  const r = M.ranking(cityAndLinks, true);
  assert.deepEqual(r.rated.map(x => x.p.id), ["alpha"]);
  assert.deepEqual(r.thin.map(x => x.p.id), []);
  const html = text(rankHTML(M, cityAndLinks, {}, true));
  assert.doesNotMatch(html, /меньше 50%[^.]*Альфа — 50%/, "a place filled exactly 50% must not be called «меньше 50%»");
});

/* ---------- rank range ---------- */

function closePair() {
  const a = place("alpha", "Альфа"), b = place("beta", "Бета");
  const common = { "улица": 3, "кожа": 3, "фонд": 3, "море": 3, "язык": 3 };
  return build({ places: [BASE, a, b], ratings: [
    rating("alpha", ME, Object.assign({ "интернет": 4, "пешком": 3 }, common)),
    rating("beta", ME, Object.assign({ "интернет": 3, "пешком": 3.9 }, common)),
  ] });
}

test("two places so close that a 20% change of one group's weight swaps them both show a «№1–2 в зависимости от весов» chip", () => {
  const M = closePair();
  assert.equal(M.hasOwnWeights, false, "nobody saved weights, so only the ±20% check can reveal the swap");
  const ranks = M.ranksFor(EQUAL);
  assert.deepEqual([ranks.alpha, ranks.beta], [1, 2]);
  const range = M.rankRange(EQUAL);
  assert.deepEqual(range.alpha, { min: 1, max: 2 });
  assert.deepEqual(range.beta, { min: 1, max: 2 });
  const html = rankHTML(M, EQUAL);
  assert.match(rowOf(html, "Альфа"), /№1–2 в зависимости от весов/);
  assert.match(rowOf(html, "Бета"), /№1–2 в зависимости от весов/);
});

test("a worst-season trip weighs twice and an off-season trip one and a half times an ordinary peak trip, as the form says", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [BASE, a], ratings: [
    rating("alpha", ME, { "шум": 5 }, { season: "пик" }),
    rating("alpha", ME, { "шум": 1 }, { season: "межсезон" }),
    rating("alpha", PARTNER, { "шум": 5 }, { season: "пик" }),
    rating("alpha", PARTNER, { "шум": 1 }, { season: "худший" }),
  ] });
  near(M.personCat("alpha", ME, "шум"), (5 * 1 + 1 * 1.5) / 2.5, "peak 5 + off-season 1:");
  near(M.personCat("alpha", PARTNER, "шум"), (5 * 1 + 1 * 2) / 3, "peak 5 + worst season 1:");
});

/* ---------- flags at exactly 1.5 ---------- */

test("our score exactly 1.5 above what residents say is flagged as «иллюзия туриста», exactly 1.5 below as «недооценили», as the legend promises", () => {
  const a = place("alpha", "Альфа", { ext: { "шум": { res: 3 }, "улица": { res: 4.5 } } });
  const M = build({ places: [BASE, a], ratings: [rating("alpha", ME, { "шум": 4.5, "улица": 3 })] });
  assert.deepEqual(M.catFlags(a, "шум").map(f => f.short), ["иллюзия туриста"]);
  assert.match(M.catFlags(a, "шум")[0].text, /мы 4\.5, живущие 3\.0/);
  assert.deepEqual(M.catFlags(a, "улица").map(f => f.short), ["недооценили"]);
});

/* ---------- offline queue: several edits of one card ---------- */

const P = { id: "budva", name: "Будва", status: "кандидат", archetype: "", questions: "" };
function remoteSetup(files) {
  localStorage.clear();
  localStorage.setItem("wtl:token", JSON.stringify("tok"));
  const remote = makeRemote(files);
  globalThis.fetch = remote.fetchImpl;
  const phoneB = new GitHubStore({ owner: "x", repo: "y", token: "t", fetchImpl: remote.fetchImpl });
  const editB = async (path, change) => { await phoneB.load(); const doc = JSON.parse(remote.state.files[path]); change(doc); await phoneB.commit([{ path, content: serialize(doc), baseOid: phoneB.oids[path] }], "B"); };
  const filesIn = dir => Object.entries(remote.state.files).filter(([k]) => k.startsWith(dir + "/")).map(([, v]) => JSON.parse(v));
  return { remote, editB, filesIn, read: path => JSON.parse(remote.state.files[path]) };
}

test("changing one card field twice offline is not blamed on «another device» when the other phone changed a different field", async () => {
  const { remote, editB, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  assert.equal((await a.updatePlace("budva", { archetype: "город у моря" })).r, "queued");
  remote.state.offlineNext = 1;
  assert.equal((await a.updatePlace("budva", { archetype: "курорт" })).r, "queued");
  await editB("places/budva.json", d => { d.status = "финалист"; });
  await a.refresh();
  assert.deepEqual(a.lost, [], "only I changed the archetype, so nothing may land in «Не отправлено»");
  assert.equal(a.notice, "");
  const fin = read("places/budva.json");
  assert.equal(fin.archetype, "курорт");
  assert.equal(fin.status, "финалист");
});

test("questions from two ratings saved offline both reach the place card when the other phone edited the card meanwhile", async () => {
  const { remote, editB, read, filesIn } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  await a.saveRating({ place: "budva", who: ME, scores: { "шум": 3 } }, { questions: "Есть ли зимой отопление?" });
  remote.state.offlineNext = 1;
  await a.saveRating({ place: "budva", who: PARTNER, scores: { "шум": 4 } }, { questions: "Где ближайший стоматолог?" });
  await editB("places/budva.json", d => { d.status = "финалист"; });
  await a.refresh();
  assert.equal(a.pending.length, 0);
  assert.deepEqual(a.lost, []);
  const fin = read("places/budva.json");
  assert.equal(fin.status, "финалист");
  assert.match(fin.questions, /отопление/, "the first rating's question must not be dropped");
  assert.match(fin.questions, /стоматолог/);
  assert.equal(filesIn("ratings").length, 2);
});

/* ---------- offline queue and clashes: what reaches GitHub and what lands in «Не отправлено» ---------- */

async function offline(remote, fn) { remote.state.offlineNext = 1; return fn(); }

test("a question added to the card is merged with the partner's new question also when the phone already pulled it in the background", async () => {
  const { editB, read } = remoteSetup({ "places/budva.json": serialize(Object.assign({}, P, { questions: "Есть ли зимой отопление?" })) });
  const a = new Data();
  await a.refresh();
  await editB("places/budva.json", d => { d.questions = "Есть ли зимой отопление?\nСколько стоит садик?"; });
  await a.poll();
  assert.match(a.docOf("places/budva.json").questions, /садик/, "fixture: the background check has brought the partner's question");
  const res = await a.updatePlace("budva", { questions: "Есть ли зимой отопление?\nГде ближайший стоматолог?" }, { base: { questions: "Есть ли зимой отопление?" } }).catch(e => e);
  assert.equal(res.code, undefined, `adding a line must merge like it does without the background check, got «${res.message}»`);
  assert.equal(res.r, "sent");
  const q = read("places/budva.json").questions;
  assert.match(q, /садик/, "the partner's question must survive");
  assert.match(q, /стоматолог/);
});

test("questions keep the order they were asked when a card edit and a rating question were both waiting offline", async () => {
  const { remote, editB, read } = remoteSetup({ "places/budva.json": serialize(Object.assign({}, P, { questions: "Q1" })) });
  const a = new Data();
  await a.refresh();
  await offline(remote, () => a.updatePlace("budva", { questions: "Q1\nQ3 — из карточки" }, { base: { questions: "Q1" } }));
  await offline(remote, () => a.saveRating({ place: "budva", who: ME, scores: { "шум": 3 } }, { questions: "Q4 — из оценки" }));
  await editB("places/budva.json", d => { d.questions = "Q1\nQ2 — с другого телефона"; });
  await a.refresh();
  assert.deepEqual(a.lost, []);
  assert.deepEqual(read("places/budva.json").questions.split("\n"), ["Q1", "Q2 — с другого телефона", "Q3 — из карточки", "Q4 — из оценки"]);
});

test("a second clash adds to «Не отправлено» instead of wiping the first unsent change", async () => {
  const BAR = { id: "bar", name: "Бар", status: "кандидат", archetype: "", questions: "" };
  const { remote, editB } = remoteSetup({ "places/budva.json": serialize(P), "places/bar.json": serialize(BAR) });
  const a = new Data();
  await a.refresh();
  await offline(remote, () => a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } }));
  await editB("places/budva.json", d => { d.archetype = "город"; });
  await a.refresh();
  assert.equal(a.lost.length, 1);
  await offline(remote, () => a.updatePlace("bar", { archetype: "деревня" }, { base: { archetype: "" } }));
  await editB("places/bar.json", d => { d.archetype = "город"; });
  await a.refresh();
  assert.deepEqual(a.lost.map(l => l.path).sort(), ["places/bar.json", "places/budva.json"], "the first unsent change must still be there");
});

test("after the network comes back with nothing new on GitHub the status leaves «Нет связи»", async () => {
  const { remote } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  await a.poll();
  assert.equal(a.status, "live");
  remote.state.offlineNext = 1;
  await a.poll();
  assert.equal(a.status, "offline", "fixture: the check without network says «Нет связи»");
  await a.poll();
  assert.equal(a.status, "live", "GitHub answered «nothing new» (304), so we are online again");
});

/* ---------- what GitHub's error answers turn into ---------- */

function storeAnswering(res) {
  return new GitHubStore({ owner: "x", repo: "y", token: "t", fetchImpl: async () => res() });
}

test("GitHub's rate limit is reported with the time to wait, not as «GitHub временно не отвечает»", async () => {
  const at = Math.floor(Date.now() / 1000) + 600;
  const st = storeAnswering(() => new Response("{}", { status: 429, headers: { "x-ratelimit-reset": String(at) } }));
  const e = await st.load().catch(x => x);
  assert.equal(e.code, "limit");
  assert.match(e.message, /ограничил запросы — до \d\d:\d\d/);
});

test("GitHub silent for 15 seconds is reported as «не ответил», not as «Нет связи»", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const st = storeAnswering(() => new Promise(() => {}));
  const p = st.load().catch(x => x);
  await Promise.resolve();
  t.mock.timers.tick(15000);
  const e = await p;
  assert.equal(e.code, "timeout");
  assert.match(e.message, /не ответил за 15 секунд/);
});

/* ---------- what the ranking and the dossier say ---------- */

const HALF_KEYS = ["пешком", "чистота", "эстетика", "фонд", "шум"];
const scoresAll = v => Object.fromEntries(HALF_KEYS.map(k => [k, v]));

test("the empty ranking for the one who has not rated yet says «Вика уже оценила», «Михаил уже оценил»", () => {
  const a = place("alpha", "Альфа");
  const forMe = text(rankHTML(build({ places: [BASE, a], ratings: [rating("alpha", PARTNER, scoresAll(4))] }, { me: ME }), EQUAL, {}, true));
  assert.match(forMe, new RegExp(`${PARTNER} уже оценила 1 место`));
  const forPartner = text(rankHTML(build({ places: [BASE, a], ratings: [rating("alpha", ME, scoresAll(4))] }, { me: PARTNER }), EQUAL, {}, true));
  assert.match(forPartner, new RegExp(`${ME} уже оценил 1 место`));
});

test("my trip in a place the partner has not rated says the partner will see it after rating", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [BASE, a], ratings: [rating("alpha", ME, scoresAll(4))] }, { me: ME });
  assert.match(text(tripsHTML(M, M.PLACE.alpha, true, ME)), new RegExp(`${PARTNER} увидит эту оценку, когда оценит место`));
});

test("after switching to other weights the «в зависимости от весов» chip is recomputed for those weights, not kept from the previous ones", () => {
  const M = closePair();
  const workOnly = normalize(schema.groups, { work: 100 });
  assert.match(rowOf(rankHTML(M, EQUAL), "Альфа"), /№1–2 в зависимости от весов/, "fixture: with equal weights the two places can swap");
  const html = rankHTML(M, workOnly);
  assert.match(rowOf(html, "Альфа"), /^1 /, "fixture: with only «Работа» weighted Альфа (internet 4 against 3) is clearly first");
  assert.doesNotMatch(html, /в зависимости от весов/, "with only «Работа» weighted no swap is possible, so no range chip");
});

test("«Записать мою» tapped without network moves the row from «Не отправлено» to the queue, and it is written when the network is back", async () => {
  const { remote, editB, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  await offline(remote, () => a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } }));
  await editB("places/budva.json", d => { d.archetype = "город"; });
  await a.refresh();
  assert.equal(a.lost.length, 1);
  assert.equal(await offline(remote, () => a.applyLost(0)), "queued");
  assert.deepEqual(a.lost, [], "the row is now waiting in the queue; left in the list it invites a second tap");
  assert.equal(a.queued, 1);
  await a.refresh();
  assert.equal(read("places/budva.json").archetype, "курорт");
  assert.deepEqual(a.lost, []);
});

test("after «GitHub временно не отвечает» the next background check tries again even if nothing changed on GitHub", async () => {
  const { remote } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.failNext = 1;
  await a.refresh();
  assert.equal(a.status, "error", "fixture: GitHub answered 502");
  await a.poll();
  assert.equal(a.status, "live", "GitHub answers again, so the red banner must go away without waiting for a new commit");
  assert.equal(a.error, "");
});

test("a data repo deleted or renamed on GitHub is reported as «Хранилище не найдено» by the background check, not ignored", async () => {
  const { remote } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  let gone = false;
  globalThis.fetch = (url, o) => gone && String(url).includes("/commits/") ? Promise.resolve(new Response("{\"message\":\"Not Found\"}", { status: 404 })) : remote.fetchImpl(url, o);
  gone = true;
  await a.poll();
  assert.equal(a.status, "auth");
  assert.equal(a.errorCode, "access");
  assert.match(a.error, /Хранилище не найдено/);
});

test("GitHub's «retry after 2 minutes» answer is shown as a time two minutes from now", async () => {
  const st = storeAnswering(() => new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
  const hhmm = t => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const t0 = Date.now();
  const e = await st.load().catch(x => x);
  assert.equal(e.code, "limit");
  const ok = [hhmm(t0 + 120e3), hhmm(Date.now() + 120e3)];
  assert.ok(ok.some(x => e.message.endsWith("до " + x)), `expected «до ${ok[0]}», got «${e.message}»`);
});

test("a place's trips are listed newest first", () => {
  const a = place("alpha", "Альфа");
  const old = rating("alpha", ME, scoresAll(3), { start: "2025-05-01", end: "2025-05-10" });
  const fresh = rating("alpha", ME, scoresAll(4), { start: "2026-08-01", end: "2026-08-14" });
  const M = build({ places: [BASE, a], ratings: [old, fresh] });
  const html = tripsHTML(M, M.PLACE.alpha, true, ME);
  assert.ok(html.indexOf(`data-rid="${fresh.id}"`) < html.indexOf(`data-rid="${old.id}"`), "the 2026 trip comes before the 2025 one");
});

test("the note about several trips being combined appears only when one of us has more than one trip there", () => {
  const a = place("alpha", "Альфа");
  const note = /Несколько поездок одного человека/;
  const one = build({ places: [BASE, a], ratings: [rating("alpha", ME, scoresAll(4)), rating("alpha", PARTNER, scoresAll(3))] });
  assert.doesNotMatch(text(tripsHTML(one, one.PLACE.alpha, true, ME)), note, "one trip each: nothing is combined");
  const two = build({ places: [BASE, a], ratings: [rating("alpha", ME, scoresAll(4)), rating("alpha", ME, scoresAll(3), { start: "2025-05-01" })] });
  assert.match(text(tripsHTML(two, two.PLACE.alpha, true, ME)), note);
});

/* ---------- cycle 3 review: a refusal is not an outage ---------- */

const RULES = "Repository rule violations found\n\nCommits must have verified signatures.";
const refusing = (remote, reply) => {
  let n = 0;
  const f = async (url, o) => (n > 0 && String(o && o.body).includes("createCommitOnBranch") ? (n--, reply()) : remote.fetchImpl(url, o));
  globalThis.fetch = f;
  return { next: k => { n = k; } };
};
const unprocessable = () => new Response(JSON.stringify({ data: null, errors: [{ type: "UNPROCESSABLE", message: RULES }] }), { status: 200 });

test("GitHub's 4xx answers and typed GraphQL refusals are «rejected» with GitHub's short reason; 5xx, web pages and «Something went wrong» stay temporary", async () => {
  const answer = res => storeAnswering(res).gql("mutation($input:X){ x }", {}).catch(e => e);
  const r422 = await answer(() => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }));
  assert.equal(r422.code, "rejected");
  assert.equal(r422.message, "GitHub не принял правку: Validation Failed");
  const rules = await answer(unprocessable);
  assert.equal(rules.code, "rejected");
  assert.equal(rules.message, "GitHub не принял правку: Repository rule violations found", "only the first line of GitHub's reason, without the trailing details");
  const archived = await answer(() => new Response(JSON.stringify({ data: null, errors: [{ message: "Repository was archived so is read-only." }] }), { status: 200 }));
  assert.equal(archived.code, "rejected", "an untyped error with a reason is a refusal too");
  assert.match(archived.message, /archived so is read-only$/);
  for (const [name, res] of [
    ["502", () => new Response("{}", { status: 502 })],
    ["404 web page", () => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } })],
    ["Something went wrong", () => new Response(JSON.stringify({ errors: [{ message: "Something went wrong while executing your query. This may be the result of a timeout." }] }), { status: 200 })],
    ["SERVICE_UNAVAILABLE", () => new Response(JSON.stringify({ errors: [{ type: "SERVICE_UNAVAILABLE", message: "Service unavailable" }] }), { status: 200 })],
    ["INTERNAL", () => new Response(JSON.stringify({ errors: [{ type: "INTERNAL", message: "Internal error" }] }), { status: 200 })],
    ["empty error", () => new Response(JSON.stringify({ errors: [{}] }), { status: 200 })],
  ]) {
    const e = await answer(res);
    assert.ok(["http", "graphql"].includes(e.code), `${name}: expected a temporary error, got ${e.code} «${e.message}»`);
  }
  const read = await storeAnswering(() => new Response(JSON.stringify({ message: "Problems parsing JSON" }), { status: 400 })).load().catch(e => e);
  assert.equal(read.code, "rejected");
  assert.match(read.message, /^GitHub не отдал данные: Problems parsing JSON$/, "a refused read does not talk about a change");
});

test("a save GitHub refuses is not queued, does not turn the status into «Ошибка связи», and the next save goes through", async () => {
  const { remote, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  const gh = refusing(remote, unprocessable);
  gh.next(1);
  const e = await a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } }).catch(x => x);
  assert.equal(e.code, "rejected");
  assert.match(e.message, /Repository rule violations found/);
  assert.deepEqual(a.pending, [], "a refusal is permanent: queueing it means it is retried forever and blocks later saves");
  assert.equal(a.status, "live", "the data connection works; only this change was refused");
  const ok = await a.updatePlace("budva", { archetype: "город" }, { base: { archetype: "" } });
  assert.equal(ok.r, "sent");
  assert.equal(read("places/budva.json").archetype, "город");
});

test("a queued change that GitHub refuses moves to «Не отправлено» with GitHub's reason, later saves are sent, and «Отправить снова» sends it once GitHub accepts", async () => {
  const B = Object.assign({}, P, { id: "bar", name: "Бар" });
  const { remote, read } = remoteSetup({ "places/budva.json": serialize(P), "places/bar.json": serialize(B) });
  const a = new Data();
  await a.refresh();
  assert.equal(await offline(remote, () => a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } })).then(x => x.r), "queued");
  const gh = refusing(remote, unprocessable);
  gh.next(1);
  await a.refresh();
  assert.deepEqual(a.pending, [], "the refused change no longer blocks the queue");
  assert.equal(a.lost.length, 1);
  assert.equal(a.lost[0].why, "rejected");
  assert.match(a.lost[0].reason, /GitHub не принял правку: Repository rule violations found/);
  assert.equal(a.refused, 1, "the app can tell the user once that a change was refused");
  assert.equal(a.status, "live");
  const other = await a.updatePlace("bar", { archetype: "город" }, { base: { archetype: "" } });
  assert.equal(other.r, "sent", "a save of another place is not held behind the refused one");
  assert.equal(read("places/bar.json").archetype, "город");
  assert.equal(await a.applyLost(0), "sent");
  assert.equal(read("places/budva.json").archetype, "курорт");
  assert.deepEqual(a.lost, []);
});

test("saving the same card again while its earlier queued edit is refused reports the refusal, not «изменили на другом устройстве»", async () => {
  const { remote } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  await offline(remote, () => a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } }));
  const gh = refusing(remote, unprocessable);
  gh.next(1);
  const e = await a.updatePlace("budva", { name: "Будва-центр" }, { base: { name: "Будва" } }).catch(x => x);
  assert.equal(e.code, "rejected", `got ${e.code}: «${e.message}»`);
  assert.match(e.message, /Repository rule violations found/);
  assert.equal(a.lost.filter(l => l.why === "rejected").length, 1, "the refused edit is kept on the device, ready for «Отправить снова»");
});

test("a GitHub outage that lasts 6 tries is reported as «давно не принимает», the queue is kept, and the next success clears it", async () => {
  const { remote, read } = remoteSetup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.failNext = 1;
  assert.equal((await a.updatePlace("budva", { archetype: "курорт" }, { base: { archetype: "" } })).r, "queued");
  assert.equal(a.stuck, false, "one failure is a normal outage");
  for (let i = 0; i < 5; i++) { remote.state.failNext = 1; await a.refresh(); }
  assert.equal(a.tries, 6);
  assert.equal(a.stuck, true, "after 6 failed tries the app must say GitHub keeps refusing and offer the copy");
  assert.equal(a.pending.length, 1, "the change stays queued");
  a.tries = 1; a.failSince = Date.now() - 61 * 60000;
  assert.equal(a.stuck, true, "an hour of failures is also «давно»");
  await a.refresh();
  assert.equal(a.stuck, false);
  assert.equal(a.failSince, 0);
  assert.equal(read("places/budva.json").archetype, "курорт");
  clearTimeout(a.retryT);
});

test("without «Кто я» the hidden note says why it is hidden, not «до вашей»", () => {
  const a = place("alpha", "Альфа");
  const M = build({ places: [BASE, a], ratings: [rating("alpha", PARTNER, scoresAll(4))] }, { me: ME });
  assert.equal(hiddenNote(M, "alpha"), `оценка ${PARTNER === "Вика" ? "Вики" : "Михаила"} скрыта до вашей`);
  M.me = "";
  assert.match(hiddenNote(M, "alpha"), /скрыта, пока не выбрано, кто вы$/);
  assert.doesNotMatch(hiddenNote(M, "alpha"), /до вашей/);
});
