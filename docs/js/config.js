// config.js — deploy-time configuration.
//
// The committed copy holds a placeholder; the Pages deploy workflow
// (.github/workflows/pages.yml) substitutes the real value from the
// repository's GitHub Actions secret WCL_CLIENT_SECRET, so no secret ever
// lives in the repo source or its history.
//
// Honesty note: whatever the deployed site ships, a visitor can extract —
// the browser has to send it to warcraftlogs.com. For this API that only
// exposes the client's shared 3600 points/hour quota (it cannot access the
// account or private logs). Regenerate the secret on the WCL clients page
// and re-deploy if it's ever abused.

export const EMBEDDED_CLIENT_ID = "a1fd073d-42da-47f6-89da-9c78dec3c75a";
export const EMBEDDED_CLIENT_SECRET = "__WCL_CLIENT_SECRET__";

const unset = (s) => !s || s.startsWith("__");

// null when this copy of the site has no injected credentials (repo checkout,
// forks without the secret) — the UI then falls back to Connect/manual modes.
export function embeddedCredentials() {
  if (unset(EMBEDDED_CLIENT_ID) || unset(EMBEDDED_CLIENT_SECRET)) return null;
  return { clientId: EMBEDDED_CLIENT_ID, clientSecret: EMBEDDED_CLIENT_SECRET };
}
