-- test_core.lua — pure logic: names, colors, evaluation, encounter mapping.

local B = _G.__B
local T = B.T
local mock = B.mock
local ns, directives = B.StartSession({})

T.group("toc sanity")
T.ok(directives.Interface and directives.Interface:match("^%d+"), "Interface directive present")
T.eq(directives.SavedVariables, "KeyLevelLogsDB", "SavedVariables declared")
T.ok(directives.Title, "Title present")

local AK = 12660       -- Ara-Kara (fixture)
local COT = 12669      -- City of Threads (fixture)
local MISTS = 62290    -- Mists (fixture, no challengeMapID)

T.group("NormalizeName")
T.eq(ns.NormalizeName("Alice"), "Alice-TestRealm", "bare name gets player realm")
T.eq(ns.NormalizeName("Alice-TestRealm"), "Alice-TestRealm", "already qualified")
T.eq(ns.NormalizeName("Foo-Some Realm"), "Foo-SomeRealm", "spaces stripped from realm")
T.eq(ns.NormalizeName("Foo-Kil'jaeden"), "Foo-Kiljaeden", "apostrophes stripped from realm")
T.eq(ns.NormalizeName("Foo-Azjol-Nerub"), "Foo-AzjolNerub", "hyphens inside realm stripped")
T.eq(ns.NormalizeName("Foo-Quel.Thalas"), "Foo-QuelThalas", "periods stripped from realm")
T.is_nil(ns.NormalizeName(nil), "nil name")
T.is_nil(ns.NormalizeName(""), "empty name")

T.group("NormalizeName with unknown player realm (loading screen)")
local savedRealm = mock.state.realmNormalized
mock.state.realmNormalized = nil
T.is_nil(ns.NormalizeName("Alice"), "bare name skipped rather than mis-keyed")
T.eq(ns.NormalizeName("Alice-Area52"), "Alice-Area52", "qualified names still work")
mock.state.realmNormalized = savedRealm

T.group("DisplayName")
T.eq(ns.DisplayName("Alice-TestRealm"), "Alice", "own realm hidden")
T.eq(ns.DisplayName("Eve-OtherRealm"), "Eve-OtherRealm", "other realm shown")

T.group("ColorForPercent")
T.eq(ns.ColorForPercent(100), "e5cc80", "100 gold")
T.eq(ns.ColorForPercent(99), "e268a8", "99 pink")
T.eq(ns.ColorForPercent(95), "ff8000", "95 orange")
T.eq(ns.ColorForPercent(94.9), "a335ee", "94.9 purple")
T.eq(ns.ColorForPercent(75), "a335ee", "75 purple")
T.eq(ns.ColorForPercent(50), "0070ff", "50 blue")
T.eq(ns.ColorForPercent(25), "1eff00", "25 green")
T.eq(ns.ColorForPercent(0), "9d9d9d", "0 gray")
T.contains(ns.FormatPercent(99.6), "99", "FormatPercent floors")
T.contains(ns.FormatPercent(99.6), "e268a8", "99.6 floors to 99 => pink")

T.group("AgeTag")
T.is_nil(ns.AgeTag(mock.state.now - 3600), "1h old: fresh")
T.is_nil(ns.AgeTag(mock.state.now - 47 * 3600), "47h old: fresh")
T.eq(ns.AgeTag(mock.state.now - 5 * 86400), "5d", "5 days")
T.eq(ns.AgeTag(mock.state.now - 300 * 86400), "99d+", "capped")
T.is_nil(ns.AgeTag(nil), "unknown updated")

T.group("EncounterForMap")
local enc, name = ns.EncounterForMap(503)
T.eq(enc, AK, "maps 503 by explicit challengeMapID")
T.eq(name, "Ara-Kara, City of Echoes", "dungeon name")
local enc2 = ns.EncounterForMap(375) -- fixture has no challengeMapID for Mists; falls back to name match
T.eq(enc2, MISTS, "name-based fallback when challengeMapID missing")
T.is_nil(ns.EncounterForMap(99999), "unknown map id")
T.is_nil(ns.EncounterForMap(nil), "nil map id")

T.group("EncounterByName")
T.eq((ns.EncounterByName("City of Threads")), COT, "exact name")
T.eq((ns.EncounterByName("city of threads")), COT, "case-insensitive")
T.eq((ns.EncounterByName("ara-kara")), AK, "partial match")
T.eq((ns.EncounterByName("Ara-Kara, City of Echoes (Mythic Keystone)")), AK,
  "decorated activity fullName matches (reverse containment)")
T.eq((ns.EncounterByName("city")), COT, "ambiguous match resolves deterministically (prefix wins)")
T.is_nil((ns.EncounterByName("Nonexistent Hall")), "no match")

T.group("Evaluate: exact hit")
local alice = ns.LookupPlayer("Alice-TestRealm")
local e = ns.Evaluate(alice, AK, 12)
T.eq(e.status, "OK", "status")
T.near(e.anyAtLevel.pct, 91.2, 0.001, "any at 12")
T.eq(e.anyAtLevel.runs, 2, "runs at 12")
T.near(e.dungeon.pct, 91.2, 0.001, "dungeon pct")
T.eq(e.dungeon.level, 12, "dungeon level")
T.eq(e.dungeon.kind, "exact", "exact hit")

T.group("Evaluate: fallback one level below")
local bob = ns.LookupPlayer("Bob-TestRealm")
e = ns.Evaluate(bob, AK, 12)
T.near(e.anyAtLevel.pct, 77.0, 0.001, "bob any at 12")
T.near(e.dungeon.pct, 76.4, 0.001, "bob AK from +11")
T.eq(e.dungeon.level, 11, "fallback level")
T.eq(e.dungeon.kind, "below", "one below")

T.group("Evaluate: higher level counts (above)")
e = ns.Evaluate(alice, AK, 10) -- alice has AK at 11 and 12; nearest above is 11
T.eq(e.dungeon.kind, "above", "above kind")
T.eq(e.dungeon.level, 11, "nearest higher level picked")
T.near(e.dungeon.pct, 88.0, 0.001, "pct from +11")
local eve = ns.LookupPlayer("Eve-OtherRealm")
e = ns.Evaluate(eve, MISTS, 11) -- eve has Mists at 12 only
T.eq(e.dungeon.kind, "above", "eve above")
T.eq(e.dungeon.level, 12, "eve above level")
local carol = ns.LookupPlayer("Carol-TestRealm")
e = ns.Evaluate(carol, AK, 2) -- carol's +9 counts as above for a +2
T.eq(e.dungeon.kind, "above", "+9 log qualifies for a +2 key")
T.eq(e.dungeon.level, 9, "level 9")
T.is_nil(e.dungeonBest, "no dungeonBest when dungeon found")

T.group("Evaluate: nothing at level, above, or one below")
e = ns.Evaluate(carol, AK, 12)
T.is_nil(e.anyAtLevel, "carol has nothing at 12")
T.is_nil(e.dungeon, "no 12/above/11 for AK")
T.eq(e.dungeonBest.level, 9, "best AK level")
T.near(e.dungeonBest.pct, 55.5, 0.001, "best AK pct")
T.eq(e.anyBest.level, 9, "best any level")

T.group("Evaluate: level yes, dungeon never")
e = ns.Evaluate(eve, AK, 12)
T.near(e.anyAtLevel.pct, 99.5, 0.001, "eve any at 12")
T.is_nil(e.dungeon, "never did AK")
T.is_nil(e.dungeonBest, "no AK at any level")

T.group("Evaluate: unknown player / bad data / missing on WCL")
e = ns.Evaluate(nil, AK, 12)
T.eq(e.status, "NO_PLAYER", "nil player")
e = ns.Evaluate({}, AK, 12)
T.eq(e.status, "NO_PLAYER", "player with no levels table")
e = ns.Evaluate(ns.LookupPlayer("Nolan-TestRealm"), AK, 12)
T.eq(e.status, "NO_WCL", "companion marked player as missing on WCL")

T.group("Evaluate: no key level context")
e = ns.Evaluate(alice, AK, nil)
T.eq(e.status, "OK", "still OK")
T.is_nil(e.anyAtLevel, "no level -> no anyAtLevel")
T.is_nil(e.dungeon, "no level -> no dungeon cell")
T.eq(e.anyBest.level, 12, "anyBest reported")

T.group("Evaluate: no encounter context")
e = ns.Evaluate(alice, nil, 12)
T.near(e.anyAtLevel.pct, 91.2, 0.001, "any still works")
T.is_nil(e.dungeon, "no dungeon without encounter")
T.is_nil(e.dungeonBest, "no dungeonBest without encounter")

T.group("Evaluate: one-below at the bottom")
e = ns.Evaluate(carol, AK, 10) -- 10-1 = 9, carol has AK at 9: a below hit
T.ok(e.dungeon and e.dungeon.kind == "below", "one-below hit at +9 for a +10 key")
T.eq(e.dungeon and e.dungeon.level, 9, "fallback level 9")
