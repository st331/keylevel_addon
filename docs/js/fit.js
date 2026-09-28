// fit.js — orchestrates the Set B "Key fit" for one applicant: picks the
// window runs, decides where each run's data comes from under the
// no-repeat rule (design/baselines-from-wowlogs.md §1), pulls what only
// this site may pull, turns runs into cacheable facts and hands them to the
// measures engine. Pure of DOM; app.js drives it.

import { fetchRunBundles } from "./wcl.js";
import { RunStore, execFromStoredRun } from "./runstore.js";
import { loadBaselines } from "./baselines.js";
import { execFromTables } from "./execparse.js";
import { kitFor, castStats, mergeCastStats, runFacts, assess } from "./measures.js";
import { roleOfSpec, pickPercent, classToken, median } from "./transform.js";

export const WINDOW_SPREAD = 2;      // listing level ± 2
export const DAMAGE_RUNS = 15;       // newest runs that feed the damage measure
export const EXEC_RUNS = 8;          // newest runs that get tables/events
export const FACTS_TTL = 14 * 86_400_000;
export const FACTS_MAX = 400;
// bumped whenever the facts' shape changes: an older box is discarded whole
export const FACTS_VERSION = 2;

// WCL classID -> the class name lists.json and the store use
const CLASS_NAMES = { WARRIOR: "Warrior", PALADIN: "Paladin", HUNTER: "Hunter", ROGUE: "Rogue", PRIEST: "Priest", DEATHKNIGHT: "DeathKnight", SHAMAN: "Shaman", MAGE: "Mage", WARLOCK: "Warlock", MONK: "Monk", DRUID: "Druid", DEMONHUNTER: "DemonHunter", EVOKER: "Evoker" };
export const className = (classID) => CLASS_NAMES[classToken(classID)] ?? null;

// ------------------------------------------------------------ lists

let listsCache = null;
export async function loadLists({ url = "data/lists.json", fetchImpl = fetch, force = false } = {}) {
  if (listsCache && !force) return listsCache;
  try {
    const res = await fetchImpl(url, { cache: "default" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    listsCache = await res.json();
  } catch {
    listsCache = null;
  }
  return listsCache;
}
export function resetListsCache() { listsCache = null; }

// ------------------------------------------------------ facts cache

// Finished runs never change: per-run facts are kept for two weeks so a
// second lookup of the same applicant pulls nothing for runs already seen.
export function loadFacts(storage) {
  try {
    const box = JSON.parse(storage.getItem("kllRunFacts") || "null");
    if (box?.v === FACTS_VERSION && box.entries) return box.entries;
  } catch { /* start over */ }
  return {};
}
export function saveFacts(storage, entries, now) {
  const alive = Object.entries(entries)
    .filter(([, v]) => v && typeof v.t === "number" && now - v.t < FACTS_TTL)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, FACTS_MAX);
  try { storage.setItem("kllRunFacts", JSON.stringify({ v: FACTS_VERSION, entries: Object.fromEntries(alive) })); } catch { /* quota */ }
  return Object.fromEntries(alive);
}
export const factsKey = (code, fightID, name) => `${code}:${fightID}:${String(name).toLowerCase()}`;

// ----------------------------------------------------- window runs

// The applicant's runs in the role, at the listing level ± 2 (widened to
// −4…+3 when fewer than 3), applied spec only, newest first, deduplicated.
// result = an encounterRankings blob set (dps or hps); encounters = zone encounters.
export function windowRuns(result, encounters, role, level) {
  if (!result) return { runs: [], spec: null };
  const byId = new Map((encounters ?? []).map((e) => [e.id, e.name]));
  const all = [];
  const seen = new Set();
  for (const [alias, blob] of Object.entries(result)) {
    const m = /^e(\d+)$/.exec(alias);
    if (!m) continue;
    const encounterID = Number(m[1]);
    for (const r of blob?.ranks ?? []) {
      if (!r?.report?.code || !Number.isInteger(r.bracketData)) continue;
      if (roleOfSpec(r.spec) !== role) continue;
      const key = `${r.report.code}:${r.report.fightID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        code: r.report.code, fightID: r.report.fightID, encounterID, dungeon: byId.get(encounterID) ?? null,
        level: r.bracketData, start: typeof r.startTime === "number" ? r.startTime : 0, spec: r.spec ?? null,
        amount: typeof r.amount === "number" ? r.amount : null, keyPct: pickPercent(r),
        timed: r.medal === undefined || r.medal === null ? true : r.medal !== "none",
        duration: typeof r.duration === "number" ? r.duration : null,
      });
    }
  }
  all.sort((a, b) => b.start - a.start);
  const inWindow = (lo, hi) => (level ? all.filter((r) => r.level >= level - lo && r.level <= level + hi) : all);
  let runs = inWindow(WINDOW_SPREAD, WINDOW_SPREAD);
  if (runs.length < 3) runs = inWindow(4, 3);
  // applied spec = the spec they played most in the window
  const specCount = new Map();
  for (const r of runs) if (r.spec) specCount.set(r.spec, (specCount.get(r.spec) ?? 0) + 1);
  const spec = [...specCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { runs: spec ? runs.filter((r) => r.spec === spec) : runs, spec };
}

// A healer's HPS and DPS as plain numbers: the median amount over the
// window runs of the hps and the dps rankings. Shown beside the fit, never
// a measure. Null for every other role.
export function throughputFor(role, dpsWindow, hpsResult, encounters, level) {
  if (role !== "healer") return null;
  const med = (runs) => median(runs.map((r) => r.amount).filter((a) => typeof a === "number" && a > 0));
  return { hps: med(windowRuns(hpsResult, encounters, role, level).runs), dps: med(dpsWindow) };
}

// ------------------------------------------------------- normalize

function findSelf(actors, name) {
  const lower = String(name).toLowerCase();
  const hits = (actors ?? []).filter((a) => String(a.name).toLowerCase() === lower);
  return hits[0]?.id ?? null;
}

function playersFrom(bundle) {
  const out = [];
  const pd = bundle?.playerDetails;
  const roles = [["tanks", "tank"], ["healers", "healer"], ["dps", "dps"]];
  if (pd) {
    for (const [group, role] of roles) {
      for (const p of pd[group] ?? []) {
        const spec = p.specs?.[0]?.spec ?? (typeof p.specs?.[0] === "string" ? p.specs[0] : null);
        out.push({ id: p.id, name: p.name, cls: p.type, spec, role, server: p.server ?? null });
      }
    }
  }
  if (!out.length) {
    for (const a of bundle?.actors ?? []) out.push({ id: a.id, name: a.name, cls: a.subType, spec: null, role: "dps", server: a.server ?? null });
  }
  return out;
}

// Assemble the run object measures.js reads.
export function normalizeRun(w, { bundle, exec, selfId, cls, role }) {
  const fight = bundle?.fight ?? null;
  const players = playersFrom(bundle);
  const durationS = fight ? (fight.endTime - fight.startTime) / 1000 : (exec?.dur_s ?? (w.duration ? w.duration / 1000 : null));
  return {
    code: w.code, fightID: w.fightID, dungeon: w.dungeon, encounterID: w.encounterID, level: w.level, start: w.start,
    durationS, timed: w.timed, selfId, cls, spec: w.spec, role, players,
    fight: fight ? { startTime: fight.startTime, endTime: fight.endTime } : { startTime: 0, endTime: 0 },
    amount: w.amount, keyPct: w.keyPct,
    exec,
    events: bundle ? { ...bundle.events } : null,
  };
}

// ------------------------------------------------------- the driver

let storeSingleton = null;
export function runStore(opts) {
  if (!storeSingleton || opts?.force) storeSingleton = new RunStore(opts);
  return storeSingleton;
}

// Compute the fit for one applicant.
//   entry: { fullName, selected (role), player.class (token), region, hps (the hps rankings, healers) }
//   ctx: WCL ctx (token + endpoints); deps: { lists, baselines, store, storage, now, log, onPartial }
// Returns { state, assess, throughput, provenance, note }. When runs still
// have to be fetched, deps.onPartial first receives what the rankings
// alone say ({ state: "partial", ... }: the damage measure, a healer's
// HPS/DPS and every run already remembered), so a number is on screen
// before Warcraft Logs answers.
export async function assessEntry(entry, dpsResult, encounters, level, ctx, deps) {
  const now = deps.now ?? Date.now();
  const role = entry.selected ?? entry.detected ?? "dps";
  const cls = className(dpsResult?.classID);
  const name = entry.fullName.split("-")[0];
  const { runs: window, spec } = windowRuns(dpsResult, encounters, role, level);
  if (!window.length) return { state: "none", note: "no runs in the window" };
  const lists = deps.lists ?? null;
  const baselines = deps.baselines ?? null;
  const kit = kitFor(lists, cls, spec);
  const kickIds = new Set(kit.kick ? [kit.kick.id] : []);
  const kickNameOf = lists ? (c, s) => lists.specs?.[`${c}-${s}`]?.kick?.name ?? null : null;
  const throughput = throughputFor(role, window, entry.hps ?? null, encounters, level);
  const provenance = [];

  // 1. facts cache
  const storage = deps.storage;
  let cache = storage ? loadFacts(storage) : {};
  const exec = window.slice(0, EXEC_RUNS);
  const facts = new Map(); // key -> facts
  const todo = [];
  for (const w of exec) {
    const k = factsKey(w.code, w.fightID, name);
    const hit = cache[k];
    if (hit && now - hit.t < FACTS_TTL && hit.facts) { facts.set(k, hit.facts); provenance.push({ code: w.code, fightID: w.fightID, source: "cached" }); }
    else todo.push(w);
  }
  deps.debug?.(`facts: ${facts.size} cached, ${todo.length} to fetch (${todo.map((w) => `${w.code}:${w.fightID}`).join(",")}); keys=${Object.keys(cache).length}`);
  const assessNow = () => assess(orderedFacts(window, facts, name, { cls, role }), role, { baselines, priority: baselines?.priority ?? null, now });
  if (todo.length && deps.onPartial) {
    try { deps.onPartial({ state: "partial", assess: assessNow(), throughput, provenance: provenance.slice(), spec, role }); }
    catch (e) { deps.log?.(`partial fit: ${e.message}`); }
  }

  // 2. where does each run's table data come from? (one shard fetch per
  // distinct shard, all in flight together)
  const store = deps.store ?? runStore();
  const items = [];
  const looks = await Promise.all(todo.map((w) => store.lookup(w.code, w.fightID, w.start)));
  for (const [i, w] of todo.entries()) {
    const look = looks[i];
    const dangerous = new Set([...(baselines?.dangerousFor?.(w.dungeon) ?? []), ...(lists?.dungeons?.[w.dungeon]?.dangerous ?? []).map(Number)]);
    items.push({ code: w.code, fightID: w.fightID, w, look, kickIds, dangerousIds: dangerous, tables: look.status === "absent" });
    provenance.push({ code: w.code, fightID: w.fightID, source: look.status === "stored" ? "store" : look.status === "absent" ? "live" : "pending" });
  }

  // 3. events (and tables for absent runs), one run per request, all in flight together
  let bundles = [];
  if (items.length) {
    try {
      bundles = await fetchRunBundles(ctx, items);
    } catch (e) {
      deps.log?.(`execution data unavailable: ${e.message}`);
      return { state: "none", note: "execution data unavailable" };
    }
  }

  // 4. runs → facts (the kick's cooldown calibrated over everything we know)
  const newRuns = [];
  for (const p of bundles) {
    const w = p.w;
    const selfId = findSelf(p.bundle?.actors, name);
    const nameToId = (n) => findSelf(p.bundle?.actors, n);
    let execData = null;
    if (p.look.status === "stored") execData = execFromStoredRun(p.look.run, nameToId);
    else if (p.bundle?.tables) execData = execFromTables(p.bundle.tables, { kickNameOf });
    if (execData?.rows && selfId !== null && !execData.rows[selfId] && execData.rows[name]) execData.rows[selfId] = execData.rows[name];
    newRuns.push({ key: factsKey(w.code, w.fightID, name), run: normalizeRun(w, { bundle: p.bundle, exec: execData, selfId, cls, role }) });
  }
  const calib = mergeCastStats([
    ...[...facts.values()].map((f) => f.casts),
    ...newRuns.map(({ run }) => castStats(run, kickIds)),
  ]);
  for (const { key, run } of newRuns) {
    const dangerous = new Set([...(baselines?.dangerousFor?.(run.dungeon) ?? []), ...(lists?.dungeons?.[run.dungeon]?.dangerous ?? []).map(Number)]);
    const f = runFacts(run, { kit, calib: calib.minGap, dangerousIds: dangerous });
    facts.set(key, f);
    cache[key] = { t: now, facts: f };
  }
  // several applicants compute at once: merge into what is in storage NOW,
  // never overwrite it with this applicant's stale copy
  if (storage && newRuns.length) {
    const fresh = loadFacts(storage);
    for (const { key } of newRuns) fresh[key] = cache[key];
    cache = saveFacts(storage, fresh, now);
  }

  // 5. damage-only runs beyond the execution window still count for damage
  const result = assessNow();
  return { state: "ready", assess: result, throughput, provenance, spec, role };
}

// The facts the measures engine reads, newest first: a run's remembered
// facts when it has them, otherwise what the rankings alone say (damage).
function orderedFacts(window, facts, name, { cls, role }) {
  const ordered = [];
  for (const w of window.slice(0, DAMAGE_RUNS)) {
    const k = factsKey(w.code, w.fightID, name);
    const f = facts.get(k);
    if (f) ordered.push(f);
    else ordered.push({ v: 2, code: w.code, fightID: w.fightID, dungeon: w.dungeon, level: w.level, start: w.start, durationS: w.duration ? w.duration / 1000 : null, timed: w.timed, cls, spec: w.spec, role, amount: w.amount, keyPct: w.keyPct, players: [], own: null, dispel_spells: null, execSource: null, hasEvents: false, kicks: null, stops: null, casts: null });
  }
  return ordered;
}
