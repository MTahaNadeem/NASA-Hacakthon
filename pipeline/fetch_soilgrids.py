"""Fetch SoilGrids v2 point properties with uncertainty percentiles (ISRIC, not NASA).

Usage: python pipeline/fetch_soilgrids.py
Writes pipeline/raw/<id>/soilgrids.json  (UNTESTED from the build sandbox: no network there)
Note: SoilGrids public REST is rate limited (about 5 calls/min); we make one call per location.
"""
import json, sys, time
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())
URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"

def fetch(loc):
    params = [("lon", loc["lon"]), ("lat", loc["lat"])]
    params += [("property", p) for p in ("phh2o", "soc", "sand", "silt", "clay")]
    params += [("depth", d) for d in ("0-5cm", "5-15cm", "15-30cm")]
    params += [("value", v) for v in ("Q0.05", "mean", "Q0.95")]
    r = requests.get(URL, params=params, timeout=120)
    r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    for loc in CFG["locations"]:
        out = ROOT / "raw" / loc["id"]; out.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                (out / "soilgrids.json").write_text(json.dumps(fetch(loc))); print("ok", loc["id"]); break
            except Exception as e:
                print("retry", loc["id"], e); time.sleep(20 * (attempt + 1))
        else:
            sys.exit(f"SoilGrids failed for {loc['id']}")
        time.sleep(15)
