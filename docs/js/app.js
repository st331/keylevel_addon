// app.js — DOM wiring for the KeyLevelLogs lookup page.
//
// Auth is zero-setup: the deploy workflow injects this site's Warcraft Logs
// client credentials (see config.js / .github/workflows/pages.yml), so
// visitors just paste names. An undeployed/unconfigured copy shows a clear
// notice instead of a setup flow.

import { parseEntriesInput, slugCandidates } from "./slugs.js";
import { getToken, listZones, guessMythicPlusZone, fetchCharacters, WclError, DEFAULT_TOKEN_URL, DEFAULT_API_URL } from "./wcl.js";
import { playerFromResult, encounterByName, windowLevels, detectRole, hasRanks } from "./transform.js";
import { summaryHTML } from "./render.js";
import { embeddedCredentials } from "./config.js";

const LEVEL_WINDOW = 4; // only key levels within ±4 of the target matter

const $ = (id) => document.getElementById(id);

const MISSING_CREDS_MSG =
  "this deployment has no Warcraft Logs credentials — the repo owner needs to "
  + "add the WCL_CLIENT_SECRET Actions secret and re-run the \"Deploy site\" workflow";

// localStorage keys (kllTokenUrl/kllApiUrl exist so tests — or a future
// proxy — can repoint the endpoints)
const LS = {
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
  const creds = embeddedCredentials();
  if (!creds) throw new WclError(MISSING_CREDS_MSG);

  const cached = localStorage.getItem(LS.token);
  const expires = Number(localStorage.getItem(LS.tokenExpires) || 0);
  if (!force && cached && Date.now() < expires - 60_000) return cached;

  const { token, expiresAt } = await getToken({ ...creds, ...endpoints() });
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
  const parsed = parseEntriesInput($("names").value);
  if (parsed.length === 0) {
    setStatus("paste at least one Name-Realm or a Raider.IO / Armory / Warcraft Logs character link", true);
    return;
  }
  const dropdownRegion = $("region").value;
  localStorage.setItem(LS.region, dropdownRegion);
  const level = Number($("level").value) || null;
  const names = parsed.map((e) => e.full);
  const byFull = new Map(parsed.map((e) => [e.full, e]));

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

    // characters: URLs carry an exact slug + region; typed names guess the
    // slug (with retries) and use the dropdown region
    const ctx = { token, ...endpoints() };
    const results = new Map(); // full -> result|null
    const slugs = new Map();   // full -> slug that resolved (or best guess)
    const regions = new Map(); // full -> region actually used
    let round = parsed.map((c) => {
      const reg = c.region ?? dropdownRegion;
      regions.set(c.full, reg);
      const candidates = c.slug ? [c.slug] : slugCandidates(c.realm);
      slugs.set(c.full, candidates[0]);
      return { key: c.full, name: c.name, candidates, tried: 0, region: reg };
    });
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
        if (r.result) {
          results.set(r.key, r.result);
          slugs.set(r.key, r.serverSlug);
        } else if (r.tried + 1 < r.candidates.length) {
          next.push({ ...r, tried: r.tried + 1 });
        } else {
          results.set(r.key, null);
        }
      }
      round = next;
    }

    // second pass: healers are judged on healing — refetch theirs with hps
    const roles = new Map(); // full -> detected role (from the dps pass)
    const healers = [];
    for (const full of names) {
      const role = detectRole(results.get(full) ?? null);
      if (role) roles.set(full, role);
      if (role === "healer") healers.push(full);
    }
    if (healers.length > 0) {
      setStatus(`fetching healing rankings for ${healers.length} healer(s)…`);
      const batch = healers.map((full) => ({
        key: full, name: byFull.get(full).name,
        serverSlug: slugs.get(full), region: regions.get(full),
      }));
      for (let i = 0; i < batch.length; i += perRequest) {
        const fetched = await fetchCharacters(ctx, batch.slice(i, i + perRequest), zone.encounters, "hps");
        for (const r of fetched) {
          // keep dps numbers if the hps result is unexpectedly empty
          if (hasRanks(r.result)) results.set(r.key, r.result);
        }
      }
    }

    const entries = names.map((full) => ({
      fullName: full,
      player: windowLevels(playerFromResult(results.get(full) ?? null, roles.get(full)), level, LEVEL_WINDOW),
      slug: slugs.get(full),
      region: regions.get(full),
    }));
    $("results").innerHTML = summaryHTML(entries, { level, encounter, encounters: zone.encounters });
    wireRowToggles();

    // make the current lookup shareable (same format the addon generates);
    // original tokens are kept so pasted URLs keep their region/realm
    const share = new URLSearchParams({ region: dropdownRegion });
    if (level) share.set("level", String(level));
    if ($("dungeon").value) share.set("dungeon", $("dungeon").value);
    share.set("chars", parsed.map((e) => encodeURIComponent(e.token)).join(","));
    history.replaceState(null, "", location.pathname + "?" + share.toString());

    const windowNote = level ? ` · showing keys +${Math.max(2, level - LEVEL_WINDOW)}–+${level + LEVEL_WINDOW}` : "";
    setStatus(`done — ${entries.length} character(s) · ${zone.name}${windowNote} · click a row for details`);
  } catch (e) {
    if (e instanceof WclError) setStatus(e.message, true);
    else { setStatus("unexpected error: " + e.message, true); throw e; }
  } finally {
    $("lookup").disabled = false;
  }
}

function wireRowToggles() {
  for (const row of document.querySelectorAll("tr.row")) {
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return; // profile link, not a toggle
      const detail = document.querySelector(`tr.detail-row[data-idx="${row.dataset.idx}"]`);
      if (detail) detail.classList.toggle("open");
    });
  }
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
    // tokens may be individually encoded (URLs from the share link)
    $("names").value = p.get("chars").split(",").map((t) => {
      try { return decodeURIComponent(t); } catch { return t; }
    }).join("\n");
    return true;
  }
  return false;
}

// Fill the dungeon dropdown as soon as the page loads (uses the 24h zone
// cache after the first visit), so it never sits empty.
async function prefetchDungeons() {
  try {
    const token = await ensureToken();
    const zone = await ensureZone(token);
    populateDungeonSelect(zone.encounters, $("dungeon").value);
  } catch { /* the first Look up will surface any real problem */ }
}

export function init() {
  $("lookup").addEventListener("click", lookup);
  $("names").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) lookup();
  });

  const hasChars = initFromParams();
  if (!embeddedCredentials()) {
    setStatus(MISSING_CREDS_MSG, true);
    return;
  }
  if (hasChars) {
    lookup(); // arrived via the addon's Copy URL: run immediately
  } else {
    prefetchDungeons();
  }
}

init();
