"""Write SYNTHETIC placeholder data so the app can run before real NASA data is pulled.

These numbers are invented from rough climate shapes. They are NOT NASA data and must
never be shown to judges as results. Every file carries "synthetic": true and the app
shows a warning banner. Replace them by running pipeline/build_cache.py on real data.
"""
import json, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "locations.json").read_text())
Y0, Y1 = CFG["period"]["start_year"], CFG["period"]["end_year"]

# monthly shapes: rain mm, tmean C, heat days (Tmax>=35), frost days, ndvi, smap m3/m3
SHAPES = {
    "faisalabad": dict(
        rain=[8, 15, 18, 12, 10, 25, 95, 95, 35, 6, 3, 5],
        tmean=[12, 15, 21, 28, 33, 35, 33, 32, 30, 25, 18, 13],
        heat=[0, 0, 0, 6, 18, 22, 15, 10, 8, 2, 0, 0],
        frost=[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        extreme=[0, 0, 0, 0, 0, 0.25, 0.4, 0.4, 0.1, 0, 0, 0],
        ndvi=[.45, .50, .50, .40, .30, .25, .40, .45, .35, .30, .35, .40],
        smap=[.20, .22, .20, .15, .12, .12, .22, .24, .18, .14, .15, .18],
        soil=dict(ph=(7.9, 8.2, 8.5), clay=(14, 20, 27), soc=(2.4, 3.5, 5.0), sand=(30, 40, 52), silt=(30, 40, 50)),
    ),
    "ames_iowa": dict(
        rain=[27, 28, 55, 95, 120, 125, 115, 110, 85, 70, 50, 35],
        tmean=[-7, -4, 3, 10, 16, 21, 23, 22, 18, 11, 3, -4],
        heat=[0, 0, 0, 0, 0, 2, 4, 3, 0, 0, 0, 0],
        frost=[28, 24, 20, 8, 1, 0, 0, 0, 1, 8, 20, 27],
        extreme=[0, 0, 0, 0.15, 0.2, 0.3, 0.3, 0.3, 0.2, 0.1, 0, 0],
        ndvi=[.25, .25, .30, .40, .60, .80, .85, .80, .65, .45, .30, .25],
        smap=[.30, .30, .33, .36, .35, .33, .30, .28, .27, .29, .31, .31],
        soil=dict(ph=(5.9, 6.4, 6.9), clay=(22, 28, 34), soc=(14, 20, 27), sand=(15, 22, 30), silt=(40, 50, 58)),
    ),
}

def make(loc):
    rnd = random.Random(sum(map(ord, loc["id"])))
    s = SHAPES[loc["id"]]
    years = list(range(Y0, Y1 + 1))
    def series(base, scale, floor=0.0, integer=False):
        out = []
        for _ in years:
            f = rnd.lognormvariate(0, scale)
            row = [max(floor, b * f * rnd.uniform(0.7, 1.3)) for b in base]
            out.append([round(v) if integer else round(v, 2) for v in row])
        return out
    sc = s["soil"]
    q = lambda t: {"q05": t[0], "mean": t[1], "q95": t[2]}
    return {
        "synthetic": True,
        "id": loc["id"], "name": loc["name"], "lat": loc["lat"], "lon": loc["lon"],
        "years": years,
        "climate": {
            "rain": series(s["rain"], 0.35),
            "tmean": [[round(t + rnd.gauss(0, 1), 1) for t in s["tmean"]] for _ in years],
            "heat_days": series(s["heat"], 0.3, integer=True),
            "frost_days": series(s["frost"], 0.3, integer=True),
            "extreme_days": series(s["extreme"], 0.5, integer=True),
        },
        "ndvi_clim": s["ndvi"], "smap_clim": s["smap"],
        "soil": {k: q(v) for k, v in sc.items()},
        "soil_units": {"ph": "pH", "clay": "%", "sand": "%", "silt": "%", "soc": "g/kg"},
        "rain_crosscheck": {"power_vs_imerg_pct_diff": None,
                            "note": "Synthetic placeholder: no cross-check was run."},
        "gaps": ["PLACEHOLDER DATA: not from NASA. Run the pipeline to replace it."],
        "sources": {"power": "synthetic", "soilgrids": "synthetic", "modis": "synthetic",
                    "smap": "synthetic", "imerg": "synthetic"},
        "resolution_note": "Synthetic placeholder: no real spatial resolution.",
    }

if __name__ == "__main__":
    out = ROOT / "app" / "data"; out.mkdir(parents=True, exist_ok=True)
    index = []
    for loc in CFG["locations"]:
        d = make(loc)
        (out / f"{loc['id']}.json").write_text(json.dumps(d, separators=(",", ":")))
        index.append({k: loc[k] for k in ("id", "name", "lat", "lon", "hero", "current_rotation", "rotation_ids")}
                     | {"synthetic": True})
        print("wrote", loc["id"])
    (out / "index.json").write_text(json.dumps(index, indent=1))
