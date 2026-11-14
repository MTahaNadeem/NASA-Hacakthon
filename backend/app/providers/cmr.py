"""NASA CMR (Common Metadata Repository) discovery. The SEARCH is public (verified 2026-11-14);
downloading the files behind SMAP and IMERG is not (Earthdata Login). This module only asks
'what is the newest acquisition?' so the app can show real data freshness."""
import httpx

from .. import config

URL = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"

PRODUCTS = {
    "smap": {"short_name": "SPL3SMP_E", "title": "SMAP Enhanced L3 radiometer soil moisture (9 km, daily)", "variable": "soil moisture"},
    "imerg": {"short_name": "GPM_3IMERGDL", "title": "GPM IMERG daily precipitation, Late run, V07 (0.1 deg)", "variable": "rainfall"},
}


class CmrError(RuntimeError):
    pass


def parse_latest(payload):
    items = payload.get("items") or []
    if not items:
        return None
    u = items[0]["umm"]
    rng = u.get("TemporalExtent", {}).get("RangeDateTime", {})
    return {"granule": u.get("GranuleUR"), "begin": (rng.get("BeginningDateTime") or "")[:10],
            "end": (rng.get("EndingDateTime") or "")[:10]}


def latest(product, client=None):
    spec = PRODUCTS[product]
    own = client is None
    client = client or httpx.Client(timeout=config.HTTP_TIMEOUT)
    try:
        r = client.get(URL, params={"short_name": spec["short_name"], "sort_key": "-start_date", "page_size": 1})
    except httpx.HTTPError as e:
        raise CmrError("could not reach NASA CMR: %s" % e.__class__.__name__)
    finally:
        if own:
            client.close()
    if r.status_code != 200:
        raise CmrError("NASA CMR answered HTTP %d" % r.status_code)
    return parse_latest(r.json())
