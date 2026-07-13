// dungeon_maps.mjs — in-game MapChallengeMode IDs by (simplified) dungeon
// name. Used to stamp challengeMapID into Data.lua so the addon can match
// your keystone to a WCL encounter without relying on name matching.
// The addon falls back to name matching for anything missing here, so an
// out-of-date table degrades gracefully.
//
// Sources: MapChallengeMode DB2 (wago.tools) + Raider.IO static data.

export function simplifyName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const RAW = {
  // Midnight Season 1 (live as of 2026-07)
  "Windrunner Spire": 557,
  "Maisara Caverns": 560,
  "Magisters' Terrace": 558,
  "Nexus-Point Xenas": 559,
  "Algeth'ar Academy": 402,
  "Seat of the Triumvirate": 239,
  "Skyreach": 161,
  "Pit of Saron": 556,
  // Midnight Season 2 (announced)
  "Altar of Fangs": 588,
  "Den of Nalorakk": 586,
  "Murder Row": 587,
  "The Blinding Vale": 584,
  "Voidscar Arena": 585,
  "Kings' Rest": 249,
  "Ruby Life Pools": 399,
  "Temple of Sethraliss": 250,
  // The War Within seasons (for older logs/zones)
  "Ara-Kara, City of Echoes": 503,
  "City of Threads": 502,
  "The Stonevault": 501,
  "The Dawnbreaker": 505,
  "Cinderbrew Meadery": 506,
  "Darkflame Cleft": 504,
  "Priory of the Sacred Flame": 499,
  "The Rookery": 500,
  "Operation: Floodgate": 525,
  "Eco-Dome Al'dani": 542,
  "Halls of Atonement": 378,
  "Tazavesh: Streets of Wonder": 391,
  "Tazavesh: So'leah's Gambit": 392,
  "Mists of Tirna Scithe": 375,
  "The Necrotic Wake": 376,
  "Theater of Pain": 382,
  "Operation: Mechagon - Workshop": 370,
  "The MOTHERLODE!!": 247,
  "Grim Batol": 507,
  "Siege of Boralus": 353,
};

const BY_SIMPLIFIED = new Map(
  Object.entries(RAW).map(([name, id]) => [simplifyName(name), id]),
);

// extras: user-supplied { "Dungeon Name": id } from config
export function challengeMapIDFor(dungeonName, extras = {}) {
  const key = simplifyName(dungeonName);
  for (const [name, id] of Object.entries(extras)) {
    if (simplifyName(name) === key) return id;
  }
  return BY_SIMPLIFIED.get(key);
}
