import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessEntry, throughputFor, windowRuns } from "../docs/js/fit.js";
import { RunStore } from "../docs/js/runstore.js";
import { makeBaselines } from "../docs/js/baselines.js";

const F8 = JSON.parse(readFileSync(new URL("./fixtures/fight8.json", import.meta.url)));
const T8 = JSON.parse(readFileSync(new URL("./fixtures/tables_fight8.json", import.meta.url)));
const LISTS = JSON.parse(readFileSync(new URL("../docs/data/lists.json", import.meta.url)));
const NOW = Date.now();
const day = 86_400_000;
const ENC = [{ id: 111, name: "Windrunner Spire" }];
const BASELINES = makeBaselines({
  built: new Date(NOW).toISOString(), quantiles: [5, 10, 25, 50, 75, 90, 95],
  measures: { dps: { unit: "per_s", better: "high" }, stops_min: { unit: "per_min", better: "high" } },
  cells: { "Warrior-Arms|*|b12": { n: 500, n_exec: 100, dps: [200000, 220000, 260000, 300000, 340000, 380000, 400000], stops_min: [0, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6] } },
  // the population kicks Piercing Hiss nine times in ten: it is a dangerous cast
  priority: { "Windrunner Spire": { 1294557: { name: "Piercing Hiss", begun: 1000, completed: 100, interrupted: 900 } } },
});

function memStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
const noStore = () => new RunStore({ baseUrl: "https://s/runs", fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), now: () => NOW });
const ranks = (codes, { classID = 11, spec = "Arms", amount = 312_375, pct = 58 } = {}) => ({ classID, e111: { ranks: codes.map((code, i) => ({ historicalPercent: pct, rankPercent: pct, bracketData: 12, amount: typeof amount === "function" ? amount(i) : amount, spec, medal: "bronze", duration: 1_715_504, startTime: NOW - (i + 3) * day, report: { code, fightID: 8 } })) } });

// the same answers the e2e fake gives: fight-8 events, tables when asked
function reportResponse(query) {
  const out = {};
  for (const block of query.split(/(?=r\d+: report\(code: ")/).filter((b) => /^r\d+: report/.test(b))) {
    const alias = /^(r\d+):/.exec(block)[1];
    const node = /fights\(fightIDs/.test(block) ? { fights: [F8.fight] } : {};
    if (/playerDetails/.test(block)) Object.assign(node, { masterData: { actors: F8.actors.map((a) => ({ ...a, server: "Area 52" })) }, playerDetails: F8.playerDetails });
    if (/deaths: events/.test(block)) Object.assign(node, { deaths: { data: F8.deaths }, ints: { data: F8.interrupts }, kick: { data: F8.kitCasts }, begin: { data: F8.begincast } });
    if (/summary: table/.test(block)) Object.assign(node, { summary: T8.summary, interrupts: T8.interrupts, dispels: T8.dispels });
    out[alias] = node;
  }
  return { data: { reportData: out } };
}
function wclFake(delayMs) {
  const calls = [];
  const f = async (url, opts) => {
    const q = JSON.parse(opts.body).query;
    calls.push(q);
    await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, status: 200, json: async () => reportResponse(q) };
  };
  f.calls = calls;
  return f;
}

test("assessEntry: what the rankings say is out before any request; the execution measures follow", async () => {
  const f = wclFake(5);
  const storage = memStorage();
  const seen = [];
  const entry = { fullName: "Genjibb-Area52", selected: "dps", region: "us" };
  const deps = { lists: LISTS, baselines: BASELINES, store: noStore(), storage, now: NOW, onPartial: (fit) => seen.push({ fit, requestsSoFar: f.calls.length }) };
  const codes = ["RUNA", "RUNB", "RUNC", "RUND"];
  const final = await assessEntry(entry, ranks(codes), ENC, 12, { token: "t", fetchImpl: f }, deps);
  assert.equal(seen.length, 1, "one partial result");
  assert.equal(seen[0].requestsSoFar, 0, "sent before the first Warcraft Logs request");
  const partial = seen[0].fit;
  assert.equal(partial.state, "partial");
  assert.equal(partial.assess.runs, 4);
  assert.equal(partial.role, "dps");
  assert.equal(partial.spec, "Arms");
  assert.ok(partial.assess.measures.damage.z !== null, "the damage percentile needs only the rankings");
  assert.equal(partial.assess.measures.kicks.n, 0, "no kick data yet");
  assert.equal(partial.assess.measures.stops.n, 0, "no stop data yet");
  assert.equal(partial.throughput, null, "no HPS/DPS line for a dps");
  assert.equal(partial.provenance.length, 0);

  assert.equal(final.state, "ready");
  assert.equal(final.assess.runs, 4);
  assert.equal(final.assess.measures.stops.n, 4, "four stops a run, judged against the pooled cell's stops_min");
  assert.ok(final.assess.measures.stops.z !== null);
  assert.equal(final.assess.measures.kicks.mode, "utilisation");
  assert.equal(final.throughput, null);
  assert.ok(final.provenance.every((p) => p.source === "live"));
  const bundles = f.calls.filter((q) => /r0: report/.test(q) && /fights\(/.test(q));
  assert.equal(bundles.length, 8, "four absent runs: an events request and a tables request each");
  assert.ok(bundles.every((q) => q.split("report(code:").length === 2), "one run per request");
  const events = bundles.filter((q) => /deaths: events/.test(q));
  assert.equal(events.length, 4);
  assert.ok(events.every((q) => /ints: events/.test(q) && /kick: events\([^)]*ability\.id in \(6552\)/.test(q) && /begin: events\([^)]*1294557/.test(q)), "deaths, interrupts, the kick's casts and the dangerous casts");
  assert.ok(events.every((q) => !/low: events/.test(q) && !/dataType: Healing/.test(q)), "no low-HP stream, no healing");
  const tables = bundles.filter((q) => /summary: table/.test(q));
  assert.equal(tables.length, 4);
  assert.ok(tables.every((q) => /interrupts: table/.test(q) && /dispels: table/.test(q) && !/dmgTaken: table/.test(q) && !/casts: table/.test(q) && !/healing: table/.test(q)), "Summary + Interrupts + Dispels only");
  assert.ok(f.calls.every((q) => !/d0: events/.test(q) && !/sourceID:/.test(q)), "no death windows, no healer stream");

  // second look: every run remembered, nothing partial, nothing fetched
  const before = f.calls.length;
  const again = await assessEntry(entry, ranks(codes), ENC, 12, { token: "t", fetchImpl: f }, deps);
  assert.equal(again.state, "ready");
  assert.equal(seen.length, 1, "no partial result when there is nothing to fetch");
  assert.equal(f.calls.length, before, "no request");
  assert.ok(again.provenance.every((p) => p.source === "cached"));
  assert.equal(again.assess.measures.stops.n, 4);
  const box = JSON.parse(storage.getItem("kllRunFacts"));
  assert.equal(box.v, 2, "the facts box carries the new shape's version");
});

test("assessEntry: an applicant with no runs in the window is none, and never partial", async () => {
  const seen = [];
  const out = await assessEntry({ fullName: "Nobody-Area52", selected: "dps" }, ranks([]), ENC, 12, { token: "t", fetchImpl: wclFake(0) }, { lists: LISTS, baselines: BASELINES, store: noStore(), storage: memStorage(), now: NOW, onPartial: (fit) => seen.push(fit) });
  assert.equal(out.state, "none");
  assert.equal(seen.length, 0);
});

test("a healer's HPS and DPS ride along as plain numbers, in the partial and the final result", async () => {
  const f = wclFake(0);
  const seen = [];
  const codes = ["HRUNA", "HRUNB", "HRUNC"];
  const dps = ranks(codes, { classID: 9, spec: "Restoration", amount: (i) => [42_000, 44_000, 43_000][i], pct: 30 });
  const hps = ranks(codes, { classID: 9, spec: "Restoration", amount: (i) => [1_250_000, 1_300_000, 1_100_000][i], pct: 70 });
  const entry = { fullName: "Healguy-Area52", selected: "healer", region: "us", hps };
  const out = await assessEntry(entry, dps, ENC, 12, { token: "t", fetchImpl: f }, { lists: LISTS, baselines: BASELINES, store: noStore(), storage: memStorage(), now: NOW, onPartial: (fit) => seen.push(fit) });
  assert.equal(seen[0].throughput.hps, 1_250_000, "median HPS over the window runs, before any request");
  assert.equal(seen[0].throughput.dps, 43_000);
  assert.equal(out.state, "ready");
  assert.deepEqual(out.throughput, { hps: 1_250_000, dps: 43_000 });
  assert.deepEqual(out.assess.weights, { damage: 15, kicks: 30, stops: 25, dispels: 30 });
  // the pure helper: only healers, only the window, only real amounts
  assert.equal(throughputFor("dps", windowRuns(dps, ENC, "dps", 12).runs, hps, ENC, 12), null);
  assert.deepEqual(throughputFor("healer", windowRuns(dps, ENC, "healer", 12).runs, null, ENC, 12), { hps: null, dps: 43_000 }, "no hps rankings yet: HPS unknown, DPS still there");
});
