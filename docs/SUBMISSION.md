# Submission kit (edit the [brackets] before submitting)

## Project title
Rotation Explorer

## One-line summary
A map-based tool that compares crop rotations for any field using NASA data, and shows the evidence, the uncertainty and the data gaps behind every result.

## Description (paste into the submission form)
Farmers in places like Punjab, Pakistan often grow the same crop on the same land year after year. Soil organic matter has fallen below 0.5% in many areas and irrigation water is getting worse, but the information to judge a change of rotation is scattered across technical satellite datasets with no sense of how certain it is.

Rotation Explorer lets a user pick a location, see a field profile built from NASA data, and compare at least three crop rotations, always including the current one. Priority sliders (water saving, income, soil building) re-rank the rotations live. Each rotation card shows the score as a range across about 20 historical years, the evidence and dataset behind it, benefits and risks, what the data cannot see, and points to confirm with a local agronomist. When two rotations' ranges overlap, the tool says there is no clear winner instead of forcing a ranking.

Scoring is rule-based and fully visible in a "How was this scored?" panel. We did not use machine learning, because there is no labelled rotation-outcome data to train or validate on. The tool does not replace an agronomist; it shows its working and sends users to local experts wherever the data is weak.

Hero case: wheat-on-wheat in Punjab (Faisalabad) versus legume and oilseed rotations. Second region: Ames, Iowa, to show the same tool and rules work on a different climate and soil.

## NASA data used
- NASA POWER: daily rainfall and temperature, heat and frost days (water, heat and extreme-rain rules)
- NASA MODIS MOD13Q1 NDVI via AppEEARS: bare-field windows [confirm if used]
- NASA SMAP L4 SPL4SMGP root-zone soil moisture via AppEEARS: water-factor adjustment [confirm if used]
- NASA GPM IMERG: extreme-rain days and rainfall cross-check [confirm if used]
Non-NASA: SoilGrids (ISRIC) for soil pH, texture and organic carbon with 5th-95th percentile uncertainty.
List only the datasets that are actually in the final cache; check each location's "sources" field in app/data/*.json.

## Features to mention (pick what fits the time limit)
Summary with confidence level; irrigated vs rain-fed; rainfall and temperature what-if sliders; editable crop rules with sources;
compare two places; share link; print report; works offline; 10 languages including Urdu and Arabic (right-to-left).
Do not claim the translations are expert-reviewed unless a fluent speaker has checked them.

## Honest claims about the data (check before you present)
- The "soil organic matter below 0.5%" line in the video storyboard is from Dawn reporting, not from this tool. SoilGrids (a 250 m model) shows
  roughly 1% for Faisalabad. Say "reports say ...", or show the tool's own pH 8.2 / low-carbon numbers instead.
- Name only the NASA datasets actually loaded for the place you demo: check the coloured chips above the results (POWER, SoilGrids, MODIS, SMAP).

## Sources to cite (open each link before presenting)
- FAO, Irrigation Water Management: Irrigation Water Needs, Training Manual 3 (Brouwer & Heibloem), Table 5: https://www.fao.org/4/s2022e/s2022e02.htm
- FAO/GIEWS Foodcrops & Shortages 02/02, Pakistan: https://www.fao.org/4/y6221e/pays/pak0202e.htm
- FEWS NET, Pakistan Special Report, May 2026 (FAO seasonal crop calendar): https://fews.net/asia/pakistan/special-report/may-2026
- Punjab Agriculture Department, Rapeseed & Mustard: https://agripunjab.punjab.gov.pk/node/9623
- USDA NASS, Agricultural Handbook 628 (Iowa): https://esmis.nal.usda.gov/usda-esmis/files/vm40xr56k/9p290c614/j9602330g/planting-12-05-1997.html
- Chickpea and mungbean windows come from secondary Pakistani sources we did not open: say "partly sourced" if asked.

## AI disclosure
AI tools were used in this project. Claude (Anthropic) helped draft the project proposal and wrote or reviewed parts of the code: the scoring module, data-fetch scripts, cache builder and web app. All AI-assisted output was reviewed and tested by the team. Scoring rules, crop parameters and data choices were decided by the team. [Edit to match what your team actually did.]

## 30-second video script
| Time | On screen | Voice-over |
|---|---|---|
| 0-5 s | Text: "Wheat on wheat. Soil organic matter below 0.5%." Punjab fields photo or map | "In Punjab, farmers grow wheat on the same land year after year, and the soil is paying for it." |
| 5-12 s | Click Faisalabad on the map; profile and calendar appear | "Pick a location. Rotation Explorer builds a field profile from NASA data and flags when the field sits bare or stressed." |
| 12-22 s | Three rotation cards with range bars; drag the water-saving slider and the ranking changes | "It compares rotations against your priorities. Each score is a range across twenty years, not one number." |
| 22-27 s | Open a card: evidence, data gaps, "Check with a local agronomist" | "Every result shows its evidence and what the data can't see, and tells you when to ask a local expert." |
| 27-30 s | Switch to Iowa; end card with tagline and NASA data credits | "Rotation Explorer: see the evidence before you change the rotation." |

Record only after real data is loaded (no red banner). Keep it at or under 30 seconds.

## Pre-submit checklist
- [ ] Red PLACEHOLDER banner is gone (real data loaded)
- [ ] Public link works in a private window, no login
- [ ] Video 30 s or less (or 7 slides or fewer), confirmed against the 2026 guide
- [ ] NASA datasets named match what is really in the cache
- [ ] SoilGrids / ISRIC credited
- [ ] AI use disclosed
- [ ] Submitted before 11:59 p.m. local time Sunday 15 Nov, aim for early evening
