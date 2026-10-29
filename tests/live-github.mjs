import assert from "node:assert/strict";
import { GitHubStore, serialize } from "../js/store.js";

const token = process.env.WTL_TOKEN;
const [owner, repo] = (process.env.WTL_REPO || "Mihinator3000/where-to-live-data").split("/");
if (!token) { console.error("WTL_TOKEN is not set"); process.exit(2); }
const branch = "selftest-" + Date.now().toString(36);
const api = (method, path, body) => fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
  method,
  headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const ok = msg => console.log("PASS", msg);

const main = await (await api("GET", "/git/ref/heads/main")).json();
assert.ok(main.object && main.object.sha, "main ref readable");
assert.equal((await api("POST", "/git/refs", { ref: "refs/heads/" + branch, sha: main.object.sha })).status, 201);
ok("test branch created");

try {
  const a = new GitHubStore({ owner, repo, token, branch });
  const b = new GitHubStore({ owner, repo, token, branch });
  const first = await a.load();
  assert.ok(first.docs.places.length >= 1);
  ok(`graphql read: ${first.docs.places.length} places, ${first.docs.ratings.length} ratings`);

  const doc = { id: "selftest", place: first.docs.places[0].id, who: "Михаил", scores: { "аренда": 3 }, deleted: false };
  await a.commit([{ path: "ratings/selftest.json", content: serialize(doc), baseOid: null }], "Selftest add");
  ok(`write via ${a.mode}`);

  await b.load();
  await b.commit([{ path: "ratings/selftest-b.json", content: serialize(Object.assign({}, doc, { id: "selftest-b", who: "Вика" })), baseOid: null }], "Selftest add from phone B");
  await a.commit([{ path: "ratings/selftest-c.json", content: serialize(Object.assign({}, doc, { id: "selftest-c" })), baseOid: null }], "Selftest add after race");
  const after = await a.load();
  assert.ok(["selftest", "selftest-b", "selftest-c"].every(id => after.docs.ratings.some(r => r.id === id)));
  ok("race on branch head: both phones' files kept");

  const staleOid = a.oids["ratings/selftest.json"];
  await b.load();
  await b.commit([{ path: "ratings/selftest.json", content: serialize(Object.assign({}, doc, { scores: { "аренда": 4 } })), baseOid: b.oids["ratings/selftest.json"] }], "Selftest edit from B");
  await assert.rejects(a.commit([{ path: "ratings/selftest.json", content: serialize(Object.assign({}, doc, { scores: { "аренда": 2 } })), baseOid: staleOid }], "Selftest stale edit"), e => e.code === "clash");
  const check = await a.load();
  assert.equal(check.docs.ratings.find(r => r.id === "selftest").scores["аренда"], 4);
  ok("same file edited on two phones: stale write refused, nothing overwritten");

  const h1 = await a.remoteHead();
  const h2 = await a.remoteHead();
  assert.equal(h1, h2);
  assert.equal(h1, a.head);
  ok("head polling with ETag");

  a.mode = "rest";
  await a.commit([{ path: "ratings/selftest.json", content: null }, { path: "ratings/selftest-b.json", content: null }, { path: "ratings/selftest-c.json", content: null }], "Selftest cleanup via REST");
  const end = await a.load();
  assert.ok(!end.docs.ratings.some(r => String(r.id).startsWith("selftest")));
  ok("REST git data write and delete");
} finally {
  const del = await api("DELETE", "/git/refs/heads/" + branch);
  console.log(del.status === 204 ? "PASS test branch deleted" : "WARN branch not deleted: " + del.status);
}
