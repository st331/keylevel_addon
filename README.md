# KeyLevelLogs

A World of Warcraft addon that shows, for every player applying to your
Mythic+ listing, their **Warcraft Logs percentile for the key level you are
running** — in a small movable window, with an explicit indicator when they
have no logs at that level.

For each applicant you see two things, mirroring how you'd vet them on the
website:

| Column | Meaning |
|---|---|
| **Any dungeon @+12** | Their best percentile at exactly your key level, across all dungeons this season (with how many dungeons they've logged at that level) |
| **This dungeon +12/+11** | Their percentile for *your* dungeon at your level — or, if they've never done it at that level, at **one level below**, clearly marked "(one below)" |

If neither exists you get `no recent · best +9: 55%` (their best logged level
for that dungeon) or `never logged`. Players with no Warcraft Logs data at
all show `no data`. Rows are sorted best-first and class-colored, and
percentiles use the familiar Warcraft Logs colors (gray → green → blue →
purple → orange → pink → gold).

## How it works (important!)

WoW addons **cannot access the internet** — the Lua sandbox has no network
API. Every addon that shows web data in game (Raider.IO, Warcraft Logs' own
Archon Tooltip) ships that data as files written by a program running
outside the game, and the game re-reads those files on `/reload`.

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

The window is movable (drag anywhere on it), remembers its position, and can
be closed with its X — it will stay hidden until you `/kll show`.

### Playing nice with other addons

KeyLevelLogs never touches the Blizzard group-finder frames, never hooks
other addons, and never calls protected LFG functions — it only *reads* the
applicant list in response to events and draws its own standalone window.
It is verified conflict-free by design with Premade Groups Filter (which
only modifies the *search results* side of the group finder, not the
applicant side).

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
- A player who doesn't log their runs will show `no data` even if they're
  experienced — same as when you check the website manually.
- Data is a snapshot: numbers update when the companion fetches, not live.
- The WCL API allows 3,600 points/hour (free tier) — plenty for a night of
  key-running; the companion batches queries and caches aggressively.
