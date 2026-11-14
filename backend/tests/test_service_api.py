import json

import pytest
from fastapi.testclient import TestClient

from app import config, main, service
from app.providers import cmr, modis, power
from conftest import load


@pytest.fixture
def api(tmp_path, monkeypatch):
    """The API with every upstream replaced by a REAL captured response (no network in tests)."""
    from app.cache import Cache
    main._cache = Cache(str(tmp_path / "api.sqlite3"))
    main._limiter.per_minute = 1000
    calls = {"power": 0, "cmr": 0}
    def fake_power(lat, lon):
        calls["power"] += 1
        return power.parse(load("power_lahore_2024.json"))
    def fake_cmr(product):
        calls["cmr"] += 1
        return cmr.parse_latest(load("cmr_smap_latest.json" if product == "smap" else "cmr_imerg_latest.json"))
    monkeypatch.setattr(power, "fetch", fake_power)
    monkeypatch.setattr(cmr, "latest", fake_cmr)
    monkeypatch.setattr(modis, "search", lambda lat, lon, months, client=None: modis.parse_items(load("stac_modis13q1_lahore.json")))
    monkeypatch.setattr(modis, "read_pixel", lambda item, lat, lon: modis.classify(5315, 0))
    return TestClient(main.app), calls


def test_health_and_sources(api):
    c, _ = api
    assert c.get("/api/health").json()["status"] == "ok"
    s = c.get("/api/sources").json()
    assert all(x["auth_for_farmer"] is False for x in s["sources"])
    assert {x["id"] for x in s["sources"]} == {"power", "modis_ndvi", "smap", "imerg"}
    assert any("IMERG_PRECTOT" in n["name"] for n in s["not_used"])


def test_location_returns_provenance_on_every_block_and_never_claims_live(api):
    c, _ = api
    d = c.get("/api/location?lat=31.55&lon=74.35").json()
    for block in (d["climate"], d["rainfall"], d["soil_moisture"]["modelled"], d["indicators"]):
        p = block["provenance"]
        assert p["is_live"] is False and p["authentication_needed_by_farmer"] is False and p["data_through"]
    assert d["climate"]["provenance"]["kind"] == "reanalysis"
    assert d["indicators"]["provenance"]["kind"] == "calculated"
    assert d["soil_moisture"]["modelled"]["provenance"]["kind"] == "reanalysis"


def test_modelled_soil_moisture_is_not_passed_off_as_SMAP(api):
    c, _ = api
    sm = c.get("/api/location?lat=31.55&lon=74.35").json()["soil_moisture"]
    assert sm["smap"]["values_available"] is False and sm["smap"]["status"] == "discovery_only"
    assert "not a satellite measurement" in sm["modelled"]["provenance"]["note"]
    assert sm["smap"]["newest_acquisition"]        # real date from the CMR fixture


def test_rainfall_is_labelled_reanalysis_and_imerg_has_no_values(api):
    c, _ = api
    r = c.get("/api/location?lat=31.55&lon=74.35").json()["rainfall"]
    assert r["provenance"]["kind"] == "reanalysis" and "NOT satellite IMERG" in r["provenance"]["note"]
    assert r["imerg"]["values_available"] is False


def test_nearby_farmers_share_one_upstream_request(api):
    c, calls = api
    c.get("/api/location?lat=31.55&lon=74.35"); c.get("/api/location?lat=31.60&lon=74.40"); c.get("/api/location?lat=31.70&lon=74.50")
    assert calls["power"] == 1                       # one POWER request for the whole cell
    d = c.get("/api/location?lat=31.65&lon=74.45").json()
    assert d["climate"]["provenance"]["served_from_cache"] is True


def test_a_different_cell_triggers_a_new_request(api):
    c, calls = api
    c.get("/api/location?lat=31.55&lon=74.35"); c.get("/api/location?lat=32.10&lon=74.35")
    assert calls["power"] == 2


def test_ndvi_endpoint_gaps_and_provenance(api, monkeypatch):
    c, _ = api
    rows = iter([modis.classify(5315, 0), modis.classify(-3000, 0)] * 100)
    monkeypatch.setattr(modis, "read_pixel", lambda item, lat, lon: next(rows))
    d = c.get("/api/ndvi?lat=31.45&lon=74.10").json()
    assert d["ndvi"]["valid_count"] < d["ndvi"]["total_count"] and d["gaps"]
    assert d["ndvi"]["provenance"]["kind"] == "satellite_estimate"
    assert "not a measurement of crop health" in d["ndvi"]["provenance"]["note"]
    assert all(r["ndvi"] is None for r in d["ndvi"]["series"] if r["reason"])      # blanks stay blank


def test_input_validation(api):
    c, _ = api
    assert c.get("/api/location?lat=95&lon=0").status_code == 422
    assert c.get("/api/location?lat=0&lon=200").status_code == 422
    assert c.get("/api/location").status_code == 422
    assert c.get("/api/ndvi?lat=1&lon=1&months=99").status_code == 422


def test_upstream_failure_is_a_502_with_no_invented_numbers(api, monkeypatch):
    c, _ = api
    def down(lat, lon): raise power.PowerError("NASA POWER answered HTTP 503")
    monkeypatch.setattr(power, "fetch", down)
    r = c.get("/api/location?lat=10&lon=10")
    assert r.status_code == 502 and "climate" not in r.json() and "unavailable" in r.json()["detail"]


def test_rate_limit(api):
    c, _ = api
    main._limiter.per_minute = 2; main._limiter._hits.clear()
    codes = [c.get("/api/location?lat=31.55&lon=74.35").status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and 429 in codes[2:]


def test_earthdata_token_never_appears_in_any_response(api, monkeypatch):
    c, _ = api
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "SUPER-SECRET-TOKEN-123")
    for url in ("/api/health", "/api/sources", "/api/location?lat=31.55&lon=74.35", "/api/ndvi?lat=31.45&lon=74.10"):
        body = c.get(url).text
        assert "SUPER-SECRET-TOKEN-123" not in body
    d = c.get("/api/location?lat=31.55&lon=74.35").json()
    assert d["soil_moisture"]["smap"]["server_token_configured"] is True        # reported as a boolean only
    assert d["soil_moisture"]["smap"]["values_available"] is False              # configured != validated


def test_responses_are_json_serialisable_and_have_no_nan(api):
    c, _ = api
    text = c.get("/api/location?lat=31.55&lon=74.35").text
    json.loads(text); assert "NaN" not in text
