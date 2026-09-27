# PUG applicant measure sets — research recommendation (2026-09-27)

Inputs read: CONTEXT.md, integration.md, four designs, eight challenges, six verification reports. None missing.

## 0. Facts every set is built on

- Baselines=collector sidecar `baselines.json.gz`: cell `spec|dungeon|level`, ladder exact (n≥100)→2-level band→dungeon-pooled band→"no baseline"; quantiles p5…p95; population=timed leaderboard runs (98.8%). `dps`/`deaths_*`/`pots` cells are full on day one; bundle measures fill under the quota rule (+960 pts/h) in 2–4 days. A missing curated list nulls its measure.
- DPS ICC 0.43/0.65/0.52 (DPS/healer/tank), 0.66 level-normalised within listing±2; raw deaths 0.05/0.06/0.01. No death measure may be a percentile (Arms Altar +18 `deaths_30m` p5–p50=0).
- `encounterRankings(byBracket:false).ranks[].amount`≡`damageDone.total ÷ Summary.totalTime`≡the collector's `dps` (2e-5). Eight aliased calls (8 pts) list every S2 run (level, medal, spec, start, `report{code fightID}`), uncapped; filter `ranks[].spec` client-side.
- Applicant sample (listing±2, applied spec, season): Q1 13, median 30, min 4–6; 1–5 per dungeon;≈40% of runs share an upload (ρ 0.28–0.38)→n_eff≈0.6 n; 23% of teammate slots recur.
- 1 pt per table per fight (+0.5–2.5 cold), 1 pt per events page; the sub-35% HP filter cuts a fight's friendly DamageTaken to 65–110 KB; a healer's Healing stream is 6 MB/1.66 pt. Vetting has 2,700–8,000 pts/h beside the collector; a second WCL client ends the contest.
- Tables/events cover the 8 newest window runs (integration §6); the run list is free per run, so damage uses up to 15.

## 1. Set A — Minimal & live

Per run: Summary, Interrupts, `fights` (combat_ms); healers+Dispels+Healing. 8+8×3.5–5.5≈36–52 pts,<1 MB, two round-trips. No hand-curated lists: `priority` weights and `dispellable` are self-seeded.

| Measure | DPS | Healer | Tank |
|---|---|---|---|
| Damage | 66 | 14 | 50 |
| Priority-weighted kicks/min | 24 | 24 | 32 |
| Own deaths, tables-only rule | 10 | 14 | 18 |
| Own dispels/min | – | 32 | – |
| Effective healing/s (context) | – | 16 | – |

| Measure | WCL path | Estimator | Own | Min n | Live | Collector adds |
|---|---|---|---|---|---|---|
| Damage | `ranks[].amount`→percentile in the run's cell; timed runs only; depleted runs listed with `historicalPercent`, used at weight 0.5 only when<3 timed runs | recency-weighted median of run percentiles→z, k=1 | H (ICC 0.66) | 2/4 | 8 pts,≤15 runs | nothing |
| Kicks | `table(Interrupts)` `details[]` (zero-fill absentees)×sidecar `priority` w_s=interrupted÷begun; Σ w_s·own_s÷combat min | per-run `kick_prio` percentile→weighted median, k=3 | M (comp 40–60%) | 4/7 | 1 pt/run | Interrupts (in bundle) |
| Deaths | `Summary.deathEvents{deathTime ability}` | §4, tables-only costs | L raw→M | flag 2, penalty 4 | 0 | `deaths_chain` export |
| Dispels | `table(Dispels)` `details[]` | own÷combat min, percentile, weighted median, k=3 | M | 4/7 | 1 pt/run | Dispels (in bundle) |
| Effective healing | `table(Healing)` (total−overheal)÷s | percentile, weighted median, k=4, labelled "demand-driven" | L–M | 4/9 | 1 pt/run | Healing (in bundle) |
| Potions | `Summary.playerDetails.*[].potionUse` (null when absent) | pass if≥1 in≥60% of runs with the field; fail→−3; never positive | H | 3 | 0 | `pots` export |

Set A's healer composite lacks a triage signal; show components.

## 2. Set B — PUG-robust execution

Adds per run: filtered DamageTaken (avoidable list), filtered Casts (defensives), Deaths events, enemy `begincast` events on the dangerous list, the sub-35% exposure pull, own filtered Casts events (1 pt each), ±10s `DamageTaken`+`Healing` windows per own death (2/death); healers: unfiltered Healing+Casts events on the 4 newest runs (2.7 pts, 6 MB each).≈100 pts (DPS), 105 (tank), 120–150 and ~25 MB (healer); 3–8s.

| Measure | DPS | Healer | Tank |
|---|---|---|---|
| Damage (A+0.25 Δ) | 50 | 10 | 30 |
| Kick utilisation, isolated opportunities | 18 | 10 | 20 |
| Self-save/defensive coverage of own sub-35% hits | 10 | 6 | 20 |
| Own-fault deaths, full rule | 10 | 8 | 16 |
| Avoidable damage/min | 12 | 8 | 14 |
| Triage latency B+no-output share | – | 36 | – |
| Missed own-class dispels+own dispels/min | – | 22 | – |

| Measure | WCL path | Estimator | Own | Min n | Live | Collector adds |
|---|---|---|---|---|---|---|
| Damage Δ (DPS specs) | `Summary.damageDone[]`+`playerDetails.specs`→teammates' `total ÷ totalTime` in their own `dps` cells | Δ_r=own percentile−mean of the other two DPS; Δ*=n·Δ̄÷(n+3); score=A*+0.25 Δ*; off when a teammate recurs≥3 of 8 | M | 4 | 0 | nothing |
| Kick utilisation | sidecar `kick_util`; `events(Casts, hostilityType:Enemies, filterExpression:"type=\"begincast\" and ability.id in (<dangerous>)")`+own kicks from `events(Casts, sourceID)` (absent from the Casts table) | own kicks÷min(dangerous begun while alive, combat min÷kick CD); a miss counts only when isolated (no party kick within 1s,≤1 concurrent cast, alive); percentile, weighted median, k=3 | M–H | 4/7 | 2 pts/run | `kick_util` (Interrupts-based→applicant percentile conservative) |
| Self-save | `events(DamageTaken, hostilityType:Friendlies, includeResources:true, filterExpression:"resources.hpPercent < 35 and resources.maxHitPoints > 0")` (all five; hits carry `buffs`, `unmitigatedAmount`, x, y)+`events(Casts, sourceID:own, filterExpression:"ability.id in (<spec kit + 6262 + potions>)")` | episode = ≥2 sub-35% hits≥1.5s apart within 8s; answered=kit cast in [−3, +3s] of the first hit or a kit id in `buffs`; answered÷episodes, absolute vs the +16/+22 reference; CD=min(baseline, observed min gap); Blood dropped | H (episode count is teammates') | 4 episodes≈3 runs | 2 pts/run | none; `def_casts_min` fallback |
| Deaths | `events(Deaths)` `killerID killingAbilityGameID`+aliased windows with `includeResources`→all five `hitPoints/maxHitPoints`, healer mana (`classResources` type 0 where she is target), x,y (yards×100) | §4 full rule | H after attribution | flag 2, penalty 4 | 1+2/death | none |
| Avoidable damage | `table(DamageTaken, filterExpression:"ability.id in (<dungeon list, ≤ 5>)")` `total` per player (no hit counts exist) | ÷ combat min; each run in its dungeon cell, pooled weighted median, k=2.5, low=good; Environment excluded; a charged death's killing hit subtracted via the window events | M–H | 4/6 | 1 pt/run | `avoid_dmg_min` (in bundle); ~10 ids/dungeon from `viewBy:Ability` |
| Triage (healer) | `events(Healing, sourceID:healer, includeResources:true)` unfiltered (a post-heal HP filter drops the responding heal)+exposure pull+`events(Casts, sourceID:healer, includeResources:true)` | episode=non-healer ally<35% at a hit, healer alive, isolated (no other ally<35% at start); latency to her first direct heal/absorb (Beacon, pre-laid absorbs excluded), censored 5s; per-run median, p90, no-output share; absolute (+22 reference: 0.55s/1.7s); episodes/min shown as context | M–H | 3 runs (~70 episodes each) | 2.7 pts×4 | none; calibration≈300 fights/spec×band (~4k pts) |
| Dispels | `table(Dispels)` `spellsCompleted` on class-dispellable ids (static map ∩ sidecar `dispellable`)+own `details[]` | missed÷applications (0.5; only debuffs dispelled≥1× that fight appear)+own/min percentile (0.5) | M–H | 4/7 | 1 pt/run | Dispels (in bundle) |

Flags: mana casts<10% or pull end<20% (healer cast rows, 1 pt); preventable ally death (ally<50%≥3s, healer alive, mana≥15%,≤40 yd, no direct heal 3s — 0 of 9 reference deaths); recurring teammate; `active_share`<0.85.

## 3. Set C — Role-complete PUG

Adds: tanks `table(Buffs, abilityID:<AM>)`, buster events, downtime from `fights` (1 pt each); DPS boss-segment `table(DamageDone, filterExpression:"target.id in (<boss gameIDs>)")` (2), CC alias (1); healers friendly Debuffs events (2.1)+Dispels events (3) on≤4 runs, emergency CDs (0).≈120 (DPS), 130 (tank), 160 (healer).

| Measure | DPS | Healer | Tank |
|---|---|---|---|
| Damage (as Set B) | 50 | 10 | 26 |
| Boss-segment damage | 6 | – | – |
| Kick utilisation | 16 | 8 | 14 |
| CC stops | 4 | – | 4 |
| Self-save | 6 | 6 | 4 (non-Blood) |
| Own-fault deaths (tank: first-in-chain add-on) | 8 | 8 | 12 |
| Avoidable damage | 10 | 8 | 8 |
| Active-mitigation uptime (Blood: Death Strike≤3s after a buster) | – | – | 14 |
| Tank-buster coverage | – | – | 12 |
| Downtime share | – | – | 6 |
| Triage latency+no-output share | – | 34 | – |
| Missed own-class dispels>3s+dispel latency | – | 18 | – |
| Emergency cooldowns under duress | – | 8 | – |

| Measure | WCL path | Estimator | Own | Min n | Live | Collector adds |
|---|---|---|---|---|---|---|
| Boss-segment | boss gameIDs from `fights.dungeonPulls.enemyNPCs`→filtered DamageDone | own boss share÷own total share, percentile, k=3 | M–H | 3 | 2 pts/run | `boss_share` (+1 pt/run); display-only until it exists |
| CC stops | `table(Casts, filterExpression:"ability.id in (<spec CC ≤ 5, pull utility excluded>)")`; pets→owner via `masterData.actors(type:"Pet"){petOwner}` | ÷ combat min, percentile capped at p60, k=3 | M | 4/7 | 1 pt/run | `cc_casts_min` (+1 pt/run) |
| AM uptime | `table(Buffs, abilityID:<AM id>)` `auras[].totalUptime`÷combat_ms; Blood: buster hits followed by Death Strike≤3s÷buster hits | weighted mean, k=1; zero-variance cell drops the measure | H | 3 | 1 pt/run | `am_uptime` (+1 pt/run on tank rows,≈+190 pts/h) |
| Buster coverage | `events(DamageTaken, targetID:tank, filterExpression:"ability.id in (<busters>)")`→hits whose `buffs` hold an own AM/defensive id (externals excluded)÷hits | absolute | H | 6 hits | 1 pt/run | none; list seeded from `viewBy:Ability targets[]` tank share≥90% |
| Downtime share | `fights.dungeonPulls`: Σ gaps÷fight length, dropping the run-in, gaps≤1s and gaps within 60s after a death; gap cap 15s | dungeon×level percentile, weighted median, k=8 | L–M | 6 | 1 pt/run | `downtime_share` (needs `fights`) |
| Dispels>3s+latency | + `events(Debuffs, hostilityType:Friendlies, filterExpression:"ability.id in (<class-dispellable>)")`+`events(Dispels)` | missed=applications>3s undispelled by anyone÷applications (0.5); own median latency (0.5), absolute | H | 4 | 5 pts×4 | none |
| Emergency CDs | exposure pull+healer Casts events filtered to major CDs | duress = ≥2 allies<40% within 3s; responded=CD in [−2, +4s] or active; share | H | 4 episodes | 0 | none |
| Tank first-in-chain | own solo death followed by≥2 party deaths within 10s | +0.25 per follower, cap 1.5; chain/duress tests precede | | | | |

Dropped after challenge: external healing on the tank (beacon-driven), aggro deaths (1 of 9, inverted 15-yd test), party-duress time, timed rate and medal tier (context only), uptime as a weight. Flags as Set B.

## 4. Shared rules

**Run window.** Current partition; applied spec; level ∈ [L−2, L+2], widened to [L−4, L+3] when<3 runs; dedupe (encounter, level, |Δstart|<120s). Recency u=0.5^(age/45 d), floor 0.2; n_eff=min((Σu)²/Σu², distinct upload sessions), session=same report code or start within 3 h.

**Cell and score.** Each run is scored in its own sidecar cell (tier and n exposed), then pooled across dungeons; per-dungeon n is never required. Value→interpolated percentile clamped [2, 98]→z=Φ⁻¹. Weighted median where one run can dominate (DPS, kicks, avoidable, dispels, downtime), weighted mean for own-dominated rates (AM uptime, defensives); z*=n_eff·z̄÷(n_eff+k). The weighted p25 is shown as text and blended at 0.15 only when n_eff≥8 (below that it is the worst-teammates run).

**Recurring teammates.** From the Summary composition of the bundled runs: anyone in≥3 of 8→flag, Δ and kick-share terms off, n_eff×0.6.

**Composite.** Σ w·z*÷Σ w over present measures, shown as Φ(composite) with n_eff and tier; only when present weight≥60 and damage is present, else components only. Potions gate −3. Legend: reference=timed leaderboard runs, percentiles conservative.

**Insufficient n.** "insufficient data (n=3, need 4)"; the measure leaves the composite and weights renormalise; hollow marker between show and full; "no baseline" when the cell has n<20 after the ladder; never impute 0 or 50; a death count is never a percentile; the classified death list always sits beside the score.

**Death rule.** Per own death, first match wins:

| Class | Test | Cost |
|---|---|---|
| Chain | another party death in the prior 5s, or≥2 members already dead; a cluster's earliest death is judged on its own merits | 0.10 |
| One-shot | HP≥80% at t−1s, or first sub-35% sample<1.5s before death | 0.25 |
| Shared duress | in the prior 5s: healer dead / mana<15% / >40 yd / <40% HP / no direct heal on the applicant, or≥2 other members<40% HP | 0.15 |
| Solo-avoidable | warning≥1.5s and a baseline-kit defensive, self-heal or potion available (CD=min(baseline, observed min gap); talent spells only once seen) and unused | 1.00 |
| Unclear | otherwise, incl. missing list or events | 0.25 |

Tables-only (Set A): chain 0.10, everything else 0.30. Environment (`killerID −1`) is shared damage, never an avoidability signal; an avoidable-list killing blow is a one-shot here and stays in the avoidable-damage measure.

Pooling: W=Σ cost over window runs (per-run cap 2.0); allowance a=1+0.25·n_runs (pinned; population mean 0.30 deaths/run, p90=1); E=max(0, W−a); composite loss=w×min(1, E÷3). No positive credit: zero deaths and one solo death both cost 0. Flags: "repeated own-fault deaths" when≥2 window runs contain a solo death; "same cause" when≥2 deaths share a `killingAbilityGameID`.

Checks: one solo death in 6 runs→W 1.0<a 2.5→0; one every run for 6→E 3.5→full weight; three in 30 runs→0; five chain deaths in five runs→0. P3j1 fight 8: #1 duress (others at 6/1/18/4%) 0.15; #2–5 chain 0.10; #6 one-shot (0.9s warning) 0.25; #7 solo (28–52% for 5s, five defensives up, healer healing him) 1.00; #8 one-shot 0.25→rogue 0.60, warrior 1.10, others≤0.15; nobody loses points; the warrior is flagged only on recurrence.

## 5. What changed versus the pre-PUG sets and why

- **Deaths 20–35→8–18, absolute, allowance-based.** Brief: "one-off deaths should not be penalized as highly". Raw deaths carry ICC≤0.06 and 7 of 8 reference deaths were chain or duress. The first solo death in a window costs nothing, chain deaths never move the score, no percentile, no luck credit.
- **DPS raised to 46–66 (DPS specs), 26–50 (tanks), 10–14 (healers).** "DPS should remain more important": the only measure with a measured own-share (0.66), so it carries the composite; "a healer in a pug may not focus as much on DPS": small but non-zero.
- **Shared duress is a death class**, matching "the healer was weak and others came close to death … over that threshold": healer HP, mana, range, last heal and two other members low are read from the party HP timeline.
- **HPS replaced by demand-conditional response.** "If the other players are good, the HPS numbers would be lower": triage latency and no-output share on isolated near-death episodes (86 per run vs 1 death) are the healer's; episode rate is context; Set A keeps effective healing only as labelled context.
- **Share-of-group measures demoted or conditioned**: kicks per minute priority-weighted, then utilisation on isolated opportunities; Δ damage at 0.25 and off for fixed cores, detected free from the Summary composition.
- **Baselines from the collector's timed population**, labelled; medal stratum and timed rate removed (no untimed rows; logged timed share 0.85–1.00).
- **Window widened** to 15 runs for damage, n_eff discounted for same-evening runs, no per-dungeon n; uptime, mana, preventable deaths and pull pace reduced to flags or small weights because their variance is teammates' or zero.

## 6. Disagreements resolved

1. `amount` vs combat-minute DPS: adv_data_dps_first's identity beats design_dps_first's ban; merged pulls are 88–97% of fight length. Combat minutes stay the denominator for kicks, dispels and avoidable damage.
2. Floor 0.35 (dps_first) vs none (statistics): the statistician and both confound reviews win — at n<8 the lower quartile is the worst-teammates run; 0.15 at n_eff≥8, text otherwise.
3. Plus-minus at 0.5 (attribution, dps_first)→0.25 and off for recurring cores (adv_confound_attribution: ±1.5 composite points of noise at n=6).
4. Duress threshold: verify_hp's "≥ 1 other<40%" fires on 7 of 8 deaths and holds 13–20% of all fight seconds (adv_data_attribution replay), so it never finds an own death. "≥ 2 others" plus verify_defensives' 1.5s warning and kit tests win; verify_hp's healer-state clauses stay. Only death #7 becomes solo, verify_defensives' one clean case.
5. Death percentiles (attribution, role_pug, statistics designs) lose to all three confound reviews (one death=4–14 composite points against a zero-inflated timed population); adv_confound_dps_first's pinned allowance and adv_confound_statistics' no-positive-credit rule are adopted; Gamma/escalation machinery dropped.
6. Environment "avoidable by construction" (attribution) refuted by measurement (all five players 6.2–7.2 M, CV 0.06).
7. Preventable ally deaths at 16–20 (three designs)→flag: 0 of 9 reference deaths qualify; verify_healer's triage latency replaces it.
8. Kick opportunity: role_pug's "completed while available" (charged the tank 13 misses despite 24 kicks)→isolated-opportunity rule with begincast events, because the Interrupts table omits spells nobody kicked.
9. `hitCount` in filtered DamageTaken does not exist (adv_data_dps_first, role_pug)→damage per minute.
10. Cost: designs' 70–120 pts and 120–200 applicants/h lose to verify_cost and integration §7 (2,700–8,000 spare pts/h; Set B 25–60/h).
11. "Newest 8" (all designs)→15 runs for damage, 8 for tables; 30-day windows rejected (verify_sample Q1=6).

## 7. Verified facts relied on/still unverified

Verified live: table and events pricing; the `amount` identity; uncapped kill list, spec unfiltered by metric; Interrupts/Dispels shapes and their "only if acted on once" bias; filtered Casts≤5 ids per alias with exact `total`; `potionUse` present (the "absent" reading came from another query shape); `resourceActor` 2=target, x,y=yards×100, `buffs` on damage events; the working HP filter; `table(Buffs, abilityID)` per-player uptime; `target.id in (…)` on DamageDone; `dungeonPulls` are combat segments; healer stream 6 MB/1.66 pt; mana never<63% in a timed +22; triage counts and latencies; Environment damage shared; `table(Resources)` empty; pet→owner via `petOwner`; population 98.8% timed with degenerate death quantiles; ICCs; sample sizes, recurrence, ρ_session.

Unverified: `historicalPercent`'s reference pool (used only for depleted runs); the death-rule thresholds as discriminators (9 deaths, two fights); `< 60` filtered Healing bias (avoided by fetching unfiltered);>5 ids in one filtered Casts alias; `healthstoneUse`; per-spec kick cooldowns and the class→dispel map (game knowledge); talent-driven CDs (calibration converges in a few fights); the collector's source for `active_ms`; ICC of attributed deaths (validation: split-half r must exceed 0.17); Δ under Augmentation Evokers.

## 8. Build first

Build Set A first: it works the day the sidecar exists because its damage and death cells need no bundle, costs≈40 pts and two round-trips per applicant, uses no hand-curated list, and already meets the brief — 66% of a DPS applicant's composite is the one signal with a measured own-share of 0.66, and the tables-only death rule makes a one-off free; its kick and dispel cells fill within days under the quota gate. Then add Set B's applicant-side signals in the order death windows→kick opportunities→self-save→healer triage, behind the second WCL client (Set B is 100–150 pts per applicant); promote to Set C only after the tank-buster and boss lists are curated and the collector exports `am_uptime`, `boss_share` and `cc_casts_min`, since Set C's extra rows are the most curation-dependent and least own-controlled.


## Revisions after use

- **Flags.** Only "repeated own-fault deaths" is shown. Dying to the same
  ability twice is recorded but not flagged (circumstance as often as habit).
  A recurring core is detected only to switch the share measures off; it says
  nothing about the player, so it is not a flag.
- **Potion gate dropped.** Potion use is preparation, not ability, and the −3
  was a weak signal in +10 pugs. Potions still count as a self-save when one
  answers a low-HP episode.
- **Cell ladder per measure.** An execution measure is judged against the
  finest cell that has quantiles for it and enough bundled rows (`n_exec`),
  so the pooled spec × band cell serves it weeks before the exact cell does;
  damage keeps its own ladder on `n`.
