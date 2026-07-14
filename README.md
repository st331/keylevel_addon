# KeyLevelLogs

Vet your Mythic+ applicants against Warcraft Logs in one paste.

Two parts:

1. **A tiny WoW addon** — a movable window that lists everyone applying to
   your group (with their in-game M+ rating) and gives you a one-click
   **Copy URL** containing all their names plus your key level and dungeon.
2. **A website on GitHub Pages** — paste that URL (or just names) and see,
   for each applicant, their Warcraft Logs percentiles organized around the
   question you actually ask: *how are their logs at the key level I'm
   running?*

For each character the site shows:

| Column | Meaning |
|---|---|
| **Any dungeon @+12** | Best percentile at exactly your key level, across all dungeons this season (with how many dungeons they've logged at that level) |
| **Your dungeon (want +12)** | Their log for *your* dungeon: at your level (`91% @+12`), at a higher level (`99% @+14 (higher)` — a higher clear counts at least as much), or one level below (`76% @+11 (one below)`) |

If neither exists: `only lower · best +9: 55%` or `never logged`, and players
with no Warcraft Logs presence at all show `no WCL character` — your explicit
"no logs" indicator. Click any row for the full **dungeon × key level
matrix** of their season. Percentiles use the Warcraft Logs color tiers
(gray → green → blue → purple → orange → pink → gold), rows sort best-first.

## How it works

WoW addons cannot access the internet (the Lua sandbox has no network API —
even Warcraft Logs' own Archon addon just reads files that their desktop app
writes to disk on a weekly schedule). So the addon's job is only to *collect
names*; the lookup happens in your browser, which calls the Warcraft Logs
API directly — their API explicitly allows browser requests (CORS), and you
use your own free API key, stored only in your browser.

```
players apply  →  addon window pops up  →  click "Copy URL"
→ paste in browser → percentiles, organized, in ~2 seconds
```

No companion process, no /reload loop, no data files.

## Setup

### 1. Addon

Copy the `KeyLevelLogs/` folder into
`World of Warcraft/_retail_/Interface/AddOns/`.

### 2. Website (zero setup for visitors)

The site is static (`docs/`) and is published by the
`.github/workflows/pages.yml` workflow, which injects the Warcraft Logs
client secret from a **GitHub Actions secret** at deploy time — the secret
never appears in the repo source or its history. Repo-owner setup, one time:

1. **Settings → Secrets and variables → Actions → New repository secret**:
   name `WCL_CLIENT_SECRET`, value = the client secret from
   [warcraftlogs.com/api/clients](https://www.warcraftlogs.com/api/clients/)
   for the client whose id is baked into `docs/js/config.js`.
2. **Settings → Pages → Source: "GitHub Actions"**.
3. Push/merge to `main` (or run the "Deploy site" workflow manually). The
   site appears at `https://<user>.github.io/keylevel_addon/`.

Visitors (you and your friends) need **no setup at all** — open the link,
paste names, done. There is no setup UI on the page; a copy deployed without
the secret shows a notice telling the owner to add `WCL_CLIENT_SECRET` and
re-run the deploy workflow.

**Security model, honestly:** GitHub Actions secrets are encrypted and never
served to visitors, but the *deployed page* must send the secret to
warcraftlogs.com, so a visitor who digs through the site's JS can extract
it. For this API that only exposes your client's shared 3,600 points/hour
quota — it cannot access your account or private logs. If it's ever abused,
regenerate the secret on the WCL clients page, update the Actions secret,
and re-run the deploy. A test guards against a real secret ever being
committed to the repo itself.

## Using it

1. List your key. When players apply, the addon window pops up (movable,
   remembers its position, X snoozes it for the current batch, `/kll hide`
   turns it off persistently).
2. Click **Copy URL** (or `/kll copy`), Ctrl+C, paste into your browser.
   The site reads the names, your key level, and your dungeon from the URL
   and runs immediately.
3. Read the table; click a row for the full matrix. Invite accordingly.

The **Names** button (`/kll names`) copies bare `Name-Realm` lines instead,
for pasting into the site's textbox by hand.

Context is picked automatically: your manual override (`/kll 13`,
`/kll dungeon windrunner`) beats the group you have **listed** (dungeon from
the listing's activity, level parsed from a "+13" in its title), which beats
your own keystone. `/kll auto` resets. You can also change level/dungeon on
the website at any time and re-run.

### Playing nice with other addons

The addon never touches the Blizzard group-finder frames, never hooks other
addons, and never calls protected LFG functions — it only *reads* the
applicant list in response to events and draws its own standalone window. By
design it has zero overlap with Premade Groups Filter, which modifies only
the *search-results* side of the group finder, not the applicant side.

## Testing without the game

Everything testable outside the game is tested outside the game:

```bash
./scripts/test.sh          # runs all three suites
```

- **Addon** (`tests/`): the real addon Lua runs under a simulated WoW client
  (frames, events, `C_LFGList`, secret-value semantics, SavedVariables) on
  Lua 5.1 — the same Lua version WoW embeds. Covers the applicant-event →
  window flow, URL building/encoding, context precedence, drag persistence,
  snooze/visibility rules, and Midnight "secret value" defenses.
  `lua5.1 tests/demo.lua` prints the window contents + generated URL.
- **Website unit tests** (`site-tests/*.test.mjs`): the percentile
  evaluation (exact / higher / one-below / only-lower / never), WCL response
  transforms, realm-slug guessing, name parsing, HTML rendering and sorting.
- **Website end-to-end** (`site-tests/e2e.mjs`): a real Chromium loads the
  actual site against a fake Warcraft Logs server and verifies the whole
  zero-setup flow — a fresh browser arriving via an addon-generated URL,
  auto-lookup with the deploy-injected credentials, rendered percentiles,
  "no WCL character" handling, the detail matrix — plus the unconfigured
  copy's owner-facing notice. (`npm install` once; CI runs it on every push.)

The only things that can't be verified outside the game are the live Blizzard
client (one 5-minute in-game pass) and the real WCL API responses for your
region's players (first paste on the live site).

## Repository layout

```
KeyLevelLogs/       the addon (copy into Interface/AddOns)
  KeyLevelLogs.toc
  Core.lua          applicant tracking, context, URL building, slash commands
  UI.lua            the movable window + copy box
docs/               the website (GitHub Pages serves this folder)
  index.html
  style.css
  js/               app wiring + pure modules (wcl api, transforms, rendering)
tests/              addon test harness (WoW API mock) + suites + demo
site-tests/         website unit tests + real-browser e2e
scripts/test.sh     run everything
```

## Notes & limitations

- Percentiles come from Warcraft Logs `encounterRankings` (`byBracket`, one
  entry per run with its keystone level, `playerscore` metric). If a number
  ever looks off next to the website, open an issue with the character name.
- A player who doesn't log shows `no WCL character` even if experienced —
  same answer the website gives. Data is per character: alts look like new
  players.
- Your API client allows 3,600 points/hour — far more than a night of
  key-running needs. The site batches all dungeons per character into single
  requests and caches the token (~1 year) and season list (24h).
- The Warcraft Logs API's browser access (CORS) is intentional but not
  contractual; if they ever turn it off, the fallback is a tiny proxy — open
  an issue if lookups suddenly fail with CORS errors.
