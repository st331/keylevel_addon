// cli.integration.test.mjs — full pipeline against a local fake WCL server:
// token -> zone discovery -> character fetch (with slug retry) -> Data.lua.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "keylevel-companion.mjs");

// async spawn: spawnSync would freeze the parent's event loop and deadlock
// the in-process fake WCL server.
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { encoding: "utf8" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const ZONES_RESPONSE = {
  data: {
    worldData: {
      zones: [
        {
          id: 47, name: "Mythic+ Season 1", frozen: false,
          brackets: { type: "Keystone Level", min: 2, max: 25, bucket: 1 },
          encounters: [
            { id: 12805, name: "Windrunner Spire" },
            { id: 10658, name: "Pit of Saron" },
          ],
          difficulties: [{ id: 10, name: "Mythic+" }],
          expansion: { id: 11, name: "Midnight" },
        },
      ],
    },
  },
};

function rankingsFor(slugUsed) {
  // Character only exists on slug "area52" (not the dashed guess "area-52"),
  // to force the slug-retry path.
  if (slugUsed !== "area52") return { data: { characterData: { c0: null } } };
  return {
    data: {
      characterData: {
        c0: {
          classID: 4,
          e12805: {
            ranks: [
              { rankPercent: 91.2, bracketData: 12, spec: "Fire" },
              { rankPercent: 88.0, bracketData: 11, spec: "Frost" },
            ],
          },
          e10658: { ranks: [{ rankPercent: 71.4, bracketData: 12, spec: "Fire" }] },
        },
      },
    },
  };
}

function startFakeWcl() {
  const state = { tokenRequests: 0, characterQueries: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") {
        state.tokenRequests++;
        res.end(JSON.stringify({ access_token: "fake-token" }));
        return;
      }
      const { query } = JSON.parse(body);
      if (query.includes("worldData")) {
        res.end(JSON.stringify(ZONES_RESPONSE));
        return;
      }
      const slug = /serverSlug: "([^"]+)"/.exec(query)?.[1];
      state.characterQueries.push(slug);
      res.end(JSON.stringify(rankingsFor(slug)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

test("fetch: end-to-end writes Data.lua, caches slug, second run skips bad slug", async () => {
  const { server, state, port } = await startFakeWcl();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kll-cli-"));
    const outPath = path.join(dir, "Data.lua");
    const config = {
      clientId: "id", clientSecret: "secret", region: "us",
      tokenUrl: `http://127.0.0.1:${port}/token`,
      apiUrl: `http://127.0.0.1:${port}/gql`,
      outPath, dbPath: path.join(dir, "db.json"),
    };
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config));

    const run1 = await runCli(["fetch", "--config", configPath, "--names", "Foo-Area52"]);
    assert.equal(run1.status, 0, `cli failed: ${run1.stderr}\n${run1.stdout}`);

    // slug retry: dashed candidate first (fails), then plain (succeeds)
    assert.deepEqual(state.characterQueries, ["area-52", "area52"]);

    const lua = fs.readFileSync(outPath, "utf8");
    assert.match(lua, /KeyLevelLogsData = \{/);
    assert.match(lua, /\["Foo-Area52"\]/);
    assert.match(lua, /class = "MAGE"/);
    assert.match(lua, /\[11\]/);
    assert.match(lua, /\[12\]/);
    assert.match(lua, /challengeMapID = 557/, "Windrunner Spire mapped");
    assert.match(lua, /runs = 2/, "two dungeons at +12");
    assert.match(run1.stdout, /logged key levels: \+11 \+12/);

    const db = JSON.parse(fs.readFileSync(config.dbPath, "utf8"));
    assert.equal(db.realmSlugCache.Area52, "area52", "working slug cached");

    // second run: cached slug used directly, zone cache avoids re-query
    state.characterQueries.length = 0;
    const run2 = await runCli(["fetch", "--config", configPath, "--names", "Foo-Area52"]);
    assert.equal(run2.status, 0, run2.stderr);
    assert.deepEqual(state.characterQueries, ["area52"], "no wasted slug attempt");
  } finally {
    server.close();
  }
});

test("fetch --sv: reads applicants from SavedVariables", async () => {
  const { server, state, port } = await startFakeWcl();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kll-sv-"));
    const now = Math.floor(Date.now() / 1000);
    const sv = `
KeyLevelLogsDB = {
	["seenApplicants"] = {
		["Foo-Area52"] = { ["lastSeen"] = ${now - 60}, ["class"] = "MAGE" },
		["Stale-Area52"] = { ["lastSeen"] = ${now - 90 * 3600}, ["class"] = "ROGUE" },
	},
}`;
    const svPath = path.join(dir, "KeyLevelLogs.lua");
    fs.writeFileSync(svPath, sv);
    const config = {
      clientId: "id", clientSecret: "secret", region: "us",
      tokenUrl: `http://127.0.0.1:${port}/token`,
      apiUrl: `http://127.0.0.1:${port}/gql`,
      outPath: path.join(dir, "Data.lua"), dbPath: path.join(dir, "db.json"),
    };
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config));

    const run = await runCli(["fetch", "--config", configPath, "--sv", svPath]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 seen in the last 24h/, "stale applicant filtered by --recent default");
    const lua = fs.readFileSync(config.outPath, "utf8");
    assert.match(lua, /\["Foo-Area52"\]/);
    assert.doesNotMatch(lua, /Stale-Area52/);
  } finally {
    server.close();
  }
});
