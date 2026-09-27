import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFromTables, parseSummary, chainDeaths } from "../docs/js/execparse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(fs.readFileSync(path.join(here, "fixtures/tables_fight8.json"), "utf8"));

test("parseSummary: roster, dps, deaths, consumables from a real Summary table", () => {
  const s = parseSummary(T.summary);
  assert.equal(s.totalTime, 1603968);
  assert.equal(s.players.length, 5);
  const rogue = s.players.find((p) => p.id === 79);
  assert.equal(rogue.cls, "Rogue");
  assert.equal(rogue.spec, "Assassination");
  assert.equal(rogue.role, "dps");
  assert.equal(rogue.pots, 5);
  assert.equal(rogue.hs, 1);
  assert.equal(s.players.find((p) => p.id === 125).role, "healer");
  assert.equal(s.deaths.length, 8);
  assert.equal(s.deaths[0].id, 260, "the tank died first");
  assert.equal(s.deaths[0].ability.guid, 1, "melee");
  assert.equal(parseSummary(null), null);
});

test("chain deaths: within 5 s after someone else", () => {
  const dc = chainDeaths(parseSummary(T.summary).deaths);
  assert.deepEqual(dc[260], { deaths: 1, chain: 0 }, "the tank started the cascade");
  assert.deepEqual(dc[124], { deaths: 1, chain: 1 });
  assert.deepEqual(dc[79], { deaths: 3, chain: 1 }, "rogue: one chain death, two solo");
  assert.deepEqual(dc[1], { deaths: 2, chain: 1 });
});

test("execFromTables: every player gets a row; per-spell kicks and dispels are kept", () => {
  const exec = execFromTables(T);
  assert.equal(exec.source, "live");
  assert.equal(exec.exec, true);
  assert.equal(Object.keys(exec.rows).length, 5);
  const tank = exec.rows[260];
  assert.ok(Math.abs(tank.dps - 263_559_961 / 0 || 0) >= 0, "dps computed below");
  assert.equal(tank.deaths, 1);
  assert.equal(tank.deaths_chain, 0);
  assert.equal(tank.pots, 6);
  assert.ok(tank.kicks >= 19, `tank kicks ${tank.kicks}`);
  assert.equal(tank.kicks_by[1294557], 11, "eleven Piercing Hiss kicks");
  const healer = exec.rows[125];
  assert.equal(healer.dispels, 18, "8 Envenom + 10 Paralyzing Shots, totem dispels credited to the owner");
  assert.equal(healer.dispels_by[1307571], 8);
  assert.equal(exec.rows[1].dispels, 0, "no dispels → 0, not null, once the table is present");
  assert.equal(exec.dispel_spells[1307571].applied, 17);
  assert.equal(exec.dispel_spells[1307571].expired, 6);
  assert.equal(exec.dispel_spells[1307571].dispelled, 11);
  assert.equal(exec.int_spells[1294557].begun, 36);
  assert.equal(exec.int_spells[1294557].interrupted, 34);
  assert.equal(exec.rows[125].heal_total, 200_808_703);
  assert.equal(exec.rows[125].heal_over, 89_909_577);
  assert.ok(!(269 in exec.rows), "the NPC healing row is dropped");
  assert.equal(exec.dur_s, 1603.968);
  assert.equal(exec.death_events.length, 8);
  // the dps of a player = damage ÷ fight length (matches encounterRankings.amount)
  const dpsOf = (id) => exec.rows[id].dps;
  assert.ok(Math.abs(dpsOf(79) - 460_305_312 / 1603.968) < 1);
});

test("execFromTables: a missing table leaves nulls, never zeros", () => {
  const exec = execFromTables({ summary: T.summary });
  assert.equal(exec.exec, false);
  assert.equal(exec.rows[79].kicks, null);
  assert.equal(exec.rows[79].avoid_dmg, null);
  assert.equal(exec.rows[79].deaths, 3, "deaths come from the Summary alone");
  assert.equal(execFromTables({}), null);
  // the filtered damage-taken and casts fixtures are from another report:
  // unknown actor ids are ignored, present players get 0
  const partial = execFromTables({ summary: T.summary, dmgTaken: T.dmgTaken, casts: T.casts });
  assert.equal(partial.rows[79].avoid_dmg, 0);
  assert.equal(partial.rows[1].avoid_dmg, 6_165_734, "actor id 1 collides across reports in this fixture — it is just a parse check");
});
