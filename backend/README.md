# NASA data backend (FastAPI) - OPTIONAL

> **You do not need to deploy this.** The website reads NASA MODIS and ISRIC soil data directly in the browser (`app/direct.js`), free, on GitHub Pages, with no account or card. This backend is an optional extra: faster first loads with a shared cache, weather indicators, and the place to add SMAP/IMERG values later (they need a server-side Earthdata login). Deploying it needs a host account, and some free hosts ask for a card.

Gives the app real NASA data for **any coordinate**, with no farmer login, no API key in the browser and no
waiting for an AppEEARS job. Read `docs/NASA-DATA-ARCHITECTURE.md` first: it explains what was verified, what
was not, and why.

## Run it

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000
```

Then try `http://localhost:8000/api/location?lat=31.55&lon=74.35` or open `http://localhost:8000/docs`.

To let the website use it, set the address in `app/config.js`:

```js
window.AGRISHIFT = { backendUrl: "http://localhost:8000" };
```

A **NASA data** tab then appears. With `backendUrl` empty the tab stays hidden and the app works exactly as before.

## Endpoints

| Endpoint | Returns | Typical time |
|---|---|---|
| `GET /api/health` | status, whether a server Earthdata token is configured (a yes/no only) | instant |
| `GET /api/sources` | every source, its auth needs, status, and what was deliberately **not** used | instant |
| `GET /api/location?lat=&lon=` | weather record, rain, modelled soil wetness, indicators, newest SMAP/IMERG acquisition dates | ~1-3 s first time for a grid cell, ~0.1 s after |
| `GET /api/ndvi?lat=&lon=&months=12` | MODIS greenness series for the 250 m pixel, plus a 12-month climatology (`monthly_mean`, months with fewer than 2 composites left blank) | ~7 s for 12 months, ~15-22 s for 36 months the first time; ~0.01 s after |
| `GET /api/recent?lat=&lon=` | **Needs `EARTHDATA_TOKEN`.** Last 30 days of NASA IMERG rain (Late run) and SMAP soil moisture for the 0.1 degree cell. Runs in the background: returns `running` (with each product as soon as it is ready), then `ready` | rain ~15-20 s, soil moisture ~30 s alone; longer if several places are read at once |
| `GET /api/soil?lat=&lon=` | SoilGrids pH, organic carbon, clay, sand, silt (5th/50th/95th percentile) for the nearest mapped land, with the distance. **Not NASA** | ~4-6 s first time for a pixel, instant after |

Every block has a `provenance` object: `source`, `dataset`, `kind` (`reanalysis` / `satellite_estimate` /
`calculated` / `observation`), `spatial_resolution`, `data_through`, `data_age_days`, `fetched_at`,
`served_from_cache`, and `is_live` (always `false`: nothing here is real-time).

## What works today, and what does not

| Source | Status |
|---|---|
| NASA POWER (temperature, rain, humidity, solar, modelled soil wetness) | **Working, verified live**, no key |
| MODIS NDVI 250 m through the anonymous Planetary Computer STAC | **Working, verified live**, no account |
| ISRIC SoilGrids soil (not NASA) | **Working, verified live.** Read from ISRIC's tiled maps (the REST API took 38-60+ s and sometimes timed out) |
| SMAP soil moisture, GPM IMERG rain | **Recent 30-day values work with a server token** (`/api/recent`, verified live). Without a token: newest date only. Not used in the score |

SMAP and IMERG files need an Earthdata Login (documented by NSIDC for SMAP). The server can hold **one** project
token so farmers never log in, but the read path could not be tested where this was built. To test it yourself:

```bash
# PowerShell:  $env:EARTHDATA_TOKEN = "your-token"      bash: export EARTHDATA_TOKEN="your-token"
python backend/tools/validate_earthdata.py
```

Until that prints `PASS` for both products, the API keeps saying `discovery_only`. It never invents values.

### Recent SMAP soil moisture and IMERG rain (needs a NASA token on the server)

Both datasets need an Earthdata Login (NASA redirects to the login page, verified). A server can hold one token so farmers never log in.
The token is used with NASA **Harmony**, which cuts a small box and a date range out of the daily files, so only tens of kilobytes move.
Verified live on 2026-11-14 with a real token:

| | IMERG daily (Late run) | SMAP L3 9 km (morning pass) |
|---|---|---|
| Harmony job | ~9 s | ~30-45 s |
| Files returned | one ~34 KB file per day | one ~35 KB file per day |
| Reading | `precipitation`, mm/day, fill -9999.9 | `soil_moisture`, m3/m3, valid 0.02-0.5, fill -9999 |

What you must do once:
1. Earthdata account: **Applications -> Authorized Apps -> Approve More Applications**, approve the GES DISC and NSIDC applications (and Harmony).
   Without this, jobs fail with 403.
2. Create a token (Earthdata profile -> **Generate Token**; valid ~60 days) and set it as `EARTHDATA_TOKEN` in the Render dashboard
   (Environment tab). Never put it in the repository or in `app/`. Renew it before it expires.

Honest limits: these are **recent values only** (last 30 days), shown as extra evidence and **not used in the score** (the score needs
20-year baselines, which cannot be built on demand). SMAP passes a place only every 2-3 days, so most days have no reading. IMERG Late is a
preliminary estimate. Many places read at once slow NASA's queue down for everyone (measured: ~30 s alone, 110 s+ with overlapping runs), so the
server reads at most two places at the same time. Without a token `/api/recent` says `not_configured` and the site shows only the newest-date notice.

`tools/probe_opendap.py` and `tools/validate_earthdata.py` were used to find this route and are kept for troubleshooting.

## Configuration (environment variables only)

| Variable | Meaning | Default |
|---|---|---|
| `EARTHDATA_TOKEN` | server-side token for recent SMAP/IMERG values (`/api/recent`). **Never commit it, never put it in `app/`** | none |
| `ALLOWED_ORIGINS` | comma-separated list of sites allowed to call the API, e.g. `https://you.github.io` | `*` |
| `CACHE_DB` | SQLite file for the cache | `backend/cache.sqlite3` |
| `RATE_LIMIT_PER_MIN` | requests per IP per minute | 60 |
| `TTL_POWER`, `TTL_MODIS_SEARCH`, `TTL_MODIS_PIXEL`, `TTL_CMR` | cache lifetimes in seconds | 6 h, 12 h, 30 d, 3 h |

For a real deployment set `ALLOWED_ORIGINS` to your site instead of `*`.

## Deploy it (free, about 5 minutes, needs your own account)

GitHub Pages can only host the static site, so this backend runs on a separate free host. The repository root has a
`render.yaml` blueprint (**not tested: it needs a Render account, which cannot be created for you**).

1. Sign up at https://render.com with your GitHub account (no card needed for the free plan).
2. **New +  ->  Blueprint**, choose this repository, click **Apply**. Wait for the build (a few minutes).
3. Open `https://<your-service>.onrender.com/api/health`. You should see `{"status":"ok", ...}`.
4. Put that address in `app/config.js` (`backendUrl`), commit and push. GitHub Pages redeploys on its own.
5. If your GitHub Pages address is not `https://mtahanadeem.github.io`, change `ALLOWED_ORIGINS` in the Render dashboard.

Things to know about the free plan: the service **sleeps when idle** (the site pings it as soon as the page opens to wake it,
but the first visitor after a quiet period can wait about a minute); it has **no persistent disk**, so the cache is emptied on
restart and refills as people use it (it is what keeps us within POWER's one-request-per-grid-cell guidance, so heavy traffic
after a restart means more upstream requests). For serious use, switch the `Cache` class to Postgres or Redis; it has two methods.
A `Dockerfile` is also included for other hosts but **was not built** where this was written.

If the backend is down or asleep the site keeps working: soil falls back to the slow SoilGrids API, the NASA tab shows a clear
error, and nothing is invented.

## Tests

```bash
cd backend && python -m pytest tests -q          # 82 tests, no network needed
node tests/nasa.test.js                          # panel rendering, from the repo root
```

Tests use **real API responses captured on 2026-11-14** (`backend/tests/fixtures`, `tests/fixtures`), not invented data.
