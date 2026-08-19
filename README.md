# Monopoline

A tabletop companion that runs every system of a property game **except the board itself** — banking,
deeds, rent maths, jobs and a living economy. Bring any board you like, or none at all:
the app tracks all 40 positions on its own.

Play **pass-and-play** on one device, or **online** where everyone uses their own phone and joins with
a four-letter table code.

---

## Run it locally

No dependencies. Node 18+.

```bash
node server.js
```

Then open <http://localhost:3000>.

## Deploy to Render

The repo includes `render.yaml`, so the whole thing is a blueprint deploy:

1. Push this folder to a GitHub repository.
2. In Render: **New → Blueprint**, pick the repo, click **Apply**.

Render reads `render.yaml` and starts `node server.js`. There is no build step and nothing to install.
`PORT` is injected by Render and read automatically; health checks hit `/api/health`.

To deploy without the blueprint, create a **Web Service** with:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | *(leave empty)* |
| Start command | `node server.js` |
| Health check path | `/api/health` |

> On Render's free tier the service sleeps after inactivity and wakes on the next request. A sleeping
> service drops open connections, so an online table left idle for a long stretch will need a refresh.
> Rooms live in memory and are cleared 8 hours after their last activity — and on every deploy/restart.
> Pass-and-play games are saved in the browser, so they survive regardless.

## Install on a phone

Open the deployed URL and use **Add to Home Screen**. It installs as a standalone app and the service
worker caches the shell, so **pass-and-play works with no signal at all**. Online tables need the network.

---

## How multiplayer works

- One player starts a table, names it, and shares the four-letter code (or the link, which pre-fills it).
- Everyone else joins from their own device. Up to 8 seats. Joining closes once the game starts.
- Live updates use **Server-Sent Events** — no WebSocket, no dependencies, and they reconnect on their own.
- Closing the app and reopening it rejoins the same seat with the game intact.

**Write authority.** The game state is one JSON document per room, and the server only accepts a write
from the player whose turn it is. An out-of-turn device is rejected and re-syncs to the table's truth,
so a stale phone can never overwrite a live game. The job draft is the one moment several players write
at once, so picks go through a separate endpoint that merges them field-by-field on the server rather
than replacing the whole document.

This protects against staleness and races, **not** against a determined cheater: the player whose turn
it is could still edit their own state. It is built for friends around a table, not for strangers with
money on the line.

---

## The game

The board follows a standard layout — Mediterranean through Boardwalk, four railroads, two utilities,
Chance at 7/22/36 and Community Chest at 2/17/33 — with the usual prices and rent tables, so the app
agrees space for space with a physical board sitting next to it.

Everything a property game normally needs — deeds, colour sets, houses and hotels, mortgages at 10% to
lift, trades with a confirmation step, jail, bankruptcy with forced liquidation, and a live transaction log — plus:

- **Jobs.** Everyone picks from **five offers** out of a deck of **twenty-nine**, all rebalanced to sit
  in a $20–45 payday band with gentler effects (Architect builds 15% cheaper, Barrister pays 12% less rent,
  Diplomat caps any rent at $350, Toll Keeper charges rivals $15 at GO…). Each pays a bonus on every GO and
  **promotes** on the 3rd and 6th lap to ×1.5 then ×2. Any job can be switched off before the game.
- **Alliances.** Two players can strike a pact: half rent between them, a 10% tithe on what either
  collects from outsiders, and a **shared victory** if the pair outlast the table. Breaking it costs $150
  to the jilted ally. One pact per player; it dissolves on bankruptcy. Online, the offer is answered on
  the ally's own device through a server-merged endpoint, since the responder is not the current player.
- **A guided tour.** Twenty-two coach marks over the live interface covering the rules as well as the
  screen — payday, promotion, skyscrapers, mortgages, the market, alliances — offered on the first game and available
  any time from the menu.
- **Twelve palettes**, each with light and dark variants, plus **24 playing pieces** and a bench of
  20 colours — every player picks their own shape and colour, so no two tables look alike.
- **A living economy.** A market index drifts each round and scales all rent between ×0.70 and ×1.35.
- **Skyscrapers**, one tier above hotels, paying 1.6× hotel rent.
- **Bank services** — loans up to $600 at 10% per lap, and rent insurance.

House rules (starting cash, salary, free-parking pot, skyscrapers, economy, loans, the pass-the-device
screen, which jobs are in the deck, and whether the app rolls the dice or you enter your own physical
rolls) are all set before the game. Buildings go up one property at a time — there is no even-build rule.

---

## Layout

```
server.js                 zero-dependency HTTP server + room API (SSE)
render.yaml               Render blueprint
public/index.html         the entire game — self-contained, also runs from file://
public/sw.js              service worker (offline shell)
public/manifest.webmanifest
public/icon.svg
```

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness + room count |
| `POST` | `/api/rooms` | create a table, returns the code |
| `POST` | `/api/rooms/:code/join` | take a seat, or rejoin with a token |
| `GET` | `/api/rooms/:code/events` | SSE stream: `sync`, `state`, `roster`, `say` |
| `POST` | `/api/rooms/:code/state` | push state (current player only) |
| `POST` | `/api/rooms/:code/pick` | claim a job during the draft (server-merged) |
| `POST` | `/api/rooms/:code/piece` | claim a playing piece and colour |
| `POST` | `/api/rooms/:code/title` | host renames the table |
| `POST` | `/api/rooms/:code/pact` | accept or decline an alliance offer |
| `POST` | `/api/rooms/:code/say` | table chat |
| `POST` | `/api/rooms/:code/signal` | relay one WebRTC message to one peer |
| `POST` | `/api/rooms/:code/voice` | join or leave the voice call |
| `POST` | `/api/auth/register` | `login` | `me` | `prefs` | `result` | accounts |
| `POST` | `/api/admin/announce` | `blackout` | moderator broadcasts (needs `ADMIN_KEY` if set) |
| `POST` | `/api/report` | file a bug report |
| `GET` | `/api/reports?key=…` | read reports back (needs `ADMIN_KEY`) |

## Bug reports

Players can file a report from the home screen or the menu, optionally attaching a game-state
snapshot (positions, cash, deeds, last 25 log lines). Every report is printed to stdout, so on Render
they show up in the service logs:

```
[bug] 2026-08-17T01:18:41.914Z | Ada @7S4U | End turn did nothing after doubles
```

To read them back over HTTP instead, set an `ADMIN_KEY` environment variable and fetch
`/api/reports?key=YOUR_KEY`. Without that variable the endpoint stays off. Reports are kept in memory
(latest 200) and clear on restart — the log line is the durable copy. Offline players get a **Copy
report** button instead, so nothing is lost when there is no server to reach.

## Console

Typing `/consolejeff` into table talk opens a hidden console. It edits anything in the game directly:

- **Players** — name, cash, position, laps, job, jail state and turns, jail cards, insurance, loan,
  bankrupt flag, piece and colour
- **Deeds** — set the owner, house count and mortgage state of any space; hand every deed to one player,
  or return them all to the bank
- **Game** — round, market index, Free Parking pot, whose turn it is, doubles count, rolled flag;
  clear all alliances; force the game over
- **Raw** — the entire game state as JSON, validated before it replaces anything

Every change is written to the table log as a `Console` entry, so nothing happens silently. The command
itself is never broadcast or logged. In an online game changes can only be applied on your turn, since
the table rejects writes from anyone else.

## Accounts

Optional. Sign in and your name, piece, colour and palette follow you between devices, and a
lifetime tally of games and wins is kept.

Passwords are hashed with **scrypt** and a per-user salt; the plain password is never stored.
Login returns the same message whether the name exists or not, so accounts cannot be enumerated.

Accounts live in `DATA_DIR/users.json` (`DATA_DIR` defaults to `./data`). **On Render's free tier the
filesystem is ephemeral, so accounts reset on every deploy** — attach a Render disk and point
`DATA_DIR` at it to keep them.

## Voice chat

Online tables can open a voice call from the chat popup. It is a WebRTC mesh: every player in the call
holds one peer connection to each other, and the server only relays offers, answers and ICE candidates —
audio never touches it. Needs HTTPS (Render provides it) and microphone permission. Lightweight mode
turns it off.

## Modes

Under the **Setup** tab:

- **Easy words** — rewrites the interface into plain language, so deeds become property cards and
  mortgages become borrowing.
- **Lightweight** — no animations, flat board, no voice. Everything battery-hungry is switched off.
- **Developer** — unlocks the console. With it off, `/consolejeff` does nothing.

## Moderator powers

The console's **Server** tab reaches every table on the server:

- **Announcement** — a banner on every player's screen.
- **Reset** — covers every screen with *"Reload, Moderators have reset the server."*

Both are gated by `ADMIN_KEY` **when that variable is set**. Leave it unset only on a server you own,
since without it anyone who finds the endpoint can use them. Set it in Render's environment and enter
the same value in the console.
