-- wow_mock.lua
-- A lightweight simulation of the WoW addon environment, sufficient to load
-- and exercise KeyLevelLogs outside the game under plain Lua 5.1.
--
-- It intentionally implements only what the addon uses; if the addon starts
-- calling something new, add it here so tests fail loudly instead of silently.

local M = {}

M.state = {
  frames = {},           -- creation-ordered list of all widgets
  eventRegistry = {},    -- event name -> { [frame] = true }
  applicants = {},       -- array of { applicantID=n, members={ {name=,class=,...}, ... } }
  activeEntry = nil,     -- return of C_LFGList.GetActiveEntryInfo()
  keystoneLevel = nil,
  keystoneMapID = nil,
  challengeMaps = {},    -- mapChallengeModeID -> name
  timers = {},
  now = 1750000000,
  playerName = "Tester",
  realmNormalized = "TestRealm",
  realmDisplay = "Test Realm",
  prints = {},           -- captured print() output
}

--------------------------------------------------------------------------
-- Widget implementation
--------------------------------------------------------------------------

local widgetId = 0

local Widget = {}
Widget.__index = Widget

local function newWidget(kind, name, parent, template)
  widgetId = widgetId + 1
  local w = setmetatable({
    _id = widgetId,
    _kind = kind,
    _name = name,
    _parent = parent,
    _template = template,
    _shown = true,
    _points = {},
    _width = 0,
    _height = 0,
    _scripts = {},
    _children = {},
    _movable = false,
    _mouseEnabled = false,
    _clamped = false,
    _dragButtons = nil,
    _moving = false,
    _strata = "MEDIUM",
    _text = nil,
    _alpha = 1,
    _backdrop = nil,
    _events = {},
  }, Widget)
  table.insert(M.state.frames, w)
  if parent and parent._children then
    table.insert(parent._children, w)
  end
  if name then
    _G[name] = w
  end
  return w
end

-- Geometry ---------------------------------------------------------------
function Widget:SetPoint(point, relTo, relPoint, x, y)
  -- Accept the common WoW overloads: (point), (point, x, y), (point, rel, relPoint, x, y)
  if type(relTo) == "number" then
    point, x, y, relTo, relPoint = point, relTo, relPoint, nil, nil
  end
  table.insert(self._points, {
    point = point, relTo = relTo, relPoint = relPoint or point, x = x or 0, y = y or 0,
  })
end
function Widget:ClearAllPoints() self._points = {} end
function Widget:GetPoint(i)
  local p = self._points[i or 1]
  if not p then return nil end
  return p.point, p.relTo, p.relPoint, p.x, p.y
end
function Widget:GetNumPoints() return #self._points end
function Widget:SetSize(w, h) self._width, self._height = w, h end
function Widget:SetWidth(w) self._width = w end
function Widget:SetHeight(h) self._height = h end
function Widget:GetWidth() return self._width end
function Widget:GetHeight() return self._height end
function Widget:SetScale() end
function Widget:GetScale() return 1 end
function Widget:GetEffectiveScale() return 1 end

-- Visibility ---------------------------------------------------------------
function Widget:Show() self._shown = true end
function Widget:Hide() self._shown = false end
function Widget:SetShown(s) self._shown = not not s end
function Widget:IsShown() return self._shown end
function Widget:IsVisible()
  local w = self
  while w do
    if not w._shown then return false end
    w = w._parent
  end
  return true
end

-- Identity ---------------------------------------------------------------
function Widget:GetName() return self._name end
function Widget:GetParent() return self._parent end
function Widget:SetParent(p) self._parent = p end
function Widget:GetObjectType() return self._kind end

-- Scripts / events ---------------------------------------------------------
function Widget:SetScript(handler, fn) self._scripts[handler] = fn end
function Widget:GetScript(handler) return self._scripts[handler] end
function Widget:HookScript(handler, fn)
  local prev = self._scripts[handler]
  self._scripts[handler] = function(...)
    if prev then prev(...) end
    fn(...)
  end
end
function Widget:RegisterEvent(event)
  self._events[event] = true
  M.state.eventRegistry[event] = M.state.eventRegistry[event] or {}
  M.state.eventRegistry[event][self] = true
end
function Widget:UnregisterEvent(event)
  self._events[event] = nil
  if M.state.eventRegistry[event] then
    M.state.eventRegistry[event][self] = nil
  end
end
function Widget:UnregisterAllEvents()
  for event in pairs(self._events) do self:UnregisterEvent(event) end
end
function Widget:IsEventRegistered(event) return self._events[event] or false end

-- Movement ---------------------------------------------------------------
function Widget:SetMovable(m) self._movable = m end
function Widget:IsMovable() return self._movable end
function Widget:EnableMouse(e) self._mouseEnabled = e end
function Widget:IsMouseEnabled() return self._mouseEnabled end
function Widget:SetClampedToScreen(c) self._clamped = c end
function Widget:RegisterForDrag(...) self._dragButtons = { ... } end
function Widget:StartMoving() self._moving = true end
function Widget:StopMovingOrSizing() self._moving = false end
function Widget:SetUserPlaced() end
function Widget:SetDontSavePosition() end
function Widget:SetResizable() end
function Widget:SetFrameStrata(s) self._strata = s end
function Widget:GetFrameStrata() return self._strata end
function Widget:SetFrameLevel() end
function Widget:SetToplevel() end
function Widget:SetAlpha(a) self._alpha = a end
function Widget:Raise() end

-- Backdrop (BackdropTemplate) ----------------------------------------------
function Widget:SetBackdrop(b) self._backdrop = b end
function Widget:SetBackdropColor(r, g, b, a) self._backdropColor = { r, g, b, a } end
function Widget:SetBackdropBorderColor(r, g, b, a) self._backdropBorderColor = { r, g, b, a } end

-- Children ---------------------------------------------------------------
function Widget:CreateFontString(name, layer, inherits)
  local fs = newWidget("FontString", name, self, inherits)
  fs._text = ""
  return fs
end
function Widget:CreateTexture(name, layer)
  return newWidget("Texture", name, self)
end

-- FontString / Button text ---------------------------------------------------
function Widget:SetText(t) self._text = t end
function Widget:GetText() return self._text end
function Widget:SetFormattedText(fmt, ...) self._text = string.format(fmt, ...) end
function Widget:SetTextColor(r, g, b, a) self._textColor = { r, g, b, a } end
function Widget:SetJustifyH(j) self._justifyH = j end
function Widget:SetJustifyV(j) self._justifyV = j end
function Widget:SetWordWrap() end
function Widget:SetNonSpaceWrap() end
function Widget:SetFontObject() end
function Widget:SetFont() end
function Widget:GetStringWidth() return #(tostring(self._text or "")) * 7 end
function Widget:SetMaxLines() end

-- Texture ---------------------------------------------------------------
function Widget:SetTexture(t) self._texture = t end
function Widget:SetColorTexture(r, g, b, a) self._texture = { r, g, b, a } end
function Widget:SetAllPoints() self._allPoints = true end
function Widget:SetAtlas(a) self._atlas = a end

-- Button ---------------------------------------------------------------
function Widget:RegisterForClicks() end
function Widget:SetNormalFontObject() end
function Widget:SetHighlightFontObject() end
function Widget:GetFontString() return self._fontString end
function Widget:Enable() self._disabled = false end
function Widget:Disable() self._disabled = true end
function Widget:IsEnabled() return not self._disabled end
function Widget:Click(button)
  local fn = self._scripts.OnClick
  if fn and not self._disabled then fn(self, button or "LeftButton") end
end
function Widget:SetNormalTexture() end
function Widget:SetPushedTexture() end
function Widget:SetHighlightTexture() end
function Widget:SetDisabledTexture() end

-- EditBox ---------------------------------------------------------------
function Widget:SetAutoFocus() end
function Widget:SetFocus() self._focused = true end
function Widget:ClearFocus() self._focused = false end
function Widget:HighlightText(s, e) self._highlighted = { s or 0, e or -1 } end
function Widget:SetMultiLine(m) self._multiLine = m end
function Widget:SetMaxLetters() end
function Widget:SetCursorPosition() end
function Widget:SetTextInsets() end

-- ScrollFrame ---------------------------------------------------------------
function Widget:SetScrollChild(c) self._scrollChild = c end
function Widget:GetScrollChild() return self._scrollChild end
function Widget:SetVerticalScroll(v) self._verticalScroll = v end
function Widget:GetVerticalScrollRange() return 0 end
function Widget:EnableMouseWheel() end
function Widget:UpdateScrollChildRect() end

--------------------------------------------------------------------------
-- Global WoW API surface
--------------------------------------------------------------------------

function M.install()
  _G.CreateFrame = function(kind, name, parent, template)
    return newWidget(kind, name, parent, template)
  end

  _G.UIParent = newWidget("Frame", "UIParent", nil)
  _G.GameFontNormal = {}
  _G.GameFontNormalLarge = {}
  _G.GameFontHighlight = {}
  _G.GameFontHighlightSmall = {}
  _G.GameFontNormalSmall = {}
  _G.ChatFontNormal = {}

  _G.SlashCmdList = {}
  _G.StaticPopupDialogs = {}

  -- print capture (also echoes to real stdout for debugging with -v)
  local realPrint = print
  _G.print = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    local line = table.concat(parts, " ")
    table.insert(M.state.prints, line)
    if M.verbose then realPrint("[print] " .. line) end
  end

  -- WoW-flavored standard library additions
  _G.format = string.format
  _G.strlower = string.lower
  _G.strupper = string.upper
  _G.strtrim = function(s) return (s:gsub("^%s*(.-)%s*$", "%1")) end
  _G.strsplit = function(delim, s, pieces)
    local out = {}
    local pattern = "([^" .. delim:gsub("(%W)", "%%%1") .. "]+)"
    for part in s:gmatch(pattern) do out[#out + 1] = part end
    return unpack(out)
  end
  _G.tinsert = table.insert
  _G.tremove = table.remove
  _G.wipe = function(t)
    for k in pairs(t) do t[k] = nil end
    return t
  end
  _G.tContains = function(t, v)
    for _, x in ipairs(t) do if x == v then return true end end
    return false
  end
  _G.CopyTable = function(t)
    local copy = {}
    for k, v in pairs(t) do
      copy[k] = (type(v) == "table") and _G.CopyTable(v) or v
    end
    return copy
  end
  _G.GetTime = function() return M.state.now end
  _G.time = function() return M.state.now end
  _G.date = function(fmt, t) return os.date(fmt, t or M.state.now) end

  _G.RAID_CLASS_COLORS = {}
  local classColors = {
    WARRIOR = "c69b6d", PALADIN = "f48cba", HUNTER = "aad372", ROGUE = "fff468",
    PRIEST = "ffffff", DEATHKNIGHT = "c41e3a", SHAMAN = "0070dd", MAGE = "3fc7eb",
    WARLOCK = "8788ee", MONK = "00ff98", DRUID = "ff7c0a", DEMONHUNTER = "a330c9",
    EVOKER = "33937f",
  }
  for class, hex in pairs(classColors) do
    local r = tonumber(hex:sub(1, 2), 16) / 255
    local g = tonumber(hex:sub(3, 4), 16) / 255
    local b = tonumber(hex:sub(5, 6), 16) / 255
    _G.RAID_CLASS_COLORS[class] = { r = r, g = g, b = b, colorStr = "ff" .. hex }
  end

  -- Unit / realm info
  _G.UnitName = function(unit)
    if unit == "player" then return M.state.playerName end
    return nil
  end
  _G.UnitFullName = function(unit)
    if unit == "player" then return M.state.playerName, M.state.realmNormalized end
    return nil
  end
  _G.GetNormalizedRealmName = function() return M.state.realmNormalized end
  _G.GetCurrentRegion = function() return M.state.region or 1 end
  _G.GetRealmName = function() return M.state.realmDisplay end
  _G.UnitClass = function() return "Mage", "MAGE", 8 end
  _G.IsInGroup = function() return false end
  _G.InCombatLockdown = function() return false end
  _G.GetLocale = function() return "enUS" end

  -- C_Timer ---------------------------------------------------------------
  _G.C_Timer = {
    After = function(delay, fn)
      table.insert(M.state.timers, { at = M.state.now + delay, fn = fn })
    end,
    NewTicker = function(interval, fn)
      local ticker = { cancelled = false }
      function ticker:Cancel() self.cancelled = true end
      local function schedule()
        table.insert(M.state.timers, {
          at = M.state.now + interval,
          fn = function()
            if not ticker.cancelled then
              fn(ticker)
              schedule()
            end
          end,
        })
      end
      schedule()
      return ticker
    end,
  }

  -- C_LFGList ---------------------------------------------------------------
  _G.C_LFGList = {
    GetApplicants = function()
      local ids = {}
      for _, app in ipairs(M.state.applicants) do ids[#ids + 1] = app.applicantID end
      return ids
    end,
    GetApplicantInfo = function(applicantID)
      for _, app in ipairs(M.state.applicants) do
        if app.applicantID == applicantID then
          return {
            applicantID = applicantID,
            applicationStatus = app.applicationStatus or "applied",
            pendingApplicationStatus = nil,
            numMembers = #app.members,
            isNew = app.isNew or false,
            comment = app.comment or "",
            displayOrderID = app.displayOrderID or 0,
          }
        end
      end
      return nil
    end,
    -- Returns are positional, mirroring the live API:
    -- name, class, localizedClass, level, itemLevel, honorLevel,
    -- tank, healer, damage, assignedRole, relationship, dungeonScore, pvpItemLevel
    GetApplicantMemberInfo = function(applicantID, memberIndex)
      for _, app in ipairs(M.state.applicants) do
        if app.applicantID == applicantID then
          local m = app.members[memberIndex]
          if not m then return nil end
          return m.name, m.class or "MAGE", m.localizedClass or "Mage",
            m.level or 80, m.itemLevel or 600, m.honorLevel or 0,
            m.tank or false, m.healer or false, m.damage ~= false,
            m.assignedRole or "DAMAGER", m.relationship or false,
            m.dungeonScore or 0, m.pvpItemLevel or 0
        end
      end
      return nil
    end,
    GetActiveEntryInfo = function() return M.state.activeEntry end,
    HasActiveEntryInfo = function() return M.state.activeEntry ~= nil end,
    GetActivityInfoTable = function(activityID)
      local a = (M.state.activities or {})[activityID]
      if a then return a end
      return nil
    end,
  }

  -- C_MythicPlus / C_ChallengeMode --------------------------------------------
  _G.C_MythicPlus = {
    GetOwnedKeystoneLevel = function() return M.state.keystoneLevel end,
    GetOwnedKeystoneChallengeMapID = function() return M.state.keystoneMapID end,
    RequestMapInfo = function() end,
  }
  _G.C_ChallengeMode = {
    GetMapUIInfo = function(mapID)
      local name = M.state.challengeMaps[mapID]
      if not name then return nil end
      -- 6 returns on live: name, id, timeLimit, texture, backgroundTexture, mapID
      return name, mapID, 1800, "tex", "bgtex", 0
    end,
    GetMapTable = function()
      local ids = {}
      for id in pairs(M.state.challengeMaps) do ids[#ids + 1] = id end
      table.sort(ids)
      return ids
    end,
  }

  _G.C_AddOns = {
    GetAddOnMetadata = function(addon, field)
      return M.state.addonMetadata and M.state.addonMetadata[field] or nil
    end,
  }

  _G.GameTooltip = newWidget("GameTooltip", "GameTooltip", _G.UIParent)
  function _G.GameTooltip.SetOwner() end
  function _G.GameTooltip.AddLine() end

  _G.PlaySound = function() end
  _G.SOUNDKIT = { IG_MAINMENU_OPEN = 850, IG_MAINMENU_CLOSE = 851 }

  -- Midnight 12.0 secret values: tests can mark specific values as secret
  -- via M.state.secretValues[value] = true
  _G.issecretvalue = function(v)
    return (M.state.secretValues and M.state.secretValues[v]) or false
  end
end

--------------------------------------------------------------------------
-- Harness controls
--------------------------------------------------------------------------

-- Fire a game event to every registered frame, in creation order.
function M.FireEvent(event, ...)
  local reg = M.state.eventRegistry[event]
  if not reg then return end
  -- deterministic order: iterate all frames, dispatch to registered ones
  local targets = {}
  for _, frame in ipairs(M.state.frames) do
    if reg[frame] then targets[#targets + 1] = frame end
  end
  for _, frame in ipairs(targets) do
    local fn = frame._scripts.OnEvent
    if fn then fn(frame, event, ...) end
  end
end

-- Advance mock time, firing any due C_Timer callbacks.
function M.Advance(seconds)
  M.state.now = M.state.now + seconds
  local due
  repeat
    due = nil
    for i, t in ipairs(M.state.timers) do
      if t.at <= M.state.now then due = i break end
    end
    if due then
      local t = table.remove(M.state.timers, due)
      t.fn()
    end
  until not due
end

-- Run a slash command exactly as typed, e.g. M.RunSlash("/kll 12")
function M.RunSlash(input)
  local cmd, rest = input:match("^(%S+)%s*(.-)$")
  for key, fn in pairs(_G.SlashCmdList) do
    local i = 1
    while true do
      local alias = _G["SLASH_" .. key .. i]
      if not alias then break end
      if alias:lower() == cmd:lower() then
        fn(rest or "", nil)
        return true
      end
      i = i + 1
    end
  end
  error("no slash command matches: " .. tostring(input))
end

-- Simulate the load sequence for an addon whose files are already executed.
function M.SimulateLogin(addonName)
  M.FireEvent("ADDON_LOADED", addonName)
  M.FireEvent("PLAYER_LOGIN")
  M.FireEvent("PLAYER_ENTERING_WORLD", true, false)
end

function M.SetApplicants(list)
  M.state.applicants = list
end

function M.Reset()
  -- fresh state between test files; globals get reinstalled by install()
  M.state.frames = {}
  M.state.eventRegistry = {}
  M.state.applicants = {}
  M.state.activeEntry = nil
  M.state.keystoneLevel = nil
  M.state.keystoneMapID = nil
  M.state.timers = {}
  M.state.prints = {}
  widgetId = 0
end

return M
