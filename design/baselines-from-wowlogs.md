# Population baselines from the wowlogs collector

How the Key Level Logs vetting site gets "what does a typical Arms Warrior do in an
Altar of Fangs +18" without pulling population data from Warcraft Logs itself.
Everything below was measured live on 2026-09-27 against the current WCL v2 API and
the current wowlogs pipeline (`st331/wowlogs`, branch `claude/wow-mythic-dashboard-jv235l`).

## 1. Division of labour

| Concern | Owner | Why |
|---|---|---|
| Population baselines: per spec × dungeon × key level, the distribution of every measure | **wowlogs** (collector + site builder) | It already sweeps ~10,000 runs/day at key 10+, keeps the newest two weekly resets, publishes gzipped JSON on GitHub Pages with `access-control-allow-origin: *`, and budgets the WCL client. |
| Per-applicant measurements: the applicant's own recent runs, incl. death-context events | **keylevel_addon**, live in the browser | Only the applicant's ~8 newest runs; must be fresh at vetting time; wowlogs only holds leaderboard-page runs, so it cannot be relied on to contain a given applicant's runs. |
| Curated spell lists: avoidable damage per dungeon, defensives/consumables per spec, dispellable debuffs, dangerous casts | one versioned JSON set in wowlogs (`data/lists/<partition>.json`), read by both | Both sides must measure the same thing. The collector also publishes the candidates it observes so curation is data-led (see §5). |

Both projects use the **same WCL API client** today (the site's embedded client id and the
collector's secret): `pointsSpentThisHour` on that client rose 5,970 → 8,427 in ~15 minutes
while this session spent ~40 points itself. The collector caps itself at 85 % of the
18,000/hour limit (15,300). Everything below is sized so the collector's addition stays
under ~1,000 points/hour and the vetting site's live spend stays under ~120 points per
applicant.

## 2. The contract: `https://st331.github.io/wowlogs/baselines.json.gz`

Rebuilt by every wowlogs site build (the refresh workflow, every 20–30 min), covering
exactly the retention window the dashboard shows (`retention.resets = 2`, ≤ 15 days).
Feature-detected by the client like wowlogs' other sidecars; unknown keys are ignored.

```jsonc
{
  "built": "2026-09-27T05:02:00Z",
  "season": "Midnight Season 2",
  "partition": 1,
  "window": { "from": "2026-09-13", "to": "2026-09-27", "resets": 2 },
  "population": "timed leaderboard runs (fightRankings pages 1–20 by score per dungeon × level)",
  "quantiles": [5, 10, 25, 50, 75, 90, 95],
  "measures": {
    "dps":        { "unit": "per_s",   "better": "high" },
    "deaths_30m": { "unit": "per_30m", "better": "low"  },
    "chain_30m":  { "unit": "per_30m", "better": "low"  },   // deaths within 5 s of another party death
    "kicks_min":  { "unit": "per_min", "better": "high" },
    "kick_prio":  { "unit": "per_min", "better": "high" },   // kicks weighted by the dungeon priority table
    "kick_util":  { "unit": "share",   "better": "high" },   // own kicks ÷ min(dangerous casts begun, combat min ÷ kick CD)
    "dispels_min":{ "unit": "per_min", "better": "high" },
    "avoid_dmg_min": { "unit": "per_min", "better": "low" }, // damage from the dungeon's avoidable list (hit counts are not in filtered tables)
    "def_casts_min":  { "unit": "per_min", "better": "high" },
    "pots":       { "unit": "per_run", "better": "high" },
    "active_share": { "unit": "share", "better": "high" },   // activeTime ÷ Σ pull windows
    "heal_eff_s": { "unit": "per_s",   "better": "high" }    // (healing − overheal) ÷ s, healers
  },
  "levels": { "min": 10, "max": 30, "band": 2 },
  "cells": {
    "Arms|Altar of Fangs|18":  { "n": 1042, "dps": [310431, 317320, 330292, 346080, 362986, 377029, 385884], "kicks_min": [...], ... },
    "Arms|Altar of Fangs|b18": { "n": 2469, ... },      // 2-level band 18–19
    "Arms|*|b18":              { "n": 9800, ... }       // all dungeons, band 18–19
  },
  "priority": {                                         // per dungeon, per enemy cast id, population-wide
    "Altar of Fangs": { "1294557": { "name": "Piercing Hiss", "begun": 15320, "completed": 812, "interrupted": 13990 } }
  },
  "dispellable": { "Altar of Fangs": ["1294569", "1307571"] },   // debuffs dispelled ≥ 1× anywhere in the window
  "lists": { "version": "12.1.0-3", "url": "lists/12.1.0-3.json" }  // the curated lists the collector used
}
```

Cell key = `spec|dungeon|level`, with `b<even level>` for a 2-level band and `*` for all
dungeons. Client fallback ladder: exact level if `n ≥ 100`, else band, else dungeon-pooled
band, else "no baseline" (shown, never silently substituted).

Size: a prototype built from today's CSV with three measures at all three tiers is
0.77 MB raw / **0.21 MB gzipped**; twelve measures land around 0.6–0.8 MB gzipped.
wowlogs already ships a 13 MB `builds.json.gz`, so this is well inside its caps.

Client-side percentile = piecewise-linear interpolation of the applicant's value between
the cell's quantiles, clamped to [2, 98]; robust z for a composite = `(v − p50) / ((p75 − p25) / 1.349)`.

**The population is timed runs.** The collector reads fight rankings ordered by score
(top 20 pages × 50 per dungeon × level), so at +12…+20 it holds the ~1,000 highest-scoring
logged runs per cell: `timed_rate` is 1.00 for Arms/Blood at Altar +18 and 0.98 for the
Fury band. Consequences: (1) deaths must never be scored by percentile against this
baseline — Arms Altar +18 `deaths_30m` quantiles are [0, 0, 0, 0, 1.10, 2.12, 2.21], so
any death is already ≥ p75; deaths use the absolute rule in the measure sets; (2) DPS,
kick and avoidable-damage percentiles are conservative ("how would this applicant sit
among players in timed +18s"), which is the right vetting standard, and the page says so
in the legend.

## 3. What the collector adds per run

Today: one `table(dataType: Summary)` per run, eight runs aliased per request (measured
1.47 points/run cold; the code's estimate of 2.6 is conservative). The Summary already
carries, unused by the export: `deathEvents[].deathTime` and the killing `ability`
(→ chain-death classification for free), and `playerDetails[].potionUse` /
`healthstoneUse` (present on most reports; absent on some older log versions → export
as null, never 0).

Add five tables **inside the same aliased request** (measured: +1.0 point per table per
run; the whole six-table bundle is 6.0 points warm, 6.5–8.5 cold; ~142 KB per run):

```graphql
a0: report(code: "…") {
  summary:    table(fightIDs: [F], dataType: Summary)
  interrupts: table(fightIDs: [F], dataType: Interrupts)
  dispels:    table(fightIDs: [F], dataType: Dispels)
  dmgTaken:   table(fightIDs: [F], dataType: DamageTaken,
                    filterExpression: "ability.id in (<the dungeon's avoidable list>)")
  casts:      table(fightIDs: [F], dataType: Casts,
                    filterExpression: "ability.id in (<defensive ids of the five specs present, ≤ 5 per spec>)")
  healing:    table(fightIDs: [F], dataType: Healing)        # healers only need it; −1 pt/run if dropped
}
```

Verified shapes (all five players in ONE call, no `sourceID` needed):
- Interrupts: `entries[0].entries[]` = one row per enemy spell with `spellsBegun /
  spellsCompleted / spellsInterrupted` and `details[]` = one row per kicking player
  (`id`, `total`, `abilities[]`). Players with zero kicks are absent → fill 0 from the
  Summary composition. The per-spell begun/completed/interrupted sums are exactly the
  per-dungeon priority table.
- Dispels: same shape per debuff (`spellsBegun` = applications, `spellsInterrupted` =
  dispelled, `spellsCompleted` = expired undispelled, `details[]` per dispeller).
- DamageTaken filtered by `ability.id in (…)`: five entries with `total`, `hitCount`
  and per-ability breakdown for the filtered ids (keep ≤ 5 ids per alias: unfiltered
  `abilities[]` lists are capped at five).
- Casts filtered: entries only for players with ≥ 1 matching cast → fill 0; `total`
  is exact, `abilities[]` capped at five, so ≤ 5 ids per spec.
- Healing: `total`, `overheal`, `activeTime` per player; drop NPC rows.
- Kicks are NOT in a player's Casts entries; they are in the Interrupts table (above).
- Two table quirks the builder must respect: the Interrupts table lists only enemy
  spells that were kicked at least once in that fight, and the Dispels table only
  debuffs dispelled at least once, so a run where nobody kicked a spell contributes no
  "begun" count for it. Over thousands of runs the dangerous spells are kicked in almost
  every run, so the population priority table is only mildly biased upward; a
  `table(dataType: Casts, hostilityType: Enemies, viewBy: Ability)` per dungeon (1.2
  points, once a day) gives the unbiased completion counts if wanted.
- Filtered DamageTaken entries carry per-ability `total` but no hit counts; avoidable
  damage is therefore scored as damage per combat minute against the cell, not hits.
- `potionUse` / `healthstoneUse` are present in the Summary `playerDetails` (verified on
  two reports; one earlier "absent" reading came from a different query shape).

**Sampling rule (measured on the CSV).** Fetch the bundle for a run only while any of its
five (spec, dungeon, 2-level band) cells has fewer than 100 player-rows from bundled runs
in the trailing 14 days; otherwise Summary only, as today. That admits 4,597 of 8,987
runs/day at key ≥ 10, fills every cell the population can fill (790 of 790 common-spec
cells reach 100), spends ≈ **+960 points/hour** (≈ 1,100 at a quota of 130), and keeps
rare specs at ~100 % coverage because they are always under quota. Uniform 50 % sampling
costs the same and leaves 141 cells short. Raise `est_cost` to 7.5 for bundled runs.
Total client load ≈ 11,000/hour, under the 15,300 ceiling with the sweep unchanged.

New CSV columns (one row per player per run; null when the bundle was not fetched):
`kicks, kick_prio, kick_util, dispels, avoid_hits, avoid_dmg, def_casts, pots, hs,
deaths_solo, deaths_chain, active_ms, heal_total, heal_over`. Run-level: `combat_ms`
(Σ merged `dungeonPulls` windows, dropping < 1 s artefacts) so per-minute rates share one
denominator with the vetting site.

Storage: keep parsed rows only (the collector journals parsed rows, not raw tables; the
bundle would be ~650 MB/day raw).

## 4. Builder: `scripts/build_baselines.py` → `site/baselines.json.gz`

- Frame = the same retention-windowed frame `build_site_data.py` publishes; bundled rows only
  for the new measures, all rows for `dps` / `deaths_30m` / `chain_30m` / `pots`.
- Per measure per cell: `n` and the seven quantiles; cells emitted at all three tiers when
  `n ≥ 20`. Rates use `combat_ms` (fallback `duration_s`).
- `priority` per dungeon: sums of begun/completed/interrupted per enemy spell over the window.
- `dispellable` per dungeon: debuff ids with `spellsInterrupted > 0` anywhere in the window.
- Health line in `build_health.txt` (the existing mechanism): cells filled, bundled-run share,
  gz size; sidecar omitted (never half-written) if the frame has no bundled rows.
- Tests: quantile edge cases, tier fallback, a fixture CSV, size cap.

## 5. Curated lists (the only manual upkeep)

`data/lists/<partition>.json`, versioned per patch, seeded by the collector:
- **Avoidable damage per dungeon**: seed from one `table(DamageTaken, viewBy: Ability,
  hostilityType: Friendlies)` per dungeon (1.2 points): candidates are Environment-sourced
  abilities and abilities whose per-player hit counts vary strongly within a run (some
  players 0, others ≥ 3); hand-confirm ~10 per dungeon.
- **Dangerous casts per dungeon**: automatic from the priority table (population
  interrupted ÷ begun ≥ 0.5 → dangerous; Fetid Spit at 4/120 drops out, Piercing Hiss at
  34/36 stays).
- **Defensives / self-heals / consumables per spec**: static, ~150 ids, stable for years
  (Healthstone 6262; 12.1 potions 1295247 / 1236994 / 1236616); validate 50 ids per point
  via `gameData.ability`.
- **Dispellable**: automatic (§4).
- **Tank busters / priority NPCs**: only needed by Set C; seed from the tank's top damage
  sources and `dungeonPulls.enemyNPCs`.

A missing list must drop the dependent measure (null), never score zero.

## 6. Consumer side (keylevel_addon)

- `docs/js/baselines.js`: fetch `baselines.json.gz` (native `DecompressionStream`), cache in
  localStorage keyed on `built` (30 min TTL), `cellFor(spec, dungeon, level)` with the
  fallback ladder, `percentile(cell, measure, value)`, `robustZ(...)`, `n` and tier exposed.
- Applicant-side tables per run (live, ~8 newest runs at listing level ± 2, pooled across
  dungeons, applied spec only): the same six tables (6 points/run) plus, for Set B/C, the
  Deaths events and one aliased request of ±10 s `DamageTaken` + `Healing` windows with
  `includeResources: true` per own death (2 points per death), and one filtered exposure
  pull (`resources.hpPercent < 40 and resources.maxHitPoints > 0`, 1 point/run).
  Measured: Set A ≈ 20 points; Set B ≈ 80–125 points per DPS applicant and ≈ 140–150 per
  healer (the healer triage stream is 6–10 MB per run, so live analysis caps at ~4 runs or
  uses the filtered sub-35 %/sub-60 % pulls at ~100 KB each); 3–8 MB and 3–8 s in parallel.
  Cache every finished run by `(code, fightID)` — a finished run never changes.
- `transform.js` / `render.js`: per-measure percentile chips with the cell `n` and tier,
  composite per the chosen set, "insufficient data" states; legend states the timed-run
  population.
- Tests: fixture baselines document, ladder, interpolation edges, sidecar-missing path.

## 7. Budget options for the shared client

| Option | Effect |
|---|---|
| Keep one client, collector at 85 % | Vetting has 2,700–8,000 points/hour depending on the collector's phase: 25–60 Set-B applicants/hour, or 130–400 Set-A. Tight on a busy evening. |
| Lower the collector's sweep cadence | Its README: the leaderboard re-scan is ~1,900 points per sweep and is the dominant cost; every-40-min instead of every-20 frees ~3,000/hour. |
| **Second WCL API client for the vetting site** | WCL's limit is documented per client (3,600/hour baseline; this account's is 18,000). Create a second client on the WCL client page, put its id/secret in the site's `config.js`, and the two projects stop competing. One `rateLimitData` call from the new client confirms it. Recommended. |

## 7b. What the collector's own data already says about ownership

Computed read-only from `mythic_runs.csv.gz` (756,595 player-rows at key ≥ 10, 15 days;
72,928 characters with ≥ 3 runs): the intraclass correlation of a player's DPS across
runs is 0.43 (DPS specs) / 0.65 (healers) / 0.52 (tanks), and 0.66 for level-normalised
DPS within a listing ± 2 window; for raw deaths it is 0.05 / 0.06 / 0.01. Runs from the
same upload or within three hours share a third of their DPS noise (the evening's group),
so an applicant's effective sample is ≈ 0.6 × their run count. These numbers set the
shrinkage in the measure sets (DPS needs 2–4 runs; raw deaths would need > 100) and are
recomputable by the builder every day at zero API cost.

## 8. Rollout

1. wowlogs: lists file + bundle + quota gate + CSV columns + `build_baselines.py` + tests;
   deploy on the default branch (the refresh workflow publishes from it). Cells for
   common specs at +12…+20 reach n = 100 within 2–4 days of bundled collection; the
   sidecar reports `n` per cell from day one.
2. keylevel_addon: `baselines.js` + Set A measures against the sidecar (works the moment
   the sidecar exists; DPS and deaths cells are full immediately because those columns
   need no bundle).
3. Set B/C applicant-side signals (death windows, self-save, healer triage) once the
   Set-A path is live.
