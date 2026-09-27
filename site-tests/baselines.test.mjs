import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { makeBaselines, fetchGzJson, loadBaselines, resetBaselinesCache } from "../docs/js/baselines.js";
import { RunStore, shardOf, execFromStoredRun, SWEEP_LAG_MS } from "../docs/js/runstore.js";

const DOC = {
  built: "2026-09-27T05:02:00Z",
  quantiles: [5, 10, 25, 50, 75, 90, 95],
  measures: { dps: { unit: "per_s", better: "high" }, avoid_dmg_min: { unit: "per_min", better: "low" }, kick_prio: { better: "high" } },
  cells: {
    "Warrior-Arms|Altar of Fangs|18": { n: 1042, n_exec: 300, dps: [310431, 317320, 330292, 346080, 362986, 377029, 385884], avoid_dmg_min: [1e4, 2e4, 4e4, 8e4, 1.5e5, 3e5, 4e5] },
    "Warrior-Arms|Altar of Fangs|b18": { n: 2469, dps: [300000, 310000, 325000, 345000, 365000, 380000, 390000] },
    "Warrior-Arms|*|b18": { n: 9800, dps: [280000, 300000, 320000, 340000, 360000, 380000, 395000] },
    "Warrior-Fury|Altar of Fangs|b18": { n: 46, dps: [333456, 341546, 352315, 376071, 399922, 413302, 417087] },
    "Warrior-Fury|*|b18": { n: 306, dps: [236979, 256683, 298668, 330120, 356780, 386792, 402222] },
  },
  priority: { "Altar of Fangs": { 1294557: { name: "Piercing Hiss", begun: 15320, completed: 812, interrupted: 13990 }, 1306381: { name: "Fetid Spit", begun: 12000, completed: 10800, interrupted: 1200 }, 999: { begun: 3, completed: 0, interrupted: 3 } } },
};

function fakeFetch(bodyByUrl) {
  return async (url) => {
    const body = bodyByUrl[url];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

test("the cell ladder: exact → band → dungeon-pooled → none", () => {
  const b = makeBaselines(DOC);
  assert.equal(b.cellFor("Warrior-Arms", "Altar of Fangs", 18).tier, "exact");
  assert.equal(b.cellFor("Warrior-Arms", "Altar of Fangs", 19).tier, "band", "19 has no exact cell; band 18–19 does");
  assert.equal(b.cellFor("Warrior-Fury", "Altar of Fangs", 18).tier, "pooled", "the Fury band cell has 46 rows: too few");
  assert.equal(b.cellFor("Warrior-Fury", "Altar of Fangs", 18).n, 306);
  assert.equal(b.cellFor("Warrior-Fury", "Altar of Fangs", 12), null, "nothing at +12 for Fury");
  assert.equal(b.cellFor("Warrior-Arms", null, 18).tier, "pooled", "no dungeon chosen: straight to the pooled band");
});

test("percentiles respect the measure's direction and the cell's coverage", () => {
  const b = makeBaselines(DOC);
  const c = b.cellFor("Warrior-Arms", "Altar of Fangs", 18);
  assert.equal(b.percentile(c, "dps", 346080), 50);
  assert.ok(b.percentile(c, "dps", 380000) > 90);
  assert.equal(b.percentile(c, "avoid_dmg_min", 8e4), 50);
  assert.ok(b.percentile(c, "avoid_dmg_min", 3e5) < 15, "more avoidable damage = worse percentile");
  assert.equal(b.percentile(c, "kick_prio", 1), null, "no quantiles for that measure in this cell");
  assert.equal(b.nFor(c, "dps"), 1042);
  assert.equal(b.nFor(c, "kick_prio"), 300, "bundle measures count the bundled rows");
});

test("dangerous casts come from the population's own kick rate", () => {
  const b = makeBaselines(DOC);
  const d = b.dangerousFor("Altar of Fangs");
  assert.ok(d.has(1294557), "Piercing Hiss: kicked 91 % of the time");
  assert.ok(!d.has(1306381), "Fetid Spit: let through");
  assert.ok(!d.has(999), "three casts is not a population");
  assert.equal(b.dangerousFor("Nowhere").size, 0);
});

test("makeBaselines rejects a document without cells", () => {
  assert.equal(makeBaselines(null), null);
  assert.equal(makeBaselines({ quantiles: [50] }), null);
});

test("fetchGzJson decompresses gzip and accepts plain JSON", async () => {
  const gz = gzipSync(Buffer.from(JSON.stringify(DOC)));
  const f = fakeFetch({ "https://x/baselines.json.gz": new Uint8Array(gz), "https://x/plain.json": DOC });
  const a = await fetchGzJson("https://x/baselines.json.gz", f);
  assert.equal(a.built, DOC.built);
  const p = await fetchGzJson("https://x/plain.json", f);
  assert.equal(p.built, DOC.built);
  await assert.rejects(fetchGzJson("https://x/missing", f), /404/);
});

test("loadBaselines returns null when the sidecar is not there yet, and caches", async () => {
  resetBaselinesCache();
  let calls = 0;
  const missing = async () => { calls++; return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; };
  assert.equal(await loadBaselines({ url: "https://x/b.json.gz", fetchImpl: missing, now: 1000 }), null);
  assert.equal(await loadBaselines({ url: "https://x/b.json.gz", fetchImpl: missing, now: 2000 }), null);
  assert.equal(calls, 1, "the absence is remembered for the TTL");
  resetBaselinesCache();
});

test("run store: stored / pending / absent, and the shard is fetched once", async () => {
  const built = Date.parse("2026-09-27T05:00:00Z");
  const shard = { built: "2026-09-27T05:00:00Z", runs: { "P3j1myqhvQcMp6Tk:8": { dun: "Altar of Fangs", lvl: 16, dur_s: 1604, timed: true, exec: true, players: [{ name: "Genjibb", server: "Area 52", class: "Warrior", spec: "Arms", role: "DPS", dps: 312375, deaths: 2, kicks: 23, kicks_by: { 1294557: 12 } }] } } };
  let calls = 0;
  const f = async (url) => { calls++; return fakeFetch({ [`https://s/runs/${shardOf("P3j1myqhvQcMp6Tk")}.json.gz`]: shard })(url); };
  const store = new RunStore({ baseUrl: "https://s/runs", fetchImpl: f, now: () => built + 3600_000 });
  const a = await store.lookup("P3j1myqhvQcMp6Tk", 8, built - 86_400_000);
  assert.equal(a.status, "stored");
  assert.equal(a.run.players[0].name, "Genjibb");
  const same = shardOf("P3j1myqhvQcMp6Tk");
  const b = await store.lookup("P3j1other", 1, built - 86_400_000); // same shard (first four chars)
  assert.equal(b.status, "absent", "old run not in the store: wowlogs will never fetch it");
  const c = await store.lookup("P3j1new", 1, built - 3600_000);
  assert.equal(c.status, "pending", "a run one hour before the build may not be swept yet");
  const d = await store.lookup("P3j1new", 1, built - SWEEP_LAG_MS - 1);
  assert.equal(d.status, "absent");
  assert.equal(calls, 1, "one shard fetch for four lookups");
  const e = await store.lookup("Zzz9", 1, built - 86_400_000);
  assert.equal(e.status, "absent", "a missing shard reads as absent");
  assert.match(same, /^[0-9a-f]{2}$/);
  assert.equal(shardOf("P3j1myqhvQcMp6Tk"), same, "hash depends on the first four characters only");
  assert.equal(shardOf(""), null);
  // the reference implementation: h = (h*31 + charCode) % 256 over 4 chars
  let h = 0; for (const ch of "P3j1") h = (h * 31 + ch.charCodeAt(0)) % 256;
  assert.equal(same, h.toString(16).padStart(2, "0"));
});

test("execFromStoredRun maps names to actor ids and keeps nulls", () => {
  const run = { exec: false, dur_s: 1600, players: [{ name: "Genjibb", class: "Warrior", spec: "Arms", role: "DPS", dps: 300000, deaths: 1 }] };
  const exec = execFromStoredRun(run, (name) => ({ Genjibb: 1 })[name]);
  assert.equal(exec.source, "store");
  assert.equal(exec.exec, false);
  assert.equal(exec.rows[1].dps, 300000);
  assert.equal(exec.rows[1].kicks, null, "bundle not fetched: null, never 0");
  assert.equal(exec.rows[1].role, "dps");
});

test("run store: parallel lookups on one shard share a single fetch", async () => {
  let calls = 0;
  const shard = { built: "2026-09-27T05:00:00Z", runs: {} };
  const f = async (url) => { calls++; await new Promise((r) => setTimeout(r, 5)); return fakeFetch({ [`https://s/runs/${shardOf("P3j1")}.json.gz`]: shard })(url); };
  const store = new RunStore({ baseUrl: "https://s/runs", fetchImpl: f, now: () => Date.parse("2026-09-27T06:00:00Z") });
  const out = await Promise.all(["P3j1a", "P3j1b", "P3j1c"].map((c) => store.lookup(c, 1, 0)));
  assert.ok(out.every((o) => o.status === "absent"));
  assert.equal(calls, 1, "three lookups at once, one shard fetch");
  await store.lookup("P3j1d", 1, 0);
  assert.equal(calls, 1, "and the shard stays cached afterwards");
});
