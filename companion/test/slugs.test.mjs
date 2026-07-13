import { test } from "node:test";
import assert from "node:assert/strict";
import { slugCandidates, parseFullName } from "../lib/slugs.mjs";

test("single-word realm", () => {
  assert.deepEqual(slugCandidates("Sargeras"), ["sargeras"]);
});

test("camel-case realm gets dashed candidate first", () => {
  assert.deepEqual(slugCandidates("TwistingNether"), ["twisting-nether", "twistingnether"]);
});

test("digit boundary", () => {
  assert.deepEqual(slugCandidates("Area52"), ["area-52", "area52"]);
});

test("apostrophe-stripped realm (Kiljaeden) yields plain slug", () => {
  assert.deepEqual(slugCandidates("Kiljaeden"), ["kiljaeden"]);
});

test("override wins", () => {
  assert.deepEqual(
    slugCandidates("MalGanis", { MalGanis: "mal-ganis" }),
    ["mal-ganis", "malganis"],
  );
});

test("parseFullName", () => {
  assert.deepEqual(parseFullName("Foo-Area52"), { name: "Foo", realm: "Area52" });
  assert.deepEqual(parseFullName("  Foo-Area52  "), { name: "Foo", realm: "Area52" });
  assert.equal(parseFullName("NoRealm"), null);
  // non-ASCII character names survive
  assert.deepEqual(parseFullName("Ñightblade-Area52"), { name: "Ñightblade", realm: "Area52" });
});
