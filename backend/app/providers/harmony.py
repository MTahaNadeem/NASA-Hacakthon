"""Recent SMAP soil moisture and GPM IMERG rain for ONE place, through NASA Harmony (verified live 2026-11-14).

Both datasets need an Earthdata login, so this runs only on the server with a token in the EARTHDATA_TOKEN environment
variable (never sent to browsers). Harmony cuts a small box and a date range out of NASA's daily files, so only tens of
kilobytes move instead of whole global files. It is an asynchronous job: submit, poll, then download one tiny file per day.

Measured: IMERG 30 days ~9 s, SMAP 30 days ~30 s. Requires the Earthdata account to have approved the GES DISC and NSIDC
applications once (otherwise the job fails with 403)."""
import concurrent.futures as cf
import datetime as dt
import io
import math
import time

import httpx

from .. import config

HARMONY = "https://harmony.earthdata.nasa.gov"
PRODUCTS = {
    "imerg": {"collection": "C2723754859-GES_DISC", "variable": "precipitation", "half_deg": 0.06, "max_km": 12.0,
              "title": "GPM IMERG daily precipitation, Late run (V07, 0.1 deg)"},
    "smap": {"collection": "C2938664763-NSIDC_CPRD", "variable": "Soil_Moisture_Retrieval_Data_AM/soil_moisture", "half_deg": 0.25, "max_km": 8.0,
             "title": "SMAP Enhanced L3 radiometer soil moisture, morning pass (9 km)"},
}
SMAP_VALID = (0.02, 0.5)      # valid_min / valid_max in the file
IMERG_FILL = -9999.9
SMAP_FILL = -9999.0


class HarmonyError(RuntimeError):
    pass


def _km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def nearest_value(lats, lons, vals, lat, lon, max_km, valid=lambda v: True):
    """Value of the cell nearest the point (flattened lists), or None if that cell is empty or farther than max_km.
    Only the NEAREST cell is used, so a neighbouring cell's value is never presented as this place's."""
    best = None
    for la, lo, v in zip(lats, lons, vals):
        d = _km(lat, lon, float(la), float(lo))
        if best is None or d < best[0]:
            best = (d, v)
    if best is None or best[0] > max_km:
        return None
    v = float(best[1])
    return round(v, 4) if (not math.isnan(v) and valid(v)) else None


def parse_imerg(f, lat, lon):
    """f: an open h5py File of an IMERG subset (variables lat, lon, precipitation)."""
    la, lo = f["lat"][...].ravel(), f["lon"][...].ravel()
    arr = f["precipitation"][...]
    # the subset is (time, lon, lat); build the matching flat lists
    lats, lons, vals = [], [], []
    for i, x in enumerate(lo):
        for j, y in enumerate(la):
            lats.append(y); lons.append(x); vals.append(arr[0, i, j] if arr.ndim == 3 else arr[i, j])
    return nearest_value(lats, lons, vals, lat, lon, PRODUCTS["imerg"]["max_km"], valid=lambda v: v != IMERG_FILL and v >= 0)


def parse_smap(f, lat, lon):
    """f: an open h5py File of a SMAP subset (group Soil_Moisture_Retrieval_Data_AM with latitude, longitude, soil_moisture)."""
    g = f["Soil_Moisture_Retrieval_Data_AM"]
    return nearest_value(g["latitude"][...].ravel(), g["longitude"][...].ravel(), g["soil_moisture"][...].ravel(), lat, lon,
                         PRODUCTS["smap"]["max_km"], valid=lambda v: v != SMAP_FILL and SMAP_VALID[0] <= v <= SMAP_VALID[1])


PARSERS = {"imerg": parse_imerg, "smap": parse_smap}


def link_date(link):
    """Date a result file belongs to, from the link's own temporal metadata (SMAP files carry no time variable)."""
    return str((link.get("temporal") or {}).get("start", ""))[:10] or None


def data_links(job):
    return [l for l in job.get("links", []) if l.get("rel") == "data"]


def submit(product, lat, lon, start, end, token, client):
    p = PRODUCTS[product]
    h = p["half_deg"]
    url = "%s/%s/ogc-api-coverages/1.0.0/collections/%s/coverage/rangeset" % (HARMONY, p["collection"], p["variable"].replace("/", "%2F"))
    params = [("subset", "lat(%.3f:%.3f)" % (lat - h, lat + h)), ("subset", "lon(%.3f:%.3f)" % (lon - h, lon + h)),
              ("subset", 'time("%sT00:00:00Z":"%sT23:59:59Z")' % (start, end)), ("format", "application/x-netcdf4"), ("forceAsync", "true")]
    r = client.get(url, params=params, headers={"Authorization": "Bearer " + token}, follow_redirects=False)
    if r.status_code != 303:
        raise HarmonyError("Harmony refused the request (HTTP %d)" % r.status_code)
    return r.headers["location"].rsplit("/", 1)[-1]


def wait(job_id, token, client, timeout=150, poll=2.0, progress=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get("%s/jobs/%s" % (HARMONY, job_id), headers={"Authorization": "Bearer " + token})
        if r.status_code != 200:
            raise HarmonyError("could not read the Harmony job (HTTP %d)" % r.status_code)
        j = r.json()
        if progress:
            progress("NASA job %s %s%%" % (j.get("status"), j.get("progress")))
        if j.get("status") in ("successful", "complete_with_errors"):
            return j
        if j.get("status") in ("failed", "canceled"):
            msg = (j.get("message") or "")
            if "403" in str(j.get("errors", "")) or "403" in msg:
                msg += " (403: approve the GES DISC / NSIDC applications on the Earthdata account)"
            raise HarmonyError("Harmony job %s: %s" % (j.get("status"), msg[:200]))
        time.sleep(poll)
    raise HarmonyError("Harmony job did not finish within %d s" % timeout)


def fetch_series(product, lat, lon, start, end, token=None, client=None, workers=8, progress=None):
    """[(date, value|None)] oldest first for the cell nearest the point. Raises HarmonyError on any failure of the job itself;
    a single file that cannot be read becomes a None for that day rather than hiding the others."""
    import h5py
    token = token or config.EARTHDATA_TOKEN
    if not token:
        raise HarmonyError("no Earthdata token configured on the server")
    own = client is None
    client = client or httpx.Client(timeout=config.HTTP_TIMEOUT)
    try:
        say = progress or (lambda msg: None)
        say("submitting the NASA job")
        jid = submit(product, lat, lon, start, end, token, client)
        say("NASA job submitted")
        job = wait(jid, token, client, progress=say)
        links = data_links(job)
        done = [0]

        def one(l):
            try:
                r = client.get(l["href"], headers={"Authorization": "Bearer " + token}, follow_redirects=True)
                done[0] += 1; say("downloading files %d/%d" % (done[0], len(links)))
                if r.status_code != 200:
                    return link_date(l), None
                with h5py.File(io.BytesIO(r.content), "r") as f:
                    return link_date(l), PARSERS[product](f, lat, lon)
            except Exception:
                return link_date(l), None
        with cf.ThreadPoolExecutor(max_workers=workers) as ex:
            rows = list(ex.map(one, links))
    except httpx.HTTPError as e:
        raise HarmonyError("could not reach NASA Harmony: %s" % e.__class__.__name__)
    finally:
        if own:
            client.close()
    by_day = {}
    for d, v in rows:
        if d:
            by_day.setdefault(d, v)
            if by_day[d] is None and v is not None:
                by_day[d] = v
    return sorted(by_day.items())
