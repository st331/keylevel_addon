import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProfileURL, seasonLabel, safeColor, parseScores,
  fetchCharacterScores, fetchScores, SEASON_FIELDS, DEFAULT_RIO_URL,
} from "../docs/js/rio.js";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(url);
    const out = handler(url, calls.length);
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => out.json,
    };
  };
  impl.calls = calls;
  return impl;
}

// a realistic slice of the API's shape
const profile = (seasons) => ({
  name: "Zerøcool", realm: "Silvermoon",
  mythic_plus_scores_by_season: seasons,
});
const season = (slug, all, extra = {}) => ({
  season: slug,
  scores: { all, tank: 0, healer: 0, dps: all, ...extra },
  segments: { all: { score: all, color: "#ff8000" } },
});

test("buildProfileURL asks for both seasons in ONE colon-chained field", () => {
  const url = buildProfileURL({ name: "Zerøcool", slug: "silvermoon", region: "eu" });
  const q = new URL(url).searchParams;
  assert.equal(q.get("region"), "eu");
  assert.equal(q.get("realm"), "silvermoon");
  assert.equal(q.get("name"), "Zerøcool", "unicode names round-trip");
  assert.equal(q.get("fields"), "mythic_plus_scores_by_season:current:previous");
  // repeating the field name instead of chaining silently returns only one
  // season — which is indistinguishable from "no score this season"
  assert.equal(SEASON_FIELDS.split("mythic_plus_scores_by_season").length - 1, 1,
    "exactly one field name, seasons chained onto it");
  assert.ok(url.startsWith(DEFAULT_RIO_URL));
});

test("seasonLabel derives the label from the slug, no hardcoded seasons", () => {
  assert.equal(seasonLabel("season-mn-2"), "S2");
  assert.equal(seasonLabel("season-mn-1"), "S1");
  assert.equal(seasonLabel("season-tww-4"), "S4", "works for a future expansion");
  assert.equal(seasonLabel("season-mn-1-break-the-meta"), "season-mn-1-break-the-meta",
    "an unrecognized shape keeps its slug rather than mislabeling");
  assert.equal(seasonLabel(undefined), "");
});

test("safeColor only lets a plain hex colour through", () => {
  assert.equal(safeColor("#ff8000"), "#ff8000");
  assert.equal(safeColor("#FFF"), "#FFF");
  assert.equal(safeColor("red"), null);
  assert.equal(safeColor("#fff;background:url(x)"), null, "no style injection");
  assert.equal(safeColor('#fff" onload="x'), null);
  assert.equal(safeColor(undefined), null);
});

test("parseScores keeps real seasons newest-first and drops unplayed ones", () => {
  const out = parseScores(profile([season("season-mn-2", 3515), season("season-mn-1", 4350.5)]));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.label), ["S2", "S1"]);
  assert.equal(out[0].all, 3515);
  assert.equal(out[1].all, 4350.5);
  assert.equal(out[0].color, "#ff8000");

  // a season the character never played comes back as zeros; showing "0"
  // would read as "terrible", not "didn't play"
  const zeroed = parseScores(profile([season("season-mn-2", 3249.5), season("season-mn-1", 0)]));
  assert.deepEqual(zeroed.map((s) => s.label), ["S2"]);

  assert.deepEqual(parseScores({}), []);
  assert.deepEqual(parseScores(null), []);
});

test("parseScores rejects a hostile colour from the API", () => {
  const evil = profile([{ season: "season-mn-2", scores: { all: 100 }, segments: { all: { color: '#000" onmouseover="alert(1)' } } }]);
  assert.equal(parseScores(evil)[0].color, null);
});

test("fetchCharacterScores fails soft on every failure mode", async () => {
  const ok = await fetchCharacterScores({ name: "A", slug: "s", region: "eu" },
    { fetchImpl: fakeFetch(() => ({ json: profile([season("season-mn-2", 3000)]) })) });
  assert.equal(ok[0].all, 3000);

  // unknown character / bad request / rate limited
  for (const status of [400, 404, 429, 500]) {
    const r = await fetchCharacterScores({ name: "A", slug: "s", region: "eu" },
      { fetchImpl: fakeFetch(() => ({ status, json: {} })) });
    assert.equal(r, null, `HTTP ${status} -> no scores, no throw`);
  }

  // network blows up entirely
  const boom = await fetchCharacterScores({ name: "A", slug: "s", region: "eu" },
    { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(boom, null);

  // reachable but the character has no scored season
  const empty = await fetchCharacterScores({ name: "A", slug: "s", region: "eu" },
    { fetchImpl: fakeFetch(() => ({ json: profile([season("season-mn-2", 0)]) })) });
  assert.equal(empty, null);
});

test("a realm slug WCL accepted but Raider.IO doesn't falls back to the other spelling", async () => {
  // real hazard: WCL resolved "area52", Raider.IO only knows "area-52"
  const impl = fakeFetch((url) => url.includes("realm=area-52")
    ? { json: profile([season("season-mn-2", 3515)]) }
    : { status: 400, json: { statusCode: 400 } });
  const out = await fetchCharacterScores(
    { name: "Foo", slugs: ["area52", "area-52"], region: "us" }, { fetchImpl: impl });
  assert.equal(out[0].all, 3515, "found on the second spelling");
  assert.equal(impl.calls.length, 2);

  // a character genuinely absent costs every candidate then gives up quietly
  const missing = fakeFetch(() => ({ status: 404, json: {} }));
  assert.equal(await fetchCharacterScores({ name: "X", slugs: ["a", "b"], region: "us" }, { fetchImpl: missing }), null);
  assert.equal(missing.calls.length, 2);

  // no needless retry once the first spelling works
  const first = fakeFetch(() => ({ json: profile([season("season-mn-2", 100)]) }));
  await fetchCharacterScores({ name: "Y", slugs: ["a", "b"], region: "us" }, { fetchImpl: first });
  assert.equal(first.calls.length, 1);
});

test("fetchScores keys results back to each character", async () => {
  const impl = fakeFetch((url) => ({
    json: profile([season("season-mn-2", url.includes("Bee") ? 1234 : 999)]),
  }));
  const out = await fetchScores([
    { key: "Ay-R@eu", name: "Ay", slug: "r", region: "eu" },
    { key: "Bee-R@us", name: "Bee", slug: "r", region: "us" },
  ], { fetchImpl: impl });
  assert.deepEqual(out.map((o) => o.key), ["Ay-R@eu", "Bee-R@us"]);
  assert.equal(out[1].scores[0].all, 1234);
  assert.equal(impl.calls.length, 2, "one small request per character");
});
