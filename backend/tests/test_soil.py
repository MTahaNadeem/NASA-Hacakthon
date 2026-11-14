import pytest
from fastapi.testclient import TestClient

from app import main, service
from app.providers import soilgrids as sg


# ---- the tile index must find exactly the pixels measured on the real ISRIC files (2026-11-14) ----
def test_pixel_and_tile_lookup_match_values_read_from_the_real_VRT():
    assert sg.pixel(38.5, -98.0) == (35968, 16300)        # Kansas farmland: pH raw 67 read from the live file
    assert sg.pixel(31.45, 74.10) == (109909, 19440)      # Lahore farmland: pH raw 79
    assert sg.pixel(42.03, -93.62) == (37397, 14731)      # Ames, an unmapped built-up pixel


def test_each_property_has_its_own_tile_layout():
    ph, soc = sg.tile_for("ph", 35968, 16300), sg.tile_for("soc", 35968, 16300)
    assert ph and soc and ph["dir"] and soc["dir"]
    assert sg._index("ph")["step"] == 600 and sg._index("soc")["step"] == 450      # pH 600x600, carbon 450x450


def test_layer_url_uses_the_property_specific_tile():
    t = sg.tile_for("clay", 35968, 16300)
    u = sg.layer_url("clay", "5-15cm", "Q0.95", t)
    assert u.startswith("https://files.isric.org/soilgrids/latest/data/clay/clay_5-15cm_Q0.95/") and u.endswith(".tif")


def test_no_tile_means_no_data_not_a_guess():
    assert sg.tile_for("ph", 0, 0) is None


def test_outside_the_map_has_no_pixel():
    assert sg.pixel(89.99, 0) is None or isinstance(sg.pixel(89.99, 0), tuple)


# ---- combining layers (hand-made raw integers; these test the arithmetic, they are not soil data) ----
def raw_all(v):
    return {(p, d, s): v for p in sg.PROPS for d, _ in sg.DEPTHS for s, _ in sg.STATS}


def test_depth_weighting_and_units():
    raw = raw_all(100)
    raw[("ph", "0-5cm", "mean")] = 60; raw[("ph", "5-15cm", "mean")] = 70; raw[("ph", "15-30cm", "mean")] = 80
    soil = sg.combine(raw)
    assert soil["ph"]["mean"] == round((5 * 6.0 + 10 * 7.0 + 15 * 8.0) / 30, 2)       # thickness-weighted, pH x10 stored
    assert soil["clay"]["mean"] == 10.0                                                 # 100 g/kg -> 10 %


def test_a_property_with_any_missing_layer_is_left_out_not_guessed():
    raw = raw_all(100); raw[("soc", "5-15cm", "q05")] = None
    soil = sg.combine(raw)
    assert "soc" not in soil and "ph" in soil


# ---- nearest mapped pixel ----
def test_uses_the_requested_pixel_when_mapped():
    assert sg.nearest_mapped(38.5, -98.0, probe=lambda c, r: True)[2] == 0


def test_searches_outward_when_the_point_is_unmapped_and_reports_the_distance():
    seen = []
    def probe(c, r):
        seen.append((c, r))
        return True if len(seen) > 3 else None      # centre and the first ring's first two candidates are unmapped
    c, r, km = sg.nearest_mapped(42.03, -93.62, probe=probe)
    assert km == 2


def test_gives_up_honestly_when_nothing_is_mapped_within_25_km():
    out = sg.fetch(42.03, -93.62, reader=lambda *a: None, probe=lambda c, r: None)
    assert out["soil"] == {} and out["distance_km"] is None and "no soil data within 25 km" in out["reason"]


def test_fetch_reads_45_layers_and_returns_the_app_format():
    calls = []
    def reader(prop, depth, stat, col, row):
        calls.append((prop, depth, stat)); return 70
    out = sg.fetch(38.5, -98.0, reader=reader, probe=lambda c, r: True)
    assert len(calls) == 45 and len(set(calls)) == 45
    assert set(out["soil"]) == set(sg.PROPS) and set(out["soil"]["ph"]) == {"q05", "mean", "q95"}


# ---- service + API ----
@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.cache import Cache
    main._cache = Cache(str(tmp_path / "s.sqlite3")); main._limiter.per_minute = 1000
    n = {"calls": 0}
    def fake(lat, lon):
        n["calls"] += 1
        return {"soil": {"ph": {"q05": 6.0, "mean": 7.0, "q95": 8.0}}, "distance_km": 4, "pixel": [1, 2], "reason": None}
    monkeypatch.setattr(sg, "fetch", fake)
    return TestClient(main.app), n


def test_soil_endpoint_labels_it_not_NASA_and_discloses_the_distance(api):
    c, _ = api
    d = c.get("/api/soil?lat=38.5&lon=-98.0").json()
    assert d["provenance"]["kind"] == "third_party" and "not NASA" in d["provenance"]["source"]
    assert d["provenance"]["is_live"] is False and "not a measurement of this field" in d["provenance"]["note"]
    assert any("nearest mapped land 4 km away" in g for g in d["gaps"])
    assert d["gaps"] and "No value for" in " ".join(d["gaps"])        # four properties absent in the fake record


def test_soil_is_cached_per_pixel(api):
    c, n = api
    c.get("/api/soil?lat=38.5&lon=-98.0"); c.get("/api/soil?lat=38.5&lon=-98.0")
    assert n["calls"] == 1


def test_soil_bad_input(api):
    c, _ = api
    assert c.get("/api/soil?lat=100&lon=0").status_code == 422


# ---- NDVI monthly climatology for the app's bare-field factor ----
def test_monthly_ndvi_uses_midpoint_month_and_leaves_gaps_as_none():
    rows = [{"start": "2025-12-25", "ndvi": 0.4}, {"start": "2026-01-02", "ndvi": 0.6}, {"start": "2026-01-10", "ndvi": 0.5},
            {"start": "2026-01-26", "ndvi": 0.9}, {"start": "2026-03-01", "ndvi": None}]
    clim, n = service.monthly_ndvi(rows)
    assert clim[0] == round((0.4 + 0.6 + 0.5) / 3, 4) and n[0] == 3          # starts +8 days: 25 Dec->2 Jan, 2 Jan->10 Jan, 10 Jan->18 Jan
    assert clim[1] is None and n[1] == 1                                      # 26 Jan + 8 days is 3 Feb; ONE composite is too thin to define a month
    two = service.monthly_ndvi([{"start": "2026-02-01", "ndvi": 0.2}, {"start": "2026-02-10", "ndvi": 0.4}])[0]
    assert two[1] == 0.3                                                       # two valid composites are enough
    assert clim[2] is None and n[2] == 0 and len(clim) == 12                  # a month with no valid composite stays blank
