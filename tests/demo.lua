-- demo.lua — loads the addon with sample data, simulates applicants, and
-- prints what the window would show (colors stripped).
--   lua5.1 tests/demo.lua

local B = dofile("tests/bootstrap.lua")
local mock = B.mock

local ns = B.StartSession({ keystoneLevel = 12, keystoneMapID = 503 })

mock.SetApplicants({
  { applicantID = 1, members = { { name = "Alice", class = "MAGE", dungeonScore = 3012 } } },
  { applicantID = 2, members = { { name = "Bob-TestRealm", class = "WARRIOR", dungeonScore = 2905 } } },
  { applicantID = 3, members = { { name = "Carol-TestRealm", class = "PRIEST", dungeonScore = 2100 } } },
  { applicantID = 4, members = { { name = "Dave-TestRealm", class = "ROGUE", dungeonScore = 2700 } } },
  { applicantID = 5, members = { { name = "Eve-OtherRealm", class = "DRUID", dungeonScore = 3305 } } },
  { applicantID = 6, members = { { name = "Nolan-TestRealm", class = "PALADIN" } } },
})
mock.FireEvent("LFG_LIST_APPLICANT_LIST_UPDATED", true, true)
mock.Advance(0.5)

local function plain(s)
  if not s then return "" end
  return (s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))
end

local UI = ns.UI
local function pad(s, n)
  s = plain(s)
  -- crude display-width padding (the demo uses one multi-byte char, "·")
  local width = #(s:gsub("\194\183", ".")) -- count · as one
  if width > n then return s:sub(1, n - 1) .. "…" end
  return s .. string.rep(" ", n - width)
end

local W = 92
io.write("\n+" .. string.rep("-", W) .. "+\n")
local function line(s)
  io.write("| " .. pad(s, W - 2) .. " |\n")
end
line("KeyLevelLogs                                                                         [X]")
line(plain(UI.context:GetText()))
line(string.rep("-", W - 2))
line(pad("Applicant", 20) .. pad("Rating", 8) .. pad(plain(UI.headAny:GetText()), 26) .. plain(UI.headDungeon:GetText()))
for i = 1, 12 do
  local row = UI.rows[i]
  if row and row.name:IsShown() then
    line(pad(row.name:GetText(), 20) .. pad(plain(row.score:GetText()), 8)
      .. pad(plain(row.any:GetText()), 26) .. plain(row.dungeon:GetText()))
  end
end
line(string.rep("-", W - 2))
line(plain(UI.footer:GetText()) .. string.rep(" ", 40) .. "[Copy]")
io.write("+" .. string.rep("-", W) .. "+\n\n")
