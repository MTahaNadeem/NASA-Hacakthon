# Rotation Explorer (NASA Space Apps 2026: Adapting Farms with NASA Data)

A map-based web tool that compares at least three crop rotations for a field location using NASA
POWER, MODIS, SMAP and GPM IMERG data plus SoilGrids soil data. Every result shows its evidence, its
uncertainty range and its data gaps, and tells the user when to check with a local agronomist.

Hero case: wheat-wheat in Punjab (Faisalabad) vs. legume and oilseed rotations. Second region: Ames, Iowa.

## Status (honest)

| Part | State |
|---|---|
| Scoring engine (`app/scoring.js`) | Built, unit-tested (`node tests/scoring.test.js`) |
| Web app (`app/`) | Built, 10 languages, checked in a headless browser |
| Any-place lookup in the browser | **Works:** NASA POWER (no key) and SoilGrids (ISRIC, not NASA), fetched live |
| **NASA data backend (`backend/`)** | **New.** POWER, MODIS NDVI and SoilGrids soil verified live with no login. **Not deployed yet:** it must be hosted separately (see `backend/README.md`), otherwise the site runs without it. SMAP and IMERG: newest-acquisition discovery only, values not served yet. See `backend/README.md` |
| `pipeline/` (offline cache builder) | POWER and SoilGrids ran; AppEEARS (MODIS/SMAP) needs an Earthdata login on your own machine; IMERG is optional and slow |
| Data in `app/data/` | **Real NASA POWER** for Faisalabad and Ames. Soil, MODIS, SMAP and IMERG are not in those files, and the app says so in its data-gap notes |

## NASA data architecture

Farmers never log in and no NASA credential is ever in the browser. The browser sends only a latitude and longitude to
the backend, which fetches real NASA data (cached per grid cell) and labels each value as an observation, a model
estimate, a satellite estimate or a calculation, together with how old it is. Read `docs/NASA-DATA-ARCHITECTURE.md` for the
research, the comparison table and the limitations. AppEEARS is no longer part of the farmer path.

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
- **SoilGrids in the browser is best-effort**: it is slow for city locations (a city-centre point can hang for minutes) and the app falls back to weather only, with a note. The cached quick picks use the nearest farmland instead.
- **SoilGrids has no data under built-up land or water**, and most quick picks are city centres. The pipeline therefore uses the nearest
  farmland cell within about 30 km and records the distance; the app shows it under "Data gaps". Soil is a 250 m model estimate:
  for Faisalabad it gives pH about 8.2 and organic matter around 1%, not the "below 0.5%" in newspaper reports.
- AppEEARS returns one CSV for all places; `build_cache.py` splits it by place (`ID` column).
- IMERG (`fetch_imerg.py`) is optional and slow (about 7,000 daily files per place); POWER is the fallback for extreme-rain days.

## Crop calendars, water needs and where they come from

Every crop rule shows a status in the app ("How was this scored?" -> "Crop rule sources"): **Sourced** (taken from a document we read),
**Partly sourced** (a real window from sources, exact months chosen by the team, or only secondary sources) or **Team estimate**.

| What | Source | Status |
|---|---|---|
| Seasonal water need per crop (mm) | FAO *Irrigation Water Management: Irrigation Water Needs*, Training Manual 3, Table 5 (the midpoint of each FAO range is used; rice excludes seepage) | Sourced for wheat, oats, maize, soybean, bean, groundnut, rice, cotton, sugarcane. Chickpea, mustard and mungbean have no FAO row: team estimate |
| Punjab (Pakistan) wheat calendar | FAO/GIEWS *Foodcrops & Shortages 02/02* and FEWS NET Pakistan report, May 2026 (which reproduces the FAO seasonal calendar) | Sourced |
| Punjab rice, cotton, sugarcane | FEWS NET May 2026: kharif planting April to July, harvest September to November; sugarcane spring sowing February to March | Partly sourced (exact months inside the window are ours) |
| Punjab canola / mustard | Punjab Agriculture Department variety table: sown 1-15 October, TM canola is a 130-day variety | Partly sourced (harvest month derived) |
| Punjab chickpea, mungbean | Pakistani agronomy notes and trials, seen as search summaries only | Partly sourced, **not opened by us** |
| Iowa corn, soybean, oats | USDA NASS *Usual Planting and Harvesting Dates for U.S. Field Crops*, Agricultural Handbook 628 (1997), Iowa tables | Sourced |
| Everywhere else | A general template (shifted 6 months south of 10 degrees S) | Team estimate |

Heat, frost and rain sensitivity, pH and clay ranges, and the soil-carbon effect are **team estimates for every crop**. Before presenting,
open the links and check the exact months yourselves (`app/rotations.json` has the quotes we relied on). Regions are approximate bounding
boxes (`regions` in `rotations.json`): the Pakistan box also covers a small part of India near the border.

**My rotation** (tab): pick up to 3 years of up to 2 crops each; it is added to the ranked list and kept in the share link.
New Punjab options: rice + wheat, cotton + wheat, sugarcane.

## How the page is organised (for non-experts)

The page is a light, four-step flow: **1 Where is your farm?** (search, phone location, map, quick picks) -> **2 What matters most to you?**
(three sliders with one-line explanations, plus big buttons for how you water your crops) -> **3 Our suggestion** (best option with a
"Fit /100" meter, "Why it works" and "Watch out for" in everyday words, confidence, and what to ask an agronomist; every option is listed
below with the technical evidence folded under "Evidence and details") -> **4 More details and tools** (field profile, calendar,
what-if sliders, crop rules, compare places). The plain-language sentences come from the six factor scores
(`plain()` in `app/app.js`: a factor scoring 0.7 or more is a strength, 0.5 or less a watch-out). The theme is light only.

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
