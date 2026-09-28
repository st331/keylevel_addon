// measures.test.mjs — the Set B engine against a REAL log: Altar of Fangs
// +16 (P3j1myqhvQcMp6Tk fight 8). The fixture is a trimmed copy of the
// Warcraft Logs event streams the site pulls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phi, phiInv, weightedMedian, percentileInCell, effectiveN, robustZ } from "../docs/js/stats.js";
import {
  kickUtilisation, stops, kitFor, calibrateCooldowns, recurringTeammates, assess, runFacts, mergeCastStats, castStats, SET_B,
} from "../docs/js/measures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F8 = JSON.parse(fs.readFileSync(path.join(here, "fixtures/fight8.json"), "utf8"));

// the kicks verified in verify_defensives (base cooldowns; talents shorten them)
const LISTS = {
  version: "test",
  specs: {
    "Warrior-Arms": { role: "dps", kick: { id: 6552, name: "Pummel", cd: 15 } },
    "Rogue-Assassination": { role: "dps", kick: { id: 1766, name: "Kick", cd: 15 } },
    "Hunter-Marksmanship": { role: "dps", kick: { id: 147362, name: "Counter Shot", cd: 24 } },
    "Shaman-Restoration": { role: "healer", kick: { id: 57994, name: "Wind Shear", cd: 12 } },
    "DeathKnight-Blood": { role: "tank", kick: { id: 47528, name: "Mind Freeze", cd: 15 } },
    "Priest-Holy": { role: "healer", kick: null },
  },
};

const CLASS_OF = { 1: "Warrior", 79: "Rogue", 124: "Hunter", 125: "Shaman", 260: "DeathKnight" };
const SPEC_OF = { 1: "Arms", 79: "Assassination", 124: "Marksmanship", 125: "Restoration", 260: "Blood" };
const ROLE_OF = { 1: "dps", 79: "dps", 124: "dps", 125: "healer", 260: "tank" };
const MINUTES = (F8.fight.endTime - F8.fight.startTime) / 60_000;

function runFor(selfId, extra = {}) {
  const players = [1, 79, 124, 125, 260].map((id) => ({ id, name: F8.actors.find((a) => a.id === id)?.name ?? String(id), cls: CLASS_OF[id], spec: SPEC_OF[id], role: ROLE_OF[id] }));
  return {
    code: F8.report, fightID: F8.fightID, dungeon: "Altar of Fangs", level: 16,
    start: Date.now() - 3 * 86_400_000, durationS: (F8.fight.endTime - F8.fight.startTime) / 1000, timed: true,
    selfId, cls: CLASS_OF[selfId], spec: SPEC_OF[selfId], role: ROLE_OF[selfId], players,
    fight: { startTime: F8.fight.startTime, endTime: F8.fight.endTime },
    amount: 312_375, keyPct: 58,
    exec: null,
    events: { deaths: F8.deaths, kickCasts: F8.kitCasts, begin: F8.begincast, interrupts: F8.interrupts },
    ...extra,
  };
}

// ------------------------------------------------------------ stats

test("normal CDF and its inverse round-trip", () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-9);
  for (const z of [-2.5, -1, -0.3, 0.7, 1.3, 2.2]) {
    assert.ok(Math.abs(phiInv(phi(z)) - z) < 1e-4, `z=${z}`);
  }
  assert.ok(Math.abs(phi(1.96) - 0.975) < 1e-4);
});

test("weighted median, effective n", () => {
  assert.equal(weightedMedian([1, 2, 3, 4, 5], [1, 1, 1, 1, 1]), 3);
  assert.equal(weightedMedian([10, 20], [1, 3]), 20, "heavy weight pulls the median");
  assert.equal(weightedMedian([], []), null);
  assert.equal(effectiveN([1, 1, 1, 1]), 4);
  assert.ok(effectiveN([1, 0.2, 0.2, 0.2]) < 3 && effectiveN([1, 0.2, 0.2, 0.2]) > 2, "decayed runs count for less");
});

test("percentile against published quantiles interpolates and clamps", () => {
  const q = [5, 10, 25, 50, 75, 90, 95];
  const v = [100, 120, 150, 200, 250, 300, 320];
  assert.equal(percentileInCell(q, v, 200), 50);
  assert.equal(percentileInCell(q, v, 225), 62.5, "linear between p50 and p75");
  assert.equal(percentileInCell(q, v, 50), 5, "below the published tail");
  assert.equal(percentileInCell(q, v, 1e9), 95);
  assert.equal(percentileInCell(q, v, 225, false), 37.5, "lower-is-better flips the scale");
  assert.equal(percentileInCell(q, v, NaN), null);
  assert.ok(Math.abs(robustZ(q, v, 250) - (50 / (100 / 1.349))) < 1e-9);
});

// -------------------------------------------------------------- kit

test("kitFor: the spec's kick, and whether the spec is listed at all", () => {
  const arms = kitFor(LISTS, "Warrior", "Arms");
  assert.deepEqual(arms.kick, { id: 6552, name: "Pummel", cd: 15 });
  assert.equal(arms.known, true);
  assert.equal(arms.role, "dps");
  const holy = kitFor(LISTS, "Priest", "Holy");
  assert.equal(holy.known, true);
  assert.equal(holy.kick, null, "a listed spec without a kick");
  const fire = kitFor(LISTS, "Mage", "Fire");
  assert.equal(fire.known, false);
  assert.equal(fire.kick, null);
  assert.equal(kitFor(null, "Mage", "Fire").known, false);
});

test("the kick's cooldown is calibrated from its observed casts", () => {
  const { minGap, seen } = calibrateCooldowns([runFor(1)], new Set([6552]));
  assert.ok(seen.includes(6552));
  assert.ok(minGap[6552] > 14 && minGap[6552] < 17, `Pummel min gap ${minGap[6552]}s (base 15 s plus the latency of a real log)`);
  assert.equal(calibrateCooldowns([runFor(1)], new Set([1766])).seen.length, 0, "the rogue's Kick is not the warrior's");
});

// ------------------------------------------------------------ kicks

test("kick utilisation counts isolated dangerous casts while the kick was up", () => {
  const dangerous = new Set([1294557, 1289416]); // Piercing Hiss, Envenom — not Fetid Spit
  const tank = kickUtilisation(runFor(260), kitFor(LISTS, "DeathKnight", "Blood"), dangerous, {});
  assert.ok(tank.opportunities > 0, "opportunities found");
  assert.ok(tank.utilisation >= 0 && tank.utilisation <= 1);
  assert.equal(tank.kicksLanded, F8.interrupts.filter((e) => e.sourceID === 260).length);
  assert.ok(tank.kicksPerMin > 0.5, `${tank.kicksPerMin} kicks/min`);
  // Piercing Hiss was kicked 34 of 36 times by this group: utilisation is high
  assert.ok(tank.utilisation >= 0.6, `utilisation ${tank.utilisation} (${tank.misses}/${tank.opportunities})`);
  // filler only: every "dangerous" cast completes, so utilisation is low
  const filler = kickUtilisation(runFor(260), kitFor(LISTS, "DeathKnight", "Blood"), new Set([1306381]), {});
  assert.ok(filler.utilisation < tank.utilisation, "Fetid Spit is let through on purpose");
  assert.equal(kickUtilisation(runFor(260, { events: null }), kitFor(LISTS, "DeathKnight", "Blood"), dangerous, {}), null);
  assert.equal(kickUtilisation(runFor(125), kitFor(LISTS, "Priest", "Holy"), dangerous, {}), null, "no kick, no utilisation");
});

// ------------------------------------------------------------ stops

test("stops: the applicant's interrupts made with anything but the kick", () => {
  // the warrior: 23 Pummels, 3 Shockwaves and a Storm Bolt
  const warrior = stops(runFor(1), kitFor(LISTS, "Warrior", "Arms"));
  assert.equal(warrior.n, 4);
  assert.equal(warrior.source, "events");
  assert.ok(Math.abs(warrior.perMin - 4 / MINUTES) < 1e-9);
  // the rogue only ever Kicked; the tank has five Blinding Sleets
  assert.equal(stops(runFor(79), kitFor(LISTS, "Rogue", "Assassination")).n, 0);
  assert.equal(stops(runFor(260), kitFor(LISTS, "DeathKnight", "Blood")).n, 5);
  // a listed spec without a kick: every interrupt is a stop (the shaman's
  // four Wind Shears, were she a Holy Priest)
  assert.equal(stops(runFor(125), kitFor(LISTS, "Priest", "Holy")).n, 4);
  // an unlisted spec: the kick cannot be told apart, so no verdict
  assert.equal(stops(runFor(1), kitFor(LISTS, "Mage", "Fire")), null);
  // no events: the store row, when the collector fetched the table
  const row = stops(runFor(1, { events: null, exec: { rows: { 1: { kicks: 27, stops: 3 } } } }), kitFor(LISTS, "Warrior", "Arms"));
  assert.equal(row.n, 3);
  assert.equal(row.source, "row");
  assert.equal(stops(runFor(1, { events: null, exec: { rows: { 1: { kicks: 27, stops: null } } } }), kitFor(LISTS, "Warrior", "Arms")), null, "null in the row: never a zero");
  assert.equal(stops(runFor(1, { events: null, exec: null }), kitFor(LISTS, "Warrior", "Arms")), null);
});

// --------------------------------------------------------- assemble

// runs -> facts the way fit.js does it: calibrate the kick over every run first
function factsFor(runs, dangerousIds) {
  const kit = kitFor(LISTS, runs[0].cls, runs[0].spec);
  const ids = new Set(kit.kick ? [kit.kick.id] : []);
  const { minGap } = mergeCastStats(runs.map((r) => castStats(r, ids)));
  return runs.map((r) => runFacts(r, { kit, calib: minGap, dangerousIds }));
}

const Q = [5, 10, 25, 50, 75, 90, 95];
function fakeBaselines(dpsQuantiles) {
  return {
    cellFor: (spec, dungeon, level) => ({ key: `${spec}|${dungeon}|${level}`, tier: "exact", n: 500, q: Q, dps: dpsQuantiles, kick_prio: [0.2, 0.3, 0.5, 0.8, 1.1, 1.5, 1.8], stops_min: [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7], dispels_min: [0, 0.1, 0.3, 0.6, 1, 1.5, 2] }),
    percentile: (cell, measure, v) => (Array.isArray(cell[measure]) ? percentileInCell(cell.q, cell[measure], v, true) : null),
  };
}

test("assess: six runs of the warrior — damage from Key % without baselines, kicks from utilisation, stops wait for a cell", () => {
  const now = Date.now();
  const runs = Array.from({ length: 6 }, (_, i) => runFor(1, { start: now - i * 4 * 86_400_000, code: `RUN${i}` }));
  const facts = factsFor(runs, new Set([1294557, 1289416]));
  assert.equal(facts[0].stops.n, 4, "facts carry the stop count");
  assert.ok(!("events" in facts[0]), "and no raw events");
  assert.ok(!("deaths" in facts[0]) && !("selfsave" in facts[0]) && !("triage" in facts[0]), "nothing of the dropped measures");
  const a = assess(facts, "dps", { now });
  assert.deepEqual(a.weights, { damage: 60, kicks: 25, stops: 15 });
  assert.equal(a.measures.damage.n, 6);
  assert.equal(a.measures.damage.pct, 58, "Key % used when no cell exists");
  assert.equal(a.measures.damage.runs[0].source, "Key %");
  assert.equal(a.measures.kicks.mode, "utilisation");
  assert.ok(a.measures.kicks.z !== null);
  assert.equal(a.measures.stops.n, 0, "no cell: not scored");
  assert.equal(a.measures.stops.z, null);
  assert.ok(Math.abs(a.measures.stops.stopsPerMin - 4 / MINUTES) < 1e-9, "the rate itself is still reported");
  assert.equal(a.measures.dispels, undefined, "dispels are a healer measure");
  assert.equal(a.flags, undefined, "no flags remain");
  assert.ok(a.composite, "damage + kicks = 85 of the weight");
  assert.deepEqual(a.present, ["damage", "kicks"]);
  assert.ok(a.composite.pct > 1 && a.composite.pct < 99);
  assert.ok(a.composite.presentWeight >= SET_B.presentWeight);
});

test("assess: with baselines the damage percentile comes from the cell and stops are judged against stops_min", () => {
  const now = Date.now();
  const rows = { 1: { dps: 312_375, kicks: 27, kicks_by: { 1294557: 8, 1306381: 3 }, stops: 9 }, 79: { dps: 290_000, kicks: 17, kicks_by: { 1294557: 10 }, stops: 0 }, 124: { dps: 300_000, kicks: 8 }, 125: { dps: 60_000, kicks: 4 }, 260: { dps: 200_000, kicks: 29 } };
  const runs = Array.from({ length: 5 }, (_, i) => runFor(1, { start: now - i * 3 * 86_400_000, code: `R${i}`, amount: 312_375, keyPct: 40, exec: { rows } }));
  const baselines = fakeBaselines([200_000, 220_000, 250_000, 280_000, 310_000, 340_000, 360_000]);
  const a = assess(factsFor(runs, new Set([1294557, 1289416])), "dps", { baselines, priority: { "Altar of Fangs": { 1294557: { begun: 100, interrupted: 90, completed: 10 }, 1306381: { begun: 120, interrupted: 12, completed: 108 } } }, now });
  assert.match(a.measures.damage.runs[0].source, /cell/);
  assert.ok(a.measures.damage.pct > 75 && a.measures.damage.pct < 90, `312k sits between p75 and p90: ${a.measures.damage.pct}`);
  // four stops in 26.7 minutes = 0.15/min: between the cell's p25 (0.10) and p50 (0.20)
  assert.equal(a.measures.stops.n, 5);
  assert.ok(a.measures.stops.pct > 25 && a.measures.stops.pct < 50, `stops percentile ${a.measures.stops.pct}`);
  assert.ok(a.measures.stops.z < 0 && a.measures.stops.z > -1);
  assert.ok(Math.abs(a.measures.stops.stopsPerMin - 4 / MINUTES) < 1e-9, "events win over the row's 9 when both are there");
  assert.equal(a.measures.kicks.mode, "utilisation");
  assert.equal(a.measures.potions, undefined, "no potion gate: preparation is not ability");
  assert.deepEqual(a.present, ["damage", "kicks", "stops"]);
  assert.ok(a.composite);
  assert.equal(a.composite.presentWeight, 100);
});

test("assess: the row's stops serve a run without events", () => {
  const now = Date.now();
  const runs = Array.from({ length: 4 }, (_, i) => runFor(1, { start: now - i * 3 * 86_400_000, code: `S${i}`, events: null, exec: { source: "store", rows: { 1: { dps: 312_375, kicks: 20, kicks_by: { 1294557: 20 }, stops: 8 } } } }));
  const a = assess(factsFor(runs, new Set()), "dps", { baselines: fakeBaselines([200_000, 220_000, 250_000, 280_000, 310_000, 340_000, 360_000]), now });
  assert.equal(a.measures.stops.n, 4);
  assert.ok(Math.abs(a.measures.stops.stopsPerMin - 8 / MINUTES) < 1e-9);
  assert.ok(a.measures.stops.z > 0, "0.3/min is the cell's p75");
  assert.equal(a.measures.kicks.mode, "priority-weighted rate", "no events: the population rate fallback");
});

test("assess: a healer keeps dispels, at the healer weights", () => {
  const now = Date.now();
  const rows = { 125: { dps: 60_000, kicks: 5, kicks_by: { 1294557: 1 }, stops: 0, dispels: 18, dispels_by: { 1307571: 8 } } };
  const dispel_spells = { 1307571: { name: "Envenom", applied: 17, dispelled: 11, expired: 6 } };
  const runs = Array.from({ length: 5 }, (_, i) => runFor(125, { start: now - i * 3 * 86_400_000, code: `H${i}`, amount: 60_000, keyPct: 50, exec: { rows, dispel_spells } }));
  const a = assess(factsFor(runs, new Set([1294557, 1289416])), "healer", { baselines: fakeBaselines([30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000]), now });
  assert.deepEqual(a.weights, { damage: 15, kicks: 30, stops: 25, dispels: 30 });
  assert.equal(a.measures.dispels.n, 5);
  assert.ok(a.measures.dispels.z !== null);
  assert.ok(Math.abs(a.measures.dispels.missedShare - 6 / 17) < 1e-9, "six of seventeen Envenoms expired");
  // 18 dispels in 26.7 min = 0.67/min, just above the cell's p50 (0.6); blended with 65 % not missed
  assert.ok(a.measures.dispels.pct > 50 && a.measures.dispels.pct < 70, `dispels percentile ${a.measures.dispels.pct}`);
  assert.equal(a.measures.stops.n, 5, "the shaman only Wind Sheared: zero stops per minute, still a value");
  assert.ok(a.composite);
  assert.deepEqual(assess(factsFor(runs, new Set()), "tank", { now }).weights, { damage: 40, kicks: 35, stops: 25 });
});

test("facts survive a JSON round-trip (the 14-day per-run cache)", () => {
  const facts = factsFor([runFor(1)], new Set([1294557]));
  const back = JSON.parse(JSON.stringify(facts));
  assert.equal(back[0].v, 2);
  assert.equal(back[0].stops.n, 4);
  const a = assess(back, "dps", {});
  assert.ok(Math.abs(a.measures.stops.stopsPerMin - 4 / MINUTES) < 1e-9);
  const merged = mergeCastStats(back.map((f) => f.casts));
  assert.ok(merged.seen.has(6552), "the kick survives the round trip (a Set would have become {})");
  assert.ok(merged.minGap[6552] > 0);
  assert.ok(JSON.stringify(facts[0]).length < 4_000, "small enough to cache many of them");
});

test("recurring teammates are detected by name", () => {
  const runs = Array.from({ length: 4 }, () => runFor(1));
  assert.ok(recurringTeammates(runs).length >= 1);
  const solo = runFor(1); solo.players = solo.players.map((p, i) => ({ ...p, name: `P${i}` }));
  const other = runFor(1); other.players = other.players.map((p, i) => ({ ...p, name: `Q${i}` }));
  const third = runFor(1); third.players = third.players.map((p, i) => ({ ...p, name: `R${i}` }));
  assert.deepEqual(recurringTeammates([solo, other, third]), []);
});
