"""Fetch SoilGrids v2 point properties with uncertainty percentiles (ISRIC, not NASA).

Usage: python pipeline/fetch_soilgrids.py [--refresh]
Writes pipeline/raw/<id>/soilgrids.json

SoilGrids has NO values under built-up land or water, and most quick-pick coordinates are city centres. So if the pin itself
returns only nulls, we look at nearby cells (rings of 0.05, 0.10, 0.20, 0.30 degrees, 8 directions) and use the closest cell that has
real values. The file records where the soil was actually sampled ("_sampled": lat, lon, km) and the app tells the user.
"""
import json, math, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())
URL = "https://rest.isric.org/soilgrids/v2.0/properties/query"
RINGS = (0.05, 0.10, 0.20, 0.30)
DIRS = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))  # N, NE, E, SE, S, SW, W, NW (dlat, dlon)

def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180; a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))

def get(params, timeout=120, tries=3):
    for i in range(tries):
        try:
            r = requests.get(URL, params=params, timeout=timeout)
            if r.status_code == 429: time.sleep(20 * (i + 1)); continue
            r.raise_for_status(); return r.json()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(10 * (i + 1))

def full(lat, lon):
    params = [("lon", lon), ("lat", lat)] + [("property", p) for p in ("phh2o", "soc", "sand", "silt", "clay")]
    params += [("depth", d) for d in ("0-5cm", "5-15cm", "15-30cm")] + [("value", v) for v in ("Q0.05", "mean", "Q0.95")]
    return get(params)

def has_values(j):
    try: return any(d.get("values", {}).get("mean") is not None for l in j["properties"]["layers"] for d in l.get("depths", []))
    except Exception: return False

def probe(lat, lon):
    """Cheap check: is there a pH value at this cell? None means the request failed (unknown), False means no soil data here."""
    try: return has_values(get([("lon", lon), ("lat", lat), ("property", "phh2o"), ("depth", "0-5cm"), ("value", "mean")], timeout=60, tries=2))
    except Exception: return None

def fetch(loc):
    lat, lon = loc["lat"], loc["lon"]
    j = full(lat, lon)
    if has_values(j): j["_sampled"] = {"lat": lat, "lon": lon, "km": 0.0}; return j, 0.0
    print(f"  {loc['id']}: no soil data at the pin (built-up land or water), searching nearby farmland...", flush=True)
    for ring in RINGS:
        cands = [(lat + dy * ring, lon + dx * ring / max(0.2, math.cos(math.radians(lat)))) for dy, dx in DIRS]
        with ThreadPoolExecutor(max_workers=3) as ex: res = list(ex.map(lambda c: probe(*c), cands))
        for c, ok in zip(cands, res):
            if ok:
                d = round(km(lat, lon, c[0], c[1]), 1); j = full(*c)
                if has_values(j): j["_sampled"] = {"lat": round(c[0], 4), "lon": round(c[1], 4), "km": d}; return j, d
    raise RuntimeError("no soil values within ~30 km")

def one(loc):
    out = ROOT / "raw" / loc["id"]; out.mkdir(parents=True, exist_ok=True); f = out / "soilgrids.json"
    try:
        if f.exists() and "--refresh" not in sys.argv and has_values(json.loads(f.read_text())): print("skip", loc["id"], "(already has values)", flush=True); return True
    except Exception: pass
    try:
        j, d = fetch(loc); f.write_text(json.dumps(j)); print("ok", loc["id"], "(at the pin)" if d == 0 else f"(sampled {d} km away)", flush=True); return True
    except Exception as e:
        print("FAILED", loc["id"], str(e)[:120], flush=True); return False

if __name__ == "__main__":
    # three places at once: ISRIC's server is slow (5-60 s per request) but copes with a few parallel requests; 429s back off in get()
    with ThreadPoolExecutor(max_workers=3) as ex: results = list(ex.map(one, CFG["locations"]))
    sys.exit(0 if all(results) else 1)
