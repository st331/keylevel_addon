-- test_flow.lua — end-to-end: LFG events -> applicant window, copy box,
-- slash commands, visibility, drag persistence.

local B = _G.__B
local T = B.T
local mock = B.mock
local ns = B.StartSession({ keystoneLevel = 12, keystoneMapID = 503 })

local UI = ns.UI
local frame = _G.KeyLevelLogsFrame

T.group("window creation")
T.ok(frame ~= nil, "KeyLevelLogsFrame exists as a named global")
T.ok(frame._movable, "frame is movable")
T.ok(frame._clamped, "frame is clamped to screen")
T.ok(frame._mouseEnabled, "frame accepts mouse (drag)")
T.ok(frame._scripts.OnDragStart and frame._scripts.OnDragStop, "drag scripts wired")
T.ok(frame._backdrop ~= nil, "backdrop applied (BackdropTemplate)")
T.ok(not frame:IsShown(), "starts hidden until applicants arrive")
T.eq(_G.KeyLevelLogsCloseButton._template, "UIPanelCloseButton", "close button uses a real template")
T.eq(_G.KeyLevelLogsCopyURLButton._template, "UIPanelButtonTemplate", "copy-url button uses a real template")
T.eq(_G.KeyLevelLogsCopyNamesButton._template, "UIPanelButtonTemplate", "names button uses a real template")

T.group("applicants render, sorted by rating")
mock.SetApplicants({
  { applicantID = 1, members = { { name = "Alice", class = "MAGE", dungeonScore = 3012 } } },
  { applicantID = 2, members = { { name = "Bob-TestRealm", class = "WARRIOR", dungeonScore = 2905 } } },
  { applicantID = 3, members = { { name = "Eve-OtherRealm", class = "DRUID", dungeonScore = 3305 } } },
  { applicantID = 4, members = { { name = "Norating-TestRealm", class = "ROGUE" } } },
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED", true, true)
mock.Advance(0.5)

T.eq(#ns.applicants, 4, "four applicants tracked")
T.ok(frame:IsShown(), "auto-shown when applicants arrive")
T.contains(UI.rows[1].name:GetText(), "Eve-OtherRealm", "row1: highest rating first, cross-realm suffix kept")
T.contains(UI.rows[1].score:GetText(), "3305", "rating rendered")
T.contains(UI.rows[2].name:GetText(), "Alice", "row2: Alice")
T.not_contains(UI.rows[2].name:GetText(), "Alice-TestRealm", "own realm hidden")
T.contains(UI.rows[2].name:GetText(), "3fc7eb", "class colored (mage)")
T.contains(UI.rows[4].name:GetText(), "Norating", "unknown rating last")
T.contains(UI.rows[4].score:GetText(), "—", "unknown rating shown as dash")
T.contains(UI.context:GetText(), "+12", "context shows level")
T.contains(UI.context:GetText(), "Ara-Kara", "context shows dungeon")

T.group("seen applicants recorded")
local db = _G.KeyLevelLogsDB
T.ok(db.seenApplicants["Alice-TestRealm"], "Alice recorded with normalized name")
T.eq(db.seenApplicants["Alice-TestRealm"].class, "MAGE", "class recorded")

T.group("copy URL")
mock.RunSlash("/kll copy")
local copyFrame = _G.KeyLevelLogsCopyFrame
T.ok(copyFrame and copyFrame:IsShown(), "copy frame shown")
local url = copyFrame.edit:GetText()
T.contains(url, "https://st331.github.io/keylevel_addon/?", "site url")
T.contains(url, "region=us", "region")
T.contains(url, "level=12", "level")
T.contains(url, "chars=", "chars param")
T.contains(url, "Alice-TestRealm", "Alice in url")
T.contains(url, "Eve-OtherRealm", "Eve in url")
T.contains(url, "Norating-TestRealm", "everyone included")
T.contains(copyFrame.label:GetText(), "browser", "label explains the paste target")
copyFrame:Hide()

T.group("copy names")
mock.RunSlash("/kll names")
T.ok(copyFrame:IsShown(), "copy frame reshown")
local text = copyFrame.edit:GetText()
T.contains(text, "Alice-TestRealm\n", "one name per line")
T.not_contains(text, "https://", "names mode has no url")
copyFrame:Hide()

T.group("copy buttons on the window")
_G.KeyLevelLogsCopyURLButton:Click()
T.contains(copyFrame.edit:GetText(), "chars=", "URL button fills url")
_G.KeyLevelLogsCopyNamesButton:Click()
T.not_contains(copyFrame.edit:GetText(), "chars=", "Names button fills names")
copyFrame:Hide()

T.group("slash: level and dungeon overrides flow into the URL")
mock.RunSlash("/kll 14")
mock.RunSlash("/kll dungeon Mists of Tirna Scithe")
mock.RunSlash("/kll copy")
url = copyFrame.edit:GetText()
T.contains(url, "level=14", "override level in url")
T.contains(url, "dungeon=Mists%20of%20Tirna%20Scithe", "override dungeon in url")
copyFrame:Hide()
mock.RunSlash("/kll auto")
mock.RunSlash("/kll copy")
T.contains(copyFrame.edit:GetText(), "level=12", "auto restores keystone level")
copyFrame:Hide()

T.group("slash: site override")
mock.RunSlash("/kll site https://example.com/kll/")
mock.RunSlash("/kll copy")
T.contains(copyFrame.edit:GetText(), "https://example.com/kll/?", "custom site in url")
copyFrame:Hide()
mock.RunSlash("/kll site default")
T.is_nil(ns.db.siteURL, "site reset")

T.group("slash: /kll 0 clears override")
mock.RunSlash("/kll 0")
T.is_nil(ns.db.keyLevelOverride, "/kll 0 clears instead of wedging context")

T.group("hide / show / auto-show")
mock.RunSlash("/kll hide")
T.ok(not frame:IsShown(), "hidden via slash")
T.eq(ns.db.window.shown, false, "hidden state persisted")
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.ok(not frame:IsShown(), "auto-show respects persistent hide")
mock.RunSlash("/kll show")
T.ok(frame:IsShown(), "shown via slash")

T.group("close button snoozes only the current batch")
_G.KeyLevelLogsCloseButton:Click()
T.ok(not frame:IsShown(), "X hides the window")
T.eq(ns.db.window.shown, true, "X does not flip the persistent setting")
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.ok(not frame:IsShown(), "same batch: stays snoozed")
mock.SetApplicants({})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
mock.SetApplicants({ { applicantID = 9, members = { { name = "Alice", class = "MAGE" } } } })
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.ok(frame:IsShown(), "new batch after empty: pops again")

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

T.group("applicant departure keeps names available for copy")
mock.SetApplicants({})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
mock.Advance(0.5)
T.eq(#ns.applicants, 0, "applicants cleared")
T.contains(UI.footer:GetText(), "No applicants", "empty state")
local names = ns.NamesForLookup()
T.ok(#names > 0, "recently seen applicants still exported")
local joined = table.concat(names, ",")
T.contains(joined, "Alice-TestRealm", "Alice recoverable after leaving")

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
mock.RunSlash("/kll copy")
local overflowURL = _G.KeyLevelLogsCopyFrame.edit:GetText()
T.contains(overflowURL, "P15-TestRealm", "overflow applicants still in the URL")
_G.KeyLevelLogsCopyFrame:Hide()

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
