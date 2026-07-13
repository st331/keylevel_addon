-- demo.lua — loads the addon with sample data, simulates applicants, and
-- prints what the window would show (colors stripped).
--   lua5.1 tests/demo.lua

local B = dofile("tests/bootstrap.lua")
local mock = B.mock

local ns = B.StartSession({ keystoneLevel = 12, keystoneMapID = 503 })

mock.SetApplicants({
  { applicantID = 1, members = { { name = "Alice", class = "MAGE" } } },
  { applicantID = 2, members = { { name = "Bob-TestRealm", class = "WARRIOR" } } },
  { applicantID = 3, members = { { name = "Carol-TestRealm", class = "PRIEST" } } },
  { applicantID = 4, members = { { name = "Dave-TestRealm", class = "ROGUE" } } },
  { applicantID = 5, members = { { name = "Eve-OtherRealm", class = "DRUID" } } },
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
  if #s > n then return s:sub(1, n - 1) .. "…" end
  return s .. string.rep(" ", n - #s)
end

local W = 78
io.write("\n+" .. string.rep("-", W) .. "+\n")
local function line(s)
  io.write("| " .. pad(s, W - 2) .. " |\n")
end
line("KeyLevelLogs                                                            [X]")
line(plain(UI.context:GetText()))
line(string.rep("-", W - 2))
line(pad("Applicant", 22) .. pad(plain(UI.headAny:GetText()), 24) .. plain(UI.headDungeon:GetText()))
for i = 1, 12 do
  local row = UI.rows[i]
  if row and row.name:IsShown() then
    line(pad(row.name:GetText(), 22) .. pad(plain(row.any:GetText()), 24) .. plain(row.dungeon:GetText()))
  end
end
line(string.rep("-", W - 2))
line(plain(UI.footer:GetText()) .. string.rep(" ", 30) .. "[Copy]")
io.write("+" .. string.rep("-", W) .. "+\n\n")
