// transform.mjs — turn raw WCL encounterRankings responses into the addon's
// data model (see KeyLevelLogs/Data.lua for the documented shape).

import { challengeMapIDFor } from "./dungeon_maps.mjs";

// WCL classID -> WoW class token (WCL GameClass ids are stable).
const WCL_CLASS_TOKENS = {
  1: "DEATHKNIGHT", 2: "DRUID", 3: "HUNTER", 4: "MAGE", 5: "MONK",
  6: "PALADIN", 7: "PRIEST", 8: "ROGUE", 9: "SHAMAN", 10: "WARLOCK",
  11: "WARRIOR", 12: "DEMONHUNTER", 13: "EVOKER",
};

export function classToken(classID) {
  return WCL_CLASS_TOKENS[classID];
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// An encounterRankings blob (byBracket: true) looks like:
//   { bestAmount, totalKills, difficulty, metric,
//     ranks: [ { rankPercent, historicalPercent, bracketData, spec, ... } ] }
// bracketData is the keystone level of that run. Percentile preference:
// bracketPercent (if the API provides it) else rankPercent — with
// byBracket: true, rankPercent is computed within the run's bracket.
export function pickPercent(rank) {
  const pct = rank?.bracketPercent ?? rank?.rankPercent;
  return typeof pct === "number" ? pct : null;
}

// Collapse one dungeon's ranks into { [keyLevel]: { pct, spec } } keeping the
// best percentile per level.
export function bestPerLevel(blob) {
  const out = {};
  for (const rank of blob?.ranks ?? []) {
    const level = rank?.bracketData;
    const pct = pickPercent(rank);
    if (!Number.isInteger(level) || level < 2 || pct === null) continue;
    if (!out[level] || pct > out[level].pct) {
      out[level] = { pct: round1(pct), spec: rank.spec || rank.bestSpec || undefined };
    }
  }
  return out;
}

// charResults: [{ key ("Name-Realm"), result: { classID, e<encID>: blob } }]
// Returns { players } in the addon's shape.
export function playersFromResults(charResults, nowSeconds) {
  const players = {};
  for (const c of charResults) {
    if (!c.result) {
      // Character not found on WCL. Record that fact so the addon can say
      // "no WCL character" (definitive) instead of "not fetched yet".
      players[c.key] = { missing: true, updated: nowSeconds };
      continue;
    }
    const levels = {};
    for (const [alias, blob] of Object.entries(c.result)) {
      const m = /^e(\d+)$/.exec(alias);
      if (!m) continue;
      const encID = Number(m[1]);
      for (const [levelStr, entry] of Object.entries(bestPerLevel(blob))) {
        const level = Number(levelStr);
        levels[level] ??= { best: 0, runs: 0, dungeons: {} };
        levels[level].dungeons[encID] = entry;
        levels[level].runs += 1;
        if (entry.pct > levels[level].best) levels[level].best = entry.pct;
      }
    }
    players[c.key] = {
      class: classToken(c.result.classID),
      updated: nowSeconds,
      levels,
    };
  }
  return { players };
}

// Build the dungeons table: WCL encounter id -> { name, challengeMapID }.
export function buildDungeonsTable(zoneEncounters, extras = {}) {
  const dungeons = {};
  for (const e of zoneEncounters ?? []) {
    if (!e?.id || !e?.name) continue;
    const d = { name: e.name };
    const mapID = challengeMapIDFor(e.name, extras);
    if (mapID) d.challengeMapID = mapID;
    dungeons[e.id] = d;
  }
  return dungeons;
}

// Merge freshly fetched players into an existing model (keeps previously
// fetched players so the database grows over time). A player fetched again
// is replaced wholesale.
export function mergeModel(existing, fresh) {
  const out = {
    meta: { ...(existing?.meta ?? {}), ...(fresh.meta ?? {}) },
    dungeons: { ...(existing?.dungeons ?? {}) },
    players: { ...(existing?.players ?? {}) },
  };
  for (const [id, d] of Object.entries(fresh.dungeons ?? {})) {
    out.dungeons[id] = { ...(out.dungeons[id] ?? {}), ...d };
  }
  for (const [name, p] of Object.entries(fresh.players ?? {})) {
    out.players[name] = p;
  }
  return out;
}
