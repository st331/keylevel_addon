import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, pctSpan, pctTag, bamHTML, ageText, anyCellHTML, dungeonCellHTML, nameHTML, profileLinkHTML, detailMatrixHTML, summaryHTML, roleChipsHTML, formatAmount, metricLabel, nextSort, validSort } from "../docs/js/render.js";
import { playerFromResult, buildRolePlayers } from "../docs/js/transform.js";

const AK = 12660, COT = 12669;
const ENCOUNTERS = [
  { id: AK, name: "Ara-Kara, City of Echoes" },
  { id: COT, name: "City of Threads" },
];

const alice = playerFromResult({
  classID: 4,
  [`e${AK}`]: { ranks: [{ rankPercent: 91.2, bracketData: 12, spec: "Fire" }] },
  [`e${COT}`]: { ranks: [{ rankPercent: 71.0, bracketData: 12, spec: "Fire" }] },
});
const ghost = playerFromResult(null);

test("esc neutralizes html", () => {
  assert.equal(esc('<img src=x onerror="a">&\''), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
});

test("pctSpan floors and colors", () => {
  assert.equal(pctSpan(99.6), '<span class="pct tier-pink">99%</span>');
});

test("pctTag suffixes and bamHTML best/avg/median", () => {
  assert.equal(pctTag(99.6, "b"), '<span class="pct tier-pink">99<i class="sfx">b</i></span>');
  const html = bamHTML(91.2, [91.2, 71.0]);
  assert.match(html, />91<i class="sfx">b</, "best");
  assert.match(html, />81<i class="sfx">a</, "average of 91.2 and 71");
  assert.match(html, />81<i class="sfx">m</, "median");
  const single = bamHTML(91.2, undefined);
  assert.match(single, />91<i class="sfx">b<.*>91<i class="sfx">a<.*>91<i class="sfx">m</,
    "no run list -> best repeated");
});

test("anyCellHTML states", () => {
  assert.match(anyCellHTML({ status: "NO_WCL" }, 12), /no WCL character/);
  const at = anyCellHTML({ status: "OK", anyAtLevel: { pct: 91.2, runs: 2, pcts: [91.2, 71.0] } }, 12);
  assert.match(at, />91<i class="sfx">b</);
  assert.match(at, />81<i class="sfx">a</);
  assert.match(at, />81<i class="sfx">m</);
  assert.match(at, /2 dungeons/);
  assert.match(anyCellHTML({ status: "OK", anyBest: { pct: 80, level: 14 } }, 12), /none at \+12 · best.*\+14/);
  assert.match(anyCellHTML({ status: "OK" }, 12), /no logs \+8–\+16/, "no-logs message names the window");
  assert.match(anyCellHTML({ status: "OK", anyBest: { pct: 80, level: 14 } }, null), /best:.*\+14/);
  assert.match(anyCellHTML({ status: "OK" }, null), /no M\+ logs/);
});

test("dungeonCellHTML states", () => {
  const mk = (kind, level) => ({ status: "OK", dungeon: { pct: 76.4, level, spec: "Fury", kind } });
  assert.match(dungeonCellHTML(mk("exact", 12), 12, AK), /@\+12/);
  assert.match(dungeonCellHTML(mk("above", 14), 12, AK), /@\+14 \(higher\)/);
  assert.match(dungeonCellHTML(mk("below", 11), 12, AK), /@\+11 \(one below\)/);
  assert.match(dungeonCellHTML({ status: "OK", dungeonBest: { pct: 55, level: 9 } }, 12, AK), /only lower · best.*\+9/);
  assert.match(dungeonCellHTML({ status: "OK" }, 12, AK), /never logged/);
  assert.match(dungeonCellHTML({ status: "OK" }, 12, null), /—/);
});

test("ageText buckets", () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;
  assert.equal(ageText(now - day / 2, now), "today");
  assert.equal(ageText(now - 6 * day, now), "6d");
  assert.equal(ageText(now - 44 * day, now), "44d");
  assert.equal(ageText(now - 90 * day, now), "3mo");
  assert.equal(ageText(undefined, now), null);
  assert.equal(ageText(0, now), null);
});

test("dungeonCellHTML appends the run's age", () => {
  const when = Date.now() - 90 * 86_400_000;
  const ev = { status: "OK", dungeon: { pct: 76.4, level: 12, spec: "Fury", kind: "exact", when } };
  assert.match(dungeonCellHTML(ev, 12, AK), /· 3mo/);
  const noWhen = { status: "OK", dungeon: { pct: 76.4, level: 12, spec: "Fury", kind: "exact" } };
  assert.doesNotMatch(dungeonCellHTML(noWhen, 12, AK), /· (today|\d)/);
});

test("matrix cells carry the run date in the tooltip", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ historicalPercent: 91.2, bracketData: 12, amount: 100, startTime: Date.UTC(2026, 5, 6), report: { code: "C0DE", fightID: 1 } }] },
  });
  const html = detailMatrixHTML(p, ENCOUNTERS, 12);
  assert.match(html, /title="run on 2026-06-06 — 100 DPS — open its report"/);
});

test("dungeonCellHTML shows run consistency via b/a/m", () => {
  const ev = { status: "OK", dungeon: { pct: 91.2, level: 12, spec: "Fire", kind: "exact", pcts: [91.2, 60] } };
  const html = dungeonCellHTML(ev, 12, AK);
  assert.match(html, />91<i class="sfx">b</);
  assert.match(html, />76<i class="sfx">a</, "average of 91.2 and 60");
  assert.match(html, />76<i class="sfx">m</);
  assert.match(html, /@\+12 · Fire/);
});

test("roleChipHTML", async () => {
  const { roleChipHTML } = await import("../docs/js/render.js");
  assert.match(roleChipHTML("healer"), /role-healer/);
  assert.match(roleChipHTML("healer"), />H</);
  assert.match(roleChipHTML("healer"), /HPS/, "healer tooltip explains the metric");
  assert.match(roleChipHTML("tank"), />T</);
  assert.match(roleChipHTML("dps"), />D</);
  assert.equal(roleChipHTML(null), "");
  assert.equal(roleChipHTML(undefined), "");
});

test("roleChipsHTML: single role -> plain chip; multi-role -> sel/dim buttons", () => {
  const single = roleChipsHTML({
    fullName: "Solo-Realm", selected: "healer", detected: "healer",
    byRole: { healer: { role: "healer", levels: {} } },
  });
  assert.match(single, /<span class="role role-healer"/, "one role: not a button");

  const multi = roleChipsHTML({
    fullName: "Multi-Realm", key: "Multi-Realm@us", selected: "healer", detected: "healer",
    byRole: { tank: { role: "tank", levels: {} }, healer: { role: "healer", levels: {} } },
  });
  assert.match(multi, /<button[^>]*role-healer sel"/, "viewed role is solid");
  assert.match(multi, /<button[^>]*role-tank dim"/, "other role dimmed");
  assert.match(multi, /data-key="Multi-Realm@us"/);
  assert.match(multi, /data-role="tank"/);
  assert.match(multi, /click to judge/, "dimmed chip explains the click");
  assert.doesNotMatch(multi, /role-dps/, "unplayed role has no chip");

  // legacy shape (no byRole): falls back to the player's role
  const legacy = roleChipsHTML({ fullName: "Old-Realm", player: { role: "tank" } });
  assert.match(legacy, /<span class="role role-tank"/);
});

test("roleChipsHTML follows entry.order and shows top-key counts", () => {
  // deliberately NOT 8 total: a hardcoded per-season denominator must fail
  const html = roleChipsHTML({
    fullName: "Multi-Realm", selected: "healer", detected: "healer",
    order: ["healer", "tank", "dps"],
    topKeys: { healer: { keys: 4, score: 1800 }, tank: { keys: 3, score: 1300 } },
    byRole: {
      tank: { role: "tank", levels: {} },
      healer: { role: "healer", levels: {} },
      dps: { role: "dps", levels: {} },
    },
  });
  const h = html.indexOf("role-healer"), t = html.indexOf("role-tank"), d = html.indexOf("role-dps");
  assert.ok(h >= 0 && h < t && t < d, "chips render in top-key order, not fixed T/H/D");
  assert.match(html, /holds 4 of their 7 top keys/, "solid chip tooltip");
  assert.match(html, /holds 3 of their 7 top keys/, "dimmed chip tooltip");
  assert.doesNotMatch(html, /holds 0/, "topless dps chip gets no count");
});

test("detailMatrixHTML: hps-metric tables link to the healing tab", () => {
  const hpsRanks = { ranks: [{ historicalPercent: 88.0, bracketData: 12, amount: 900, spec: "Mistweaver", report: { code: "HEALC0DE", fightID: 5 } }] };
  const healer = playerFromResult({ classID: 5, [`e${AK}`]: hpsRanks }, "healer", "healer");
  healer.metric = "hps"; // as buildRolePlayers tags it
  const html = detailMatrixHTML(healer, ENCOUNTERS, 12);
  assert.match(html, /\?fight=5&type=healing"/, "healing tab, not damage-done");

  // the metric decides, not the role: a healer-role table built from dps
  // percentiles (fallback path) must keep damage-done links
  const fallback = playerFromResult({ classID: 5, [`e${AK}`]: hpsRanks }, "healer", "healer");
  assert.match(detailMatrixHTML(fallback, ENCOUNTERS, 12), /type=damage-done"/);
});

test("summaryHTML with byRole entries: active view renders, sort follows detected", () => {
  // switcher viewed as tank (weak) but detected healer (strong): the row
  // must SORT by the healer table while SHOWING the tank numbers
  const dps = {
    classID: 5,
    [`e${AK}`]: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 20.0, amount: 100, startTime: 1000 },
      { spec: "Mistweaver", score: 450, bracketData: 12, historicalPercent: 10.0, amount: 50, startTime: 2000 },
    ] },
  };
  const hps = {
    classID: 5,
    [`e${AK}`]: { ranks: [
      { spec: "Brewmaster", score: 400, bracketData: 12, historicalPercent: 2.0, amount: 10, startTime: 1000 },
      { spec: "Mistweaver", score: 450, bracketData: 12, historicalPercent: 95.0, amount: 900, startTime: 2000 },
    ] },
  };
  const { detected, byRole } = buildRolePlayers(dps, hps);
  const entries = [
    { fullName: "Switch-Realm", detected, selected: "tank", byRole, player: byRole.tank, slug: "realm", region: "us" },
    { fullName: "Alice-Area52", player: alice, slug: "area-52", region: "us" },
  ];
  const html = summaryHTML(entries, { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS });
  assert.ok(html.indexOf("Switch-Realm") < html.indexOf("Alice-Area52"),
    "healer 95 (detected) outsorts Alice's 91.2 even while the tank view is shown");
  assert.match(html, />20<i class="sfx">b</, "tank view's numbers rendered");
  assert.doesNotMatch(html, />95<i class="sfx">b</, "healer numbers not shown while tank is selected");
  assert.match(html, /data-key="Switch-Realm"/, "rows carry data-key (fullName fallback) for re-render state");
});

test("summaryHTML keeps same-name characters from different regions distinct", () => {
  const entries = [
    { fullName: "Twin-Realm", key: "Twin-Realm@us", player: alice, slug: "realm", region: "us" },
    { fullName: "Twin-Realm", key: "Twin-Realm@eu", player: alice, slug: "realm", region: "eu" },
  ];
  const html = summaryHTML(entries, { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS });
  assert.match(html, /data-key="Twin-Realm@us"/, "each row keyed by full@region");
  assert.match(html, /data-key="Twin-Realm@eu"/);
});

test("formatAmount is compact and never reads '1000k'", () => {
  assert.equal(formatAmount(845), "845");
  assert.equal(formatAmount(21053.914), "21.1k");
  assert.equal(formatAmount(850_000), "850k");
  assert.equal(formatAmount(999_999), "1M", "rounds up a unit instead of 1000k");
  assert.equal(formatAmount(1_250_000), "1.25M");
  assert.equal(formatAmount(12_400_000), "12.4M");
  assert.equal(formatAmount(1_500_000_000), "1.5B");
  assert.equal(formatAmount(0), null, "no run, no number");
  assert.equal(formatAmount(0.4), null, "sub-1 never renders as a bare '0'");
  assert.equal(formatAmount(-5), null);
  assert.equal(formatAmount(Infinity), null);
  assert.equal(formatAmount(999_499), "999k", "just under the unit boundary");
  assert.equal(formatAmount(999_499_999), "999M");
  assert.equal(formatAmount(999_500_000), "1B");
  assert.equal(formatAmount(undefined), null);
  assert.equal(formatAmount(NaN), null);
  assert.equal(formatAmount("120"), null, "strings are not amounts");
});

test("metricLabel follows the table's metric, not its role", () => {
  assert.equal(metricLabel({ metric: "hps", role: "healer" }), "HPS");
  assert.equal(metricLabel({ metric: "dps", role: "tank" }), "DPS");
  assert.equal(metricLabel({ role: "healer" }), "DPS", "unlabeled fallback table is dps data");
  assert.equal(metricLabel(null), "DPS");
});

test("detailMatrixHTML shows each run's throughput under its percentile", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ historicalPercent: 91.2, bracketData: 12, amount: 1_250_000, spec: "Fire", startTime: Date.UTC(2026, 5, 6), report: { code: "C0DE", fightID: 3 } }] },
    [`e${COT}`]: { ranks: [{ historicalPercent: 71.0, bracketData: 12, amount: 990_000, spec: "Fire" }] },
  });
  const html = detailMatrixHTML(p, ENCOUNTERS, 12);
  assert.match(html, /91%<\/span><span class="amt" title="DPS">1\.25M<\/span>/, "amount sits under the pct");
  assert.match(html, />990k</, "the second dungeon's dps too");
  assert.match(html, /title="run on 2026-06-06 — 1\.25M DPS — open its report"/, "tooltip names the metric");
  assert.match(html, /Top number = Key % .* under it = DPS on that run/, "legend under the matrix");
  // stats rows average the throughput the same way they average percentiles
  const stats = html.slice(html.indexOf("Average"));
  assert.match(stats, />1\.12M</, "average of 1.25M and 990k");

  // healer tables are HPS end to end
  const healer = playerFromResult({
    classID: 5,
    [`e${AK}`]: { ranks: [{ historicalPercent: 88.0, bracketData: 12, amount: 640_000, spec: "Mistweaver" }] },
  }, "healer", "healer");
  healer.metric = "hps";
  const hHtml = detailMatrixHTML(healer, ENCOUNTERS, 12);
  assert.match(hHtml, /<span class="amt" title="HPS">640k<\/span>/);
  assert.match(hHtml, /under it = HPS on that run/);
  assert.doesNotMatch(hHtml, /DPS/, "a healing table never says DPS");
});

test("stats rows summarize throughput only when every dungeon has one", () => {
  // one dungeon at +12 carries an amount, the other doesn't: the percentile
  // average covers both, so an amount "average" over just one would lie
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ historicalPercent: 90, bracketData: 12, amount: 1_000_000, spec: "Fire" }] },
    [`e${COT}`]: { ranks: [{ historicalPercent: 50, bracketData: 12, spec: "Fire" }] },
  });
  const stats = detailMatrixHTML(p, ENCOUNTERS, 12).slice(detailMatrixHTML(p, ENCOUNTERS, 12).indexOf("Average"));
  assert.match(stats, /70%/, "percentiles still averaged across both dungeons");
  assert.doesNotMatch(stats, /1M/, "no partial-population throughput average");
});

test("detailMatrixHTML tolerates runs with no amount", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ historicalPercent: 91.2, bracketData: 12, spec: "Fire" }] },
  });
  const html = detailMatrixHTML(p, ENCOUNTERS, 12);
  assert.match(html, /91%/);
  assert.doesNotMatch(html, /class="amt"/, "no amount, no empty line");
});

test("scoresHTML shows both seasons with a safe colour", async () => {
  const { scoresHTML } = await import("../docs/js/render.js");
  const html = scoresHTML([
    { slug: "season-mn-2", label: "S2", all: 3515, tank: 0, healer: 0, dps: 3515, color: "#ff8000" },
    { slug: "season-mn-1", label: "S1", all: 4350.5, tank: 3682, healer: 3389, dps: 670, color: "#e268a8" },
  ]);
  assert.match(html, /<i>S2<\/i><b style="color:#ff8000">3515<\/b>/);
  assert.match(html, /<i>S1<\/i><b style="color:#e268a8">4351<\/b>/, "rounded for display");
  assert.match(html, /tank 3682 · healer 3389 · dps 670/, "role split in the tooltip");
  assert.match(html, /Raider\.IO/, "attributed so the number's origin is clear");
  assert.equal(scoresHTML(null), "", "no scores, nothing rendered");
  assert.equal(scoresHTML([]), "");

  // a colour the parser rejected must not become an attribute
  const noColor = scoresHTML([{ slug: "season-mn-2", label: "S2", all: 100, tank: 0, healer: 0, dps: 100, color: null }]);
  assert.doesNotMatch(noColor, /style=/);
  assert.match(noColor, /<b>100<\/b>/);
});

test("summaryHTML places scores in the applicant cell, not a new column", () => {
  const entries = [{
    fullName: "Alice-Area52", key: "k", player: alice, slug: "area-52", region: "us",
    scores: [{ slug: "season-mn-2", label: "S2", all: 3515, tank: 0, healer: 0, dps: 3515, color: "#ff8000" }],
  }];
  const html = summaryHTML(entries, { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS });
  assert.match(html, /class="scores"/);
  const headers = (/<thead>([\s\S]*?)<\/thead>/.exec(html)[1].match(/<th[ >]/g) ?? []).length;
  assert.equal(headers, 4, "still four columns: applicant, key fit, any dungeon, this dungeon");
  // the score sits inside the same cell as the name
  const cell = /<td>([\s\S]*?)<\/td>/.exec(html)[1];
  assert.match(cell, /Alice-Area52/);
  assert.match(cell, /3515/);
});

test("nameHTML uses class color and escapes", () => {
  const html = nameHTML("Foo<bar>-Realm", "MAGE");
  assert.match(html, /#3fc7eb/);
  assert.match(html, /Foo&lt;bar&gt;-Realm/);
});

test("detailMatrixHTML renders matrix with target column and skips empty dungeons", () => {
  const html = detailMatrixHTML(alice, ENCOUNTERS, 12);
  assert.match(html, /<th class="target-level">\+12<\/th>/);
  assert.match(html, /Ara-Kara/);
  assert.match(html, /91%/);
  assert.equal(detailMatrixHTML(ghost, ENCOUNTERS, 12), "");
  assert.match(detailMatrixHTML(playerFromResult({ classID: 4 }), ENCOUNTERS, 12), /No Mythic\+ logs/);
});

test("detailMatrixHTML links each percentile to its source report", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ historicalPercent: 91.2, bracketData: 12, amount: 100, spec: "Fire", report: { code: "Q4Yaq7hdRc9K2wPk", fightID: 3 } }] },
  });
  const html = detailMatrixHTML(p, ENCOUNTERS, 12);
  assert.match(html, /href="https:\/\/www\.warcraftlogs\.com\/reports\/Q4Yaq7hdRc9K2wPk\?fight=3&type=damage-done"/);
  assert.match(html, /class="runlink"/);
  assert.match(html, /target="_blank"/);
});

test("detailMatrixHTML appends per-level average and median rows", () => {
  // AK 91.2 + CoT 71.0 at +12 -> avg 81.1 -> shown 81%, median 81.1 -> 81%
  const html = detailMatrixHTML(alice, ENCOUNTERS, 12);
  assert.match(html, /Average/);
  assert.match(html, /Median/);
  const statsSection = html.slice(html.indexOf("Average"));
  assert.match(statsSection, /81%/, "average of 91.2 and 71.0");
});

test("detailMatrixHTML stats with distinct avg vs median", () => {
  const p = playerFromResult({
    classID: 4,
    [`e${AK}`]: { ranks: [{ rankPercent: 10, bracketData: 12 }] },
    [`e${COT}`]: { ranks: [{ rankPercent: 20, bracketData: 12 }] },
    e99: { ranks: [{ rankPercent: 90, bracketData: 12 }] },
  });
  const encs = [...ENCOUNTERS, { id: 99, name: "Third Dungeon" }];
  const html = detailMatrixHTML(p, encs, 12);
  const statsSection = html.slice(html.indexOf("Average"));
  assert.match(statsSection, /40%/, "average (10+20+90)/3 = 40");
  assert.match(statsSection.slice(statsSection.indexOf("Median")), /20%/, "median = 20");
});

test("profileLinkHTML builds a WCL character link", () => {
  const html = profileLinkHTML("us", "area-52", "Foo-Area52");
  assert.match(html, /href="https:\/\/www\.warcraftlogs\.com\/character\/us\/area-52\/Foo"/);
  assert.match(html, /target="_blank"/);
  assert.equal(profileLinkHTML("us", null, "Foo-Area52"), "", "no slug -> no link");
});

test("summaryHTML sorts best-first, includes detail rows and profile links", () => {
  const html = summaryHTML(
    [
      { fullName: "Ghost-Sargeras", player: ghost, slug: "sargeras", region: "us" },
      { fullName: "Alice-Area52", player: alice, slug: "area-52", region: "us" },
    ],
    { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS },
  );
  const aliceIdx = html.indexOf("Alice-Area52");
  const ghostIdx = html.indexOf("Ghost-Sargeras");
  assert.ok(aliceIdx >= 0 && ghostIdx >= 0);
  assert.ok(aliceIdx < ghostIdx, "Alice sorts above the missing player");
  assert.match(html, /Any dungeon @\+12/);
  assert.match(html, /want \+12/);
  assert.match(html, /detail-row/);
  assert.match(html, /colspan="4"/, "applicant, key fit, any dungeon, this dungeon");
  assert.match(html, /no WCL character/);
  assert.match(html, /character\/us\/area-52\/Alice/, "profile link present");
  // alice @12: AK 91.2 + CoT 71.0 -> 91b 81a 81m inline in the any-dungeon cell
  assert.match(html, />91<i class="sfx">b</);
  assert.match(html, />81<i class="sfx">a</);
  assert.match(html, />81<i class="sfx">m</);
});

// ---------------------------------------------------------------- key fit
import { fitCellHTML, fitChipHTML, fitDetailHTML, throughputHTML } from "../docs/js/render.js";

test("fitCellHTML: pending, none, ready with composite and chips", () => {
  assert.match(fitCellHTML({ state: "pending", note: "computing…" }), /computing…/);
  assert.match(fitCellHTML({ state: "none", note: "no runs in the window" }), /no runs in the window/);
  assert.match(fitCellHTML(null), /—/);
  const ready = {
    state: "ready",
    assess: {
      runs: 6, weights: { damage: 60, kicks: 25, stops: 15 },
      composite: { pct: 71.4, presentWeight: 85 },
      present: ["damage", "kicks"],
      measures: {
        damage: { n: 6, pct: 74, z: 0.5 },
        kicks: { n: 5, pct: 61, z: 0.2, mode: "utilisation" },
        stops: { n: 3, z: null },
      },
    },
  };
  const html = fitCellHTML(ready);
  assert.match(html, /class="pct tier-blue fit-score"[^>]*>71<i class="sfx">fit<\/i>/, "composite as a tiered percentile");
  assert.match(html, /n 6/);
  assert.match(html, /DMG 74/);
  assert.match(html, /KICK 61/);
  assert.match(html, /utilisation/, "mode in the tooltip");
  assert.match(html, /STOP ·/, "not enough data reads as a dot");
  assert.match(html, /not enough data yet \(n=3\)/);
  assert.ok(!/DEATHS|SAVE|AVOID|TRIAGE|⚑/.test(html), "nothing of the dropped measures, no flags");
  assert.ok(!/HPS/.test(html), "no throughput line for a dps");
  assert.match(fitChipHTML("stops", { n: 5, pct: 38, z: -0.3 }), /class="fit-chip tier-green"[^>]*title="Stops: casts interrupted with stuns, knocks, silences or other non-kick abilities, per minute vs the cell — percentile 38 over 5 run\(s\)">STOP 38</);
  assert.match(fitChipHTML("dispels", { n: 5, pct: 62, z: 0.3 }), /DISPEL 62/);
  assert.match(fitCellHTML({ state: "partial", assess: ready.assess }), /fit-partial/, "the loading mark while the execution measures are on their way");
});

test("a healer's HPS and DPS sit in the cell as plain numbers", () => {
  const healer = {
    state: "ready", throughput: { hps: 1_250_000, dps: 68_400 },
    assess: { runs: 5, weights: { damage: 15, kicks: 30, stops: 25, dispels: 30 }, composite: null, present: ["damage"], measures: { damage: { n: 5, pct: 60, z: 0.2 }, kicks: { n: 2, z: null }, stops: { n: 5, pct: 40, z: -0.2 }, dispels: { n: 5, pct: 62, z: 0.3 } } },
  };
  const html = fitCellHTML(healer);
  assert.match(html, /<span class="fit-thru muted"[^>]*>1\.25M HPS · 68\.4k DPS<\/span>/);
  assert.match(html, /DISPEL 62/);
  assert.match(html, /no composite yet · n 5/);
  assert.equal(throughputHTML(null), "");
  assert.equal(throughputHTML({ hps: null, dps: null }), "", "nothing known: no line");
  assert.match(throughputHTML({ hps: null, dps: 43_250 }), />43\.3k DPS</, "one side alone still shows");
});

test("fitDetailHTML lists the measures and the provenance", () => {
  const fit = {
    state: "ready",
    provenance: [{ code: "A", fightID: 1, source: "store" }, { code: "B", fightID: 2, source: "live" }, { code: "C", fightID: 3, source: "cached" }],
    assess: {
      runs: 3, weights: { damage: 60, kicks: 25, stops: 15 }, present: ["damage"],
      composite: null,
      measures: {
        damage: { n: 3, pct: 60, z: 0.2, plusMinus: { delta: 4.2, n: 2 } },
        kicks: { n: 3, pct: 55, z: 0.1, mode: "priority-weighted rate" },
        stops: { n: 2, z: null },
      },
    },
  };
  const html = fitDetailHTML(fit);
  assert.match(html, /Execution \(Set B\) · 3 run\(s\)/);
  assert.match(html, /<b>DMG<\/b> <span class="muted">w60<\/span> — percentile 60 over 3 run\(s\) · plus-minus \+4\.2 pp/);
  assert.match(html, /<b>KICK<\/b> <span class="muted">w25<\/span> — percentile 55 over 3 run\(s\) · priority-weighted rate/);
  assert.match(html, /<b>STOP<\/b> <span class="muted">w15<\/span> — not enough data \(n=2\)/);
  assert.ok(!/Deaths, classified|Flags|POTIONS/.test(html), "no death list, no flags, no potion line");
  assert.match(html, /1 store · 1 live · 1 cached/);
  assert.equal(fitDetailHTML({ state: "pending" }), "");
});

/* ---------------- column sorting ---------------- */

const rank = (enc, pct, level) => ({ [`e${enc}`]: { ranks: [{ rankPercent: pct, bracketData: level, spec: "Fire" }] } });
const SORTERS = {
  alice: alice,                                                          // AK 91.2 @12, CoT 71 @12
  bob: playerFromResult({ classID: 4, ...rank(AK, 60, 12) }),            // AK 60 @12
  carl: playerFromResult({ classID: 4, ...rank(COT, 99, 10) }),          // nothing at +12; CoT 99 @10; never AK
  dave: playerFromResult({ classID: 4, ...rank(AK, 50, 10) }),           // nothing at +12; AK 50 @10 only
};
const composite = (pct) => ({ state: "ready", assess: { composite: { pct, presentWeight: 100 }, weights: {}, measures: {}, runs: 6, present: [] } });
const sortEntries = () => [
  { fullName: "Dave-Realm", player: SORTERS.dave, slug: "realm", region: "us" },
  { fullName: "Ghost-Realm", player: ghost, slug: "realm", region: "us" },
  { fullName: "Carl-Realm", player: SORTERS.carl, slug: "realm", region: "us", fit: { state: "pending", note: "computing…" } },
  { fullName: "Bob-Realm", player: SORTERS.bob, slug: "realm", region: "us", fit: composite(70) },
  // re-judged through a role chip: shows 90, but sorts on the lookup's 40
  { fullName: "Alice-Realm", player: SORTERS.alice, slug: "realm", region: "us", fit: composite(90), fitSort: composite(40) },
];
const order = (sort) => {
  const html = summaryHTML(sortEntries(), { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS, sort });
  return [...html.matchAll(/<tr class="row" data-idx="\d+" data-key="([^"]+)"/g)].map((m) => m[1].split("-")[0]);
};

test("nextSort: natural direction, reversed, then back to the default", () => {
  let s = null;
  s = nextSort(s, "any"); assert.deepEqual(s, { col: "any", dir: "desc" }, "numbers: best first");
  s = nextSort(s, "any"); assert.deepEqual(s, { col: "any", dir: "asc" });
  s = nextSort(s, "any"); assert.equal(s, null, "third click: the default order");
  assert.deepEqual(nextSort(null, "name"), { col: "name", dir: "asc" }, "names: A to Z first");
  assert.deepEqual(nextSort({ col: "name", dir: "asc" }, "name"), { col: "name", dir: "desc" });
  assert.deepEqual(nextSort({ col: "any", dir: "asc" }, "fit"), { col: "fit", dir: "desc" }, "another column starts fresh");
  assert.deepEqual(nextSort({ col: "fit", dir: "desc" }, "bogus"), { col: "fit", dir: "desc" }, "an unknown column changes nothing");
});

test("validSort keeps only a known column and direction", () => {
  assert.deepEqual(validSort({ col: "dungeon", dir: "asc", extra: 1 }), { col: "dungeon", dir: "asc" });
  for (const bad of [null, undefined, {}, { col: "dps", dir: "asc" }, { col: "any", dir: "up" }, "any"]) assert.equal(validSort(bad), null);
});

test("default order is unchanged: this dungeon first, then any dungeon", () => {
  assert.deepEqual(order(null), ["Alice", "Bob", "Dave", "Carl", "Ghost"],
    "Dave's lower-key run in this dungeon outranks Carl, who never ran it");
});

test("sort by applicant: A to Z, then Z to A", () => {
  assert.deepEqual(order({ col: "name", dir: "asc" }), ["Alice", "Bob", "Carl", "Dave", "Ghost"]);
  assert.deepEqual(order({ col: "name", dir: "desc" }), ["Ghost", "Dave", "Carl", "Bob", "Alice"]);
});

test("sort by any dungeon: the key level's number ranks above a lower-level best; no data stays last", () => {
  assert.deepEqual(order({ col: "any", dir: "desc" }), ["Alice", "Bob", "Carl", "Dave", "Ghost"],
    "91 and 60 at +12, then Carl's 99 and Dave's 50 from lower keys, then no character");
  assert.deepEqual(order({ col: "any", dir: "asc" }), ["Dave", "Carl", "Bob", "Alice", "Ghost"],
    "reversed, but the row with nothing to sort on is still last");
});

test("sort by this dungeon: a run at the key level above an only-lower best; never logged stays last", () => {
  assert.deepEqual(order({ col: "dungeon", dir: "desc" }), ["Alice", "Bob", "Dave", "Carl", "Ghost"]);
  assert.deepEqual(order({ col: "dungeon", dir: "asc" }), ["Dave", "Bob", "Alice", "Carl", "Ghost"]);
});

test("sort by Key fit: the lookup's own fit (fitSort) decides; no composite stays last", () => {
  assert.deepEqual(order({ col: "fit", dir: "desc" }), ["Bob", "Alice", "Carl", "Dave", "Ghost"],
    "Bob 70 above Alice's 40, though Alice's re-judged row shows 90");
  assert.deepEqual(order({ col: "fit", dir: "asc" }), ["Alice", "Bob", "Carl", "Dave", "Ghost"]);
});

test("headers are sort buttons; only the active one is marked", () => {
  const html = summaryHTML(sortEntries(), { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS, sort: { col: "any", dir: "desc" } });
  for (const col of ["name", "fit", "any", "dungeon"]) assert.match(html, new RegExp(`<button type="button" class="sort[^"]*" data-sort="${col}"`));
  assert.match(html, /<th aria-sort="descending"><button type="button" class="sort active" data-sort="any"[^>]*>Any dungeon @\+12<span class="sort-arrow" aria-hidden="true">▼<\/span>/);
  assert.equal((html.match(/aria-sort="none"/g) ?? []).length, 3, "the other three headers are not sorted");
  assert.match(html, /data-sort="any" title="Sort by any-dungeon Key %, lowest first"/, "the tooltip says what the next click does");
  const plain = summaryHTML(sortEntries(), { level: 12, encounter: ENCOUNTERS[0], encounters: ENCOUNTERS });
  assert.equal((plain.match(/aria-sort="none"/g) ?? []).length, 4, "default order: no header is marked");
});
