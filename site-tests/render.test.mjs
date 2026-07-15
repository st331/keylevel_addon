import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, pctSpan, pctTag, bamHTML, ageText, anyCellHTML, dungeonCellHTML, nameHTML, profileLinkHTML, detailMatrixHTML, summaryHTML, roleChipsHTML } from "../docs/js/render.js";
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
  assert.match(html, /title="run on 2026-06-06 — open its report"/);
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
    fullName: "Multi-Realm", selected: "healer", detected: "healer",
    byRole: { tank: { role: "tank", levels: {} }, healer: { role: "healer", levels: {} } },
  });
  assert.match(multi, /<button[^>]*role-healer sel"/, "viewed role is solid");
  assert.match(multi, /<button[^>]*role-tank dim"/, "other role dimmed");
  assert.match(multi, /data-full="Multi-Realm"/);
  assert.match(multi, /data-role="tank"/);
  assert.match(multi, /click to judge/, "dimmed chip explains the click");
  assert.doesNotMatch(multi, /role-dps/, "unplayed role has no chip");

  // legacy shape (no byRole): falls back to the player's role
  const legacy = roleChipsHTML({ fullName: "Old-Realm", player: { role: "tank" } });
  assert.match(legacy, /<span class="role role-tank"/);
});

test("roleChipsHTML follows entry.order and shows top-key counts", () => {
  const html = roleChipsHTML({
    fullName: "Multi-Realm", selected: "healer", detected: "healer",
    order: ["healer", "tank", "dps"],
    topKeys: { healer: { keys: 5, score: 2300 }, tank: { keys: 3, score: 1300 } },
    byRole: {
      tank: { role: "tank", levels: {} },
      healer: { role: "healer", levels: {} },
      dps: { role: "dps", levels: {} },
    },
  });
  const h = html.indexOf("role-healer"), t = html.indexOf("role-tank"), d = html.indexOf("role-dps");
  assert.ok(h >= 0 && h < t && t < d, "chips render in top-key order, not fixed T/H/D");
  assert.match(html, /holds 5 of their 8 top keys/, "solid chip tooltip");
  assert.match(html, /holds 3 of their 8 top keys/, "dimmed chip tooltip");
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
  assert.match(html, /data-full="Switch-Realm"/, "rows carry data-full for re-render state");
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
  assert.match(html, /colspan="3"/);
  assert.match(html, /no WCL character/);
  assert.match(html, /character\/us\/area-52\/Alice/, "profile link present");
  // alice @12: AK 91.2 + CoT 71.0 -> 91b 81a 81m inline in the any-dungeon cell
  assert.match(html, />91<i class="sfx">b</);
  assert.match(html, />81<i class="sfx">a</);
  assert.match(html, />81<i class="sfx">m</);
});
