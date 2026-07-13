// wcl.mjs — minimal Warcraft Logs v2 (GraphQL) client. No dependencies;
// `fetchImpl` is injectable for tests.
//
// Per-key-level data comes from character.encounterRankings(encounterID,
// byBracket: true): each entry in `ranks` carries bracketData = the keystone
// level of that run, so one query per dungeon yields every key level at once.
// (character.zoneRankings has NO integer bracket selector — only the
// byBracket boolean — so it cannot ask for "key level N" directly.)

const DEFAULT_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const DEFAULT_API_URL = "https://www.warcraftlogs.com/api/v2/client";

export class WclError extends Error {}

export async function getToken({ clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, fetchImpl = fetch }) {
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new WclError(`token request failed: HTTP ${res.status} ${await safeText(res)} — check clientId/clientSecret`);
  }
  const json = await res.json();
  if (!json.access_token) throw new WclError("token response missing access_token");
  return json.access_token;
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ""; }
}

export async function gql({ token, query, variables, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    throw new WclError("rate limited (HTTP 429) — the client allowance is 3600 points/hour; wait and re-run");
  }
  if (!res.ok) {
    throw new WclError(`GraphQL HTTP ${res.status}: ${await safeText(res)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    // partial data with per-field errors is fine (unknown characters etc.),
    // but surface the messages so a null result isn't misread as "not found"
    if (!json.data) {
      throw new WclError("GraphQL errors: " + json.errors.map((e) => e.message).join("; "));
    }
    console.warn("WCL API partial errors: " + json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

// --- zone discovery ---------------------------------------------------------

export const ZONES_QUERY = `
query {
  worldData {
    zones {
      id
      name
      frozen
      brackets { type min max bucket }
      encounters { id name }
      difficulties { id name }
      expansion { id name }
    }
  }
}`;

export async function listZones(ctx) {
  const data = await gql({ ...ctx, query: ZONES_QUERY });
  return data?.worldData?.zones ?? [];
}

export function isMythicPlusZone(z) {
  const bracketType = z?.brackets?.type ?? "";
  if (/keystone/i.test(bracketType)) return true;
  const diffs = z?.difficulties ?? [];
  if (diffs.some((d) => /mythic\+/i.test(d?.name ?? ""))) return true;
  return /mythic\+/i.test(z?.name ?? "");
}

// Current M+ zone: unfrozen keystone-bracket zone in the newest expansion,
// highest id wins; falls back to frozen ones if none are live.
export function guessMythicPlusZone(zones) {
  const mplus = zones.filter(isMythicPlusZone).filter((z) => !/ptr|beta/i.test(z.name ?? ""));
  if (mplus.length === 0) return null;
  const score = (z) => (z.frozen ? 0 : 1e9) + (z.expansion?.id ?? 0) * 1e4 + (z.id ?? 0);
  mplus.sort((a, b) => score(b) - score(a));
  return mplus[0];
}

// --- character rankings -----------------------------------------------------

// One aliased query fetching encounterRankings for several characters across
// all of a zone's dungeons. `chars`: [{ name, serverSlug, region }],
// `encounters`: [{ id }]. Alias eNNN = encounter id.
export function buildCharacterQuery(chars, encounters, metric) {
  const parts = [];
  chars.forEach((c, i) => {
    const rankings = encounters
      .map((e) => `    e${e.id}: encounterRankings(encounterID: ${e.id}, metric: ${metric}, byBracket: true)`)
      .join("\n");
    parts.push(
      `  c${i}: character(name: ${JSON.stringify(c.name)}, serverSlug: ${JSON.stringify(c.serverSlug)}, serverRegion: ${JSON.stringify(c.region)}) {
    classID
${rankings}
  }`);
  });
  return `query {\n  characterData {\n${parts.join("\n")}\n  }\n}`;
}

export async function fetchCharacters(ctx, chars, encounters, metric) {
  if (chars.length === 0) return [];
  const query = buildCharacterQuery(chars, encounters, metric);
  const data = await gql({ ...ctx, query });
  const cd = data?.characterData ?? {};
  return chars.map((c, i) => ({ ...c, result: cd[`c${i}`] ?? null }));
}
