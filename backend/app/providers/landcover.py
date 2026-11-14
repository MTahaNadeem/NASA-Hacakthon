"""Crop-area polygons from REAL classified satellite datasets, via the Microsoft Planetary Computer (no login).

Nothing here is invented. Two datasets, with very different abilities (verified 2026-11-14):

* USDA NASS Cropland Data Layer (CDL): 30 m, a supervised classification of satellite imagery into 133 classes with USDA's own names
  and colours (Corn, Soybeans, Cotton, Rice ...). Covers the CONTINENTAL USA only. The PC copy runs to 2021.
* ESA WorldCover: 10 m global land cover. It has ONE cropland class, so it can show WHERE cropland is but not WHICH crop (2021, v200).

Both are model predictions made from satellite images, not field surveys. Neither contains field IDs, so a polygon here is a connected
group of pixels of the same class, not a surveyed field boundary. Where no crop-type map exists the honest answer is "cropland, type unknown"."""
import json
import math
import re
import threading
import time
import urllib.parse

import httpx

from .. import config

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/%s"
MAX_PIXELS = 600            # per side; bigger windows are read at a coarser resolution (nearest neighbour keeps classes valid)
MAX_FEATURES = 2500
MIN_AREA_HA = 0.05
CONUS = (-125.0, 24.0, -66.5, 49.5)     # lon/lat box of the Cropland Data Layer's coverage (west, south, east, north)

SOURCES = {
    "cdl": {"collection": "usda-cdl", "asset": "cropland", "token": "landcoverdata/usda-cdl", "hosts": {"landcoverdata.blob.core.windows.net"},
            "name": "USDA NASS Cropland Data Layer", "resolution": "30 m", "kind": "model_prediction",
            "credit": "USDA National Agricultural Statistics Service, Cropland Data Layer; hosted by Microsoft Planetary Computer",
            "crop_type": True},
    "worldcover": {"collection": "esa-worldcover", "asset": "map", "token": "ai4edataeuwest/esa-worldcover", "hosts": {"ai4edataeuwest.blob.core.windows.net"},
                   "name": "ESA WorldCover (land cover; only 'Cropland', not crop type)", "resolution": "10 m", "kind": "model_prediction",
                   "credit": "ESA WorldCover 2021 v200 (CC BY 4.0); hosted by Microsoft Planetary Computer", "crop_type": False},
}

# CDL classes that are NOT crops or farmland (urban, forest, water, wetlands, clouds, ...). Everything else the CDL names is shown.
_NON_AG = re.compile(r"developed|forest|shrub|barren|water|wetland|clouds|no data|nonag|undefined|aquaculture|ice|grassland/pasture|^background", re.I)

# Crop category is NOT in the CDL. It is this app's own grouping of USDA's crop NAMES, listed here so it can be checked and changed.
CATEGORY_RULES = [
    ("Cereal", r"corn|sorghum|wheat|barley|oats|rye|millet|rice|triticale|speltz|buckwheat|sweet corn|pop or orn corn"),
    ("Oilseed", r"soybean|sunflower|canola|rape|safflower|flax|mustard|camelina|sesame|peanut"),
    ("Fodder / pasture", r"hay|alfalfa|clover|pasture|grass|fallow|sod"),
    ("Legume / pulse", r"pea|lentil|chick|bean|vetch"),
    ("Fibre", r"cotton|hemp"),
    ("Sugar", r"sugarbeet|sugarcane|sugar"),
    ("Orchard / fruit", r"apple|apricot|cherr|citrus|orange|grape|olive|peach|pear|plum|prune|nectarine|pomegranate|avocado|cranberr|blueberr|strawberr|berr|melon|watermelon|cantaloupe|honeydew|fruit|orchard|date|fig|kiwi"),
    ("Nut", r"almond|walnut|pecan|pistachio|nut"),
    ("Vegetable", r"potato|tomato|onion|carrot|lettuce|cabbage|broccoli|cauliflower|pepper|cucumber|squash|pumpkin|spinach|celery|asparagus|garlic|radish|turnip|vegetable|sweet potato|greens|herb"),
]


class LandcoverError(RuntimeError):
    pass


def crop_category(name):
    """Group a crop NAME into a broad category, or None when no rule applies (never guessed)."""
    n = (name or "").lower()
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, n):
            return cat
    return None


def is_agricultural(name):
    return bool(name) and not _NON_AG.search(name)


def covered_by_cdl(lon, lat):
    return CONUS[0] <= lon <= CONUS[2] and CONUS[1] <= lat <= CONUS[3]


def choose_source(west, south, east, north):
    """CDL where it exists (it knows crop types); otherwise WorldCover (cropland only)."""
    cx, cy = (west + east) / 2, (south + north) / 2
    return "cdl" if covered_by_cdl(cx, cy) else "worldcover"


# ---- tokens ----
_tok, _tok_lock = {}, threading.Lock()


def read_token(path):
    with _tok_lock:
        t = _tok.get(path)
        if t and time.time() < t[1] - 300:
            return t[0]
    r = httpx.get(TOKEN % path, timeout=config.HTTP_TIMEOUT)
    if r.status_code != 200:
        raise LandcoverError("could not get a read token (HTTP %d)" % r.status_code)
    j = r.json()
    import datetime as dt
    try:
        exp = dt.datetime.fromisoformat(str(j.get("msft:expiry", "")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        exp = time.time() + 600
    with _tok_lock:
        _tok[path] = (j["token"], exp)
    return j["token"]


# ---- STAC ----
def find_items(source, west, south, east, north, client=None):
    """Newest-year items of the dataset that overlap the box. Returns [{id, year, href, classes}]."""
    spec = SOURCES[source]
    body = {"collections": [spec["collection"]], "bbox": [west, south, east, north], "limit": 40}
    r = (client or httpx).post(STAC, json=body, timeout=config.HTTP_TIMEOUT)
    if r.status_code != 200:
        raise LandcoverError("catalogue answered HTTP %d" % r.status_code)
    out = []
    for f in r.json().get("features", []):
        a = f["assets"].get(spec["asset"])
        if not a:
            continue
        year = int(str(f["properties"].get("start_datetime") or f["properties"].get("datetime") or "0")[:4] or 0)
        if source == "worldcover" and "v200" not in f["id"]:
            continue           # v200 = 2021 (the newer algorithm); v100 = 2020
        if urllib.parse.urlparse(a["href"]).hostname not in spec["hosts"]:
            continue
        rb = (a.get("raster:bands") or [{}])[0]
        classes = a.get("classification:classes") or rb.get("classification:classes") or []
        out.append({"id": f["id"], "year": year, "href": a["href"], "classes": classes})
    if not out:
        return []
    newest = max(o["year"] for o in out)
    return [o for o in out if o["year"] == newest]


def class_table(classes):
    """{value: (name, '#rrggbb' or None)} from the STAC classification metadata."""
    t = {}
    for c in classes:
        col = c.get("color_hint")
        t[int(c["value"])] = (c.get("description") or c.get("name") or str(c["value"]), ("#" + col.lstrip("#")) if col else None)
    return t


# ---- geometry ----
def ring_area_m2(ring, lat0, lon0):
    """Area of a lon/lat ring in m2 using a local equal-area (Lambert azimuthal) projection centred near the ring."""
    R = 6371008.8
    p0, l0 = math.radians(lat0), math.radians(lon0)
    pts = []
    for lon, lat in ring:
        p, l = math.radians(lat), math.radians(lon)
        k = math.sqrt(2 / (1 + math.sin(p0) * math.sin(p) + math.cos(p0) * math.cos(p) * math.cos(l - l0)))
        pts.append((R * k * math.cos(p) * math.sin(l - l0), R * k * (math.cos(p0) * math.sin(p) - math.sin(p0) * math.cos(p) * math.cos(l - l0))))
    s = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def polygon_area_ha(rings, lat0, lon0):
    outer = ring_area_m2(rings[0], lat0, lon0)
    holes = sum(ring_area_m2(r, lat0, lon0) for r in rings[1:])
    return max(0.0, outer - holes) / 10000.0


def window_features(arr, transform, to_lonlat, table, source, year, item_id, keep=None):
    """Turn one classified raster window into GeoJSON features (one per connected same-class area).
    arr: 2-D integer array; transform: its affine; to_lonlat: function(x, y) -> (lon, lat); table: {value: (name, colour)}."""
    import numpy as np
    from rasterio import features
    spec = SOURCES[source]
    feats, dropped = [], 0
    vals = [int(v) for v in np.unique(arr)]
    for v in vals:
        name = table.get(v, (None, None))[0]
        if source == "worldcover":
            if v != 40:
                continue
            name, colour = "Cropland (crop type not identified)", None
        else:
            if not is_agricultural(name) or (keep is not None and v not in keep):
                continue
            colour = table[v][1]
        mask = (arr == v)
        for geom, _ in features.shapes(arr.astype("int32"), mask=mask, transform=transform, connectivity=4):
            rings = [[to_lonlat(x, y) for x, y in ring] for ring in geom["coordinates"]]
            lon0 = sum(p[0] for p in rings[0]) / len(rings[0]); lat0 = sum(p[1] for p in rings[0]) / len(rings[0])
            ha = polygon_area_ha(rings, lat0, lon0)
            if ha < MIN_AREA_HA:
                dropped += 1
                continue
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in r] for r in rings]},
                          "properties": {"crop": name, "class_code": v, "category": crop_category(name) if source == "cdl" else "Cropland",
                                         "area_ha": round(ha, 2), "lat": round(lat0, 5), "lon": round(lon0, 5), "color": colour,
                                         "year": year, "item": item_id}})
    return feats, dropped


def read_window(item, source, west, south, east, north, token=None):
    """Read the part of one COG that overlaps the box, as a classified array. Returns (array, transform, to_lonlat, resolution_m_note)."""
    import numpy as np
    import rasterio
    from pyproj import Transformer
    from rasterio.enums import Resampling
    from rasterio.warp import transform_bounds
    from rasterio.windows import Window, from_bounds
    token = token or read_token(SOURCES[source]["token"])
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT=str(config.HTTP_TIMEOUT), GDAL_HTTP_MAX_RETRY="2"):
        with rasterio.open(item["href"] + "?" + token) as ds:
            b = transform_bounds("EPSG:4326", ds.crs, west, south, east, north, densify_pts=11)
            win = from_bounds(*b, transform=ds.transform).round_offsets().round_lengths()
            win = win.intersection(Window(0, 0, ds.width, ds.height)) if (win.col_off < ds.width and win.row_off < ds.height) else None
            if win is None or win.width < 1 or win.height < 1:
                return None
            scale = max(1.0, win.width / MAX_PIXELS, win.height / MAX_PIXELS)
            shape = (max(1, int(win.height / scale)), max(1, int(win.width / scale)))
            arr = ds.read(1, window=win, out_shape=shape, resampling=Resampling.nearest)
            tr = ds.window_transform(win) * rasterio.Affine.scale(win.width / shape[1], win.height / shape[0])
            back = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)
            px = abs(tr.a) if not ds.crs.is_geographic else abs(tr.a) * 111320 * math.cos(math.radians((south + north) / 2))
            return arr, tr, (lambda x, y: back.transform(x, y)), round(px, 1)


def fetch(west, south, east, north, source=None, client=None, reader=None):
    """GeoJSON FeatureCollection of crop areas in the box, with honest metadata. `reader` is injectable for tests."""
    source = source or choose_source(west, south, east, north)
    spec = SOURCES[source]
    items = find_items(source, west, south, east, north, client)
    feats, dropped, res, year = [], 0, None, None
    for it in items:
        got = (reader or read_window)(it, source, west, south, east, north)
        if not got:
            continue
        arr, tr, to_lonlat, px = got
        table = class_table(it["classes"])
        f, d = window_features(arr, tr, to_lonlat, table, source, it["year"], it["id"])
        feats += f; dropped += d; res = px if res is None else max(res, px); year = it["year"]
    feats.sort(key=lambda f: -f["properties"]["area_ha"])
    truncated = max(0, len(feats) - MAX_FEATURES)
    feats = feats[:MAX_FEATURES]
    return {"type": "FeatureCollection", "features": feats, "meta": {
        "source": source, "dataset": spec["name"], "year": year, "native_resolution": spec["resolution"], "used_resolution_m": res,
        "kind": spec["kind"], "credit": spec["credit"], "crop_type_available": spec["crop_type"],
        "bbox": [west, south, east, north], "feature_count": len(feats), "dropped_small": dropped, "truncated": truncated,
        "notes": ([] if spec["crop_type"] else ["This dataset only separates cropland from other land; it cannot say which crop is grown. No open crop-type map was found for this region."])
                 + ["Polygons are connected groups of same-class pixels from a satellite classification, not surveyed field boundaries; the dataset has no field IDs."]}}
