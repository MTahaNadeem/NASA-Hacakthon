"""Turn raw downloads in pipeline/raw/ into the static cache the web app reads (app/data/<id>.json).

  python pipeline/build_cache.py [--raw DIR] [--out DIR]

Missing inputs are never invented: a missing source is recorded in "gaps" and the app drops the
scoring factors that depended on it.
"""
import argparse, csv, json, statistics as st
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())
HEAT_C, FROST_C, EXTREME_MM = 35.0, 0.0, 50.0
SOIL_PROPS = {"phh2o": "ph", "soc": "soc", "sand": "sand", "silt": "silt", "clay": "clay"}
SOIL_UNITS = {"ph": "pH", "soc": "g/kg", "sand": "%", "silt": "%", "clay": "%"}
DEPTH_WEIGHTS = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}  # thickness-weighted topsoil mean

def parse_power(path, y0, y1):
    p = json.loads(Path(path).read_text())["properties"]["parameter"]
    years = list(range(y0, y1 + 1))
    def grid(): return [[0.0] * 12 for _ in years]
    rain, tsum, tcount, ext = grid(), grid(), grid(), grid()
    # counts for the warming scenario: heat_dt[d] = days with Tmax >= 35-d, frost_dt[d] = days with Tmin <= 0-d  (d = 0..4 degrees C)
    heat_dt = [grid() for _ in range(5)]; frost_dt = [grid() for _ in range(5)]
    for ds, v in p["PRECTOTCORR"].items():
        y, m = int(ds[:4]), int(ds[4:6]) - 1
        if v > -990 and y0 <= y <= y1:
            rain[y - y0][m] += v
            if v >= EXTREME_MM: ext[y - y0][m] += 1
    for ds, v in p["T2M"].items():
        y, m = int(ds[:4]), int(ds[4:6]) - 1
        if v > -990 and y0 <= y <= y1: tsum[y - y0][m] += v; tcount[y - y0][m] += 1
    for ds, v in p["T2M_MAX"].items():
        y, m = int(ds[:4]), int(ds[4:6]) - 1
        if v > -990 and y0 <= y <= y1:
            for d in range(5):
                if v >= HEAT_C - d: heat_dt[d][y - y0][m] += 1
    for ds, v in p["T2M_MIN"].items():
        y, m = int(ds[:4]), int(ds[4:6]) - 1
        if v > -990 and y0 <= y <= y1:
            for d in range(5):
                if v <= FROST_C - d: frost_dt[d][y - y0][m] += 1
    tmean = [[round(tsum[i][m] / tcount[i][m], 1) if tcount[i][m] else None for m in range(12)] for i in range(len(years))]
    r2 = lambda g: [[round(v, 2) for v in row] for row in g]
    ints = lambda g: [[int(v) for v in r] for r in g]
    return years, {"rain": r2(rain), "tmean": tmean, "heat_days": ints(heat_dt[0]), "frost_days": ints(frost_dt[0]), "extreme_days": ints(ext),
                   "heat_by_dt": {str(d): ints(heat_dt[d]) for d in range(5)}, "frost_by_dt": {str(d): ints(frost_dt[d]) for d in range(5)}}, p["PRECTOTCORR"]

def _pick(vals, name):
    """Case-insensitive lookup of a percentile key such as 'Q0.05' or 'mean'."""
    for k, v in (vals or {}).items():
        if str(k).lower() == name: return v
    return None

def parse_soilgrids(path):
    """Return (soil, bands_ok). soil maps ph/soc/sand/silt/clay to {q05, mean, q95} (thickness-weighted topsoil).
    bands_ok is False if any property lacked the 5th/95th percentiles (then q05 = q95 = mean). Empty soil = no usable values."""
    layers = json.loads(Path(path).read_text()).get("properties", {}).get("layers", [])
    soil, bands_ok = {}, True
    for layer in layers:
        key = SOIL_PROPS.get(layer.get("name"))
        if not key: continue
        d_factor = (layer.get("unit_measure") or {}).get("d_factor") or 1
        acc = {"q05": 0.0, "mean": 0.0, "q95": 0.0}; wsum = 0.0; full = True
        for depth in layer.get("depths", []):
            vals = depth.get("values") or {}
            mean = _pick(vals, "mean")
            if mean is None: continue
            lo, hi = _pick(vals, "q0.05"), _pick(vals, "q0.95")
            if lo is None or hi is None: lo = hi = mean; full = False
            rng = depth.get("range") or {}
            if rng.get("top_depth") is not None and rng.get("bottom_depth") is not None:
                w = float(rng["bottom_depth"]) - float(rng["top_depth"])
            else:
                w = DEPTH_WEIGHTS.get(str(depth.get("label", "")).replace(" ", ""), 0)
            if w <= 0: continue
            acc["q05"] += w * lo / d_factor; acc["mean"] += w * mean / d_factor; acc["q95"] += w * hi / d_factor; wsum += w
        if wsum:
            soil[key] = {k: round(v / wsum, 2) for k, v in acc.items()}
            bands_ok = bands_ok and full
    return soil, bands_ok

def monthly_clim_from_csv(path, col_hint, scale=1.0, min_valid=None):
    """Monthly mean climatology (12 values) from an AppEEARS point CSV (column containing col_hint)."""
    by_m = defaultdict(list)
    with open(path, newline="") as f:
        rd = csv.DictReader(f)
        col = next(c for c in rd.fieldnames if col_hint.lower() in c.lower() and "quality" not in c.lower())
        for row in rd:
            try: v = float(row[col])
            except (ValueError, TypeError): continue
            if min_valid is not None and v * scale < min_valid: continue  # fill values (e.g. MODIS -3000)
            by_m[int(row["Date"][5:7])].append(v * scale)
    return [round(st.mean(by_m[m]), 3) if by_m[m] else None for m in range(1, 13)]

def imerg_extreme(path, years):
    y0 = years[0]; ext = [[0] * 12 for _ in years]; rain_by = [[0.0] * 12 for _ in years]
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try: v = float(row["precip_mm"])
            except ValueError: continue
            y, m = int(row["date"][:4]), int(row["date"][5:7]) - 1
            if y0 <= y <= years[-1]:
                rain_by[y - y0][m] += v
                if v >= EXTREME_MM: ext[y - y0][m] += 1
    return ext, rain_by

def build(loc, raw_dir, out_dir):
    d, gaps, sources = Path(raw_dir) / loc["id"], [], {}
    y0, y1 = CFG["period"]["start_year"], CFG["period"]["end_year"]
    if not (d / "power.json").exists():
        print("skip", loc["id"], "- no POWER data (required)"); return None
    years, climate, _ = parse_power(d / "power.json", y0, y1); sources["power"] = "NASA POWER"
    rec = {"synthetic": False, "id": loc["id"], "name": loc["name"], "lat": loc["lat"], "lon": loc["lon"],
           "years": years, "climate": climate, "gaps": gaps, "sources": sources,
           "resolution_note": "POWER ~0.5 deg (~50 km); MODIS 250 m; SMAP L4 9 km; IMERG 0.1 deg (~10 km); "
                              "SoilGrids 250 m. Results describe the surrounding area, not one field."}
    if (d / "soilgrids.json").exists():
        soil, bands_ok = parse_soilgrids(d / "soilgrids.json")
        if soil.get("ph") and soil.get("clay"):
            rec["soil"] = soil; rec["soil_units"] = SOIL_UNITS; sources["soilgrids"] = "SoilGrids (ISRIC)"
            if not bands_ok: gaps.append("SoilGrids percentile bands missing: soil uncertainty not shown.")
        else:
            gaps.append("SoilGrids missing: returned no usable values for this point, so soil fit and soil-carbon factors dropped.")
    else: gaps.append("SoilGrids missing: soil fit and soil-carbon factors dropped.")
    ap = Path(raw_dir) / "_appeears"
    if (ap / "modis_ndvi.csv").exists():
        rec["ndvi_clim"] = monthly_clim_from_csv(ap / "modis_ndvi.csv", "NDVI", scale=0.0001, min_valid=-0.2); sources["modis"] = "NASA MODIS MOD13Q1"
    else: gaps.append("MODIS NDVI missing: bare-field factor dropped.")
    if (ap / "smap_rootzone.csv").exists():
        rec["smap_clim"] = monthly_clim_from_csv(ap / "smap_rootzone.csv", "rootzone"); sources["smap"] = "NASA SMAP SPL4SMGP (2015-)"
    else: gaps.append("SMAP missing: soil-moisture adjustment not applied to the water factor.")
    if (d / "imerg.csv").exists():
        ext, imerg_rain = imerg_extreme(d / "imerg.csv", years); rec["climate"]["extreme_days"] = ext; sources["imerg"] = "NASA GPM IMERG"
        p_tot = sum(sum(r) for r in climate["rain"]); i_tot = sum(sum(r) for r in imerg_rain)
        diff = round(100 * (i_tot - p_tot) / p_tot, 1) if p_tot else None
        rec["rain_crosscheck"] = {"power_vs_imerg_pct_diff": diff,
            "note": f"IMERG total rain differs from POWER by {diff}%." + (" Large gap: treat rain scores with caution." if diff is not None and abs(diff) > 25 else "")}
    else:
        gaps.append("IMERG missing: extreme-rain days counted from POWER rainfall instead; no cross-check possible.")
        rec["rain_crosscheck"] = {"power_vs_imerg_pct_diff": None, "note": "No IMERG data, so POWER was not cross-checked."}
    (Path(out_dir) / f"{loc['id']}.json").write_text(json.dumps(rec, separators=(",", ":")))
    print("built", loc["id"], "| gaps:", gaps or "none"); return rec

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--raw", default=ROOT / "raw"); ap.add_argument("--out", default=ROOT.parent / "app" / "data")
    a = ap.parse_args(); Path(a.out).mkdir(parents=True, exist_ok=True)
    index = []
    for loc in CFG["locations"]:
        if build(loc, a.raw, a.out):
            index.append({k: loc[k] for k in ("id", "name", "lat", "lon", "hero", "current_rotation", "rotation_ids")} | {"synthetic": False})
    if index: (Path(a.out) / "index.json").write_text(json.dumps(index, indent=1))
