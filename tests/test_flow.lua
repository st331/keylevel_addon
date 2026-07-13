-- test_flow.lua — end-to-end: LFG events -> applicant window contents,
-- slash commands, visibility, drag persistence, copy box.

local B = _G.__B
local T = B.T
local mock = B.mock
local ns = B.StartSession({})

local UI = ns.UI
local frame = _G.KeyLevelLogsFrame

T.group("window creation")
T.ok(frame ~= nil, "KeyLevelLogsFrame exists as a named global")
T.ok(frame._movable, "frame is movable")
T.ok(frame._clamped, "frame is clamped to screen")
T.ok(frame._mouseEnabled, "frame accepts mouse (drag)")
T.ok(frame._scripts.OnDragStart and frame._scripts.OnDragStop, "drag scripts wired")
T.ok(frame._backdrop ~= nil, "backdrop applied (BackdropTemplate)")

T.group("context from own keystone")
mock.state.keystoneLevel = 12
mock.state.keystoneMapID = 503 -- Ara-Kara in fixtures
local ctx = ns.GetContext()
T.eq(ctx.level, 12, "level from keystone")
T.eq(ctx.encounterID, 12660, "encounter resolved from challenge map")
T.eq(ctx.dungeonName, "Ara-Kara, City of Echoes", "dungeon name resolved")

T.group("applicants render")
mock.SetApplicants({
  { applicantID = 1, members = { { name = "Alice", class = "MAGE" } } },       -- same realm, bare name
  { applicantID = 2, members = { { name = "Bob-TestRealm", class = "WARRIOR" } } },
  { applicantID = 3, members = { { name = "Dave-TestRealm", class = "ROGUE" } } }, -- not in data
  { applicantID = 4, members = { { name = "Eve-OtherRealm", class = "DRUID" } } },
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED", true, true)
mock.Advance(0.5) -- debounce timer

T.eq(#ns.applicants, 4, "four applicants tracked")
T.ok(frame:IsShown(), "window visible with applicants")

-- Sorted: Eve any@12 99.5 > Alice AK@12 91.2 > Bob AK@11 76.4 > Dave (no data)
local r1, r2, r3, r4 = UI.rows[1], UI.rows[2], UI.rows[3], UI.rows[4]
T.contains(r1.name:GetText(), "Eve-OtherRealm", "row1: Eve (cross-realm keeps suffix)")
T.contains(r1.any:GetText(), "99", "Eve any 99")
T.contains(r1.dungeon:GetText(), "never logged", "Eve never logged this dungeon")

T.contains(r2.name:GetText(), "Alice", "row2: Alice")
T.not_contains(r2.name:GetText(), "Alice-TestRealm", "own realm hidden")
T.contains(r2.name:GetText(), "3fc7eb", "class colored (mage)")
T.contains(r2.any:GetText(), "91", "Alice any 91")
T.contains(r2.any:GetText(), "2 dungeons", "run count shown")
T.contains(r2.dungeon:GetText(), "91", "Alice AK 91")
T.contains(r2.dungeon:GetText(), "@+12", "at the exact level")

T.contains(r3.name:GetText(), "Bob", "row3: Bob")
T.contains(r3.dungeon:GetText(), "76", "Bob fallback pct")
T.contains(r3.dungeon:GetText(), "@+11", "fallback level shown")
T.contains(r3.dungeon:GetText(), "one below", "fallback labelled")

T.contains(r4.name:GetText(), "Dave", "row4: Dave last (no data)")
T.contains(r4.any:GetText(), "no data", "no-data indicator")

T.group("seen applicants recorded for companion")
local db = _G.KeyLevelLogsDB
T.ok(db.seenApplicants["Alice-TestRealm"], "Alice recorded with normalized name")
T.ok(db.seenApplicants["Eve-OtherRealm"], "Eve recorded")
T.eq(db.seenApplicants["Alice-TestRealm"].class, "MAGE", "class recorded")

T.group("header/context text")
T.contains(UI.context:GetText(), "+12", "context shows level")
T.contains(UI.context:GetText(), "Ara-Kara", "context shows dungeon")
T.contains(UI.headAny:GetText(), "+12", "any-column header shows level")
T.contains(UI.headDungeon:GetText(), "+12/+11", "dungeon column advertises fallback")

T.group("copy box")
mock.RunSlash("/kll copy")
local copyFrame = _G.KeyLevelLogsCopyFrame
T.ok(copyFrame and copyFrame:IsShown(), "copy frame shown")
local text = copyFrame.edit:GetText()
T.contains(text, "Alice-TestRealm", "copy has normalized Alice")
T.contains(text, "Eve-OtherRealm", "copy has Eve")
copyFrame:Hide()

T.group("slash: level override")
mock.RunSlash("/kll 13")
T.eq(ns.db.keyLevelOverride, 13, "override stored")
T.contains(UI.context:GetText(), "+13", "context reflects override")
-- at 13, Alice has nothing at level; 12 is one below -> AK fallback 91.2@+12
T.contains(UI.rows[1].dungeon:GetText() .. UI.rows[2].dungeon:GetText(), "@+12", "fallback to +12 after override")
mock.RunSlash("/kll auto")
T.is_nil(ns.db.keyLevelOverride, "auto clears override")
T.contains(UI.context:GetText(), "+12", "back to keystone level")

T.group("slash: dungeon override")
mock.RunSlash("/kll dungeon city of threads")
T.eq(ns.db.dungeonOverride, 502, "dungeon override stored (challenge map id)")
T.contains(UI.context:GetText(), "City of Threads", "context shows override dungeon")
-- Bob has CoT 77 at +12 exactly
local found = false
for i = 1, 4 do
  local cell = UI.rows[i].dungeon:GetText() or ""
  if cell:find("77", 1, true) and cell:find("@+12", 1, true) then found = true end
end
T.ok(found, "Bob CoT 77@+12 rendered")
mock.RunSlash("/kll dungeon clear")
T.is_nil(ns.db.dungeonOverride, "dungeon override cleared")

T.group("hide / show / auto-show")
mock.RunSlash("/kll hide")
T.ok(not frame:IsShown(), "hidden via slash")
T.eq(ns.db.window.shown, false, "hidden state persisted")
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.ok(not frame:IsShown(), "auto-show respects manual hide")
mock.RunSlash("/kll show")
T.ok(frame:IsShown(), "shown via slash")

T.group("drag persistence")
frame._scripts.OnDragStart(frame)
T.ok(frame._moving, "StartMoving called")
frame:ClearAllPoints()
frame:SetPoint("TOPLEFT", _G.UIParent, "TOPLEFT", 123, -45)
frame._scripts.OnDragStop(frame)
T.ok(not frame._moving, "StopMovingOrSizing called")
T.eq(ns.db.window.point, "TOPLEFT", "point saved")
T.eq(ns.db.window.x, 123, "x saved")
T.eq(ns.db.window.y, -45, "y saved")
mock.RunSlash("/kll reset")
T.eq(ns.db.window.point, "CENTER", "reset restores default point")
T.eq(ns.db.window.x, 260, "reset restores default x")

T.group("applicant departure")
mock.SetApplicants({})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 0, "applicants cleared")
T.contains(UI.footer:GetText(), "No applicants", "empty state")
for i = 1, 4 do
  T.ok(not UI.rows[i].name:IsShown(), "row " .. i .. " hidden")
end

T.group("many applicants overflow")
local many = {}
for i = 1, 15 do
  many[i] = { applicantID = 100 + i, members = { { name = "P" .. i, class = "MAGE" } } }
end
mock.SetApplicants(many)
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 15, "15 tracked")
T.contains(UI.footer:GetText(), "+3 more", "overflow reported (12 max rows)")

T.group("no key level context")
mock.SetApplicants({ { applicantID = 1, members = { { name = "Alice", class = "MAGE" } } } })
mock.state.keystoneLevel = nil
mock.state.keystoneMapID = nil
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.contains(UI.context:GetText(), "/kll 12", "hint to set level")
T.contains(UI.rows[1].any:GetText(), "none · best", "shows best-level note when no context")
T.contains(UI.rows[1].any:GetText(), "+12", "best level value shown")
mock.state.keystoneLevel = 12
mock.state.keystoneMapID = 503

T.group("no data file warning")
local saved = _G.KeyLevelLogsData
_G.KeyLevelLogsData = { meta = {}, dungeons = {}, players = {} }
UI:Refresh()
T.contains(UI.context:GetText(), "no data file", "warns when data empty")
_G.KeyLevelLogsData = saved
UI:Refresh()
T.not_contains(UI.context:GetText(), "no data file", "warning clears with data")

T.group("multi-member applicant groups")
mock.SetApplicants({
  { applicantID = 9, members = {
    { name = "Alice", class = "MAGE" },
    { name = "Bob-TestRealm", class = "WARRIOR" },
  } },
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 2, "both members listed")

T.group("declined applicants filtered")
mock.SetApplicants({
  { applicantID = 10, members = { { name = "Alice", class = "MAGE" } }, applicationStatus = "declined" },
  { applicantID = 11, members = { { name = "Bob-TestRealm", class = "WARRIOR" } }, applicationStatus = "applied" },
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 1, "declined filtered out")
T.contains(ns.applicants[1].name, "Bob", "applied kept")
