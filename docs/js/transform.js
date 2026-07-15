// transform.js — turn raw WCL encounterRankings responses into per-player,
// per-key-level percentile tables, and answer the "how are their logs for
// THIS key level / THIS dungeon" question.

// WCL classID -> WoW class token (WCL GameClass ids are stable).
const WCL_CLASS_TOKENS = {
  1: "DEATHKNIGHT", 2: "DRUID", 3: "HUNTER", 4: "MAGE", 5: "MONK",
  6: "PALADIN", 7: "PRIEST", 8: "ROGUE", 9: "SHAMAN", 10: "WARLOCK",
  11: "WARRIOR", 12: "DEMONHUNTER", 13: "EVOKER",
};

export function classToken(classID) {
  return WCL_CLASS_TOKENS[classID];
}

// Spec name -> role. Ambiguous names (Protection, Holy, Restoration) are
// unambiguous at the role level: every spec sharing a name shares a role.
const HEALER_SPECS = new Set(["Restoration", "Preservation", "Mistweaver", "Holy", "Discipline"]);
const TANK_SPECS = new Set(["Blood", "Vengeance", "Guardian", "Brewmaster", "Protection"]);

export function roleOfSpec(spec) {
  if (!spec) return "dps";
  if (HEALER_SPECS.has(spec)) return "healer";
  if (TANK_SPECS.has(spec)) return "tank";
  return "dps";
}

// Which role does this character mainly play *now*? Their runs (newest
// first) are score-summed per role with an exponential decay per run, so
// the last ~10-15 runs dominate: a tank who switched to healing mid-season
// reads as a healer, but one novelty off-role run can't flip a long main.
// Plain all-time score sums fail exactly that case — months of old
// tank runs outweighing a current healer main. Runs break score ties;
// dps wins remaining ties. null when there are no runs to judge by.
export const ROLE_RECENCY_DECAY = 0.9;

export function detectRole(result) {
  if (!result) return null;
  const all = [];
  for (const [alias, blob] of Object.entries(result)) {
    if (!/^e\d+$/.test(alias)) continue;
    const seen = new Set(); // the API sometimes lists a run twice
    for (const rank of blob?.ranks ?? []) {
      const key = `${rank?.bracketData}:${rank?.amount ?? pickPercent(rank)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        role: roleOfSpec(rank?.spec),
        // score can be missing: still count the run, so recency order matters
        score: rank?.score || 1,
        when: typeof rank?.startTime === "number" ? rank.startTime : 0,
      });
    }
  }
  if (all.length === 0) return null;
  all.sort((a, b) => b.when - a.when);
  const score = { tank: 0, healer: 0, dps: 0 };
  const runs = { tank: 0, healer: 0, dps: 0 };
  all.forEach((r, i) => {
    score[r.role] += r.score * Math.pow(ROLE_RECENCY_DECAY, i);
    runs[r.role] += 1;
  });
  let best = "dps";
  for (const r of ["healer", "tank"]) {
    if (score[r] > score[best] || (score[r] === score[best] && runs[r] > runs[best])) best = r;
  }
  return best;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// An encounterRankings blob (metric: dps, byBracket: true):
//   { bestAmount, totalKills, metric,
//     ranks: [ { rankPercent, historicalPercent, todayPercent, bracketData,
//               amount, spec, ... } ] }
// bracketData is the keystone level of that run. With byBracket: true the
// percentiles are computed within that key level — the "Key %" from a
// report's DPS tab. We use the HISTORICAL percentile (frozen as of the day
// the run happened), not todayPercent: gear inflation over a season pushes
// everyone's absolute dps up, so re-ranking an old run against today's
// population systematically understates it. "What it was then" is the
// fairer skill signal.
export function pickPercent(rank) {
  const pct = rank?.historicalPercent ?? rank?.rankPercent;
  return typeof pct === "number" ? pct : null;
}

// Collapse one dungeon's ranks into { [keyLevel]: { pct, spec, pcts } }:
// pct/spec from the best run at that level, pcts = every run's percentile
// (so best/average/median can be shown). The API sometimes lists the same
// run twice (identical amount at the same level) — those are deduped so
// they don't skew averages. filterRole keeps only runs played in that role
// (a run is judged by the job its spec was doing, not the player's main).
export function bestPerLevel(blob, filterRole) {
  const out = {};
  const seen = new Set();
  for (const rank of blob?.ranks ?? []) {
    if (filterRole && roleOfSpec(rank?.spec) !== filterRole) continue;
    const level = rank?.bracketData;
    const pct = pickPercent(rank);
    if (!Number.isInteger(level) || level < 2 || pct === null) continue;
    const key = `${level}:${rank.amount ?? pct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = round1(pct);
    if (!out[level]) out[level] = { pct: -1, spec: undefined, pcts: [] };
    const e = out[level];
    e.pcts.push(p);
    if (p > e.pct) {
      e.pct = p;
      e.spec = rank.spec || rank.bestSpec || undefined;
      if (typeof rank.startTime === "number") e.when = rank.startTime; // ms
      // provenance: link the best run to its exact report fight
      if (rank.report?.code) {
        e.report = { code: rank.report.code, fightID: rank.report.fightID };
      }
    }
  }
  return out;
}

// One character's aliased result ({ classID, e<encID>: blob, ... }) ->
//   { class, role, levels: { [level]: { best, runs, dungeons: { [encID]: {pct,spec} } } } }
// A null result (character not on WCL) -> { missing: true }.
// role can be passed in (e.g. detected from the dps pass while building
// from the hps pass); otherwise it's detected from this result.
// filterRole restricts the table to runs played in that role.
export function playerFromResult(result, role, filterRole) {
  if (!result) return { missing: true };
  const levels = {};
  for (const [alias, blob] of Object.entries(result)) {
    const m = /^e(\d+)$/.exec(alias);
    if (!m) continue;
    const encID = Number(m[1]);
    for (const [levelStr, entry] of Object.entries(bestPerLevel(blob, filterRole))) {
      const level = Number(levelStr);
      levels[level] ??= { best: 0, runs: 0, dungeons: {} };
      levels[level].dungeons[encID] = entry;
      levels[level].runs += 1;
      if (entry.pct > levels[level].best) levels[level].best = entry.pct;
    }
  }
  return { class: classToken(result.classID), role: role ?? detectRole(result), levels };
}

// Which roles has this character actually played (any spec, any run)?
export function rolesWithRuns(result) {
  const out = new Set();
  if (!result) return out;
  for (const [alias, blob] of Object.entries(result)) {
    if (!/^e\d+$/.test(alias)) continue;
    for (const rank of blob?.ranks ?? []) out.add(roleOfSpec(rank?.spec));
  }
  return out;
}

// Per-role tables for one character, each run judged by the role it was
// played in: healer-spec runs take their percentiles from the hps result
// (healers are ranked on healing), tank/dps-spec runs from the dps result.
// Roles with no runs are absent. `detected` is the recency-weighted main.
export function buildRolePlayers(dpsResult, hpsResult) {
  if (!dpsResult) return { detected: null, byRole: {} };
  const detected = detectRole(dpsResult);
  const byRole = {};
  for (const role of ["tank", "healer", "dps"]) {
    // never fall back to dps percentiles for healer runs: mislabeled
    // numbers are worse than an absent table
    const src = role === "healer" ? hpsResult : dpsResult;
    if (!src) continue;
    const p = playerFromResult(src, role, role);
    if (Object.keys(p.levels).length > 0) byRole[role] = p;
  }
  return { detected, byRole };
}

// Does a result contain any usable ranked runs at all?
export function hasRanks(result) {
  if (!result) return false;
  return Object.entries(result).some(([alias, blob]) =>
    /^e\d+$/.test(alias) && (blob?.ranks?.length ?? 0) > 0);
}

// The core verdict, mirroring how you'd vet a player manually:
//   anyAtLevel  { pct, runs }   best percentile at exactly keyLevel, any dungeon
//   dungeon     { pct, level, spec, kind: "exact"|"above"|"below" }
//   dungeonBest { pct, level }  best logged level for the dungeon otherwise
//   anyBest     { pct, level }  highest level with any logs (when no anyAtLevel)
export function evaluate(player, encounterID, keyLevel) {
  if (!player || player.missing) return { status: "NO_WCL" };
  const levels = player.levels ?? {};
  const result = { status: "OK" };
  const levelNums = Object.keys(levels).map(Number);

  if (keyLevel) {
    const atLevel = levels[keyLevel];
    if (atLevel && atLevel.runs > 0) {
      // pcts: each dungeon's best at this level (feeds best/avg/median)
      result.anyAtLevel = {
        pct: atLevel.best,
        runs: atLevel.runs,
        pcts: Object.values(atLevel.dungeons).map((d) => d.pct),
      };
    }
    if (encounterID) {
      const exact = atLevel?.dungeons?.[encounterID];
      if (exact) {
        result.dungeon = { pct: exact.pct, level: keyLevel, spec: exact.spec, kind: "exact", pcts: exact.pcts, ...(exact.when !== undefined && { when: exact.when }) };
      } else {
        const above = levelNums
          .filter((l) => l > keyLevel && levels[l].dungeons?.[encounterID])
          .sort((a, b) => a - b)[0];
        if (above !== undefined) {
          const d = levels[above].dungeons[encounterID];
          result.dungeon = { pct: d.pct, level: above, spec: d.spec, kind: "above", pcts: d.pcts, ...(d.when !== undefined && { when: d.when }) };
        } else {
          const fb = levels[keyLevel - 1]?.dungeons?.[encounterID];
          if (fb) {
            result.dungeon = { pct: fb.pct, level: keyLevel - 1, spec: fb.spec, kind: "below", pcts: fb.pcts, ...(fb.when !== undefined && { when: fb.when }) };
          }
        }
      }
    }
  }

  if (encounterID && !result.dungeon) {
    const withDungeon = levelNums.filter((l) => levels[l].dungeons?.[encounterID]);
    if (withDungeon.length) {
      const best = Math.max(...withDungeon);
      result.dungeonBest = { level: best, pct: levels[best].dungeons[encounterID].pct };
    }
  }

  if (!result.anyAtLevel && levelNums.length) {
    const best = Math.max(...levelNums);
    result.anyBest = { level: best, pct: levels[best].best };
  }

  return result;
}

// Restrict a player's levels to the relevant window around the target key
// level: [level - spread, level + spread]. Levels outside are noise for the
// invite decision and are dropped everywhere (summary + details).
export function windowLevels(player, level, spread = 4) {
  if (!player || player.missing || !level) return player;
  const levels = {};
  for (const [l, entry] of Object.entries(player.levels ?? {})) {
    const n = Number(l);
    if (n >= level - spread && n <= level + spread) levels[n] = entry;
  }
  return { ...player, levels };
}

export function average(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Warcraft Logs color tier for a percentile.
export function tierClass(pct) {
  if (pct >= 100) return "tier-gold";
  if (pct >= 99) return "tier-pink";
  if (pct >= 95) return "tier-orange";
  if (pct >= 75) return "tier-purple";
  if (pct >= 50) return "tier-blue";
  if (pct >= 25) return "tier-green";
  return "tier-gray";
}

// Sort key for the summary table: strongest relevant signal first.
export function sortValue(evalResult) {
  if (evalResult.status !== "OK") return -2;
  if (evalResult.dungeon) return evalResult.dungeon.pct;
  if (evalResult.anyAtLevel) return evalResult.anyAtLevel.pct - 0.001;
  if (evalResult.dungeonBest) return -1 + (evalResult.dungeonBest.pct ?? 0) / 1000;
  if (evalResult.anyBest) return -1.5 + (evalResult.anyBest.pct ?? 0) / 1000;
  return -2;
}

// Match a dungeon name (possibly partial/decorated) against zone encounters.
// Prefix matches beat substring matches; longest name wins ties.
export function simplifyName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function encounterByName(encounters, text) {
  if (!text) return null;
  const target = simplifyName(text);
  if (!target) return null;
  let best = null, bestScore = -1;
  for (const e of encounters ?? []) {
    if (!e?.name) continue;
    const s = simplifyName(e.name);
    if (s === target) return e;
    let score = -1;
    if (s.startsWith(target) || target.startsWith(s)) score = 2000 + s.length;
    else if (s.includes(target) || target.includes(s)) score = 1000 + s.length;
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 1000 ? best : null;
}
