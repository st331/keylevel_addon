// measures.test.mjs — the Set B engine against REAL logs: Altar of Fangs
// +16 (P3j1myqhvQcMp6Tk fight 8: 8 deaths, one wipe cascade) and a timed
// +22 healer window (X3L24CBGv6Rz9xWf fight 17). Fixtures are trimmed
// copies of the Warcraft Logs event streams the site pulls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phi, phiInv, weightedMedian, percentileInCell, effectiveN, robustZ } from "../docs/js/stats.js";
import {
  classifyRunDeaths, deathAllowance, selfSave, kickUtilisation, triage, triageScore,
  kitFor, calibrateCooldowns, recurringTeammates, assess, runFacts, mergeCastStats, castStats, SET_B, DEATH_COST,
} from "../docs/js/measures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const F8 = JSON.parse(fs.readFileSync(path.join(here, "fixtures/fight8.json"), "utf8"));
const F17 = JSON.parse(fs.readFileSync(path.join(here, "fixtures/fight17_healer.json"), "utf8"));

// the ids verified in verify_defensives (base cooldowns; talents shorten them)
const LISTS = {
  version: "test",
  consumables: { healthstone: 6262, healing_potion: [1295247], combat_potion: [] },
  specs: {
    "Warrior-Arms": { role: "dps", kick: { id: 6552, name: "Pummel", cd: 15 },
      defensives: [{ id: 118038, name: "Die by the Sword", cd: 120 }, { id: 23920, name: "Spell Reflection", cd: 25 }, { id: 97462, name: "Rallying Cry", cd: 180 }, { id: 386208, name: "Defensive Stance", cd: 3 }],
      selfheals: [{ id: 202168, name: "Impending Victory", cd: 30 }] },
    "Rogue-Assassination": { role: "dps", kick: { id: 1766, name: "Kick", cd: 15 },
      defensives: [{ id: 5277, name: "Evasion", cd: 120 }, { id: 31224, name: "Cloak of Shadows", cd: 120 }, { id: 1966, name: "Feint", cd: 15 }],
      selfheals: [{ id: 185311, name: "Crimson Vial", cd: 30 }] },
    "Hunter-Marksmanship": { role: "dps", kick: { id: 147362, name: "Counter Shot", cd: 24 },
      defensives: [{ id: 264735, name: "Survival of the Fittest", cd: 120 }, { id: 186265, name: "Aspect of the Turtle", cd: 180 }],
      selfheals: [{ id: 109304, name: "Exhilaration", cd: 120 }] },
    "Shaman-Restoration": { role: "healer", kick: { id: 57994, name: "Wind Shear", cd: 12 },
      defensives: [{ id: 108271, name: "Astral Shift", cd: 120 }], selfheals: [] },
    "DeathKnight-Blood": { role: "tank", kick: { id: 47528, name: "Mind Freeze", cd: 15 },
      defensives: [{ id: 48792, name: "Icebound Fortitude", cd: 180 }, { id: 48707, name: "Anti-Magic Shell", cd: 60 }, { id: 55233, name: "Vampiric Blood", cd: 90 }],
      selfheals: [{ id: 48743, name: "Death Pact", cd: 120 }] },
  },
};

const CLASS_OF = { 1: "Warrior", 79: "Rogue", 124: "Hunter", 125: "Shaman", 260: "DeathKnight" };
const SPEC_OF = { 1: "Arms", 79: "Assassination", 124: "Marksmanship", 125: "Restoration", 260: "Blood" };
const ROLE_OF = { 1: "dps", 79: "dps", 124: "dps", 125: "healer", 260: "tank" };
const DEATH_TIMES = F8.deaths.map((d) => d.timestamp);

// Which ±10 s window holds this death? (the fixture's windows are the four
// clusters the verification agent pulled)
function windowFor(t) {
  for (const [k, dmg] of Object.entries(F8.windows)) {
    if (!k.startsWith("d")) continue;
    const ts = dmg.map((e) => e.timestamp);
    if (t >= Math.min(...ts) - 1000 && t <= Math.max(...ts) + 2000) {
      return { dmg, heal: F8.windows["h" + k.slice(1)] ?? [] };
    }
  }
  return null;
}

function runFor(selfId, extra = {}) {
  const players = [1, 79, 124, 125, 260].map((id) => ({ id, name: F8.actors.find((a) => a.id === id)?.name ?? String(id), cls: CLASS_OF[id], spec: SPEC_OF[id], role: ROLE_OF[id] }));
  const own = F8.deaths.filter((d) => d.targetID === selfId).sort((a, b) => a.timestamp - b.timestamp);
  const windows = {};
  own.forEach((d, i) => { windows[i] = windowFor(d.timestamp); });
  return {
    code: F8.report, fightID: F8.fightID, dungeon: "Altar of Fangs", level: 16,
    start: Date.now() - 3 * 86_400_000, durationS: (F8.fight.endTime - F8.fight.startTime) / 1000, timed: true,
    selfId, cls: CLASS_OF[selfId], spec: SPEC_OF[selfId], role: ROLE_OF[selfId], players, healerId: 125,
    fight: { startTime: F8.fight.startTime, endTime: F8.fight.endTime },
    amount: 312_375, keyPct: 58,
    exec: null,
    events: { deaths: F8.deaths, low35: F8.low35, kitCasts: F8.kitCasts, begin: F8.begincast, interrupts: F8.interrupts, windows },
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

// ----------------------------------------------------------- deaths

test("fight 8: the wipe cascade is chain, the one-shots are one-shots, the warrior's slow death is solo", () => {
  const kit = (id) => kitFor(LISTS, CLASS_OF[id], SPEC_OF[id]);
  const all = [1, 79, 124, 125, 260].map((id) => runFor(id));
  const { minGap, seen } = calibrateCooldowns(all, new Set([...kit(1).kit.keys()]));
  const byPlayer = {};
  for (const run of all) byPlayer[run.selfId] = classifyRunDeaths(run, { kit: kit(run.selfId), calib: minGap, seen });

  // tank: first to fall; the pack turned on the rest within 4 s
  assert.equal(byPlayer[260].length, 1);
  assert.equal(byPlayer[260][0].cls, "oneshot", "2.2M in 2.5 s: no one-second warning");
  // the four who followed within 4 s
  assert.equal(byPlayer[124][0].cls, "chain");
  assert.equal(byPlayer[1][0].cls, "chain");
  assert.equal(byPlayer[79][0].cls, "chain");
  assert.equal(byPlayer[125][0].cls, "chain");
  // rogue #6 (Unstable Totem, 0.9 s warning) and #8 (Paralyzing Shots at 100 %)
  assert.equal(byPlayer[79][1].cls, "oneshot");
  assert.ok(byPlayer[79][1].warnS < 1.5, `warn ${byPlayer[79][1].warnS}`);
  assert.equal(byPlayer[79][2].cls, "oneshot");
  assert.ok(byPlayer[79][2].hpBefore >= 0.8, "full HP a second before");
  // warrior #7: 28–52 % for five seconds, five options up, nothing pressed
  const w7 = byPlayer[1][1];
  assert.equal(w7.cls, "solo", JSON.stringify(w7));
  assert.ok(w7.warnS >= 1.5, `warning ${w7.warnS}s`);
  assert.ok(w7.available.includes("Spell Reflection") && w7.available.includes("Defensive Stance"), w7.available.join(","));
  assert.ok(!w7.available.includes("Die by the Sword"), "on cooldown (cast 96 s earlier)");
  assert.equal(w7.cost, DEATH_COST.solo);

  const total = (id) => byPlayer[id].reduce((a, d) => a + d.cost, 0);
  assert.ok(Math.abs(total(79) - 0.60) < 1e-9);
  assert.ok(Math.abs(total(1) - 1.10) < 1e-9);
  assert.ok(Math.abs(total(260) - 0.25) < 1e-9);
  assert.ok(Math.abs(total(124) - 0.10) < 1e-9);
  assert.ok(Math.abs(total(125) - 0.10) < 1e-9);
});

test("deaths without event windows fall back to the tables-only costs", () => {
  const run = runFor(79, { events: null, exec: { rows: {}, death_events: F8.deaths.map((d) => ({ id: d.targetID, deathTime: d.timestamp - F8.fight.startTime, ability: { guid: d.killingAbilityGameID } })) } });
  const cls = classifyRunDeaths(run, {});
  assert.equal(cls.length, 3);
  assert.equal(cls[0].cls, "chain");
  assert.equal(cls[0].cost, 0.10);
  assert.equal(cls[1].cost, 0.30, "everything else is 0.30 without events");
  assert.equal(classifyRunDeaths(runFor(79, { events: null, exec: null }), {}), null, "nothing known: no verdict");
});

test("the allowance: one-off deaths are free, repetition is not", () => {
  const solo = { cls: "solo", cost: 1, ability: 1306890 };
  const chain = { cls: "chain", cost: 0.1, ability: 1 };
  // nobody in fight 8 loses anything
  const one = deathAllowance([{ deaths: [chain, { cls: "oneshot", cost: 0.25, ability: 1306890 }, { cls: "oneshot", cost: 0.25, ability: 1307269 }] }]);
  assert.equal(one.excess, 0);
  assert.equal(one.loss01, 0);
  // one solo death in six runs: allowance 2.5
  const six = [{ deaths: [solo] }, ...Array.from({ length: 5 }, () => ({ deaths: [] }))];
  assert.equal(deathAllowance(six).loss01, 0);
  assert.equal(deathAllowance(six).repeated, false);
  // a solo death every run for six runs: full penalty and the flag
  const bad = Array.from({ length: 6 }, () => ({ deaths: [solo] }));
  const b = deathAllowance(bad);
  assert.equal(b.loss01, 1);
  assert.equal(b.repeated, true);
  assert.deepEqual(b.sameCause, [1306890], "same killing ability twice");
  // five chain deaths in five runs never move the score
  assert.equal(deathAllowance(Array.from({ length: 5 }, () => ({ deaths: [chain] }))).loss01, 0);
  // per-run cap: a five-death run costs at most 2
  assert.equal(deathAllowance([{ deaths: [solo, solo, solo, solo] }]).W, 2);
  // three solo deaths spread over thirty runs cost nothing
  const thirty = Array.from({ length: 30 }, (_, i) => ({ deaths: i % 10 === 0 ? [solo] : [] }));
  assert.equal(deathAllowance(thirty).loss01, 0);
});

// -------------------------------------------------------- self-save

test("self-save: the rogue never pressed anything, Blood is excluded", () => {
  const rogue = selfSave(runFor(79), kitFor(LISTS, "Rogue", "Assassination"));
  assert.ok(rogue.episodes >= 1, "sub-35 % episodes exist");
  assert.equal(rogue.answered, 0);
  assert.equal(rogue.rate, 0);
  assert.equal(selfSave(runFor(260), kitFor(LISTS, "DeathKnight", "Blood")).excluded, "Blood DK lives below 35 %");
  const warrior = selfSave(runFor(1), kitFor(LISTS, "Warrior", "Arms"));
  assert.ok(warrior.episodes >= 1);
  assert.ok(warrior.rate === null || (warrior.rate >= 0 && warrior.rate <= 1));
  assert.equal(selfSave(runFor(1, { events: null }), kitFor(LISTS, "Warrior", "Arms")), null, "no events, no verdict");
  assert.equal(selfSave(runFor(1), kitFor(LISTS, "Mage", "Fire")), null, "no kit list for the spec: no verdict, never a zero");
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
});

// ----------------------------------------------------------- triage

test("healer triage on a timed +22: fast direct heals on isolated drops", () => {
  const healer = F17.healerID;
  const players = F17.actors.filter((a) => [5, 392, 393, 394, 396].includes(a.id)).map((a) => ({ id: a.id, name: a.name, cls: a.subType, spec: "?", role: a.id === healer ? "healer" : a.id === 5 ? "tank" : "dps" }));
  const low35 = F17.damageTaken.filter((e) => e.maxHitPoints > 0 && e.hitPoints < 0.35 * e.maxHitPoints);
  const run = {
    selfId: healer, players, durationS: (F17.window[1] - F17.window[0]) / 1000, role: "healer",
    events: { deaths: [], low35, healerHeal: F17.heal, healerCasts: F17.healerCasts },
  };
  const t = triage(run);
  assert.ok(t.episodes >= 5, `${t.episodes} episodes`);
  assert.ok(t.isolated >= 1);
  assert.ok(t.median !== null && t.median >= 0 && t.median < 3, `median latency ${t.median}s`);
  assert.ok(t.noOutputShare >= 0 && t.noOutputShare <= 1);
  const s = triageScore(t);
  assert.ok(s > 0 && s <= 1, `score ${s}`);
  assert.equal(triage({ selfId: healer, players, durationS: 100, events: null }), null);
});

// --------------------------------------------------------- assemble

// runs -> facts the way app.js does it: calibrate cooldowns over every run first
function factsFor(runs, dangerousIds) {
  const kit = kitFor(LISTS, runs[0].cls, runs[0].spec);
  const ids = new Set([...kit.kit.keys(), ...(kit.kick ? [kit.kick.id] : [])]);
  const { minGap, seen } = mergeCastStats(runs.map((r) => castStats(r, ids)));
  return runs.map((r) => runFacts(r, { kit, calib: minGap, seen, dangerousIds }));
}

function fakeBaselines(dpsQuantiles) {
  const q = [5, 10, 25, 50, 75, 90, 95];
  return {
    cellFor: (spec, dungeon, level) => ({ key: `${spec}|${dungeon}|${level}`, tier: "exact", n: 500, q, dps: dpsQuantiles, kick_prio: [0.2, 0.3, 0.5, 0.8, 1.1, 1.5, 1.8], avoid_dmg_min: [1e4, 2e4, 4e4, 8e4, 1.5e5, 3e5, 4e5], dispels_min: [0, 0.1, 0.3, 0.6, 1, 1.5, 2] }),
    percentile: (cell, measure, v) => percentileInCell(cell.q, cell[measure], v, measure !== "avoid_dmg_min"),
  };
}

test("assess: six runs of the warrior — damage from Key % without baselines, deaths flagged", () => {
  const now = Date.now();
  const runs = Array.from({ length: 6 }, (_, i) => runFor(1, { start: now - i * 4 * 86_400_000, code: `RUN${i}` }));
  const facts = factsFor(runs, new Set([1294557, 1289416]));
  assert.equal(facts[0].deaths.length, 2, "facts carry the classified deaths");
  assert.ok(!("events" in facts[0]), "and no raw events");
  const a = assess(facts, "dps", { now });
  assert.equal(a.measures.damage.n, 6);
  assert.equal(a.measures.damage.pct, 58, "Key % used when no cell exists");
  assert.equal(a.measures.damage.runs[0].source, "Key %");
  assert.equal(a.measures.deaths.n, 6);
  assert.equal(a.measures.deaths.loss01, 1, "a solo death every run");
  assert.equal(a.measures.deaths.z, -2);
  assert.ok(a.flags.some((f) => f.kind === "deaths" && /repeated/.test(f.text)));
  assert.ok(a.flags.some((f) => f.kind === "recurring"), "the same four teammates six times");
  assert.equal(a.measures.kicks.mode, "utilisation");
  assert.ok(a.measures.kicks.z !== null);
  assert.equal(a.measures.avoidable.z, null, "no cell, no tables: not scored");
  assert.ok(a.composite, "damage + kicks + deaths + self-save ≥ 60 of the weight");
  assert.ok(a.composite.pct > 1 && a.composite.pct < 99);
  assert.ok(a.composite.presentWeight >= SET_B.presentWeight);
});

test("assess: with baselines the damage percentile comes from the cell and the rogue's clean record costs nothing", () => {
  const now = Date.now();
  const rows = { 1: { dps: 312_375, deaths: 2, avoid_dmg: 4_000_000, pots: 1, kicks: 26, kicks_by: { 1294557: 20, 1306381: 6 } }, 79: { dps: 290_000, deaths: 3, avoid_dmg: 1_000_000, pots: 1, kicks: 20, kicks_by: { 1294557: 15 } }, 124: { dps: 300_000, deaths: 1, pots: 0, kicks: 13 }, 125: { dps: 60_000, deaths: 1, pots: 2, kicks: 7 }, 260: { dps: 200_000, deaths: 1, pots: 1, kicks: 27 } };
  const runs = Array.from({ length: 5 }, (_, i) => runFor(79, { start: now - i * 3 * 86_400_000, code: `R${i}`, amount: 290_000, keyPct: 40, exec: { rows } }));
  const baselines = fakeBaselines([200_000, 220_000, 250_000, 280_000, 310_000, 340_000, 360_000]);
  const a = assess(factsFor(runs, new Set([1294557, 1289416])), "dps", { baselines, priority: { "Altar of Fangs": { 1294557: { begun: 100, interrupted: 90, completed: 10 }, 1306381: { begun: 120, interrupted: 12, completed: 108 } } }, now });
  assert.match(a.measures.damage.runs[0].source, /cell/);
  assert.ok(Math.abs(a.measures.damage.pct - 58.3) < 1, `290k sits just above the median: ${a.measures.damage.pct}`);
  // three deaths a run, five runs: 0.60 × 5 = 3.0 against an allowance of
  // 2.25 — the excess 0.75 costs a quarter of the weight, not all of it
  assert.equal(a.measures.deaths.loss01, 0.25);
  assert.equal(a.measures.deaths.z, -0.5);
  assert.ok(a.measures.avoidable.pct !== null, "avoidable damage scored against the cell");
  assert.ok(a.measures.potions.pass);
  assert.equal(a.measures.selfsave.n, 5);
  assert.ok(a.composite);
});

test("facts survive a JSON round-trip (the 14-day per-run cache)", () => {
  const facts = factsFor([runFor(1)], new Set([1294557]));
  const back = JSON.parse(JSON.stringify(facts));
  const a = assess(back, "dps", {});
  assert.equal(a.measures.deaths.perRun[0].deaths.length, 2);
  const merged = mergeCastStats(back.map((f) => f.casts));
  assert.ok(merged.seen.has(23920), "seen spells survive the round trip (a Set would have become {})");
  assert.ok(merged.minGap[23920] > 0);
  assert.ok(JSON.stringify(facts[0]).length < 20_000, "small enough to cache many of them");
});

test("recurring teammates are detected by name", () => {
  const runs = Array.from({ length: 4 }, () => runFor(1));
  assert.ok(recurringTeammates(runs).length >= 1);
  const solo = runFor(1); solo.players = solo.players.map((p, i) => ({ ...p, name: `P${i}` }));
  const other = runFor(1); other.players = other.players.map((p, i) => ({ ...p, name: `Q${i}` }));
  const third = runFor(1); third.players = third.players.map((p, i) => ({ ...p, name: `R${i}` }));
  assert.deepEqual(recurringTeammates([solo, other, third]), []);
});
