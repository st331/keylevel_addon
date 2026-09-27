# Baselines and per-run data from the wowlogs collector

How the Key Level Logs vetting site gets "what does a typical Arms Warrior do in an
Altar of Fangs +18" and an applicant's per-run execution numbers **without any run
being pulled from Warcraft Logs twice**. Everything below was measured live on
2026-09-27 against the WCL v2 API and the wowlogs pipeline (`st331/wowlogs`, default
branch `claude/wow-mythic-dashboard-jv235l`, which is also its deploy branch).

## 1. The no-repeat rule

Both projects use the same WCL API client (18,000 points/hour; the collector already
spends ~10,000/hour and caps itself at 85 %). The rule that keeps every pull unique:

| Data | Pulled by | Never pulled by | Why |
|---|---|---|---|
| Per-run **tables** (Summary, Interrupts, Dispels, filtered DamageTaken, filtered Casts, Healing) for runs on the leaderboard pages | **wowlogs**, once, in its existing per-run request | the site | The site reads them from the wowlogs run store (§3). |
| Per-run tables for runs wowlogs will never sweep (below its leaderboard pages) | the site, live, once per browser (14-day cache) | wowlogs | wowlogs only sweeps `fightRankings` pages 1–20 by score and never revisits a run it skipped. |
| Per-run **events** (death windows, sub-35 % HP exposure, the applicant's own kit casts, enemy begincasts, the healer's healing stream) | the site, live, once per browser (14-day cache) | wowlogs | Only the vetting side needs them; population baselines for these are absolute thresholds. |
| An applicant's run list (`encounterRankings`) | the site (8 points per character, cached 1 hour) | wowlogs | wowlogs cannot know who applied. |
| Population **baselines** (per-cell quantiles, priority table, dispellable list) | derived by wowlogs from data it already holds | — | zero extra API cost |

**Sweep-lag rule.** A run that started less than 3 hours before the run store's
`built` time may simply not have been swept yet. The site never pulls tables for such a
run (it uses the run's `encounterRankings.amount` for damage and still pulls events,
which wowlogs never fetches). On a later lookup the run is either in the store or old
enough to be known as "never swept", and only then is it pulled live. This is the only
place freshness is traded for the guarantee.

**Curated lists** (avoidable damage per dungeon, dangerous casts, defensive kits per spec,
consumables, dispel types) live in ONE file, published by this repo at
`https://st331.github.io/keylevel_addon/data/lists.json`. wowlogs fetches it at the start
of every refresh run and keeps a vendored copy (`data/lists.json`) as the fallback, so
both sides always measure the same spell ids.

## 2. Contract: `https://st331.github.io/wowlogs/baselines.json.gz`

Rebuilt by every wowlogs site build (every 20–30 min), covering exactly the retention
window the dashboard shows (`retention.resets = 2`, ≤ 15 days). Feature-detected by the
client; unknown keys are ignored. Served with `access-control-allow-origin: *`.

```jsonc
{
  "built": "2026-09-27T05:02:00Z",
  "season": "Midnight Season 2",
  "window": { "from": "2026-09-13", "to": "2026-09-27", "resets": 2 },
  "population": "timed leaderboard runs (fightRankings pages 1–20 by score per dungeon × level)",
  "lists_version": "12.1",                   // the lists.json version the collector used
  "quantiles": [5, 10, 25, 50, 75, 90, 95],
  "measures": {                              // unit + direction, so the client never guesses
    "dps":         { "unit": "per_s",   "better": "high" },
    "deaths_30m":  { "unit": "per_30m", "better": "low"  },   // all deaths
    "chain_30m":   { "unit": "per_30m", "better": "low"  },   // deaths within 5 s after another party death
    "kicks_min":   { "unit": "per_min", "better": "high" },   // interrupts landed ÷ fight minutes
    "kick_prio":   { "unit": "per_min", "better": "high" },   // Σ over kicked spells of p_s × kicks_s ÷ fight minutes
    "dispels_min": { "unit": "per_min", "better": "high" },
    "avoid_dmg_min": { "unit": "per_min", "better": "low" },  // damage taken from the dungeon's avoidable list ÷ minutes
    "def_casts_min": { "unit": "per_min", "better": "high" }, // casts of the spec's defensives + self-heals + consumables ÷ minutes
    "pots":        { "unit": "per_run", "better": "high" },
    "heal_eff_s":  { "unit": "per_s",   "better": "high" }    // (healing − overheal) ÷ s, healers
  },
  "levels": { "min": 10, "max": 30, "band": 2 },
  "cells": {
    // three granularities, coarsest as fallback; key = spec|dungeon|level (spec keyed "Class-Spec")
    "Warrior-Arms|Altar of Fangs|18":  { "n": 1042, "dps": [310431, 317320, 330292, 346080, 362986, 377029, 385884], "kicks_min": [...], "n_exec": 412, ... },
    "Warrior-Arms|Altar of Fangs|b18": { "n": 2469, ... },   // 2-level band 18–19
    "Warrior-Arms|*|b18":              { "n": 9800, ... }    // all dungeons, band
  },
  "priority": {                              // per dungeon, per enemy cast id, summed over the window
    "Altar of Fangs": { "1294557": { "name": "Piercing Hiss", "begun": 15320, "completed": 812, "interrupted": 13990 } }
  },
  "dispellable": { "Altar of Fangs": { "1294569": { "name": "Paralyzing Shots", "applied": 1200, "dispelled": 890, "expired": 310 } } }
}
```

- `n` counts rows for `dps` / `deaths_*` / `pots` (present for every run); `n_exec` counts
  rows that carried the execution bundle (the other measures). A measure's quantiles are
  omitted when its `n` is under 20.
- Rates use the run's fight duration (`duration_s`, the Summary `totalTime`) on both sides.
- Fallback ladder on the client: exact level if `n ≥ 100`, else band, else dungeon-pooled
  band, else "no baseline" (shown, never silently substituted).
- Percentile = piecewise-linear interpolation between the quantiles, clamped to [2, 98];
  robust z for a composite = `(v − p50) / ((p75 − p25) / 1.349)`.
- The population is timed leaderboard runs (`timed_rate` 0.98–1.00 per cell). Deaths are
  therefore never scored by percentile against it; DPS, kick and avoidable-damage
  percentiles are conservative and the page says so.

Size: three measures at three tiers measured 0.21 MB gzipped; twelve measures ≈ 0.7 MB.

## 3. Contract: the run store `https://st331.github.io/wowlogs/runs/<c>.json.gz`

One shard per first character of the report code (`[A-Za-z0-9]`, case-sensitive, ≤ 62
files, ~150 KB gzipped each), rebuilt with the site, covering the retention window:

```jsonc
{
  "built": "2026-09-27T05:02:00Z",
  "runs": {
    "P3j1myqhvQcMp6Tk:8": {
      "dun": "Altar of Fangs", "lvl": 16, "start": 1758915000000, "dur_s": 1604.0, "timed": true,
      "exec": true,                        // false when the execution bundle was not fetched (quota gate)
      "players": [
        { "name": "Genjibb", "server": "Area 52", "region": "US", "class": "Warrior", "spec": "Arms", "role": "DPS",
          "dps": 312375, "deaths": 2, "deaths_chain": 1, "pots": 6, "hs": 0,
          "kicks": 23, "kicks_by": { "1294557": 12, "1307571": 11 }, "dispels": 0, "dispels_by": {},
          "avoid_dmg": 1876532, "def_casts": 7, "heal_total": 4100000, "heal_over": 900000 }
      ]
    }
  }
}
```

Bundle fields are `null` when `exec` is false. `kicks_by` / `dispels_by` are keyed by enemy
spell id so the client can apply the current priority table. The client fetches only the
shards its applicants' runs need (≤ 8 per applicant), caches each for 30 minutes keyed on
`built`, and looks up `<code>:<fightID>` from the applicant's `encounterRankings` list.

## 4. What the collector adds per run

Today: one `table(dataType: Summary)` per run, eight runs aliased per request (1.47
points per run cold). Add five tables **inside the same aliased request**, gated by the
quota rule below (measured: +1.0 point per table per run; the six-table bundle is 6.0
points warm, 6.5–8.5 cold; ~142 KB per run):

```graphql
a0: report(code: "…") {
  summary:    table(fightIDs: [F], dataType: Summary)
  interrupts: table(fightIDs: [F], dataType: Interrupts)
  dispels:    table(fightIDs: [F], dataType: Dispels)
  dmgTaken:   table(fightIDs: [F], dataType: DamageTaken,
                    filterExpression: "ability.id in (<lists.dungeons[dun].avoidable>)")
  casts:      table(fightIDs: [F], dataType: Casts,
                    filterExpression: "ability.id in (<union of defensives + selfheals + consumables of the five specs present>)")
  healing:    table(fightIDs: [F], dataType: Healing)
}
```

Verified shapes (all five players in ONE call, no `sourceID`):
- Interrupts: `entries[0].entries[]` = one row per enemy spell with `guid`, `name`,
  `spellsBegun / spellsCompleted / spellsInterrupted` and `details[]` = one row per
  kicking player (`id`, `name`, `total`). Players with zero kicks are absent → 0.
  Only spells kicked at least once in that fight appear; over thousands of runs the
  population priority table is only mildly biased upward.
- Dispels: same shape per debuff (`spellsBegun` = applications, `spellsInterrupted` =
  dispelled, `spellsCompleted` = expired undispelled, `details[]` per dispeller; the
  dispeller can be a pet/totem actor → attribute to its owner via `masterData.actors.petOwner`
  if present, else drop).
- DamageTaken filtered: five entries with `total` per player (the per-ability breakdown is
  capped at five and not needed). No hit counts exist; the measure is damage.
- Casts filtered: entries only for players with ≥ 1 matching cast → 0 for the rest;
  `total` is exact for any number of ids.
- Healing: `total`, `overheal`, per player; drop NPC rows; `overheal` may be null.
- Summary already carries `deathEvents[].deathTime` (ms) and killing `ability`, and
  `playerDetails[].potionUse` / `healthstoneUse` (null when absent, never 0) — export them.
  `deaths_chain` = deaths with another party death in the previous 5 s.

**Quota gate (measured on the CSV).** Fetch the bundle only while any of the run's five
(spec, dungeon, 2-level band) cells has fewer than 100 bundled player-rows in the trailing
14 days (specs from the sweep roster; fall back to class if the roster lacks specs).
That admits ~4,600 of ~9,000 runs/day at key ≥ 10, fills every cell the population can
fill, spends ≈ **+960 points/hour**, and keeps rare specs at ~100 % coverage. Use
`est_cost` 7.5 for bundled runs. Total load ≈ 11,000/hour, under the 15,300 ceiling.

Storage: parsed rows only (the raw bundle would be ~650 MB/day). New per-player
columns in `players.jsonl` and `mythic_runs.csv.gz` (null when not fetched): `pots, hs,
deaths_chain, kicks, kicks_by, dispels, dispels_by, avoid_dmg, def_casts, heal_total,
heal_over`; run-level `exec` flag and the run's per-spell Interrupts/Dispels sums in a
run-level journal for the priority/dispellable tables.

## 5. Builder: `scripts/build_baselines.py`

- Input: the same retention-windowed frame `build_site_data.py` publishes, plus the
  run-level journal.
- Output: `site/baselines.json.gz` and `site/runs/<c>.json.gz` as in §2–3 (Pages deploys
  `site/**`, so nothing else changes).
- Cells at all three tiers when `n ≥ 20`; `priority` and `dispellable` summed per dungeon
  over the window; a health line in `build_health.txt` (cells filled, bundled share, sizes).
- Tests: quantile edge cases, tier fallback, a fixture journal, the shard split, sizes.

## 6. Consumer side (this site)

- `docs/js/baselines.js`: fetch + cache (localStorage, 30 min, keyed on `built`), ladder,
  `percentile`, `robustZ`, `n` and tier exposed.
- `docs/js/runstore.js`: shard fetch + cache; `lookupRun(code, fightID)`; the sweep-lag rule.
- Per applicant (live): the run list (existing 8-point call), the newest runs at listing
  level ± 2 in the applied spec (up to 15 for damage, 8 for execution); for each run,
  store first; tables live only when the store says the run is absent and the run is older
  than the sweep lag; events always live (Deaths, sub-35 % exposure pull, own kit casts,
  enemy begincasts on the dungeon's dangerous list; ±10 s windows per own death; healer
  healing stream on ≤ 4 runs). Measured: Set B ≈ 80–125 points per DPS applicant, 140–150
  per healer, < 10 MB, 3–8 s in parallel. Finished runs never change: per-run results are
  cached 14 days by `(code, fightID)`.

## 7. Budget options for the shared client

| Option | Effect |
|---|---|
| Keep one client, collector at 85 % | Vetting gets 2,700–8,000 points/hour depending on the collector's phase: 25–60 Set-B applicants/hour. Tight on a busy evening. |
| Lower the collector's sweep cadence | Its README: the leaderboard re-scan is ~1,900 points per sweep, the dominant cost; every 40 min instead of every 20 frees ~3,000/hour. |
| **Second WCL API client for the vetting site** | WCL's limit is documented per client. Create a second client on the WCL client page, put its id/secret in this site's `config.js` deploy secret, and the two projects stop competing. Recommended. |

## 8. What the collector's own data says about ownership

From `mythic_runs.csv.gz` (756,595 player-rows at key ≥ 10, 15 days; 72,928 characters
with ≥ 3 runs): the intraclass correlation of a player's DPS across runs is 0.43 (DPS
specs) / 0.65 (healers) / 0.52 (tanks), 0.66 for level-normalised DPS within a listing ± 2
window; for raw deaths 0.05 / 0.06 / 0.01. Runs from the same upload or within three hours
share a third of their DPS noise, so an applicant's effective sample is ≈ 0.6 × their run
count. These set the shrinkage in the measure sets and are recomputable daily at zero API
cost.

## 9. Rollout

1. This repo publishes `docs/data/lists.json` (v12.1) and ships the consumer with graceful
   absence (no sidecar → Key % only; no store → tables live for runs older than the lag).
2. wowlogs: lists fetch + bundle + quota gate + columns + `build_baselines.py` + tests,
   merged to its deploy branch; cells for common specs at +12…+20 reach n = 100 within 2–4
   days; `dps` / `deaths` / `pots` cells and the run store are complete from the first build.
3. The site switches on the baseline-dependent measures automatically when the sidecar
   appears (feature detection, no deploy needed).
