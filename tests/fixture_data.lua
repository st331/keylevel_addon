-- fixture_data.lua — a realistic KeyLevelLogsData for tests.
-- Encounter IDs are arbitrary but stable within the tests.

return {
  meta = {
    generatedAt = "2026-07-13T00:00:00Z",
    region = "us",
    zoneID = 45,
    zoneName = "Test Season Dungeons",
  },
  dungeons = {
    [12660] = { name = "Ara-Kara, City of Echoes", challengeMapID = 503 },
    [12669] = { name = "City of Threads", challengeMapID = 502 },
    [62290] = { name = "Mists of Tirna Scithe" }, -- intentionally no challengeMapID: exercises name matching
  },
  players = {
    -- has the exact dungeon at the exact level
    ["Alice-TestRealm"] = {
      class = "MAGE",
      updated = 1752000000,
      levels = {
        [12] = { best = 91.2, runs = 2, dungeons = {
          [12660] = { pct = 91.2, spec = "Fire" },
          [12669] = { pct = 71.0, spec = "Fire" },
        } },
        [11] = { best = 88.0, runs = 2, dungeons = {
          [12660] = { pct = 88.0, spec = "Fire" },
          [62290] = { pct = 60.0, spec = "Frost" },
        } },
      },
    },
    -- has the level (elsewhere) but only one-below for the target dungeon
    ["Bob-TestRealm"] = {
      class = "WARRIOR",
      updated = 1752000000,
      levels = {
        [12] = { best = 77.0, runs = 1, dungeons = {
          [12669] = { pct = 77.0, spec = "Protection" },
        } },
        [11] = { best = 76.4, runs = 1, dungeons = {
          [12660] = { pct = 76.4, spec = "Fury" },
        } },
      },
    },
    -- nothing at level or level-1; best is far below
    ["Carol-TestRealm"] = {
      class = "PRIEST",
      updated = 1752000000,
      levels = {
        [9] = { best = 55.5, runs = 1, dungeons = {
          [12660] = { pct = 55.5, spec = "Discipline" },
        } },
      },
    },
    -- great at the level, but never logged the target dungeon at all
    ["Eve-OtherRealm"] = {
      class = "DRUID",
      updated = 1752000000,
      levels = {
        [12] = { best = 99.5, runs = 1, dungeons = {
          [62290] = { pct = 99.5, spec = "Restoration" },
        } },
      },
    },
  },
}
