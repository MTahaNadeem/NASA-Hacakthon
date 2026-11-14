import pytest

from app import config
from app.providers import cmr, modis
from conftest import load


def test_real_stac_response_parses_newest_first_with_sensor_and_dates():
    items = modis.parse_items(load("stac_modis13q1_lahore.json"))
    assert items and items[0]["start"] >= items[-1]["start"]
    assert {i["sensor"] for i in items} <= {"Terra", "Aqua"}
    assert items[0]["ndvi_href"].endswith("_250m_16_days_NDVI.tif")
    assert items[0]["reliability_href"].endswith("_pixel_reliability.tif")


def test_asset_on_a_host_outside_the_allow_list_is_ignored():
    payload = load("stac_modis13q1_lahore.json")
    payload["features"][0]["assets"]["250m_16_days_NDVI"]["href"] = "https://evil.example.com/x.tif"
    items = modis.parse_items(payload)
    assert all("evil.example.com" not in i["ndvi_href"] for i in items)
    assert len(items) == len(load("stac_modis13q1_lahore.json")["features"]) - 1


def test_ndvi_scaling_and_quality_rules():
    ok = modis.classify(5315, 0)
    assert ok == {"ndvi": 0.5315, "reliability": 0, "reason": None}         # same raw value measured live for Lahore farmland
    assert modis.classify(5315, 1)["ndvi"] == 0.5315                        # marginal is accepted
    assert modis.classify(5315, 3)["ndvi"] is None                          # cloud/snow rank rejected
    assert modis.classify(-3000, 0)["ndvi"] is None                         # fill value
    assert modis.classify(12000, 0)["ndvi"] is None                         # out of physical range


def test_a_failed_read_leaves_a_blank_with_a_reason_never_a_number(cache, monkeypatch):
    items = modis.parse_items(load("stac_modis13q1_lahore.json"))[:3]
    def boom(item, lat, lon): raise OSError("network")
    monkeypatch.setattr(modis, "read_pixel", boom)
    rows = modis.series(31.45, 74.10, items, cache)
    assert len(rows) == 3 and all(r["ndvi"] is None and "read failed" in r["reason"] for r in rows)


def test_series_caches_each_finished_composite_per_pixel(cache, monkeypatch):
    items = modis.parse_items(load("stac_modis13q1_lahore.json"))[:2]
    calls = []
    monkeypatch.setattr(modis, "read_pixel", lambda item, lat, lon: calls.append(item["id"]) or {"ndvi": 0.5, "reliability": 0, "reason": None})
    modis.series(31.45, 74.10, items, cache); modis.series(31.45, 74.10, items, cache)
    assert len(calls) == 2           # second farmer on the same pixel cost nothing


def test_cmr_parses_real_smap_and_imerg_granules():
    s = cmr.parse_latest(load("cmr_smap_latest.json")); i = cmr.parse_latest(load("cmr_imerg_latest.json"))
    assert s["granule"].startswith("SMAP_L3_SM_P_E_") and len(s["end"]) == 10
    assert i["granule"].startswith("GPM_3IMERGDL") and len(i["end"]) == 10


def test_cmr_empty_result_is_none():
    assert cmr.parse_latest({"items": []}) is None


def test_only_expected_hosts_are_whitelisted():
    assert config.UPSTREAM_HOSTS == {"power.larc.nasa.gov", "planetarycomputer.microsoft.com",
                                     "modiseuwest.blob.core.windows.net", "cmr.earthdata.nasa.gov", "files.isric.org"}


def test_container_token_is_fetched_once_and_reused_until_near_expiry():
    calls = []
    def fetch():
        calls.append(1); return {"token": "T%d" % len(calls), "msft:expiry": "2026-11-14T12:00:00Z"}
    modis._tok.update(value=None, expires=0.0)
    import datetime as dt
    t0 = dt.datetime(2026, 11, 14, 11, 0, tzinfo=dt.timezone.utc).timestamp()
    assert modis.container_token(fetch, now=t0) == "T1" and modis.container_token(fetch, now=t0 + 600) == "T1"
    assert len(calls) == 1                                                # 42 composites would otherwise cost 84 signing calls
    assert modis.container_token(fetch, now=t0 + 3500) == "T2"           # within 5 minutes of expiry: refreshed
    modis._tok.update(value=None, expires=0.0)


def test_a_token_response_without_a_token_is_an_error():
    modis._tok.update(value=None, expires=0.0)
    with pytest.raises(modis.ModisError):
        modis.container_token(lambda: {"msft:expiry": "2026-11-14T12:00:00Z"})
