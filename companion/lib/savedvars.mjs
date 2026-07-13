// savedvars.mjs — pull applicant names out of the game's SavedVariables file
// (WTF/Account/<acct>/SavedVariables/KeyLevelLogs.lua) without a Lua runtime.
// The file is Blizzard-serialized Lua; we only need the seenApplicants keys
// and their lastSeen values, so a tolerant scanner is enough.

// Returns [{ name, lastSeen }] sorted by lastSeen desc.
export function extractSeenApplicants(luaText) {
  const anchor = luaText.indexOf('["seenApplicants"]');
  if (anchor === -1) return [];
  const braceStart = luaText.indexOf("{", anchor);
  if (braceStart === -1) return [];

  // capture the balanced { ... } block
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < luaText.length; i++) {
    const ch = luaText[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = luaText.slice(braceStart, end + 1);

  // entries look like: ["Name-Realm"] = { ["lastSeen"] = 1234, ["class"] = "MAGE" }
  const out = [];
  const entryRe = /\["([^"]+)"\]\s*=\s*\{([^{}]*)\}/g;
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    const name = m[1];
    if (!name.includes("-")) continue; // defensive: keys are Name-Realm
    const lastSeenMatch = /\["lastSeen"\]\s*=\s*(\d+)/.exec(m[2]);
    out.push({ name, lastSeen: lastSeenMatch ? Number(lastSeenMatch[1]) : 0 });
  }
  out.sort((a, b) => b.lastSeen - a.lastSeen);
  return out;
}

// Filter to names seen within the last `hours` (0 or undefined = no filter).
export function recentNames(entries, hours, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!hours) return entries.map((e) => e.name);
  const cutoff = nowSeconds - hours * 3600;
  return entries.filter((e) => e.lastSeen >= cutoff).map((e) => e.name);
}
