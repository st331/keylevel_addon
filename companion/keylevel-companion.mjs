#!/usr/bin/env node
// keylevel-companion — fetches Warcraft Logs M+ percentiles per key level and
// writes them into the KeyLevelLogs addon's Data.lua.
//
//   node keylevel-companion.mjs init
//   node keylevel-companion.mjs zones
//   node keylevel-companion.mjs fetch --names "Foo-Area52,Bar-TwistingNether"
//   node keylevel-companion.mjs fetch --sv "<WTF path>/SavedVariables/KeyLevelLogs.lua"
//   node keylevel-companion.mjs watch --sv "<...>/KeyLevelLogs.lua"
//   node keylevel-companion.mjs probe --names "Foo-Area52"   (dump raw API response)
//
// See README.md for setup (WCL API client id/secret).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getToken, listZones, guessMythicPlusZone, fetchCharacters, buildCharacterQuery, gql, WclError } from "./lib/wcl.mjs";
import { slugCandidates, parseFullName } from "./lib/slugs.mjs";
import { playersFromResults, buildDungeonsTable, mergeModel } from "./lib/transform.mjs";
import { generateDataLua } from "./lib/luagen.mjs";
import { extractSeenApplicants, recentNames } from "./lib/savedvars.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------- config

const CONFIG_TEMPLATE = {
  clientId: "env:WCL_CLIENT_ID",
  clientSecret: "env:WCL_CLIENT_SECRET",
  region: "us",
  zoneID: null,
  metric: "playerscore",
  outPath: "../KeyLevelLogs/Data.lua",
  dbPath: "keylevel-db.json",
  realmSlugs: {},
  challengeMapIDs: {},
};

// numeric option with validation ( --recent 24 )
function numArg(args, key, def) {
  if (args[key] === undefined) return def;
  const n = Number(args[key]);
  if (!Number.isFinite(n) || args[key] === true) die(`--${key} needs a number`);
  return n;
}

function configPathFrom(args) {
  if (args.config !== undefined && typeof args.config !== "string") {
    die("--config needs a path");
  }
  return path.resolve(args.config ?? path.join(HERE, "config.json"));
}

function loadConfig(args) {
  const configPath = configPathFrom(args);
  if (!fs.existsSync(configPath)) {
    die(`no config at ${configPath} — run: node keylevel-companion.mjs init`);
  }
  const cfg = { ...CONFIG_TEMPLATE, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  cfg._dir = path.dirname(configPath);
  for (const key of ["clientId", "clientSecret"]) {
    if (typeof cfg[key] === "string" && cfg[key].startsWith("env:")) {
      cfg[key] = process.env[cfg[key].slice(4)] ?? "";
    }
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    die("clientId/clientSecret missing — put them in config.json or export WCL_CLIENT_ID / WCL_CLIENT_SECRET (create a client at https://www.warcraftlogs.com/api/clients/)");
  }
  return cfg;
}

function die(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- db cache

function loadDb(cfg) {
  const p = path.resolve(cfg._dir, cfg.dbPath);
  let parsed = null;
  if (fs.existsSync(p)) {
    try { parsed = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* corrupt -> fresh */ }
  }
  // tolerate hand-edited / partial db files: merge over the skeleton
  return {
    model: {
      meta: parsed?.model?.meta ?? {},
      dungeons: parsed?.model?.dungeons ?? {},
      players: parsed?.model?.players ?? {},
    },
    realmSlugCache: parsed?.realmSlugCache ?? {},
    zoneCache: parsed?.zoneCache ?? null,
  };
}

function saveDb(cfg, db) {
  const p = path.resolve(cfg._dir, cfg.dbPath);
  fs.writeFileSync(p, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------- commands

async function cmdInit(args) {
  const p = configPathFrom(args);
  if (fs.existsSync(p)) die(`config already exists: ${p}`);
  fs.writeFileSync(p, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n");
  console.log(`wrote ${p}`);
  console.log("1) create an API client at https://www.warcraftlogs.com/api/clients/");
  console.log("2) put clientId/clientSecret in config.json (or export WCL_CLIENT_ID/WCL_CLIENT_SECRET)");
  console.log("3) set outPath to your WoW folder: .../Interface/AddOns/KeyLevelLogs/Data.lua");
}

async function cmdZones(cfg) {
  const token = await getToken(cfg);
  const zones = await listZones({ token, apiUrl: cfg.apiUrl });
  for (const z of zones) {
    const b = z.brackets ?? {};
    if (!/keystone|item level/i.test(b.type ?? "") && !/mythic\+/i.test(z.name ?? "")) continue;
    console.log(`${String(z.id).padStart(5)}  ${z.name}  [${z.expansion?.name ?? "?"}]  brackets: ${b.type ?? "?"} min=${b.min} max=${b.max}${z.frozen ? "  (frozen)" : ""}`);
  }
  const guess = guessMythicPlusZone(zones);
  if (guess) console.log(`\nauto-detected current M+ zone: ${guess.id} (${guess.name}) — set "zoneID" in config.json to override`);
}

function resolveNames(cfg, args) {
  let names = [];
  if (args.names) {
    names = String(args.names).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  } else if (args.sv) {
    const text = fs.readFileSync(path.resolve(args.sv), "utf8");
    const entries = extractSeenApplicants(text);
    const hours = numArg(args, "recent", 24);
    names = recentNames(entries, hours);
    console.log(`SavedVariables: ${entries.length} known applicants, ${names.length} seen in the last ${hours}h`);
  } else if (Array.isArray(cfg.names)) {
    names = cfg.names;
  }
  const parsed = [];
  for (const n of names) {
    const p = parseFullName(n);
    if (!p) console.warn(`skipping '${n}' — expected Name-Realm`);
    else parsed.push({ full: n, ...p });
  }
  return parsed;
}

async function resolveZone(cfg, ctx, db, args) {
  if (db.zoneCache && !args["refresh-zone"] && (!cfg.zoneID || db.zoneCache.id === cfg.zoneID)) {
    return db.zoneCache;
  }
  const zones = await listZones(ctx);
  const zone = cfg.zoneID ? zones.find((z) => z.id === cfg.zoneID) : guessMythicPlusZone(zones);
  // WclError, not die(): watch mode must survive fetch-path failures
  if (!zone) throw new WclError(cfg.zoneID ? `zone ${cfg.zoneID} not found` : "could not auto-detect the current M+ zone — run 'zones' and set zoneID in config.json");
  db.zoneCache = { id: zone.id, name: zone.name, encounters: zone.encounters ?? [] };
  console.log(`zone: ${zone.id} (${zone.name}), ${db.zoneCache.encounters.length} dungeons`);
  return db.zoneCache;
}

// slug-retrying batched fetch; returns [{key, name, realm, serverSlug, result}]
async function fetchWithSlugRetry(cfg, ctx, db, chars, encounters) {
  const pending = chars.map((c) => {
    const candidates = slugCandidates(c.realm, cfg.realmSlugs ?? {});
    const cached = db.realmSlugCache[c.realm];
    if (cached) {
      const i = candidates.indexOf(cached);
      if (i >= 0) candidates.splice(i, 1);
      candidates.unshift(cached);
    }
    return { key: c.full, name: c.name, realm: c.realm, candidates, tried: 0, region: cfg.region };
  });

  // ~16 encounterRankings sub-queries per request
  const perRequest = Math.max(1, Math.floor(16 / Math.max(1, encounters.length)));
  const found = [];
  let round = pending;
  while (round.length > 0) {
    const batch = round.map((c) => ({ ...c, serverSlug: c.candidates[c.tried] }));
    const results = [];
    for (let i = 0; i < batch.length; i += perRequest) {
      const chunk = batch.slice(i, i + perRequest);
      results.push(...await fetchCharacters(ctx, chunk, encounters, cfg.metric ?? "playerscore"));
    }
    const nextRound = [];
    for (const r of results) {
      if (r.result) {
        db.realmSlugCache[r.realm] = r.serverSlug;
        found.push(r);
      } else if (r.tried + 1 < r.candidates.length) {
        nextRound.push({ ...r, tried: r.tried + 1, result: null });
      } else {
        console.warn(`not found on WCL: ${r.key} (tried slugs: ${r.candidates.join(", ")})`);
        found.push({ ...r, result: null }); // recorded as missing in the data file
      }
    }
    round = nextRound;
  }
  return found;
}

function writeDataLua(cfg, db) {
  const outPath = path.resolve(cfg._dir, cfg.outPath);
  fs.writeFileSync(outPath, generateDataLua(db.model));
  return outPath;
}

async function fetchOnce(cfg, args) {
  const chars = resolveNames(cfg, args);
  if (chars.length === 0) {
    if (args.sv) {
      // normal in watch mode / fresh installs: nothing to do yet
      console.log("no applicants to fetch yet — waiting");
      return;
    }
    throw new WclError("no names to fetch — pass --names \"Foo-Area52,...\" or --sv <SavedVariables/KeyLevelLogs.lua>");
  }

  const db = loadDb(cfg);

  // players fetched recently are fresh enough; --max-age 0 or --force refetches
  const maxAgeMin = numArg(args, "max-age", 30);
  let toFetch = chars;
  if (!args.force && maxAgeMin > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeMin * 60;
    toFetch = chars.filter((c) => {
      const p = db.model.players[c.full];
      return !(p && typeof p.updated === "number" && p.updated >= cutoff);
    });
    const skipped = chars.length - toFetch.length;
    if (skipped > 0) console.log(`skipped ${skipped} character(s) fetched within the last ${maxAgeMin}m (--force to refetch)`);
  }
  if (toFetch.length === 0) {
    const outPath = writeDataLua(cfg, db); // keep Data.lua in sync anyway
    console.log(`nothing new to fetch — ${outPath} is current`);
    return;
  }
  console.log(`fetching ${toFetch.length} character(s) ...`);

  const token = await getToken(cfg);
  const ctx = { token, apiUrl: cfg.apiUrl };
  const zone = await resolveZone(cfg, ctx, db, args);
  if (zone.encounters.length === 0) throw new WclError(`zone ${zone.id} lists no encounters — try --refresh-zone`);

  const found = await fetchWithSlugRetry(cfg, ctx, db, toFetch, zone.encounters);

  const now = Math.floor(Date.now() / 1000);
  const { players } = playersFromResults(found, now);
  const dungeons = buildDungeonsTable(zone.encounters, cfg.challengeMapIDs ?? {});

  db.model = mergeModel(db.model, {
    meta: {
      generatedAt: new Date(now * 1000).toISOString(),
      region: cfg.region,
      zoneID: zone.id,
      zoneName: zone.name,
      metric: cfg.metric ?? "playerscore",
    },
    dungeons,
    players,
  });
  saveDb(cfg, db);
  const outPath = writeDataLua(cfg, db);

  for (const c of toFetch) {
    const p = db.model.players[c.full];
    if (!p || p.missing) { console.log(`  ${c.full}: no WCL character found`); continue; }
    const lvls = Object.keys(p.levels).map(Number).sort((a, b) => a - b);
    console.log(`  ${c.full}: logged key levels: ${lvls.length ? lvls.map((l) => "+" + l).join(" ") : "(none)"}`);
  }
  console.log(`wrote ${outPath} (${Object.keys(db.model.players).length} player(s) total) — /reload in game to pick it up`);
}

async function cmdWatch(cfg, args) {
  if (!args.sv || args.sv === true) die("watch needs --sv <path to SavedVariables/KeyLevelLogs.lua>");
  const svPath = path.resolve(args.sv);
  const interval = Math.max(2, numArg(args, "interval", 15));
  console.log(`watching ${svPath} (checking every ${interval}s)`);
  console.log("flow: /reload in game -> companion fetches -> /reload again to see the data");
  let lastMtime = 0;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const st = fs.statSync(svPath);
      if (st.mtimeMs > lastMtime) {
        // commit the mtime only after a successful fetch, so a transient
        // failure (429, network) retries on the next tick
        await fetchOnce(cfg, args);
        lastMtime = st.mtimeMs;
      }
    } catch (e) {
      if (e.code !== "ENOENT") console.error("watch error:", e.message);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, interval * 1000);
}

// Dump one raw character response — for verifying the API shape.
async function cmdProbe(cfg, args) {
  const chars = resolveNames(cfg, args);
  if (chars.length === 0) die("probe needs --names \"Foo-Realm\"");
  const token = await getToken(cfg);
  const ctx = { token, apiUrl: cfg.apiUrl };
  const db = loadDb(cfg);
  const zone = await resolveZone(cfg, ctx, db, args);
  const c = chars[0];
  const slug = slugCandidates(c.realm, cfg.realmSlugs ?? {})[0];
  const query = buildCharacterQuery(
    [{ name: c.name, serverSlug: slug, region: cfg.region }],
    zone.encounters.slice(0, 2),
    cfg.metric ?? "playerscore",
  );
  console.log("--- query ---\n" + query + "\n--- response ---");
  const data = await gql({ ...ctx, query });
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "help";

try {
  if (cmd === "init") await cmdInit(args);
  else if (cmd === "zones") await cmdZones(loadConfig(args));
  else if (cmd === "fetch") await fetchOnce(loadConfig(args), args);
  else if (cmd === "watch") await cmdWatch(loadConfig(args), args);
  else if (cmd === "probe") await cmdProbe(loadConfig(args), args);
  else {
    console.log(`usage: node keylevel-companion.mjs <command>

commands:
  init                       write a starter config.json
  zones                      list WCL dungeon zones (find/verify zoneID)
  fetch --names "A-R,B-R"    fetch these characters (all key levels at once)
  fetch --sv <path>          fetch applicants recorded by the addon
                             (--recent <hours>, default 24)
  watch --sv <path>          auto-fetch whenever the game writes SavedVariables
                             (--interval <seconds>, default 15)
  probe --names "A-R"        dump one raw API response (debugging)

common options:
  --config <path>            config file (default: companion/config.json)
  --refresh-zone             re-query the zone/dungeon list
  --max-age <minutes>        skip players fetched more recently (default 30)
  --force                    refetch even recently-fetched players`);
  }
} catch (e) {
  if (e instanceof WclError) die(e.message);
  throw e;
}
