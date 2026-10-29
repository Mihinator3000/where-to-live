import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createModel, normalize } from "../js/calc.js";

const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url)));
const base = { id: "spb", name: "Санкт-Петербург", status: "база", cc: "RUS" };
const budva = { id: "budva", name: "Будва", status: "кандидат", cc: "MNE", ext: { "к_русским": { res: 2 } } };
const kotor = { id: "kotor", name: "Котор", status: "кандидат" };
const r = (o) => Object.assign({ scores: {}, conf: {}, season: "", mode: "", retro: false }, o);

test("schema has 11 groups and 69 cats", () => {
  assert.equal(schema.groups.length, 11);
  assert.equal(schema.cats.length, 69);
});

test("repeat trips weighted by season, mode, retro", () => {
  const M = createModel(schema, { places: [base, budva], ratings: [
    r({ id: "1", place: "budva", who: "Михаил", season: "пик", mode: "отпуск", scores: { "аренда": 4 } }),
    r({ id: "2", place: "budva", who: "Михаил", season: "худший", mode: "удалёнка", scores: { "аренда": 2 } }),
  ] });
  const w1 = 1, w2 = 2 * 1.5;
  assert.ok(Math.abs(M.personCat("budva", "Михаил", "аренда") - (4 * w1 + 2 * w2) / (w1 + w2)) < 1e-9);
});

test("risky groups take min of two, others mean", () => {
  const M = createModel(schema, { places: [budva], ratings: [
    r({ id: "1", place: "budva", who: "Михаил", scores: { "улица": 4, "аренда": 4 } }),
    r({ id: "2", place: "budva", who: "Вика", scores: { "улица": 2, "аренда": 2 } }),
  ] });
  assert.equal(M.usCat("budva", "улица"), 2);
  assert.equal(M.usCat("budva", "аренда"), 3);
});

test("final mixes us with residents by visibility share", () => {
  const M = createModel(schema, { places: [budva], ratings: [r({ id: "1", place: "budva", who: "Михаил", scores: { "к_русским": 4 } })] });
  assert.equal(M.finalCat(budva, "к_русским"), 0.5 * 4 + 0.5 * 2);
});

test("base is 3 on relative groups, null on absolute", () => {
  const M = createModel(schema, { places: [base], ratings: [] });
  assert.equal(M.groupScore(base, "money", "final"), 3);
  assert.equal(M.groupScore(base, "legal", "final"), null);
});

test("autoData fills data column and is overridden by explicit ext", () => {
  const M = createModel(schema, { places: [budva], ratings: [] }, { autoData: (p, k) => (k === "к_русским" ? 5 : k === "преступность" ? 4 : null) });
  assert.equal(M.extCat(budva, "к_русским", "data"), 5);
  assert.equal(M.extCat(budva, "преступность", "data"), 4);
  assert.equal(M.finalCat(budva, "преступность"), 4);
});

test("veto and отсев remove from candidates; flags detect disagreement and tourist illusion", () => {
  const M = createModel(schema, { places: [budva, kotor], ratings: [
    r({ id: "1", place: "budva", who: "Михаил", scores: { "к_русским": 4, "шум": 1 } }),
    r({ id: "2", place: "budva", who: "Вика", scores: { "к_русским": 4, "шум": 3 } }),
    r({ id: "3", place: "kotor", who: "Вика", veto: "сыро", scores: { "аренда": 3 } }),
  ] });
  assert.deepEqual(M.candidates().map(p => p.id), ["budva"]);
  const sev = M.allFlags().map(f => f.sev);
  assert.ok(sev.includes("crit"));
  assert.ok(sev.includes("serious"));
  assert.ok(sev.includes("warn"));
});

test("weights normalize to 100 and coverage counts weighted groups", () => {
  const n = normalize(schema.groups, { money: 30, safety: 10 });
  assert.equal(Math.round(n.money), 75);
  const M = createModel(schema, { places: [budva], ratings: [r({ id: "1", place: "budva", who: "Михаил", scores: { "аренда": 5 } })] });
  const t = M.total(budva, n, "final");
  assert.equal(t.score, 5);
  assert.equal(t.coverage, 0.75);
});

test("ratings for unknown or deleted places are ignored", () => {
  const M = createModel(schema, { places: [budva], ratings: [r({ id: "1", place: "nowhere", who: "Михаил", scores: { "аренда": 5 } }), r({ id: "2", place: "budva", who: "Вика", deleted: true, scores: { "аренда": 1 } })] });
  assert.equal(M.ratings.length, 0);
});
