import { test } from "node:test";
import assert from "node:assert/strict";
import { getToken, gql, buildCharacterQuery, fetchCharacters, guessMythicPlusZone, isMythicPlusZone, WclError } from "../lib/wcl.mjs";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const out = handler(url, opts, calls.length);
    return {
      ok: out.status === undefined || out.status < 400,
      status: out.status ?? 200,
      json: async () => out.json,
      text: async () => JSON.stringify(out.json),
    };
  };
  impl.calls = calls;
  return impl;
}

test("getToken posts client credentials with basic auth", async () => {
  const f = fakeFetch(() => ({ json: { access_token: "tok123" } }));
  const token = await getToken({ clientId: "id", clientSecret: "sec", fetchImpl: f });
  assert.equal(token, "tok123");
  const call = f.calls[0];
  assert.equal(call.url, "https://www.warcraftlogs.com/oauth/token");
  assert.match(call.opts.headers.Authorization, /^Basic /);
  assert.equal(
    Buffer.from(call.opts.headers.Authorization.slice(6), "base64").toString(),
    "id:sec",
  );
  assert.equal(call.opts.body, "grant_type=client_credentials");
});

test("getToken surfaces HTTP failures", async () => {
  const f = fakeFetch(() => ({ status: 401, json: { error: "unauthorized" } }));
  await assert.rejects(
    getToken({ clientId: "x", clientSecret: "y", fetchImpl: f }),
    WclError,
  );
});

test("gql sends bearer token and returns data despite partial errors", async () => {
  const f = fakeFetch(() => ({
    json: { data: { some: "thing" }, errors: [{ message: "character not found" }] },
  }));
  const data = await gql({ token: "tok", query: "query{}", fetchImpl: f });
  assert.deepEqual(data, { some: "thing" });
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer tok");
});

test("gql throws on errors with no data, and on 429", async () => {
  const f1 = fakeFetch(() => ({ json: { errors: [{ message: "boom" }] } }));
  await assert.rejects(gql({ token: "t", query: "q", fetchImpl: f1 }), /boom/);
  const f2 = fakeFetch(() => ({ status: 429, json: {} }));
  await assert.rejects(gql({ token: "t", query: "q", fetchImpl: f2 }), /rate limited/);
});

test("buildCharacterQuery aliases characters and encounters", () => {
  const q = buildCharacterQuery(
    [
      { name: "Foo", serverSlug: "area-52", region: "us" },
      { name: 'O"Hara', serverSlug: "sargeras", region: "us" },
    ],
    [{ id: 12805 }, { id: 361753 }],
    "playerscore",
  );
  assert.match(q, /c0: character\(name: "Foo", serverSlug: "area-52", serverRegion: "us"\)/);
  assert.match(q, /c1: character\(name: "O\\"Hara"/, "quotes in names escaped");
  assert.match(q, /e12805: encounterRankings\(encounterID: 12805, metric: playerscore, byBracket: true\)/);
  assert.match(q, /e361753: encounterRankings\(encounterID: 361753/);
  assert.match(q, /classID/);
});

test("fetchCharacters maps aliased results back to characters", async () => {
  const f = fakeFetch(() => ({
    json: {
      data: {
        characterData: {
          c0: { classID: 4, e1: { ranks: [] } },
          c1: null,
        },
      },
    },
  }));
  const out = await fetchCharacters(
    { token: "t", fetchImpl: f },
    [
      { key: "Foo-Area52", name: "Foo", serverSlug: "area-52", region: "us" },
      { key: "Bar-Sargeras", name: "Bar", serverSlug: "sargeras", region: "us" },
    ],
    [{ id: 1 }],
    "playerscore",
  );
  assert.equal(out[0].result.classID, 4);
  assert.equal(out[1].result, null, "unknown character resolves to null result");
});

const ZONES = [
  { id: 39, name: "Mythic+ Season 1", frozen: true, brackets: { type: "Keystone Level", min: 2, max: 25, bucket: 1 }, expansion: { id: 10, name: "TWW" } },
  { id: 46, name: "Launch Raids", frozen: false, brackets: { type: "Item Level", min: 600, max: 700, bucket: 10 }, expansion: { id: 11, name: "Midnight" } },
  { id: 47, name: "Mythic+ Season 1", frozen: false, brackets: { type: "Keystone Level", min: 2, max: 25, bucket: 1 }, expansion: { id: 11, name: "Midnight" } },
  { id: 56, name: "Mythic+ Season 2 (PTR)", frozen: false, brackets: { type: "Keystone Level", min: 2, max: 25, bucket: 1 }, expansion: { id: 11, name: "Midnight" } },
];

test("isMythicPlusZone keys off the bracket type", () => {
  assert.ok(isMythicPlusZone(ZONES[0]));
  assert.ok(!isMythicPlusZone(ZONES[1]));
});

test("guessMythicPlusZone picks the live keystone zone, skipping PTR", () => {
  const z = guessMythicPlusZone(ZONES);
  assert.equal(z.id, 47);
});

test("guessMythicPlusZone falls back to frozen zones if none live", () => {
  const z = guessMythicPlusZone([ZONES[0], ZONES[1]]);
  assert.equal(z.id, 39);
});
