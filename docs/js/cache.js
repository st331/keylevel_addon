// cache.js — the per-character lookup cache (pure helpers; app.js owns
// localStorage). Once a character is looked up, their rankings are kept
// for an hour so re-running a roster (or reopening a share link) costs
// nothing — Shift-click "Look up" bypasses it for fresh data.

export const CHAR_CACHE_TTL = 3600_000; // 1 hour
export const CHAR_CACHE_MAX = 60;       // most-recent entries kept

// One entry per character per season: a season rollover (new zone id)
// naturally misses the old entries.
export function cacheKey(zoneId, full, region) {
  return `${zoneId}:${full}@${region}`.toLowerCase();
}

// Drop expired entries, then the oldest beyond the cap.
export function pruneCache(entries, now) {
  const alive = Object.entries(entries ?? {})
    .filter(([, v]) => v && typeof v.t === "number" && now - v.t < CHAR_CACHE_TTL)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, CHAR_CACHE_MAX);
  return Object.fromEntries(alive);
}

// The raw encounterRankings blobs carry far more than the site reads
// (bestAmount, kill times, per-rank server/guild info…). Keep only the
// fields the transforms use so 60 cached characters stay small.
export function slimResult(result) {
  if (!result) return null;
  const out = { classID: result.classID };
  for (const [alias, blob] of Object.entries(result)) {
    if (!/^e\d+$/.test(alias)) continue;
    out[alias] = {
      ranks: (blob?.ranks ?? []).map((r) => ({
        spec: r.spec,
        bestSpec: r.bestSpec,
        score: r.score,
        bracketData: r.bracketData,
        amount: r.amount,
        historicalPercent: r.historicalPercent,
        rankPercent: r.rankPercent,
        startTime: r.startTime,
        ...(r.report?.code ? { report: { code: r.report.code, fightID: r.report.fightID } } : {}),
      })),
    };
  }
  return out;
}
