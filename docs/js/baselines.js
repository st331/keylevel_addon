// baselines.js — the population baselines published by the wowlogs
// collector (design/baselines-from-wowlogs.md §2): per spec × dungeon ×
// key-level cell, the quantiles of every measure over the newest two weekly
// resets of timed leaderboard runs. This site never computes a population
// itself; it only reads this document.

import { percentileInCell, robustZ } from "./stats.js";

export const DEFAULT_BASELINES_URL = "https://st331.github.io/wowlogs/baselines.json.gz";
export const EXACT_MIN_N = 100;  // exact level cell needs this many rows
export const BAND_MIN_N = 100;   // else the 2-level band
export const POOLED_MIN_N = 20;  // else all dungeons in the band

// Fetch a gzipped JSON document. GitHub Pages serves *.json.gz as
// application/gzip (not content-encoding), so the body is decompressed here
// with the browser's DecompressionStream. A server that already serves plain
// JSON under the same name (tests, a future host) works too.
export async function fetchGzJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { cache: "default" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (!isGzip) return JSON.parse(new TextDecoder().decode(buf));
  if (typeof DecompressionStream !== "function") throw new Error("this browser cannot decompress gzip");
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// Wrap a baselines document with the cell ladder and percentile lookup.
export function makeBaselines(doc) {
  if (!doc || typeof doc !== "object" || !doc.cells || !Array.isArray(doc.quantiles)) return null;
  const q = doc.quantiles;
  const band = (level) => `b${Math.floor(level / 2) * 2}`;
  const EXEC_MEASURES = ["kicks_min", "kick_prio", "dispels_min", "avoid_dmg_min", "def_casts_min", "heal_eff_s"];
  const nRows = (c, measure) => (EXEC_MEASURES.includes(measure) ? (c.n_exec ?? 0) : (c.n ?? 0));
  const get = (key, minN) => {
    const c = doc.cells[key];
    return c && typeof c.n === "number" && c.n >= minN ? c : null;
  };
  const getFor = (key, measure, minN) => {
    const c = doc.cells[key];
    if (!c || !Array.isArray(c[measure])) return null;
    return nRows(c, measure) >= minN ? c : null;
  };
  return {
    built: doc.built ?? null,
    window: doc.window ?? null,
    population: doc.population ?? null,
    quantiles: q,
    measures: doc.measures ?? {},
    priority: doc.priority ?? {},
    dispellable: doc.dispellable ?? {},
    // spec is "Class-Spec"; returns { ...cell, key, tier } or null. With a
    // measure, the ladder counts that measure's own rows (n_exec for the
    // bundle measures) and skips a cell that has no quantiles for it, so an
    // execution measure is judged against the finest cell that can judge
    // it — the pooled spec × band cell fills weeks before the exact one.
    cellFor(spec, dungeon, level, measure = null) {
      if (!spec || !Number.isInteger(level)) return null;
      const tries = [
        dungeon ? [`${spec}|${dungeon}|${level}`, "exact", EXACT_MIN_N] : null,
        dungeon ? [`${spec}|${dungeon}|${band(level)}`, "band", BAND_MIN_N] : null,
        [`${spec}|*|${band(level)}`, "pooled", POOLED_MIN_N],
      ].filter(Boolean);
      for (const [key, tier, minN] of tries) {
        const c = measure ? getFor(key, measure, minN) : get(key, minN);
        if (c) return { ...c, key, tier, q };
      }
      return null;
    },
    // where value sits in the cell for that measure (2–98), or null when the
    // cell has no quantiles for it (n too small at build time)
    percentile(cell, measure, value) {
      if (!cell || !Array.isArray(cell[measure])) return null;
      const better = this.measures?.[measure]?.better ?? "high";
      return percentileInCell(q, cell[measure], value, better !== "low");
    },
    robustZ(cell, measure, value) {
      if (!cell || !Array.isArray(cell[measure])) return null;
      return robustZ(q, cell[measure], value);
    },
    // how many rows back the measure in this cell (n_exec for bundle measures)
    nFor(cell, measure) { return cell ? nRows(cell, measure) : 0; },
    // the dungeon's dangerous casts: kicked at least half the time by the population
    dangerousFor(dungeon, minBegun = 10) {
      const out = new Set();
      for (const [id, s] of Object.entries(this.priority?.[dungeon] ?? {})) {
        if ((s.begun ?? 0) >= minBegun && s.interrupted / s.begun >= 0.5) out.add(Number(id));
      }
      return out;
    },
  };
}

// Load (once per page, refreshed every 30 min) — returns null when the
// document is not there yet; every caller must cope with that.
const TTL = 30 * 60_000;
let cached = null; // { at, url, baselines }
export async function loadBaselines({ url = DEFAULT_BASELINES_URL, fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!force && cached && cached.url === url && now - cached.at < TTL) return cached.baselines;
  let baselines = null;
  try {
    baselines = makeBaselines(await fetchGzJson(url, fetchImpl));
  } catch {
    baselines = null;
  }
  cached = { at: now, url, baselines };
  return baselines;
}

export function resetBaselinesCache() { cached = null; }
