import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedCredentials, EMBEDDED_CLIENT_ID } from "../docs/js/config.js";

const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "js", "config.js");

test("repo copy of config.js has no injected secret", () => {
  assert.equal(embeddedCredentials(), null, "placeholder must not count as credentials");
});

test("guard: the placeholder is intact — no real secret committed", () => {
  const src = fs.readFileSync(CONFIG_PATH, "utf8");
  assert.match(src, /__WCL_CLIENT_SECRET__/,
    "docs/js/config.js must keep the __WCL_CLIENT_SECRET__ placeholder; "
    + "real secrets belong in the GitHub Actions secret, never in the repo");
});

test("client id is present (public identifier)", () => {
  assert.match(EMBEDDED_CLIENT_ID, /^[0-9a-f-]{36}$/);
});

test("workflow substitution produces working credentials", async () => {
  // simulate exactly what pages.yml does, in a temp module
  const src = fs.readFileSync(CONFIG_PATH, "utf8");
  const injected = src.replace("__WCL_CLIENT_SECRET__", "real-secret-value");
  const tmp = path.join(path.dirname(CONFIG_PATH), ".config.injected.test.mjs");
  fs.writeFileSync(tmp, injected);
  try {
    const mod = await import(tmp);
    assert.deepEqual(mod.embeddedCredentials(), {
      clientId: EMBEDDED_CLIENT_ID,
      clientSecret: "real-secret-value",
    });
  } finally {
    fs.unlinkSync(tmp);
  }
});
