"""NASA POWER daily point API. Public, no key, no login (verified 2026-11-14)."""
import datetime as dt

import httpx

from .. import config, grid

BASE = "https://power.larc.nasa.gov/api/temporal/daily/point"
FILL = -999.0

# IMERG_PRECTOT is listed in POWER's catalogue but returned only fill values at every
# date we tested, so it is NOT requested. See docs/NASA-DATA-ARCHITECTURE.md.
PARAMS = ["T2M", "T2M_MAX", "T2M_MIN", "PRECTOTCORR", "RH2M", "ALLSKY_SFC_SW_DWN", "GWETTOP", "GWETROOT"]
UNITS = {"T2M": "degC", "T2M_MAX": "degC", "T2M_MIN": "degC", "PRECTOTCORR": "mm/day", "RH2M": "%",
         "ALLSKY_SFC_SW_DWN": "MJ/m2/day", "GWETTOP": "fraction 0-1", "GWETROOT": "fraction 0-1"}


class PowerError(RuntimeError):
    pass


def parse(payload):
    """POWER JSON -> {param: {YYYYMMDD: float|None}}. Fill values become None.
    A parameter that is ALL fill (like IMERG_PRECTOT) is dropped and reported."""
    try:
        params = payload["properties"]["parameter"]
    except (KeyError, TypeError):
        raise PowerError("unexpected POWER response shape")
    series, empty = {}, []
    for name, days in params.items():
        clean = {d: (None if v is None or float(v) == FILL else float(v)) for d, v in days.items()}
        if all(v is None for v in clean.values()):
            empty.append(name)
        else:
            series[name] = clean
    return {"series": series, "empty_parameters": empty,
            "sources": payload.get("header", {}).get("sources", []),
            "api_version": payload.get("header", {}).get("api", {}).get("version"),
            "elevation_m": (payload.get("geometry", {}).get("coordinates") or [None, None, None])[2]}


def last_valid_date(series):
    t2m = series.get("T2M", {})
    valid = [d for d, v in t2m.items() if v is not None]
    return max(valid) if valid else None


def fetch(lat, lon, start_year=None, end=None, client=None):
    """One HTTP call for the 20+ year daily record of the cell. Called at most once
    per cell per TTL because the caller wraps it in the cache."""
    start_year = start_year or config.POWER_START_YEAR
    end = end or dt.date.today()
    params = {"parameters": ",".join(PARAMS), "community": "AG", "longitude": "%.4f" % lon, "latitude": "%.4f" % lat,
              "start": "%d0101" % start_year, "end": end.strftime("%Y%m%d"), "format": "JSON"}
    own = client is None
    client = client or httpx.Client(timeout=config.HTTP_TIMEOUT)
    try:
        r = client.get(BASE, params=params)
    except httpx.HTTPError as e:
        raise PowerError("could not reach NASA POWER: %s" % e.__class__.__name__)
    finally:
        if own:
            client.close()
    if r.status_code != 200:
        raise PowerError("NASA POWER answered HTTP %d" % r.status_code)
    out = parse(r.json())
    out["requested_at_cell"] = grid.power_cell(lat, lon)
    return out
