-- load_addon.lua
-- Loads an addon the way the WoW client does: parse the .toc, execute each
-- listed Lua file in order, passing (addonName, sharedTable) as varargs.

local Loader = {}

local function readLines(path)
  local f, err = io.open(path, "r")
  if not f then error("cannot open " .. path .. ": " .. tostring(err)) end
  local lines = {}
  for line in f:lines() do lines[#lines + 1] = line end
  f:close()
  return lines
end

-- Returns the ordered list of Lua files and the TOC directives.
function Loader.ParseTOC(tocPath)
  local files, directives = {}, {}
  for _, raw in ipairs(readLines(tocPath)) do
    local line = raw:gsub("\r$", "")
    local key, value = line:match("^##%s*([%w%-]+)%s*:%s*(.-)%s*$")
    if key then
      directives[key] = value
    elseif not line:match("^#") then
      local trimmed = line:match("^%s*(.-)%s*$")
      if trimmed ~= "" then files[#files + 1] = trimmed end
    end
  end
  return files, directives
end

-- Executes the addon. `addonDir` is the folder containing the .toc.
-- Returns the shared addon-private table (second vararg the files receive).
function Loader.Load(addonDir, addonName)
  local tocPath = addonDir .. "/" .. addonName .. ".toc"
  local files, directives = Loader.ParseTOC(tocPath)
  assert(#files > 0, "TOC lists no files: " .. tocPath)
  local shared = {}
  for _, file in ipairs(files) do
    assert(file:match("%.lua$"), "non-lua file in TOC not supported by loader: " .. file)
    local chunk, err = loadfile(addonDir .. "/" .. file:gsub("\\", "/"))
    assert(chunk, "failed to load " .. file .. ": " .. tostring(err))
    chunk(addonName, shared)
  end
  return shared, directives
end

return Loader
