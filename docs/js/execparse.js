// execparse.js — turn the six per-run Warcraft Logs tables into the `exec`
// shape measures.js reads (the same shape the wowlogs run store publishes,
// see design/baselines-from-wowlogs.md §3–4). Used only for runs the store
// will never hold; the parsing rules mirror the collector's.

function entriesOf(table) {
  const d = table?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.entries)) return d.entries;
  return [];
}

// Interrupts and Dispels tables wrap their rows one level deeper:
// data.entries[0].entries[] = one row per enemy spell / debuff.
function spellRows(table) {
  const groups = entriesOf(table);
  const out = [];
  for (const g of groups) for (const row of g?.entries ?? []) out.push(row);
  return out;
}

// per-player totals from one spell-keyed table: { [actorId]: { total, by: { [spellId]: n } } }
function perPlayerFromSpells(rows) {
  const per = {};
  const spells = {};
  for (const row of rows) {
    const guid = Number(row.guid);
    spells[guid] = { name: row.name, begun: row.spellsBegun ?? 0, completed: row.spellsCompleted ?? 0, interrupted: row.spellsInterrupted ?? 0 };
    for (const d of row.details ?? []) {
      const id = d.id;
      if (id === undefined || id === null) continue;
      per[id] ??= { total: 0, by: {} };
      per[id].total += d.total ?? 0;
      per[id].by[guid] = (per[id].by[guid] ?? 0) + (d.total ?? 0);
    }
  }
  return { per, spells };
}

// Summary → composition, dps, deaths, consumables
export function parseSummary(table) {
  const d = table?.data;
  if (!d || typeof d !== "object") return null;
  const players = [];
  const byId = {};
  for (const [group, role] of [["tanks", "tank"], ["healers", "healer"], ["dps", "dps"]]) {
    for (const p of d.playerDetails?.[group] ?? []) {
      const spec = p.specs?.[0]?.spec ?? p.specs?.[0] ?? null;
      const row = { id: p.id, name: p.name, cls: p.type, spec: typeof spec === "string" ? spec : spec?.spec ?? null, role, server: p.server ?? null, region: p.region ?? null,
        pots: typeof p.potionUse === "number" ? p.potionUse : null, hs: typeof p.healthstoneUse === "number" ? p.healthstoneUse : null };
      players.push(row);
      byId[p.id] = row;
    }
  }
  // composition carries roles when playerDetails is thin
  for (const c of d.composition ?? []) {
    if (byId[c.id]) continue;
    const s = c.specs?.[0];
    const row = { id: c.id, name: c.name, cls: c.type, spec: s?.spec ?? null, role: s?.role ?? "dps", pots: null, hs: null };
    players.push(row); byId[c.id] = row;
  }
  const dps = {};
  for (const e of d.damageDone ?? []) dps[e.id] = e.total ?? 0;
  const healing = {};
  for (const e of d.healingDone ?? []) healing[e.id] = e.total ?? 0;
  const deaths = (d.deathEvents ?? []).map((e) => ({ id: e.id, deathTime: e.deathTime, ability: e.ability ? { guid: e.ability.guid, name: e.ability.name } : null }))
    .sort((a, b) => a.deathTime - b.deathTime);
  return { totalTime: d.totalTime ?? null, players, dps, healing, deaths };
}

// deaths within 5 s after another party death
export function chainDeaths(deaths) {
  const out = {};
  for (const d of deaths) {
    out[d.id] ??= { deaths: 0, chain: 0 };
    out[d.id].deaths++;
    if (deaths.some((o) => o.id !== d.id && o.deathTime < d.deathTime && d.deathTime - o.deathTime <= 5000)) out[d.id].chain++;
  }
  return out;
}

// All six tables (any may be missing) → exec
export function execFromTables(tables) {
  const s = parseSummary(tables?.summary);
  if (!s) return null;
  const rows = {};
  const dc = chainDeaths(s.deaths);
  for (const p of s.players) {
    rows[p.id] = {
      name: p.name, server: p.server, cls: p.cls, spec: p.spec, role: p.role,
      dps: s.totalTime ? (s.dps[p.id] ?? 0) / (s.totalTime / 1000) : null,
      deaths: dc[p.id]?.deaths ?? 0, deaths_chain: dc[p.id]?.chain ?? 0,
      pots: p.pots, hs: p.hs,
      kicks: null, kicks_by: null, dispels: null, dispels_by: null, avoid_dmg: null, def_casts: null, heal_total: null, heal_over: null,
    };
  }
  const zeroFill = (field) => { for (const r of Object.values(rows)) if (r[field] === null) r[field] = 0; };
  let int_spells = null, dispel_spells = null;
  if (tables?.interrupts) {
    const { per, spells } = perPlayerFromSpells(spellRows(tables.interrupts));
    int_spells = spells;
    for (const [id, v] of Object.entries(per)) { if (rows[id]) { rows[id].kicks = v.total; rows[id].kicks_by = v.by; } }
    zeroFill("kicks"); for (const r of Object.values(rows)) r.kicks_by ??= {};
  }
  if (tables?.dispels) {
    const { per, spells } = perPlayerFromSpells(spellRows(tables.dispels));
    dispel_spells = {};
    for (const [guid, v] of Object.entries(spells)) dispel_spells[guid] = { name: v.name, applied: v.begun, dispelled: v.interrupted, expired: v.completed };
    for (const [id, v] of Object.entries(per)) { if (rows[id]) { rows[id].dispels = v.total; rows[id].dispels_by = v.by; } }
    zeroFill("dispels"); for (const r of Object.values(rows)) r.dispels_by ??= {};
  }
  if (tables?.dmgTaken) {
    for (const e of entriesOf(tables.dmgTaken)) if (rows[e.id]) rows[e.id].avoid_dmg = e.total ?? 0;
    zeroFill("avoid_dmg");
  }
  if (tables?.casts) {
    for (const e of entriesOf(tables.casts)) if (rows[e.id]) rows[e.id].def_casts = e.total ?? 0;
    zeroFill("def_casts");
  }
  if (tables?.healing) {
    for (const e of entriesOf(tables.healing)) {
      if (!rows[e.id] || e.type === "NPC") continue;
      rows[e.id].heal_total = e.total ?? 0;
      rows[e.id].heal_over = typeof e.overheal === "number" ? e.overheal : 0;
    }
    zeroFill("heal_total"); zeroFill("heal_over");
  }
  return {
    source: "live",
    exec: Boolean(tables?.interrupts && tables?.dispels),
    rows, int_spells, dispel_spells,
    death_events: s.deaths,
    dur_s: s.totalTime ? s.totalTime / 1000 : null,
    players: s.players,
  };
}
