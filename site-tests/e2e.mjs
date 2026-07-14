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
  // Foo exists on slug area52 (forces one slug retry from area-52);
  // Ghost-Sargeras never exists.
  const out = {};
  const charRe = /(c\d+): character\(name: "([^"]+)", serverSlug: "([^"]+)"/g;
  let m;
  while ((m = charRe.exec(query)) !== null) {
    const [, alias, name, slug] = m;
    if (name === "Foo" && slug === "area52") {
      out[alias] = {
        classID: 4,
        [`e${AK}`]: { ranks: [
          { rankPercent: 91.2, bracketData: 12, spec: "Fire" },
          { rankPercent: 60.0, bracketData: 12, spec: "Fire" }, // second +12 run: avg/med differ from best
          { rankPercent: 76.4, bracketData: 11, spec: "Fire" },
          { rankPercent: 50.0, bracketData: 2, spec: "Fire" }, // outside the ±4 window at +12
        ] },
        [`e${PIT}`]: { ranks: [{ rankPercent: 99.4, bracketData: 14, spec: "Fire" }] },
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

const QUERY = `?region=us&level=12&dungeon=Windrunner%20Spire&chars=Foo-Area52,Ghost-Sargeras`;

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
      assert.match(await page.inputValue("#names"), /Foo-Area52\nGhost-Sargeras/);
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
      const ghost = await page.locator("tr.row", { hasText: "Ghost-Sargeras" }).innerText();
      assert.match(ghost, /no WCL character/);
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
      assert.deepEqual(names, ["Foo-Area52", "Ghost-Sargeras"]);
    });

    await check("clicking a row opens the dungeon × level matrix", async () => {
      await page.locator("tr.row", { hasText: "Foo-Area52" }).click();
      const text = await page.locator("tr.detail-row.open").innerText();
      assert.match(text, /Windrunner Spire/);
      assert.match(text, /Pit of Saron/);
      assert.match(text, /99%/, "the +14 pit run shows in the matrix");
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
      const href = await page.locator("tr.row a.wcl-link").first().getAttribute("href");
      assert.equal(href, "https://www.warcraftlogs.com/character/us/area52/Foo");
    });

    await check("address bar reflects the current lookup (shareable)", async () => {
      const url = new URL(page.url());
      assert.equal(url.searchParams.get("level"), "12");
      assert.match(url.searchParams.get("chars"), /Foo-Area52/);
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
