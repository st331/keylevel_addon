-- bootstrap.lua — shared setup: lets each test file start a fresh "session"
-- (fresh addon load, optional pre-existing SavedVariables), like relogging.

local B = {}

B.mock = dofile("tests/wow_mock.lua")
B.Loader = dofile("tests/load_addon.lua")
B.T = dofile("tests/t.lua")

local DEFAULT_MAPS = {
  [503] = "Ara-Kara, City of Echoes",
  [502] = "City of Threads",
  [375] = "Mists of Tirna Scithe",
}

-- opts:
--   savedVars     value for _G.KeyLevelLogsDB before ADDON_LOADED (nil = fresh install)
--   data          KeyLevelLogsData table; false = keep shipped placeholder; nil = test fixture
--   challengeMaps map id -> name table for C_ChallengeMode
--   keystoneLevel / keystoneMapID  starting keystone
--   skipLogin     don't fire the login events
-- returns ns (addon private table), directives (parsed TOC)
function B.StartSession(opts)
  opts = opts or {}
  local mock = B.mock
  mock.Reset()
  mock.install()
  mock.state.challengeMaps = opts.challengeMaps or DEFAULT_MAPS
  mock.state.keystoneLevel = opts.keystoneLevel
  mock.state.keystoneMapID = opts.keystoneMapID

  _G.KeyLevelLogsDB = opts.savedVars
  _G.KeyLevelLogsData = nil
  _G.KeyLevelLogsFrame = nil
  _G.KeyLevelLogsCopyFrame = nil

  local ns, directives = B.Loader.Load("KeyLevelLogs", "KeyLevelLogs")

  if opts.data ~= false then
    _G.KeyLevelLogsData = opts.data or dofile("tests/fixture_data.lua")
  end
  if not opts.skipLogin then
    mock.SimulateLogin("KeyLevelLogs")
  end
  return ns, directives
end

return B
