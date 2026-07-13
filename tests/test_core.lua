-- test_core.lua — pure logic: names, URL building, recruiting context.

local B = _G.__B
local T = B.T
local mock = B.mock
local ns, directives = B.StartSession({})

T.group("toc sanity")
T.ok(directives.Interface and directives.Interface:match("^%d+"), "Interface directive present")
T.eq(directives.SavedVariables, "KeyLevelLogsDB", "SavedVariables declared")
T.ok(directives.Title, "Title present")

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

T.group("URLEncode")
T.eq(ns.URLEncode("Alice-Area52"), "Alice-Area52", "unreserved chars untouched")
T.eq(ns.URLEncode("a b"), "a%20b", "space encoded")
T.eq(ns.URLEncode("a&b=c"), "a%26b%3Dc", "query metachars encoded")
T.eq(ns.URLEncode("Ñight"), "%C3%91ight", "utf-8 bytes percent-encoded")

T.group("RegionSlug")
T.eq(ns.RegionSlug(), "us", "region 1 = us")
mock.state.region = 3
T.eq(ns.RegionSlug(), "eu", "region 3 = eu")
mock.state.region = 99
T.eq(ns.RegionSlug(), "us", "unknown region falls back to us")
mock.state.region = nil

T.group("context from own keystone")
mock.state.keystoneLevel = 12
mock.state.keystoneMapID = 503
local ctx = ns.GetContext()
T.eq(ctx.level, 12, "level from keystone")
T.eq(ctx.dungeonName, "Ara-Kara, City of Echoes", "dungeon name from challenge map")

T.group("context from active listing beats keystone")
mock.state.activeEntry = { name = "LF healer +13 weekly", activityIDs = { 999 } }
mock.state.activities = { [999] = { fullName = "City of Threads (Mythic Keystone)", isMythicPlusActivity = true } }
ctx = ns.GetContext()
T.eq(ctx.level, 13, "level parsed from listing title")
T.eq(ctx.dungeonName, "City of Threads", "dungeon from listing, decoration stripped")
mock.state.activeEntry = nil
mock.state.activities = nil
ctx = ns.GetContext()
T.eq(ctx.level, 12, "keystone again once listing is gone")

T.group("context overrides")
ns.db.keyLevelOverride = 14
ns.db.dungeonOverride = "Mists of Tirna Scithe"
ctx = ns.GetContext()
T.eq(ctx.level, 14, "manual level wins")
T.eq(ctx.dungeonName, "Mists of Tirna Scithe", "manual dungeon wins")
ns.db.keyLevelOverride = nil
ns.db.dungeonOverride = nil

T.group("BuildLookupURL")
local url = ns.BuildLookupURL({ "Alice-TestRealm", "Bob-Area52" })
T.contains(url, "https://st331.github.io/keylevel_addon/?", "default site base")
T.contains(url, "region=us", "region param")
T.contains(url, "level=12", "level param from context")
T.contains(url, "dungeon=Ara-Kara%2C%20City%20of%20Echoes", "dungeon param encoded")
T.contains(url, "chars=Alice-TestRealm,Bob-Area52", "names joined with comma")

T.group("BuildLookupURL respects /kll site override")
ns.db.siteURL = "https://example.com/lookup/"
url = ns.BuildLookupURL({ "Alice-TestRealm" })
T.contains(url, "https://example.com/lookup/?", "custom base used")
ns.db.siteURL = nil

T.group("BuildLookupURL without context")
mock.state.keystoneLevel = nil
mock.state.keystoneMapID = nil
url = ns.BuildLookupURL({ "Alice-TestRealm" })
T.not_contains(url, "level=", "no level param when unknown")
T.not_contains(url, "dungeon=", "no dungeon param when unknown")
T.contains(url, "chars=Alice-TestRealm", "names still present")
mock.state.keystoneLevel = 12
mock.state.keystoneMapID = 503
