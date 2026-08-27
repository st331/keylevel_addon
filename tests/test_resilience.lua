-- test_resilience.lua — the window must appear when asked, no matter what
-- happened during load.
--
-- Reported live on 12.1: /keylevellogs autocompleted (so Core.lua had run
-- and registered the command) but /kll did nothing at all — no window, no
-- error. Every case below reproduces that class of failure: something stops
-- UI:Init() from running, after which the addon no-ops in silence forever,
-- which is impossible to diagnose from inside the game.

local B = _G.__B
local T = B.T
local mock = B.mock

local function windowShown()
  local f = _G.KeyLevelLogsFrame
  return f ~= nil and f:IsShown()
end

--------------------------------------------------------------------------
T.group("resilience: the window opens on demand")

-- 1. PLAYER_LOGIN already fired before this addon finished loading (a late
--    or on-demand load, or being enabled mid-session). PLAYER_LOGIN used to
--    be registered *inside* the ADDON_LOADED handler, so it never arrived
--    again and Init() never ran.
do
  local ns = B.StartSession({ skipLogin = true })
  mock.SetLoggedIn(true)
  mock.FireEvent("PLAYER_LOGIN")                     -- nobody is listening yet
  mock.FireEvent("ADDON_LOADED", "KeyLevelLogs")

  T.ok(ns.UI.frame ~= nil, "late load: UI initializes without a second PLAYER_LOGIN")
  mock.RunSlash("/kll")
  T.ok(windowShown(), "late load: /kll opens the window")
end

-- 2. No login events at all: /kll must still build and show the window.
do
  B.StartSession({ skipLogin = true })
  mock.SetLoggedIn(true)
  mock.RunSlash("/kll")
  T.ok(windowShown(), "no login events: /kll still opens the window")
  mock.RunSlash("/kll")
  T.ok(not windowShown(), "and toggles back closed")
end

--------------------------------------------------------------------------
T.group("resilience: bad saved state cannot swallow the window")

do
  B.StartSession({ savedVars = {
    window = { point = "TOPLEFT", relPoint = "TOPLEFT", x = 99999, y = -99999, shown = true },
  } })
  mock.RunSlash("/kll show")
  T.ok(windowShown(), "absurd saved position: window still shows")
  local _, _, _, x, y = _G.KeyLevelLogsFrame:GetPoint(1)
  T.ok(math.abs(x) < 10000 and math.abs(y) < 10000, "off-screen position is pulled back on screen")
end

do
  B.StartSession({ savedVars = { window = { point = 42, x = "nonsense", y = {}, shown = true } } })
  mock.RunSlash("/kll show")
  T.ok(windowShown(), "corrupt saved position: window still shows")
end

-- A broken SavedVariables table must not stop event wiring. The old code ran
-- InitDB before registering events, so a throw there disabled everything.
do
  B.StartSession({ savedVars = "not a table at all" })
  mock.RunSlash("/kll show")
  T.ok(windowShown(), "corrupt SavedVariables: addon still works")
end

--------------------------------------------------------------------------
T.group("resilience: failures are reported, never silent")

-- If the frame genuinely cannot be built, say so. Silence is what made this
-- undiagnosable in-game (script errors are off by default).
do
  local ns = B.StartSession({ skipLogin = true })
  mock.SetLoggedIn(true)
  local realCreate = _G.CreateFrame
  _G.CreateFrame = function() error("simulated 12.1 template failure") end
  local printed = mock.CapturePrint(function() mock.RunSlash("/kll") end)
  _G.CreateFrame = realCreate

  T.ok(#printed > 0, "a failed init prints something rather than doing nothing")
  local joined = table.concat(printed, "\n"):lower()
  T.ok(joined:find("could not") or joined:find("error") or joined:find("fail"),
    "and the message says it failed")
  T.is_nil(ns.UI.frame, "no half-built frame is left behind")

  -- and it recovers once the cause clears
  mock.RunSlash("/kll")
  T.ok(windowShown(), "recovers on the next /kll once the failure clears")
end

--------------------------------------------------------------------------
T.group("key level parsed out of listing titles")

do
  local nsp = B.StartSession({})
  local ns_ParseKeyLevel = nsp.ParseKeyLevel
  local cases = {
    { "AK +12 weekly",              12 },
    { "M+15 AA",                    15 },
    { "Voidscar +18 timed",         18 },
    { "+10 or higher",              10 },
    { "Kings Rest 15+",             15, "level written after the plus" },
    -- the reported wrong-key-level bug: an io-score requirement in the
    -- title was being read as the key level
    { "+2.5k io +18 need dps",      18, "score '+2.5k' is not the key level" },
    { "3200+ io, Murder Row +14",   14, "four-digit score ignored" },
    { "LF healer 3.2k+ rio +20",    20, "'3.2k+' ignored" },
    { "2500+ score +8 chill run",    8 },
    { "+3k io +22",                 22, "'+3k' ignored" },
    -- nothing usable: fall back rather than invent a level
    { "Altar of Fangs run",        nil },
    { "Need 3.2k io",              nil, "a bare score is not a key level" },
    { "+99 impossible",            nil, "implausible levels rejected" },
    { "",                          nil },
  }
  for _, c in ipairs(cases) do
    local got = ns_ParseKeyLevel(c[1])
    T.eq(got, c[2], ("title %q -> %s%s"):format(c[1], tostring(c[2]), c[3] and (" (" .. c[3] .. ")") or ""))
  end
  T.is_nil(ns_ParseKeyLevel(nil), "nil title")
  T.is_nil(ns_ParseKeyLevel(12), "non-string title")
end

do
  -- end to end: the listing title wins over the keystone you happen to hold
  local ns = B.StartSession({ keystoneLevel = 7 })
  mock.state.activeEntry = { activityID = 1, name = "+2.5k io +18 LF dps" }
  local ctx = ns.GetContext()
  T.eq(ctx.level, 18, "listing title beats the held keystone, score ignored")
  T.eq(ctx.levelSource, "your listing's title", "and reports where it came from")

  mock.state.activeEntry = { activityID = 1, name = "Murder Row chill run" }
  ctx = ns.GetContext()
  T.eq(ctx.level, 7, "no +N in the title: falls back to your keystone")
  T.eq(ctx.levelSource, "the keystone you're holding", "source says so, so a wrong level is explainable")
end

--------------------------------------------------------------------------
T.group("resilience: status reports enough to diagnose")

do
  B.StartSession({})
  local printed = mock.CapturePrint(function() mock.RunSlash("/kll status") end)
  local joined = table.concat(printed, "\n"):lower()
  T.ok(joined:find("window"), "status mentions the window state: " .. joined)
end
