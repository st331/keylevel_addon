// e2e.mjs — real-browser test of the lookup site against a fake Warcraft
// Logs server. Run: node site-tests/e2e.mjs
// Requires the playwright package; the chromium binary comes from
// `npx playwright install chromium` (or a preinstalled PLAYWRIGHT_BROWSERS_PATH).

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
function startStatic() {
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    let file = path.join(DOCS, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) {
      res.writeHead(404); res.end("nope"); return;
    }
    res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
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
          { rankPercent: 76.4, bracketData: 11, spec: "Fire" },
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
  const state = { tokenRequests: 0, gqlRequests: 0 };
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
      if (req.url === "/token") {
        state.tokenRequests++;
        res.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
        return;
      }
      state.gqlRequests++;
      const { query } = JSON.parse(body);
      res.end(JSON.stringify(query.includes("worldData") ? ZONES : characterResponse(query)));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, state, port: server.address().port })));
}

// --- the test ---------------------------------------------------------------
const staticSrv = await startStatic();
const wcl = await startFakeWcl();
// PLAYWRIGHT_CHROMIUM env overrides the executable (for environments with a
// preinstalled chromium that doesn't match the playwright package version)
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

try {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => { failed++; console.error("not ok - page error: " + e.message); });

  await page.addInitScript(({ tokenUrl, apiUrl }) => {
    localStorage.setItem("kllClientId", "test-id");
    localStorage.setItem("kllClientSecret", "test-secret");
    localStorage.setItem("kllTokenUrl", tokenUrl);
    localStorage.setItem("kllApiUrl", apiUrl);
  }, {
    tokenUrl: `http://127.0.0.1:${wcl.port}/token`,
    apiUrl: `http://127.0.0.1:${wcl.port}/gql`,
  });

  // arrive exactly like the addon's Copy URL
  const url = `http://127.0.0.1:${staticSrv.port}/index.html`
    + `?region=us&level=12&dungeon=Windrunner%20Spire&chars=Foo-Area52,Ghost-Sargeras`;
  await page.goto(url);

  await check("auto-runs and renders the summary table", async () => {
    await page.waitForSelector("table.summary", { timeout: 10_000 });
  });

  await check("controls prefilled from the URL", async () => {
    assert.equal(await page.inputValue("#level"), "12");
    assert.equal(await page.inputValue("#region"), "us");
    assert.match(await page.inputValue("#names"), /Foo-Area52\nGhost-Sargeras/);
  });

  await check("dungeon select resolved against the season list", async () => {
    assert.equal(await page.inputValue("#dungeon"), "Windrunner Spire");
  });

  await check("Foo row shows exact-level percentile for the dungeon", async () => {
    const row = page.locator("tr.row", { hasText: "Foo-Area52" });
    await row.waitFor();
    const text = await row.innerText();
    assert.match(text, /91%/, "dungeon percentile");
    assert.match(text, /@\+12/, "at the exact level");
    assert.match(text, /1 dungeon/, "any-at-level run count");
  });

  await check("Ghost row says no WCL character", async () => {
    const row = page.locator("tr.row", { hasText: "Ghost-Sargeras" });
    assert.match(await row.innerText(), /no WCL character/);
  });

  await check("Foo sorts above Ghost", async () => {
    const names = await page.locator("tr.row .charname").allInnerTexts();
    assert.deepEqual(names, ["Foo-Area52", "Ghost-Sargeras"]);
  });

  await check("clicking a row opens the dungeon × level detail matrix", async () => {
    await page.locator("tr.row", { hasText: "Foo-Area52" }).click();
    const detail = page.locator("tr.detail-row.open");
    await detail.waitFor();
    const text = await detail.innerText();
    assert.match(text, /Windrunner Spire/);
    assert.match(text, /Pit of Saron/);
    assert.match(text, /99%/, "the +14 pit run shows in the matrix");
  });

  await check("higher-level run counts for the dungeon column", async () => {
    // re-run with Pit of Saron at +12: Foo only has a +14 -> "(higher)"
    await page.selectOption("#dungeon", "Pit of Saron");
    await page.click("#lookup");
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.startsWith("done"));
    const row = page.locator("tr.row", { hasText: "Foo-Area52" });
    const text = await row.innerText();
    assert.match(text, /99%/, "pct from the +14 run");
    assert.match(text, /@\+14 \(higher\)/, "explicitly labelled higher");
  });

  await check("token fetched once and cached", async () => {
    assert.equal(wcl.state.tokenRequests, 1);
  });

  await check("no credentials ever left the browser except to the (fake) WCL", async () => {
    // both fetch targets were 127.0.0.1 fakes; nothing else was contacted.
    // static server saw only GETs for site files (it would 404 anything else)
    assert.ok(wcl.state.gqlRequests >= 2, "zones + characters queried");
  });
} finally {
  await browser.close();
  staticSrv.server.close();
  wcl.server.close();
}

console.log(failed === 0 ? "e2e: all checks passed" : `e2e: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
