-- UI.lua — the standalone, movable applicant window.
-- Renders into its own frame only; never anchors to or hooks the Blizzard
-- group finder, so it coexists with Premade Groups Filter and friends.

local ADDON_NAME, ns = ...

local UI = {}
ns.UI = UI

local WIDTH = 300
local PAD = 10
local ROW_HEIGHT = 16
local MAX_ROWS = 12
local HEADER_AREA = 58   -- title + context + column headers
local FOOTER_AREA = 28

local COL_NAME_W = 200

--------------------------------------------------------------------------

local function gray(text)
  return ns.GRAY:format(text)
end

-- In-game M+ rating (comes free with the application).
function UI.ScoreCell(score)
  if type(score) == "number" and score > 0 then
    return tostring(score)
  end
  return gray("—")
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

  local headName = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headName:SetPoint("TOPLEFT", PAD, -(HEADER_AREA - 14))
  headName:SetText("Applicant")
  local headScore = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  headScore:SetPoint("TOPLEFT", PAD + COL_NAME_W, -(HEADER_AREA - 14))
  headScore:SetText("Rating")

  self.rows = {}

  local footer = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  footer:SetPoint("BOTTOMLEFT", PAD, 9)
  footer:SetJustifyH("LEFT")
  self.footer = footer

  local copyURL = CreateFrame("Button", "KeyLevelLogsCopyURLButton", f, "UIPanelButtonTemplate")
  copyURL:SetSize(80, 20)
  copyURL:SetPoint("BOTTOMRIGHT", -8, 5)
  copyURL:SetText("Copy URL")
  copyURL:SetScript("OnClick", function() UI:ShowCopyBox("url") end)
  self.copyURLButton = copyURL

  local copyNames = CreateFrame("Button", "KeyLevelLogsCopyNamesButton", f, "UIPanelButtonTemplate")
  copyNames:SetSize(60, 20)
  copyNames:SetPoint("RIGHT", copyURL, "LEFT", -4, 0)
  copyNames:SetText("Names")
  copyNames:SetScript("OnClick", function() UI:ShowCopyBox("names") end)
  self.copyNamesButton = copyNames

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
  local name = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  name:SetPoint("TOPLEFT", PAD, y)
  name:SetWidth(COL_NAME_W - 6)
  name:SetJustifyH("LEFT")
  local score = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  score:SetPoint("TOPLEFT", PAD + COL_NAME_W, y)
  score:SetWidth(WIDTH - COL_NAME_W - PAD * 2)
  score:SetJustifyH("LEFT")
  self.rows[i] = { name = name, score = score }
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
    bits[#bits + 1] = "Key level unknown — |cffffff78/kll 12|r"
  end
  if ctx.dungeonName then
    bits[#bits + 1] = ("|cffffffff%s|r"):format(ctx.dungeonName)
  end
  return table.concat(bits, "  ·  ")
end

function UI:Refresh()
  if not self.frame then return end
  local ctx = ns.GetContext()
  local db = ns.db

  self.context:SetText(contextLine(ctx))

  -- sort by in-game rating, best first; unknown rating last
  local entries = {}
  for _, app in ipairs(ns.applicants) do
    entries[#entries + 1] = app
  end
  table.sort(entries, function(a, b)
    local sa, sb = a.score or -1, b.score or -1
    if sa ~= sb then return sa > sb end
    return a.name < b.name
  end)

  local shown = math.min(#entries, MAX_ROWS)
  for i = 1, shown do
    local row = self:Row(i)
    local app = entries[i]
    row.name:SetText(ns.ClassColor(ns.DisplayName(app.name), app.class))
    row.score:SetText(UI.ScoreCell(app.score))
    row.name:Show(); row.score:Show()
  end
  for i = shown + 1, #self.rows do
    self.rows[i].name:Hide(); self.rows[i].score:Hide()
  end

  if #entries == 0 then
    self.footer:SetText(gray("No applicants right now."))
    self.sessionSnoozed = false -- batch is over; next batch may pop again
  elseif #entries > shown then
    self.footer:SetText(gray(("+%d more — all included in Copy URL"):format(#entries - shown)))
  else
    self.footer:SetText(gray("Copy URL → paste in browser"))
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
-- Copy box — lookup URL / names for the website
--------------------------------------------------------------------------

-- kind: "url" (full lookup link) or "names" (one per line)
function UI:CopyContent(kind)
  local names = ns.NamesForLookup()
  if #names == 0 then return nil end
  if kind == "names" then
    return table.concat(names, "\n")
  end
  return ns.BuildLookupURL(names)
end

function UI:ShowCopyBox(kind)
  if not self.copyFrame then
    local cf = CreateFrame("Frame", "KeyLevelLogsCopyFrame", UIParent, "BackdropTemplate")
    cf:SetSize(420, 150)
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
    cf.label = label

    local scroll = CreateFrame("ScrollFrame", "KeyLevelLogsCopyScroll", cf)
    scroll:SetPoint("TOPLEFT", 10, -30)
    scroll:SetPoint("BOTTOMRIGHT", -10, 34)

    local edit = CreateFrame("EditBox", "KeyLevelLogsCopyEdit", scroll)
    edit:SetMultiLine(true)
    edit:SetAutoFocus(false)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(390)
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
  local text = self:CopyContent(kind or "url")
  if not text then
    ns.Print("no applicant names to copy yet")
    return
  end
  self.copyFrame.label:SetText(kind == "names"
    and "Applicant names — Ctrl+C"
    or "Lookup link — Ctrl+C, paste in your browser")
  self.copyFrame.edit:SetText(text)
  self.copyFrame:Show()
  self.copyFrame.edit:SetFocus()
  self.copyFrame.edit:HighlightText(0, -1)
end
