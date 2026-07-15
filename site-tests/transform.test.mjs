import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestPerLevel, pickPercent, playerFromResult, evaluate,
  tierClass, sortValue, encounterByName, classToken,
  windowLevels, average, median,
  roleOfSpec, detectRole, hasRanks, rolesWithRuns, buildRolePlayers,
  topKeyRoles, roleOrder, pickSelectedRole,
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

test("pickPercent uses the historical (at-the-time) percentile", () => {
  // gear inflation: today's re-ranking understates old runs — use historical.
  // real case (Steelsdk +20 PoS): historical 4.02, today had drifted to 3.26
  assert.equal(pickPercent({ historicalPercent: 4.02, todayPercent: 3.26, rankPercent: 4.02 }), 4.02);
  assert.equal(pickPercent({ rankPercent: 90 }), 90, "falls back to rankPercent");
  assert.equal(pickPercent({ todayPercent: 50 }), null, "todayPercent alone is not used");
  assert.equal(pickPercent({}), null);
});

test("bestPerLevel links the best run's report and date for provenance", () => {
  const out = bestPerLevel({ ranks: [
    { historicalPercent: 60.0, bracketData: 12, amount: 90, startTime: 111, report: { code: "AAA", fightID: 2 } },
    { historicalPercent: 91.2, bracketData: 12, amount: 100, startTime: 222, report: { code: "BBB", fightID: 5 } },
  ] });
  assert.deepEqual(out[12].report, { code: "BBB", fightID: 5 }, "best run wins the link");
  assert.equal(out[12].when, 222, "best run's date retained");
});

test("bestPerLevel dedupes identical runs (same level + amount)", () => {
  const out = bestPerLevel({ ranks: [
    { historicalPercent: 91.2, bracketData: 12, amount: 100, spec: "Fire" },
    { historicalPercent: 91.2, bracketData: 12, amount: 100, spec: "Fire" }, // API duplicate
    { historicalPercent: 60.0, bracketData: 12, amount: 90, spec: "Fire" },
  ] });
  assert.deepEqual(out[12].pcts, [91.2, 60], "duplicate run counted once");
});

test("bestPerLevel keeps best pct per keystone level, skips junk", () => {
  const out = bestPerLevel({ ranks: [
    { rankPercent: 80, bracketData: 12, spec: "Fire" },
    { rankPercent: 91.26, bracketData: 12, spec: "Fire" },
    { rankPercent: null, bracketData: 10 },
    { rankPercent: 70, bracketData: 0 },
  ] });
  assert.deepEqual(out, { 12: { pct: 91.3, spec: "Fire", pcts: [80, 91.3] } });
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
  assert.deepEqual([...ev.anyAtLevel.pcts].sort((a, b) => a - b), [71, 91.2],
    "per-dungeon bests at the level, for avg/median");
  assert.deepEqual(ev.dungeon, { pct: 91.2, level: 12, spec: "Fire", kind: "exact", pcts: [91.2] });
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
  assert.deepEqual(ev.dungeon, { pct: 76.4, level: 11, spec: "Fury", kind: "below", pcts: [76.4] });
});

test("evaluate: dungeon result carries every run's percentile", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [
      { rankPercent: 91.2, bracketData: 12, spec: "Fire" },
      { rankPercent: 60.0, bracketData: 12, spec: "Fire" },
      { rankPercent: 40.0, bracketData: 12, spec: "Frost" },
    ] },
  });
  const ev = evaluate(p, AK, 12);
  assert.equal(ev.dungeon.pct, 91.2, "best");
  assert.deepEqual(ev.dungeon.pcts, [91.2, 60, 40], "all runs retained");
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

test("roleOfSpec covers all role families", () => {
  for (const s of ["Restoration", "Preservation", "Mistweaver", "Holy", "Discipline"]) {
    assert.equal(roleOfSpec(s), "healer", s);
  }
  for (const s of ["Blood", "Vengeance", "Guardian", "Brewmaster", "Protection"]) {
    assert.equal(roleOfSpec(s), "tank", s);
  }
  for (const s of ["Unholy", "Fire", "Augmentation", "Marksmanship", undefined]) {
    assert.equal(roleOfSpec(s), "dps", String(s));
  }
});

test("detectRole picks the role holding the most score", () => {
  const healerMain = {
    classID: 7,
    e1: { ranks: [
      { spec: "Discipline", score: 400, bracketData: 12, historicalPercent: 50, amount: 1 },
      { spec: "Discipline", score: 380, bracketData: 11, historicalPercent: 50, amount: 2 },
      { spec: "Shadow", score: 300, bracketData: 12, historicalPercent: 50, amount: 3 },
    ] },
  };
  assert.equal(detectRole(healerMain), "healer");

  const tankMain = {
    classID: 11,
    e1: { ranks: [{ spec: "Protection", score: 500, bracketData: 12, historicalPercent: 50, amount: 1 }] },
    e2: { ranks: [{ spec: "Arms", score: 100, bracketData: 12, historicalPercent: 50, amount: 2 }] },
  };
  assert.equal(detectRole(tankMain), "tank");

  assert.equal(detectRole({ classID: 4, e1: { ranks: [] } }), null, "no runs -> unknown");
  assert.equal(detectRole(null), null);
  // tie on score (both zero) falls to dps unless another role has more runs
  const tie = { classID: 2, e1: { ranks: [
    { spec: "Restoration", bracketData: 12, historicalPercent: 50, amount: 1 },
    { spec: "Restoration", bracketData: 11, historicalPercent: 50, amount: 2 },
    { spec: "Balance", bracketData: 12, historicalPercent: 50, amount: 3 },
  ] } };
  assert.equal(detectRole(tie), "healer", "zero scores -> run count decides");
});

test("detectRole: recent runs outweigh an older, larger pile (role switcher)", () => {
  // modeled on a real case (Zyntexx-Draenor): months of tank runs, then an
  // exclusive switch to healing — the current main must win
  const day = 86_400_000;
  const now = 1_780_000_000_000;
  const tankRuns = Array.from({ length: 30 }, (_, i) => ({
    spec: "Brewmaster", score: 450, bracketData: 10 + (i % 5),
    historicalPercent: 50, amount: 1000 + i, startTime: now - (60 + i) * day,
  }));
  const healRuns = Array.from({ length: 8 }, (_, i) => ({
    spec: "Mistweaver", score: 460, bracketData: 15 + (i % 3),
    historicalPercent: 70, amount: 2000 + i, startTime: now - i * day,
  }));
  const switcher = { classID: 5, e1: { ranks: [...tankRuns, ...healRuns] } };
  assert.equal(detectRole(switcher), "healer", "8 fresh healer runs beat 30 stale tank runs");

  // ...but one novelty off-role run can't flip a long active main
  const oneOff = {
    classID: 5,
    e1: { ranks: [
      ...Array.from({ length: 20 }, (_, i) => ({
        spec: "Brewmaster", score: 450, bracketData: 12,
        historicalPercent: 50, amount: 1000 + i, startTime: now - (2 + i) * day,
      })),
      { spec: "Mistweaver", score: 470, bracketData: 12, historicalPercent: 70, amount: 3000, startTime: now },
    ] },
  };
  assert.equal(detectRole(oneOff), "tank", "a single fresh healer run is not a re-main");

  // duplicated API rows must not double-weight a role: deduped, dps wins
  // (500 * 0.9 = 450 > 400); with the dupe kept, healer would win (760)
  const duped = { classID: 5, e1: { ranks: [
    { spec: "Mistweaver", score: 400, bracketData: 12, historicalPercent: 70, amount: 1, startTime: now },
    { spec: "Mistweaver", score: 400, bracketData: 12, historicalPercent: 70, amount: 1, startTime: now },
    { spec: "Windwalker", score: 500, bracketData: 12, historicalPercent: 70, amount: 2, startTime: now - day },
  ] } };
  assert.equal(detectRole(duped), "dps", "dupe collapses to one healer run");
});

test("playerFromResult carries the role; override wins; filterRole filters", () => {
  const result = {
    classID: 7,
    e1: { ranks: [{ spec: "Discipline", score: 400, bracketData: 12, historicalPercent: 50, amount: 1 }] },
  };
  assert.equal(playerFromResult(result).role, "healer");
  assert.equal(playerFromResult(result, "dps").role, "dps", "explicit role wins");

  const mixed = {
    classID: 5,
    e1: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 30, amount: 1 },
      { spec: "Mistweaver", score: 420, bracketData: 13, historicalPercent: 80, amount: 2 },
    ] },
  };
  const tankOnly = playerFromResult(mixed, "tank", "tank");
  assert.deepEqual(Object.keys(tankOnly.levels), ["12"], "healer run filtered out");
  const healOnly = playerFromResult(mixed, "healer", "healer");
  assert.deepEqual(Object.keys(healOnly.levels), ["13"], "tank run filtered out");
});

test("topKeyRoles: the highest-scored run of each dungeon is its top key", () => {
  const result = {
    classID: 5,
    e1: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 10, amount: 1 },
      { spec: "Mistweaver", score: 450, bracketData: 13, historicalPercent: 20, amount: 2 }, // top
    ] },
    e2: { ranks: [
      { spec: "Brewmaster", score: 470, bracketData: 14, historicalPercent: 30, amount: 3 }, // top
      { spec: "Mistweaver", score: 460, bracketData: 13, historicalPercent: 40, amount: 4 },
    ] },
    e3: { ranks: [{ spec: "Windwalker", score: 300, bracketData: 10, historicalPercent: 50, amount: 5 }] }, // top
    e4: { ranks: [] }, // dungeon never done: no top key
  };
  assert.deepEqual(topKeyRoles(result), {
    healer: { keys: 1, score: 450 },
    tank: { keys: 1, score: 470 },
    dps: { keys: 1, score: 300 },
  });
  assert.deepEqual(topKeyRoles(null), {});
});

test("roleOrder: most top keys first; recency breaks ties; topless roles trail", () => {
  const now = 1_780_000_000_000, day = 86_400_000;
  // 2 tank tops vs 1 healer top -> tank leads even though healing is recent
  const tankLead = {
    classID: 5,
    e1: { ranks: [{ spec: "Brewmaster", score: 470, bracketData: 14, historicalPercent: 1, amount: 1, startTime: now - 90 * day }] },
    e2: { ranks: [{ spec: "Brewmaster", score: 460, bracketData: 14, historicalPercent: 1, amount: 2, startTime: now - 91 * day }] },
    e3: { ranks: [{ spec: "Mistweaver", score: 480, bracketData: 15, historicalPercent: 1, amount: 3, startTime: now }] },
  };
  assert.deepEqual(roleOrder(tankLead), ["tank", "healer"]);

  // 1-1 top-key tie (the Zyntexx case) -> the recently played role wins,
  // even against a higher raw score on the older role
  const tie = {
    classID: 5,
    e1: { ranks: [{ spec: "Brewmaster", score: 470, bracketData: 14, historicalPercent: 1, amount: 1, startTime: now - 90 * day }] },
    e2: { ranks: [{ spec: "Mistweaver", score: 460, bracketData: 14, historicalPercent: 1, amount: 2, startTime: now }] },
  };
  assert.deepEqual(roleOrder(tie), ["healer", "tank"]);

  // dps runs exist but hold no dungeon's top key -> chip trails
  const offRole = {
    classID: 5,
    e1: { ranks: [
      { spec: "Mistweaver", score: 460, bracketData: 14, historicalPercent: 1, amount: 1, startTime: now },
      { spec: "Windwalker", score: 300, bracketData: 10, historicalPercent: 1, amount: 2, startTime: now - day },
    ] },
  };
  assert.deepEqual(roleOrder(offRole), ["healer", "dps"]);
  assert.deepEqual(roleOrder(null), []);

  // top keys are the PRIMARY rule: 2 tank tops beat a healer whose recent
  // grind dominates the recency-weighted score (this pins the rule — with
  // recency-only ordering, healer would come first)
  const grinder = {
    classID: 5,
    e1: { ranks: [{ spec: "Brewmaster", score: 470, bracketData: 14, historicalPercent: 1, amount: 1, startTime: now - 200 * day }] },
    e2: { ranks: [{ spec: "Brewmaster", score: 460, bracketData: 14, historicalPercent: 1, amount: 2, startTime: now - 201 * day }] },
    e3: { ranks: Array.from({ length: 10 }, (_, i) => (
      { spec: "Mistweaver", score: 300, bracketData: 10, historicalPercent: 1, amount: 10 + i, startTime: now - i * day }
    )) },
  };
  assert.deepEqual(roleOrder(grinder), ["tank", "healer"], "2 top keys beat recency score");
});

test("pickSelectedRole skips roles the key-level window emptied", () => {
  const byRole = {
    tank: { role: "tank", levels: {} },              // emptied by windowing
    healer: { role: "healer", levels: { 12: { best: 80, runs: 1, dungeons: {} } } },
  };
  assert.equal(pickSelectedRole(["tank", "healer"], byRole), "healer",
    "lead role has nothing visible -> fall through to one that does");
  assert.equal(pickSelectedRole(["tank"], { tank: { levels: {} } }), "tank",
    "nothing visible anywhere -> keep the lead role");
  assert.equal(pickSelectedRole([], {}), null);
});

test("rolesWithRuns lists every role the character has played", () => {
  const mixed = {
    classID: 5,
    e1: { ranks: [
      { spec: "Brewmaster", bracketData: 12, historicalPercent: 30, amount: 1 },
      { spec: "Mistweaver", bracketData: 13, historicalPercent: 80, amount: 2 },
    ] },
  };
  assert.deepEqual([...rolesWithRuns(mixed)].sort(), ["healer", "tank"]);
  assert.deepEqual([...rolesWithRuns(null)], []);
  assert.deepEqual([...rolesWithRuns({ classID: 4, e1: { ranks: [] } })], []);
});

test("buildRolePlayers: healer table from hps, tank/dps from dps, per-run split", () => {
  // same runs in both results — only the percentiles differ by metric.
  // The healer's tank run must never surface hps numbers and vice versa.
  const dps = {
    classID: 5,
    e1: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 42.0, amount: 100, startTime: 1000 },
      { spec: "Mistweaver", score: 420, bracketData: 12, historicalPercent: 15.0, amount: 50, startTime: 2000 },
    ] },
  };
  const hps = {
    classID: 5,
    e1: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 3.0, amount: 20, startTime: 1000 },
      { spec: "Mistweaver", score: 420, bracketData: 12, historicalPercent: 88.0, amount: 900, startTime: 2000 },
    ] },
  };
  const { detected, order, topKeys, byRole } = buildRolePlayers(dps, hps);
  assert.equal(detected, "healer", "the healer run is the dungeon's top key (420 > 400)");
  assert.deepEqual(order, ["healer", "tank"], "top-key holder first, topless role trails");
  assert.equal(topKeys.healer.keys, 1);
  assert.equal(topKeys.tank, undefined, "tank holds no top key");
  assert.equal(byRole.tank.levels[12].dungeons[1].pct, 42.0, "tank run keeps its dps Key %");
  assert.equal(byRole.healer.levels[12].dungeons[1].pct, 88.0, "healer run uses its hps Key %");
  assert.equal(byRole.dps, undefined, "no dps-spec runs -> no dps table");
  assert.equal(byRole.tank.role, "tank");
  assert.equal(byRole.healer.role, "healer");
  assert.equal(byRole.tank.metric, "dps", "metric tag drives report-tab links");
  assert.equal(byRole.healer.metric, "hps");

  // no hps result (fetch skipped/failed): mislabeled numbers are worse than
  // an absent table — healer view must be omitted, not built from dps
  const noHps = buildRolePlayers(dps, null);
  assert.equal(noHps.byRole.healer, undefined);
  assert.equal(noHps.byRole.tank.levels[12].dungeons[1].pct, 42.0);
  assert.deepEqual(noHps.order, ["tank"], "order only offers roles with tables");
  assert.equal(noHps.detected, "tank");

  assert.deepEqual(buildRolePlayers(null, null), { detected: null, order: [], topKeys: {}, byRole: {} });
});

test("hasRanks", () => {
  assert.equal(hasRanks({ classID: 4, e1: { ranks: [{ bracketData: 12 }] } }), true);
  assert.equal(hasRanks({ classID: 4, e1: { ranks: [] } }), false);
  assert.equal(hasRanks(null), false);
});

test("average and median", () => {
  assert.equal(average([]), null);
  assert.equal(average([10, 20]), 15);
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([1, 3, 100]), 3, "median resists outliers");
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
