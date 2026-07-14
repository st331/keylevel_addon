import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestPerLevel, pickPercent, playerFromResult, evaluate,
  tierClass, sortValue, encounterByName, classToken,
  windowLevels, average, median,
} from "../docs/js/transform.js";

const AK = 12660, COT = 12669, MISTS = 62290;

function alicePlayer() {
  // exact fixture semantics as the old addon tests: Alice has AK+CoT at 12,
  // AK+Mists at 11
  return playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [
      { rankPercent: 91.2, bracketData: 12, spec: "Fire" },
      { rankPercent: 88.0, bracketData: 11, spec: "Fire" },
    ] },
    [`e${COT}`]: { ranks: [{ rankPercent: 71.0, bracketData: 12, spec: "Fire" }] },
    [`e${MISTS}`]: { ranks: [{ rankPercent: 60.0, bracketData: 11, spec: "Frost" }] },
  });
}

test("pickPercent prefers bracketPercent", () => {
  assert.equal(pickPercent({ bracketPercent: 95, rankPercent: 90 }), 95);
  assert.equal(pickPercent({ rankPercent: 90 }), 90);
  assert.equal(pickPercent({}), null);
});

test("bestPerLevel keeps best pct per keystone level, skips junk", () => {
  const out = bestPerLevel({ ranks: [
    { rankPercent: 80, bracketData: 12, spec: "Fire" },
    { rankPercent: 91.26, bracketData: 12, spec: "Fire" },
    { rankPercent: null, bracketData: 10 },
    { rankPercent: 70, bracketData: 0 },
  ] });
  assert.deepEqual(out, { 12: { pct: 91.3, spec: "Fire" } });
});

test("playerFromResult builds levels; null result is missing", () => {
  const p = alicePlayer();
  assert.equal(p.class, "MAGE");
  assert.equal(p.levels[12].runs, 2);
  assert.equal(p.levels[12].best, 91.2);
  assert.equal(p.levels[11].runs, 2);
  assert.deepEqual(playerFromResult(null), { missing: true });
});

test("evaluate: exact hit", () => {
  const ev = evaluate(alicePlayer(), AK, 12);
  assert.equal(ev.status, "OK");
  assert.equal(ev.anyAtLevel.pct, 91.2);
  assert.equal(ev.anyAtLevel.runs, 2);
  assert.deepEqual(ev.dungeon, { pct: 91.2, level: 12, spec: "Fire", kind: "exact" });
});

test("evaluate: nearest higher level counts", () => {
  const ev = evaluate(alicePlayer(), AK, 10); // has AK at 11 and 12
  assert.equal(ev.dungeon.kind, "above");
  assert.equal(ev.dungeon.level, 11);
});

test("evaluate: one below", () => {
  const bob = playerFromResult({
    classID: 11,
    [`e${COT}`]: { ranks: [{ rankPercent: 77, bracketData: 12, spec: "Protection" }] },
    [`e${AK}`]: { ranks: [{ rankPercent: 76.4, bracketData: 11, spec: "Fury" }] },
  });
  const ev = evaluate(bob, AK, 12);
  assert.equal(ev.anyAtLevel.pct, 77);
  assert.deepEqual(ev.dungeon, { pct: 76.4, level: 11, spec: "Fury", kind: "below" });
});

test("evaluate: nothing relevant -> dungeonBest and anyBest", () => {
  const carol = playerFromResult({
    classID: 7,
    [`e${AK}`]: { ranks: [{ rankPercent: 55.5, bracketData: 9, spec: "Discipline" }] },
  });
  const ev = evaluate(carol, AK, 12);
  assert.equal(ev.anyAtLevel, undefined);
  assert.equal(ev.dungeon, undefined);
  assert.deepEqual(ev.dungeonBest, { level: 9, pct: 55.5 });
  assert.deepEqual(ev.anyBest, { level: 9, pct: 55.5 });
});

test("evaluate: missing player", () => {
  assert.equal(evaluate({ missing: true }, AK, 12).status, "NO_WCL");
  assert.equal(evaluate(null, AK, 12).status, "NO_WCL");
});

test("evaluate: no level / no encounter degrade gracefully", () => {
  const p = alicePlayer();
  const noLevel = evaluate(p, AK, null);
  assert.equal(noLevel.anyAtLevel, undefined);
  assert.equal(noLevel.anyBest.level, 12);
  const noEnc = evaluate(p, null, 12);
  assert.equal(noEnc.anyAtLevel.pct, 91.2);
  assert.equal(noEnc.dungeon, undefined);
});

test("tierClass boundaries", () => {
  assert.equal(tierClass(100), "tier-gold");
  assert.equal(tierClass(99), "tier-pink");
  assert.equal(tierClass(95), "tier-orange");
  assert.equal(tierClass(94), "tier-purple");
  assert.equal(tierClass(75), "tier-purple");
  assert.equal(tierClass(50), "tier-blue");
  assert.equal(tierClass(25), "tier-green");
  assert.equal(tierClass(1), "tier-gray");
});

test("sortValue ordering: dungeon > anyAtLevel > bests > nothing", () => {
  const exact = { status: "OK", dungeon: { pct: 80 } };
  const any = { status: "OK", anyAtLevel: { pct: 90 } };
  const bests = { status: "OK", dungeonBest: { pct: 99 } };
  const missing = { status: "NO_WCL" };
  assert.ok(sortValue(any) > sortValue(exact), "90 any beats 80 exact");
  assert.ok(sortValue(exact) > sortValue(bests));
  assert.ok(sortValue(bests) > sortValue(missing));
});

test("encounterByName: exact, decorated, prefix-deterministic", () => {
  const encounters = [
    { id: AK, name: "Ara-Kara, City of Echoes" },
    { id: COT, name: "City of Threads" },
  ];
  assert.equal(encounterByName(encounters, "city of threads").id, COT);
  assert.equal(encounterByName(encounters, "Ara-Kara, City of Echoes (Mythic Keystone)").id, AK);
  assert.equal(encounterByName(encounters, "city").id, COT, "prefix beats substring");
  assert.equal(encounterByName(encounters, "zzz"), null);
  assert.equal(encounterByName(encounters, ""), null);
});

test("classToken", () => {
  assert.equal(classToken(4), "MAGE");
  assert.equal(classToken(13), "EVOKER");
  assert.equal(classToken(999), undefined);
});

test("windowLevels keeps only levels within ±4 of the target", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [
      { rankPercent: 50, bracketData: 2 },
      { rankPercent: 60, bracketData: 16 },
      { rankPercent: 70, bracketData: 20 },
      { rankPercent: 80, bracketData: 24 },
      { rankPercent: 90, bracketData: 25 },
    ] },
  });
  const w = windowLevels(p, 20);
  assert.deepEqual(Object.keys(w.levels).map(Number).sort((a, b) => a - b), [16, 20, 24],
    "keeps [16..24], drops 2 and 25");
  assert.equal(p.levels[2].best, 50, "original untouched");
  // evaluation then only sees the window
  const ev = evaluate(w, AK, 20);
  assert.equal(ev.dungeon.level, 20);
  assert.equal(ev.anyBest, undefined, "anyAtLevel present instead");
});

test("windowLevels passes through when no level / missing player", () => {
  const p = playerFromResult({ classID: 4, [`e${AK}`]: { ranks: [{ rankPercent: 50, bracketData: 2 }] } });
  assert.equal(windowLevels(p, null), p);
  const missing = { missing: true };
  assert.equal(windowLevels(missing, 20), missing);
  assert.equal(windowLevels(null, 20), null);
});

test("average and median", () => {
  assert.equal(average([]), null);
  assert.equal(average([10, 20]), 15);
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([1, 3, 100]), 3, "median resists outliers");
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
