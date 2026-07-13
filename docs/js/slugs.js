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

// Free-form pasted text (or the ?chars= param) -> unique full names.
// Accepts commas, semicolons, whitespace/newlines as separators.
export function parseNamesInput(text) {
  const out = [];
  const seen = new Set();
  for (const piece of String(text ?? "").split(/[\s,;]+/)) {
    const trimmed = piece.trim();
    if (!trimmed || !trimmed.includes("-")) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}
