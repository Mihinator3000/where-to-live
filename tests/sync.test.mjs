import "./helpers/env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { makeRemote } from "./helpers/remote.mjs";
import { serialize, GitHubStore } from "../js/store.js";
import { Data } from "../js/data.js";

const P = { id: "budva", name: "Будва", status: "кандидат", questions: "" };

function setup(files) {
  localStorage.clear();
  localStorage.setItem("wtl:token", JSON.stringify("tok"));
  const remote = makeRemote(files);
  globalThis.fetch = remote.fetchImpl;
  const phoneB = new GitHubStore({ owner: "x", repo: "y", token: "t", fetchImpl: remote.fetchImpl });
  const editB = async (path, doc) => { await phoneB.load(); await phoneB.commit([{ path, content: serialize(doc), baseOid: phoneB.oids[path] }], "B"); };
  return { remote, editB, read: path => JSON.parse(remote.state.files[path]) };
}

test("offline queue: a clash drops only the clashing file and keeps a copy", async () => {
  const { remote, editB } = setup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.offlineNext = 1;
  await a.savePlace(Object.assign({}, P, { questions: "A" }), false);
  remote.state.offlineNext = 1;
  await a.saveRating({ place: "budva", who: "Михаил", scores: { "аренда": 4 } });
  await editB("places/budva.json", Object.assign({}, P, { questions: "B" }));
  await a.refresh();
  assert.equal(a.pending.length, 0);
  assert.equal(Object.keys(remote.state.files).filter(p => p.startsWith("ratings/")).length, 1);
  assert.equal(a.view().places[0].questions, "B");
  assert.match(a.notice, /places\/budva\.json/);
  assert.equal(JSON.parse(localStorage.getItem("wtl:lost")).length, 1);
  assert.equal(a.status, "live");
});

test("a save after another phone's edit does not hide or overwrite that edit", async () => {
  const { editB, read } = setup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  await editB("places/budva.json", Object.assign({}, P, { status: "отсев", reason: "B" }));
  await a.saveRating({ place: "budva", who: "Вика", scores: { "шум": 2 } });
  assert.equal(a.view().places[0].status, "отсев");
  await a.savePlace(Object.assign({}, a.view().places[0], { questions: "A" }), false);
  const fin = read("places/budva.json");
  assert.equal(fin.reason, "B");
  assert.equal(fin.questions, "A");
});

test("a commit whose response was lost is not reported as a clash", async () => {
  const { remote } = setup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  remote.state.dropResponseNext = 1;
  assert.equal((await a.saveRating({ place: "budva", who: "Михаил", scores: { "аренда": 3 } })).r, "queued");
  remote.state.offlineNext = 1;
  await a.saveRating({ place: "budva", who: "Вика", scores: { "аренда": 4 } });
  await a.refresh();
  assert.equal(a.pending.length, 0);
  assert.equal(a.notice, "");
  assert.deepEqual(Object.keys(remote.state.files).filter(p => p.startsWith("ratings/")).map(p => JSON.parse(remote.state.files[p]).who).sort(), ["Вика", "Михаил"]);
});

test("offline edits flushed by a later save stay visible", async () => {
  const { read } = setup({ "places/budva.json": serialize(P) });
  const a = new Data();
  await a.refresh();
  globalThis.fetch = (() => { const f = globalThis.fetch; let n = 1; return (...x) => (n-- > 0 ? Promise.reject(new TypeError("Load failed")) : f(...x)); })();
  a.configure();
  await a.savePlace(Object.assign({}, P, { status: "база" }), false);
  await a.saveRating({ place: "budva", who: "Михаил", scores: { "аренда": 4 } });
  assert.equal(a.view().places[0].status, "база");
  assert.equal(read("places/budva.json").status, "база");
});
