// rio.js — Mythic+ season scores from Raider.IO.
//
// Why a second source: Warcraft Logs only knows about runs someone
// *uploaded*, so a score summed from WCL ranks undercounts badly (a real
// case: 2432 from logs vs 3249.5 actual — a quarter missing). Raider.IO
// carries Blizzard's own rating, so scores come from here and Key %
// stays with Warcraft Logs.
//
// The API sends CORS headers (it echoes the Origin), so the static site
// can call it straight from the browser like it does the WCL API.
//
// Everything here fails soft: Raider.IO being slow, rate-limiting, or not
// knowing a character must never cost you the Warcraft Logs data.

export const DEFAULT_RIO_URL = "https://raider.io/api/v1/characters/profile";

// "current:previous" is colon-CHAINED on purpose. Repeating the field
// (…by_season:a,…by_season:b) silently returns only one of them, which
// looks exactly like "this character has no score this season". Chaining
// also means no season slug is ever hardcoded, so a new season needs no
// deploy.
export const SEASON_FIELDS = "mythic_plus_scores_by_season:current:previous";

export function buildProfileURL({ name, slug, region }, rioUrl = DEFAULT_RIO_URL) {
  const q = new URLSearchParams({ region, realm: slug, name, fields: SEASON_FIELDS });
  return `${rioUrl}?${q}`;
}

// "season-mn-2" -> "S2". Unrecognized shapes keep the raw slug so a label
// is never silently wrong.
export function seasonLabel(slug) {
  const m = /-(\d+)$/.exec(String(slug ?? ""));
  return m ? `S${m[1]}` : String(slug ?? "");
}

// Raider.IO tints each score with its tier colour. It's injected into
// markup, so only accept a plain hex colour.
export function safeColor(c) {
  return /^#[0-9a-f]{3,8}$/i.test(String(c ?? "")) ? String(c) : null;
}

// -> [{ slug, label, all, tank, healer, dps, color }], newest season first.
// Seasons the character never played come back as zeros; those are dropped
// so the row shows nothing rather than a misleading "0".
export function parseScores(json) {
  const out = [];
  for (const s of json?.mythic_plus_scores_by_season ?? []) {
    const sc = s?.scores ?? {};
    const all = Number(sc.all) || 0;
    if (all <= 0) continue;
    out.push({
      slug: s.season,
      label: seasonLabel(s.season),
      all,
      tank: Number(sc.tank) || 0,
      healer: Number(sc.healer) || 0,
      dps: Number(sc.dps) || 0,
      color: safeColor(s?.segments?.all?.color),
    });
  }
  return out;
}

// One character's scores, or null for "no scores to show" (unknown
// character, network trouble, rate limit — all the same to the caller).
//
// Raider.IO and Warcraft Logs don't always spell a realm the same way
// ("area-52" vs "area52"), so the slug that resolved on WCL is only the
// first guess: on a miss the remaining candidates are tried before giving
// up. char.slugs (ordered) wins over char.slug.
export async function fetchCharacterScores(char, { rioUrl = DEFAULT_RIO_URL, fetchImpl = fetch } = {}) {
  const candidates = [...new Set([...(char.slugs ?? []), char.slug].filter(Boolean))];
  for (const slug of candidates) {
    try {
      const res = await fetchImpl(buildProfileURL({ ...char, slug }, rioUrl), { headers: { accept: "application/json" } });
      if (!res.ok) continue; // 400/404 = wrong slug or not on Raider.IO, 429 = rate limited
      const scores = parseScores(await res.json());
      if (scores.length) return scores;
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

// All characters at once — one small request each, fired together.
export async function fetchScores(chars, opts = {}) {
  return Promise.all(chars.map(async (c) => ({ key: c.key, scores: await fetchCharacterScores(c, opts) })));
}
