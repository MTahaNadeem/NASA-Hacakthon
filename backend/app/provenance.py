"""Every value the API returns is described by a provenance record, so the UI can
always tell an observation from a model estimate from a calculation."""
import datetime as dt

KINDS = ("observation", "satellite_estimate", "reanalysis", "calculated", "third_party")

KIND_TEXT = {
    "observation": "Direct NASA observation",
    "satellite_estimate": "NASA satellite-derived estimate",
    "reanalysis": "NASA model / reanalysis estimate (not a direct measurement)",
    "calculated": "Calculated by this app from the data above",
    "third_party": "Not NASA",
}


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make(source, dataset, kind, units=None, spatial_resolution=None, temporal_resolution=None,
         period=None, data_through=None, fetched_at=None, from_cache=False, stale=False,
         auth="none", note=None):
    if kind not in KINDS:
        raise ValueError("unknown provenance kind: %s" % kind)
    age = None
    if data_through:
        try:
            age = (dt.date.today() - dt.date.fromisoformat(data_through[:10])).days
        except ValueError:
            age = None
    return {
        "source": source, "dataset": dataset, "kind": kind, "kind_text": KIND_TEXT[kind],
        "units": units, "spatial_resolution": spatial_resolution, "temporal_resolution": temporal_resolution,
        "period": period, "data_through": data_through, "data_age_days": age,
        "fetched_at": iso(fetched_at) if fetched_at else None,
        "served_from_cache": from_cache, "stale_copy": stale,
        "authentication_needed_by_farmer": False, "upstream_auth": auth, "note": note,
        "is_live": False,   # nothing here is real-time; see data_through / data_age_days
    }
