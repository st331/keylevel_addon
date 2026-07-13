-- Core.lua — applicant tracking, lookup-URL building, slash commands.
--
-- KeyLevelLogs collects the names of players applying to your Mythic+
-- listing and hands them to the companion website (one click: Copy URL,
-- paste in browser). WoW addons have no network access, so the website —
-- not the addon — talks to Warcraft Logs.
--
-- The addon deliberately never touches Blizzard's LFG frames or any other
-- addon's frames (e.g. Premade Groups Filter): it only *reads* C_LFGList
-- data in response to events and renders into its own standalone window.

local ADDON_NAME, ns = ...

ns.VERSION = "0.2.0"

-- The GitHub Pages site this repo ships (override with /kll site <url>)
ns.DEFAULT_SITE_URL = "https://st331.github.io/keylevel_addon/"

-- Midnight (12.0) can hand addons "secret" values in some contexts; treat
-- them as unusable. issecretvalue does not exist on older clients.
-- ORDER MATTERS: issecretvalue must run first — comparing a secret value
-- (even to nil) raises, while issecretvalue is always safe.
local function usable(v)
  if issecretvalue and issecretvalue(v) then return false end
  return v ~= nil
end
ns.IsUsableValue = usable

--------------------------------------------------------------------------
-- Names
--------------------------------------------------------------------------

-- Applicants on your own realm arrive without "-Realm"; normalize so the
-- website always receives fully-qualified "Name-NormalizedRealm".
function ns.NormalizeName(name)
  if not name or name == "" then return nil end
  local char, realm = name:match("^([^%-]+)%-(.+)$")
  if not char then
    -- bare name: realm must come from the player, but GetNormalizedRealmName
    -- is nil during loading screens — better to skip this refresh (a later
    -- event re-reads applicants) than to store a realm-less key
    realm = GetNormalizedRealmName()
    if not realm or realm == "" then return nil end
    char = name
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

ns.GRAY = "|cff808080%s|r"

--------------------------------------------------------------------------
-- Region / URL building
--------------------------------------------------------------------------

local REGIONS = { "us", "kr", "eu", "tw", "cn" }

function ns.RegionSlug()
  local id = GetCurrentRegion and GetCurrentRegion() or 1
  return REGIONS[id] or "us"
end

-- percent-encode everything outside RFC 3986 unreserved (byte-wise: safe
-- for UTF-8 names)
function ns.URLEncode(s)
  return (s:gsub("[^%w%-%._~]", function(c)
    return ("%%%02X"):format(c:byte())
  end))
end

-- Full lookup URL for the website: names + your current recruiting context.
function ns.BuildLookupURL(names)
  local base = (ns.db and ns.db.siteURL) or ns.DEFAULT_SITE_URL
  local ctx = ns.GetContext()
  local params = { "region=" .. ns.RegionSlug() }
  if ctx.level then
    params[#params + 1] = "level=" .. ctx.level
  end
  if ctx.dungeonName then
    params[#params + 1] = "dungeon=" .. ns.URLEncode(ctx.dungeonName)
  end
  local enc = {}
  for i, n in ipairs(names) do enc[i] = ns.URLEncode(n) end
  params[#params + 1] = "chars=" .. table.concat(enc, ",")
  local sep = base:find("?", 1, true) and "&" or "?"
  return base .. sep .. table.concat(params, "&")
end

--------------------------------------------------------------------------
-- Context: which key level / dungeon are we recruiting for?
--------------------------------------------------------------------------

-- Reads the group the player has listed in the group finder, if any.
-- Returns dungeonName, keyLevel (parsed from the listing title, e.g.
-- "AK +12 weekly"), either may be nil.
local function readActiveListing()
  if not (C_LFGList and C_LFGList.GetActiveEntryInfo) then return nil end
  local ok, entry = pcall(C_LFGList.GetActiveEntryInfo)
  if not ok or type(entry) ~= "table" then return nil end

  local dungeonName, level

  local activityID = usable(entry.activityID) and entry.activityID or nil
  if not activityID and type(entry.activityIDs) == "table" then
    local first = entry.activityIDs[1]
    activityID = usable(first) and first or nil
  end
  if activityID and C_LFGList.GetActivityInfoTable then
    local ok2, info = pcall(C_LFGList.GetActivityInfoTable, activityID)
    if ok2 and type(info) == "table" and usable(info.fullName) and type(info.fullName) == "string" then
      -- "Ara-Kara, City of Echoes (Mythic Keystone)" -> drop the suffix
      dungeonName = info.fullName:gsub("%s*%b()%s*$", "")
      if dungeonName == "" then dungeonName = nil end
    end
  end

  if usable(entry.name) and type(entry.name) == "string" then
    local lvl = entry.name:match("%+%s*(%d%d?)")
    level = lvl and tonumber(lvl) or nil
  end

  return dungeonName, level
end

-- Priority — level: manual override > level in your listing's title > your
-- own keystone. Dungeon: manual override > your active listing > your own
-- keystone. The active listing is what you're actually recruiting for, so
-- it beats the keystone you happen to be holding.
function ns.GetContext()
  local db = ns.db or {}
  local listingDungeon, listingLevel = readActiveListing()

  local level = db.keyLevelOverride or listingLevel
    or (C_MythicPlus and C_MythicPlus.GetOwnedKeystoneLevel and C_MythicPlus.GetOwnedKeystoneLevel())
  if level == 0 then level = nil end

  local dungeonName = db.dungeonOverride or listingDungeon
  if not dungeonName then
    local mapID = C_MythicPlus and C_MythicPlus.GetOwnedKeystoneChallengeMapID
      and C_MythicPlus.GetOwnedKeystoneChallengeMapID() or nil
    if mapID and C_ChallengeMode and C_ChallengeMode.GetMapUIInfo then
      dungeonName = C_ChallengeMode.GetMapUIInfo(mapID)
    end
  end

  return { level = level, dungeonName = dungeonName }
end

--------------------------------------------------------------------------
-- SavedVariables
--------------------------------------------------------------------------

local DEFAULTS = {
  window = { point = "CENTER", relPoint = "CENTER", x = 260, y = 60, shown = true },
  autoShow = true,
  keyLevelOverride = nil,
  dungeonOverride = nil,
  siteURL = nil,
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
    -- Positional returns; only name, class and dungeonScore are used.
    local name, class, _, _, _, _, _, _, _, _, _, dungeonScore =
      C_LFGList.GetApplicantMemberInfo(id, m)
    local full = (usable(name) and type(name) == "string")
      and ns.NormalizeName(name) or nil
    if not usable(class) then class = nil end
    if not usable(dungeonScore) or type(dungeonScore) ~= "number" or dungeonScore <= 0 then
      dungeonScore = nil
    end
    if full then
      table.insert(out, { name = full, class = class, score = dungeonScore, applicantID = id })
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

-- Current applicant names; falls back to applicants seen in the last hour
-- (e.g. you just closed the listing but still want the lookup).
function ns.NamesForLookup()
  local names = {}
  for _, app in ipairs(ns.applicants) do
    names[#names + 1] = app.name
  end
  if #names == 0 and ns.db then
    local cutoff = time() - 3600
    for name, info in pairs(ns.db.seenApplicants) do
      if (info.lastSeen or 0) >= cutoff then names[#names + 1] = name end
    end
    table.sort(names)
  end
  return names
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
    -- any LFG applicant/entry change (or a fresh loading screen)
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
  ns.Print(("key level: %s%s, dungeon: %s%s, region: %s"):format(
    ctx.level and ("+" .. ctx.level) or "unknown",
    ns.db.keyLevelOverride and " (manual)" or "",
    ctx.dungeonName or "unknown",
    ns.db.dungeonOverride and " (manual)" or "",
    ns.RegionSlug()))
  ns.Print(("lookup site: %s"):format((ns.db and ns.db.siteURL) or ns.DEFAULT_SITE_URL))
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
    if level < 2 then
      ns.db.keyLevelOverride = nil
      ns.Print("key levels start at +2 — following your listing/keystone instead")
    else
      ns.db.keyLevelOverride = level
      ns.Print(("key level set to +%d (use /kll auto to follow your keystone/listing)"):format(level))
    end
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "auto" or cmd == "clear" then
    ns.db.keyLevelOverride = nil
    ns.db.dungeonOverride = nil
    ns.Print("following your listing/keystone again")
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "dungeon" then
    if rest == "" or rest:lower() == "clear" or rest:lower() == "auto" then
      ns.db.dungeonOverride = nil
      ns.Print("dungeon override cleared")
    else
      ns.db.dungeonOverride = rest
      ns.Print(("dungeon set to %s"):format(rest))
    end
    if ns.UI then ns.UI:Refresh() end
  elseif cmd == "site" then
    if rest == "" or rest:lower() == "default" then
      ns.db.siteURL = nil
      ns.Print("lookup site reset to " .. ns.DEFAULT_SITE_URL)
    elseif rest:match("^https?://") then
      ns.db.siteURL = rest
      ns.Print("lookup site set to " .. rest)
    else
      ns.Print("usage: /kll site https://you.github.io/keylevel_addon/  (or /kll site default)")
    end
  elseif cmd == "copy" or cmd == "url" then
    if ns.UI then ns.UI:ShowCopyBox("url") end
  elseif cmd == "names" then
    if ns.UI then ns.UI:ShowCopyBox("names") end
  elseif cmd == "reset" then
    ns.db.window = nil
    ns.InitDB()
    if ns.UI then ns.UI:RestorePosition(); ns.UI:SetShown(true) end
    ns.Print("window position reset")
  elseif cmd == "status" then
    slashStatus()
  else
    ns.Print("commands: /kll  |  /kll copy (URL)  |  /kll names  |  /kll 12  |  /kll dungeon <name>  |  /kll auto  |  /kll site <url>  |  /kll reset  |  /kll status")
  end
end

SLASH_KEYLEVELLOGS1 = "/kll"
SLASH_KEYLEVELLOGS2 = "/keylevellogs"
SlashCmdList["KEYLEVELLOGS"] = ns.HandleSlash
