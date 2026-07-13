-- t.lua — dependency-free micro test framework.

local T = {
  passed = 0,
  failed = 0,
  failures = {},
  currentGroup = "",
}

local function record(ok, msg)
  if ok then
    T.passed = T.passed + 1
  else
    T.failed = T.failed + 1
    local where = debug.traceback("", 3):match("\n%s*(.-)\n") or "?"
    local full = string.format("[%s] %s (%s)", T.currentGroup, msg, where)
    table.insert(T.failures, full)
    io.stderr:write("FAIL " .. full .. "\n")
  end
end

function T.group(name)
  T.currentGroup = name
end

function T.ok(cond, msg)
  record(not not cond, msg or "expected truthy")
end

local function repr(v)
  if type(v) == "string" then return string.format("%q", v) end
  return tostring(v)
end

function T.eq(got, want, msg)
  record(got == want, string.format("%s: got %s, want %s", msg or "eq", repr(got), repr(want)))
end

function T.near(got, want, eps, msg)
  local ok = type(got) == "number" and math.abs(got - want) <= (eps or 1e-9)
  record(ok, string.format("%s: got %s, want ~%s", msg or "near", repr(got), repr(want)))
end

function T.contains(haystack, needle, msg)
  local ok = type(haystack) == "string" and haystack:find(needle, 1, true) ~= nil
  record(ok, string.format("%s: %s does not contain %s", msg or "contains", repr(haystack), repr(needle)))
end

function T.not_contains(haystack, needle, msg)
  local ok = type(haystack) == "string" and haystack:find(needle, 1, true) == nil
  record(ok, string.format("%s: %s unexpectedly contains %s", msg or "not_contains", repr(haystack), repr(needle)))
end

function T.is_nil(v, msg)
  record(v == nil, string.format("%s: expected nil, got %s", msg or "is_nil", repr(v)))
end

function T.errors(fn, msg)
  local ok = not pcall(fn)
  record(ok, msg or "expected error")
end

function T.summary()
  -- io.write, not print: the WoW mock hijacks print() for capture
  io.write(string.format("passed: %d, failed: %d\n", T.passed, T.failed))
  return T.failed
end

return T
