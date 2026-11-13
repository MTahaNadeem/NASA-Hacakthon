"""Fetch NASA POWER daily point data for every location. No login needed.

Usage: python pipeline/fetch_power.py
Writes pipeline/raw/<id>/power.json  (UNTESTED from the build sandbox: no network there)
"""
import json, sys, time
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())
URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
PARAMS = "PRECTOTCORR,T2M,T2M_MAX,T2M_MIN"

def fetch(loc):
    p = CFG["period"]
    r = requests.get(URL, params={
        "parameters": PARAMS, "community": "AG", "format": "JSON",
        "latitude": loc["lat"], "longitude": loc["lon"],
        "start": f'{p["start_year"]}0101', "end": f'{p["end_year"]}1231'}, timeout=300)
    r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    for loc in CFG["locations"]:
        out = ROOT / "raw" / loc["id"]; out.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                (out / "power.json").write_text(json.dumps(fetch(loc))); print("ok", loc["id"]); break
            except Exception as e:
                print("retry", loc["id"], e); time.sleep(5 * (attempt + 1))
        else:
            sys.exit(f"POWER failed for {loc['id']}")
