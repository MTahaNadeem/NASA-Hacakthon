"""Assembles provider output + indicators + provenance into API responses."""
import datetime as dt

from . import config, grid, indicators, provenance as pv
import concurrent.futures as cf
import math
import threading
import time

from .providers import cmr, harmony, modis, power, soilgrids

POWER_RES = "0.5 deg lat x 0.625 deg lon (meteorology); 1 x 1 deg (solar radiation)"


def _power_payload(lat, lon, cache, fetcher):
    cell = grid.power_cell(lat, lon)
    key = "power:v1:%s:%d" % (cell["key"], config.POWER_START_YEAR)
    # Query the cell centre: every point in the cell returns identical values (verified), and this makes the cached record deterministic.
    payload, fetched, stale, hit = cache.fetch(key, config.TTL_POWER, lambda: fetcher(cell["lat"], cell["lon"]))
    return cell, payload, fetched, stale, hit


def climate(lat, lon, cache, fetcher=None):
    lat, lon = grid.check_lat_lon(lat, lon)
    cell, payload, fetched, stale, hit = _power_payload(lat, lon, cache, fetcher or power.fetch)
    series = payload["series"]
    through = last_date = power.last_valid_date(series)
    through_iso = "%s-%s-%s" % (through[:4], through[4:6], through[6:]) if through else None
    first = min(next(iter(series.values())).keys()) if series else None
    period = "%s-%s-%s to %s" % (first[:4], first[4:6], first[6:], through_iso) if first and through_iso else None
    ind = indicators.compute(series)

    def prov(kind, dataset, units, note=None, params=None):
        return pv.make("NASA POWER (MERRA-2 / CERES-derived)", dataset, kind, units=units,
                       spatial_resolution=POWER_RES, temporal_resolution="daily", period=period,
                       data_through=through_iso, fetched_at=fetched, from_cache=hit, stale=stale, note=note)

    return {
        "location": {"requested": {"lat": lat, "lon": lon}, "grid_cell": cell,
                     "elevation_m": payload.get("elevation_m"),
                     "note": "All points inside this %s x %s degree cell receive identical NASA POWER values." % (grid.POWER_LAT_STEP, grid.POWER_LON_STEP)},
        "climate": {
            "provenance": prov("reanalysis", "POWER daily, community AG: T2M, T2M_MAX, T2M_MIN, PRECTOTCORR, RH2M, ALLSKY_SFC_SW_DWN",
                               "see units_by_parameter",
                               note="Temperature, rain, humidity and wind are MERRA-2 reanalysis (model assimilating observations); solar radiation is satellite-derived. Neither is a ground-station measurement."),
            "units_by_parameter": {k: power.UNITS.get(k) for k in series},
            "monthly_climatology": ind["monthly_climatology"],
            "annual": ind["annual"],
        },
        "rainfall": {
            "provenance": prov("reanalysis", "POWER PRECTOTCORR (MERRA-2 bias-corrected total precipitation)", "mm/day",
                               note="This is a reanalysis rainfall estimate, NOT satellite IMERG rain. IMERG is shown separately in `imerg`."),
            "imerg": imerg_status(cache),
        },
        "soil_moisture": {
            "modelled": {
                "provenance": prov("reanalysis", "POWER GWETROOT / GWETTOP (MERRA-2 modelled soil wetness)", "fraction 0-1",
                                   note="Modelled wetness of the root zone. A model estimate, not a satellite measurement."),
                "recent_state": (ind["recent"] or {}).get("soil_state"),
                "root_wetness_percentile": (ind["recent"] or {}).get("root_wetness_percentile"),
            },
            "smap": smap_status(cache),
        },
        "indicators": {
            "provenance": pv.make("This app", "Indicators calculated from NASA POWER daily values", "calculated",
                                  period=period, data_through=through_iso, fetched_at=fetched, from_cache=hit, stale=stale,
                                  note="Thresholds are this app's own definitions, listed in `definitions`."),
            "definitions": ind["definitions"], "recent_vs_normal": ind["recent"], "trends": ind["trends"],
        },
        "excluded": {"power_parameters_with_only_fill_values": payload.get("empty_parameters", []),
                     "note": "Parameters that POWER lists but returns no data for are dropped, never filled."},
        "gaps": _gaps(payload, through_iso),
    }


def _gaps(payload, through_iso):
    gaps = []
    if through_iso:
        age = (dt.date.today() - dt.date.fromisoformat(through_iso)).days
        gaps.append("Newest POWER day is %s (%d days ago). Data is not real-time." % (through_iso, age))
    if payload.get("empty_parameters"):
        gaps.append("POWER returned no data for: %s." % ", ".join(payload["empty_parameters"]))
    gaps.append("Climate values are an average over a ~50 km grid cell, not for the exact field.")
    return gaps


def _cmr_block(product, cache):
    spec = cmr.PRODUCTS[product]
    try:
        info, fetched, stale, hit = cache.fetch("cmr:%s" % product, config.TTL_CMR, lambda: cmr.latest(product))
    except Exception as e:
        info, fetched, stale, hit = None, None, False, False
        err = "%s" % e
    else:
        err = None
    token = bool(config.EARTHDATA_TOKEN)
    return {
        "dataset": spec["title"],
        "newest_acquisition": (info or {}).get("end"),
        "newest_granule": (info or {}).get("granule"),
        "values_available": False,
        "status": "discovery_only" if info else "unavailable",
        "server_token_configured": token,
        "reason": ("Newest acquisition found via NASA CMR (public). Reading its values needs an Earthdata Login on the SERVER; "
                   + ("a server token is configured, so recent values are read separately (see /api/recent); none are part of this response."
                      if token else "no server token is configured, so no values are served.")
                   + " Farmers never need an account.") if info else (err or "NASA CMR did not answer."),
        "provenance": pv.make("NASA CMR", spec["title"], "observation" if product == "smap" else "satellite_estimate",
                              data_through=(info or {}).get("end"), fetched_at=fetched, from_cache=hit, stale=stale,
                              auth="Earthdata Login (documented for SMAP; assumed for IMERG, not verified)",
                              note="Metadata only: when the newest file was acquired. No measurement values."),
    }


def smap_status(cache):
    return _cmr_block("smap", cache)


def imerg_status(cache):
    return _cmr_block("imerg", cache)


def ndvi(lat, lon, cache, months=12, searcher=None, reader=None):
    lat, lon = grid.check_lat_lon(lat, lon)
    cell = grid.modis_cell(lat, lon)
    items, fetched, stale, hit = cache.fetch("modis:search:%s:%d" % (cell, months), config.TTL_MODIS_SEARCH,
                                             lambda: (searcher or modis.search)(lat, lon, months))
    if reader is None:
        rows = _heavy(lambda: modis.series(lat, lon, items, cache))
    else:
        rows = reader(lat, lon, items)
    good = [r for r in rows if r["ndvi"] is not None]
    clim, clim_n = monthly_ndvi(rows)
    through = max((r["end"] for r in good), default=None)
    return {
        "location": {"requested": {"lat": lat, "lon": lon}, "pixel_key": cell},
        "ndvi": {
            "provenance": pv.make("NASA MODIS (hosted by Microsoft Planetary Computer)", "MOD13Q1 / MYD13Q1 v061 NDVI, 16-day composite",
                                  "satellite_estimate", units="NDVI (-1 to 1)", spatial_resolution="250 m",
                                  temporal_resolution="16-day composites (Terra and Aqua interleaved)",
                                  period="last %d months" % months, data_through=through, fetched_at=fetched, from_cache=hit, stale=stale,
                                  auth="none",
                                  note="Greenness from satellite reflectance, not a measurement of crop health. One 250 m pixel can mix fields, trees and buildings. Composites are typically weeks old."),
            "series": rows,
            "latest": (sorted(good, key=lambda r: r["end"])[-1] if good else None),
            "valid_count": len(good), "total_count": len(rows),
            "monthly_mean": clim, "monthly_count": clim_n,
            "monthly_note": "Average NDVI per calendar month over the last %d months only (%.1f years). Not a long-term climatology." % (months, months / 12),
        },
        "gaps": (["%d of %d composites had no usable value (cloud, water or low quality) and are left blank." % (len(rows) - len(good), len(rows))]
                 if len(good) != len(rows) else []),
    }


MIN_COMPOSITES_PER_MONTH = 2


def monthly_ndvi(rows):
    """12-value NDVI climatology (index 0 = January) from valid composites, using each composite's mid-date month.
    A month backed by fewer than MIN_COMPOSITES_PER_MONTH valid composites stays None: one cloud-edge pass should not define a month. This is what the app's bare-field factor reads (data.ndvi_clim)."""
    buckets = {m: [] for m in range(1, 13)}
    for r in rows:
        if r.get("ndvi") is None or not r.get("start"):
            continue
        mid = dt.date.fromisoformat(r["start"]) + dt.timedelta(days=8)
        buckets[mid.month].append(r["ndvi"])
    return ([round(sum(v) / len(v), 4) if len(v) >= MIN_COMPOSITES_PER_MONTH else None for v in (buckets[m] for m in range(1, 13))],
            [len(buckets[m]) for m in range(1, 13)])


def soil(lat, lon, cache, fetcher=None):
    lat, lon = grid.check_lat_lon(lat, lon)
    px = soilgrids.pixel(lat, lon)
    if px is None:
        raise ValueError("point is outside the SoilGrids map")
    rec, fetched, stale, hit = cache.fetch("soil:v1:%d:%d" % px, config.TTL_SOIL, lambda: _heavy(lambda: (fetcher or soilgrids.fetch)(lat, lon)))
    gaps = []
    if rec.get("reason"):
        gaps.append(rec["reason"])
    elif rec.get("distance_km"):
        gaps.append("No soil is mapped at the exact point (towns, water and ice are masked). Using the nearest mapped land %d km away." % rec["distance_km"])
    missing = [k for k in soilgrids.PROPS if k not in rec.get("soil", {})]
    if rec.get("soil") and missing:
        gaps.append("No value for: %s." % ", ".join(missing))
    return {
        "location": {"requested": {"lat": lat, "lon": lon}, "pixel": rec.get("pixel")},
        "soil": rec.get("soil", {}), "distance_km": rec.get("distance_km"),
        "provenance": pv.make("ISRIC SoilGrids 2.0 (not NASA)", "SoilGrids mean, 5th and 95th percentile maps, 0-30 cm depth-weighted", "third_party",
                              units="pH; organic carbon g/kg; clay, sand, silt %", spatial_resolution="250 m",
                              temporal_resolution="static map", period="0-5, 5-15 and 15-30 cm layers weighted by thickness",
                              fetched_at=fetched, from_cache=hit, stale=stale,
                              note="A machine-learning prediction of soil properties, not a measurement of this field. The 5th-95th range shows its uncertainty."),
        "gaps": gaps,
    }


# The free server has 512 MB. Measured: idle 87 MB, one soil read +105 MB, one MODIS read +160 MB, so only this many heavy jobs may run at the
# same time; further requests wait their turn instead of pushing the process out of memory (which dropped connections and lost NASA jobs).
HEAVY_JOBS = 2
_heavy_slots = threading.BoundedSemaphore(HEAVY_JOBS)


def _heavy(fn):
    with _heavy_slots:
        return fn()


RECENT_DAYS = 30
RECENT_TTL = 6 * 3600
_recent_jobs = {}
_recent_lock = threading.Lock()
# NASA's job queue slows down for everyone when several jobs run at once (measured: ~30 s alone, 110 s+ with overlapping runs),
# so at most this many places are read at the same time; others wait their turn and stay 'running'.
_recent_slots = None   # replaced by the global heavy-job ceiling below


def summarise_imerg(rows):
    vals = [(d, v) for d, v in rows if v is not None]
    last7 = [v for d, v in vals if d >= (dt.date.fromisoformat(rows[-1][0]) - dt.timedelta(days=6)).isoformat()] if rows else []
    return {"days_listed": len(rows), "valid_days": len(vals), "total_mm": round(sum(v for _, v in vals), 1),
            "rainy_days": sum(1 for _, v in vals if v >= 1), "heavy_days": sum(1 for _, v in vals if v >= 20),
            "last7_mm": round(sum(last7), 1) if last7 else None,
            "max_day": (lambda m: {"date": m[0], "mm": m[1]})(max(vals, key=lambda x: x[1])) if vals else None,
            "daily": [{"date": d, "mm": v} for d, v in rows]}


def summarise_smap(rows):
    vals = [(d, v) for d, v in rows if v is not None]
    return {"days_listed": len(rows), "valid_passes": len(vals),
            "latest": {"date": vals[-1][0], "value": vals[-1][1]} if vals else None,
            "mean": round(sum(v for _, v in vals) / len(vals), 3) if vals else None,
            "min": min(v for _, v in vals) if vals else None, "max": max(v for _, v in vals) if vals else None,
            "observations": [{"date": d, "value": v} for d, v in vals]}


def _section(name, rows, now):
    """Summary + provenance for one product's daily rows."""
    if name == "imerg":
        s = summarise_imerg(rows); through = max((d for d, v in rows if v is not None), default=None)
        s["provenance"] = pv.make("NASA GPM IMERG, read through NASA Harmony", harmony.PRODUCTS["imerg"]["title"], "satellite_estimate", units="mm/day",
                                  spatial_resolution="0.1 degree (about 10 km cell)", temporal_resolution="daily", period="last %d days" % RECENT_DAYS,
                                  data_through=through, fetched_at=now, auth="Earthdata Login (held by the server only)",
                                  note="This is the Late run: a preliminary estimate made about a day after the rain. NASA's later Final run can differ. A satellite estimate of rain over a 10 km cell, not a rain-gauge measurement.")
        return s
    s = summarise_smap(rows); through = max((d for d, v in rows if v is not None), default=None)
    s["provenance"] = pv.make("NASA SMAP, read through NASA Harmony", harmony.PRODUCTS["smap"]["title"], "satellite_estimate", units="m3/m3 (volumetric soil moisture)",
                              spatial_resolution="9 km", temporal_resolution="a reading about every 2-3 days", period="last %d days" % RECENT_DAYS,
                              data_through=through, fetched_at=now, auth="Earthdata Login (held by the server only)",
                              note="Moisture of the top few centimetres of soil from a satellite radiometer (morning pass), not the root zone. Many days have no reading at a place; frozen, very wet or densely vegetated ground can also give none.")
    return s


def _recent_compute(lat, lon, fetcher, today, on_part=None):
    """Both products run at once; each is reported through on_part(name, section) the moment it finishes, so the fast one
    (IMERG, ~10 s) is not held back by the slow one (SMAP, ~45 s or more)."""
    end, start = today, today - dt.timedelta(days=RECENT_DAYS - 1)
    out, errors = {}, {}
    with cf.ThreadPoolExecutor(max_workers=2) as ex:
        futs = {ex.submit(fetcher, name, lat, lon, start.isoformat(), end.isoformat()): name for name in ("imerg", "smap")}
        for fu in cf.as_completed(futs):
            name = futs[fu]
            try:
                out[name] = _section(name, fu.result(), time.time())
                if on_part:
                    on_part(name, out[name])
            except Exception as e:           # one product failing must not hide the other
                errors[name] = str(e)[:200]
    if not out:
        raise harmony.HarmonyError("; ".join("%s: %s" % kv for kv in errors.items()))
    res = {"window": {"start": start.isoformat(), "end": end.isoformat(), "days": RECENT_DAYS}, "cell": {"lat": lat, "lon": lon, "size_deg": 0.1},
           "errors": errors, "gaps": [], **out}
    if "smap" in out and out["smap"]["valid_passes"] == 0:
        res["gaps"].append("SMAP has no valid soil-moisture reading at this place in the last %d days." % RECENT_DAYS)
    for k, msg in errors.items():
        res["gaps"].append("%s could not be loaded: %s" % (k.upper(), msg))
    return res


def _default_fetcher(name, lat, lon, start, end):
    return harmony.fetch_series(name, lat, lon, start, end)


def recent(lat, lon, cache, fetcher=None, today=None, background=True):
    """Recent satellite soil moisture (SMAP) and rain (IMERG). Takes ~10-45 s the first time, so it runs in the background:
    returns {'status': 'running'} until ready, then the cached result. Server token required; otherwise 'not_configured'."""
    lat, lon = grid.check_lat_lon(lat, lon)
    if fetcher is None:
        if not config.EARTHDATA_TOKEN:
            return {"status": "not_configured", "reason": "No Earthdata token is configured on the server, so recent SMAP and IMERG values cannot be read. Farmers never need one."}
        fetcher = _default_fetcher
    today = today or dt.date.today()
    # Snap to the 0.1 degree cell centre: every place in the cell gets the same, deterministic answer (and shares one NASA job),
    # as with the weather data. IMERG's own cells are 0.1 degree; SMAP's 9 km cell nearest the centre is used.
    ci, cj = math.floor(lat * 10), math.floor(lon * 10)
    clat, clon = round(ci / 10 + 0.05, 3), round(cj / 10 + 0.05, 3)
    key = "recent:v2:%d:%d" % (ci, cj)
    hit = cache.get(key)
    if hit:
        v, fetched, _ = hit
        return dict(v, status="ready", served_from_cache=True)
    with _recent_lock:
        job = _recent_jobs.get(key)
        if job and job["state"] == "running":
            return dict({"status": "running", "window": job.get("window"), "cell": job.get("cell")}, **job.get("partial", {}))
        if job and job["state"] == "error" and time.time() - job["at"] < 60:
            return {"status": "error", "reason": job["error"]}
        _recent_jobs[key] = {"state": "running", "at": time.time(), "partial": {}, "cell": {"lat": clat, "lon": clon, "size_deg": 0.1},
                             "window": {"start": (today - dt.timedelta(days=RECENT_DAYS - 1)).isoformat(), "end": today.isoformat(), "days": RECENT_DAYS}}

    def work():
        try:
            def part(name, section):
                with _recent_lock:
                    if key in _recent_jobs:
                        _recent_jobs[key].setdefault("partial", {})[name] = section
            res = _heavy(lambda: _recent_compute(clat, clon, fetcher, today, on_part=part))
            cache.put(key, res, RECENT_TTL)
            with _recent_lock:
                _recent_jobs.pop(key, None)
        except Exception as e:
            with _recent_lock:
                _recent_jobs[key] = {"state": "error", "at": time.time(), "error": str(e)[:240]}
    if background:
        threading.Thread(target=work, daemon=True).start()
        return {"status": "running"}
    work()
    hit = cache.get(key)
    return dict(hit[0], status="ready", served_from_cache=False) if hit else {"status": "error", "reason": _recent_jobs.get(key, {}).get("error", "failed")}


def sources(cache=None):
    return {"sources": [
        {"id": "power", "name": "NASA POWER daily", "kind": "reanalysis", "auth_for_farmer": False, "server_auth": "none",
         "instant": True, "status": "enabled", "endpoint": "/api/location"},
        {"id": "modis_ndvi", "name": "NASA MODIS NDVI 250 m (via Planetary Computer STAC)", "kind": "satellite_estimate",
         "auth_for_farmer": False, "server_auth": "none", "instant": True, "status": "enabled", "endpoint": "/api/ndvi"},
        {"id": "soilgrids", "name": "ISRIC SoilGrids 250 m (not NASA)", "kind": "third_party", "auth_for_farmer": False, "server_auth": "none",
         "instant": True, "status": "enabled", "endpoint": "/api/soil"},
        {"id": "smap", "name": "NASA SMAP L3 soil moisture 9 km", "kind": "observation", "auth_for_farmer": False,
         "server_auth": "Earthdata Login (documented)", "instant": False,
         "status": "recent_values" if config.EARTHDATA_TOKEN else "discovery_only", "server_token_configured": bool(config.EARTHDATA_TOKEN), "endpoint": "/api/recent"},
        {"id": "imerg", "name": "NASA GPM IMERG daily rain", "kind": "satellite_estimate", "auth_for_farmer": False,
         "server_auth": "Earthdata Login (verified: NASA redirects to login)", "instant": False,
         "status": "recent_values" if config.EARTHDATA_TOKEN else "discovery_only", "server_token_configured": bool(config.EARTHDATA_TOKEN), "endpoint": "/api/recent"},
    ], "not_used": [
        {"name": "POWER IMERG_PRECTOT", "why": "Listed in the POWER catalogue but returned only fill values at every date tested."},
        {"name": "Hydrology Data Rods (GLDAS)", "why": "Service is being discontinued."},
        {"name": "AppEEARS", "why": "Asynchronous job queue needing a login; offline research tool only, never in the farmer path."},
    ]}
