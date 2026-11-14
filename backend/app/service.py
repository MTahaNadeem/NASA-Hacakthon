"""Assembles provider output + indicators + provenance into API responses."""
import datetime as dt

from . import config, grid, indicators, provenance as pv
from .providers import cmr, modis, power, soilgrids

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
                   + ("a server token is configured but the reader has not been validated yet, so no values are served."
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
        rows = modis.series(lat, lon, items, cache)
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
    rec, fetched, stale, hit = cache.fetch("soil:v1:%d:%d" % px, config.TTL_SOIL, lambda: (fetcher or soilgrids.fetch)(lat, lon))
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
         "status": "discovery_only", "server_token_configured": bool(config.EARTHDATA_TOKEN), "endpoint": "/api/location (soil_moisture.smap)"},
        {"id": "imerg", "name": "NASA GPM IMERG daily rain", "kind": "satellite_estimate", "auth_for_farmer": False,
         "server_auth": "Earthdata Login (assumed, not verified)", "instant": False,
         "status": "discovery_only", "server_token_configured": bool(config.EARTHDATA_TOKEN), "endpoint": "/api/location (rainfall.imerg)"},
    ], "not_used": [
        {"name": "POWER IMERG_PRECTOT", "why": "Listed in the POWER catalogue but returned only fill values at every date tested."},
        {"name": "Hydrology Data Rods (GLDAS)", "why": "Service is being discontinued."},
        {"name": "AppEEARS", "why": "Asynchronous job queue needing a login; offline research tool only, never in the farmer path."},
    ]}
