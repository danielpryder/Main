# Vancouver Tee Times

A small self-hosted web app (plus CLI) that checks tee time availability across eight
Metro Vancouver public courses for a chosen date, time and group size (1 to 4 golfers):

| Course | City | Booking platform | How this app checks it |
|---|---|---|---|
| Furry Creek Golf & Country Club | Furry Creek | Chronogolf (Lightspeed Golf) | Live, open marketplace API |
| Northlands Golf Course | North Vancouver | Club Prophet (CPS) Online Reservation v4 | Live, tee-sheet API used by the booking page |
| Northview Golf & Country Club | Surrey | Chronogolf | Live (Ridge and Canal) |
| Morgan Creek Golf Course | South Surrey | CPS v4, also listed on Chronogolf | Live; CPS first, Chronogolf fallback |
| Mayfair Lakes Golf & Country Club | Richmond | Total e Integrated (GolfBC) | Link out (no public feed) |
| The Redwoods Golf Course | Langley | Course site / Gallus Golf app | Link out (no public feed) |
| Kings Links by the Sea | Delta | CPS legacy v3 (server-rendered) | Live, HTML scrape |
| Fraserview Golf Course | Vancouver | Chronogolf (City of Vancouver) | Live, open marketplace API |

Pick a day on the calendar, a tee time (or "any time"), a window around it, how many are
playing, and the app queries every course in parallel, filters to slots that can seat your
group, and links each slot straight to the booking page.

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Demo the UI without touching the real booking sites:

```bash
MOCK_PROVIDERS=1 npm run dev
```

Command line:

```bash
npm run check -- --date 2026-09-26 --time 09:00 --players 2 --window 90
npm run check -- --date 2026-09-26 --players 4 --courses fraserview,northlands --json
```

Other scripts: `npm test` (fixture-based unit tests), `npm run typecheck`, `npm run discover`.

## How it works

```
public/            calendar UI (vanilla JS, no build step)
src/server.ts      Express: GET /api/courses, GET /api/availability, serves public/
src/cli.ts         same query from the terminal
src/services/      fan-out across courses, time-window + party-size filtering, TTL cache
src/providers/     one adapter per booking platform
config/courses.json  the eight courses and their provider settings
```

`GET /api/availability?date=YYYY-MM-DD&time=HH:MM&players=2&window=90&holes=18&courses=a,b`

Each course result carries a `status`:

- `ok` with `times` (nearest to the requested time first, each with open spots, per-player price
  where the platform reports it, and a booking link);
- `manual` for courses that have to be checked on their own site (Mayfair Lakes, Redwoods);
- `error` when the platform could not be reached or blocked the request; the booking link is
  still returned so you can check by hand.

`beyondWindow` / `bookingOpens` tell you when a date is further out than the course's public
booking window (for example Fraserview and Northlands open 5 days ahead).

### Provider notes

**Chronogolf** (Furry Creek, Northview, Fraserview, Morgan Creek fallback). Chronogolf club pages
embed their course UUIDs; the adapter reads them on first use and calls the modern
`/marketplace/v2/teetimes` endpoint. If a club page carries no UUIDs, it falls back to the classic
numeric API (`/marketplace/clubs/{id}/teetimes`, one `affiliation_type_ids[]` per player), probing
which public player type actually sells online. Run `npm run discover` to print the ids and pin
them in `config/courses.local.json` so startup skips discovery. Chronogolf rate-limits bursts
(HTTP 429); results are cached for two minutes by default.

**CPS v4** (Northlands, Morgan Creek). Calls the same `RegisterTransactionId` + `TeeTimes` API the
`*.cps.golf/onlineresweb` booking page uses, with an anonymous token from the site's identity
server. Some CPS installs sit behind a strict Cloudflare tier and answer 403 to non-browser
clients; those come back as `error` with the booking link. If a site needs its per-site
`x-apikey` / `x-websiteid`, copy them from the browser's Network tab on the booking page and
add `apiKey` / `websiteId` to the provider config. `courseIds`, `classCode` and
`memberStoreId` default to `1`, `R`, `1`; adjust them if the site's own request uses different
values.

**CPS v3** (Kings Links). The legacy server-rendered booking site. The adapter follows the
session redirect and scrapes tee times out of the HTML.

**Link out** (Mayfair Lakes, Redwoods). Their booking engines have no public availability feed
that could be confirmed, so the app shows the booking link and the course's booking rules.
Adding an adapter later only requires a new class in `src/providers/` and a config entry.

## Publishing it as a live web page

The app has to run as a Node server (it calls the booking sites on your behalf), so it needs a
host that runs containers rather than static pages. The repo ships a `Dockerfile` and a
`render.yaml`, which makes Render's free tier a one-click deploy:

1. Sign in at https://render.com with your GitHub account and let it see this repository.
2. Click **New > Blueprint**, pick this repo and branch, and accept the `render.yaml` it finds.
3. Render builds the Docker image and gives you a URL like `https://vancouver-tee-times.onrender.com`.
   Every push to the branch redeploys automatically.

The same `Dockerfile` works unchanged on Railway (`New Project > Deploy from GitHub`),
Fly.io (`fly launch`), or any VPS with Docker:

```bash
docker build -t tee-times .
docker run -p 3000:3000 tee-times
```

Things to know about hosting it:

- **Free tiers sleep.** Render's free service spins down after 15 idle minutes and takes
  about 30 seconds to wake on the first visit. The paid tier (or Railway/Fly) stays warm.
- **Cloud IPs get blocked more than home IPs.** The CPS sites (Northlands, Morgan Creek) sit
  behind Cloudflare, which is stricter with datacenter addresses. If a course shows
  "couldn't fetch" only when hosted, run it at home instead: a Raspberry Pi or an always-on
  laptop plus a free Cloudflare Tunnel or Tailscale Funnel gives you a public URL from your
  own IP.
- **It is public.** Anything at that URL can be used by anyone who finds it, and each check
  hits the courses' booking sites. Keep the cache on (it is by default), and if you want to
  keep it to yourself, put it behind your host's access control (Render and Cloudflare both
  offer this) rather than leaving it open.
- `config/courses.local.json` (discovered ids, CPS api keys) is git-ignored, so a hosted
  deploy will not have it. Either pin those values in `config/courses.json` before pushing,
  or rely on runtime discovery, which works without the file.

## Configuration

`config/courses.json` is tracked. Put machine-specific overrides (discovered ids, api keys) in
`config/courses.local.json`, which is git-ignored and merged by course `id`:

```json
{
  "courses": [
    { "id": "fraserview", "providers": [{ "type": "chronogolf", "slug": "fraserview-golf-course", "courseUuids": ["..."] }] }
  ]
}
```

Environment variables (see `.env.example`): `PORT`, `CACHE_TTL_SECONDS`, `PROVIDER_TIMEOUT_MS`,
`MOCK_PROVIDERS=1`.

## Caveats

- Availability is read from each platform's own booking front end, not from an official API,
  so a platform redesign can break an adapter. The adapters parse defensively and report
  `error` rather than silently showing "no times".
- The adapters were built from the request shapes those booking pages currently use, but the
  sandbox this project was written in could not reach the golf sites, so the first real run is
  the acceptance test: `npm run discover` walks every live course and reports what it got back.
- Where a platform does not report open spots per slot, `openSpots` is `null` and the slot is
  still shown, marked "spots not reported".
- Be polite: this is for personal use. Keep the cache on and do not poll in a tight loop.
