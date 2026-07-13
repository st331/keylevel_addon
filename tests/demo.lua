-- demo.lua — loads the addon, simulates applicants, and prints what the
-- window would show plus the generated lookup URL (colors stripped).
--   lua5.1 tests/demo.lua

local B = dofile("tests/bootstrap.lua")
local mock = B.mock

local ns = B.StartSession({ keystoneLevel = 12, keystoneMapID = 503 })

mock.SetApplicants({
  { applicantID = 1, members = { { name = "Alice", class = "MAGE", dungeonScore = 3012 } } },
  { applicantID = 2, members = { { name = "Bob-TestRealm", class = "WARRIOR", dungeonScore = 2905 } } },
  { applicantID = 3, members = { { name = "Eve-OtherRealm", class = "DRUID", dungeonScore = 3305 } } },
  { applicantID = 4, members = { { name = "Nolan-TestRealm", class = "PALADIN" } } },
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
  local width = #(s:gsub("\194\183", "."):gsub("\226\128\148", "-"))
  if width > n then return s:sub(1, n - 1) .. "…" end
  return s .. string.rep(" ", n - width)
end

local W = 46
io.write("\n+" .. string.rep("-", W) .. "+\n")
local function line(s)
  io.write("| " .. pad(s, W - 2) .. " |\n")
end
line("KeyLevelLogs                          [X]")
line(plain(UI.context:GetText()))
line(string.rep("-", W - 2))
line(pad("Applicant", 26) .. "Rating")
for i = 1, 12 do
  local row = UI.rows[i]
  if row and row.name:IsShown() then
    line(pad(row.name:GetText(), 26) .. plain(row.score:GetText()))
  end
end
line(string.rep("-", W - 2))
line(plain(UI.footer:GetText()))
line("              [Names]  [Copy URL]")
io.write("+" .. string.rep("-", W) .. "+\n\n")

io.write("Copy URL produces:\n")
io.write(ns.BuildLookupURL(ns.NamesForLookup()) .. "\n\n")
