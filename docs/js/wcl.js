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

// Warcraft Logs answers one client's requests in parallel, but past about a
// dozen in flight each one only waits longer (measured on cold runs: 8
// single-run requests finish in 2.0 s, 16 in 3.2 s), so the site keeps a
// ceiling and queues the rest.
export const MAX_IN_FLIGHT = 12;
let inFlight = 0;
const waiting = [];
async function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return; }
  await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
}
function release() {
  inFlight--;
  const next = waiting.shift();
  if (next) next();
}
export const inFlightCount = () => inFlight;

export async function gql({ token, query, apiUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  await acquire();
  try {
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
  } finally {
    release();
  }
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
// which query is decided in fit.js by the no-repeat rule (see
// design/baselines-from-wowlogs.md §1): events are always live (nobody
// else fetches them), tables only for runs the wowlogs store will never
// hold.

const s = (v) => JSON.stringify(v);
export const idsExpr = (ids) => `ability.id in (${[...ids].map(Number).filter(Number.isFinite).join(",")})`;

// items: [{ code, fightID, kickIds: Set, dangerousIds: Set|null, tables: bool }]
// part: "all" (one request holds everything), "events" (the fight plus the
// event streams: deaths for the alive check, interrupts, the applicant's
// kick casts, the dangerous enemy casts) or "tables" (the fight, the
// actors, the player details, Summary + Interrupts + Dispels). WCL works through one
// request's fields one after the other, so a run that needs both halves is
// faster as two requests in flight.
export function buildRunBundleQuery(items, part = "all") {
  const wantEvents = part !== "tables";
  const wantTables = part !== "events";
  const parts = items.map((it, i) => {
    const F = `fightIDs: [${Number(it.fightID)}]`;
    const lines = [
      `fights(${F}) { id name startTime endTime keystoneLevel keystoneTime keystoneBonus friendlyPlayers }`,
    ];
    if (wantTables) {
      lines.push(`masterData { actors(type: "Player") { id name subType server } }`);
      lines.push(`playerDetails(${F})`);
    }
    if (wantEvents) {
      lines.push(`deaths: events(${F}, dataType: Deaths, hostilityType: Friendlies, limit: 200) { data }`);
      lines.push(`ints: events(${F}, dataType: Interrupts, hostilityType: Friendlies, limit: 5000) { data }`);
      if (it.kickIds?.size) {
        lines.push(`kick: events(${F}, dataType: Casts, hostilityType: Friendlies, filterExpression: ${s(idsExpr(it.kickIds))}, limit: 10000) { data }`);
      }
      if (it.dangerousIds?.size) {
        lines.push(`begin: events(${F}, dataType: Casts, hostilityType: Enemies, filterExpression: ${s(`${idsExpr(it.dangerousIds)} and (type = "begincast" or type = "cast")`)}, limit: 10000) { data }`);
      }
    }
    if (wantTables && it.tables) {
      lines.push(`summary: table(${F}, dataType: Summary)`);
      lines.push(`interrupts: table(${F}, dataType: Interrupts)`);
      lines.push(`dispels: table(${F}, dataType: Dispels)`);
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
  for (const k of ["summary", "interrupts", "dispels"]) if (node[k]) tables[k] = node[k];
  return {
    fight, actors, playerDetails: pd,
    events: {
      deaths: ev(node.deaths),
      kickCasts: ev(node.kick),
      begin: node.begin ? ev(node.begin) : null,
      interrupts: ev(node.ints),
    },
    tables: Object.keys(tables).length ? tables : null,
  };
}

// One run per request, every request in flight together: WCL answers the
// fields of one request one after the other, so four runs in one request
// took 4.3 s where four single-run requests took 2.0 s (cold). A run that
// also needs its tables goes as two requests (events | tables) whose report
// nodes are merged before parsing.
export async function fetchRunBundles(ctx, items, perRequest = 1) {
  const chunks = [];
  for (let i = 0; i < items.length; i += perRequest) chunks.push(items.slice(i, i + perRequest));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const parts = perRequest === 1 && chunk[0].tables ? ["events", "tables"] : ["all"];
    const nodes = await Promise.all(parts.map(async (part) => (await gql({ ...ctx, query: buildRunBundleQuery(chunk, part) }))?.reportData ?? {}));
    return chunk.map((it, i) => {
      const found = nodes.map((rd) => rd[`r${i}`]).filter(Boolean);
      return { ...it, bundle: parseRunBundle(found.length ? Object.assign({}, ...found) : null) };
    });
  }));
  return results.flat();
}
