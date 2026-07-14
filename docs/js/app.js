// app.js — DOM wiring for the KeyLevelLogs lookup page.
//
// Auth: primary flow is Warcraft Logs "Public Client" PKCE — visitors click
// Connect once and sign in with their own (free) WCL account. No secret
// exists anywhere. A manual client-id/secret mode remains as an advanced
// fallback (credentials stay in that browser's localStorage).

import { parseNamesInput, parseFullName, slugCandidates } from "./slugs.js";
import {
  getToken, listZones, guessMythicPlusZone, fetchCharacters, WclError,
  makeVerifier, challengeFromVerifier, buildAuthorizeURL, exchangeCode, refreshTokens,
  DEFAULT_TOKEN_URL, DEFAULT_AUTH_URL, DEFAULT_API_URL,
} from "./wcl.js";
import { playerFromResult, encounterByName } from "./transform.js";
import { summaryHTML } from "./render.js";
import { EMBEDDED_CLIENT_ID, embeddedCredentials } from "./config.js";

const $ = (id) => document.getElementById(id);

// The "MPlus Dashboard" WCL API client id (public identifier; also used for
// the PKCE fallback when no secret was injected at deploy time).
const DEFAULT_CLIENT_ID = EMBEDDED_CLIENT_ID;

// localStorage keys (kllTokenUrl/kllAuthUrl/kllApiUrl exist so tests — or a
// future proxy — can repoint the endpoints)
const LS = {
  clientId: "kllClientId",
  clientSecret: "kllClientSecret",
  token: "kllToken",
  tokenExpires: "kllTokenExpires",
  refreshToken: "kllRefreshToken",
  zoneCache: "kllZoneCache",
  region: "kllRegion",
  tokenUrl: "kllTokenUrl",
  authUrl: "kllAuthUrl",
  apiUrl: "kllApiUrl",
};
// sessionStorage keys for the OAuth round-trip
const SS = { verifier: "kllVerifier", state: "kllOAuthState", pendingQuery: "kllPendingQuery" };

const endpoints = () => ({
  tokenUrl: localStorage.getItem(LS.tokenUrl) || DEFAULT_TOKEN_URL,
  authUrl: localStorage.getItem(LS.authUrl) || DEFAULT_AUTH_URL,
  apiUrl: localStorage.getItem(LS.apiUrl) || DEFAULT_API_URL,
});

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = isError ? "status error" : "status";
}

// ---------------------------------------------------------------- auth

function storeTokens({ token, refreshToken, expiresAt }) {
  localStorage.setItem(LS.token, token);
  localStorage.setItem(LS.tokenExpires, String(expiresAt));
  if (refreshToken) localStorage.setItem(LS.refreshToken, refreshToken);
}

function clearTokens() {
  for (const k of [LS.token, LS.tokenExpires, LS.refreshToken]) localStorage.removeItem(k);
}

function isConnected() {
  return Boolean(embeddedCredentials()
    || localStorage.getItem(LS.token) || localStorage.getItem(LS.refreshToken)
    || (localStorage.getItem(LS.clientId) && localStorage.getItem(LS.clientSecret)));
}

// The exact URI registered on the WCL client (origin + path, no query).
function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

async function connect() {
  // stash the addon-provided query so it survives the OAuth round-trip
  sessionStorage.setItem(SS.pendingQuery, location.search);
  const verifier = makeVerifier();
  const state = makeVerifier(32);
  sessionStorage.setItem(SS.verifier, verifier);
  sessionStorage.setItem(SS.state, state);
  const challenge = await challengeFromVerifier(verifier);
  location.href = buildAuthorizeURL({
    authUrl: endpoints().authUrl,
    clientId: DEFAULT_CLIENT_ID,
    redirectUri: redirectUri(),
    state,
    challenge,
  });
}

// Handles arriving back from warcraftlogs.com with ?code=...&state=...
// Returns true if a sign-in was completed.
async function handleOAuthReturn() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");
  if (!code) return false;

  const expected = sessionStorage.getItem(SS.state);
  const verifier = sessionStorage.getItem(SS.verifier);
  sessionStorage.removeItem(SS.state);
  sessionStorage.removeItem(SS.verifier);
  const pending = sessionStorage.getItem(SS.pendingQuery) ?? "";
  sessionStorage.removeItem(SS.pendingQuery);
  // restore the pre-signin URL either way
  history.replaceState(null, "", location.pathname + pending);

  if (!expected || p.get("state") !== expected || !verifier) {
    setStatus("sign-in state mismatch — please try Connect again", true);
    return false;
  }
  try {
    setStatus("finishing Warcraft Logs sign-in…");
    storeTokens(await exchangeCode({
      tokenUrl: endpoints().tokenUrl,
      clientId: DEFAULT_CLIENT_ID,
      code,
      redirectUri: redirectUri(),
      verifier,
    }));
    setStatus("connected to Warcraft Logs ✓");
    return true;
  } catch (e) {
    setStatus(e.message, true);
    return false;
  }
}

async function ensureToken(force) {
  const cached = localStorage.getItem(LS.token);
  const expires = Number(localStorage.getItem(LS.tokenExpires) || 0);
  if (!force && cached && Date.now() < expires - 60_000) return cached;

  const refresh = localStorage.getItem(LS.refreshToken);
  if (refresh) {
    try {
      const tokens = await refreshTokens({
        tokenUrl: endpoints().tokenUrl,
        clientId: DEFAULT_CLIENT_ID,
        refreshToken: refresh,
      });
      storeTokens(tokens);
      return tokens.token;
    } catch {
      clearTokens(); // fall through to other options
    }
  }

  // manual (advanced) credentials override the deploy-time embedded ones
  const manualId = localStorage.getItem(LS.clientId);
  const manualSecret = localStorage.getItem(LS.clientSecret);
  const creds = (manualId && manualSecret)
    ? { clientId: manualId, clientSecret: manualSecret }
    : embeddedCredentials();
  if (creds) {
    const { token, expiresAt } = await getToken({ ...creds, ...endpoints() });
    storeTokens({ token, expiresAt });
    return token;
  }

  if (cached && !force) return cached; // possibly still valid despite clock

  throw new WclError("not connected — click “Connect Warcraft Logs” above (one-time, free WCL account)");
}

// ---------------------------------------------------------------- zone

async function ensureZone(token, force) {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS.zoneCache) || "null");
      if (cached && cached.until > Date.now() && cached.zone?.encounters?.length) {
        return cached.zone;
      }
    } catch { /* re-fetch */ }
  }
  const zones = await listZones({ token, ...endpoints() });
  const zone = guessMythicPlusZone(zones);
  if (!zone || !(zone.encounters ?? []).length) {
    throw new WclError("could not find the current Mythic+ season zone on Warcraft Logs");
  }
  const slim = { id: zone.id, name: zone.name, encounters: zone.encounters };
  localStorage.setItem(LS.zoneCache, JSON.stringify({ until: Date.now() + 24 * 3600_000, zone: slim }));
  return slim;
}

function populateDungeonSelect(encounters, selected) {
  const sel = $("dungeon");
  const current = selected ?? sel.value;
  sel.innerHTML = `<option value="">(any / not sure)</option>`;
  for (const e of [...encounters].sort((a, b) => a.name.localeCompare(b.name))) {
    const opt = document.createElement("option");
    opt.value = e.name;
    opt.textContent = e.name;
    sel.appendChild(opt);
  }
  if (current) {
    const match = encounterByName(encounters, current);
    if (match) sel.value = match.name;
  }
}

// ---------------------------------------------------------------- lookup

async function lookup() {
  const names = parseNamesInput($("names").value);
  if (names.length === 0) {
    setStatus("paste at least one Name-Realm (the addon's Copy URL / Names button gives you these)", true);
    return;
  }
  const region = $("region").value;
  localStorage.setItem(LS.region, region);
  const level = Number($("level").value) || null;

  $("lookup").disabled = true;
  try {
    setStatus("authenticating…");
    let token = await ensureToken();

    setStatus("finding current season…");
    let zone;
    try {
      zone = await ensureZone(token);
    } catch (e) {
      if (/unauthorized/i.test(e.message)) { // stale cached token
        token = await ensureToken(true);
        zone = await ensureZone(token);
      } else {
        throw e;
      }
    }
    populateDungeonSelect(zone.encounters, $("dungeon").value);
    const encounter = encounterByName(zone.encounters, $("dungeon").value) ?? null;

    // characters: try most-likely realm slug, retry alternates for misses
    const ctx = { token, ...endpoints() };
    const chars = names
      .map((full) => ({ full, parsed: parseFullName(full) }))
      .filter((c) => c.parsed);
    const results = new Map(); // full -> result|null
    let round = chars.map((c) => ({
      key: c.full, name: c.parsed.name, realm: c.parsed.realm,
      candidates: slugCandidates(c.parsed.realm), tried: 0, region,
    }));
    const perRequest = Math.max(1, Math.floor(16 / Math.max(1, zone.encounters.length)));
    while (round.length > 0) {
      const batch = round.map((c) => ({ ...c, serverSlug: c.candidates[c.tried] }));
      setStatus(`looking up ${batch.length} character(s)…`);
      const fetched = [];
      for (let i = 0; i < batch.length; i += perRequest) {
        fetched.push(...await fetchCharacters(ctx, batch.slice(i, i + perRequest), zone.encounters));
      }
      const next = [];
      for (const r of fetched) {
        if (r.result) results.set(r.key, r.result);
        else if (r.tried + 1 < r.candidates.length) next.push({ ...r, tried: r.tried + 1 });
        else results.set(r.key, null);
      }
      round = next;
    }

    const entries = names.map((full) => ({ fullName: full, player: playerFromResult(results.get(full) ?? null) }));
    $("results").innerHTML = summaryHTML(entries, { level, encounter, encounters: zone.encounters });
    wireRowToggles();
    setStatus(`done — ${entries.length} character(s), season: ${zone.name}. Click a row for the full dungeon × level matrix.`);
  } catch (e) {
    if (e instanceof WclError) setStatus(e.message, true);
    else { setStatus("unexpected error: " + e.message, true); throw e; }
  } finally {
    $("lookup").disabled = false;
  }
}

function wireRowToggles() {
  for (const row of document.querySelectorAll("tr.row")) {
    row.addEventListener("click", () => {
      const detail = document.querySelector(`tr.detail-row[data-idx="${row.dataset.idx}"]`);
      if (detail) detail.classList.toggle("open");
    });
  }
}

// ---------------------------------------------------------------- setup

function refreshSetupState() {
  if (embeddedCredentials()) {
    $("creds-state").textContent = "ready — no setup needed ✓";
    $("setup").open = false;
    $("disconnect").style.display = "none";
    return;
  }
  const connected = isConnected();
  $("creds-state").textContent = connected ? "connected ✓" : "not connected";
  $("setup").open = !connected;
  $("disconnect").style.display = connected ? "" : "none";
  if (!localStorage.getItem(LS.clientId) && !$("client-id").value) {
    $("client-id").value = DEFAULT_CLIENT_ID;
  }
}

function saveCreds() {
  const id = $("client-id").value.trim();
  const secret = $("client-secret").value.trim();
  if (!id || !secret) {
    setStatus("both client id and client secret are needed for manual mode", true);
    return;
  }
  localStorage.setItem(LS.clientId, id);
  localStorage.setItem(LS.clientSecret, secret);
  clearTokens();
  $("client-secret").value = "";
  refreshSetupState();
  setStatus("credentials saved (locally in this browser only)");
}

function disconnect() {
  clearTokens();
  for (const k of [LS.clientId, LS.clientSecret]) localStorage.removeItem(k);
  refreshSetupState();
  setStatus("disconnected — tokens and credentials removed from this browser");
}

// ---------------------------------------------------------------- init

function initFromParams() {
  const p = new URLSearchParams(location.search);
  if (p.get("region")) $("region").value = p.get("region");
  else if (localStorage.getItem(LS.region)) $("region").value = localStorage.getItem(LS.region);
  if (p.get("level")) $("level").value = p.get("level");
  if (p.get("dungeon")) {
    // the select is empty until the first zone fetch; stash as a lone option
    const sel = $("dungeon");
    const opt = document.createElement("option");
    opt.value = p.get("dungeon");
    opt.textContent = p.get("dungeon");
    sel.appendChild(opt);
    sel.value = p.get("dungeon");
  }
  if (p.get("chars")) {
    $("names").value = p.get("chars").split(",").join("\n");
    return true;
  }
  return false;
}

export async function init() {
  $("lookup").addEventListener("click", lookup);
  $("connect").addEventListener("click", connect);
  $("save-creds").addEventListener("click", saveCreds);
  $("disconnect").addEventListener("click", disconnect);
  $("names").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) lookup();
  });

  await handleOAuthReturn(); // no-op unless arriving from warcraftlogs.com
  refreshSetupState();
  const hasChars = initFromParams();
  if (hasChars && isConnected()) {
    lookup(); // arrived via the addon's Copy URL: run immediately
  } else if (hasChars) {
    setStatus("names loaded — click “Connect Warcraft Logs” once, then Look up");
  }
}

init();
