// wcl.js — browser client for the Warcraft Logs v2 GraphQL API.
// Endpoints are injectable (tests point them at a fake server).

export const DEFAULT_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
export const DEFAULT_API_URL = "https://www.warcraftlogs.com/api/v2/client";

export class WclError extends Error {}

// Client-credentials token using the user's own API client (id+secret live
// only in their browser's localStorage).
export async function getToken({ clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
  } catch (e) {
    throw new WclError(
      "could not reach the Warcraft Logs token endpoint from the browser "
      + "(network/CORS): " + e.message);
  }
  if (!res.ok) {
    throw new WclError(`token request failed (HTTP ${res.status}) — check your client id/secret`);
  }
  const json = await res.json();
  if (!json.access_token) throw new WclError("token response missing access_token");
  return { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

export async function gql({ token, query, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    throw new WclError("could not reach the Warcraft Logs API (network/CORS): " + e.message);
  }
  if (res.status === 401) throw new WclError("unauthorized — token expired or invalid; re-check credentials");
  if (res.status === 429) throw new WclError("rate limited by Warcraft Logs — wait a minute and retry");
  if (!res.ok) throw new WclError(`Warcraft Logs API returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length && !json.data) {
    throw new WclError("API errors: " + json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

export const ZONES_QUERY = `
query {
  worldData {
    zones {
      id
      name
      frozen
      brackets { type min max bucket }
      encounters { id name }
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
  return /mythic\+/i.test(z?.name ?? "");
}

// Current M+ zone: unfrozen keystone-bracket zone in the newest expansion.
export function guessMythicPlusZone(zones) {
  const mplus = zones.filter(isMythicPlusZone).filter((z) => !/ptr|beta/i.test(z.name ?? ""));
  if (mplus.length === 0) return null;
  const score = (z) => (z.frozen ? 0 : 1e9) + (z.expansion?.id ?? 0) * 1e4 + (z.id ?? 0);
  mplus.sort((a, b) => score(b) - score(a));
  return mplus[0];
}

// One aliased query fetching encounterRankings (byBracket: each rank carries
// bracketData = its keystone level) for several characters x all dungeons.
// metric dps + byBracket = the "Key %" column from a report's DPS tab.
export function buildCharacterQuery(chars, encounters, metric = "dps") {
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

// Split a big roster into perRequest-sized queries and fire them ALL at
// once — 20 applicants should cost about one round-trip of wall time,
// not ten sequential ones. Chunk order (and therefore character order)
// is preserved in the merged result.
export async function fetchCharactersParallel(ctx, chars, encounters, metric, perRequest) {
  const chunks = [];
  for (let i = 0; i < chars.length; i += perRequest) {
    chunks.push(chars.slice(i, i + perRequest));
  }
  const fetched = await Promise.all(
    chunks.map((chunk) => fetchCharacters(ctx, chunk, encounters, metric)),
  );
  return fetched.flat();
}

// ------------------------------------------------------------------
// Set B: per-run report data for the execution measures. Which run gets
// which query is decided in app.js by the no-repeat rule (see
// design/baselines-from-wowlogs.md §1): events are always live (nobody
// else fetches them), tables only for runs the wowlogs store will never
// hold.

const s = (v) => JSON.stringify(v);
export const idsExpr = (ids) => `ability.id in (${[...ids].map(Number).filter(Number.isFinite).join(",")})`;

// items: [{ code, fightID, kitIds: Set, dangerousIds: Set|null, avoidableIds: Set|null, tables: bool }]
export function buildRunBundleQuery(items) {
  const parts = items.map((it, i) => {
    const F = `fightIDs: [${Number(it.fightID)}]`;
    const lines = [
      `fights(${F}) { id name startTime endTime keystoneLevel keystoneTime keystoneBonus friendlyPlayers }`,
      `masterData { actors(type: "Player") { id name subType server } }`,
      `playerDetails(${F})`,
      `deaths: events(${F}, dataType: Deaths, hostilityType: Friendlies, limit: 200) { data }`,
      `low: events(${F}, dataType: DamageTaken, hostilityType: Friendlies, includeResources: true, filterExpression: ${s("resources.hpPercent < 35 and resources.maxHitPoints > 0")}, limit: 10000) { data }`,
      `ints: events(${F}, dataType: Interrupts, hostilityType: Friendlies, limit: 5000) { data }`,
    ];
    if (it.kitIds?.size) {
      lines.push(`kit: events(${F}, dataType: Casts, hostilityType: Friendlies, filterExpression: ${s(idsExpr(it.kitIds))}, limit: 10000) { data }`);
    }
    if (it.dangerousIds?.size) {
      lines.push(`begin: events(${F}, dataType: Casts, hostilityType: Enemies, filterExpression: ${s(`${idsExpr(it.dangerousIds)} and (type = "begincast" or type = "cast")`)}, limit: 10000) { data }`);
    }
    if (it.tables) {
      lines.push(`summary: table(${F}, dataType: Summary)`);
      lines.push(`interrupts: table(${F}, dataType: Interrupts)`);
      lines.push(`dispels: table(${F}, dataType: Dispels)`);
      if (it.avoidableIds?.size) lines.push(`dmgTaken: table(${F}, dataType: DamageTaken, filterExpression: ${s(idsExpr(it.avoidableIds))})`);
      if (it.kitIds?.size) lines.push(`casts: table(${F}, dataType: Casts, filterExpression: ${s(idsExpr(it.kitIds))})`);
      lines.push(`healing: table(${F}, dataType: Healing)`);
    }
    return `  r${i}: report(code: ${s(it.code)}) {\n    ${lines.join("\n    ")}\n  }`;
  });
  return `query {\n reportData {\n${parts.join("\n")}\n }\n}`;
}

const ev = (blob) => (Array.isArray(blob?.data) ? blob.data : []);

export function parseRunBundle(node) {
  if (!node) return null;
  const fight = node.fights?.[0] ?? null;
  const actors = node.masterData?.actors ?? [];
  const pd = node.playerDetails?.data?.playerDetails ?? node.playerDetails?.playerDetails ?? null;
  const tables = {};
  for (const k of ["summary", "interrupts", "dispels", "dmgTaken", "casts", "healing"]) if (node[k]) tables[k] = node[k];
  return {
    fight, actors, playerDetails: pd,
    events: {
      deaths: ev(node.deaths),
      low35: ev(node.low),
      kitCasts: ev(node.kit),
      begin: node.begin ? ev(node.begin) : null,
      interrupts: ev(node.ints),
    },
    tables: Object.keys(tables).length ? tables : null,
  };
}

// Several runs per request; all requests in flight together.
export async function fetchRunBundles(ctx, items, perRequest = 4) {
  const chunks = [];
  for (let i = 0; i < items.length; i += perRequest) chunks.push(items.slice(i, i + perRequest));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const data = await gql({ ...ctx, query: buildRunBundleQuery(chunk) });
    const rd = data?.reportData ?? {};
    return chunk.map((it, i) => ({ ...it, bundle: parseRunBundle(rd[`r${i}`]) }));
  }));
  return results.flat();
}

// ±10 s of party damage + healing around each own death, all in one
// request: 2 points per death.
// items: [{ code, fightID, deaths: [timestampMs...] }]
export function buildWindowsQuery(items) {
  const parts = [];
  items.forEach((it, i) => {
    const F = `fightIDs: [${Number(it.fightID)}]`;
    const lines = [];
    it.deaths.forEach((t, k) => {
      const win = `startTime: ${Math.floor(t) - 10_000}, endTime: ${Math.floor(t) + 5_000}`;
      lines.push(`d${k}: events(${F}, dataType: DamageTaken, hostilityType: Friendlies, includeResources: true, ${win}, limit: 5000) { data }`);
      lines.push(`h${k}: events(${F}, dataType: Healing, hostilityType: Friendlies, includeResources: true, ${win}, limit: 5000) { data }`);
    });
    if (lines.length) parts.push(`  r${i}: report(code: ${s(it.code)}) {\n    ${lines.join("\n    ")}\n  }`);
  });
  return parts.length ? `query {\n reportData {\n${parts.join("\n")}\n }\n}` : null;
}

export async function fetchWindows(ctx, items) {
  const wanted = items.filter((it) => it.deaths?.length);
  if (!wanted.length) return items.map((it) => ({ ...it, windows: {} }));
  const data = await gql({ ...ctx, query: buildWindowsQuery(wanted) });
  const rd = data?.reportData ?? {};
  const out = new Map();
  wanted.forEach((it, i) => {
    const node = rd[`r${i}`] ?? {};
    const windows = {};
    it.deaths.forEach((_, k) => { windows[k] = { dmg: ev(node[`d${k}`]), heal: ev(node[`h${k}`]) }; });
    out.set(`${it.code}:${it.fightID}`, windows);
  });
  return items.map((it) => ({ ...it, windows: out.get(`${it.code}:${it.fightID}`) ?? {} }));
}

// The healer's own healing stream (every heal she landed, with the
// target's HP), paged. Only for a healer applicant, on a few runs.
export async function fetchHealerStream(ctx, { code, fightID, healerId }, maxPages = 3) {
  const all = [];
  let startTime = null;
  for (let page = 0; page < maxPages; page++) {
    const st = startTime === null ? "" : `, startTime: ${Math.floor(startTime)}`;
    const query = `query { reportData { report(code: ${s(code)}) { heal: events(fightIDs: [${Number(fightID)}], dataType: Healing, sourceID: ${Number(healerId)}, includeResources: true, limit: 10000${st}) { data nextPageTimestamp } } } }`;
    const data = await gql({ ...ctx, query });
    const blob = data?.reportData?.report?.heal;
    all.push(...ev(blob));
    if (!blob?.nextPageTimestamp) break;
    startTime = blob.nextPageTimestamp;
  }
  return all;
}
