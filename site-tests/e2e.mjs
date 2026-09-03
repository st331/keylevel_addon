// e2e.mjs — real-browser tests of the lookup site against a fake Warcraft
// Logs server. Run: node site-tests/e2e.mjs
// Scenario 1: deployed site (secret injected at deploy time) — zero setup.
// Scenario 2: unconfigured copy (no secret) — clear owner-facing notice.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".json": "application/json",
};

// --- static server for docs/ -------------------------------------------------
// injectSecret mimics the Pages deploy workflow: substitute the placeholder
// in config.js at serve time.
function startStatic({ injectSecret } = {}) {
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    let file = path.join(DOCS, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) {
      res.writeHead(404); res.end("nope"); return;
    }
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    let body = fs.readFileSync(file);
    if (injectSecret && urlPath.endsWith("config.js")) {
      body = Buffer.from(body.toString().replace("__WCL_CLIENT_SECRET__", injectSecret));
    }
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

// --- fake WCL ---------------------------------------------------------------
const AK = 12805, PIT = 10658;
const ZONES = {
  data: { worldData: { zones: [
    {
      id: 47, name: "Mythic+ Season 1", frozen: false,
      brackets: { type: "Keystone Level", min: 2, max: 25, bucket: 1 },
      encounters: [{ id: AK, name: "Windrunner Spire" }, { id: PIT, name: "Pit of Saron" }],
      expansion: { id: 11, name: "Midnight" },
    },
  ] } },
};

function characterResponse(query) {
  // Foo/Priestess/Switcher exist on slug area52 (forces one slug retry from
  // area-52); Ghost-Sargeras never exists. Priestess is a healer: weak dps
  // Key %, strong hps Key % — the site must detect her role and show the
  // hps side. Switcher is a role-switcher modeled on a real case: a pile of
  // old tank runs, then an exclusive switch to healing — recency must win,
  // and each run must be judged by the role it was played in.
  // Eurodude exists ONLY at slug twisting-nether in region EU (pasted as a
  // raider.io URL — exact slug + region, no dropdown, no retries).
  const isHps = /metric: hps/.test(query);
  const day = 86_400_000;
  // Switcher's top keys: AK's is Mistweaver (460 beats the Brewmasters),
  // PIT's is Brewmaster (only run) — one top key per role, and the recency
  // tie-break picks healer (all Mistweaver runs are fresh).
  const switcherRanks = isHps
    ? {
      // healing percentiles: the Mistweaver runs' real numbers, the
      // Brewmaster runs' garbage ones (must never be shown)
      [`e${AK}`]: { ranks: [
        { historicalPercent: 5.0, rankPercent: 5.0, bracketData: 12, amount: 20, spec: "Brewmaster", score: 400, startTime: Date.now() - 100 * day },
        { historicalPercent: 6.0, rankPercent: 6.0, bracketData: 12, amount: 21, spec: "Brewmaster", score: 405, startTime: Date.now() - 95 * day },
        { historicalPercent: 7.0, rankPercent: 7.0, bracketData: 12, amount: 22, spec: "Brewmaster", score: 410, startTime: Date.now() - 90 * day },
        { historicalPercent: 90.0, rankPercent: 90.0, bracketData: 12, amount: 620_000, spec: "Mistweaver", score: 450, startTime: Date.now() - 20 * day },
        { historicalPercent: 91.0, rankPercent: 91.0, bracketData: 12, amount: 630_000, spec: "Mistweaver", score: 460, startTime: Date.now() - 15 * day },
        { historicalPercent: 92.0, rankPercent: 92.0, bracketData: 12, amount: 640_000, spec: "Mistweaver", score: 455, startTime: Date.now() - 10 * day, report: { code: "HEALCODE1", fightID: 9 } },
      ] },
      [`e${PIT}`]: { ranks: [
        { historicalPercent: 4.0, rankPercent: 4.0, bracketData: 13, amount: 19, spec: "Brewmaster", score: 465, startTime: Date.now() - 85 * day },
      ] },
    }
    : {
      // damage percentiles: the Brewmaster runs' real numbers, the
      // Mistweaver runs' weak ones (healer dps — never shown either)
      [`e${AK}`]: { ranks: [
        { historicalPercent: 30.0, rankPercent: 30.0, bracketData: 12, amount: 300, spec: "Brewmaster", score: 400, startTime: Date.now() - 100 * day },
        { historicalPercent: 35.0, rankPercent: 35.0, bracketData: 12, amount: 310, spec: "Brewmaster", score: 405, startTime: Date.now() - 95 * day },
        { historicalPercent: 40.0, rankPercent: 40.0, bracketData: 12, amount: 320, spec: "Brewmaster", score: 410, startTime: Date.now() - 90 * day },
        { historicalPercent: 25.0, rankPercent: 25.0, bracketData: 12, amount: 100, spec: "Mistweaver", score: 450, startTime: Date.now() - 20 * day },
        { historicalPercent: 24.0, rankPercent: 24.0, bracketData: 12, amount: 105, spec: "Mistweaver", score: 460, startTime: Date.now() - 15 * day },
        { historicalPercent: 22.0, rankPercent: 22.0, bracketData: 12, amount: 110, spec: "Mistweaver", score: 455, startTime: Date.now() - 10 * day },
      ] },
      [`e${PIT}`]: { ranks: [
        { historicalPercent: 38.0, rankPercent: 38.0, bracketData: 13, amount: 130, spec: "Brewmaster", score: 465, startTime: Date.now() - 85 * day },
      ] },
    };
  const out = {};
  const charRe = /(c\d+): character\(name: "([^"]+)", serverSlug: "([^"]+)", serverRegion: "([^"]+)"/g;
  let m;
  while ((m = charRe.exec(query)) !== null) {
    const [, alias, name, slug, region] = m;
    if (name === "Eurodude" && slug === "twisting-nether" && region === "eu" && !isHps) {
      out[alias] = {
        classID: 11,
        [`e${AK}`]: { ranks: [{ historicalPercent: 95.0, rankPercent: 95.0, bracketData: 12, amount: 200, spec: "Arms", score: 450 }] },
        [`e${PIT}`]: { ranks: [] },
      };
    } else if (name === "Eurodude" && slug === "twisting-nether" && region === "us" && !isHps) {
      // same Name-Realm as the EU character but a DIFFERENT person in
      // another region — must get its own independent row/chips.
      // Multi-role: one top key each (AK Brewmaster, PIT Windwalker);
      // the fresher tank run wins the recency tie-break.
      out[alias] = {
        classID: 5,
        [`e${AK}`]: { ranks: [
          { historicalPercent: 55.0, rankPercent: 55.0, bracketData: 12, amount: 500, spec: "Brewmaster", score: 420, startTime: Date.now() - 5 * day },
        ] },
        [`e${PIT}`]: { ranks: [
          { historicalPercent: 45.0, rankPercent: 45.0, bracketData: 12, amount: 480, spec: "Windwalker", score: 400, startTime: Date.now() - 30 * day },
        ] },
      };
    } else if (name === "Switcher" && slug === "area52") {
      out[alias] = { classID: 5, ...switcherRanks };
    } else if (name === "Priestess" && slug === "area52") {
      out[alias] = {
        classID: 7,
        [`e${AK}`]: { ranks: [isHps
          ? { historicalPercent: 88.0, rankPercent: 88.0, bracketData: 12, amount: 999, spec: "Discipline", score: 400 }
          : { historicalPercent: 20.0, rankPercent: 20.0, bracketData: 12, amount: 50, spec: "Discipline", score: 400 },
        ] },
        [`e${PIT}`]: { ranks: [] },
      };
    } else if (name === "Foo" && slug === "area52" && !isHps) {
      // realistic shape: the site must show the HISTORICAL (at-the-time)
      // Key %, not today's drifted value; plus an API-duplicated run
      // amounts are realistic dps so the detail matrix's throughput line
      // exercises real formatting (1.25M / 990k), not toy integers
      out[alias] = {
        classID: 4,
        [`e${AK}`]: { ranks: [
          { historicalPercent: 91.2, rankPercent: 91.2, todayPercent: 85.0, bracketData: 12, amount: 1_250_000, spec: "Fire", startTime: Date.now() - 90 * 86_400_000, report: { code: "TESTCODE1", fightID: 7 } },
          { historicalPercent: 60.0, rankPercent: 60.0, todayPercent: 52.0, bracketData: 12, amount: 900_000, spec: "Fire" }, // second +12 run
          { historicalPercent: 60.0, rankPercent: 60.0, todayPercent: 52.0, bracketData: 12, amount: 900_000, spec: "Fire" }, // duplicate: must not skew avg
          { historicalPercent: 76.4, rankPercent: 76.4, todayPercent: 70.0, bracketData: 11, amount: 800_000, spec: "Fire" },
          { historicalPercent: 50.0, rankPercent: 50.0, todayPercent: 45.0, bracketData: 2, amount: 700_000, spec: "Fire" }, // outside the ±4 window at +12
        ] },
        [`e${PIT}`]: { ranks: [{ historicalPercent: 99.4, rankPercent: 99.4, todayPercent: 97.0, bracketData: 14, amount: 990_000, spec: "Fire" }] },
      };
    } else if (slug === "area52" && /^(Newguy|Racer\d)$/.test(name) && !isHps) {
      // stand-ins for the applicants that stream in while you are vetting
      out[alias] = {
        classID: 3,
        [`e${AK}`]: { ranks: [{ historicalPercent: 70.0, rankPercent: 70.0, bracketData: 12, amount: 700_000, spec: "Marksmanship", score: 400 }] },
        [`e${PIT}`]: { ranks: [] },
      };
    } else {
      out[alias] = null;
    }
  }
  return { data: { characterData: out } };
}

// --- fake Raider.IO --------------------------------------------------------
// Season scores come from Raider.IO because Warcraft Logs only sees uploaded
// runs. Foo has both seasons; Priestess only played last season; Switcher is
// unknown to Raider.IO (404) and must still render its Warcraft Logs data.
function startFakeRio() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const name = url.searchParams.get("name");
    state.requests.push({ name, fields: url.searchParams.get("fields"), realm: url.searchParams.get("realm"), region: url.searchParams.get("region") });
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("content-type", "application/json");
    const seasons = {
      Foo: [
        { season: "season-mn-2", scores: { all: 3515, tank: 0, healer: 0, dps: 3515 }, segments: { all: { color: "#ff8000" } } },
        { season: "season-mn-1", scores: { all: 4350.5, tank: 0, healer: 0, dps: 4350.5 }, segments: { all: { color: "#e268a8" } } },
      ],
      Priestess: [
        { season: "season-mn-2", scores: { all: 0, tank: 0, healer: 0, dps: 0 }, segments: { all: { color: "#ffffff" } } },
        { season: "season-mn-1", scores: { all: 2750, tank: 0, healer: 2750, dps: 0 }, segments: { all: { color: "#a335ee" } } },
      ],
    }[name];
    // Raider.IO knows this realm only as "area-52"; Warcraft Logs resolved
    // these characters at "area52", so the client must retry the other spelling
    if (url.searchParams.get("realm") === "area52") {
      res.writeHead(400); res.end(JSON.stringify({ statusCode: 400, error: "Bad Request" })); return;
    }
    if (!seasons) { res.writeHead(404); res.end(JSON.stringify({ statusCode: 404, error: "Not Found" })); return; }
    res.end(JSON.stringify({ name, mythic_plus_scores_by_season: seasons }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state, port: server.address().port })));
}

function startFakeWcl() {
  const state = { tokenRequests: 0, gqlRequests: 0, lastTokenAuth: null, lastTokenGrant: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // permissive CORS, mirroring the real API
      res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
      res.setHeader("access-control-allow-methods", "POST");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      res.setHeader("content-type", "application/json");

      if (new URL(req.url, "http://x").pathname === "/token") {
        state.tokenRequests++;
        state.lastTokenGrant = Object.fromEntries(new URLSearchParams(body));
        state.lastTokenAuth = req.headers.authorization ?? null;
        res.end(JSON.stringify({ access_token: "cc-token", expires_in: 3600 }));
        return;
      }
      state.gqlRequests++;
      const { query } = JSON.parse(body);
      if (!query.includes("worldData")) {
        state.lastCharQuery = query;
        (state.charQueries ??= []).push(query);
      }
      res.end(JSON.stringify(query.includes("worldData") ? ZONES : characterResponse(query)));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state, port: server.address().port })));
}

// --- harness ---------------------------------------------------------------
const bareSrv = await startStatic(); // repo copy: placeholder intact
const deployedSrv = await startStatic({ injectSecret: "e2e-injected-secret" });
const wcl = await startFakeWcl();
const rio = await startFakeRio();
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (e) {
    failed++;
    console.error("not ok - " + name + "\n  " + e.message);
  }
}

async function newPage() {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => { failed++; console.error("not ok - page error: " + e.message); });
  await page.addInitScript(({ tokenUrl, apiUrl, rioUrl }) => {
    localStorage.setItem("kllTokenUrl", tokenUrl);
    localStorage.setItem("kllApiUrl", apiUrl);
    localStorage.setItem("kllRioUrl", rioUrl);
  }, {
    tokenUrl: `http://127.0.0.1:${wcl.port}/token`,
    apiUrl: `http://127.0.0.1:${wcl.port}/gql`,
    rioUrl: `http://127.0.0.1:${rio.port}/profile`,
  });
  return page;
}

const RIO_URL = "https://raider.io/characters/eu/twisting-nether/Eurodude";
// the last token is an armory URL for Foo — the SAME character as the typed
// "Foo-Area52" once the us dropdown region applies; it must collapse to one row
const QUERY = `?region=us&level=12&dungeon=Windrunner%20Spire&chars=Foo-Area52,Priestess-Area52,Switcher-Area52,Ghost-Sargeras,https%3A%2F%2Fraider.io%2Fcharacters%2Feu%2Ftwisting-nether%2FEurodude,https%3A%2F%2Fworldofwarcraft.blizzard.com%2Fen-us%2Fcharacter%2Fus%2Farea-52%2Ffoo,https%3A%2F%2Fraider.io%2Fcharacters%2Fus%2Ftwisting-nether%2FEurodude`;

// ================= scenario 1: deployed site, zero setup ====================
try {
  {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${deployedSrv.port}/index.html${QUERY}`);

    await check("zero-setup: auto-runs with nothing stored in the browser", async () => {
      await page.waitForSelector("table.summary", { timeout: 10_000 });
    });

    await check("zero-setup: no setup UI exists on the page", async () => {
      assert.equal(await page.locator("#setup").count(), 0);
      assert.equal(await page.locator("#connect").count(), 0);
      assert.equal(await page.locator("#client-secret").count(), 0);
    });

    await check("controls prefilled from the addon URL", async () => {
      assert.equal(await page.inputValue("#level"), "12");
      assert.equal(await page.inputValue("#region"), "us");
      assert.match(await page.inputValue("#names"),
        /Foo-Area52\nPriestess-Area52\nSwitcher-Area52\nGhost-Sargeras\nhttps:\/\/raider\.io.*\nhttps:\/\/worldofwarcraft/);
      assert.equal(await page.inputValue("#dungeon"), "Windrunner Spire");
    });

    await check("used the deploy-injected embedded credentials", async () => {
      assert.equal(wcl.state.lastTokenGrant.grant_type, "client_credentials");
      const basic = Buffer.from(wcl.state.lastTokenAuth.replace(/^Basic /, ""), "base64").toString();
      const { EMBEDDED_CLIENT_ID } = await import("../docs/js/config.js");
      assert.equal(basic, `${EMBEDDED_CLIENT_ID}:e2e-injected-secret`, "embedded id + injected secret");
    });

    await check("results render (exact-level hit + missing character)", async () => {
      const cells = await page.locator("tr.row", { hasText: "Foo-Area52" }).locator("td").allInnerTexts();
      // any-dungeon cell: only AK logged at +12 (best 91.2) -> 91b 91a 91m (1 dungeon)
      assert.match(cells[1], /91b\s*91a\s*91m/, "b/a/m inline in the any-dungeon cell");
      assert.match(cells[1], /1 dungeon/);
      // this-dungeon cell: two +12 runs (91.2, 60) -> best 91, avg/med 76
      assert.match(cells[2], /91b\s*76a\s*76m/, "per-run b/a/m for the dungeon");
      assert.match(cells[2], /@\+12/);
      assert.match(cells[2], /· 3mo/, "best run's age shown");
      const ghost = await page.locator("tr.row", { hasText: "Ghost-Sargeras" }).innerText();
      assert.match(ghost, /no WCL character/);
    });

    await check("both seasons' Mythic+ scores show under the name", async () => {
      const row = page.locator("tr.row", { hasText: "Foo-Area52" });
      const text = await row.innerText();
      assert.match(text, /S2\s*3515/, "this season");
      assert.match(text, /S1\s*4351/, "last season, rounded");
      const req = rio.state.requests.find((r) => r.name === "Foo");
      assert.equal(req.fields, "mythic_plus_scores_by_season:current:previous",
        "one chained field — repeating it would drop a season");
      assert.equal(req.realm, "area52", "tries the slug that resolved on WCL first");
      const ok = rio.state.requests.filter((r) => r.name === "Foo" && r.realm === "area-52");
      assert.equal(ok.length, 1, "then falls back to Raider.IO's spelling");
      assert.equal(req.region, "us");
    });

    await check("a season the character never played is omitted, not shown as 0", async () => {
      const text = await page.locator("tr.row", { hasText: "Priestess-Area52" }).innerText();
      assert.match(text, /S1\s*2750/, "the season she played");
      assert.doesNotMatch(text, /S2\s*0\b/, "an unplayed season would read as 'terrible', not 'absent'");
    });

    await check("Raider.IO not knowing a character costs nothing", async () => {
      assert.ok(rio.state.requests.some((r) => r.name === "Switcher"), "we did ask");
      const row = page.locator("tr.row", { hasText: "Switcher-Area52" });
      assert.equal(await row.locator(".scores").count(), 0, "no score block");
      assert.match(await row.innerText(), /92b/, "but the Warcraft Logs data is intact");
    });

    await check("queries use the dps metric (Key %), not playerscore", async () => {
      assert.match(wcl.state.charQueries[0], /metric: dps, byBracket: true/);
      assert.ok(wcl.state.charQueries.every((q) => !/playerscore/.test(q)));
    });

    await check("healer detected: H chip + hps rankings shown", async () => {
      const row = page.locator("tr.row", { hasText: "Priestess-Area52" });
      assert.match(await row.innerHTML(), /role-healer/, "healer chip");
      const text = await row.innerText();
      assert.match(text, /88b/, "hps Key % shown");
      assert.doesNotMatch(text, /20b/, "dps Key % replaced");
      const fooRow = page.locator("tr.row", { hasText: "Foo-Area52" });
      assert.match(await fooRow.innerHTML(), /role-dps/, "dps chip on Foo");
      const hpsQueries = wcl.state.charQueries.filter((q) => /metric: hps/.test(q));
      assert.equal(hpsQueries.length, 1, "one batched hps refetch");
      assert.match(hpsQueries[0], /Priestess/);
      assert.match(hpsQueries[0], /Switcher/, "anyone with healer-spec runs is included");
      assert.doesNotMatch(hpsQueries[0], /Foo/, "dps players not refetched");
    });

    await check("raider.io URL: exact slug + URL region used, dropdown ignored", async () => {
      const row = page.locator('tr.row[data-key="Eurodude-TwistingNether@eu"]');
      assert.match(await row.innerText(), /95b/, "found via exact slug + eu region");
      assert.equal(await page.inputValue("#region"), "us", "dropdown still us");
      const tnQueries = wcl.state.charQueries.filter((q) => /twisting-nether/.test(q));
      assert.equal(tnQueries.length, 1, "exact slug: no retry rounds");
      assert.match(tnQueries[0], /serverRegion: "eu"/, "URL region used in the query");
      const href = await row.locator("a.wcl-link").getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/character/eu/twisting-nether/Eurodude");
    });

    await check("same Name-Realm in two regions = two independent rows", async () => {
      assert.equal(await page.locator("tr.row", { hasText: "Eurodude-TwistingNether" }).count(), 2);
      const usRow = page.locator('tr.row[data-key="Eurodude-TwistingNether@us"]');
      assert.match(await usRow.innerText(), /55b/, "US monk's tank Key % (its own data)");
      assert.match(await usRow.innerHTML(), /role-tank sel/, "1-1 top keys: fresher tank run wins the tie");
    });

    await check("chip click on a duplicate-name row targets THAT row only", async () => {
      await page.locator('tr.row[data-key="Eurodude-TwistingNether@us"] button.role.dim').click();
      const usRow = page.locator('tr.row[data-key="Eurodude-TwistingNether@us"]');
      assert.match(await usRow.innerText(), /45b/, "US row re-judged as dps");
      assert.match(await usRow.innerHTML(), /role-dps sel/);
      const euRow = page.locator('tr.row[data-key="Eurodude-TwistingNether@eu"]');
      assert.match(await euRow.innerText(), /95b/, "EU row untouched");
      // put it back so later checks see the default state
      await page.locator('tr.row[data-key="Eurodude-TwistingNether@us"] button.role.dim').click();
    });

    await check("share URL keeps the pasted link token", async () => {
      const url = new URL(page.url());
      assert.match(url.searchParams.get("chars"), /raider\.io/);
    });

    await check("no separate stats column exists", async () => {
      const head = await page.locator("table.summary thead").innerText();
      assert.doesNotMatch(head, /avg · med/i);
      assert.match(head, /any dungeon @\+12/i);
      const headers = await page.locator("table.summary > thead th").count();
      assert.equal(headers, 3, "three columns total");
    });

    await check("Foo sorts above Ghost", async () => {
      const names = await page.locator("tr.row .charname").allInnerTexts();
      assert.deepEqual(names, ["Eurodude-TwistingNether", "Switcher-Area52", "Foo-Area52", "Priestess-Area52", "Eurodude-TwistingNether", "Ghost-Sargeras"]);
    });

    await check("typed name + armory URL of the same character = one row", async () => {
      assert.equal(await page.locator("tr.row", { hasText: "Foo-Area52" }).count(), 1);
    });

    await check("clicking a row opens the dungeon × level matrix", async () => {
      await page.locator("tr.row", { hasText: "Foo-Area52" }).click();
      const text = await page.locator("tr.detail-row.open").innerText();
      assert.match(text, /Windrunner Spire/);
      assert.match(text, /Pit of Saron/);
      assert.match(text, /99%/, "the +14 pit run shows in the matrix");
    });

    await check("matrix percentiles link to their source report fight", async () => {
      const href = await page.locator("tr.detail-row.open a.runlink").first().getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/reports/TESTCODE1?fight=7&type=damage-done");
    });

    await check("matrix shows each run's actual DPS under its Key %", async () => {
      const text = await page.locator("tr.detail-row.open").innerText();
      assert.match(text, /1\.25M/, "the +12 Ara-Kara run's dps");
      assert.match(text, /990k/, "the +14 Pit run's dps");
      assert.match(text, /under it = DPS on that run/i, "legend explains the second number");
      const tip = await page.locator("tr.detail-row.open a.runlink").first().getAttribute("title");
      assert.match(tip, /1\.25M DPS/, "tooltip names the metric");
    });

    await check("matrix hides keys outside the ±4 window and shows avg/median", async () => {
      const text = await page.locator("tr.detail-row.open").innerText();
      assert.doesNotMatch(text, /\+2\b/, "the +2 log is outside +8..+16");
      assert.doesNotMatch(text, /50%/, "its percentile is gone too");
      assert.match(text, /average/i);
      assert.match(text, /median/i);
    });

    await check("status advertises the key window", async () => {
      assert.match(await page.locator("#status").innerText(), /\+8–\+16/);
    });

    await check("names link to the Warcraft Logs profile", async () => {
      const href = await page.locator("tr.row", { hasText: "Foo-Area52" })
        .locator("a.wcl-link").getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/character/us/area52/Foo");
    });

    await check("address bar reflects the current lookup (shareable)", async () => {
      const url = new URL(page.url());
      assert.equal(url.searchParams.get("level"), "12");
      assert.match(url.searchParams.get("chars"), /Foo-Area52/);
    });

    await check("role switcher: top-key holder leads, chips in top-key order", async () => {
      const row = page.locator("tr.row", { hasText: "Switcher-Area52" });
      const html = await row.innerHTML();
      assert.match(html, /button[^>]*role-healer sel/, "H chip solid: 1-1 top keys, fresher healer play wins");
      assert.match(html, /button[^>]*role-tank dim/, "T chip present but dimmed");
      assert.ok(html.indexOf("role-healer") < html.indexOf("role-tank"),
        "H before T — ordered by top keys + recency, not a fixed T/H/D order");
      assert.match(html, /holds 1 of their 2 top keys/, "tooltip carries the count");
      assert.doesNotMatch(html, /role-dps/, "never played dps -> no D chip");
      const text = await row.innerText();
      assert.match(text, /92b/, "healer runs shown with their hps Key %");
      assert.doesNotMatch(text, /40b/, "tank numbers not mixed in");
      assert.doesNotMatch(text, /25b|24b|22b/, "healer runs' dps percentiles never shown");
    });

    await check("clicking the dimmed T chip re-judges the row as a tank", async () => {
      const namesBefore = await page.locator("tr.row .charname").allInnerTexts();
      await page.locator("tr.row", { hasText: "Switcher-Area52" }).locator("button.role.dim").click();
      const row = page.locator("tr.row", { hasText: "Switcher-Area52" });
      assert.match(await row.innerHTML(), /button[^>]*role-tank sel/, "T chip now solid");
      const text = await row.innerText();
      assert.match(text, /40b/, "tank runs' dps Key % shown");
      assert.doesNotMatch(text, /92b/, "healer view replaced");
      assert.doesNotMatch(text, /7b/, "tank runs' hps percentiles never shown");
      const namesAfter = await page.locator("tr.row .charname").allInnerTexts();
      assert.deepEqual(namesAfter, namesBefore, "sort stays pinned to the detected role");
    });

    await check("chip click keeps keyboard focus on the chip", async () => {
      // the click re-render destroys and recreates the button; focus must follow
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.matches?.("button.role") ? `${el.dataset.key} ${el.dataset.role}` : null;
      });
      assert.equal(focus, "Switcher-Area52@us tank", "recreated chip regains focus");
    });

    await check("healer detail matrix links to the healing tab", async () => {
      await page.locator("tr.row", { hasText: "Switcher-Area52" }).locator("button.role.dim").click(); // back to H
      await page.locator("tr.row", { hasText: "Switcher-Area52" }).click(); // open detail
      const detail = page.locator('tr.detail-row[data-key="Switcher-Area52@us"]');
      const href = await detail.locator("a.runlink").first().getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/reports/HEALCODE1?fight=9&type=healing");
      const text = await detail.innerText();
      assert.match(text, /640k/, "the healer's throughput is their HPS");
      assert.match(text, /under it = HPS on that run/i, "legend says HPS, not DPS");
      assert.doesNotMatch(text, /DPS/, "a healing table never mentions DPS");
    });

    await check("higher-level run counts for the dungeon column", async () => {
      await page.selectOption("#dungeon", "Pit of Saron");
      await page.click("#lookup");
      await page.waitForFunction(() =>
        document.querySelector("#status")?.textContent?.startsWith("done"));
      const foo = await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText();
      assert.match(foo, /99b/);
      assert.match(foo, /@\+14 \(higher\)/);
    });

    await check("repeat lookup within the hour is served from the cache", async () => {
      const before = wcl.state.charQueries.length;
      await page.evaluate(() => { document.querySelector("#status").textContent = ""; });
      await page.click("#lookup");
      await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("done"));
      assert.equal(wcl.state.charQueries.length, before, "zero character queries — all cached");
      assert.equal(await page.locator("tr.row").count(), 6, "every row renders from cache");
      assert.match(await page.locator("tr.row", { hasText: "Priestess-Area52" }).innerText(), /88b/,
        "the healer's hps side was cached too");
      const box = await page.evaluate(() => JSON.parse(localStorage.getItem("kllCharCache")));
      assert.ok(box && box.entries && Object.keys(box.entries).length >= 5, "cache persisted");
    });

    await check("Shift-click bypasses the cache for fresh data", async () => {
      const before = wcl.state.charQueries.length;
      await page.evaluate(() => { document.querySelector("#status").textContent = ""; });
      await page.click("#lookup", { modifiers: ["Shift"] });
      await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("done"));
      assert.ok(wcl.state.charQueries.length > before, "characters re-fetched from the API");
    });

    await check("the ⟳ Fresh data button also bypasses the cache", async () => {
      const before = wcl.state.charQueries.length;
      await page.evaluate(() => { document.querySelector("#status").textContent = ""; });
      await page.click("#refresh");
      await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("done"));
      assert.ok(wcl.state.charQueries.length > before, "works without a keyboard (touch devices)");
      assert.match(await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText(), /99b/,
        "results re-render after the refresh");
    });

    await check("pasting the roster looks it up with no click", async () => {
      const before = wcl.state.charQueries.length;
      await page.evaluate(() => {
        document.querySelector("#status").textContent = "";
        document.querySelector("#results").innerHTML = "";
      });
      // paste a name that is NOT already loaded, the way the addon's
      // "Names" button feeds it: whole roster replaced, growing each time
      await page.evaluate(() => {
        const ta = document.querySelector("#names");
        ta.focus();
        ta.value = "Foo-Area52\nPriestess-Area52\nNewguy-Area52";
        // a real paste, so the page sees inputType insertFromPaste
        ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      });
      await page.waitForFunction(
        () => document.querySelector("#status")?.textContent?.startsWith("done"),
        null, { timeout: 10_000 });
      assert.ok(await page.locator("tr.row").count() >= 3, "results rendered without pressing Look up");
      assert.ok(wcl.state.charQueries.length > before, "the new name was actually fetched");
    });

    await check("re-pasting the same roster costs no extra request", async () => {
      const before = wcl.state.charQueries.length;
      await page.evaluate(() => {
        const ta = document.querySelector("#names");
        ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      });
      await page.waitForTimeout(700);
      assert.equal(wcl.state.charQueries.length, before,
        "an unchanged roster is not re-looked-up (it churns every few seconds)");
    });

    await check("a paste landing mid-lookup is not dropped", async () => {
      await page.evaluate(() => {
        document.querySelector("#status").textContent = "";
        const ta = document.querySelector("#names");
        ta.value = "Foo-Area52\nRacer1-Area52";
        ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
        // second paste immediately after, while the first is still in flight
        setTimeout(() => {
          ta.value = "Foo-Area52\nRacer1-Area52\nRacer2-Area52";
          ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
          ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
        }, 180);
      });
      await page.waitForFunction(
        () => document.querySelector("#names").value.includes("Racer2")
          && document.querySelector("#status")?.textContent?.startsWith("done")
          && document.querySelectorAll("tr.row").length >= 3,
        null, { timeout: 10_000 });
      const names = await page.locator("tr.row .charname").allInnerTexts();
      assert.ok(names.some((n) => n.includes("Racer2")),
        "the applicant added mid-flight still ends up on screen");
    });

    await check("a hand-picked role survives the next paste", async () => {
      // Switcher is multi-role; pick the non-default one, then re-paste
      await page.evaluate(() => {
        const ta = document.querySelector("#names");
        ta.value = "Switcher-Area52";
        ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      });
      await page.waitForFunction(() => document.querySelectorAll("tr.row").length === 1,
        null, { timeout: 10_000 });
      await page.locator('tr.row[data-key="Switcher-Area52@us"] button.role.dim').click();
      assert.match(await page.locator('tr.row[data-key="Switcher-Area52@us"]').innerHTML(),
        /role-tank sel/, "tank view chosen by hand");

      await page.evaluate(() => {
        const ta = document.querySelector("#names");
        ta.value = "Switcher-Area52\nFoo-Area52";
        ta.dispatchEvent(new InputEvent("paste", { bubbles: true }));
        ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      });
      await page.waitForFunction(() => document.querySelectorAll("tr.row").length === 2,
        null, { timeout: 10_000 });
      assert.match(await page.locator('tr.row[data-key="Switcher-Area52@us"]').innerHTML(),
        /role-tank sel/, "still tank after the roster grew — choice not clobbered");
    });

    await check("token fetched once and cached", async () => {
      assert.equal(wcl.state.tokenRequests, 1);
    });

    await page.context().close();
  }

  // ============ scenario 1b: plain visit (no params) ========================
  {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${deployedSrv.port}/index.html`);

    await check("plain visit: key level defaults to 12", async () => {
      assert.equal(await page.inputValue("#level"), "12");
    });

    await check("plain visit: dungeon dropdown fills without a lookup", async () => {
      await page.waitForFunction(() =>
        document.querySelectorAll("#dungeon option").length > 1, null, { timeout: 10_000 });
      const options = await page.locator("#dungeon option").allInnerTexts();
      assert.ok(options.includes("Windrunner Spire"), "season dungeons listed on load");
    });

    await page.context().close();
  }

  // ====== scenario 1c: last season's cached zone must not survive ==========
  {
    const page = await newPage();
    // exactly what a returning visitor carries from the previous release:
    // the old cache shape (no version), still inside its 24h TTL, holding
    // last season's dungeon list
    await page.addInitScript(() => {
      localStorage.setItem("kllZoneCache", JSON.stringify({
        until: Date.now() + 24 * 3600_000,
        zone: { id: 47, name: "Mythic+ Season 1", encounters: [{ id: 1, name: "Last Season Dungeon" }] },
      }));
    });
    await page.goto(`http://127.0.0.1:${deployedSrv.port}/index.html`);

    await check("a new season evicts the previous release's cached dungeon list", async () => {
      await page.waitForFunction(() =>
        document.querySelectorAll("#dungeon option").length > 1, null, { timeout: 10_000 });
      const options = await page.locator("#dungeon option").allInnerTexts();
      assert.ok(options.includes("Windrunner Spire"), "current season's dungeons fetched");
      assert.ok(!options.includes("Last Season Dungeon"), "stale season dropped, not served for 24h");
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("kllZoneCache")));
      // >= 2 rather than == 2: a future season bump must not fail this test,
      // but a version-less cache (the bug being fixed) still must
      assert.ok(typeof stored.v === "number" && stored.v >= 2, "rewritten with a cache version");
      assert.ok(stored.until - Date.now() <= 3 * 3600_000 + 5000, "short TTL bounds the next rollover");
    });

    await page.context().close();
  }

  // ============ scenario 2: unconfigured copy shows a clear notice ==========
  {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${bareSrv.port}/index.html${QUERY}`);

    await check("unconfigured: explains exactly what the owner must do", async () => {
      await page.waitForFunction(() =>
        document.querySelector("#status")?.textContent?.includes("WCL_CLIENT_SECRET"));
      assert.equal(await page.locator(".status.error").count(), 1);
      assert.equal(await page.locator("table.summary").count(), 0, "no lookup attempted");
    });

    await page.context().close();
  }
} finally {
  await browser.close();
  bareSrv.server.close();
  deployedSrv.server.close();
  wcl.server.close();
  rio.server.close();
}

console.log(failed === 0 ? "e2e: all checks passed" : `e2e: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
