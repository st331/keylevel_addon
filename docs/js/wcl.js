// wcl.js — browser client for the Warcraft Logs v2 GraphQL API.
// Endpoints are injectable (tests point them at a fake server).

export const DEFAULT_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
export const DEFAULT_AUTH_URL = "https://www.warcraftlogs.com/oauth/authorize";
export const DEFAULT_API_URL = "https://www.warcraftlogs.com/api/v2/client";

export class WclError extends Error {}

// --- PKCE ("Public Client") flow: no secret exists anywhere -----------------

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function makeVerifier(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += UNRESERVED[b % UNRESERVED.length];
  return out;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// S256 code challenge (base64url of the SHA-256 digest, no padding)
export async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export function buildAuthorizeURL({ authUrl = DEFAULT_AUTH_URL, clientId, redirectUri, state, challenge }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${authUrl}?${p}`;
}

async function tokenPost(tokenUrl, params, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new WclError("could not reach the Warcraft Logs token endpoint (network/CORS): " + e.message);
  }
  if (!res.ok) throw new WclError(`Warcraft Logs sign-in failed (HTTP ${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new WclError("token response missing access_token");
  return {
    token: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

// authorization code -> tokens (code_verifier sent plain, per WCL docs)
export function exchangeCode({ tokenUrl = DEFAULT_TOKEN_URL, clientId, code, redirectUri, verifier, fetchImpl = fetch }) {
  return tokenPost(tokenUrl, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, fetchImpl);
}

export function refreshTokens({ tokenUrl = DEFAULT_TOKEN_URL, clientId, refreshToken, fetchImpl = fetch }) {
  return tokenPost(tokenUrl, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  }, fetchImpl);
}

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
export function buildCharacterQuery(chars, encounters, metric = "playerscore") {
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
