import { test } from "node:test";
import assert from "node:assert/strict";
import { makeVerifier, challengeFromVerifier, buildAuthorizeURL, exchangeCode, refreshTokens } from "../docs/js/wcl.js";

test("makeVerifier: length and RFC 7636 charset", () => {
  const v = makeVerifier();
  assert.equal(v.length, 64);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
  assert.notEqual(makeVerifier(), makeVerifier(), "random");
  assert.equal(makeVerifier(43).length, 43);
});

test("challengeFromVerifier matches the RFC 7636 appendix B vector", async () => {
  const challenge = await challengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("buildAuthorizeURL carries all PKCE params", () => {
  const url = new URL(buildAuthorizeURL({
    clientId: "cid", redirectUri: "https://x.github.io/y/", state: "st8", challenge: "ch4",
  }));
  assert.equal(url.origin + url.pathname, "https://www.warcraftlogs.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x.github.io/y/");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "st8");
  assert.equal(url.searchParams.get("code_challenge"), "ch4");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, params: new URLSearchParams(opts.body) });
    const out = handler(url, opts, calls.length);
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => out.json,
      text: async () => JSON.stringify(out.json),
    };
  };
  impl.calls = calls;
  return impl;
}

test("exchangeCode posts the verifier plain, returns tokens", async () => {
  const f = fakeFetch(() => ({ json: { access_token: "at", refresh_token: "rt", expires_in: 100 } }));
  const t = await exchangeCode({
    clientId: "cid", code: "c0de", redirectUri: "https://x/", verifier: "verif13r", fetchImpl: f,
  });
  assert.equal(t.token, "at");
  assert.equal(t.refreshToken, "rt");
  assert.ok(t.expiresAt > Date.now());
  const p = f.calls[0].params;
  assert.equal(p.get("grant_type"), "authorization_code");
  assert.equal(p.get("client_id"), "cid");
  assert.equal(p.get("code"), "c0de");
  assert.equal(p.get("redirect_uri"), "https://x/");
  assert.equal(p.get("code_verifier"), "verif13r");
  assert.equal(f.calls[0].opts.headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("refreshTokens posts refresh grant with client id only", async () => {
  const f = fakeFetch(() => ({ json: { access_token: "at2", refresh_token: "rt2", expires_in: 100 } }));
  const t = await refreshTokens({ clientId: "cid", refreshToken: "rt1", fetchImpl: f });
  assert.equal(t.token, "at2");
  const p = f.calls[0].params;
  assert.equal(p.get("grant_type"), "refresh_token");
  assert.equal(p.get("refresh_token"), "rt1");
  assert.equal(p.get("client_id"), "cid");
  assert.equal(p.get("client_secret"), null, "no secret anywhere in PKCE flows");
});

test("exchangeCode surfaces failures as friendly errors", async () => {
  const f = fakeFetch(() => ({ status: 401, json: {} }));
  await assert.rejects(
    exchangeCode({ clientId: "c", code: "x", redirectUri: "https://x/", verifier: "v", fetchImpl: f }),
    /sign-in failed/);
});
