# Monopoline

A tabletop companion that runs every system of a property game **except the board itself** — banking,
deeds, rent maths, jobs, minigames and a living economy. Bring any board you like, or none at all:
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

- One player starts a table and shares the four-letter code (or the link, which pre-fills the code).
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
lift, auctions, trades, jail, bankruptcy with forced liquidation, and a full transaction log — plus:

- **Jobs.** Everyone drafts one of sixteen (Architect builds 25% cheaper, Barrister pays 20% less rent,
  Conductor doubles station rent, Tycoon earns 25% more on developed sets, Accountant pays 40% less tax,
  Bailiff is paid when others are jailed, Croupier hustles free and twice a lap, Drifter nudges its token…).
  Each pays a bonus on every GO and **promotes** on the 3rd and 6th lap to ×1.5 then ×2.
- **A guided tour.** Seven coach marks over the live interface, offered on the first game and available
  any time from the menu.
- **Twelve palettes**, each with light and dark variants, and a bench of 20 piece colours —
  every player picks their own shape and colour.
- **Five minigames.** Vault Run, Safecracker, Rush Hour, Market Rush and Night Shift, triggered by Civic
  Plaza, cards, a job action, or a $75 ante once per lap.
- **A living economy.** A market index drifts each round and scales all rent between ×0.70 and ×1.35.
- **Skyscrapers**, one tier above hotels, paying 1.6× hotel rent.
- **Bank services** — loans up to $600 at 10% per lap, and rent insurance.
- **Manual correction**, because the table always gets ahead of the app. Every adjustment is logged.

House rules (starting cash, salary, auctions, even-build, free-parking pot, skyscrapers, economy, loans,
and whether the app rolls the dice or you enter your own physical rolls) are all toggleable at setup.

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
| `POST` | `/api/rooms/:code/piece` | claim a playing piece in the lobby |
| `POST` | `/api/rooms/:code/say` | table chat |
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
