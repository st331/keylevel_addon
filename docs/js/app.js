// app.js — DOM wiring for the KeyLevelLogs lookup page.

import { parseNamesInput, parseFullName, slugCandidates } from "./slugs.js";
import { getToken, listZones, guessMythicPlusZone, fetchCharacters, WclError, DEFAULT_TOKEN_URL, DEFAULT_API_URL } from "./wcl.js";
import { playerFromResult, encounterByName } from "./transform.js";
import { summaryHTML } from "./render.js";

const $ = (id) => document.getElementById(id);

// localStorage keys (kllTokenUrl/kllApiUrl exist so tests — or a future
// proxy — can repoint the endpoints)
const LS = {
  clientId: "kllClientId",
  clientSecret: "kllClientSecret",
  token: "kllToken",
  tokenExpires: "kllTokenExpires",
  zoneCache: "kllZoneCache",
  region: "kllRegion",
  tokenUrl: "kllTokenUrl",
  apiUrl: "kllApiUrl",
};

const endpoints = () => ({
  tokenUrl: localStorage.getItem(LS.tokenUrl) || DEFAULT_TOKEN_URL,
  apiUrl: localStorage.getItem(LS.apiUrl) || DEFAULT_API_URL,
});

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = isError ? "status error" : "status";
}

// ---------------------------------------------------------------- token

async function ensureToken(force) {
  const cached = localStorage.getItem(LS.token);
  const expires = Number(localStorage.getItem(LS.tokenExpires) || 0);
  if (!force && cached && Date.now() < expires - 60_000) return cached;

  const clientId = localStorage.getItem(LS.clientId);
  const clientSecret = localStorage.getItem(LS.clientSecret);
  if (!clientId || !clientSecret) {
    throw new WclError("no API credentials yet — open Setup below and paste your client id/secret");
  }
  const { token, expiresAt } = await getToken({ clientId, clientSecret, ...endpoints() });
  localStorage.setItem(LS.token, token);
  localStorage.setItem(LS.tokenExpires, String(expiresAt));
  return token;
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
  const have = localStorage.getItem(LS.clientId) && localStorage.getItem(LS.clientSecret);
  $("creds-state").textContent = have ? "credentials saved in this browser ✓" : "no credentials yet";
  $("setup").open = !have;
}

function saveCreds() {
  const id = $("client-id").value.trim();
  const secret = $("client-secret").value.trim();
  if (!id || !secret) {
    setStatus("both client id and client secret are needed", true);
    return;
  }
  localStorage.setItem(LS.clientId, id);
  localStorage.setItem(LS.clientSecret, secret);
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.tokenExpires);
  $("client-id").value = "";
  $("client-secret").value = "";
  refreshSetupState();
  setStatus("credentials saved (locally in this browser only)");
}

function forgetCreds() {
  for (const k of [LS.clientId, LS.clientSecret, LS.token, LS.tokenExpires]) {
    localStorage.removeItem(k);
  }
  refreshSetupState();
  setStatus("credentials forgotten");
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

export function init() {
  $("lookup").addEventListener("click", lookup);
  $("save-creds").addEventListener("click", saveCreds);
  $("forget-creds").addEventListener("click", forgetCreds);
  $("names").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) lookup();
  });
  refreshSetupState();
  const hasChars = initFromParams();
  const haveCreds = localStorage.getItem(LS.clientId) && localStorage.getItem(LS.clientSecret);
  if (hasChars && haveCreds) {
    lookup(); // arrived via the addon's Copy URL: run immediately
  } else if (hasChars) {
    setStatus("names loaded from the link — finish Setup once, then hit Look up");
  }
}

init();
