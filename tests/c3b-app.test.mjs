import "./helpers/env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeRemote } from "./helpers/remote.mjs";
import { serialize } from "../js/store.js";
import { Data } from "../js/data.js";

// Cycle 3b leftovers that are plain logic: the rate limit with an empty queue (A6) and the form's ranking threshold (A14).

const P = { id: "budva", name: "Будва", status: "кандидат", questions: "" };

function limitedRemote(reset) {
  localStorage.clear();
  localStorage.setItem("wtl:token", JSON.stringify("tok"));
  const remote = makeRemote({ "places/budva.json": serialize(P) });
  const gate = { limited: false, calls: 0 };
  globalThis.fetch = async (url, opts) => {
    gate.calls++;
    if (gate.limited) return new Response(JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), { status: 403, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    return remote.fetchImpl(url, opts);
  };
  return gate;
}

test("A6: a rate limit met by the background check with an empty queue stops further requests until GitHub's reset time", async () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const gate = limitedRemote(reset);
  const a = new Data();
  try {
    await a.refresh();
    assert.equal(a.status, "live", "fixture: the first load works");
    assert.equal(a.pending.length, 0, "fixture: nothing is queued");
    gate.limited = true;
    await a.poll();
    assert.equal(a.status, "error", "the background check swallowed the rate limit; the app still says it is connected");
    assert.equal(a.errorCode, "limit");
    assert.ok(a.limited, "the limit is not remembered while the queue is empty, so the next check knocks on GitHub again");
    assert.equal(a.limitAt, reset * 1000, "the time GitHub gave is not kept for the status and the banner");
    const n = gate.calls;
    await a.poll();
    await a.refresh();
    assert.equal(gate.calls, n, "requests sent while GitHub still refuses them");
  } finally { a.calm(); }
});

test("A6: a rate-limited refresh with an empty queue also waits for the reset time instead of retrying on every tap", async () => {
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const gate = limitedRemote(reset);
  gate.limited = true;
  const a = new Data();
  try {
    await a.refresh();
    assert.equal(a.errorCode, "limit");
    assert.ok(a.limited, "an empty queue makes the app forget the limit");
    const n = gate.calls;
    await a.refresh();
    await a.refresh();
    assert.equal(gate.calls, n, "each refresh knocks on GitHub during the limit");
  } finally { a.calm(); }
});

test("A6: the timer set for an empty-queue limit fires a refresh once the limit is over", async () => {
  const reset = Math.floor(Date.now() / 1000) - 10;
  const gate = limitedRemote(reset);
  gate.limited = true;
  const a = new Data();
  try {
    await a.refresh();
    assert.ok(a.retryT, "no retry is planned after the limit, the status would stay on «limit» until the next minute check");
    assert.ok(a.limitUntil - Date.now() <= 30000 + 50, "a limit whose reset time already passed waits longer than one step");
  } finally { a.calm(); }
});

test("A14: the rating form takes the ranking threshold from calc.js, not a hard-coded half", () => {
  const src = readFileSync(new URL("../js/form.js", import.meta.url), "utf8");
  assert.match(src, /import\s*\{[^}]*\bMIN_OWN\b[^}]*\}\s*from\s*"\.\/calc\.js"/, "form.js does not import MIN_OWN");
  assert.doesNotMatch(src, /STAR_KEYS\.length\s*\/\s*2/, "form.js still divides by 2 on its own");
  assert.match(src, /MIN_OWN\s*\*\s*this\.STAR_KEYS\.length/, "the threshold is not computed from MIN_OWN");
});
