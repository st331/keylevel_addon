import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, pruneCache, slimResult, CHAR_CACHE_TTL, CHAR_CACHE_MAX } from "../docs/js/cache.js";
import { playerFromResult, detectRole, buildRolePlayers } from "../docs/js/transform.js";

test("cacheKey: per season, per character, case-insensitive", () => {
  assert.equal(cacheKey(47, "Foo-Area52", "us"), "47:foo-area52@us");
  assert.notEqual(cacheKey(47, "Foo-Area52", "us"), cacheKey(48, "Foo-Area52", "us"),
    "a new season misses the old entries");
  assert.notEqual(cacheKey(47, "Foo-Area52", "us"), cacheKey(47, "Foo-Area52", "eu"));
});

test("pruneCache drops expired entries and keeps the newest under the cap", () => {
  const now = 1_780_000_000_000;
  const entries = {
    fresh: { t: now - 1000 },
    edge: { t: now - CHAR_CACHE_TTL + 1000 },
    stale: { t: now - CHAR_CACHE_TTL - 1 },
    junk: { t: "nope" },
    nul: null,
  };
  const pruned = pruneCache(entries, now);
  assert.deepEqual(Object.keys(pruned).sort(), ["edge", "fresh"]);

  // cap: newest CHAR_CACHE_MAX survive
  const many = {};
  for (let i = 0; i < CHAR_CACHE_MAX + 10; i++) many[`c${i}`] = { t: now - i * 1000 };
  const capped = pruneCache(many, now);
  assert.equal(Object.keys(capped).length, CHAR_CACHE_MAX);
  assert.ok(capped.c0, "newest kept");
  assert.equal(capped[`c${CHAR_CACHE_MAX + 5}`], undefined, "oldest evicted");

  assert.deepEqual(pruneCache(null, now), {});
});

test("slimResult round-trips through every transform unchanged", () => {
  const raw = {
    classID: 5,
    // junk the API sends that the site never reads
    bestAmount: 12345.6, totalKills: 99,
    e1: {
      bestAmount: 999, medianPerformance: 40,
      ranks: [
        { historicalPercent: 91.2, rankPercent: 91.2, todayPercent: 85, bracketData: 12,
          amount: 100, spec: "Mistweaver", score: 450, startTime: 1_700_000_000_000,
          report: { code: "C0DE", fightID: 7, startTime: 1 }, guild: { name: "x" }, server: { id: 1 } },
        { historicalPercent: 40.0, rankPercent: 40.0, bracketData: 12,
          amount: 90, spec: "Brewmaster", score: 400, startTime: 1_600_000_000_000 },
      ],
    },
    e2: { ranks: [] },
  };
  const slim = slimResult(raw);
  assert.equal(slim.bestAmount, undefined, "junk dropped");
  assert.equal(slim.e1.ranks[0].guild, undefined);
  assert.deepEqual(slim.e1.ranks[0].report, { code: "C0DE", fightID: 7 });

  assert.equal(detectRole(slim), detectRole(raw), "role detection identical");
  assert.deepEqual(playerFromResult(slim, "healer", "healer"), playerFromResult(raw, "healer", "healer"));
  assert.deepEqual(buildRolePlayers(slim, slim).order, buildRolePlayers(raw, raw).order);

  assert.equal(slimResult(null), null, "missing characters cache as misses");
});
