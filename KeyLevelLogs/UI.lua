-- UI.lua — the standalone, movable applicant window.
-- Renders into its own frame only; never anchors to or hooks the Blizzard
-- group finder, so it coexists with Premade Groups Filter and friends.

local ADDON_NAME, ns = ...

local UI = {}
ns.UI = UI

local WIDTH = 500
local PAD = 10
local ROW_HEIGHT = 16
local MAX_ROWS = 12
local HEADER_AREA = 58   -- title + context + column headers
local FOOTER_AREA = 26

local COL_NAME_W = 150
local COL_ANY_W = 150

--------------------------------------------------------------------------
-- Cell text builders (exposed for tests)
--------------------------------------------------------------------------

local function gray(text)
  return ns.GRAY:format(text)
end

local function pctText(pct)
  return ns.FormatPercent(pct) .. "%"
end

-- "Any dungeon at this key level" column.
function UI.AnyCell(eval, level)
  if eval.status == "NO_PLAYER" then
    return gray("no data")
  end
  if eval.anyAtLevel then
    local runs = eval.anyAtLevel.runs or 0
    return ("%s %s"):format(pctText(eval.anyAtLevel.pct),
      gray(("(%d dungeon%s)"):format(runs, runs == 1 and "" or "s")))
  end
  if eval.anyBest then
    return ("%s +%d: %s"):format(gray("none · best"), eval.anyBest.level, pctText(eval.anyBest.pct))
  end
  if not level then
    return gray("set level: /kll 12")
  end
  return gray("no M+ logs")
end

-- "This dungeon" column (exact level, or one below as fallback).
function UI.DungeonCell(eval, level, encounterID)
  if eval.status == "NO_PLAYER" then
    return gray("—")
  end
  if not encounterID then
    return gray("—")
  end
  if eval.dungeon then
    if eval.dungeon.isFallback then
      return ("%s %s"):format(pctText(eval.dungeon.pct), gray(("@+%d (one below)"):format(eval.dungeon.level)))
    end
    return ("%s %s"):format(pctText(eval.dungeon.pct), gray(("@+%d"):format(eval.dungeon.level)))
  end
  if eval.dungeonBest then
    return ("%s +%d: %s"):format(gray("no recent · best"), eval.dungeonBest.level, pctText(eval.dungeonBest.pct))
  end
  return gray("never logged")
end

-- Sort key: strongest relevant signal first, unknowns last.
function UI.SortValue(eval)
  if eval.status == "NO_PLAYER" then return -2 end
  if eval.dungeon then return eval.dungeon.pct end
  if eval.anyAtLevel then return eval.anyAtLevel.pct - 0.001 end
  if eval.dungeonBest then return -1 + (eval.dungeonBest.pct or 0) / 1000 end
  if eval.anyBest then return -1.5 + (eval.anyBest.pct or 0) / 1000 end
  return -2
end

--------------------------------------------------------------------------
-- Frame construction
--------------------------------------------------------------------------

function UI:Init()
  if self.frame then return end

  local f = CreateFrame("Frame", "KeyLevelLogsFrame", UIParent, "BackdropTemplate")
  self.frame = f
  f:SetSize(WIDTH, HEADER_AREA + FOOTER_AREA + 4 * ROW_HEIGHT)
  f:SetFrameStrata("HIGH")
  f:SetToplevel(true)
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function() f:StartMoving() end)
  f:SetScript("OnDragStop", function()
    f:StopMovingOrSizing()
    UI:SavePosition()
  end)
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
      edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      edgeSize = 12,
      insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    f:SetBackdropColor(0.05, 0.05, 0.08, 0.92)
    f:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)
  end

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOPLEFT", PAD, -8)
  title:SetText("|cff3fc7ebKeyLevelLogs|r")
  self.title = title

  local context = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  context:SetPoint("TOPLEFT", PAD, -24)
  context:SetJustifyH("LEFT")
  self.context = context

  local close = CreateFrame("Button", "KeyLevelLogsCloseButton", f)
  close:SetSize(20, 20)
  close:SetPoint("TOPRIGHT", -4, -4)
  close:SetText("X")
  close:SetScript("OnClick", function() UI:SetShown(false) end)
  self.closeButton = close

  local headName = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headName:SetPoint("TOPLEFT", PAD, -(HEADER_AREA - 14))
  headName:SetText("Applicant")
  local headAny = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headAny:SetPoint("TOPLEFT", PAD + COL_NAME_W, -(HEADER_AREA - 14))
  local headDungeon = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headDungeon:SetPoint("TOPLEFT", PAD + COL_NAME_W + COL_ANY_W, -(HEADER_AREA - 14))
  self.headAny, self.headDungeon = headAny, headDungeon

  self.rows = {}

  local footer = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  footer:SetPoint("BOTTOMLEFT", PAD, 8)
  footer:SetJustifyH("LEFT")
  self.footer = footer

  local copyBtn = CreateFrame("Button", "KeyLevelLogsCopyButton", f)
  copyBtn:SetSize(50, 18)
  copyBtn:SetPoint("BOTTOMRIGHT", -8, 6)
  copyBtn:SetText("Copy")
  copyBtn:SetScript("OnClick", function() UI:ShowCopyBox() end)
  self.copyButton = copyBtn

  self:RestorePosition()
  f:SetShown(ns.db and ns.db.window.shown or false)
  self:Refresh()
end

function UI:Row(i)
  if self.rows[i] then return self.rows[i] end
  local f = self.frame
  local y = -(HEADER_AREA + (i - 1) * ROW_HEIGHT)
  local name = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  name:SetPoint("TOPLEFT", PAD, y)
  name:SetWidth(COL_NAME_W - 6)
  name:SetJustifyH("LEFT")
  local any = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  any:SetPoint("TOPLEFT", PAD + COL_NAME_W, y)
  any:SetWidth(COL_ANY_W - 6)
  any:SetJustifyH("LEFT")
  local dungeon = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  dungeon:SetPoint("TOPLEFT", PAD + COL_NAME_W + COL_ANY_W, y)
  dungeon:SetWidth(WIDTH - COL_NAME_W - COL_ANY_W - PAD * 2)
  dungeon:SetJustifyH("LEFT")
  self.rows[i] = { name = name, any = any, dungeon = dungeon }
  return self.rows[i]
end

--------------------------------------------------------------------------
-- Position persistence
--------------------------------------------------------------------------

function UI:SavePosition()
  if not (self.frame and ns.db) then return end
  local point, _, relPoint, x, y = self.frame:GetPoint(1)
  if point then
    ns.db.window.point, ns.db.window.relPoint = point, relPoint
    ns.db.window.x, ns.db.window.y = x, y
  end
end

function UI:RestorePosition()
  if not (self.frame and ns.db) then return end
  local w = ns.db.window
  self.frame:ClearAllPoints()
  self.frame:SetPoint(w.point or "CENTER", UIParent, w.relPoint or w.point or "CENTER", w.x or 0, w.y or 0)
end

--------------------------------------------------------------------------
-- Visibility
--------------------------------------------------------------------------

function UI:SetShown(shown)
  if not self.frame then return end
  if ns.db then ns.db.window.shown = shown end
  self.frame:SetShown(shown)
  if shown then self:Refresh() end
end

function UI:Toggle()
  if not self.frame then return end
  self:SetShown(not self.frame:IsShown())
end

--------------------------------------------------------------------------
-- Rendering
--------------------------------------------------------------------------

local function contextLine(ctx)
  local bits = {}
  if ctx.level then
    bits[#bits + 1] = ("Recruiting for |cffffffff+%d|r"):format(ctx.level)
  else
    bits[#bits + 1] = "Key level unknown — |cffffff78/kll 12|r to set"
  end
  if ctx.dungeonName then
    bits[#bits + 1] = ("|cffffffff%s|r"):format(ctx.dungeonName)
  elseif ctx.level then
    bits[#bits + 1] = "dungeon unknown — |cffffff78/kll dungeon <name>|r"
  end
  if not ns.HasData() then
    bits[#bits + 1] = "|cffff5555no data file — run companion, then /reload|r"
  end
  return table.concat(bits, "  ·  ")
end

function UI:Refresh()
  if not self.frame then return end
  local ctx = ns.GetContext()
  local db = ns.db

  self.context:SetText(contextLine(ctx))
  self.headAny:SetText(ctx.level and ("Any dungeon @+%d"):format(ctx.level) or "Any dungeon")
  if ctx.level and ctx.encounterID then
    self.headDungeon:SetFormattedText("This dungeon +%d/+%d", ctx.level, ctx.level - 1)
  else
    self.headDungeon:SetText("This dungeon")
  end

  -- evaluate + sort applicants
  local entries = {}
  for _, app in ipairs(ns.applicants) do
    local eval = ns.Evaluate(ns.LookupPlayer(app.name), ctx.encounterID, ctx.level)
    entries[#entries + 1] = { app = app, eval = eval, sort = UI.SortValue(eval) }
  end
  table.sort(entries, function(a, b)
    if a.sort ~= b.sort then return a.sort > b.sort end
    return a.app.name < b.app.name
  end)

  local shown = math.min(#entries, MAX_ROWS)
  for i = 1, shown do
    local row = self:Row(i)
    local e = entries[i]
    row.name:SetText(ns.ClassColor(ns.DisplayName(e.app.name), e.app.class))
    row.any:SetText(UI.AnyCell(e.eval, ctx.level))
    row.dungeon:SetText(UI.DungeonCell(e.eval, ctx.level, ctx.encounterID))
    row.name:Show(); row.any:Show(); row.dungeon:Show()
  end
  for i = shown + 1, #self.rows do
    local row = self.rows[i]
    row.name:Hide(); row.any:Hide(); row.dungeon:Hide()
  end

  if #entries == 0 then
    self.footer:SetText(gray("No applicants right now."))
  elseif #entries > shown then
    self.footer:SetText(gray(("+%d more applicant(s) not shown"):format(#entries - shown)))
  else
    self.footer:SetText(gray("/kll for options"))
  end

  local rowsForHeight = math.max(shown, 1)
  self.frame:SetHeight(HEADER_AREA + FOOTER_AREA + rowsForHeight * ROW_HEIGHT)

  -- pop the window when applicants arrive, if the user hasn't hidden it
  if #entries > 0 and db and db.autoShow and db.window.shown and not self.frame:IsShown() then
    self.frame:Show()
  end
end

--------------------------------------------------------------------------
-- Copy box — names for the companion tool
--------------------------------------------------------------------------

function UI:CopyText()
  local names = {}
  for _, app in ipairs(ns.applicants) do
    names[#names + 1] = app.name
  end
  if #names == 0 and ns.db then
    -- fall back to recently seen applicants (last hour)
    local cutoff = time() - 3600
    for name, info in pairs(ns.db.seenApplicants) do
      if (info.lastSeen or 0) >= cutoff then names[#names + 1] = name end
    end
    table.sort(names)
  end
  return table.concat(names, "\n")
end

function UI:ShowCopyBox()
  if not self.copyFrame then
    local cf = CreateFrame("Frame", "KeyLevelLogsCopyFrame", UIParent, "BackdropTemplate")
    cf:SetSize(360, 180)
    cf:SetPoint("CENTER")
    cf:SetFrameStrata("DIALOG")
    cf:SetMovable(true)
    cf:EnableMouse(true)
    cf:RegisterForDrag("LeftButton")
    cf:SetScript("OnDragStart", function() cf:StartMoving() end)
    cf:SetScript("OnDragStop", function() cf:StopMovingOrSizing() end)
    if cf.SetBackdrop then
      cf:SetBackdrop({
        bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
        edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
        edgeSize = 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
      })
      cf:SetBackdropColor(0, 0, 0, 0.95)
    end

    local label = cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    label:SetPoint("TOPLEFT", 10, -10)
    label:SetText("Applicant names — Ctrl+C, paste into the companion")

    local scroll = CreateFrame("ScrollFrame", "KeyLevelLogsCopyScroll", cf)
    scroll:SetPoint("TOPLEFT", 10, -30)
    scroll:SetPoint("BOTTOMRIGHT", -10, 34)

    local edit = CreateFrame("EditBox", "KeyLevelLogsCopyEdit", scroll)
    edit:SetMultiLine(true)
    edit:SetAutoFocus(false)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(330)
    edit:SetScript("OnEscapePressed", function() cf:Hide() end)
    scroll:SetScrollChild(edit)
    cf.edit = edit

    local closeBtn = CreateFrame("Button", "KeyLevelLogsCopyClose", cf)
    closeBtn:SetSize(60, 20)
    closeBtn:SetPoint("BOTTOMRIGHT", -10, 8)
    closeBtn:SetText("Close")
    closeBtn:SetScript("OnClick", function() cf:Hide() end)

    self.copyFrame = cf
  end
  local text = self:CopyText()
  if text == "" then
    ns.Print("no applicant names to copy yet")
    return
  end
  self.copyFrame.edit:SetText(text)
  self.copyFrame:Show()
  self.copyFrame.edit:SetFocus()
  self.copyFrame.edit:HighlightText(0, -1)
end
