import { test } from "node:test";
import assert from "node:assert/strict";
import { slugCandidates, parseFullName, parseNamesInput } from "../docs/js/slugs.js";

test("single-word realm", () => {
  assert.deepEqual(slugCandidates("Sargeras"), ["sargeras"]);
});

test("camel-case realm gets dashed candidate first", () => {
  assert.deepEqual(slugCandidates("TwistingNether"), ["twisting-nether", "twistingnether"]);
});

test("digit boundary", () => {
  assert.deepEqual(slugCandidates("Area52"), ["area-52", "area52"]);
});

test("override wins", () => {
  assert.deepEqual(slugCandidates("MalGanis", { MalGanis: "mal-ganis" }), ["mal-ganis", "malganis"]);
});

test("parseFullName", () => {
  assert.deepEqual(parseFullName("Foo-Area52"), { name: "Foo", realm: "Area52" });
  assert.equal(parseFullName("NoRealm"), null);
  assert.deepEqual(parseFullName("Ñightblade-Area52"), { name: "Ñightblade", realm: "Area52" });
});

test("parseNamesInput handles lines, commas, dupes, junk", () => {
  const input = "Foo-Area52\nBar-TwistingNether, Foo-Area52;  baz\n  Qux-Sargeras  ";
  assert.deepEqual(parseNamesInput(input), ["Foo-Area52", "Bar-TwistingNether", "Qux-Sargeras"]);
  assert.deepEqual(parseNamesInput(""), []);
  assert.deepEqual(parseNamesInput(null), []);
});
