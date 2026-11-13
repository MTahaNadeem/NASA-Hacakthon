# Rotation Explorer (NASA Space Apps 2026: Adapting Farms with NASA Data)

A map-based web tool that compares at least three crop rotations for a field location using NASA
POWER, MODIS, SMAP and GPM IMERG data plus SoilGrids soil data. Every result shows its evidence, its
uncertainty range and its data gaps, and tells the user when to check with a local agronomist.

Hero case: wheat-wheat in Punjab (Faisalabad) vs. legume and oilseed rotations. Second region: Ames, Iowa.

## Status (honest)

| Part | State |
|---|---|
| Scoring engine (`app/scoring.js`) | Built, unit-tested (`node tests/scoring.test.js`) |
| Web app (`app/`) | Built, checked in a headless browser |
| `pipeline/build_cache.py` | Built, tested on small fixtures only |
| `fetch_power.py`, `fetch_soilgrids.py`, `appeears.py`, `fetch_imerg.py` | Written from the API docs, **never run** (the build sandbox had no network). Expect small fixes, especially AppEEARS layer names and IMERG access. |
| Data in `app/data/` | **Synthetic placeholders** from `make_placeholder.py`. The app shows a red banner. Not NASA data. |

## Run the app

From the repo root, then open http://localhost:8000:

```bash
python3 -m http.server 8000 --directory app   # Mac/Linux
```
```powershell
python -m http.server 8000 --directory app    # Windows PowerShell (python, not python3; or use: py -m http.server ...)
```

On Windows, use `python` instead of `python3` for every command below, and set variables with
`$env:EARTHDATA_USER="..."` instead of `export`.

## Replace placeholders with real data

```bash
pip install requests earthaccess xarray netCDF4 h5netcdf
export EARTHDATA_USER=... EARTHDATA_PASS=...      # free NASA Earthdata Login
python pipeline/appeears.py layers MOD13Q1.061    # confirm layer names, edit PRODUCTS if needed
python pipeline/appeears.py layers SPL4SMGP.007
python pipeline/appeears.py submit                # queue MODIS + SMAP first (slow)
python pipeline/fetch_power.py
python pipeline/fetch_soilgrids.py
python pipeline/fetch_imerg.py                    # optional; POWER is the fallback
python pipeline/appeears.py status                # repeat until done
python pipeline/appeears.py download
python pipeline/build_cache.py                    # writes app/data/*.json (synthetic: false)
node tests/scoring.test.js && python tests/test_build_cache.py
```
Missing sources become entries in each location's `gaps` list, and the dependent scoring factors are dropped, never faked.

## Deploy

Publish the `app/` folder with GitHub Pages (Settings > Pages > deploy from branch, folder `/app`, or copy to `/docs`).

## Change locations or crops

`pipeline/locations.json` (coordinates, rotations compared) and `app/rotations.json` (crop parameters, rotations).
Crop parameters are team rules of thumb; have an agronomist check them.

## Known limits

- POWER is about 50 km resolution, so results describe an area, not a field.
- SMAP L4 starts in 2015, so it is a shorter record than the 20-year climate series.
- Rainfall scenario slider only; temperature scenarios are not modelled.
- No machine learning and no yield prediction by design.

## AI disclosure

Claude (Anthropic) wrote or reviewed the scoring module, data pipeline scripts and web app. All AI-assisted
output must be reviewed and tested by the team. Scoring rules and data choices are the team's to confirm.

Data credits: NASA POWER, NASA MODIS, NASA SMAP, NASA GPM IMERG; SoilGrids (ISRIC, not NASA).
