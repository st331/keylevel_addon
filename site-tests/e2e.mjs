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
  const switcherRanks = isHps
    ? {
      // healing percentiles: the Mistweaver runs' real numbers, the
      // Brewmaster runs' garbage ones (must never be shown)
      [`e${AK}`]: { ranks: [
        { historicalPercent: 5.0, rankPercent: 5.0, bracketData: 12, amount: 20, spec: "Brewmaster", score: 400, startTime: Date.now() - 100 * day },
        { historicalPercent: 6.0, rankPercent: 6.0, bracketData: 12, amount: 21, spec: "Brewmaster", score: 405, startTime: Date.now() - 95 * day },
        { historicalPercent: 7.0, rankPercent: 7.0, bracketData: 12, amount: 22, spec: "Brewmaster", score: 410, startTime: Date.now() - 90 * day },
        { historicalPercent: 90.0, rankPercent: 90.0, bracketData: 12, amount: 900, spec: "Mistweaver", score: 450, startTime: Date.now() - 20 * day },
        { historicalPercent: 92.0, rankPercent: 92.0, bracketData: 12, amount: 910, spec: "Mistweaver", score: 455, startTime: Date.now() - 10 * day, report: { code: "HEALCODE1", fightID: 9 } },
      ] },
      [`e${PIT}`]: { ranks: [
        { historicalPercent: 89.0, rankPercent: 89.0, bracketData: 13, amount: 950, spec: "Mistweaver", score: 470, startTime: Date.now() - 5 * day },
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
        { historicalPercent: 22.0, rankPercent: 22.0, bracketData: 12, amount: 110, spec: "Mistweaver", score: 455, startTime: Date.now() - 10 * day },
      ] },
      [`e${PIT}`]: { ranks: [
        { historicalPercent: 28.0, rankPercent: 28.0, bracketData: 13, amount: 120, spec: "Mistweaver", score: 470, startTime: Date.now() - 5 * day },
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
      out[alias] = {
        classID: 4,
        [`e${AK}`]: { ranks: [
          { historicalPercent: 91.2, rankPercent: 91.2, todayPercent: 85.0, bracketData: 12, amount: 100, spec: "Fire", startTime: Date.now() - 90 * 86_400_000, report: { code: "TESTCODE1", fightID: 7 } },
          { historicalPercent: 60.0, rankPercent: 60.0, todayPercent: 52.0, bracketData: 12, amount: 90, spec: "Fire" }, // second +12 run
          { historicalPercent: 60.0, rankPercent: 60.0, todayPercent: 52.0, bracketData: 12, amount: 90, spec: "Fire" }, // duplicate: must not skew avg
          { historicalPercent: 76.4, rankPercent: 76.4, todayPercent: 70.0, bracketData: 11, amount: 80, spec: "Fire" },
          { historicalPercent: 50.0, rankPercent: 50.0, todayPercent: 45.0, bracketData: 2, amount: 70, spec: "Fire" }, // outside the ±4 window at +12
        ] },
        [`e${PIT}`]: { ranks: [{ historicalPercent: 99.4, rankPercent: 99.4, todayPercent: 97.0, bracketData: 14, amount: 120, spec: "Fire" }] },
      };
    } else {
      out[alias] = null;
    }
  }
  return { data: { characterData: out } };
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
  await page.addInitScript(({ tokenUrl, apiUrl }) => {
    localStorage.setItem("kllTokenUrl", tokenUrl);
    localStorage.setItem("kllApiUrl", apiUrl);
  }, {
    tokenUrl: `http://127.0.0.1:${wcl.port}/token`,
    apiUrl: `http://127.0.0.1:${wcl.port}/gql`,
  });
  return page;
}

const RIO_URL = "https://raider.io/characters/eu/twisting-nether/Eurodude";
// the last token is an armory URL for Foo — the SAME character as the typed
// "Foo-Area52" once the us dropdown region applies; it must collapse to one row
const QUERY = `?region=us&level=12&dungeon=Windrunner%20Spire&chars=Foo-Area52,Priestess-Area52,Switcher-Area52,Ghost-Sargeras,https%3A%2F%2Fraider.io%2Fcharacters%2Feu%2Ftwisting-nether%2FEurodude,https%3A%2F%2Fworldofwarcraft.blizzard.com%2Fen-us%2Fcharacter%2Fus%2Farea-52%2Ffoo`;

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
      const row = page.locator("tr.row", { hasText: "Eurodude-TwistingNether" });
      assert.match(await row.innerText(), /95b/, "found via exact slug + eu region");
      assert.equal(await page.inputValue("#region"), "us", "dropdown still us");
      const tnQueries = wcl.state.charQueries.filter((q) => /twisting-nether/.test(q));
      assert.equal(tnQueries.length, 1, "exact slug: no retry rounds");
      assert.match(tnQueries[0], /serverRegion: "eu"/, "URL region used in the query");
      const href = await row.locator("a.wcl-link").getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/character/eu/twisting-nether/Eurodude");
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
      assert.deepEqual(names, ["Eurodude-TwistingNether", "Switcher-Area52", "Foo-Area52", "Priestess-Area52", "Ghost-Sargeras"]);
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
      assert.match(html, /button[^>]*role-healer sel/, "H chip solid: holds both top keys");
      assert.match(html, /button[^>]*role-tank dim/, "T chip present but dimmed");
      assert.ok(html.indexOf("role-healer") < html.indexOf("role-tank"),
        "H before T — ordered by top keys, not a fixed T/H/D order");
      assert.match(html, /holds 2 of their 2 top keys/, "tooltip carries the count");
      assert.doesNotMatch(html, /role-dps/, "never played dps -> no D chip");
      const text = await row.innerText();
      assert.match(text, /92b/, "healer runs shown with their hps Key %");
      assert.doesNotMatch(text, /40b/, "tank numbers not mixed in");
      assert.doesNotMatch(text, /25b|22b/, "healer runs' dps percentiles never shown");
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
        return el?.matches?.("button.role") ? `${el.dataset.full} ${el.dataset.role}` : null;
      });
      assert.equal(focus, "Switcher-Area52 tank", "recreated chip regains focus");
    });

    await check("healer detail matrix links to the healing tab", async () => {
      await page.locator("tr.row", { hasText: "Switcher-Area52" }).locator("button.role.dim").click(); // back to H
      await page.locator("tr.row", { hasText: "Switcher-Area52" }).click(); // open detail
      const href = await page
        .locator('tr.detail-row[data-full="Switcher-Area52"] a.runlink').first().getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/reports/HEALCODE1?fight=9&type=healing");
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

    await check("token fetched once and cached", async () => {
      assert.equal(wcl.state.tokenRequests, 1);
    });

    await page.context().close();
  }

  // ============ scenario 1b: plain visit (no params) ========================
  {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${deployedSrv.port}/index.html`);

    await check("plain visit: key level defaults to 20", async () => {
      assert.equal(await page.inputValue("#level"), "20");
    });

    await check("plain visit: dungeon dropdown fills without a lookup", async () => {
      await page.waitForFunction(() =>
        document.querySelectorAll("#dungeon option").length > 1, null, { timeout: 10_000 });
      const options = await page.locator("#dungeon option").allInnerTexts();
      assert.ok(options.includes("Windrunner Spire"), "season dungeons listed on load");
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
}

console.log(failed === 0 ? "e2e: all checks passed" : `e2e: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
