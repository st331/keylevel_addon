import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, pctSpan, anyCellHTML, dungeonCellHTML, nameHTML, detailMatrixHTML, summaryHTML } from "../docs/js/render.js";
import { playerFromResult } from "../docs/js/transform.js";

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

test("anyCellHTML states", () => {
  assert.match(anyCellHTML({ status: "NO_WCL" }, 12), /no WCL character/);
  assert.match(anyCellHTML({ status: "OK", anyAtLevel: { pct: 91.2, runs: 2 } }, 12), /91%.*2 dungeons/);
  assert.match(anyCellHTML({ status: "OK", anyBest: { pct: 80, level: 14 } }, 12), /none at \+12 · best.*\+14/);
  assert.match(anyCellHTML({ status: "OK" }, 12), /no M\+ logs/);
  assert.match(anyCellHTML({ status: "OK", anyBest: { pct: 80, level: 14 } }, null), /best:.*\+14/);
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

test("summaryHTML sorts best-first and includes detail rows", () => {
  const html = summaryHTML(
    [
      { fullName: "Ghost-Sargeras", player: ghost },
      { fullName: "Alice-Area52", player: alice },
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
  assert.match(html, /no WCL character/);
});
