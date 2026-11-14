"""MODIS NDVI (MOD13Q1 Terra / MYD13Q1 Aqua, 250 m, 16-day) read for ONE pixel through the
Planetary Computer STAC. No account and no AppEEARS job (verified 2026-11-14).

The NASA data is hosted by Microsoft as Cloud-Optimized GeoTIFFs; only the bytes of the
single pixel are fetched via HTTP range requests."""
import concurrent.futures as cf
import datetime as dt
import urllib.parse
from urllib.parse import urlparse

import httpx

from .. import config

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SIGN = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
NDVI_SCALE = 0.0001
NDVI_NODATA = -3000
GOOD_RELIABILITY = (0, 1)   # 0 = good, 1 = marginal (MODIS pixel-reliability rank)


class ModisError(RuntimeError):
    pass


def _host_ok(href):
    return urlparse(href).hostname in config.UPSTREAM_HOSTS


def parse_items(payload):
    """STAC FeatureCollection -> list of dicts, newest first."""
    out = []
    for f in payload.get("features", []):
        p = f.get("properties", {})
        assets = f.get("assets", {})
        nd, rel = assets.get("250m_16_days_NDVI"), assets.get("250m_16_days_pixel_reliability")
        if not nd or not _host_ok(nd["href"]):
            continue
        start = (p.get("start_datetime") or p.get("datetime") or "")[:10]
        end = (p.get("end_datetime") or "")[:10]
        out.append({"id": f["id"], "sensor": "Terra" if f["id"].startswith("MOD") else "Aqua",
                    "start": start, "end": end, "ndvi_href": nd["href"],
                    "reliability_href": rel["href"] if rel and _host_ok(rel["href"]) else None})
    out.sort(key=lambda x: x["start"], reverse=True)
    return out


def search(lat, lon, months=12, client=None):
    end = dt.date.today()
    start = end - dt.timedelta(days=int(months * 30.5))
    body = {"collections": ["modis-13Q1-061"], "intersects": {"type": "Point", "coordinates": [lon, lat]},
            "datetime": "%sT00:00:00Z/%sT23:59:59Z" % (start, end), "limit": 200,
            "sortby": [{"field": "datetime", "direction": "desc"}]}
    own = client is None
    client = client or httpx.Client(timeout=config.HTTP_TIMEOUT)
    try:
        r = client.post(STAC, json=body)
    except httpx.HTTPError as e:
        raise ModisError("could not reach the MODIS catalogue: %s" % e.__class__.__name__)
    finally:
        if own:
            client.close()
    if r.status_code != 200:
        raise ModisError("MODIS catalogue answered HTTP %d" % r.status_code)
    return parse_items(r.json())


def _sign(href, client):
    r = client.get(SIGN, params={"href": href})
    if r.status_code != 200:
        raise ModisError("could not sign MODIS asset (HTTP %d)" % r.status_code)
    return r.json()["href"]


def read_pixel(item, lat, lon):
    """Read the NDVI of one pixel. Returns dict(ndvi=float|None, reliability=int|None, reason=str|None).
    NDVI is None (never a guess) for no-data or poor-quality pixels."""
    import rasterio
    from pyproj import Transformer
    from rasterio.windows import Window
    with httpx.Client(timeout=config.HTTP_TIMEOUT) as c:
        nd_url = _sign(item["ndvi_href"], c)
        rel_url = _sign(item["reliability_href"], c) if item.get("reliability_href") else None
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT=str(config.HTTP_TIMEOUT)):
        with rasterio.open(nd_url) as ds:
            x, y = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True).transform(lon, lat)
            row, col = ds.index(x, y)
            if not (0 <= row < ds.height and 0 <= col < ds.width):
                return {"ndvi": None, "reliability": None, "reason": "point outside tile"}
            raw = int(ds.read(1, window=Window(col, row, 1, 1))[0, 0])
        rel = None
        if rel_url:
            with rasterio.open(rel_url) as dr:
                rel = int(dr.read(1, window=Window(col, row, 1, 1))[0, 0])
    return classify(raw, rel)


def classify(raw, rel):
    """Turn a raw MODIS integer into an NDVI or an honest reason for having none."""
    if raw == NDVI_NODATA or raw < -2000 or raw > 10000:
        return {"ndvi": None, "reliability": rel, "reason": "no data (cloud, water or fill)"}
    if rel is not None and rel not in GOOD_RELIABILITY:
        return {"ndvi": None, "reliability": rel, "reason": "pixel reliability too low (rank %d)" % rel}
    return {"ndvi": round(raw * NDVI_SCALE, 4), "reliability": rel, "reason": None}


def series(lat, lon, items, cache, max_workers=16):
    """Read every item for this pixel (in parallel). Each finished composite is cached
    permanently-ish per pixel, so a second farmer on the same pixel costs nothing."""
    from .. import grid
    cell = grid.modis_cell(lat, lon)

    def one(item):
        try:
            val, fetched, stale, hit = cache.fetch("modis:ndvi:%s:%s" % (cell, item["id"]), config.TTL_MODIS_PIXEL,
                                                    lambda: read_pixel(item, lat, lon))
            return dict(item_id=item["id"], sensor=item["sensor"], start=item["start"], end=item["end"],
                        ndvi=val["ndvi"], reliability=val["reliability"], reason=val["reason"])
        except Exception as e:  # one bad composite must not hide the others
            return dict(item_id=item["id"], sensor=item["sensor"], start=item["start"], end=item["end"],
                        ndvi=None, reliability=None, reason="read failed: %s" % e.__class__.__name__)

    with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
        out = list(ex.map(one, items))
    out.sort(key=lambda r: r["start"])
    return out
