-- run_tests.lua — entry point: lua5.1 tests/run_tests.lua  (from repo root)

local B = dofile("tests/bootstrap.lua")
B.mock.verbose = arg and arg[1] == "-v"

_G.__B = B
_G.__T = B.T

dofile("tests/test_core.lua")
dofile("tests/test_flow.lua")
dofile("tests/test_saved_vars.lua")

local failed = B.T.summary()
os.exit(failed > 0 and 1 or 0)
