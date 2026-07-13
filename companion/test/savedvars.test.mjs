import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSeenApplicants, recentNames } from "../lib/savedvars.mjs";

// The exact shape Blizzard serializes SavedVariables in.
const SV = `
KeyLevelLogsDB = {
	["window"] = {
		["point"] = "CENTER",
		["x"] = 260,
		["shown"] = true,
	},
	["seenApplicants"] = {
		["Alice-Area52"] = {
			["lastSeen"] = 1752000000,
			["class"] = "MAGE",
		},
		["Bob-TwistingNether"] = {
			["lastSeen"] = 1751000000,
			["class"] = "WARRIOR",
		},
	},
	["autoShow"] = true,
}
`;

test("extracts names with lastSeen, newest first", () => {
  const entries = extractSeenApplicants(SV);
  assert.deepEqual(entries, [
    { name: "Alice-Area52", lastSeen: 1752000000 },
    { name: "Bob-TwistingNether", lastSeen: 1751000000 },
  ]);
});

test("ignores non Name-Realm keys and handles missing block", () => {
  assert.deepEqual(extractSeenApplicants("SomethingElse = {}"), []);
  const noRealm = 'KeyLevelLogsDB = { ["seenApplicants"] = { ["justkey"] = { ["lastSeen"] = 5 } } }';
  assert.deepEqual(extractSeenApplicants(noRealm), []);
});

test("does not leak keys from sibling tables", () => {
  const entries = extractSeenApplicants(SV);
  assert.ok(!entries.some((e) => e.name === "point" || e.name === "window"));
});

test("recentNames filters by hours", () => {
  const entries = [
    { name: "New-Realm", lastSeen: 1000000 },
    { name: "Old-Realm", lastSeen: 1000 },
  ];
  assert.deepEqual(recentNames(entries, 1, 1000000 + 100), ["New-Realm"]);
  assert.deepEqual(recentNames(entries, 0, 1000000 + 100), ["New-Realm", "Old-Realm"]);
});
