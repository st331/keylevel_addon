// measures.js — the "PUG-robust execution" measure set (Set B), as pure
// functions over one applicant's runs. Nothing here touches the network or
// the DOM; app.js assembles the per-run inputs and render.js draws the
// results. See design/pug-measures.md for the reasoning behind every rule.
//
// A run, as this module sees it (see normalizeRun in app.js):
//   { code, fightID, dungeon, level, start, durationS, timed,
//     selfId, cls, spec, role, players: [{ id, name, cls, spec, role }],
//     fight: { startTime, endTime },
//     amount, keyPct,                       // encounterRankings dps + Key %
//     exec: {                               // per-player table numbers, from the
//       rows: { [actorId]: { dps, deaths, deaths_chain, pots, hs, kicks, kicks_by,
//                            dispels, dispels_by, avoid_dmg, def_casts, heal_total, heal_over } },
//       int_spells: { [spellId]: { begun, completed, interrupted } },
//       dispel_spells: { [spellId]: { applied, dispelled, expired } },
//     } | null,                             // wowlogs run store, or live tables
//     events: {                             // live, only the vetting side pulls these
//       deaths, low35, kitCasts, begin, interrupts, windows: { [i]: { dmg, heal } },
//       healerHeal, healerCasts,
//     } | null }

import { clamp, phi, phiInv, pctToZ, zToPct, weightedMedian, weightedQuantile, effectiveN, mean } from "./stats.js";

// ------------------------------------------------------------ the set

export const SET_B = {
  // weights per role, each column sums to 100 (design/pug-measures.md §2)
  weights: {
    dps:    { damage: 50, kicks: 18, selfsave: 10, deaths: 10, avoidable: 12 },
    healer: { damage: 10, kicks: 10, selfsave: 6, deaths: 8, avoidable: 8, triage: 36, dispels: 22 },
    tank:   { damage: 30, kicks: 20, selfsave: 20, deaths: 16, avoidable: 14 },
  },
  // shrinkage toward the cell mean: z* = n·z̄ / (n + k)
  k: { damage: 1, kicks: 3, selfsave: 2, avoidable: 2.5, triage: 2, dispels: 3 },
  // runs (or episodes) before a measure is shown at all
  minRuns: { damage: 2, kicks: 4, selfsave: 3, deaths: 2, avoidable: 4, triage: 3, dispels: 4 },
  // the composite needs this much of the role's weight present, and damage
  presentWeight: 60,
  // recency: half-life in days, weight floor
  halfLifeDays: 45,
  weightFloor: 0.2,
};

export const DEATH_COST = { chain: 0.10, oneshot: 0.25, duress: 0.15, solo: 1.00, unclear: 0.25 };
export const DEATH_COST_TABLES_ONLY = { chain: 0.10, other: 0.30 };
export const RUN_DEATH_CAP = 2.0;
export const BEACON_OF_LIGHT = 53652;

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

const hpFrac = (e) => (e && e.maxHitPoints > 0 && typeof e.hitPoints === "number") ? e.hitPoints / e.maxHitPoints : null;
const dist = (a, b) => (a && b && typeof a.x === "number" && typeof b.x === "number")
  ? Math.hypot(a.x - b.x, a.y - b.y) / 100 : null; // map units are yards × 100

// buffs on a damage event come as "id.id.id." — the auras active on the target
export function buffIds(e) {
  if (!e?.buffs || typeof e.buffs !== "string") return new Set();
  return new Set(e.buffs.split(".").filter(Boolean).map(Number));
}

// The spells an applicant of this class/spec can press to save themselves,
// with base cooldowns. lists = docs/data/lists.json.
export function kitFor(lists, cls, spec) {
  const s = lists?.specs?.[`${cls}-${spec}`] ?? null;
  const cons = lists?.consumables ?? {};
  const kit = new Map(); // id -> { name, cd, kind, baseline }
  for (const d of s?.defensives ?? []) kit.set(Number(d.id), { name: d.name, cd: d.cd, kind: "defensive", baseline: d.baseline !== false });
  for (const d of s?.selfheals ?? []) kit.set(Number(d.id), { name: d.name, cd: d.cd ?? 0, kind: "selfheal", baseline: d.baseline !== false });
  if (cons.healthstone) kit.set(Number(cons.healthstone), { name: "Healthstone", cd: 60, kind: "consumable", baseline: true });
  for (const id of cons.healing_potion ?? []) kit.set(Number(id), { name: "Healing Potion", cd: 300, kind: "consumable", baseline: true });
  return {
    role: s?.role ?? null,
    kick: s?.kick ? { id: Number(s.kick.id), name: s.kick.name, cd: s.kick.cd } : null,
    kit,
    activeMitigation: (s?.active_mitigation ?? []).map((a) => Number(a.buff_id ?? a.id)),
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
    const casts = (run.events?.kitCasts ?? []).filter((e) => e.sourceID === run.selfId && e.type === "cast");
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

// ------------------------------------------------------------ deaths

// One own death classified from its ±10 s window of party events.
export function classifyDeath(run, death, ctx) {
  const t = death.timestamp;
  const self = run.selfId;
  const out = { t, rel: (t - run.fight.startTime) / 1000, killerID: death.killerID, ability: death.killingAbilityGameID, cls: "unclear", cost: DEATH_COST.unclear, reasons: [], warnS: null, hpBefore: null, available: [] };
  const deaths = run.events?.deaths ?? [];
  const others = deaths.filter((d) => d.targetID !== self);

  // chain: someone else died in the prior 5 s, or two are already down
  const priorOther = others.filter((d) => d.timestamp < t && t - d.timestamp <= 5000);
  const alreadyDown = others.filter((d) => d.timestamp < t && t - d.timestamp <= 60_000);
  if (priorOther.length > 0 || alreadyDown.length >= 2) {
    out.cls = "chain"; out.cost = DEATH_COST.chain;
    out.reasons.push(priorOther.length ? `${priorOther.length} party death(s) in the prior 5 s` : "two party members already down");
    return out;
  }

  const win = ctx?.window;
  if (!win) { out.reasons.push("no event window"); return out; }
  const dmg = win.dmg ?? [], heal = win.heal ?? [];
  const samplesFor = (id) => [...dmg.filter((e) => e.targetID === id && hpFrac(e) !== null), ...heal.filter((e) => e.targetID === id && hpFrac(e) !== null)]
    .sort((a, b) => a.timestamp - b.timestamp);
  const own = samplesFor(self).filter((e) => e.timestamp <= t);

  // HP a second before, and how long the sub-35 % stretch lasted
  const before = own.filter((e) => e.timestamp <= t - 1000);
  out.hpBefore = before.length ? hpFrac(before[before.length - 1]) : null;
  // the warning: from the first sub-35 % sample in the last 10 s, unless
  // the player genuinely recovered (≥ 70 %) in between
  let firstLow = null;
  for (const e of own) {
    if (e.timestamp < t - 10_000) continue;
    const f = hpFrac(e);
    if (f >= 0.7) firstLow = null;
    else if (f < 0.35 && firstLow === null) firstLow = e.timestamp;
  }
  out.warnS = firstLow !== null ? (t - firstLow) / 1000 : 0;
  if ((out.hpBefore !== null && out.hpBefore >= 0.8) || out.warnS < 1.5) {
    out.cls = "oneshot"; out.cost = DEATH_COST.oneshot;
    out.reasons.push(out.hpBefore !== null && out.hpBefore >= 0.8 ? `${Math.round(out.hpBefore * 100)} % HP one second before` : `${out.warnS.toFixed(1)} s below 35 %`);
    return out;
  }

  // shared duress: the healer could not act, or the group was collapsing
  const healerId = run.healerId ?? run.players.find((p) => p.role === "healer")?.id ?? null;
  const t0 = t - 5000;
  const duress = [];
  if (healerId !== null && healerId !== self) {
    // dead = died in the last minute and has not healed anyone since (a
    // healer who died 17 minutes ago and got a battle rez is alive)
    const lastHealerDeath = deaths.filter((d) => d.targetID === healerId && d.timestamp <= t).map((d) => d.timestamp).pop();
    if (lastHealerDeath !== undefined && t - lastHealerDeath <= 60_000
        && !heal.some((e) => e.sourceID === healerId && e.timestamp > lastHealerDeath && e.timestamp <= t)) {
      duress.push("healer dead");
    }
    const healerSamples = [...dmg, ...heal].filter((e) => e.targetID === healerId && e.timestamp >= t - 10_000 && e.timestamp <= t).sort((a, b) => a.timestamp - b.timestamp);
    const lastH = healerSamples[healerSamples.length - 1];
    const mana = healerSamples.map((e) => e.classResources?.[0]).filter((r) => r && r.type === 0 && r.max > 0).pop();
    if (mana && mana.amount / mana.max < 0.15) duress.push("healer out of mana");
    const hf = hpFrac(lastH);
    if (hf !== null && hf < 0.4) duress.push("healer below 40 %");
    const ownLast = own[own.length - 1];
    const d = dist(lastH, ownLast);
    if (d !== null && d > 40) duress.push(`healer ${Math.round(d)} yd away`);
    const healed = heal.some((e) => e.type === "heal" && e.sourceID === healerId && e.targetID === self && e.timestamp >= t0 && e.timestamp <= t);
    if (!healed) duress.push("no direct heal in the last 5 s");
  }
  const othersLow = run.players.filter((p) => p.id !== self).filter((p) => {
    const s = samplesFor(p.id).filter((e) => e.timestamp >= t0 && e.timestamp <= t);
    return s.some((e) => hpFrac(e) < 0.4);
  });
  if (othersLow.length >= 2) duress.push(`${othersLow.length} others below 40 %`);
  if (duress.length) {
    out.cls = "duress"; out.cost = DEATH_COST.duress; out.reasons = duress;
    return out;
  }

  // solo-avoidable: warning ≥ 1.5 s and a save button available but unused
  const kit = ctx?.kit;
  if (kit?.kit?.size) {
    const casts = (run.events?.kitCasts ?? []).filter((e) => e.sourceID === self && e.type === "cast");
    const usedRecently = casts.some((e) => kit.kit.has(e.abilityGameID) && e.timestamp >= t - 10_000 && e.timestamp <= t);
    for (const [id, spell] of kit.kit) {
      if (!spell.baseline && !seenHas(ctx?.seen, id)) continue; // talent spell never seen: assume untalented
      const last = casts.filter((e) => e.abilityGameID === id && e.timestamp < t).pop();
      const cd = Math.min(spell.cd ?? 0, ctx?.calib?.[id] ?? Infinity);
      if (!last || (t - last.timestamp) / 1000 >= cd) out.available.push(spell.name);
    }
    if (out.available.length && !usedRecently) {
      out.cls = "solo"; out.cost = DEATH_COST.solo;
      out.reasons.push(`${out.warnS.toFixed(1)} s of warning, ${out.available.slice(0, 3).join(", ")} available and unused`);
      return out;
    }
    out.reasons.push(out.available.length ? "a save was pressed" : "nothing available");
  } else {
    out.reasons.push("no kit list for this spec");
  }
  return out;
}

// All own deaths of one run → classified list (events) or tables-only costs.
export function classifyRunDeaths(run, ctx) {
  const self = run.selfId;
  if (run.events?.deaths) {
    const own = run.events.deaths.filter((d) => d.targetID === self).sort((a, b) => a.timestamp - b.timestamp);
    return own.map((d, i) => classifyDeath(run, d, { ...ctx, window: run.events.windows?.[i] ?? run.events.windows?.[String(i)] ?? null }));
  }
  // tables only: death timestamps from the Summary's deathEvents (all party)
  const table = run.exec?.death_events ?? null;
  if (!table) return null;
  const all = table.slice().sort((a, b) => a.deathTime - b.deathTime);
  return all.filter((d) => d.id === self).map((d) => {
    const chain = all.some((o) => o.id !== self && o.deathTime < d.deathTime && d.deathTime - o.deathTime <= 5000);
    return { rel: d.deathTime / 1000, ability: d.ability?.guid ?? null, cls: chain ? "chain" : "unclassified", cost: chain ? DEATH_COST_TABLES_ONLY.chain : DEATH_COST_TABLES_ONLY.other, reasons: [chain ? "party death in the prior 5 s" : "no event window (tables only)"], available: [] };
  });
}

// Pool a window of runs' death costs into the allowance rule.
// perRun: [{ deaths: [classified...] }] — one per run in the window.
export function deathAllowance(perRun) {
  const n = perRun.length;
  let W = 0;
  let runsWithSolo = 0;
  const causes = new Map();
  for (const r of perRun) {
    const costs = (r.deaths ?? []).map((d) => d.cost);
    W += Math.min(RUN_DEATH_CAP, costs.reduce((a, b) => a + b, 0));
    if ((r.deaths ?? []).some((d) => d.cls === "solo")) runsWithSolo++;
    for (const d of r.deaths ?? []) {
      if (d.ability && d.ability !== 1) causes.set(d.ability, (causes.get(d.ability) ?? 0) + 1);
    }
  }
  const allowance = 1 + 0.25 * n;
  const excess = Math.max(0, W - allowance);
  const loss01 = Math.min(1, excess / 3);
  const sameCause = [...causes.entries()].filter(([, c]) => c >= 2).map(([id]) => id);
  return { n, W: Math.round(W * 100) / 100, allowance, excess: Math.round(excess * 100) / 100, loss01, repeated: runsWithSolo >= 2, sameCause };
}

// --------------------------------------------------------- self-save

// Episodes of the applicant below 35 % HP, and whether they pressed
// something. episode = ≥ 2 sub-35 % hits ≥ 1.5 s apart within 8 s.
export function selfSave(run, kit) {
  if (run.spec === "Blood") return { excluded: "Blood DK lives below 35 %" };
  const self = run.selfId;
  const lows = (run.events?.low35 ?? []).filter((e) => e.targetID === self && hpFrac(e) !== null && hpFrac(e) < 0.35).sort((a, b) => a.timestamp - b.timestamp);
  if (!run.events?.low35) return null;
  const casts = (run.events?.kitCasts ?? []).filter((e) => e.sourceID === self && e.type === "cast" && kit.kit.has(e.abilityGameID));
  const episodes = [];
  let cur = null;
  for (const e of lows) {
    if (cur && e.timestamp - cur.last <= 8000) { cur.last = e.timestamp; cur.hits++; }
    else { cur = { first: e.timestamp, last: e.timestamp, hits: 1, firstEvent: e }; episodes.push(cur); }
  }
  const real = episodes.filter((ep) => ep.hits >= 2 && ep.last - ep.first >= 1500);
  let answered = 0;
  for (const ep of real) {
    const pressed = casts.some((c) => c.timestamp >= ep.first - 3000 && c.timestamp <= ep.first + 3000);
    const active = [...buffIds(ep.firstEvent)].some((id) => kit.kit.has(id) && kit.kit.get(id).kind === "defensive");
    ep.answered = pressed || active;
    if (ep.answered) answered++;
  }
  return { episodes: real.length, answered, rate: real.length ? answered / real.length : null };
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
  const casts = (run.events.kitCasts ?? []).filter((e) => e.sourceID === self && e.type === "cast" && e.abilityGameID === kickId).map((e) => e.timestamp).sort((a, b) => a - b);
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

// ------------------------------------------------------------ triage

// Healer: how fast does a direct heal land on an ally who dropped below
// 35 %? Isolated episodes only (nobody else was already low).
export function triage(run) {
  const healer = run.selfId;
  const heal = run.events?.healerHeal;
  const lows = run.events?.low35;
  if (!heal || !lows) return null;
  const allyLows = lows.filter((e) => e.targetID !== healer && hpFrac(e) !== null && hpFrac(e) < 0.35 && run.players.some((p) => p.id === e.targetID)).sort((a, b) => a.timestamp - b.timestamp);
  const heals = heal.filter((e) => e.type === "heal" && e.sourceID === healer && e.abilityGameID !== BEACON_OF_LIGHT).sort((a, b) => a.timestamp - b.timestamp);
  const deaths = run.events?.deaths ?? [];
  const episodes = [];
  const open = new Map(); // targetID -> episode
  for (const e of allyLows) {
    const cur = open.get(e.targetID);
    if (cur && e.timestamp - cur.last <= 5000) { cur.last = e.timestamp; continue; }
    // does this ally recover (a heal lands with post-heal HP ≥ 35 %) before 5 s?
    const ep = { target: e.targetID, start: e.timestamp, last: e.timestamp, isolated: true, latency: null, output: false };
    for (const [id, o] of open) { if (id !== e.targetID && e.timestamp - o.last <= 5000) ep.isolated = false; }
    const end = Math.min(e.timestamp + 5000, ...deaths.filter((d) => d.targetID === e.targetID && d.timestamp >= e.timestamp).map((d) => d.timestamp));
    const first = heals.find((h) => h.targetID === e.targetID && h.timestamp >= e.timestamp && h.timestamp <= end);
    if (first) { ep.output = true; ep.latency = (first.timestamp - e.timestamp) / 1000; }
    episodes.push(ep);
    open.set(e.targetID, ep);
  }
  const iso = episodes.filter((ep) => ep.isolated);
  const lat = iso.filter((ep) => ep.output).map((ep) => ep.latency);
  const minutes = run.durationS ? run.durationS / 60 : null;
  return {
    episodes: episodes.length, isolated: iso.length,
    median: lat.length ? weightedQuantile(lat, null, 0.5) : null,
    p90: lat.length ? weightedQuantile(lat, null, 0.9) : null,
    noOutputShare: iso.length ? iso.filter((ep) => !ep.output).length / iso.length : null,
    perMin: minutes ? episodes.length / minutes : null,
  };
}

// Absolute reference (a timed +22: median 0.55 s, p90 1.7 s): 0..1 score.
export function triageScore(tr) {
  if (!tr || tr.median === null || tr.noOutputShare === null) return null;
  const lat = clamp(1 - (tr.median - 0.5) / 1.5, 0, 1);
  const out = clamp(1 - (tr.noOutputShare - 0.15) / 0.45, 0, 1);
  return 0.6 * lat + 0.4 * out;
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

export function dispelMissedShare(run) {
  const sp = run.exec?.dispel_spells;
  if (!sp) return null;
  let applied = 0, expired = 0;
  for (const s of Object.values(sp)) { applied += s.applied ?? 0; expired += s.expired ?? 0; }
  return applied ? expired / applied : null;
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
//   ctx: { kit, calib: { [spellId]: seconds }, seen: Set<spellId>, dangerousIds: Set }
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

// accept a Set or an array of ids
const seenHas = (seen, id) => (seen instanceof Set ? seen.has(id) : Array.isArray(seen) ? seen.includes(id) : false);

export function runFacts(run, ctx = {}) {
  const kit = ctx.kit ?? kitFor(null);
  const own = ownRow(run);
  const players = (run.players ?? []).map((p) => {
    const row = run.exec?.rows?.[p.id] ?? run.exec?.rows?.[String(p.id)] ?? null;
    return { name: p.name, cls: p.cls, spec: p.spec, role: p.role, self: p.id === run.selfId, dps: row?.dps ?? null };
  });
  const tr = run.role === "healer" ? triage(run) : null;
  return {
    v: 1, code: run.code, fightID: run.fightID, dungeon: run.dungeon, level: run.level,
    start: run.start, durationS: run.durationS, timed: run.timed !== false,
    cls: run.cls, spec: run.spec, role: run.role, amount: run.amount ?? null, keyPct: run.keyPct ?? null,
    players,
    own: own ? { ...own } : null,
    dispel_spells: run.exec?.dispel_spells ?? null,
    execSource: run.exec?.source ?? (run.exec ? "live" : null),
    hasEvents: Boolean(run.events),
    deaths: classifyRunDeaths(run, { kit, calib: ctx.calib, seen: ctx.seen }),
    selfsave: selfSave(run, kit),
    kicks: kickUtilisation(run, kit, ctx.dangerousIds ?? new Set(), ctx.calib),
    triage: tr,
    triageScore: triageScore(tr),
    casts: castStats(run, new Set([...kit.kit.keys(), ...(kit.kick ? [kit.kick.id] : [])])),
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
  const flags = [];
  const recurring = recurringFromFacts(facts);
  if (recurring.length) flags.push({ kind: "recurring", text: `plays with ${recurring.length} recurring teammate(s): share measures off` });
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
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level);
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

  // self-save
  {
    const rates = [], rw = [];
    let episodes = 0, excluded = null;
    facts.forEach((f, i) => {
      const s = f.selfsave;
      if (s?.excluded) { excluded = s.excluded; return; }
      if (s && s.rate !== null && s.rate !== undefined) { rates.push(s.rate); rw.push(w[i]); episodes += s.episodes; }
    });
    let z = null, pct = null;
    if (!excluded && episodes >= 4 && rates.length >= 2) {
      const med = weightedMedian(rates, rw);
      pct = clamp(50 + (med - 0.6) * 120, 2, 98); // 60 % answered = the middle
      z = shrink(pctToZ(pct), effectiveN(rw), SET_B.k.selfsave);
    }
    measures.selfsave = { n: rates.length, episodes, z, pct, excluded };
  }

  // deaths
  {
    const known = facts.filter((f) => f.deaths !== null).map((f) => ({ code: f.code, fightID: f.fightID, dungeon: f.dungeon, level: f.level, start: f.start, deaths: f.deaths }));
    const allowance = deathAllowance(known);
    const z = known.length >= SET_B.minRuns.deaths ? -2 * allowance.loss01 : null;
    if (allowance.repeated) flags.push({ kind: "deaths", text: "repeated own-fault deaths" });
    if (allowance.sameCause.length) flags.push({ kind: "deaths", text: "died to the same ability more than once" });
    measures.deaths = { n: known.length, z, ...allowance, perRun: known };
  }

  // avoidable damage per minute vs cell (low = good)
  {
    const pcts = [], pw = [];
    facts.forEach((f, i) => {
      if (!f.own || f.own.avoid_dmg == null) return;
      const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level);
      if (!cell) return;
      const p = deps.baselines.percentile(cell, "avoid_dmg_min", perMin(f.own.avoid_dmg, f));
      if (p !== null) { pcts.push(p); pw.push(w[i]); }
    });
    const pooled = pcts.length >= SET_B.minRuns.avoidable ? pooledZ(pcts, pw, SET_B.k.avoidable) : { z: null, n: pcts.length, pct: null };
    measures.avoidable = { n: pcts.length, z: pooled.z, pct: pooled.pct };
  }

  if (role === "healer") {
    {
      const scores = [], sw = [], medians = [];
      let episodes = 0;
      facts.forEach((f, i) => {
        if (f.triageScore !== null && f.triageScore !== undefined) { scores.push(f.triageScore); sw.push(w[i]); episodes += f.triage?.isolated ?? 0; if (f.triage?.median !== null) medians.push(f.triage.median); }
      });
      let z = null, pct = null;
      if (scores.length >= SET_B.minRuns.triage) {
        pct = clamp(weightedMedian(scores, sw) * 100, 2, 98);
        z = shrink(pctToZ(pct), effectiveN(sw), SET_B.k.triage);
      }
      measures.triage = { n: scores.length, episodes, z, pct, medianLatency: medians.length ? weightedQuantile(medians, null, 0.5) : null };
    }
    {
      const pcts = [], pw = [], missed = [];
      facts.forEach((f, i) => {
        const cell = deps.baselines?.cellFor?.(`${f.cls}-${f.spec}`, f.dungeon, f.level);
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
  }

  // potions gate
  {
    const known = facts.map((f) => f.own?.pots).filter((p) => typeof p === "number");
    if (known.length >= 3) {
      const share = known.filter((p) => p >= 1).length / known.length;
      measures.potions = { n: known.length, share, pass: share >= 0.6 };
      if (!measures.potions.pass) flags.push({ kind: "potions", text: `potion in only ${Math.round(share * 100)} % of logged runs` });
    }
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
    let pct = zToPct(z);
    if (measures.potions && !measures.potions.pass) pct -= 3;
    composite = { z, pct: clamp(pct, 1, 99), presentWeight: sumW, nEff: measures.damage.nEff };
  }
  return { role, runs: facts.length, measures, composite, present, missing, flags, weights };
}
