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
| SMAP soil moisture | **Discovery only.** Newest acquisition date is real; values are not served |
| GPM IMERG rain | **Discovery only.** Same |

SMAP and IMERG files need an Earthdata Login (documented by NSIDC for SMAP). The server can hold **one** project
token so farmers never log in, but the read path could not be tested where this was built. To test it yourself:

```bash
# PowerShell:  $env:EARTHDATA_TOKEN = "your-token"      bash: export EARTHDATA_TOKEN="your-token"
python backend/tools/validate_earthdata.py
```

Until that prints `PASS` for both products, the API keeps saying `discovery_only`. It never invents values.

To build a **recent SMAP soil-moisture and IMERG rain** reader we first need real answers from NASA about how one point can be
requested without downloading whole files. `python backend/tools/probe_opendap.py` (needs your token in `EARTHDATA_TOKEN`)
asks NASA's OPeNDAP service and writes `opendap_probe_report.txt`. It could not be completed from the build environment, whose
network proxy does not show whether the token is attached (the answer was the same with a valid and an invalid token).

## Configuration (environment variables only)

| Variable | Meaning | Default |
|---|---|---|
| `EARTHDATA_TOKEN` | optional server-side token for SMAP/IMERG. **Never commit it, never put it in `app/`** | none |
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
cd backend && python -m pytest tests -q          # 55 tests, no network needed
node tests/nasa.test.js                          # panel rendering, from the repo root
```

Tests use **real API responses captured on 2026-11-14** (`backend/tests/fixtures`, `tests/fixtures`), not invented data.
