import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFromTables, parseSummary } from "../docs/js/execparse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(fs.readFileSync(path.join(here, "fixtures/tables_fight8.json"), "utf8"));
const KICKS = { "Warrior-Arms": "Pummel", "Rogue-Assassination": "Kick", "Hunter-Marksmanship": "Counter Shot", "Shaman-Restoration": "Wind Shear", "DeathKnight-Blood": "Mind Freeze" };
const kickNameOf = (cls, spec) => KICKS[`${cls}-${spec}`] ?? null;

test("parseSummary: roster and damage from a real Summary table", () => {
  const s = parseSummary(T.summary);
  assert.equal(s.totalTime, 1603968);
  assert.equal(s.players.length, 5);
  const rogue = s.players.find((p) => p.id === 79);
  assert.equal(rogue.cls, "Rogue");
  assert.equal(rogue.spec, "Assassination");
  assert.equal(rogue.role, "dps");
  assert.equal(s.players.find((p) => p.id === 125).role, "healer");
  assert.equal(s.players.find((p) => p.id === 260).role, "tank");
  assert.equal(s.dps[79], 460_305_312);
  assert.equal(parseSummary(null), null);
});

test("execFromTables: every player gets a row; kicks, stops and dispels are kept per spell", () => {
  const exec = execFromTables(T, { kickNameOf });
  assert.equal(exec.source, "live");
  assert.equal(exec.exec, true);
  assert.equal(Object.keys(exec.rows).length, 5);
  const tank = exec.rows[260];
  assert.equal(tank.kicks, 29, "24 Mind Freezes and 5 Blinding Sleets");
  assert.equal(tank.kicks_by[1294557], 11, "eleven Piercing Hiss kicks");
  assert.equal(tank.stops, 5, "the Blinding Sleets are stops");
  const warrior = exec.rows[1];
  assert.equal(warrior.kicks, 27);
  assert.equal(warrior.stops, 4, "three Shockwaves and a Storm Bolt among 23 Pummels");
  assert.equal(exec.rows[79].stops, 0, "the rogue only Kicked: 0, not null, once the table is present");
  const healer = exec.rows[125];
  assert.equal(healer.dispels, 18, "8 Envenom + 10 Paralyzing Shots, totem dispels credited to the owner");
  assert.equal(healer.dispels_by[1307571], 8);
  assert.equal(exec.rows[1].dispels, 0, "no dispels → 0, not null, once the table is present");
  assert.equal(exec.dispel_spells[1307571].applied, 17);
  assert.equal(exec.dispel_spells[1307571].expired, 6);
  assert.equal(exec.dispel_spells[1307571].dispelled, 11);
  assert.equal(exec.dur_s, 1603.968);
  assert.ok(!("death_events" in exec) && !("deaths" in tank), "deaths are not read any more");
  // the dps of a player = damage ÷ fight length (matches encounterRankings.amount)
  assert.ok(Math.abs(exec.rows[79].dps - 460_305_312 / 1603.968) < 1);
});

test("execFromTables: a spec without a kick counts every interrupt as a stop; no kick names, no stops", () => {
  const all = execFromTables(T, { kickNameOf: () => null });
  assert.equal(all.rows[1].stops, 27);
  const blind = execFromTables(T);
  assert.equal(blind.rows[1].kicks, 27, "kicks need no names");
  assert.equal(blind.rows[1].stops, null, "the kick cannot be told apart");
});

test("execFromTables: a missing table leaves nulls, never zeros", () => {
  const exec = execFromTables({ summary: T.summary }, { kickNameOf });
  assert.equal(exec.exec, false);
  assert.equal(exec.rows[79].kicks, null);
  assert.equal(exec.rows[79].stops, null);
  assert.equal(exec.rows[125].dispels, null);
  assert.equal(exec.dispel_spells, null);
  assert.ok(Number.isFinite(exec.rows[79].dps), "dps comes from the Summary alone");
  const noDispels = execFromTables({ summary: T.summary, interrupts: T.interrupts }, { kickNameOf });
  assert.equal(noDispels.exec, false);
  assert.equal(noDispels.rows[1].stops, 4);
  assert.equal(noDispels.rows[125].dispels, null);
  assert.equal(execFromTables({}), null);
  assert.equal(execFromTables(null), null);
});
