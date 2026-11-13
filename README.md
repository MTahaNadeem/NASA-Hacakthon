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

## Build the real data (one command)

```powershell
pip install requests
$env:EARTHDATA_USER="your_username"; $env:EARTHDATA_PASS="your_password"   # free NASA Earthdata Login (needed for MODIS + SMAP)
python pipeline/run_all.py
```
`run_all.py` fetches NASA POWER climate and SoilGrids soil for every place in `pipeline/locations.json`, submits the NASA AppEEARS
jobs for MODIS NDVI and SMAP soil moisture, waits for them (usually minutes to an hour), builds `app/data/*.json`, and prints what each
place actually contains. It is safe to re-run: finished steps are skipped, and AppEEARS jobs are resubmitted only if the list of places
changed. Use `--skip-nasa-login` for POWER + SoilGrids only. Then commit `app/data/`.

Things worth knowing:
- **SoilGrids has no data under built-up land or water**, and most quick picks are city centres. The pipeline therefore uses the nearest
  farmland cell within about 30 km and records the distance; the app shows it under "Data gaps". Soil is a 250 m model estimate:
  for Faisalabad it gives pH about 8.2 and organic matter around 1%, not the "below 0.5%" in newspaper reports.
- AppEEARS returns one CSV for all places; `build_cache.py` splits it by place (`ID` column).
- IMERG (`fetch_imerg.py`) is optional and slow (about 7,000 daily files per place); POWER is the fallback for extreme-rain days.

## Features

- **Summary card** with the best rotation for your priorities, how it compares with the current one, a **confidence** level
  (high / medium / low, with the reasons) and what to ask a local agronomist. Every card has its own confidence badge.
  With only POWER + SoilGrids loaded (any live point) confidence can never be "high"; that is deliberate.
- **Water source** (not sure / irrigated / rain-fed). Irrigated farms are scored on how much water is needed; for rain-fed
  farms a water gap is yield risk, so the water factor moves under the income slider and the water-saving slider switches off.
  Each card shows the typical water gap in mm per year.
- **What-if sliders**: rainfall, and **temperature (+0 to +4 °C)**. Warming re-counts heat days against a threshold lowered by
  the warming (Tmax >= 35 - dT) and frost days against Tmin <= -dT, using counts stored from the real daily data
  (`heat_by_dt` / `frost_by_dt`). Evaporation (water demand) is not adjusted. Cached files built before this feature need
  `python pipeline/build_cache.py` re-run to enable the temperature slider; live points have it automatically.
- **Crop rules tab**: a local expert can edit water need, sowing/harvest month and pH range per crop, and add a **source or note**
  (listed under "Crop rule sources" and in the print report). Only those fields change; heat/frost/rain-sensitive months stay as in the template.
- **Compare places**: any quick pick next to the current place, using the same priorities, water source and crop rules.
- **Share link**: "Copy link" stores location, priorities, water source, scenarios, edited crop rules, tab and compared place in the URL.
- **Print / save PDF**: a clean report with every tab, details expanded, the link and a disclaimer.
- **Installable and offline**: a service worker caches the app and cached places (needs https or localhost). Live APIs and map tiles are never cached.
- **Accessibility**: axe-core finds no violations in light, dark, right-to-left and phone layouts across all tabs.

## Quick picks, search and "use my location"

- **Quick picks** (`app/places.json`): Lahore (default), Islamabad, Rawalpindi, Ludhiana, Dhaka, Nairobi, Londrina, Toowoomba and Ames.
  A place with a cache file in `app/data/` opens instantly with every NASA source; any other place loads live
  (NASA POWER + SoilGrids). To cache them all, run the pipeline (it reads `pipeline/locations.json`, which lists the same places).
  Note: AppEEARS jobs submitted earlier covered only the old points. To include the new ones, delete the entries in
  `pipeline/raw/_appeears/tasks.json` and run `python pipeline/appeears.py submit` again.
- **Search suggestions** use the free Open-Meteo geocoding API (no key) and return names in the chosen language.
- **Use my location** asks the browser for permission (needs https or localhost). The position is only used to request data for that point.
- **Map tiles** are OpenStreetMap standard tiles (no API key). CARTO's free tiles now show an "API key required" watermark.

## Languages

The language switcher (top right) offers English, اردو (Urdu), हिन्दी (Hindi), العربية (Arabic), বাংলা (Bengali),
Español, Français, Português, Kiswahili and 中文. Urdu and Arabic switch the whole layout to right-to-left.
The choice is remembered, and `?lang=ar` in the URL forces a language.

**The translations were written by an AI and have not been reviewed by native speakers.** Have a fluent speaker
check at least Urdu (the hero case) before the submission, especially agronomy terms. To add a language: copy
`app/i18n/en.js` to `app/i18n/<code>.js`, translate the values, add it to `LANGS` in `app/i18n.js`, then run
`node tests/i18n.test.js`, which checks that every key and `{placeholder}` is present.

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
