import { test } from "node:test";
import assert from "node:assert/strict";
import { getToken, gql, buildCharacterQuery, fetchCharacters, fetchCharactersParallel, guessMythicPlusZone, WclError, fetchRunBundles, buildRunBundleQuery, MAX_IN_FLIGHT, inFlightCount } from "../docs/js/wcl.js";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const out = handler(url, opts, calls.length);
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => out.json,
      text: async () => JSON.stringify(out.json),
    };
  };
  impl.calls = calls;
  return impl;
}

test("getToken posts client credentials with basic auth, returns expiry", async () => {
  const f = fakeFetch(() => ({ json: { access_token: "tok123", expires_in: 100 } }));
  const { token, expiresAt } = await getToken({ clientId: "id", clientSecret: "sec", fetchImpl: f });
  assert.equal(token, "tok123");
  assert.ok(expiresAt > Date.now());
  const call = f.calls[0];
  assert.equal(Buffer.from(call.opts.headers.Authorization.slice(6), "base64").toString(), "id:sec");
  assert.equal(call.opts.body, "grant_type=client_credentials");
});

test("getToken/gql produce friendly errors", async () => {
  const f401 = fakeFetch(() => ({ status: 401, json: {} }));
  await assert.rejects(getToken({ clientId: "x", clientSecret: "y", fetchImpl: f401 }), /check your client id\/secret/);
  const fNet = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(getToken({ clientId: "x", clientSecret: "y", fetchImpl: fNet }), /network\/CORS/);
  await assert.rejects(gql({ token: "t", query: "q", fetchImpl: fakeFetch(() => ({ status: 429, json: {} })) }), /rate limited/);
  await assert.rejects(gql({ token: "t", query: "q", fetchImpl: fakeFetch(() => ({ status: 401, json: {} })) }), /unauthorized/);
  await assert.rejects(
    gql({ token: "t", query: "q", fetchImpl: fakeFetch(() => ({ json: { errors: [{ message: "boom" }] } })) }),
    /boom/);
});

test("gql returns data despite partial errors", async () => {
  const f = fakeFetch(() => ({ json: { data: { x: 1 }, errors: [{ message: "character not found" }] } }));
  assert.deepEqual(await gql({ token: "t", query: "q", fetchImpl: f }), { x: 1 });
});

test("buildCharacterQuery aliases and escapes", () => {
  const q = buildCharacterQuery(
    [{ name: 'O"Hara', serverSlug: "area-52", region: "us" }],
    [{ id: 12805 }, { id: 361753 }],
  );
  assert.match(q, /c0: character\(name: "O\\"Hara", serverSlug: "area-52", serverRegion: "us"\)/);
  assert.match(q, /e12805: encounterRankings\(encounterID: 12805, metric: dps, byBracket: true\)/,
    "default metric is dps: byBracket dps percentile = the report's Key %");
  assert.match(q, /e361753:/);
});

test("fetchCharacters maps aliases back; unknown character -> null", async () => {
  const f = fakeFetch(() => ({ json: { data: { characterData: { c0: { classID: 4 }, c1: null } } } }));
  const out = await fetchCharacters(
    { token: "t", fetchImpl: f },
    [
      { name: "Foo", serverSlug: "area-52", region: "us" },
      { name: "Bar", serverSlug: "sargeras", region: "us" },
    ],
    [{ id: 1 }],
  );
  assert.equal(out[0].result.classID, 4);
  assert.equal(out[1].result, null);
});

test("fetchCharactersParallel: all chunks in flight at once, order preserved", async () => {
  let inFlight = 0, maxInFlight = 0;
  const classFor = { A: 1, B: 2, C: 3, D: 4, E: 5 };
  const fetchImpl = async (url, opts) => {
    const name = /name: "([^"]+)"/.exec(JSON.parse(opts.body).query)[1];
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15)); // hold the request open
    inFlight--;
    return {
      ok: true, status: 200,
      json: async () => ({ data: { characterData: { c0: { classID: classFor[name] } } } }),
    };
  };
  const chars = Object.keys(classFor).map((n) => ({ key: n, name: n, serverSlug: "s", region: "us" }));
  const out = await fetchCharactersParallel({ token: "t", fetchImpl }, chars, [{ id: 1 }], undefined, 1);
  assert.equal(maxInFlight, 5, "no request waits for another — 20 characters ≈ one round-trip");
  assert.deepEqual(out.map((r) => r.key), ["A", "B", "C", "D", "E"], "merged in roster order");
  assert.equal(out[2].result.classID, 3, "results map back to the right character");
  assert.deepEqual(await fetchCharactersParallel({ token: "t", fetchImpl }, [], [{ id: 1 }], undefined, 2), []);
});

test("guessMythicPlusZone picks live keystone zone, skipping PTR", () => {
  const zones = [
    { id: 39, name: "Mythic+ Season 1", frozen: true, brackets: { type: "Keystone Level" }, expansion: { id: 10 } },
    { id: 46, name: "Launch Raids", frozen: false, brackets: { type: "Item Level" }, expansion: { id: 11 } },
    { id: 47, name: "Mythic+ Season 1", frozen: false, brackets: { type: "Keystone Level" }, expansion: { id: 11 } },
    { id: 56, name: "Mythic+ Season 2 (PTR)", frozen: false, brackets: { type: "Keystone Level" }, expansion: { id: 11 } },
  ];
  assert.equal(guessMythicPlusZone(zones).id, 47);
  assert.equal(guessMythicPlusZone(zones.slice(0, 2)).id, 39, "frozen fallback");
});

test("a season rollover picks the NEW season while the old one is still unfrozen", () => {
  // the real shape at the 12.1 rollover: Warcraft Logs left Season 1 (47)
  // unfrozen for a while after Season 2 (55) opened, both in expansion 7 —
  // so "newest expansion" alone does not decide it, the zone id must
  const zones = [
    { id: 47, name: "Mythic+ Season 1", frozen: false, brackets: { type: "Keystone Level", min: 2, max: 25 }, expansion: { id: 7 } },
    { id: 55, name: "Mythic+ Season 2", frozen: false, brackets: { type: "Keystone Level", min: 2, max: 30 }, expansion: { id: 7 } },
    { id: 45, name: "Mythic+ Season 3", frozen: true, brackets: { type: "Keystone Level" }, expansion: { id: 6 } },
  ];
  assert.equal(guessMythicPlusZone(zones).id, 55, "Season 2 wins over a still-open Season 1");
  assert.equal(guessMythicPlusZone([...zones].reverse()).id, 55, "and not by list order");
});

test("buildRunBundleQuery asks for exactly what damage, kicks, stops and dispels need", () => {
  const item = { code: "ABC", fightID: 8, kickIds: new Set([6552]), dangerousIds: new Set([1294557, 1289416]), tables: true };
  const events = buildRunBundleQuery([item], "events");
  assert.match(events, /fights\(fightIDs: \[8\]\)/);
  assert.match(events, /deaths: events\(fightIDs: \[8\], dataType: Deaths, hostilityType: Friendlies/, "deaths: only for the alive check in kick utilisation");
  assert.match(events, /ints: events\(fightIDs: \[8\], dataType: Interrupts, hostilityType: Friendlies/);
  assert.match(events, /kick: events\(fightIDs: \[8\], dataType: Casts, hostilityType: Friendlies, filterExpression: "ability\.id in \(6552\)"/, "the kick's casts only");
  assert.match(events, /begin: events\(fightIDs: \[8\], dataType: Casts, hostilityType: Enemies, filterExpression: "ability\.id in \(1294557,1289416\) and \(type = \\"begincast\\" or type = \\"cast\\"\)"/);
  assert.ok(!/low: events|DamageTaken|Healing|playerDetails|table\(/.test(events), "no low-HP stream, no healing, no tables in the events half");
  const tables = buildRunBundleQuery([item], "tables");
  assert.match(tables, /masterData \{ actors\(type: "Player"\)/);
  assert.match(tables, /playerDetails\(fightIDs: \[8\]\)/);
  assert.match(tables, /summary: table\(fightIDs: \[8\], dataType: Summary\)/);
  assert.match(tables, /interrupts: table\(fightIDs: \[8\], dataType: Interrupts\)/);
  assert.match(tables, /dispels: table\(fightIDs: \[8\], dataType: Dispels\)/);
  assert.ok(!/dmgTaken|casts: table|healing: table|events\(/.test(tables), "no damage-taken, casts or healing tables, no events in the tables half");
  const stored = buildRunBundleQuery([{ ...item, tables: false, kickIds: new Set(), dangerousIds: new Set() }], "all");
  assert.ok(!/table\(/.test(stored), "a stored run never asks for tables");
  assert.ok(!/kick: events|begin: events/.test(stored), "no kick, no dangerous list: those streams are not asked for");
  assert.match(stored, /deaths: events/);
  assert.match(stored, /ints: events/);
});

test("fetchRunBundles: one request per run, two for a run that needs tables, merged into one bundle", async () => {
  const f = fakeFetch((url, opts) => {
    const q = JSON.parse(opts.body).query;
    const node = { fights: [{ id: 8, startTime: 0, endTime: 1000 }] };
    if (/deaths: events/.test(q)) Object.assign(node, { deaths: { data: [{ timestamp: 5, targetID: 1 }] }, ints: { data: [{ timestamp: 7, sourceID: 1, abilityGameID: 6552 }] }, kick: { data: [{ timestamp: 6, sourceID: 1, type: "cast", abilityGameID: 6552 }] }, begin: { data: [] } });
    if (/summary: table/.test(q)) Object.assign(node, { masterData: { actors: [{ id: 1, name: "A" }] }, playerDetails: { data: { playerDetails: { dps: [] } } }, summary: { s: 1 }, interrupts: {}, dispels: {} });
    return { json: { data: { reportData: { r0: node } } } };
  });
  const out = await fetchRunBundles({ token: "t", fetchImpl: f }, [
    { code: "STORED", fightID: 8, tables: false, kickIds: new Set([6552]), dangerousIds: new Set([1]) },
    { code: "ABSENT", fightID: 8, tables: true, kickIds: new Set([6552]), dangerousIds: new Set([1]) },
  ]);
  assert.equal(f.calls.length, 3, "one request for the stored run, two for the absent one");
  const queries = f.calls.map((c) => JSON.parse(c.opts.body).query);
  assert.ok(queries.every((q) => q.split("report(code:").length === 2), "never more than one run per request");
  const absent = queries.filter((q) => q.includes('"ABSENT"'));
  assert.ok(absent.some((q) => /deaths: events/.test(q) && !/summary: table/.test(q) && /fights\(/.test(q)), "an events half, with the fight");
  assert.ok(absent.some((q) => /summary: table/.test(q) && /playerDetails/.test(q) && !/deaths: events/.test(q)), "a tables half, with the actors");
  assert.equal(out[0].bundle.tables, null, "a stored run never asks for tables");
  assert.equal(out[0].bundle.events.deaths.length, 1);
  assert.equal(out[0].bundle.events.kickCasts.length, 1);
  assert.equal(out[0].bundle.events.interrupts.length, 1);
  assert.deepEqual(out[0].bundle.events.begin, []);
  assert.ok(!("low35" in out[0].bundle.events), "no low-HP stream in the bundle");
  assert.equal(out[1].bundle.events.deaths.length, 1, "events from one half…");
  assert.ok(out[1].bundle.tables?.summary, "…tables from the other");
  assert.deepEqual(Object.keys(out[1].bundle.tables).sort(), ["dispels", "interrupts", "summary"]);
  assert.equal(out[1].bundle.actors.length, 1);
  assert.equal(out[1].bundle.fight.endTime, 1000);
});

test("gql keeps at most MAX_IN_FLIGHT requests in flight and drains the queue", async () => {
  let now = 0, peak = 0;
  const f = async () => {
    now++; peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
    return { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  };
  const out = await Promise.all(Array.from({ length: 30 }, () => gql({ token: "t", query: "{ x }", fetchImpl: f })));
  assert.equal(out.length, 30);
  assert.equal(peak, MAX_IN_FLIGHT);
  assert.equal(inFlightCount(), 0);
  // a failure releases its slot too
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(gql({ token: "t", query: "{ x }", fetchImpl: bad }), /HTTP 500/);
  assert.equal(inFlightCount(), 0);
});
