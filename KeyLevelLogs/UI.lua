-- UI.lua — the standalone, movable applicant window.
-- Renders into its own frame only; never anchors to or hooks the Blizzard
-- group finder, so it coexists with Premade Groups Filter and friends.

local ADDON_NAME, ns = ...

local UI = {}
ns.UI = UI

local WIDTH = 560
local PAD = 10
local ROW_HEIGHT = 16
local MAX_ROWS = 12
local HEADER_AREA = 58   -- title + context + column headers
local FOOTER_AREA = 26

local COL_NAME_W = 150
local COL_SCORE_W = 52
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
    return gray("not fetched — /kll copy")
  end
  if eval.status == "NO_WCL" then
    return gray("no WCL character")
  end
  if not level then
    if eval.anyBest then
      return ("%s +%d: %s"):format(gray("best:"), eval.anyBest.level, pctText(eval.anyBest.pct))
    end
    return gray("set level: /kll 12")
  end
  if eval.anyAtLevel then
    local runs = eval.anyAtLevel.runs or 0
    return ("%s %s"):format(pctText(eval.anyAtLevel.pct),
      gray(("(%d dungeon%s)"):format(runs, runs == 1 and "" or "s")))
  end
  if eval.anyBest then
    return ("%s +%d: %s"):format(gray(("none at +%d · best"):format(level)), eval.anyBest.level, pctText(eval.anyBest.pct))
  end
  return gray("no M+ logs")
end

-- "This dungeon" column: exact level, nearest higher level, or one below.
function UI.DungeonCell(eval, level, encounterID)
  if eval.status ~= "OK" or not encounterID then
    return gray("—")
  end
  local d = eval.dungeon
  if d then
    if d.kind == "below" then
      return ("%s %s"):format(pctText(d.pct), gray(("@+%d (one below)"):format(d.level)))
    elseif d.kind == "above" then
      return ("%s %s"):format(pctText(d.pct), gray(("@+%d (higher)"):format(d.level)))
    end
    return ("%s %s"):format(pctText(d.pct), gray(("@+%d"):format(d.level)))
  end
  if eval.dungeonBest then
    return ("%s +%d: %s"):format(gray("only lower · best"), eval.dungeonBest.level, pctText(eval.dungeonBest.pct))
  end
  return gray("never logged")
end

-- In-game M+ rating (comes free with the application; works even for
-- players the companion hasn't fetched).
function UI.ScoreCell(score)
  if type(score) == "number" and score > 0 then
    return tostring(score)
  end
  return gray("—")
end

-- Sort key: strongest relevant signal first, unknowns last.
function UI.SortValue(eval)
  if eval.status ~= "OK" then return -2 end
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

  -- UIPanelCloseButton: template supplies textures; a bare Button would be
  -- invisible in the live client. Closing snoozes for this applicant batch
  -- only (see Snooze) — /kll hide is the persistent off switch.
  local close = CreateFrame("Button", "KeyLevelLogsCloseButton", f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() UI:Snooze() end)
  self.closeButton = close

  local x = PAD
  local headName = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headName:SetPoint("TOPLEFT", x, -(HEADER_AREA - 14))
  headName:SetText("Applicant")
  x = x + COL_NAME_W
  local headScore = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headScore:SetPoint("TOPLEFT", x, -(HEADER_AREA - 14))
  headScore:SetText("Rating")
  x = x + COL_SCORE_W
  local headAny = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headAny:SetPoint("TOPLEFT", x, -(HEADER_AREA - 14))
  x = x + COL_ANY_W
  local headDungeon = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headDungeon:SetPoint("TOPLEFT", x, -(HEADER_AREA - 14))
  self.headAny, self.headDungeon = headAny, headDungeon

  self.rows = {}

  local footer = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  footer:SetPoint("BOTTOMLEFT", PAD, 8)
  footer:SetJustifyH("LEFT")
  self.footer = footer

  local copyBtn = CreateFrame("Button", "KeyLevelLogsCopyButton", f, "UIPanelButtonTemplate")
  copyBtn:SetSize(60, 20)
  copyBtn:SetPoint("BOTTOMRIGHT", -8, 5)
  copyBtn:SetText("Copy")
  copyBtn:SetScript("OnClick", function() UI:ShowCopyBox() end)
  self.copyButton = copyBtn

  self:RestorePosition()
  -- start hidden; Refresh auto-shows when applicants exist (no empty window
  -- squatting on screen after every login)
  f:Hide()
  self:Refresh()
end

function UI:Row(i)
  if self.rows[i] then return self.rows[i] end
  local f = self.frame
  local y = -(HEADER_AREA + (i - 1) * ROW_HEIGHT)
  local x = PAD
  local function col(width)
    local fs = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    fs:SetPoint("TOPLEFT", x, y)
    fs:SetWidth(width - 6)
    fs:SetJustifyH("LEFT")
    x = x + width
    return fs
  end
  local name = col(COL_NAME_W)
  local score = col(COL_SCORE_W)
  local any = col(COL_ANY_W)
  local dungeon = col(WIDTH - COL_NAME_W - COL_SCORE_W - COL_ANY_W - PAD * 2)
  self.rows[i] = { name = name, score = score, any = any, dungeon = dungeon }
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
-- Three layers:
--   db.window.shown  persistent preference (/kll show|hide)
--   sessionSnoozed   the X button: hide until this applicant batch clears
--   auto-show        new applicants pop the window when allowed by both

function UI:SetShown(shown)
  if not self.frame then return end
  if ns.db then ns.db.window.shown = shown end
  self.sessionSnoozed = false
  self.frame:SetShown(shown)
  if shown then self:Refresh() end
end

function UI:Toggle()
  if not self.frame then return end
  self:SetShown(not self.frame:IsShown())
end

function UI:Snooze()
  if not self.frame then return end
  self.sessionSnoozed = true
  self.frame:Hide()
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
    self.headDungeon:SetFormattedText("This dungeon (want +%d)", ctx.level)
  else
    self.headDungeon:SetText("This dungeon")
  end

  -- evaluate + sort applicants
  local entries = {}
  for _, app in ipairs(ns.applicants) do
    local player = ns.LookupPlayer(app.name)
    local eval = ns.Evaluate(player, ctx.encounterID, ctx.level)
    entries[#entries + 1] = { app = app, eval = eval, player = player, sort = UI.SortValue(eval) }
  end
  table.sort(entries, function(a, b)
    if a.sort ~= b.sort then return a.sort > b.sort end
    return a.app.name < b.app.name
  end)

  local shown = math.min(#entries, MAX_ROWS)
  for i = 1, shown do
    local row = self:Row(i)
    local e = entries[i]
    local name = ns.ClassColor(ns.DisplayName(e.app.name), e.app.class)
    local age = e.player and ns.AgeTag(e.player.updated)
    if age then
      name = name .. " " .. gray("(" .. age .. ")")
    end
    row.name:SetText(name)
    row.score:SetText(UI.ScoreCell(e.app.score))
    row.any:SetText(UI.AnyCell(e.eval, ctx.level))
    row.dungeon:SetText(UI.DungeonCell(e.eval, ctx.level, ctx.encounterID))
    row.name:Show(); row.score:Show(); row.any:Show(); row.dungeon:Show()
  end
  for i = shown + 1, #self.rows do
    local row = self.rows[i]
    row.name:Hide(); row.score:Hide(); row.any:Hide(); row.dungeon:Hide()
  end

  if #entries == 0 then
    self.footer:SetText(gray("No applicants right now."))
    self.sessionSnoozed = false -- batch is over; next batch may pop again
  elseif #entries > shown then
    self.footer:SetText(gray(("+%d more applicant(s) not shown"):format(#entries - shown)))
  else
    self.footer:SetText(gray("/kll for options"))
  end

  local rowsForHeight = math.max(shown, 1)
  self.frame:SetHeight(HEADER_AREA + FOOTER_AREA + rowsForHeight * ROW_HEIGHT)

  -- pop the window when applicants arrive, unless the user said no
  if #entries > 0 and db and db.autoShow and db.window.shown
    and not self.sessionSnoozed and not self.frame:IsShown() then
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

    local closeBtn = CreateFrame("Button", "KeyLevelLogsCopyClose", cf, "UIPanelButtonTemplate")
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
