-- Core.lua — data lookup, applicant tracking, slash commands.
-- KeyLevelLogs deliberately never touches Blizzard's LFG frames or any other
-- addon's frames (e.g. Premade Groups Filter): it only *reads* C_LFGList data
-- in response to events and renders into its own standalone window.

local ADDON_NAME, ns = ...

ns.VERSION = "0.1.0"

--------------------------------------------------------------------------
-- Percentile colors (Warcraft Logs tiers)
--------------------------------------------------------------------------

ns.PERCENTILE_COLORS = {
  { min = 100, hex = "e5cc80" }, -- gold
  { min = 99,  hex = "e268a8" }, -- pink
  { min = 95,  hex = "ff8000" }, -- orange
  { min = 75,  hex = "a335ee" }, -- purple
  { min = 50,  hex = "0070ff" }, -- blue
  { min = 25,  hex = "1eff00" }, -- green
  { min = 0,   hex = "9d9d9d" }, -- gray
}

function ns.ColorForPercent(pct)
  for _, tier in ipairs(ns.PERCENTILE_COLORS) do
    if pct >= tier.min then return tier.hex end
  end
  return "9d9d9d"
end

-- "84" colored like Warcraft Logs does (percentiles are floored for display).
function ns.FormatPercent(pct)
  local shown = math.floor(pct)
  return ("|cff%s%d|r"):format(ns.ColorForPercent(shown), shown)
end

ns.GRAY = "|cff808080%s|r"

--------------------------------------------------------------------------
-- Names
--------------------------------------------------------------------------

-- Applicants on your own realm arrive without "-Realm"; normalize so keys
-- always match the companion's "Name-NormalizedRealm" format.
function ns.NormalizeName(name)
  if not name or name == "" then return nil end
  local char, realm = name:match("^([^%-]+)%-(.+)$")
  if not char then
    char = name
    realm = GetNormalizedRealmName() or ""
  end
  -- normalized realm names carry no spaces/apostrophes/hyphens/periods
  realm = realm:gsub("[%s'%-%.]", "")
  if realm == "" then return char end
  return char .. "-" .. realm
end

-- Display: hide the realm when it is the player's own.
function ns.DisplayName(fullName)
  local char, realm = fullName:match("^([^%-]+)%-(.+)$")
  if char and realm == (GetNormalizedRealmName() or "") then
    return char
  end
  return fullName
end

function ns.ClassColor(name, class)
  local c = class and RAID_CLASS_COLORS and RAID_CLASS_COLORS[class]
  if c and c.colorStr then
    return ("|c%s%s|r"):format(c.colorStr, name)
  end
  return name
end

local function simplify(name)
  return (name:lower():gsub("[^%w]", ""))
end

--------------------------------------------------------------------------
-- Data access
--------------------------------------------------------------------------

local EMPTY_DATA = { meta = {}, dungeons = {}, players = {} }

function ns.GetData()
  local data = _G.KeyLevelLogsData
  if type(data) ~= "table" or type(data.players) ~= "table" then
    return EMPTY_DATA
  end
  return data
end

function ns.HasData()
  return next(ns.GetData().players) ~= nil
end

function ns.LookupPlayer(fullName)
  return ns.GetData().players[fullName]
end

-- Map an in-game challenge map ID to the WCL encounter ID in our data file,
-- by explicit mapping first, then by (simplified) name.
function ns.EncounterForMap(mapID)
  if not mapID then return nil end
  local dungeons = ns.GetData().dungeons or {}
  for encID, d in pairs(dungeons) do
    if d.challengeMapID == mapID then
      return encID, d.name
    end
  end
  local mapName = C_ChallengeMode and C_ChallengeMode.GetMapUIInfo and C_ChallengeMode.GetMapUIInfo(mapID)
  if mapName then
    local target = simplify(mapName)
    for encID, d in pairs(dungeons) do
      if d.name and simplify(d.name) == target then
        return encID, d.name
      end
    end
  end
  return nil
end

function ns.EncounterByName(text)
  if not text or text == "" then return nil end
  local target = simplify(text)
  if target == "" then return nil end
  local best, bestName
  for encID, d in pairs(ns.GetData().dungeons or {}) do
    if d.name then
      local s = simplify(d.name)
      if s == target then return encID, d.name end
      if s:find(target, 1, true) and not best then
        best, bestName = encID, d.name
      end
    end
  end
  return best, bestName
end

--------------------------------------------------------------------------
-- Context: which key level / dungeon are we recruiting for?
--------------------------------------------------------------------------

-- Priority: explicit override (slash command) > your own keystone >
-- (dungeon only) the group you have listed in the group finder.
function ns.GetContext()
  local db = ns.db or {}
  local level = db.keyLevelOverride or (C_MythicPlus and C_MythicPlus.GetOwnedKeystoneLevel and C_MythicPlus.GetOwnedKeystoneLevel())
  if level == 0 then level = nil end

  local mapID = db.dungeonOverride or (C_MythicPlus and C_MythicPlus.GetOwnedKeystoneChallengeMapID and C_MythicPlus.GetOwnedKeystoneChallengeMapID())
  local encID, dungeonName
  if mapID then
    encID, dungeonName = ns.EncounterForMap(mapID)
    if not dungeonName and C_ChallengeMode and C_ChallengeMode.GetMapUIInfo then
      dungeonName = C_ChallengeMode.GetMapUIInfo(mapID)
    end
  end

  -- Fall back to the group we have listed, matching the activity name.
  if not encID and C_LFGList and C_LFGList.GetActiveEntryInfo then
    local ok, entry = pcall(C_LFGList.GetActiveEntryInfo)
    if ok and type(entry) == "table" then
      local activityID = entry.activityID
      if not activityID and type(entry.activityIDs) == "table" then
        activityID = entry.activityIDs[1]
      end
      if activityID and C_LFGList.GetActivityInfoTable then
        local ok2, info = pcall(C_LFGList.GetActivityInfoTable, activityID)
        if ok2 and type(info) == "table" and info.fullName then
          local e, n = ns.EncounterByName(info.fullName)
          if e then encID, dungeonName = e, n end
        end
      end
    end
  end

  return { level = level, mapID = mapID, encounterID = encID, dungeonName = dungeonName }
end

--------------------------------------------------------------------------
-- Evaluation — the core "how are their logs for this key level" question.
--------------------------------------------------------------------------

-- Pure function; takes the player's data table (may be nil) plus the target
-- encounter/level, returns a structured verdict the UI renders:
--   status        "NO_PLAYER" | "OK"
--   anyAtLevel    { pct, runs }            best percentile at exactly this key
--                                          level, across all dungeons
--   dungeon       { pct, level, spec, isFallback }
--                 this dungeon at this level, or one level below (isFallback)
--   dungeonBest   { pct, level }           best logged level for this dungeon,
--                                          when `dungeon` is nil
--   anyBest       { pct, level }           highest key level with any logs,
--                                          when `anyAtLevel` is nil
function ns.Evaluate(playerData, encounterID, keyLevel)
  if type(playerData) ~= "table" or type(playerData.levels) ~= "table" then
    return { status = "NO_PLAYER" }
  end
  local levels = playerData.levels
  local result = { status = "OK" }

  if keyLevel then
    local atLevel = levels[keyLevel]
    if atLevel and atLevel.best then
      result.anyAtLevel = { pct = atLevel.best, runs = atLevel.runs or 0 }
    end

    if encounterID then
      local exact = atLevel and atLevel.dungeons and atLevel.dungeons[encounterID]
      if exact then
        result.dungeon = { pct = exact.pct, level = keyLevel, spec = exact.spec, isFallback = false }
      else
        local below = levels[keyLevel - 1]
        local fb = below and below.dungeons and below.dungeons[encounterID]
        if fb then
          result.dungeon = { pct = fb.pct, level = keyLevel - 1, spec = fb.spec, isFallback = true }
        end
      end
    end
  end

  -- Best logged level for this dungeon (context when there is no direct hit).
  if encounterID and not result.dungeon then
    local bestLevel, bestPct
    for level, entry in pairs(levels) do
      local d = entry.dungeons and entry.dungeons[encounterID]
      if d and (not bestLevel or level > bestLevel) then
        bestLevel, bestPct = level, d.pct
      end
    end
    if bestLevel then
      result.dungeonBest = { level = bestLevel, pct = bestPct }
    end
  end

  -- Highest key level with any logs at all.
  if not result.anyAtLevel then
    local bestLevel, bestPct
    for level, entry in pairs(levels) do
      if entry.best and (not bestLevel or level > bestLevel) then
        bestLevel, bestPct = level, entry.best
      end
    end
    if bestLevel then
      result.anyBest = { level = bestLevel, pct = bestPct }
    end
  end

  return result
end

--------------------------------------------------------------------------
-- SavedVariables
--------------------------------------------------------------------------

local DEFAULTS = {
  window = { point = "CENTER", relPoint = "CENTER", x = 260, y = 60, shown = true },
  autoShow = true,
  keyLevelOverride = nil,
  dungeonOverride = nil,
  seenApplicants = {},
}

local SEEN_TTL = 14 * 24 * 3600

local function applyDefaults(dst, src)
  for k, v in pairs(src) do
    if type(v) == "table" then
      if type(dst[k]) ~= "table" then dst[k] = {} end
      applyDefaults(dst[k], v)
    elseif dst[k] == nil then
      dst[k] = v
    end
  end
end

function ns.InitDB()
  if type(_G.KeyLevelLogsDB) ~= "table" then
    _G.KeyLevelLogsDB = {}
  end
  ns.db = _G.KeyLevelLogsDB
  applyDefaults(ns.db, DEFAULTS)
  -- prune stale applicant history so SavedVariables stay small
  local cutoff = time() - SEEN_TTL
  for name, info in pairs(ns.db.seenApplicants) do
    if type(info) ~= "table" or (info.lastSeen or 0) < cutoff then
      ns.db.seenApplicants[name] = nil
    end
  end
end

--------------------------------------------------------------------------
-- Applicant tracking
--------------------------------------------------------------------------

ns.applicants = {}

local INTERESTING_STATUS = { applied = true, invited = true }

-- Midnight (12.0) can hand addons "secret" values in some contexts; treat
-- them as unusable. issecretvalue does not exist on older clients.
local function usable(v)
  if v == nil then return false end
  if issecretvalue and issecretvalue(v) then return false end
  return true
end

-- One applicant group; every value from C_LFGList is treated as potentially
-- secret (Midnight 12.0), so the caller wraps this in pcall — loop bounds,
-- table indexing and comparisons on secrets all raise.
local function processApplicant(id, out)
  if not usable(id) then return end
  local info = C_LFGList.GetApplicantInfo(id)
  if not info or not usable(info.applicationStatus) then return end
  if not INTERESTING_STATUS[info.applicationStatus or "applied"] then return end
  if not usable(info.numMembers) then return end
  for m = 1, info.numMembers or 0 do
    -- Only the first two returns (name, class token) are relied upon.
    local name, class = C_LFGList.GetApplicantMemberInfo(id, m)
    local full = (usable(name) and type(name) == "string")
      and ns.NormalizeName(name) or nil
    if not usable(class) then class = nil end
    if full then
      table.insert(out, { name = full, class = class, applicantID = id })
      if ns.db then
        ns.db.seenApplicants[full] = { lastSeen = time(), class = class }
      end
    end
  end
end

function ns.RefreshApplicants()
  local out = {}
  local ok, ids = pcall(function()
    return (C_LFGList and C_LFGList.GetApplicants and C_LFGList.GetApplicants()) or {}
  end)
  if ok and type(ids) == "table" then
    for _, id in ipairs(ids) do
      pcall(processApplicant, id, out)
    end
  end
  ns.applicants = out
  if ns.UI and ns.UI.Refresh then ns.UI:Refresh() end
end

-- Coalesce event bursts into one refresh.
local pendingRefresh = false
function ns.QueueRefresh()
  if pendingRefresh then return end
  pendingRefresh = true
  C_Timer.After(0.2, function()
    pendingRefresh = false
    ns.RefreshApplicants()
  end)
end

--------------------------------------------------------------------------
-- Events
--------------------------------------------------------------------------

local eventFrame = CreateFrame("Frame", "KeyLevelLogsEventFrame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:SetScript("OnEvent", function(_, event, arg1)
  if event == "ADDON_LOADED" then
    if arg1 ~= ADDON_NAME then return end
    eventFrame:UnregisterEvent("ADDON_LOADED")
    ns.InitDB()
    eventFrame:RegisterEvent("PLAYER_LOGIN")
    eventFrame:RegisterEvent("PLAYER_ENTERING_WORLD") -- realm name can be nil during loading screens; re-read after
    eventFrame:RegisterEvent("LFG_LIST_APPLICANT_LIST_UPDATED")
    eventFrame:RegisterEvent("LFG_LIST_APPLICANT_UPDATED")
    eventFrame:RegisterEvent("LFG_LIST_ACTIVE_ENTRY_UPDATE")
  elseif event == "PLAYER_LOGIN" then
    if C_MythicPlus and C_MythicPlus.RequestMapInfo then
      C_MythicPlus.RequestMapInfo()
    end
    if ns.UI and ns.UI.Init then ns.UI:Init() end
    ns.RefreshApplicants()
  else
    -- any LFG applicant/entry change
    ns.QueueRefresh()
  end
end)

--------------------------------------------------------------------------
-- Slash commands
--------------------------------------------------------------------------

function ns.Print(msg)
  print(("|cff3fc7ebKeyLevelLogs|r: %s"):format(msg))
end

local function slashStatus()
  local ctx = ns.GetContext()
  local data = ns.GetData()
  local players = 0
  for _ in pairs(data.players) do players = players + 1 end
  ns.Print(("key level: %s%s, dungeon: %s%s"):format(
    ctx.level and ("+" .. ctx.level) or "unknown",
    ns.db.keyLevelOverride and " (manual)" or "",
    ctx.dungeonName or "unknown",
    ns.db.dungeonOverride and " (manual)" or ""))
  ns.Print(("data file: %d player(s), generated %s"):format(
    players, tostring(data.meta and data.meta.generatedAt or "never")))
end

function ns.HandleSlash(input)
  input = (input or ""):match("^%s*(.-)%s*$")
  local cmd, rest = input:match("^(%S+)%s*(.-)$")
  cmd = cmd and cmd:lower() or ""

  if cmd == "" or cmd == "show" or cmd == "toggle" then
    if ns.UI then
      if cmd == "show" then ns.UI:SetShown(true) else ns.UI:Toggle() end
    end
  elseif cmd == "hide" then
    if ns.UI then ns.UI:SetShown(false) end
  elseif cmd:match("^%+?%d+$") then
    local level = tonumber(cmd:match("%d+"))
    ns.db.keyLevelOverride = level
    ns.Print(("key level set to +%d (use /kll auto to follow your keystone)"):format(level))
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "auto" or cmd == "clear" then
    ns.db.keyLevelOverride = nil
    ns.db.dungeonOverride = nil
    ns.Print("following your own keystone again")
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "dungeon" then
    if rest == "" or rest:lower() == "clear" or rest:lower() == "auto" then
      ns.db.dungeonOverride = nil
      ns.Print("dungeon override cleared")
    else
      local encID, name = ns.EncounterByName(rest)
      local mapID
      if encID then
        local d = ns.GetData().dungeons[encID]
        mapID = d and d.challengeMapID
      end
      if encID and mapID then
        ns.db.dungeonOverride = mapID
        ns.Print(("dungeon set to %s"):format(name))
      elseif encID then
        ns.Print(("matched %s in the data file, but it has no challenge map id; update the companion mapping"):format(name or rest))
      else
        ns.Print(("no dungeon matching '%s' in the data file"):format(rest))
      end
    end
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "copy" then
    if ns.UI then ns.UI:ShowCopyBox() end
  elseif cmd == "reset" then
    ns.db.window = nil
    ns.InitDB()
    if ns.UI then ns.UI:RestorePosition(); ns.UI:SetShown(true) end
    ns.Print("window position reset")
  elseif cmd == "status" then
    slashStatus()
  else
    ns.Print("commands: /kll  |  /kll 12  |  /kll auto  |  /kll dungeon <name>  |  /kll copy  |  /kll reset  |  /kll status")
  end
end

SLASH_KEYLEVELLOGS1 = "/kll"
SLASH_KEYLEVELLOGS2 = "/keylevellogs"
SlashCmdList["KEYLEVELLOGS"] = ns.HandleSlash
