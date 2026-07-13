# KeyLevelLogs

A World of Warcraft addon that shows, for every player applying to your
Mythic+ listing, their **Warcraft Logs percentile for the key level you are
running** — in a small movable window, with an explicit indicator when they
have no logs at that level.

For each applicant you see three things, mirroring how you'd vet them on the
website:

| Column | Meaning |
|---|---|
| **Rating** | Their in-game M+ rating (comes free with the application — works even before any Warcraft Logs data is fetched) |
| **Any dungeon @+12** | Their best percentile at exactly your key level, across all dungeons this season (with how many dungeons they've logged at that level) |
| **This dungeon (want +12)** | Their percentile for *your* dungeon: at your level (`91% @+12`), at a higher level if that's what they've logged (`92% @+14 (higher)` — a higher clear counts at least as much), or **one level below** (`76% @+11 (one below)`) |

If none of those exist you get `only lower · best +9: 55%` (their best logged
level for that dungeon) or `never logged`. The window distinguishes
`not fetched — /kll copy` (the companion hasn't looked this player up yet)
from `no WCL character` (looked up — they simply don't log). Data older than
two days gets a gray age tag next to the name, e.g. `Bob (5d)`. Rows are
sorted best-first and class-colored, and percentiles use the familiar
Warcraft Logs colors (gray → green → blue → purple → orange → pink → gold).

## How it works (important!)

WoW addons **cannot access the internet** — the Lua sandbox has no network
API. Every addon that shows web data in game ships that data as files
written by a program running outside the game, and the game re-reads those
files on `/reload`:

- **Warcraft Logs' Archon Tooltip** looks real-time but isn't: the Warcraft
  Logs Uploader desktop app writes `db_*.lua` database files into the
  `ArchonTooltip` addon folder — refreshed **weekly** for free users, daily
  for subscribers. Warcraft Logs can pre-ship *every* character because they
  generate the export server-side from their own database.
- **Raider.IO** ships whole-region score databases as `RaiderIO_DB_*` addon
  folders, rewritten by its desktop client up to a few times per day.

A third-party tool like this one can't bulk-export Warcraft Logs (the public
API is rate-limited per client), so KeyLevelLogs fetches exactly the players
who apply to your groups instead — fresher data for the people you actually
care about, seconds after they apply.

KeyLevelLogs works the same way, with two parts:

1. **The addon** (`KeyLevelLogs/`) — tracks who applies to your group,
   displays their numbers from its local data file (`Data.lua`), and records
   applicant names so the companion knows who to look up.
2. **The companion** (`companion/`) — a small Node.js tool that fetches
   percentiles from the official Warcraft Logs API (using your own free API
   key) and rewrites `Data.lua`.

The loop while you're recruiting for a key:

```
applicants show up  ->  /reload  (game saves the applicant names to disk)
                        companion (in watch mode) sees them, fetches WCL data,
                        rewrites Data.lua in a few seconds
/reload again       ->  window now shows everyone's percentiles
```

You can also pre-load players any time with `fetch --names`, and everything
the companion ever fetched stays in the data file, so frequently-seen
players are often already there.

## Installation

### Addon

Copy (or symlink) the `KeyLevelLogs/` folder into
`World of Warcraft/_retail_/Interface/AddOns/`.

### Companion

Requires [Node.js](https://nodejs.org) 18+ (no npm packages needed).

```bash
cd companion
node keylevel-companion.mjs init
```

Then edit the generated `companion/config.json`:

1. **API credentials**: create a (free) client at
   <https://www.warcraftlogs.com/api/clients/> — any name, no redirect URL
   needed. Put `clientId`/`clientSecret` in the config, or leave the
   `env:...` values and export `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`.
2. **`outPath`**: point it at your real addon folder, e.g.
   `C:/Program Files (x86)/World of Warcraft/_retail_/Interface/AddOns/KeyLevelLogs/Data.lua`
   (forward slashes work on Windows).
3. **`region`**: `us`, `eu`, `kr`, or `tw`.

The current M+ season zone is auto-detected from the API; run
`node keylevel-companion.mjs zones` to see it (set `zoneID` in the config to
pin a specific season).

## Usage

### Day-to-day

Start the companion in watch mode, pointing it at the addon's saved
variables (adjust account name):

```bash
node keylevel-companion.mjs watch --sv "<WoW>/_retail_/WTF/Account/<ACCOUNT>/SavedVariables/KeyLevelLogs.lua"
```

In game: list your key. When applications arrive, the window pops up.
Anyone already in the data file shows numbers immediately; for the rest,
`/reload` once (saves their names), wait a few seconds, `/reload` again.

### Manual fetch

```bash
node keylevel-companion.mjs fetch --names "Playerone-Area52,Playertwo-TwistingNether"
```

In game, the **Copy** button (or `/kll copy`) opens a box with all current
applicant names ready to paste into that command.

### Slash commands

| Command | Effect |
|---|---|
| `/kll` | toggle the window |
| `/kll 12` | evaluate applicants as if recruiting for a +12 (otherwise your own keystone's level is used) |
| `/kll auto` | back to following your keystone |
| `/kll dungeon <name>` | evaluate against a specific dungeon (name-matched, e.g. `/kll dungeon windrunner`) |
| `/kll copy` | copyable list of applicant names for the companion |
| `/kll reset` | reset window position |
| `/kll status` | show current context + data file stats |

The recruiting context is picked in this order: your manual override, then
the group you actually have **listed** (dungeon from the activity, key level
parsed from a "+13" in your listing title), then your own keystone.

The window is movable (drag anywhere on it) and remembers its position. It
pops up when applicants arrive; its X button snoozes it for the current
batch of applicants only, while `/kll hide` turns it off until you
`/kll show` again.

### Playing nice with other addons

KeyLevelLogs never touches the Blizzard group-finder frames, never hooks
other addons, and never calls protected LFG functions — it only *reads* the
applicant list in response to events and draws its own standalone window.
By design it has zero overlap with Premade Groups Filter, which modifies
only the *search results* side of the group finder, not the applicant side.

## Testing without the game

Everything testable outside the game is tested outside the game:

```bash
./scripts/test.sh
```

- **Addon tests** (`tests/`): the real addon Lua runs under a simulated WoW
  environment (frames, events, `C_LFGList`, `C_MythicPlus`, SavedVariables,
  slash commands) on Lua 5.1 — the same Lua version WoW embeds. They cover
  the percentile/fallback logic, the full applicant-event → window-rows
  flow, sorting, overrides, window drag persistence, secret-value defense,
  and no-data states.
- **Companion tests** (`companion/test/`): unit tests for every module plus
  an end-to-end run of the actual CLI against a fake Warcraft Logs server
  (token → zone discovery → character fetch with realm-slug retry →
  `Data.lua` generation). Generated `Data.lua` files are additionally
  executed by real Lua to prove the game can load them.

CI (GitHub Actions) runs all of this on every push.

## Repository layout

```
KeyLevelLogs/            the addon (copy this folder into Interface/AddOns)
  KeyLevelLogs.toc
  Data.lua               generated data (placeholder until companion runs)
  Core.lua               data lookup, evaluation, applicant tracking, slash cmds
  UI.lua                 the movable window
companion/               the out-of-game fetcher (Node.js, no dependencies)
  keylevel-companion.mjs CLI entry point
  lib/                   wcl api client, transforms, lua generation, sv parsing
  test/                  node --test suite incl. fake-server integration test
tests/                   addon test harness (WoW API mock) + test suites
scripts/test.sh          run everything
```

## Notes & limitations

- **Percentile source**: Warcraft Logs `encounterRankings` with
  `byBracket: true` and the `playerscore` metric — each logged run carries
  its keystone level, and the addon shows the best percentile per level.
  If a percentile ever looks off compared to the website, run
  `node keylevel-companion.mjs probe --names "Name-Realm"` and open an issue
  with the output.
- A player who doesn't log their runs will show `no WCL character` (or thin
  data) even if they're experienced — same as when you check the website
  manually. Data is also strictly per character: a known player applying on
  a fresh alt looks like a new player, exactly as on the website.
- Data is a snapshot: numbers update when the companion fetches, not live.
  Rows show a gray age tag (e.g. `(5d)`) when a player's data is older than
  two days; re-run the companion (or let watch mode do it) to refresh.
- The WCL API allows 3,600 points/hour (free tier) — plenty for a night of
  key-running. The companion skips players fetched within the last 30
  minutes (`--max-age <minutes>` to tune, `--force` to override), caches the
  zone/dungeon list and realm slugs, and batches characters per request.
- Corporate/VPN proxies: the companion uses Node's built-in fetch, which
  ignores `HTTP(S)_PROXY` environment variables. Run it on a normal home
  connection.
