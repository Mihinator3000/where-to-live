import { test } from "node:test";
import assert from "node:assert/strict";
import { daylight, toScore, haversine } from "../js/world.js";
import { blobOid } from "../js/store.js";

test("daylight on Dec 21 matches NOAA within 10 min", () => {
  assert.ok(Math.abs(daylight(59.94) - (5 + 53 / 60)) < 0.17);
  assert.ok(Math.abs(daylight(42.29) - (9 + 5 / 60)) < 0.17);
});

test("log scale: 1.5x is one point", () => {
  const ind = { dir: 1, scale: { type: "log", step: Math.log(1.5) } };
  assert.ok(Math.abs(toScore(ind, 150, 100) - 4) < 1e-9);
  assert.equal(toScore(ind, 1000, 100), 5);
});

test("abs points interpolate and clip", () => {
  const ind = { dir: -1, scale: { type: "abs", points: [[5, 5], [35, 1]] } };
  assert.equal(toScore(ind, 20, null), 3);
  assert.equal(toScore(ind, 2, null), 5);
});

test("haversine Budva–Kotor ~ 13 km", () => {
  const d = haversine({ lat: 42.288, lon: 18.84 }, { lat: 42.424, lon: 18.771 });
  assert.ok(d > 12 && d < 18);
});

test("git blob oid matches git hash-object", async () => {
  assert.equal(await blobOid("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});
