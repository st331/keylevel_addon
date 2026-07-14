// e2e.mjs — real-browser tests of the lookup site against a fake Warcraft
// Logs server. Run: node site-tests/e2e.mjs
// Scenario 1: PKCE sign-in (the primary flow) — full OAuth round-trip.
// Scenario 2: advanced manual client-credentials fallback.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  const state = {
    tokenRequests: 0, gqlRequests: 0,
    authorize: null,      // params of the last /authorize navigation
    lastTokenGrant: null, // params of the last /token POST
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");

      // OAuth authorize: top-level navigation; bounce straight back with a code
      if (url.pathname === "/authorize") {
        state.authorize = Object.fromEntries(url.searchParams);
        const back = new URL(url.searchParams.get("redirect_uri"));
        back.searchParams.set("code", "fake-code");
        back.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { Location: back.toString() });
        res.end();
        return;
      }

      // permissive CORS, mirroring the real API
      res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
      res.setHeader("access-control-allow-methods", "POST");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      res.setHeader("content-type", "application/json");

      if (url.pathname === "/token") {
        state.tokenRequests++;
        const p = new URLSearchParams(body);
        state.lastTokenGrant = Object.fromEntries(p);
        state.lastTokenAuth = req.headers.authorization ?? null;
        const grant = p.get("grant_type");
        if (grant === "authorization_code") {
          // real PKCE verification: S256(verifier) must equal the challenge
          const expected = state.authorize?.code_challenge;
          const got = crypto.createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
          if (p.get("code") !== "fake-code" || got !== expected) {
            res.writeHead(401); res.end(JSON.stringify({ error: "invalid_grant" })); return;
          }
          res.end(JSON.stringify({ access_token: "pkce-token", refresh_token: "pkce-refresh", expires_in: 3600 }));
        } else if (grant === "refresh_token") {
          res.end(JSON.stringify({ access_token: "refreshed-token", refresh_token: "pkce-refresh-2", expires_in: 3600 }));
        } else {
          res.end(JSON.stringify({ access_token: "cc-token", expires_in: 3600 }));
        }
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
const staticSrv = await startStatic();
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

const endpointOverrides = {
  tokenUrl: `http://127.0.0.1:${wcl.port}/token`,
  authUrl: `http://127.0.0.1:${wcl.port}/authorize`,
  apiUrl: `http://127.0.0.1:${wcl.port}/gql`,
};
const siteURL = `http://127.0.0.1:${staticSrv.port}/index.html`
  + `?region=us&level=12&dungeon=Windrunner%20Spire&chars=Foo-Area52,Ghost-Sargeras`;

async function newPage(extraInit) {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => { failed++; console.error("not ok - page error: " + e.message); });
  await page.addInitScript(({ overrides, extra }) => {
    localStorage.setItem("kllTokenUrl", overrides.tokenUrl);
    localStorage.setItem("kllAuthUrl", overrides.authUrl);
    localStorage.setItem("kllApiUrl", overrides.apiUrl);
    for (const [k, v] of Object.entries(extra ?? {})) localStorage.setItem(k, v);
  }, { overrides: endpointOverrides, extra: extraInit });
  return page;
}

// ============================ scenario 1: PKCE ==============================
try {
  {
    const page = await newPage();
    await page.goto(siteURL);

    await check("pkce: prompts to connect when not signed in", async () => {
      await page.waitForFunction(() =>
        document.querySelector("#status")?.textContent?.includes("Connect Warcraft Logs"));
      assert.equal(await page.locator("#setup").getAttribute("open"), "");
    });

    await check("pkce: connect round-trips through the authorize endpoint", async () => {
      await page.click("#connect");
      await page.waitForFunction(() =>
        document.querySelector("#creds-state")?.textContent?.includes("connected"));
      assert.ok(wcl.state.authorize, "authorize endpoint was visited");
      assert.equal(wcl.state.authorize.response_type, "code");
      assert.equal(wcl.state.authorize.code_challenge_method, "S256");
      assert.match(wcl.state.authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/$/, "redirect uri normalized (no index.html, no query)");
    });

    await check("pkce: token exchange used the code verifier (server-verified S256)", async () => {
      assert.equal(wcl.state.lastTokenGrant.grant_type, "authorization_code");
      assert.match(wcl.state.lastTokenGrant.code_verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
      assert.equal(wcl.state.lastTokenGrant.client_secret, undefined, "no secret transmitted, ever");
    });

    await check("pkce: addon URL params survive the OAuth round-trip and auto-run", async () => {
      await page.waitForSelector("table.summary", { timeout: 10_000 });
      assert.equal(await page.inputValue("#level"), "12");
      assert.match(await page.inputValue("#names"), /Foo-Area52\nGhost-Sargeras/);
      assert.equal(await page.inputValue("#dungeon"), "Windrunner Spire");
    });

    await check("pkce: results render (exact-level hit + missing character)", async () => {
      const foo = await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText();
      assert.match(foo, /91%/);
      assert.match(foo, /@\+12/);
      const ghost = await page.locator("tr.row", { hasText: "Ghost-Sargeras" }).innerText();
      assert.match(ghost, /no WCL character/);
    });

    await check("pkce: clicking a row opens the dungeon × level matrix", async () => {
      await page.locator("tr.row", { hasText: "Foo-Area52" }).click();
      const text = await page.locator("tr.detail-row.open").innerText();
      assert.match(text, /Windrunner Spire/);
      assert.match(text, /99%/, "the +14 pit run shows in the matrix");
    });

    await check("pkce: higher-level run labels as (higher)", async () => {
      await page.selectOption("#dungeon", "Pit of Saron");
      await page.click("#lookup");
      await page.waitForFunction(() =>
        document.querySelector("#status")?.textContent?.startsWith("done"));
      const foo = await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText();
      assert.match(foo, /@\+14 \(higher\)/);
    });

    await page.context().close();
  }

  // ================== scenario 2: manual credentials fallback ==============
  {
    const page = await newPage({ kllClientId: "test-id", kllClientSecret: "test-secret" });
    const before = wcl.state.tokenRequests;
    await page.goto(siteURL);

    await check("manual: auto-runs with saved credentials", async () => {
      await page.waitForSelector("table.summary", { timeout: 10_000 });
      const foo = await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText();
      assert.match(foo, /91%/);
    });

    await check("manual: used client_credentials grant, token cached", async () => {
      assert.equal(wcl.state.lastTokenGrant.grant_type, "client_credentials");
      assert.equal(wcl.state.tokenRequests, before + 1, "exactly one token fetch");
    });

    await page.context().close();
  }

  // ====== scenario 3: deployed site with injected secret — zero setup ======
  {
    const page = await newPage(); // NO stored credentials or tokens at all
    const deployedURL = siteURL.replace(`:${staticSrv.port}/`, `:${deployedSrv.port}/`);
    await page.goto(deployedURL);

    await check("zero-setup: auto-runs with nothing stored in the browser", async () => {
      await page.waitForSelector("table.summary", { timeout: 10_000 });
      const foo = await page.locator("tr.row", { hasText: "Foo-Area52" }).innerText();
      assert.match(foo, /91%/);
    });

    await check("zero-setup: used the deploy-injected embedded credentials", async () => {
      assert.equal(wcl.state.lastTokenGrant.grant_type, "client_credentials");
      const basic = Buffer.from(wcl.state.lastTokenAuth.replace(/^Basic /, ""), "base64").toString();
      assert.match(basic, /^a1fd073d-.*:e2e-injected-secret$/, "embedded id + injected secret");
    });

    await check("zero-setup: setup panel reports ready and stays closed", async () => {
      const state = await page.locator("#creds-state").innerText();
      assert.match(state, /no setup needed/);
      assert.equal(await page.locator("#setup").getAttribute("open"), null, "panel closed");
    });

    await page.context().close();
  }
} finally {
  await browser.close();
  staticSrv.server.close();
  deployedSrv.server.close();
  wcl.server.close();
}

console.log(failed === 0 ? "e2e: all checks passed" : `e2e: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
