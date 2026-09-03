// app.js — DOM wiring for the KeyLevelLogs lookup page.
//
// Auth is zero-setup: the deploy workflow injects this site's Warcraft Logs
// client credentials (see config.js / .github/workflows/pages.yml), so
// visitors just paste names. An undeployed/unconfigured copy shows a clear
// notice instead of a setup flow.

import { parseEntriesInput, dedupeEntries, slugCandidates } from "./slugs.js";
import { getToken, listZones, guessMythicPlusZone, fetchCharactersParallel, WclError, DEFAULT_TOKEN_URL, DEFAULT_API_URL } from "./wcl.js";
import { playerFromResult, encounterByName, windowLevels, rolesWithRuns, buildRolePlayers, pickSelectedRole } from "./transform.js";
import { summaryHTML } from "./render.js";
import { embeddedCredentials } from "./config.js";
import { cacheKey, pruneCache, slimResult } from "./cache.js";
import { fetchScores, DEFAULT_RIO_URL } from "./rio.js";

const LEVEL_WINDOW = 4; // only key levels within ±4 of the target matter

const $ = (id) => document.getElementById(id);

const MISSING_CREDS_MSG =
  "this deployment has no Warcraft Logs credentials — the repo owner needs to "
  + "add the WCL_CLIENT_SECRET Actions secret and re-run the \"Deploy site\" workflow";

// localStorage keys (kllTokenUrl/kllApiUrl/kllRioUrl exist so tests — or a
// future proxy — can repoint the endpoints)
const LS = {
  token: "kllToken",
  tokenExpires: "kllTokenExpires",
  zoneCache: "kllZoneCache",
  charCache: "kllCharCache",
  region: "kllRegion",
  tokenUrl: "kllTokenUrl",
  apiUrl: "kllApiUrl",
  rioUrl: "kllRioUrl",
};

const rioEndpoint = () => localStorage.getItem(LS.rioUrl) || DEFAULT_RIO_URL;

// ------------------------------------------------- per-character cache

// bumping this discards every previously stored cache on the next visit
// (3: entries now also carry Raider.IO season scores)
const CHAR_CACHE_VERSION = 3;

function loadCharCache() {
  try {
    const box = JSON.parse(localStorage.getItem(LS.charCache) || "null");
    if (box?.v === CHAR_CACHE_VERSION && box.entries) return box.entries;
  } catch { /* corrupted: start over */ }
  return {};
}

function saveCharCache(entries) {
  try {
    localStorage.setItem(LS.charCache, JSON.stringify({ v: CHAR_CACHE_VERSION, entries }));
  } catch { /* quota full — the cache is just an optimization */ }
}

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

// A new season means a new zone id and a new dungeon list. Bumping this
// discards every stored season cache on the next visit; the short TTL then
// bounds how long the *next* rollover can serve a stale dungeon list
// without anyone shipping a deploy.
const ZONE_CACHE_VERSION = 2;
const ZONE_CACHE_TTL = 3 * 3600_000; // 3 hours

async function ensureZone(token, force) {
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS.zoneCache) || "null");
      if (cached?.v === ZONE_CACHE_VERSION && cached.until > Date.now() && cached.zone?.encounters?.length) {
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
  localStorage.setItem(LS.zoneCache, JSON.stringify({
    v: ZONE_CACHE_VERSION, until: Date.now() + ZONE_CACHE_TTL, zone: slim,
  }));
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

async function lookup(ev) {
  // Shift-click (or Ctrl+Shift+Enter) skips the hour cache for fresh data
  const skipCache = Boolean(ev?.shiftKey);
  const dropdownRegion = $("region").value;
  // a typed name and a pasted URL can be the same character — collapse them
  // now that the default region is known
  const parsed = dedupeEntries(parseEntriesInput($("names").value), dropdownRegion);
  if (parsed.length === 0) {
    setStatus("paste at least one Name-Realm or a Raider.IO / Armory / Warcraft Logs character link", true);
    return;
  }
  localStorage.setItem(LS.region, dropdownRegion);
  const level = Number($("level").value) || null;
  // unique per-character key: the same Name-Realm can legitimately appear
  // in two regions (two pasted URLs), so full alone is ambiguous
  const keyOf = (c) => `${c.full}@${c.region ?? dropdownRegion}`;
  const byKey = new Map(parsed.map((e) => [keyOf(e), e]));

  $("lookup").disabled = true;
  $("refresh").disabled = true;
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
    // slug (with retries) and use the dropdown region. Anyone looked up in
    // the last hour (this season) is served from the browser cache.
    const ctx = { token, ...endpoints() };
    const results = new Map();    // key -> result|null
    const slugs = new Map();      // key -> slug that resolved (or best guess)
    const regions = new Map();    // key -> region actually used
    const hpsResults = new Map(); // key -> hps result
    const rioScores = new Map();  // key -> Raider.IO season scores
    const now = Date.now();
    const cache = pruneCache(loadCharCache(), now);
    const fetchedKeys = [];
    let cachedCount = 0;
    let round = [];
    for (const c of parsed) {
      const reg = c.region ?? dropdownRegion;
      const k = keyOf(c);
      regions.set(k, reg);
      const hit = skipCache ? undefined : cache[cacheKey(zone.id, c.full, reg)];
      if (hit) {
        cachedCount++;
        results.set(k, hit.dps ?? null);
        slugs.set(k, hit.slug);
        if (hit.hps != null) hpsResults.set(k, hit.hps);
        if (hit.rio != null) rioScores.set(k, hit.rio);
        continue;
      }
      fetchedKeys.push(k);
      const candidates = c.slug ? [c.slug] : slugCandidates(c.realm);
      slugs.set(k, candidates[0]);
      round.push({ key: k, name: c.name, candidates, tried: 0, region: reg });
    }
    const perRequest = Math.max(1, Math.floor(16 / Math.max(1, zone.encounters.length)));
    while (round.length > 0) {
      const batch = round.map((c) => ({ ...c, serverSlug: c.candidates[c.tried] }));
      setStatus(`looking up ${batch.length} character(s)…${cachedCount ? ` (${cachedCount} cached)` : ""}`);
      // all requests for this round go out together
      const fetched = await fetchCharactersParallel(ctx, batch, zone.encounters, undefined, perRequest);
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

    // second pass: every run is judged by the role it was played in, and
    // healer runs are ranked on healing — fetch hps for any character with
    // healer-spec runs (not just detected healer mains: a tank who also
    // heals needs both sides). Cache hits already carry their hps side.
    const needHps = [...byKey.keys()].filter((k) =>
      !hpsResults.has(k) && rolesWithRuns(results.get(k) ?? null).has("healer"));
    // Mythic+ season scores come from Raider.IO (Warcraft Logs only sees
    // uploaded runs, so a score summed from its ranks undercounts). It runs
    // alongside the healing pass and can fail without costing us anything.
    const needRio = fetchedKeys.filter((k) => !rioScores.has(k));

    if (needHps.length > 0 || needRio.length > 0) {
      setStatus(needHps.length
        ? `fetching healing rankings for ${needHps.length} character(s)…`
        : "fetching Mythic+ scores…");
      const hpsBatch = needHps.map((k) => ({
        key: k, name: byKey.get(k).name,
        serverSlug: slugs.get(k), region: regions.get(k),
      }));
      const rioBatch = needRio.map((k) => {
        const c = byKey.get(k);
        // the slug that worked on WCL first, then the other spellings —
        // Raider.IO doesn't always agree with WCL on realm slugs
        const alts = c.slug ? [c.slug] : slugCandidates(c.realm);
        return {
          key: k, name: c.name, region: regions.get(k),
          slugs: [slugs.get(k), ...alts].filter(Boolean),
        };
      });
      const [hpsFetched, rioFetched] = await Promise.all([
        hpsBatch.length
          ? fetchCharactersParallel(ctx, hpsBatch, zone.encounters, "hps", perRequest)
          : [],
        fetchScores(rioBatch, { rioUrl: rioEndpoint() }),
      ]);
      for (const r of hpsFetched) hpsResults.set(r.key, r.result);
      for (const r of rioFetched) if (r.scores) rioScores.set(r.key, r.scores);
    }

    // remember what we just fetched: an hour per character, this season
    if (fetchedKeys.length > 0) {
      const fetched = new Set(fetchedKeys);
      for (const c of parsed) {
        const k = keyOf(c);
        if (!fetched.has(k)) continue;
        cache[cacheKey(zone.id, c.full, regions.get(k))] = {
          t: now,
          slug: slugs.get(k),
          dps: slimResult(results.get(k) ?? null),
          ...(hpsResults.has(k) && { hps: slimResult(hpsResults.get(k)) }),
          ...(rioScores.has(k) && { rio: rioScores.get(k) }),
        };
      }
      saveCharCache(pruneCache(cache, now));
    }

    const entries = parsed.map((c) => {
      const k = keyOf(c);
      const dpsResult = results.get(k) ?? null;
      const { detected, order, topKeys, byRole } = buildRolePlayers(dpsResult, hpsResults.get(k) ?? null);
      const windowed = {};
      for (const [role, p] of Object.entries(byRole)) {
        windowed[role] = windowLevels(p, level, LEVEL_WINDOW);
      }
      // default view: the lead role — unless the key-level window emptied
      // its table while another role still has visible runs. A role the
      // user picked by hand survives the next paste.
      const picked = chosenRole.get(k);
      const selected = (picked && windowed[picked]) ? picked : pickSelectedRole(order, windowed);
      return {
        fullName: c.full,
        key: k,
        detected, selected, sortRole: selected, order, topKeys, byRole: windowed,
        scores: rioScores.get(k) ?? null,
        // no per-role runs at all: unfiltered fallback keeps the old
        // "no M+ logs" / "no WCL character" rows working
        player: selected
          ? windowed[selected]
          : windowLevels(playerFromResult(dpsResult, detected), level, LEVEL_WINDOW),
        slug: slugs.get(k),
        region: regions.get(k),
      };
    });
    lastRender = { entries, level, encounter, encounters: zone.encounters };
    renderResults();

    // make the current lookup shareable (same format the addon generates);
    // original tokens are kept so pasted URLs keep their region/realm
    const share = new URLSearchParams({ region: dropdownRegion });
    if (level) share.set("level", String(level));
    if ($("dungeon").value) share.set("dungeon", $("dungeon").value);
    share.set("chars", parsed.map((e) => encodeURIComponent(e.token)).join(","));
    history.replaceState(null, "", location.pathname + "?" + share.toString());

    const windowNote = level ? ` · showing keys +${Math.max(2, level - LEVEL_WINDOW)}–+${level + LEVEL_WINDOW}` : "";
    setStatus(`done — ${entries.length} character(s) · ${zone.name}${windowNote} · click a row for details`);
    return true;
  } catch (e) {
    // a handled error still returns false: the caller must know this roster
    // was NOT successfully looked up, or re-pasting it would be skipped
    if (e instanceof WclError) { setStatus(e.message, true); return false; }
    setStatus("unexpected error: " + e.message, true);
    throw e;
  } finally {
    $("lookup").disabled = false;
    $("refresh").disabled = false;
  }
}

// last successful lookup, kept so role-chip clicks can re-render without
// refetching (all roles' tables are already built)
let lastRender = null;

// a role the user picked by clicking a chip, kept across re-lookups so a
// fresh paste doesn't undo their choice mid-vetting
const chosenRole = new Map(); // entry key -> role

function renderResults() {
  if (!lastRender) return;
  const open = new Set(
    [...document.querySelectorAll("tr.detail-row.open")].map((r) => r.dataset.key),
  );
  // the rebuild destroys the clicked chip: remember it to restore focus,
  // so keyboard users don't get dumped back to the top of the page
  const focused = document.activeElement?.closest?.("button.role[data-role]");
  const focusKey = focused ? `${focused.dataset.key} ${focused.dataset.role}` : null;
  $("results").innerHTML = summaryHTML(lastRender.entries, lastRender);
  for (const row of document.querySelectorAll("tr.detail-row")) {
    if (open.has(row.dataset.key)) row.classList.add("open");
  }
  wireRowToggles();
  wireRoleChips();
  if (focusKey) {
    for (const btn of document.querySelectorAll("button.role[data-role]")) {
      if (`${btn.dataset.key} ${btn.dataset.role}` === focusKey) {
        btn.focus();
        break;
      }
    }
  }
}

function wireRowToggles() {
  for (const row of document.querySelectorAll("tr.row")) {
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("a, button")) return; // profile link / role chip
      const detail = document.querySelector(`tr.detail-row[data-idx="${row.dataset.idx}"]`);
      if (detail) detail.classList.toggle("open");
    });
  }
}

// clicking a dimmed role chip re-judges that player as that role (their
// runs in it, ranked on the right metric); sort order stays put
function wireRoleChips() {
  for (const btn of document.querySelectorAll("button.role[data-role]")) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const entry = lastRender?.entries.find((e) => (e.key ?? e.fullName) === btn.dataset.key);
      const player = entry?.byRole?.[btn.dataset.role];
      if (!player) return;
      entry.selected = btn.dataset.role;
      entry.player = player;
      chosenRole.set(btn.dataset.key, btn.dataset.role);
      renderResults();
    });
  }
}

// ------------------------------------------------------- auto-lookup
//
// Under a live applicant wave the roster changes every few seconds, so
// pasting the new list should be the ONLY action: the lookup runs itself.
// Cached characters cost no request, so a re-paste of the whole list only
// fetches whoever is new.

const PASTE_DELAY = 150;   // a paste is a finished thought — go almost at once
const TYPING_DELAY = 900;  // typing isn't; wait for a half-written name to finish

let autoTimer = null;
let running = false;
let rerunQueued = false;
let lastSignature = null;

// What the current textarea resolves to, so we can skip a lookup that would
// ask for exactly what's already on screen.
function rosterSignature() {
  const region = $("region").value;
  return dedupeEntries(parseEntriesInput($("names").value), region)
    .map((e) => `${e.full}@${e.region ?? region}`)
    .join(",");
}

// One lookup at a time. A paste that lands mid-flight is never dropped — it
// re-runs as soon as the current pass finishes.
async function runLookup(ev) {
  if (running) { rerunQueued = true; return; }
  running = true;
  const attempted = rosterSignature();
  try {
    // only remember the roster once it actually worked — lookup() handles
    // its own errors and resolves either way, so a FAILED lookup (dropped
    // wifi, API blip) must not make re-pasting the same roster a no-op
    if (await lookup(ev)) lastSignature = attempted;
  } finally {
    running = false;
    if (rerunQueued) { rerunQueued = false; scheduleLookup(0); }
  }
}

function scheduleLookup(delay) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    // nothing new resolved (still mid-word, or the same roster re-pasted)
    if (rosterSignature() === lastSignature) return;
    if (!rosterSignature()) return;
    runLookup();
  }, delay);
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
  $("lookup").addEventListener("click", (e) => runLookup(e)); // keeps Shift = fresh data
  // an explicit fresh-data control: Shift-click doesn't exist on touch
  // devices, and share-link visits auto-run before you could hold Shift
  $("refresh").addEventListener("click", () => runLookup({ shiftKey: true }));
  $("names").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runLookup(e);
  });

  // pasting the roster IS the action — no click needed
  $("names").addEventListener("paste", () => scheduleLookup(PASTE_DELAY));

  // ...and you don't even have to click into the box first: Ctrl+V anywhere
  // on the page replaces the roster and looks it up. This uses the paste
  // EVENT's own clipboardData, which needs no permission in any browser —
  // unlike navigator.clipboard.readText(), which is Chrome/Edge-only behind
  // a prompt. Saves a click and a Ctrl+A on every single wave.
  document.addEventListener("paste", (e) => {
    if (e.target?.closest?.("input, textarea")) return; // normal editing
    const text = e.clipboardData?.getData("text");
    if (!text || !text.trim()) return;
    e.preventDefault();
    $("names").value = text;
    scheduleLookup(PASTE_DELAY);
  });
  $("names").addEventListener("input", (e) => {
    // a paste fires input too; don't downgrade it to the typing delay
    if (e.inputType && e.inputType.startsWith("insertFromPaste")) return;
    scheduleLookup(TYPING_DELAY);
  });
  // changing the key level or dungeon re-judges everyone already loaded
  for (const id of ["level", "dungeon", "region"]) {
    $(id).addEventListener("change", () => { lastSignature = null; scheduleLookup(PASTE_DELAY); });
  }

  const hasChars = initFromParams();
  if (!embeddedCredentials()) {
    setStatus(MISSING_CREDS_MSG, true);
    return;
  }
  if (hasChars) {
    runLookup(); // arrived via the addon's Copy URL: run immediately
  } else {
    prefetchDungeons();
  }
}

init();
