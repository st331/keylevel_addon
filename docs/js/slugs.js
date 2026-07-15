// slugs.js — turn a WoW *normalized* realm name (as the addon exports it,
// e.g. "Area52", "TwistingNether", "Kiljaeden") into candidate Warcraft Logs
// server slugs, most likely first. WCL slugs are lowercase and use dashes at
// word boundaries ("area-52", "twisting-nether") but plain concatenation for
// realms whose display name has no space ("kiljaeden").

export function slugCandidates(normalizedRealm, overrides = {}) {
  const override = overrides[normalizedRealm];
  const out = [];
  if (override) out.push(override.toLowerCase());

  // split at lower->Upper and letter<->digit boundaries: "TwistingNether"
  // -> "twisting-nether", "Area52" -> "area-52"
  const dashed = normalizedRealm
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])(\d)/g, "$1-$2")
    .replace(/(\d)([A-Za-z])/g, "$1-$2")
    .toLowerCase();
  const plain = normalizedRealm.toLowerCase();

  for (const c of [dashed, plain]) {
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// "Name-Realm" -> { name, realm } ; bare names are rejected.
export function parseFullName(full) {
  const m = /^([^-]+)-(.+)$/.exec(full.trim());
  if (!m) return null;
  return { name: m[1], realm: m[2] };
}

const REGIONS = new Set(["us", "eu", "kr", "tw", "cn"]);

// "area-52" -> "Area52", "twisting-nether" -> "TwistingNether"
export function slugToNormalizedRealm(slug) {
  return String(slug).split("-").map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join("");
}

function capName(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

// Character page URLs from Raider.IO, the WoW Armory, or Warcraft Logs ->
// { name, slug, region } (slug/region are exact, no guessing needed).
export function parseCharacterURL(token) {
  const patterns = [
    /raider\.io\/characters\/([a-z]{2})\/([^/?#]+)\/([^/?#]+)/i,
    /worldofwarcraft\.(?:blizzard\.)?com\/[a-z]{2}-[a-z]{2}\/character\/([a-z]{2})\/([^/?#]+)\/([^/?#]+)/i,
    /warcraftlogs\.com\/character\/([a-z]{2})\/([^/?#]+)\/([^/?#]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(String(token));
    if (!m) continue;
    const region = m[1].toLowerCase();
    if (!REGIONS.has(region)) return null;
    let name = m[3];
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    name = capName(name.trim());
    if (!name) return null;
    return { name, slug: m[2].toLowerCase(), region };
  }
  return null;
}

// Free-form pasted text (or the ?chars= param) -> entries. Each line/token
// is either "Name-Realm" (region comes from the dropdown) or a character
// URL (slug + region come from the URL and win over the dropdown).
//   { token, full, name, realm? }               for typed names
//   { token, full, name, slug, region }         for URLs
export function parseEntriesInput(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    let entry = null;
    const url = parseCharacterURL(token);
    if (url) {
      entry = { token, full: `${url.name}-${slugToNormalizedRealm(url.slug)}`, ...url };
    } else if (token.includes("-") && !token.includes("/")) {
      const p = parseFullName(token);
      if (p) entry = { token, full: token, name: p.name, realm: p.realm };
    }
    if (entry) {
      const key = `${entry.full}@${entry.region ?? ""}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}

// Drop entries that resolve to the same character once the default region
// is known: a typed "Foo-Area52" and a pasted URL for the same character
// carry different region hints at parse time (none vs explicit), so
// parseEntriesInput alone can't collapse them.
export function dedupeEntries(entries, defaultRegion) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = `${e.full}@${e.region ?? defaultRegion ?? ""}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

// Back-compat helper: just the resolved full names.
export function parseNamesInput(text) {
  return parseEntriesInput(text).map((e) => e.full);
}
