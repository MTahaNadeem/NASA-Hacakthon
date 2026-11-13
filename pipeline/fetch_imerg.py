"""GPM IMERG daily precipitation at each location (NASA GES DISC), via earthaccess.

Needs Earthdata Login (EARTHDATA_USER / EARTHDATA_PASS env vars). Writes pipeline/raw/<id>/imerg.csv
with columns date,precip_mm. Product: GPM_3IMERGDF v07 (daily final run), variable 'precipitation'.

UNTESTED from the build sandbox (no network, and IMERG access can be slow). If this does not work in
time, build_cache.py falls back to POWER rainfall for extreme-rain counts and records that as a data gap.
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())

def main():
    import earthaccess, xarray as xr  # pip install earthaccess xarray netCDF4 h5netcdf
    earthaccess.login(strategy="environment")
    p = CFG["period"]
    for loc in CFG["locations"]:
        pad = 0.15
        granules = earthaccess.search_data(short_name="GPM_3IMERGDF", version="07",
            temporal=(f'{p["start_year"]}-01-01', f'{p["end_year"]}-12-31'),
            bounding_box=(loc["lon"] - pad, loc["lat"] - pad, loc["lon"] + pad, loc["lat"] + pad))
        files = earthaccess.open(granules)
        ds = xr.open_mfdataset(files, combine="by_coords")
        pt = ds["precipitation"].sel(lat=loc["lat"], lon=loc["lon"], method="nearest")
        out = ROOT / "raw" / loc["id"]; out.mkdir(parents=True, exist_ok=True)
        pt.to_series().rename("precip_mm").to_csv(out / "imerg.csv", index_label="date"); print("ok", loc["id"])

if __name__ == "__main__":
    main()
