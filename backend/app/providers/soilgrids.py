"""ISRIC SoilGrids 2.0 (NOT NASA) read straight from ISRIC's published tiles.

Why not the SoilGrids REST API: it took 38-60+ s per place in testing and timed out for some, which left the app with no soil
data. The same maps are published as tiled GeoTIFFs (CORS-open, no key) and one pixel reads in well under a second.
Each property has its own tile layout, so compact per-property indexes (app/data/soilgrids_tiles_*.json) find the right tile."""
import concurrent.futures as cf
import json
import math
import os
import threading

from .. import config

BASE = "https://files.isric.org/soilgrids/latest/data/"
PROPS = {"ph": "phh2o", "soc": "soc", "sand": "sand", "silt": "silt", "clay": "clay"}
DEPTHS = [("0-5cm", 5), ("5-15cm", 10), ("15-30cm", 15)]     # weights = layer thickness in cm
STATS = [("q05", "Q0.05"), ("mean", "mean"), ("q95", "Q0.95")]
D_FACTOR = 10          # SoilGrids stores pH x10, SOC in dg/kg, clay/sand/silt in g/kg; /10 gives pH, g/kg, %
NODATA = -32768
SEARCH_KM = [0, 2, 4, 8, 12, 16, 20, 25]
IGH = "+proj=igh +lon_0=0 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"


class SoilError(RuntimeError):
    pass


_lock = threading.Lock()
_idx = {}
_tr = None


def _index(prop):
    """Tile index for one property. Layouts differ between properties (pH 600x600, the others 450x450) but are identical
    across depths and percentiles within a property (checked by tools/build_soil_tile_index.py --verify)."""
    with _lock:
        if prop not in _idx:
            path = os.path.join(os.path.dirname(__file__), "..", "data", "soilgrids_tiles_%s.json" % PROPS[prop])
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
            step = max(t[2] for t in raw["tiles"])
            buckets = {}
            for t in raw["tiles"]:
                x, y, xs, ys = t[:4]
                for bx in {x // step, (x + xs - 1) // step}:
                    for by in {y // step, (y + ys - 1) // step}:
                        buckets.setdefault((bx, by), []).append(t)
            _idx[prop] = {"gt": raw["geotransform"], "size": raw["size"], "buckets": buckets, "step": step}
        return _idx[prop]


def pixel(lat, lon):
    """Column/row of the 250 m pixel holding the point. The map grid is common to all layers (None if outside)."""
    global _tr
    ix = _index("ph")
    with _lock:
        if _tr is None:
            from pyproj import Transformer
            _tr = Transformer.from_crs("EPSG:4326", IGH, always_xy=True)
    x, y = _tr.transform(lon, lat)
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    col, row = int((x - ix["gt"][0]) // ix["gt"][1]), int((y - ix["gt"][3]) // ix["gt"][5])
    if not (0 <= col < ix["size"][0] and 0 <= row < ix["size"][1]):
        return None
    return col, row


def tile_for(prop, col, row):
    ix = _index(prop)
    for x, y, xs, ys, d, sub in ix["buckets"].get((col // ix["step"], row // ix["step"]), []):
        if x <= col < x + xs and y <= row < y + ys:
            return {"x": x, "y": y, "dir": d, "sub": sub}
    return None      # no tile = SoilGrids has no data here (sea, ice, ...)


def layer_url(prop, depth, stat, tile):
    name = "%s_%s_%s" % (PROPS[prop], depth, stat)
    return "%s%s/%s/%s/%s_%s.tif" % (BASE, PROPS[prop], name, tile["dir"], tile["dir"], tile["sub"])


def read_value(prop, depth, stat, col, row):
    """One raw integer, or None when unmapped / unreadable."""
    import rasterio
    from rasterio.windows import Window
    tile = tile_for(prop, col, row)
    if not tile:
        return None
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT=str(config.HTTP_TIMEOUT), GDAL_HTTP_MAX_RETRY="2"):
            with rasterio.open(layer_url(prop, depth, stat, tile)) as ds:
                v = int(ds.read(1, window=Window(col - tile["x"], row - tile["y"], 1, 1))[0, 0])
    except Exception as e:
        if "404" in str(e) or "No such file" in str(e) or "not recognized" in str(e):
            return None
        if isinstance(e, IndexError):
            raise SoilError("soil tile layout does not match the index for %s (rebuild with tools/build_soil_tile_index.py)" % prop)
        raise SoilError("could not read soil tile: %s" % e.__class__.__name__)
    return None if v == NODATA else v


def combine(raw):
    """raw[(prop, depth, stat)] -> {prop: {q05, mean, q95}} in pH / g/kg / %, depth-weighted over 0-30 cm.
    A property with any missing layer is left out rather than guessed."""
    soil = {}
    for prop in PROPS:
        rec = {}
        for stat, _ in STATS:
            acc = ws = 0.0
            for depth, w in DEPTHS:
                v = raw.get((prop, depth, stat))
                if v is None:
                    acc = None
                    break
                acc += w * v / D_FACTOR
                ws += w
            if acc is None:
                rec = None
                break
            rec[stat] = round(acc / ws, 2)
        if rec:
            soil[prop] = rec
    return soil


def _offset_pixel(lat, lon, km, bearing_deg):
    b = math.radians(bearing_deg)
    dlat = km / 111.32 * math.cos(b)
    dlon = km / (111.32 * max(0.05, math.cos(math.radians(lat)))) * math.sin(b)
    return pixel(lat + dlat, lon + dlon)


def nearest_mapped(lat, lon, probe=None):
    """The requested pixel if SoilGrids has data there, else the nearest mapped pixel within 25 km (soil is not mapped under
    towns, water or ice). Returns (col, row, distance_km) or None."""
    # accept a pixel only if ALL five properties are mapped there (carbon, for instance, can be masked where pH is not)
    probe = probe or (lambda c, r: True if all(read_value(p, "0-5cm", "mean", c, r) is not None for p in PROPS) else None)
    for km in SEARCH_KM:
        cands = [pixel(lat, lon)] if km == 0 else [_offset_pixel(lat, lon, km, b) for b in range(0, 360, 45)]
        cands = [c for c in cands if c]
        if not cands:
            continue
        with cf.ThreadPoolExecutor(max_workers=len(cands)) as ex:
            vals = list(ex.map(lambda c: probe(*c), cands))
        for c, v in zip(cands, vals):
            if v is not None:
                return c[0], c[1], km
    return None


def fetch(lat, lon, reader=None, probe=None):
    """Full soil record for the point. 45 small reads (5 properties x 3 depths x mean/Q0.05/Q0.95) in parallel."""
    reader = reader or read_value
    found = nearest_mapped(lat, lon, probe)
    if not found:
        return {"soil": {}, "distance_km": None, "pixel": None,
                "reason": "SoilGrids has no soil data within 25 km (sea, ice, or an unmapped area)."}
    col, row, km = found
    jobs = [(p, d, s) for p in PROPS for d, _ in DEPTHS for s, _ in STATS]
    sname = dict(STATS)
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        vals = list(ex.map(lambda j: reader(j[0], j[1], sname[j[2]], col, row), jobs))
    return {"soil": combine(dict(zip(jobs, vals))), "distance_km": km, "pixel": [col, row], "reason": None}
