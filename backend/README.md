# NASA data backend (FastAPI)

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
| `GET /api/ndvi?lat=&lon=&months=12` | MODIS greenness series for the 250 m pixel | ~7-11 s first time for a pixel, ~0.01 s after |

Every block has a `provenance` object: `source`, `dataset`, `kind` (`reanalysis` / `satellite_estimate` /
`calculated` / `observation`), `spatial_resolution`, `data_through`, `data_age_days`, `fetched_at`,
`served_from_cache`, and `is_live` (always `false`: nothing here is real-time).

## What works today, and what does not

| Source | Status |
|---|---|
| NASA POWER (temperature, rain, humidity, solar, modelled soil wetness) | **Working, verified live**, no key |
| MODIS NDVI 250 m through the anonymous Planetary Computer STAC | **Working, verified live**, no account |
| SMAP soil moisture | **Discovery only.** Newest acquisition date is real; values are not served |
| GPM IMERG rain | **Discovery only.** Same |

SMAP and IMERG files need an Earthdata Login (documented by NSIDC for SMAP). The server can hold **one** project
token so farmers never log in, but the read path could not be tested where this was built. To test it yourself:

```bash
# PowerShell:  $env:EARTHDATA_TOKEN = "your-token"      bash: export EARTHDATA_TOKEN="your-token"
python backend/tools/validate_earthdata.py
```

Until that prints `PASS` for both products, the API keeps saying `discovery_only`. It never invents values.

## Configuration (environment variables only)

| Variable | Meaning | Default |
|---|---|---|
| `EARTHDATA_TOKEN` | optional server-side token for SMAP/IMERG. **Never commit it, never put it in `app/`** | none |
| `ALLOWED_ORIGINS` | comma-separated list of sites allowed to call the API, e.g. `https://you.github.io` | `*` |
| `CACHE_DB` | SQLite file for the cache | `backend/cache.sqlite3` |
| `RATE_LIMIT_PER_MIN` | requests per IP per minute | 60 |
| `TTL_POWER`, `TTL_MODIS_SEARCH`, `TTL_MODIS_PIXEL`, `TTL_CMR` | cache lifetimes in seconds | 6 h, 12 h, 30 d, 3 h |

For a real deployment set `ALLOWED_ORIGINS` to your site instead of `*`.

## Hosting

GitHub Pages can host only the static site, so this backend needs a separate host. Any service that runs a Python web
app or a container works (Render, Fly.io, Railway, a small VPS). `Dockerfile` is included but **was not built in the
environment where this was written**. Free tiers sleep when idle, so the first request after a pause can take longer.
SQLite on a host with no persistent disk is emptied on restart; the cache then simply refills (POWER asks clients to
make one request per grid cell, which the cache enforces while it lives). For heavier use switch the `Cache` class to
Postgres or Redis, as the interface is two methods.

## Tests

```bash
cd backend && python -m pytest tests -q          # 40 tests, no network needed
node tests/nasa.test.js                          # panel rendering, from the repo root
```

Tests use **real API responses captured on 2026-11-14** (`backend/tests/fixtures`, `tests/fixtures`), not invented data.
