import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessEntry } from "../docs/js/fit.js";
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
  measures: { dps: { unit: "per_s", better: "high" } },
  cells: { "Warrior-Arms|*|b12": { n: 500, dps: [200000, 220000, 260000, 300000, 340000, 380000, 400000] } },
});

function memStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
const noStore = () => new RunStore({ baseUrl: "https://s/runs", fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), now: () => NOW });
const ranks = (codes) => ({ classID: 11, e111: { ranks: codes.map((code, i) => ({ historicalPercent: 58, rankPercent: 58, bracketData: 12, amount: 312_375, spec: "Arms", medal: "bronze", duration: 1_715_504, startTime: NOW - (i + 3) * day, report: { code, fightID: 8 } })) } });

// the same answers the e2e fake gives: fight-8 events, tables when asked,
// the ±10 s death clusters for window queries
function reportResponse(query) {
  const out = {};
  for (const block of query.split(/(?=r\d+: report\(code: ")/).filter((b) => /^r\d+: report/.test(b))) {
    const alias = /^(r\d+):/.exec(block)[1];
    if (/fights\(fightIDs/.test(block)) {
      const node = { fights: [F8.fight] };
      if (/playerDetails/.test(block)) Object.assign(node, { masterData: { actors: F8.actors.map((a) => ({ ...a, server: "Area 52" })) }, playerDetails: F8.playerDetails });
      if (/deaths: events/.test(block)) Object.assign(node, { deaths: { data: F8.deaths }, low: { data: F8.low35 }, ints: { data: F8.interrupts }, kit: { data: F8.kitCasts }, begin: { data: F8.begincast } });
      if (/summary: table/.test(block)) Object.assign(node, { summary: T8.summary, interrupts: T8.interrupts, dispels: T8.dispels, dmgTaken: T8.dmgTaken, casts: T8.casts, healing: T8.healing });
      out[alias] = node;
      continue;
    }
    const node = {};
    for (const m of block.matchAll(/(d|h)(\d+): events\([^)]*startTime: (\d+)/g)) {
      const [, kind, k, st] = m;
      const t = Number(st) + 10_000;
      const cluster = Object.keys(F8.windows).filter((w) => w.startsWith("d")).find((w) => { const ts = F8.windows[w].map((e) => e.timestamp); return t >= Math.min(...ts) - 1000 && t <= Math.max(...ts) + 2000; });
      node[`${kind}${k}`] = { data: cluster ? (kind === "d" ? F8.windows[cluster] : F8.windows["h" + cluster.slice(1)]) : [] };
    }
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
  const final = await assessEntry(entry, ranks(["RUNA", "RUNB", "RUNC"]), ENC, 12, { token: "t", fetchImpl: f }, deps);
  assert.equal(seen.length, 1, "one partial result");
  assert.equal(seen[0].requestsSoFar, 0, "sent before the first Warcraft Logs request");
  const partial = seen[0].fit;
  assert.equal(partial.state, "partial");
  assert.equal(partial.assess.runs, 3);
  assert.equal(partial.role, "dps");
  assert.equal(partial.spec, "Arms");
  assert.ok(partial.assess.measures.damage.z !== null, "the damage percentile needs only the rankings");
  assert.equal(partial.assess.measures.deaths.n, 0, "no death data yet");
  assert.equal(partial.provenance.length, 0);

  assert.equal(final.state, "ready");
  assert.equal(final.assess.runs, 3);
  assert.equal(final.assess.measures.deaths.n, 3, "death data came with the events");
  assert.ok(final.provenance.every((p) => p.source === "live"));
  const bundles = f.calls.filter((q) => /r0: report/.test(q) && /fights\(/.test(q));
  assert.equal(bundles.length, 6, "three absent runs: an events request and a tables request each");
  assert.ok(bundles.every((q) => q.split("report(code:").length === 2), "one run per request");

  // second look: every run remembered, nothing partial, nothing fetched
  const before = f.calls.length;
  const again = await assessEntry(entry, ranks(["RUNA", "RUNB", "RUNC"]), ENC, 12, { token: "t", fetchImpl: f }, deps);
  assert.equal(again.state, "ready");
  assert.equal(seen.length, 1, "no partial result when there is nothing to fetch");
  assert.equal(f.calls.length, before, "no request");
  assert.ok(again.provenance.every((p) => p.source === "cached"));
});

test("assessEntry: an applicant with no runs in the window is none, and never partial", async () => {
  const seen = [];
  const out = await assessEntry({ fullName: "Nobody-Area52", selected: "dps" }, ranks([]), ENC, 12, { token: "t", fetchImpl: wclFake(0) }, { lists: LISTS, baselines: BASELINES, store: noStore(), storage: memStorage(), now: NOW, onPartial: (fit) => seen.push(fit) });
  assert.equal(out.state, "none");
  assert.equal(seen.length, 0);
});
