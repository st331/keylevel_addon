// runstore.js — the per-run rows the wowlogs collector already fetched
// (design/baselines-from-wowlogs.md §3), in 256 shards by a hash of the
// report code. Reading a run from here is what keeps the no-repeat rule:
// a run in the store is never pulled from Warcraft Logs again by this site.

import { fetchGzJson } from "./baselines.js";

export const DEFAULT_RUNSTORE_URL = "https://st331.github.io/wowlogs/runs/";
// A run younger than this (relative to the store's build time) may not
// have been swept yet; the site must not pull its tables live, or the
// collector would pull them again minutes later.
export const SWEEP_LAG_MS = 3 * 3600_000;
const SHARD_TTL = 30 * 60_000;

// 256 shards by a hash of the report code (the same function runs in the
// collector): h = (h * 31 + charCode) mod 256 over the first four characters.
export function shardOf(code) {
  const c = String(code ?? "");
  if (!c) return null;
  let h = 0;
  for (let i = 0; i < Math.min(4, c.length); i++) h = (h * 31 + c.charCodeAt(i)) % 256;
  return h.toString(16).padStart(2, "0");
}

export class RunStore {
  constructor({ baseUrl = DEFAULT_RUNSTORE_URL, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.shards = new Map(); // c -> { at, doc|null }
    this.inflight = new Map(); // c -> promise, so parallel lookups share one fetch
    this.built = null;       // newest build time seen (ms)
    this.available = null;   // false once a shard fetch failed outright (no store deployed)
  }

  async shard(c) {
    const hit = this.shards.get(c);
    if (hit && this.now() - hit.at < SHARD_TTL) return hit.doc;
    const pending = this.inflight.get(c);
    if (pending) return pending;
    const p = this.fetchShard(c).finally(() => this.inflight.delete(c));
    this.inflight.set(c, p);
    return p;
  }

  async fetchShard(c) {
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
// name (the store has no report-local actor ids), plus the run's dispel
// table. The caller maps names to ids once it knows the fight's actors.
// Only what the measures read is carried over; a field the collector did
// not fetch for the run (`stops` before the lean bundle) stays null, never 0.
export function execFromStoredRun(run, nameToId) {
  if (!run) return null;
  const rows = {};
  for (const p of run.players ?? []) {
    const id = nameToId?.(p.name, p.server) ?? p.name;
    rows[id] = {
      name: p.name, server: p.server, cls: p.class, spec: p.spec, role: (p.role ?? "").toLowerCase(),
      dps: p.dps ?? null,
      kicks: p.kicks ?? null, kicks_by: p.kicks_by ?? null,
      stops: typeof p.stops === "number" ? p.stops : null,
      dispels: p.dispels ?? null, dispels_by: p.dispels_by ?? null,
    };
  }
  return {
    source: "store",
    exec: run.exec !== false,
    rows,
    dispel_spells: run.dispel_spells ?? null,
    dur_s: run.dur_s ?? null,
    timed: run.timed ?? null,
  };
}
