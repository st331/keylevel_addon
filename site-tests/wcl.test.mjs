import { test } from "node:test";
import assert from "node:assert/strict";
import { getToken, gql, buildCharacterQuery, fetchCharacters, fetchCharactersParallel, guessMythicPlusZone, WclError } from "../docs/js/wcl.js";

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
