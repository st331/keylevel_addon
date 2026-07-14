import { test } from "node:test";
import assert from "node:assert/strict";
import { getToken, gql, buildCharacterQuery, fetchCharacters, guessMythicPlusZone, WclError } from "../docs/js/wcl.js";

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
