// measures.js — the "PUG-robust execution" measure set (Set B), as pure
// functions over one applicant's runs. Nothing here touches the network or
// the DOM; fit.js assembles the per-run inputs and render.js draws the
// results. See design/pug-measures.md for the reasoning behind every rule.
//
// Damage, kicks and stops for every role; healers also keep dispels. A
// stop is an enemy cast interrupted with anything that is not the spec's
// kick (a stun, a knock, an incapacitate, a silence). Everything else a run
// could say about the player is already reflected in the damage number.
//
// A run, as this module sees it (see normalizeRun in fit.js):
//   { code, fightID, dungeon, level, start, durationS, timed,
//     selfId, cls, spec, role, players: [{ id, name, cls, spec, role }],
//     fight: { startTime, endTime },
//     amount, keyPct,                       // encounterRankings dps + Key %
//     exec: {                               // per-player table numbers, from the
//       rows: { [actorId]: { dps, kicks, kicks_by, stops, dispels, dispels_by } },
//       dispel_spells: { [spellId]: { applied, dispelled, expired } },
//     } | null,                             // wowlogs run store, or live tables
//     events: {                             // live, only the vetting side pulls these
//       deaths, kickCasts, begin, interrupts,
//     } | null }

import { clamp, pctToZ, zToPct, weightedMedian, weightedQuantile, effectiveN, mean } from "./stats.js";

// ------------------------------------------------------------ the set

export const SET_B = {
  // weights per role, each row sums to 100 (design/pug-measures.md, revisions)
  weights: {
    dps:    { damage: 60, kicks: 25, stops: 15 },
    tank:   { damage: 40, kicks: 35, stops: 25 },
    healer: { damage: 15, kicks: 30, stops: 25, dispels: 30 },
  },
  // shrinkage toward the cell mean: z* = n·z̄ / (n + k)
  k: { damage: 1, kicks: 3, stops: 3, dispels: 3 },
  // runs before a measure is shown at all
  minRuns: { damage: 2, kicks: 4, stops: 4, dispels: 4 },
  // the composite needs this much of the role's weight present, and damage
  presentWeight: 60,
  // recency: half-life in days, weight floor
  halfLifeDays: 45,
  weightFloor: 0.2,
};

// --------------------------------------------------------- helpers

export function recencyWeight(startMs, nowMs = Date.now(), halfLife = SET_B.halfLifeDays, floor = SET_B.weightFloor) {
  if (typeof startMs !== "number" || startMs <= 0) return floor;
  const days = Math.max(0, (nowMs - startMs) / 86_400_000);
  return Math.max(floor, Math.pow(0.5, days / halfLife));
}

// z shrunk toward 0 (the cell mean) by the effective sample size
export function shrink(z, nEff, k) {
  if (z === null || !Number.isFinite(z)) return null;
  return (nEff * z) / (nEff + k);
}

// Every per-run measure value → one applicant-level z: recency-weighted
// median of the run percentiles, converted to z and shrunk.
function pooledZ(runPcts, weights, k) {
  const vals = [], ws = [];
  runPcts.forEach((p, i) => { if (Number.isFinite(p)) { vals.push(p); ws.push(weights[i]); } });
  if (!vals.length) return { z: null, n: 0, nEff: 0, pct: null };
  const med = weightedMedian(vals, ws);
  const nEff = effectiveN(ws);
  return { z: shrink(pctToZ(med), nEff, k), n: vals.length, nEff, pct: med };
}

// The spec's kick, with its base cooldown. lists = docs/data/lists.json.
// known = the spec has a list at all (a listed spec without a kick, such as
// a Holy Priest, makes every interrupt a stop).
export function kitFor(lists, cls, spec) {
  const s = lists?.specs?.[`${cls}-${spec}`] ?? null;
  return {
    role: s?.role ?? null,
    kick: s?.kick ? { id: Number(s.kick.id), name: s.kick.name, cd: s.kick.cd } : null,
    known: Boolean(s),
  };
}

// Observed minimum gap between casts of a spell across the applicant's
// runs: talents shorten most cooldowns, so the base value is an upper
// bound. calib: { [spellId]: seconds }.
export function calibrateCooldowns(runs, ids) {
  const minGap = {};
  const seen = new Set();
  for (const run of runs) {
    const casts = (run.events?.kickCasts ?? []).filter((e) => e.sourceID === run.selfId && e.type === "cast");
    const byId = new Map();
    for (const c of casts) {
      if (!ids.has(c.abilityGameID)) continue;
      seen.add(c.abilityGameID);
      const arr = byId.get(c.abilityGameID) ?? [];
      arr.push(c.timestamp);
      byId.set(c.abilityGameID, arr);
    }
    for (const [id, ts] of byId) {
      ts.sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) {
        const gap = (ts[i] - ts[i - 1]) / 1000;
        if (gap > 1 && (minGap[id] === undefined || gap < minGap[id])) minGap[id] = gap;
      }
    }
  }
  return { minGap, seen: [...seen] }; // an array: facts are cached as JSON
}

// ------------------------------------------------------------- kicks

// Kick utilisation on isolated opportunities: dangerous enemy casts that
// began while the applicant was alive with their kick off cooldown and no
// other dangerous cast within a second. A miss = such a cast that nobody
// interrupted.
export function kickUtilisation(run, kit, dangerousIds, calib) {
  if (!kit.kick || !run.events?.begin) return null;
  const self = run.selfId;
  const kickId = kit.kick.id;
  const cd = Math.min(kit.kick.cd ?? 15, calib?.[kickId] ?? Infinity);
  const casts = (run.events.kickCasts ?? []).filter((e) => e.sourceID === self && e.type === "cast" && e.abilityGameID === kickId).map((e) => e.timestamp).sort((a, b) => a - b);
  const kicksLanded = (run.events.interrupts ?? []).filter((e) => e.sourceID === self).length;
  const ownDeaths = (run.events.deaths ?? []).filter((d) => d.targetID === self).map((d) => d.timestamp);
  const begins = run.events.begin.filter((e) => e.type === "begincast" && dangerousIds.has(e.abilityGameID)).sort((a, b) => a.timestamp - b.timestamp);
  const completed = run.events.begin.filter((e) => e.type === "cast");
  const interrupts = run.events.interrupts ?? [];
  let opportunities = 0, misses = 0;
  for (let i = 0; i < begins.length; i++) {
    const b = begins[i];
    const t = b.timestamp;
    const alive = !ownDeaths.some((d) => t >= d && t - d <= 60_000);
    if (!alive) continue;
    const lastKick = casts.filter((c) => c < t).pop();
    if (lastKick !== undefined && (t - lastKick) / 1000 < cd) continue;
    const concurrent = begins.some((o, j) => j !== i && Math.abs(o.timestamp - t) <= 1000);
    if (concurrent) continue;
    opportunities++;
    const kicked = interrupts.some((k) => k.extraAbilityGameID === b.abilityGameID && k.timestamp >= t && k.timestamp - t <= 4000);
    const finished = completed.length
      ? completed.some((c) => c.abilityGameID === b.abilityGameID && c.sourceID === b.sourceID && c.timestamp >= t && c.timestamp - t <= 5000)
      : !kicked;
    if (!kicked && finished) misses++;
  }
  return { opportunities, misses, utilisation: opportunities ? 1 - misses / opportunities : null, kicksLanded, kicksPerMin: run.durationS ? kicksLanded / (run.durationS / 60) : null };
}

// ------------------------------------------------------------- stops

// The applicant's interrupts made with anything but the spec's kick, per
// minute. Events when the run has them (the interrupting ability's id is
// on the event), else the store row's `stops`; null when neither is known
// or the spec has no list (then the kick cannot be told apart).
export function stops(run, kit) {
  let n = null, source = null;
  if (run.events?.interrupts) {
    if (!kit?.known) return null;
    const kickId = kit.kick?.id ?? null;
    n = run.events.interrupts.filter((e) => e.sourceID === run.selfId && e.abilityGameID !== kickId).length;
    source = "events";
  } else {
    const row = ownRow(run);
    if (row && typeof row.stops === "number") { n = row.stops; source = "row"; }
  }
  if (n === null) return null;
  return { n, perMin: perMinute(n, run), source };
}

// -------------------------------------------------- table-based rates

export function ownRow(run) {
  return run.exec?.rows?.[run.selfId] ?? run.exec?.rows?.[String(run.selfId)] ?? null;
}

export function perMinute(value, run) {
  if (typeof value !== "number" || !run.durationS) return null;
  return value / (run.durationS / 60);
}

// Kicks weighted by how dangerous the population treats each cast
// (priority = interrupted ÷ begun, from the baselines sidecar).
export function kickPriorityPerMin(run, priority) {
  const row = ownRow(run);
  if (!row || row.kicks == null) return null;
  const by = row.kicks_by ?? null;
  if (!by || !priority) return perMinute(row.kicks, run);
  let sum = 0;
  for (const [id, n] of Object.entries(by)) {
    const p = priority[id];
    const w = p && p.begun > 0 ? p.interrupted / p.begun : 0.5;
    sum += w * n;
  }
  return perMinute(sum, run);
}

// ------------------------------------------------------------ damage

// Per-run damage percentile: the cell (timed runs) when the baseline has
// one, else the Key % the site already shows. Depleted runs only fall back
// to Key % and only count when fewer than 3 timed runs exist.
export function damagePercentiles(runs, baselines) {
  const out = [];
  for (const r of runs) {
    let pct = null, source = null;
    const cell = baselines?.cellFor?.(`${r.cls}-${r.spec}`, r.dungeon, r.level) ?? null;
    if (cell && r.timed !== false && Number.isFinite(r.amount)) {
      pct = baselines.percentile(cell, "dps", r.amount);
      source = `cell (${cell.tier}, n=${cell.n})`;
    }
    if (pct === null && Number.isFinite(r.keyPct)) { pct = r.keyPct; source = "Key %"; }
    out.push({ run: r, pct, source, timed: r.timed !== false });
  }
  const timed = out.filter((o) => o.timed && o.pct !== null);
  const use = timed.length >= 3 ? timed : out.filter((o) => o.pct !== null);
  return { all: out, used: use };
}

// Plus-minus: the applicant's percentile minus the mean of the other two
// DPS players' percentiles in the same run (same pulls, same pace).
export function plusMinus(runs, baselines) {
  const deltas = [];
  for (const r of runs) {
    const rows = r.exec?.rows;
    if (!rows || r.role !== "dps") continue;
    const cell = baselines?.cellFor?.(`${r.cls}-${r.spec}`, r.dungeon, r.level);
    if (!cell || !Number.isFinite(r.amount)) continue;
    const own = baselines.percentile(cell, "dps", r.amount);
    const others = r.players.filter((p) => p.id !== r.selfId && p.role === "dps").map((p) => {
      const row = rows[p.id] ?? rows[String(p.id)];
      const c = baselines.cellFor(`${p.cls}-${p.spec}`, r.dungeon, r.level);
      return row && c && Number.isFinite(row.dps) ? baselines.percentile(c, "dps", row.dps) : null;
    }).filter((x) => x !== null);
    if (own === null || others.length < 2) continue;
    deltas.push(own - mean(others));
  }
  if (!deltas.length) return { delta: null, n: 0 };
  const n = deltas.length;
  return { delta: (n * mean(deltas)) / (n + 3), n };
}

// Teammates who recur in ≥ 3 of the runs: share-of-group terms go off.
export function recurringTeammates(runs) {
  const count = new Map();
  for (const r of runs) {
    const seen = new Set();
    for (const p of r.players) {
      if (p.id === r.selfId) continue;
      const key = `${p.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return [...count.entries()].filter(([, c]) => c >= 3).map(([name]) => name);
}

// ----------------------------------------------- per-run facts

// Everything the applicant-level assessment needs from one run, small
// enough to cache for 14 days (a finished run never changes). Events are
// consumed here and never stored.
//   ctx: { kit, calib: { [spellId]: seconds }, dangerousIds: Set }
export function castStats(run, ids) {
  return calibrateCooldowns([run], ids);
}

export function mergeCastStats(list) {
  const minGap = {};
  const seen = new Set();
  for (const cs of list) {
    if (!cs) continue;
    for (const [id, g] of Object.entries(cs.minGap ?? {})) {
      if (minGap[id] === undefined || g < minGap[id]) minGap[id] = g;
    }
    for (const id of cs.seen ?? []) seen.add(Number(id));
  }
  return { minGap, seen };
}

export function runFacts(run, ctx = {}) {
  const kit = ctx.kit ?? kitFor(null);
  const own = ownRow(run);
  const players = (run.players ?? []).map((p) => {
    const row = run.exec?.rows?.[p.id] ?? run.exec?.rows?.[String(p.id)] ?? null;
    return { name: p.name, cls: p.cls, spec: p.spec, role: p.role, self: p.id === run.selfId, dps: row?.dps ?? null };
  });
  return {
    v: 2, code: run.code, fightID: run.fightID, dungeon: run.dungeon, level: run.level,
    start: run.start, durationS: run.durationS, timed: run.timed !== false,
    cls: run.cls, spec: run.spec, role: run.role, amount: run.amount ?? null, keyPct: run.keyPct ?? null,
    players,
    own: own ? { ...own } : null,
    dispel_spells: run.exec?.dispel_spells ?? null,
    execSource: run.exec?.source ?? (run.exec ? "live" : null),
    hasEvents: Boolean(run.events),
    kicks: kickUtilisation(run, kit, ctx.dangerousIds ?? new Set(), ctx.calib),
    stops: stops(run, kit),
    casts: castStats(run, new Set(kit.kick ? [kit.kick.id] : [])),
  };
}

// --------------------------------------------------------- assemble

function factsPlusMinus(facts, baselines) {
  const deltas = [];
  for (const f of facts) {
    if (f.role !== "dps") continue;
    const cell = baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level);
    if (!cell || !Number.isFinite(f.amount)) continue;
    const own = baselines.percentile(cell, "dps", f.amount);
    const others = f.players.filter((p) => !p.self && p.role === "dps" && Number.isFinite(p.dps)).map((p) => {
      const c = baselines.cellFor(`${p.cls}-${p.spec}`, f.dungeon, f.level);
      return c ? baselines.percentile(c, "dps", p.dps) : null;
    }).filter((x) => x !== null);
    if (own === null || others.length < 2) continue;
    deltas.push(own - mean(others));
  }
  if (!deltas.length) return { delta: null, n: 0 };
  const n = deltas.length;
  return { delta: (n * mean(deltas)) / (n + 3), n };
}

export function recurringFromFacts(facts) {
  const count = new Map();
  for (const f of facts) {
    const seen = new Set();
    for (const p of f.players) {
      if (p.self) continue;
      const key = String(p.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return [...count.entries()].filter(([, c]) => c >= 3).map(([name]) => name);
}

function kickPrioPerMinFromFacts(f, priority) {
  const row = f.own;
  if (!row || row.kicks == null) return null;
  const by = row.kicks_by ?? null;
  if (!by || !priority) return f.durationS ? row.kicks / (f.durationS / 60) : null;
  let sum = 0;
  for (const [id, n] of Object.entries(by)) {
    const p = priority[id];
    const w = p && p.begun > 0 ? p.interrupted / p.begun : 0.5;
    sum += w * n;
  }
  return f.durationS ? sum / (f.durationS / 60) : null;
}

// facts: runFacts() of the applicant's window runs. deps: { baselines,
// priority, now }. Returns every measure with its inputs and the composite.
export function assess(facts, role, deps = {}) {
  const now = deps.now ?? Date.now();
  const weights = SET_B.weights[role] ?? SET_B.weights.dps;
  const w = facts.map((f) => recencyWeight(f.start, now));
  const measures = {};
  // a recurring core only switches the share measures off: it says nothing
  // about the player
  const recurring = recurringFromFacts(facts);
  const perMin = (v, f) => (typeof v === "number" && f.durationS) ? v / (f.durationS / 60) : null;

  // damage
  {
    const dmg = facts.slice(0, 15);
    const runs = dmg.map((f) => {
      let pct = null, source = null;
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level) ?? null;
      if (cell && f.timed && Number.isFinite(f.amount)) { pct = deps.baselines.percentile(cell, "dps", f.amount); if (pct !== null) source = `cell (${cell.tier}, n=${cell.n})`; }
      if (pct === null && Number.isFinite(f.keyPct)) { pct = f.keyPct; source = "Key %"; }
      return { code: f.code, fightID: f.fightID, dungeon: f.dungeon, level: f.level, start: f.start, timed: f.timed, pct, source };
    });
    const timed = runs.filter((r) => r.timed && r.pct !== null);
    const used = timed.length >= 3 ? timed : runs.filter((r) => r.pct !== null);
    const pcts = used.map((r) => r.pct);
    const ws = used.map((r) => recencyWeight(r.start, now));
    let pct = pcts.length ? weightedMedian(pcts, ws) : null;
    let nEff = effectiveN(ws);
    let pm = { delta: null, n: 0 };
    if (!recurring.length && role === "dps") {
      pm = factsPlusMinus(dmg, deps.baselines);
      if (pm.delta !== null && pct !== null) pct = clamp(pct + 0.25 * pm.delta, 2, 98);
    }
    if (recurring.length) nEff *= 0.6;
    measures.damage = {
      n: used.length, nEff, pct, plusMinus: pm, runs,
      z: used.length >= SET_B.minRuns.damage && pct !== null ? shrink(pctToZ(pct), nEff, SET_B.k.damage) : null,
      floor: used.length >= 8 ? weightedQuantile(pcts, ws, 0.25) : null,
    };
  }

  // kicks: utilisation from events when there is enough of it, else the
  // priority-weighted rate against the cell
  {
    const util = [], utilW = [], rate = [], rateW = [];
    facts.forEach((f, i) => {
      const u = f.kicks;
      if (u && u.utilisation !== null && u.utilisation !== undefined && u.opportunities >= 2) { util.push(u.utilisation); utilW.push(w[i]); }
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level, "kick_prio");
      const v = kickPrioPerMinFromFacts(f, deps.priority?.[f.dungeon]);
      if (cell && v !== null) { const p = deps.baselines.percentile(cell, "kick_prio", v); if (p !== null) { rate.push(p); rateW.push(w[i]); } }
    });
    let z = null, n = 0, pct = null, mode = null;
    if (util.length >= SET_B.minRuns.kicks) {
      const med = weightedMedian(util, utilW);
      pct = clamp(50 + (med - 0.75) * 160, 2, 98); // 75 % of isolated chances taken = the middle
      n = util.length; mode = "utilisation";
      z = shrink(pctToZ(pct), effectiveN(utilW), SET_B.k.kicks);
    } else if (rate.length >= SET_B.minRuns.kicks) {
      const pooled = pooledZ(rate, rateW, SET_B.k.kicks);
      z = pooled.z; n = pooled.n; pct = pooled.pct; mode = "priority-weighted rate";
    } else {
      n = Math.max(util.length, rate.length);
    }
    const kicksPerMin = facts.map((f) => f.kicks?.kicksPerMin).filter((x) => typeof x === "number");
    measures.kicks = { n, z, pct, mode, kicksPerMin: kicksPerMin.length ? weightedQuantile(kicksPerMin, null, 0.5) : null };
  }

  // stops: own non-kick interrupts per minute vs the cell (high = good)
  {
    const pcts = [], pw = [];
    facts.forEach((f, i) => {
      const v = f.stops?.perMin;
      if (typeof v !== "number") return;
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level, "stops_min");
      if (!cell) return;
      const p = deps.baselines.percentile(cell, "stops_min", v);
      if (p !== null) { pcts.push(p); pw.push(w[i]); }
    });
    const pooled = pcts.length >= SET_B.minRuns.stops ? pooledZ(pcts, pw, SET_B.k.stops) : { z: null, n: pcts.length, pct: null };
    const stopsPerMin = facts.map((f) => f.stops?.perMin).filter((x) => typeof x === "number");
    measures.stops = { n: pcts.length, z: pooled.z, pct: pooled.pct, stopsPerMin: stopsPerMin.length ? weightedQuantile(stopsPerMin, null, 0.5) : null };
  }

  // healers: own dispels per minute vs the cell, blended half and half
  // with the share of dispellable debuffs that did not expire
  if (role === "healer") {
    const pcts = [], pw = [], missed = [];
    facts.forEach((f, i) => {
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level, "dispels_min");
      if (f.own && f.own.dispels != null && cell) {
        const p = deps.baselines.percentile(cell, "dispels_min", perMin(f.own.dispels, f));
        if (p !== null) { pcts.push(p); pw.push(w[i]); }
      }
      const sp = f.dispel_spells;
      if (sp) {
        let applied = 0, expired = 0;
        for (const s of Object.values(sp)) { applied += s.applied ?? 0; expired += s.expired ?? 0; }
        if (applied) missed.push(expired / applied);
      }
    });
    let z = null, pct = null;
    const missedShare = missed.length ? mean(missed) : null;
    if (pcts.length >= SET_B.minRuns.dispels) {
      const own = pooledZ(pcts, pw, SET_B.k.dispels);
      pct = own.pct; z = own.z;
      if (missedShare !== null) {
        const mp = clamp(100 * (1 - missedShare), 2, 98);
        z = 0.5 * own.z + 0.5 * shrink(pctToZ(mp), own.nEff, SET_B.k.dispels);
        pct = 0.5 * own.pct + 0.5 * mp;
      }
    }
    measures.dispels = { n: pcts.length, z, pct, missedShare };
  }

  // composite
  let sumW = 0, sumWZ = 0;
  const present = [], missing = [];
  for (const [name, weight] of Object.entries(weights)) {
    const m = measures[name];
    if (m && m.z !== null && m.z !== undefined) { sumW += weight; sumWZ += weight * m.z; present.push(name); }
    else missing.push(name);
  }
  let composite = null;
  if (sumW >= SET_B.presentWeight && present.includes("damage")) {
    const z = sumWZ / sumW;
    const pct = zToPct(z);
    composite = { z, pct: clamp(pct, 1, 99), presentWeight: sumW, nEff: measures.damage.nEff };
  }
  return { role, runs: facts.length, measures, composite, present, missing, weights };
}
