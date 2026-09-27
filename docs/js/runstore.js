// runstore.js — the per-run rows the wowlogs collector already fetched
// (design/baselines-from-wowlogs.md §3), sharded by the first character of
// the report code. Reading a run from here is what keeps the no-repeat rule:
// a run in the store is never pulled from Warcraft Logs again by this site.

import { fetchGzJson } from "./baselines.js";

export const DEFAULT_RUNSTORE_URL = "https://st331.github.io/wowlogs/runs/";
// A run younger than this (relative to the store's build time) may not
// have been swept yet; the site must not pull its tables live, or the
// collector would pull them again minutes later.
export const SWEEP_LAG_MS = 3 * 3600_000;
const SHARD_TTL = 30 * 60_000;

export function shardOf(code) {
  const c = String(code ?? "")[0];
  return c && /[A-Za-z0-9]/.test(c) ? c : null;
}

export class RunStore {
  constructor({ baseUrl = DEFAULT_RUNSTORE_URL, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.shards = new Map(); // c -> { at, doc|null }
    this.built = null;       // newest build time seen (ms)
    this.available = null;   // false once a shard fetch failed outright (no store deployed)
  }

  async shard(c) {
    const hit = this.shards.get(c);
    if (hit && this.now() - hit.at < SHARD_TTL) return hit.doc;
    let doc = null;
    try {
      doc = await fetchGzJson(`${this.baseUrl}${c}.json.gz`, this.fetchImpl);
      if (doc?.built) {
        const t = Date.parse(doc.built);
        if (Number.isFinite(t)) this.built = Math.max(this.built ?? 0, t);
      }
      this.available = true;
    } catch {
      doc = null;
      // a 404 for one shard is possible (no run with that first letter
      // in the window); a network failure means "no store": both read as
      // absent, and the lag rule below still protects fresh runs
      if (this.available === null) this.available = false;
    }
    this.shards.set(c, { at: this.now(), doc });
    return doc;
  }

  // { status: "stored"|"pending"|"absent", run } — pending = too fresh to
  // know (see SWEEP_LAG_MS); tables are pulled live only for "absent".
  async lookup(code, fightID, startMs) {
    const c = shardOf(code);
    const doc = c ? await this.shard(c) : null;
    const run = doc?.runs?.[`${code}:${fightID}`] ?? null;
    if (run) return { status: "stored", run };
    const built = this.built ?? this.now();
    if (typeof startMs === "number" && startMs > built - SWEEP_LAG_MS) return { status: "pending", run: null };
    return { status: "absent", run: null };
  }
}

// Turn a stored run into the `exec` shape measures.js reads: rows by actor
// name (the store has no report-local actor ids), plus the run-level spell
// tables. The caller maps names to ids once it knows the fight's actors.
export function execFromStoredRun(run, nameToId) {
  if (!run) return null;
  const rows = {};
  for (const p of run.players ?? []) {
    const id = nameToId?.(p.name, p.server) ?? p.name;
    rows[id] = {
      name: p.name, server: p.server, cls: p.class, spec: p.spec, role: (p.role ?? "").toLowerCase(),
      dps: p.dps ?? null, deaths: p.deaths ?? null, deaths_chain: p.deaths_chain ?? null,
      pots: p.pots ?? null, hs: p.hs ?? null,
      kicks: p.kicks ?? null, kicks_by: p.kicks_by ?? null,
      dispels: p.dispels ?? null, dispels_by: p.dispels_by ?? null,
      avoid_dmg: p.avoid_dmg ?? null, def_casts: p.def_casts ?? null,
      heal_total: p.heal_total ?? null, heal_over: p.heal_over ?? null,
    };
  }
  return {
    source: "store",
    exec: run.exec !== false,
    rows,
    int_spells: run.int_spells ?? null,
    dispel_spells: run.dispel_spells ?? null,
    death_events: run.death_events ?? null,
    dur_s: run.dur_s ?? null,
    timed: run.timed ?? null,
  };
}
