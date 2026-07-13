-- test_saved_vars.lua — behavior across sessions: persisted position,
-- overrides, pruning, corrupted SavedVariables, secret-value defense.

local B = _G.__B
local T = B.T
local mock = B.mock

T.group("returning player: saved state honored")
local now = 1750000000 -- mock clock at install
local ns = B.StartSession({
  savedVars = {
    window = { point = "BOTTOMRIGHT", relPoint = "BOTTOMRIGHT", x = -20, y = 30, shown = false },
    keyLevelOverride = 14,
    seenApplicants = {
      ["Ancient-TestRealm"] = { lastSeen = 1000, class = "ROGUE" },      -- ancient -> pruned
      ["Recent-TestRealm"] = { lastSeen = now - 100, class = "MAGE" },   -- fresh -> kept
      ["Broken-TestRealm"] = "not-a-table",                              -- corrupt entry -> pruned
    },
  },
  keystoneLevel = 12,
  keystoneMapID = 503,
})
local frame = _G.KeyLevelLogsFrame
T.ok(not frame:IsShown(), "window stays hidden as saved")
local point, _, relPoint, x, y = frame:GetPoint(1)
T.eq(point, "BOTTOMRIGHT", "saved point restored")
T.eq(x, -20, "saved x restored")
T.eq(y, 30, "saved y restored")
T.eq(ns.GetContext().level, 14, "manual key level override persisted over keystone")
local db = _G.KeyLevelLogsDB
T.is_nil(db.seenApplicants["Ancient-TestRealm"], "stale entry pruned")
T.is_nil(db.seenApplicants["Broken-TestRealm"], "corrupt entry pruned")
T.ok(db.seenApplicants["Recent-TestRealm"], "recent entry kept")
T.eq(db.autoShow, true, "new defaults merged in")

T.group("corrupted SavedVariables replaced")
ns = B.StartSession({ savedVars = "garbage string" })
T.eq(type(_G.KeyLevelLogsDB), "table", "DB rebuilt as table")
T.eq(_G.KeyLevelLogsDB.window.point, "CENTER", "defaults applied")

T.group("secret values are skipped, not crashed on")
ns = B.StartSession({ keystoneLevel = 12, keystoneMapID = 503 })
local secretName = "Secret-TestRealm"
mock.state.secretValues = { [secretName] = true, [77] = true }
mock.SetApplicants({
  { applicantID = 5, members = { { name = "Alice", class = "MAGE" } } },
  { applicantID = 6, members = { { name = secretName, class = "ROGUE" } } }, -- secret name
  { applicantID = 77, members = { { name = "Frank-TestRealm", class = "DRUID" } } }, -- secret id
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 1, "only the clean applicant tracked")
T.contains(ns.applicants[1].name, "Alice", "clean applicant kept")
mock.state.secretValues = nil

T.group("data file missing entirely (nil global)")
ns = B.StartSession({ data = false, keystoneLevel = 12, keystoneMapID = 503 })
_G.KeyLevelLogsData = nil -- as if Data.lua failed to load
mock.SetApplicants({ { applicantID = 1, members = { { name = "Alice", class = "MAGE" } } } })
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5) -- must not error
T.eq(#ns.applicants, 1, "applicants still tracked without data")
T.contains(ns.UI.rows[1].any:GetText(), "not fetched", "renders not-fetched state")
T.contains(ns.UI.context:GetText(), "no data file", "warns about missing data")

T.group("placeholder Data.lua (fresh install, shipped file)")
ns = B.StartSession({ data = false, keystoneLevel = 12, keystoneMapID = 503 })
-- data = false keeps the real shipped placeholder from KeyLevelLogs/Data.lua
T.eq(type(_G.KeyLevelLogsData), "table", "placeholder data global exists")
T.ok(not ns.HasData(), "placeholder counts as no data")
local ctx = ns.GetContext()
T.eq(ctx.level, 12, "keystone level still resolves")
T.is_nil(ctx.encounterID, "no encounter mapping without data")
T.eq(ctx.dungeonName, "Ara-Kara, City of Echoes", "dungeon name comes from game API")
