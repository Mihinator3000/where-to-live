import { test } from "node:test";
import assert from "node:assert/strict";
import { daylight, toScore, haversine } from "../js/world.js";
import { blobOid } from "../js/store.js";
import { readFileSync } from "node:fs";

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

const readJSON = f => JSON.parse(readFileSync(new URL(`../data/world/${f}`, import.meta.url), "utf8"));

test("indicators.json: only kept indicators, with the fields the app reads", () => {
  const d = readJSON("indicators.json");
  const allowed = ["price_level", "usd_prices", "uhc", "pm25", "homicide", "wgi_pv", "quake", "wgi_cc", "wgi_ge", "free_speech", "ru_visa"];
  for (const ind of d.indicators) {
    assert.ok(allowed.includes(ind.key), `unexpected indicator ${ind.key}`);
    for (const f of ["name", "short", "group", "unit", "fmt", "dir", "scale", "source", "code", "license", "url", "cats"]) assert.ok(f in ind, `${ind.key}.${f}`);
  }
  for (const c of Object.values(d.countries)) for (const k of Object.keys(c)) assert.ok(allowed.includes(k), `stale value ${k}`);
});

test("indicators.json: Russia is 3 on relative scales, nothing beats SPb on quakes", () => {
  const d = readJSON("indicators.json");
  const score = (iso, ind) => { const r = d.countries[iso]?.[ind.key], ref = d.countries.RUS?.[ind.key]; return r ? toScore(ind, r[0], ref ? ref[0] : null) : null; };
  for (const ind of d.indicators) if (ind.scale.type !== "abs") assert.equal(score("RUS", ind), 3, ind.key);
  const quake = d.indicators.find(i => i.key === "quake");
  if (quake) for (const iso of Object.keys(d.countries)) { const s = score(iso, quake); assert.ok(s == null || s <= 3, iso); }
  const usd = d.indicators.find(i => i.key === "usd_prices");
  if (usd && d.countries.TUR?.usd_prices) assert.ok(score("TUR", usd) > 3, "Turkey: slower USD price growth than Russia");
});

test("cities.json: airports with scheduled flights, no visa-only neighbours", () => {
  const byId = Object.fromEntries(readJSON("cities.json").cities.map(c => [c.id, c]));
  const air = id => byId[id].air;
  assert.ok(air(745044) >= 25 && air(745044) <= 45, "Istanbul: IST/SAW, not closed Atatürk");
  assert.ok(air(3189073) <= 8 && air(3197538) <= 8, "Tivat, Kotor: TIV");
  assert.ok(air(3203106) >= 10 && air(3203106) <= 25, "Budva: TIV");
  assert.ok(air(3199394) <= 20, "Herceg Novi: TIV, not Dubrovnik");
});

test("cities.json: July night minimum below July mean below July max", () => {
  for (const c of readJSON("cities.json").cities) {
    if (c.tn == null || c.tx == null || !Array.isArray(c.t) || c.t[6] == null) continue;
    assert.ok(c.tn <= c.t[6] + 0.5 && c.t[6] <= c.tx + 0.5, `${c.en}: tn ${c.tn}, t ${c.t[6]}, tx ${c.tx}`);
  }
});
