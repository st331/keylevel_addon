import { test } from "node:test";
import assert from "node:assert/strict";
import { bestPerLevel, pickPercent, playersFromResults, buildDungeonsTable, mergeModel, classToken } from "../lib/transform.mjs";

const RANKS_BLOB = {
  bestAmount: 1500, totalKills: 5, metric: "playerscore",
  ranks: [
    { rankPercent: 80.04, bracketData: 12, spec: "Fire" },
    { rankPercent: 91.26, bracketData: 12, spec: "Fire" },   // better 12 — kept
    { rankPercent: 88.0, bracketData: 11, spec: "Frost" },
    { rankPercent: null, bracketData: 10, spec: "Fire" },    // no percentile — skipped
    { rankPercent: 70.0, bracketData: 0, spec: "Fire" },     // bad level — skipped
  ],
};

test("pickPercent prefers bracketPercent when present", () => {
  assert.equal(pickPercent({ bracketPercent: 95, rankPercent: 90 }), 95);
  assert.equal(pickPercent({ rankPercent: 90 }), 90);
  assert.equal(pickPercent({ rankPercent: null }), null);
  assert.equal(pickPercent({}), null);
});

test("bestPerLevel keeps best pct per keystone level", () => {
  const out = bestPerLevel(RANKS_BLOB);
  assert.deepEqual(out, {
    11: { pct: 88, spec: "Frost" },
    12: { pct: 91.3, spec: "Fire" },
  });
});

test("bestPerLevel handles empty/missing ranks", () => {
  assert.deepEqual(bestPerLevel(null), {});
  assert.deepEqual(bestPerLevel({}), {});
  assert.deepEqual(bestPerLevel({ ranks: [] }), {});
});

test("playersFromResults builds the addon model", () => {
  const results = [
    {
      key: "Foo-Area52",
      result: {
        classID: 4,
        e12805: RANKS_BLOB,
        e12811: { ranks: [{ rankPercent: 60, bracketData: 12, spec: "Arcane" }] },
      },
    },
    { key: "Missing-Realm", result: null },
  ];
  const { players } = playersFromResults(results, 1752000000);
  assert.ok(!players["Missing-Realm"], "not-found character omitted");
  const foo = players["Foo-Area52"];
  assert.equal(foo.class, "MAGE");
  assert.equal(foo.updated, 1752000000);
  assert.equal(foo.levels[12].runs, 2, "two dungeons at 12");
  assert.equal(foo.levels[12].best, 91.3, "best across dungeons");
  assert.equal(foo.levels[12].dungeons[12811].pct, 60);
  assert.equal(foo.levels[11].runs, 1);
});

test("classToken mapping", () => {
  assert.equal(classToken(4), "MAGE");
  assert.equal(classToken(11), "WARRIOR");
  assert.equal(classToken(13), "EVOKER");
  assert.equal(classToken(999), undefined);
});

test("buildDungeonsTable stamps known challengeMapIDs", () => {
  const dungeons = buildDungeonsTable(
    [
      { id: 12805, name: "Windrunner Spire" },
      { id: 99999, name: "Totally Unknown Dungeon" },
    ],
    { "Totally Unknown Dungeon": 777 },
  );
  assert.equal(dungeons[12805].challengeMapID, 557, "static table");
  assert.equal(dungeons[99999].challengeMapID, 777, "config extras");
  assert.equal(dungeons[12805].name, "Windrunner Spire");
});

test("mergeModel keeps old players, replaces refetched ones", () => {
  const existing = {
    meta: { zoneID: 47 },
    dungeons: { 1: { name: "A" } },
    players: { "Old-R": { class: "MAGE", levels: {} }, "Both-R": { class: "MAGE", levels: { 10: {} } } },
  };
  const fresh = {
    meta: { generatedAt: "now" },
    dungeons: { 2: { name: "B" } },
    players: { "Both-R": { class: "MAGE", levels: { 12: {} } }, "New-R": { class: "DRUID", levels: {} } },
  };
  const out = mergeModel(existing, fresh);
  assert.ok(out.players["Old-R"], "old kept");
  assert.ok(out.players["New-R"], "new added");
  assert.ok(out.players["Both-R"].levels[12] && !out.players["Both-R"].levels[10], "refetched replaced wholesale");
  assert.equal(out.meta.zoneID, 47);
  assert.equal(out.meta.generatedAt, "now");
  assert.ok(out.dungeons[1] && out.dungeons[2], "dungeons merged");
});
