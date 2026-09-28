// execparse.js — turn the per-run Warcraft Logs Summary, Interrupts and
// Dispels tables into the `exec` shape measures.js reads (the same shape
// the wowlogs run store publishes, see design/baselines-from-wowlogs.md
// §3–4). Used only for runs the store will never hold; the parsing rules
// mirror the collector's.

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

// per-player totals from one spell-keyed table:
//   per: { [actorId]: { total, by: { [spellId]: n }, abilities: { [name]: n } } }
//   spells: { [spellId]: { name, begun, completed, interrupted } }
// The player's own ability is given by name only, which is how a stop
// (anything but the spec's kick) is told apart.
function perPlayerFromSpells(rows) {
  const per = {};
  const spells = {};
  for (const row of rows) {
    const guid = Number(row.guid);
    spells[guid] = { name: row.name, begun: row.spellsBegun ?? 0, completed: row.spellsCompleted ?? 0, interrupted: row.spellsInterrupted ?? 0 };
    for (const d of row.details ?? []) {
      const id = d.id;
      if (id === undefined || id === null) continue;
      per[id] ??= { total: 0, by: {}, abilities: {} };
      per[id].total += d.total ?? 0;
      per[id].by[guid] = (per[id].by[guid] ?? 0) + (d.total ?? 0);
      for (const a of d.abilities ?? []) per[id].abilities[a.name] = (per[id].abilities[a.name] ?? 0) + (a.total ?? 0);
    }
  }
  return { per, spells };
}

// Summary → composition and dps
export function parseSummary(table) {
  const d = table?.data;
  if (!d || typeof d !== "object") return null;
  const players = [];
  const byId = {};
  for (const [group, role] of [["tanks", "tank"], ["healers", "healer"], ["dps", "dps"]]) {
    for (const p of d.playerDetails?.[group] ?? []) {
      const spec = p.specs?.[0]?.spec ?? p.specs?.[0] ?? null;
      const row = { id: p.id, name: p.name, cls: p.type, spec: typeof spec === "string" ? spec : spec?.spec ?? null, role, server: p.server ?? null, region: p.region ?? null };
      players.push(row);
      byId[p.id] = row;
    }
  }
  // composition carries roles when playerDetails is thin
  for (const c of d.composition ?? []) {
    if (byId[c.id]) continue;
    const s = c.specs?.[0];
    const row = { id: c.id, name: c.name, cls: c.type, spec: s?.spec ?? null, role: s?.role ?? "dps", server: null, region: null };
    players.push(row); byId[c.id] = row;
  }
  const dps = {};
  for (const e of d.damageDone ?? []) dps[e.id] = e.total ?? 0;
  return { totalTime: d.totalTime ?? null, players, dps };
}

// Summary + Interrupts + Dispels (any may be missing) → exec. A missing
// table leaves its numbers null, never 0. kickNameOf(cls, spec) names the
// spec's kick (null for a spec without one, so every interrupt is a stop);
// without it stops stay null, since the kick cannot be told apart.
export function execFromTables(tables, { kickNameOf = null } = {}) {
  const s = parseSummary(tables?.summary);
  if (!s) return null;
  const rows = {};
  for (const p of s.players) {
    rows[p.id] = {
      name: p.name, server: p.server, cls: p.cls, spec: p.spec, role: p.role,
      dps: s.totalTime ? (s.dps[p.id] ?? 0) / (s.totalTime / 1000) : null,
      kicks: null, kicks_by: null, stops: null, dispels: null, dispels_by: null,
    };
  }
  let dispel_spells = null;
  if (tables?.interrupts) {
    const { per } = perPlayerFromSpells(spellRows(tables.interrupts));
    for (const r of Object.values(rows)) { r.kicks = 0; r.kicks_by = {}; if (kickNameOf) r.stops = 0; }
    for (const [id, v] of Object.entries(per)) {
      const r = rows[id];
      if (!r) continue;
      r.kicks = v.total; r.kicks_by = v.by;
      if (kickNameOf) {
        const kick = kickNameOf(r.cls, r.spec);
        r.stops = Object.entries(v.abilities).filter(([name]) => name !== kick).reduce((a, [, n]) => a + n, 0);
      }
    }
  }
  if (tables?.dispels) {
    const { per, spells } = perPlayerFromSpells(spellRows(tables.dispels));
    dispel_spells = {};
    for (const [guid, v] of Object.entries(spells)) dispel_spells[guid] = { name: v.name, applied: v.begun, dispelled: v.interrupted, expired: v.completed };
    for (const r of Object.values(rows)) { r.dispels = 0; r.dispels_by = {}; }
    for (const [id, v] of Object.entries(per)) { if (rows[id]) { rows[id].dispels = v.total; rows[id].dispels_by = v.by; } }
  }
  return {
    source: "live",
    exec: Boolean(tables?.interrupts && tables?.dispels),
    rows, dispel_spells,
    dur_s: s.totalTime ? s.totalTime / 1000 : null,
    players: s.players,
  };
}
