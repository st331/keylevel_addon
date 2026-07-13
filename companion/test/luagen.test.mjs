import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDataLua, luaTable, luaString } from "../lib/luagen.mjs";

const MODEL = {
  meta: { generatedAt: "2026-07-13T00:00:00Z", region: "us", zoneID: 47, zoneName: 'M+ "S1"' },
  dungeons: {
    12805: { name: "Windrunner Spire", challengeMapID: 557 },
    361753: { name: "Seat of the Triumvirate", challengeMapID: 239 },
  },
  players: {
    "Foo-Area52": {
      class: "MAGE",
      updated: 1752000000,
      levels: {
        12: { best: 91.25, runs: 2, dungeons: { 12805: { pct: 91.25, spec: "Fire" } } },
      },
    },
  },
};

test("luaString escapes quotes/backslashes/newlines", () => {
  assert.equal(luaString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
});

test("numeric keys are bracketed, identifiers bare, others quoted", () => {
  const out = luaTable({ 12: 1, name: 2, "Foo-Bar": 3, ["end"]: 4 });
  assert.match(out, /\[12\] = 1/);
  assert.match(out, /(^|\s)name = 2/);
  assert.match(out, /\["Foo-Bar"\] = 3/);
  assert.match(out, /\["end"\] = 4/, "lua keywords must be quoted");
});

test("deterministic output", () => {
  assert.equal(generateDataLua(MODEL), generateDataLua(MODEL));
});

test("floats round to one decimal, integers stay integers", () => {
  const lua = generateDataLua(MODEL);
  assert.match(lua, /pct = 91\.3/);
  assert.match(lua, /challengeMapID = 557/);
});

test("generated lua parses and roundtrips under real lua5.1", (t) => {
  const luaBin = ["lua5.1", "lua"].find((bin) => !spawnSync(bin, ["-v"]).error);
  if (!luaBin) { t.skip("no lua interpreter on PATH"); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kll-"));
  const dataPath = path.join(dir, "Data.lua");
  fs.writeFileSync(dataPath, generateDataLua(MODEL));
  const script = `
dofile(${JSON.stringify(dataPath)})
local d = KeyLevelLogsData
assert(type(d) == "table", "table")
assert(d.meta.zoneID == 47, "zoneID")
assert(d.meta.zoneName == 'M+ "S1"', "escaped quote survived")
assert(d.dungeons[12805].name == "Windrunner Spire", "dungeon name")
assert(d.dungeons[361753].challengeMapID == 239, "big encounter id")
local p = d.players["Foo-Area52"]
assert(p.class == "MAGE", "class")
assert(p.levels[12].runs == 2, "runs")
assert(math.abs(p.levels[12].dungeons[12805].pct - 91.3) < 0.001, "pct rounded")
print("ROUNDTRIP_OK")
`;
  const scriptPath = path.join(dir, "check.lua");
  fs.writeFileSync(scriptPath, script);
  const res = spawnSync(luaBin, [scriptPath], { encoding: "utf8" });
  assert.equal(res.status, 0, `lua failed: ${res.stderr}`);
  assert.match(res.stdout, /ROUNDTRIP_OK/);
});

test("empty model still generates valid lua", () => {
  const lua = generateDataLua({ meta: {}, dungeons: {}, players: {} });
  assert.match(lua, /KeyLevelLogsData = \{/);
  assert.match(lua, /players = \{\}/);
});
