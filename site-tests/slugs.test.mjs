import { test } from "node:test";
import assert from "node:assert/strict";
import { slugCandidates, parseFullName, parseNamesInput, parseCharacterURL, parseEntriesInput, slugToNormalizedRealm } from "../docs/js/slugs.js";

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

test("slugToNormalizedRealm", () => {
  assert.equal(slugToNormalizedRealm("area-52"), "Area52");
  assert.equal(slugToNormalizedRealm("twisting-nether"), "TwistingNether");
  assert.equal(slugToNormalizedRealm("kiljaeden"), "Kiljaeden");
});

test("parseCharacterURL: raider.io", () => {
  assert.deepEqual(
    parseCharacterURL("https://raider.io/characters/eu/twisting-nether/Eurodude"),
    { name: "Eurodude", slug: "twisting-nether", region: "eu" });
  assert.deepEqual(
    parseCharacterURL("https://raider.io/characters/us/area-52/foo?season=season-mn-1#raid"),
    { name: "Foo", slug: "area-52", region: "us" }, "query/fragment stripped, name capitalized");
});

test("parseCharacterURL: armory (current + legacy hosts, any locale)", () => {
  assert.deepEqual(
    parseCharacterURL("https://worldofwarcraft.blizzard.com/en-us/character/us/area-52/steelsdk"),
    { name: "Steelsdk", slug: "area-52", region: "us" });
  assert.deepEqual(
    parseCharacterURL("https://worldofwarcraft.blizzard.com/de-de/character/eu/kiljaeden/heiler"),
    { name: "Heiler", slug: "kiljaeden", region: "eu" });
  assert.deepEqual(
    parseCharacterURL("https://worldofwarcraft.com/en-gb/character/eu/silvermoon/steelsdk"),
    { name: "Steelsdk", slug: "silvermoon", region: "eu" });
});

test("parseCharacterURL: warcraftlogs + encoded names + rejects junk", () => {
  assert.deepEqual(
    parseCharacterURL("https://www.warcraftlogs.com/character/eu/silvermoon/Steelsdk"),
    { name: "Steelsdk", slug: "silvermoon", region: "eu" });
  assert.deepEqual(
    parseCharacterURL("https://raider.io/characters/us/area-52/%C3%B1ight"),
    { name: "Ñight", slug: "area-52", region: "us" }, "percent-encoded names decoded");
  assert.equal(parseCharacterURL("https://raider.io/characters/xx/area-52/foo"), null, "bad region");
  assert.equal(parseCharacterURL("https://raider.io/mythic-plus-rankings"), null);
  assert.equal(parseCharacterURL("Foo-Area52"), null);
});

test("parseEntriesInput mixes names and URLs, URL region wins", () => {
  const input = [
    "Foo-Area52",
    "https://raider.io/characters/eu/twisting-nether/Eurodude",
    "https://worldofwarcraft.blizzard.com/en-us/character/us/tichondrius/somedude",
    "Foo-Area52", // dupe
  ].join("\n");
  const entries = parseEntriesInput(input);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { token: "Foo-Area52", full: "Foo-Area52", name: "Foo", realm: "Area52" });
  assert.equal(entries[1].full, "Eurodude-TwistingNether");
  assert.equal(entries[1].slug, "twisting-nether");
  assert.equal(entries[1].region, "eu");
  assert.equal(entries[2].full, "Somedude-Tichondrius");
  assert.equal(entries[2].region, "us");
});
