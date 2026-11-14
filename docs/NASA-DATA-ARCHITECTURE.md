# NASA data architecture for AgriShift AI / Rotation Explorer

Status: research done 2026-11-14. Implemented in `backend/` (POWER + MODIS working; SMAP/IMERG discovery only). Frontend panel in `app/nasa.js`.
Everything marked **VERIFIED** was run against the live service from this
project's build environment on that date. Everything marked **DOCUMENTED**
comes from NASA/NSIDC/POWER pages but was not exercised here. Anything else is
marked **NOT VERIFIED**. Nothing in this file is assumed.

## 1. What is wrong with the current approach

| Problem | Where it shows up |
|---|---|
| The only "real" NASA sources beyond POWER (MODIS, SMAP, IMERG) are fetched by an **offline pipeline** that needs the *builder's* Earthdata login (`pipeline/appeears.py`, `run_all.py`, `fetch_imerg.py`). | A visitor who picks a new place gets POWER + SoilGrids only. MODIS / SMAP / IMERG exist only for the 10 pre-built places. |
| AppEEARS is an **asynchronous job queue** (submit, wait minutes to hours, download). | Cannot answer "I clicked a map location" in seconds. Fine for a batch job, wrong for a farmer. |
| Satellite results are baked into static JSON on GitHub Pages. | Nothing refreshes; data age is invisible; no per-request provenance. |
| The browser calls POWER and SoilGrids directly with no cache. | POWER's own documentation warns that repeated requests for the same grid cell "will potentially be blocked". A popular site would hit that. |
| The UI does not show what is observation, model, or calculation, nor how old it is. | Violates the project rule to distinguish them. |

Keeping AppEEARS as the *mandatory* path is therefore the wrong design. It stays
only as an optional offline tool for building a research cache.

## 2. Per-service findings

### NASA POWER  - VERIFIED, no key, no login
* `GET https://power.larc.nasa.gov/api/temporal/daily/point?...` returned HTTP 200 in about 1 s with **no key and no account**.
* Parameter catalogue (`/api/system/manager/parameters?community=ag&temporal=daily`) lists 152 parameters, including `T2M`, `T2M_MAX`, `T2M_MIN`, `PRECTOTCORR`, `RH2M`, `ALLSKY_SFC_SW_DWN`, `WS2M`, `GWETTOP`, `GWETROOT`, `GWETPROF`, `EVLAND`, `T2MDEW`, `PS`, `TS`, `FROST_DAYS`.
* **`IMERG_PRECTOT` is listed in the catalogue but returned -999 (fill value) for every date tested** (2001-01, 2015-06, 2023-07, 2025-06, 2026-06, Lahore). It is **not usable** and the backend rejects it.
* Latency: on 2026-11-14 the newest valid day was 2026-11-11 (about 3 days).
* Resolution (DOCUMENTED, POWER methodology page): meteorology 1/2 degree lat x 5/8 degree lon, radiation 1 x 1 degree. VERIFIED behaviour: points 15 km apart inside one cell returned identical values; the cell edges measured on the live API sit exactly at lon 74.6875 and lat 31.25 / 31.75, matching a 0.5 x 0.625 degree grid (tested in `backend/tests/test_grid_power.py`).
* Limits (DOCUMENTED, daily API page): at most 20 parameters per point request; do not repeat requests for the same cell.
* Nature of the data: MERRA-2 **reanalysis** and satellite-derived radiation (response header `sources: MERRA2, SYN1DEG, POWER`). Not a direct satellite observation of rain or soil.

### SMAP (soil moisture)  - discovery VERIFIED, data access needs Earthdata Login
* CMR search is public: latest `SPL3SMP_E` granule was dated 2026-11-12 (about 2 days old). VERIFIED.
* NSIDC page states: "A free NASA Earthdata Login account is required to access these data." DOCUMENTED. L3 9 km, daily, 31 Mar 2015 to present, HDF5, EASE-Grid 2.0.
* Granules are in "protected" Earthdata Cloud storage. OPeNDAP and direct-S3 links are listed by CMR. DOCUMENTED via CMR.
* **NOT VERIFIED:** an actual value read for a coordinate. The build environment cannot send a user token to NSIDC hosts, so this path has not been run.
* Consequence: a farmer never needs an account, but the **server** needs one project Earthdata token. It is a server secret, never sent to a browser.

### GPM IMERG (rain)  - discovery VERIFIED, data access NOT VERIFIED
* Latest `GPM_3IMERGDL` (daily, V07) granule: 2026-11-12. VERIFIED via CMR.
* Files sit on `data.gesdisc.earthdata.nasa.gov`. GES DISC documentation pages were unreachable from the build environment, so the exact access terms are **NOT VERIFIED here**; treat as Earthdata-login protected until checked.
* POWER's IMERG parameter is empty (see above), so there is **no verified instant IMERG route today**.
* Planetary Computer holds an IMERG copy but it **ends 2021-05-31** - useless for current rain. VERIFIED from the STAC catalogue.

### MODIS (NDVI, LST, LAI, GPP, ET)  - VERIFIED, no login
* Planetary Computer STAC (`planetarycomputer.microsoft.com/api/stac/v1`) lists `modis-13Q1-061` (NDVI/EVI 250 m, 16-day), `modis-11A2-061` (LST 8-day), `modis-15A2H-061` (LAI), `modis-17A2H-061` (GPP), `modis-16A3GF-061` (ET, yearly), all ongoing.
* The assets are Cloud-Optimized GeoTIFFs. A signed URL comes from `/api/sas/v1/sign?href=...` with **no account**.
* **VERIFIED end to end:** a single-pixel read for Lahore returned NDVI 0.531 (farmland) and 0.461 (urban core) in **1.9 s total**. Latest composite 2026-10-08 to 2026-10-23.
* Gotcha found while testing: the collection-level token is scoped to a different container than the COGs; use the per-asset `sign` endpoint.
* Resolution 250 m (231.66 m sinusoidal pixel), 16-day composites, global.
* Latency: the newest composite ended 2026-10-23, so about 3 weeks behind. Must be shown as such.
* The ORNL MODIS web service failed TLS inside the build environment ("self-signed certificate in chain"). **Not usable by me, NOT VERIFIED**, and not needed.

### Other services evaluated

| Service | Verdict |
|---|---|
| Hydrology Data Rods (GLDAS point time series) | **Being discontinued** (service redirects to a NASA notice). VERIFIED. Do not build on it. GLDAS files themselves need Earthdata Login (DOCUMENTED). POWER `GWET*` (MERRA-2) is the practical instant stand-in. |
| NASA GIBS (map imagery tiles) | WMTS capabilities VERIFIED, no key; layers include `IMERG_Precipitation_Rate`, `MODIS_Terra_NDVI_8Day`. Pictures only, not numbers; useful as optional map overlays later. |
| Landsat C2 L2 (30 m, 16-day) | Available through the same anonymous STAC (VERIFIED in catalogue). Field-scale but heavier (cloud masking, many scenes). Phase 2. |
| Sentinel-2 L2A (10 m) | ESA/Copernicus, **not NASA**. Same anonymous STAC. Excellent for field scale; list as optional non-NASA add-on. |
| VIIRS | Not in the Planetary Computer listing. Would need Earthdata Login (LAADS/LP DAAC). Skip; MODIS covers the need. |
| ECOSTRESS | Irregular ISS overpasses, not a regular global product, Earthdata Login. Not practical for a farmer tool. |
| ERA5 | ECMWF/Copernicus, **not NASA**. Present in the STAC. Would duplicate POWER. Skip. |
| NEX-GDDP-CMIP6 (NASA downscaled climate projections, 0.25 deg, to 2100) | Present in STAC (VERIFIED): `pr, tas, tasmax, tasmin, hurs, rsds...`. Assets are large per-model per-year NetCDF files, not point-friendly. Best candidate for the "climate-adaptive" claim, but needs a **pre-extraction job**. Phase 2. |
| FAO GAEZ | FAO, not NASA. **Not tested**; no point API verified. Could be pre-processed as static layers later. |

## 3. Comparison table

| Dataset / service | Data provided | Global coverage | API | Auth | Instant for a coordinate? | Latency | Spatial / temporal resolution | Integration method |
|---|---|---|---|---|---|---|---|---|
| NASA POWER daily | Temp, rain, humidity, radiation, wind, MERRA-2 soil wetness | Yes | REST JSON | None (VERIFIED) | **Yes, ~1 s** | ~3 days | 0.5 x 0.625 deg met; 1 deg radiation; daily, 1981-near present | Backend call, cache per grid cell |
| MODIS NDVI via STAC (MOD13Q1/MYD13Q1) | Vegetation greenness | Yes | STAC + COG | None (VERIFIED) | **Yes, ~2 s per pixel** | ~3 weeks | 250 m; 16-day; 2000-present | Backend, windowed COG read, cache per 250 m cell |
| MODIS LST / LAI / GPP | Surface temp, leaf area, productivity | Yes | STAC + COG | None (catalogue VERIFIED, read not run) | Expected yes (same route) | days-weeks | 500 m-1 km; 4-8 day | Same adapter, phase 2 |
| SMAP L3 9 km | Satellite surface soil moisture | Yes (to 85 S) | CMR + OPeNDAP/HTTPS | **Earthdata Login** (DOCUMENTED) | **Not verified** | ~2 days (CMR) | 9 km; daily; 2015-present | Server-side token, prefetch+cache; discovery live |
| GPM IMERG daily | Satellite rain | Yes | CMR + OPeNDAP | Assumed Earthdata Login, NOT VERIFIED | **Not verified** | ~2 days (CMR) | 0.1 deg; daily; 2000-present | Same as SMAP, discovery live |
| POWER `GWET*` | Modelled soil wetness (top/root/profile) | Yes | REST | None (VERIFIED) | Yes | ~3 days | MERRA-2 grid; daily | Interim soil-moisture indicator, **labelled reanalysis** |
| NEX-GDDP-CMIP6 | Downscaled climate projections | Yes | STAC + NetCDF | None | No (large files) | static | 0.25 deg; daily; to 2100 | Offline extraction job, phase 2 |
| Landsat C2 L2 | 30 m reflectance | Yes | STAC + COG | None | Likely, not run | days | 30 m; 16-day | Phase 2 |
| AppEEARS | Subsetting of many products | Yes | REST, async jobs | Earthdata Login | **No** (queue) | minutes-hours | product dependent | Offline batch only, never per farmer |

## 4. Proposed architecture

```
Browser (static app on GitHub Pages)       FastAPI backend (Render/Fly/any host)
  map pin / search  ------------------->   GET /api/location?lat=&lon=
  shows data + provenance chips            |
                                           +-- cache (SQLite, key = source + grid cell, TTL per source)
                                           |        hit -> return stored value + its original fetch time
                                           |        miss -> call provider
                                           +-- providers
                                           |     power.py   NASA POWER REST        (no auth)
                                           |     modis.py   STAC + COG pixel read  (no auth)
                                           |     smap.py    CMR discovery live; values only if EARTHDATA_TOKEN set and reader validated
                                           |     imerg.py   CMR discovery live; same rule
                                           +-- indicators.py  calculated from provider output
                                           +-- every value carries a provenance record
```

Rules the design enforces:
1. **Farmers never authenticate.** The browser only talks to this project's backend.
2. **Secrets live in backend environment variables** (`EARTHDATA_TOKEN`). Never in frontend code, never in git, never returned by any endpoint.
3. **Cache key = native grid cell**, not the typed coordinate: 0.5 x 0.625 deg for POWER, ~250 m for MODIS. That respects POWER's one-request-per-cell guidance and makes nearby farmers share one fetch.
4. **Provenance on every value**: `source`, `dataset`, `kind` (`observation` | `satellite_estimate` | `reanalysis` | `calculated`), `units`, `spatial_resolution`, `period`, `data_through`, `fetched_at`, `latency_note`. The UI shows these.
5. **No mock data.** If a provider fails or has not been validated, the response says `status: "unavailable"` with a reason and the UI shows the gap.
6. **No "live" claims.** Each block carries `data_through`; freshness labels are computed from it.
7. **Slow things never block the farmer.** The location endpoint returns whatever is ready (POWER first), and heavier layers load in separate calls (progressive loading, same pattern the frontend already uses for soil).

### Where non-instant data is handled
SMAP and IMERG files are large global granules. The plan, in order of effort:
1. **Show the newest available acquisition date** (live from CMR) so the farmer sees how fresh the satellite record is.
2. **Prefetch**: a scheduled worker downloads the newest daily granule once (not per farmer) and stores values for the grid cells that farmers asked for.
3. **Background job for a new cell**, returning "pending" immediately plus the last cached state and a freshness timestamp, instead of blocking.
4. **Fallback shown clearly**: POWER `GWET*` soil wetness (modelled) while SMAP is unavailable, labelled "modelled, not satellite".

### Limitations (honest list)
* POWER values are **cell averages (~50 km)**: two farms in one cell get identical numbers. The UI says so.
* MODIS NDVI is **~3 weeks old** and 250 m pixels mix fields, roads and houses; city pixels are not farmland.
* **SMAP and IMERG values are not delivered yet.** Discovery works; the read path needs one validated Earthdata token and a test I could not run here. The backend reports this plainly rather than faking it.
* Rainfall today comes from MERRA-2 (POWER), which is a **reanalysis estimate**, not IMERG satellite rain.
* SoilGrids is ISRIC, not NASA; labelled as such.
* The backend must be hosted somewhere other than GitHub Pages (free tiers exist, with cold starts).
* The requested stack says React + Vite; the existing frontend is vanilla JS with a full 10-language, tested UI. Rewriting it is out of scope and would risk the working app, so the backend is added alongside it behind a config switch.

## 5. How a brand-new farmer gets NASA data without credentials

1. They open the site and pick a location.
2. The browser sends only `lat` and `lon` to the project backend.
3. The backend snaps to the POWER grid cell, finds the cache entry or makes **one** keyless POWER request (about 1 s), and reads the MODIS pixel through the anonymous STAC route (about 2 s).
4. The response arrives with provenance and ages. The farmer never sees a login, key or job ID.
5. SMAP/IMERG, when enabled, use the **project's** server-side token. Still no farmer credentials.

## 6. Recommended first datasets

1. **NASA POWER daily** - temperature, rain, humidity, solar, soil wetness. Keyless, instant, global. VERIFIED.
2. **MODIS NDVI (250 m) via anonymous STAC** - how green the land is now and over the last years. VERIFIED.
3. **SMAP soil moisture** - the real satellite soil-moisture observation. Staged: discovery now, values after the server token path is validated.
4. **GPM IMERG daily rain** - satellite rain and heavy-rain days. Staged the same way. Until then rain comes from POWER and is labelled as reanalysis.

Next: MODIS LST, NEX-GDDP-CMIP6 projections, Landsat.

## 7. Security checklist
* No Earthdata username, password or token appears in `app/`. A test greps the frontend for secrets.
* `EARTHDATA_TOKEN` is read only from the environment in `backend/`, is never logged and never serialized.
* CORS allow-list is configurable via `ALLOWED_ORIGINS`.
* Input is validated (lat -90..90, lon -180..180); only whitelisted upstream hosts are contacted.
