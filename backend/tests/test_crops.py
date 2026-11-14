import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main, service
from app.providers import landcover as lc
from conftest import load

AMES = load("crops_ames_cdl2021.json")          # REAL polygons produced from the USDA Cropland Data Layer 2021 on 2026-11-14
LAHORE = load("crops_lahore_worldcover2021.json")   # REAL cropland polygons from ESA WorldCover 2021


# ---- what the real data says ----
def test_real_cdl_polygons_carry_real_crop_names_with_usda_colours():
    props = [f["properties"] for f in AMES["features"]]
    crops = {p["crop"] for p in props}
    assert {"Corn", "Soybeans"} <= crops and len(crops) >= 5
    colours = {p["crop"]: p["color"] for p in props}
    assert colours["Corn"] == "#FFD200" and colours["Soybeans"] == "#256F00"          # USDA's own colour table, not ours
    assert AMES["meta"]["crop_type_available"] is True and AMES["meta"]["kind"] == "model_prediction" and AMES["meta"]["year"] == 2021


def test_non_agricultural_classes_are_never_shown_as_crops():
    names = {f["properties"]["crop"] for f in AMES["features"]}
    assert not any(lc._NON_AG.search(n) for n in names)


def test_worldcover_never_claims_a_crop_type():
    assert LAHORE["meta"]["crop_type_available"] is False
    assert {f["properties"]["crop"] for f in LAHORE["features"]} == {"Cropland (crop type not identified)"}
    assert any("cannot say which crop" in n for n in LAHORE["meta"]["notes"])


def test_polygons_are_valid_geojson_with_areas_and_no_invented_fields():
    for fc in (AMES, LAHORE):
        for f in fc["features"]:
            ring = f["geometry"]["coordinates"][0]
            assert f["geometry"]["type"] == "Polygon" and ring[0] == ring[-1] and len(ring) >= 4
            assert f["properties"]["area_ha"] >= lc.MIN_AREA_HA
        assert "Field ID" not in json.dumps(fc) and "field_id" not in json.dumps(fc)       # the datasets have none
        assert any("no field IDs" in n for n in fc["meta"]["notes"])


# ---- classification helpers ----
def test_categories_are_a_documented_grouping_of_usda_names_and_never_guessed():
    assert lc.crop_category("Corn") == "Cereal" and lc.crop_category("Soybeans") == "Oilseed" and lc.crop_category("Cotton") == "Fibre"
    assert lc.crop_category("Other Hay/Non Alfalfa") == "Fodder / pasture" and lc.crop_category("Alfalfa") == "Fodder / pasture"
    assert lc.crop_category("Apples") == "Orchard / fruit" and lc.crop_category("Almonds") == "Nut"
    assert lc.crop_category("Something Unheard Of") is None


def test_only_agricultural_names_pass():
    assert lc.is_agricultural("Winter Wheat") and lc.is_agricultural("Fallow/Idle Cropland")
    for n in ("Developed/Low Intensity", "Deciduous Forest", "Open Water", "Clouds/No Data", "Grassland/Pasture", "Woody Wetlands", "Shrubland"):
        assert not lc.is_agricultural(n)


def test_source_choice_cdl_only_inside_the_usa():
    assert lc.choose_source(-93.66, 42.0, -93.62, 42.04) == "cdl"
    for box in ((74.05, 31.4, 74.09, 31.44), (36.8, -1.3, 36.9, -1.2), (-51.2, -23.4, -51.1, -23.3)):
        assert lc.choose_source(*box) == "worldcover"


# ---- geometry on small hand-made rasters (the arithmetic, not data) ----
def _features(arr, table, source="cdl"):
    from rasterio import Affine
    tr = Affine(0.001, 0, 10.0, 0, -0.001, 20.0)               # 0.001 degree pixels
    return lc.window_features(np.array(arr, "int32"), tr, lambda x, y: (x, y), table, source, 2021, "test")


def test_connected_areas_become_one_polygon_each_and_other_classes_are_ignored():
    arr = [[1, 1, 0, 2, 2],
           [1, 1, 0, 2, 2],
           [0, 0, 0, 0, 0],
           [1, 0, 0, 0, 83]]
    feats, dropped = _features(arr, {1: ("Corn", "#ffd200"), 2: ("Soybeans", "#256f00"), 83: ("Water", None), 0: ("Background", None)})
    by = {}
    for f in feats:
        by.setdefault(f["properties"]["crop"], []).append(f)
    assert len(by["Corn"]) == 2 and len(by["Soybeans"]) == 1 and "Water" not in by and "Background" not in by      # separate Corn patches stay separate


def test_area_in_hectares_is_physically_right():
    # a 0.01 x 0.01 degree square at 20 N is about 1.04 km x 1.11 km = ~116 ha
    ha = lc.polygon_area_ha([[(10, 20), (10.01, 20), (10.01, 20.01), (10, 20.01), (10, 20)]], 20.005, 10.005)
    assert 110 < ha < 122
    holed = lc.polygon_area_ha([[(10, 20), (10.01, 20), (10.01, 20.01), (10, 20.01), (10, 20)], [(10.004, 20.004), (10.006, 20.004), (10.006, 20.006), (10.004, 20.006), (10.004, 20.004)]], 20.005, 10.005)
    assert holed < ha                                                      # a hole (a pond, a building) is not counted as crop


def test_tiny_patches_are_dropped_and_counted_not_hidden():
    arr = np.zeros((40, 40), "int32"); arr[0, 0] = 1                       # one 0.001 degree pixel ~1.2 ha
    feats, dropped = _features(arr, {1: ("Corn", None)})
    assert len(feats) == 1                                                  # kept: bigger than the 0.05 ha minimum
    lc_min = lc.MIN_AREA_HA; lc.MIN_AREA_HA = 5.0
    try:
        feats, dropped = _features(arr, {1: ("Corn", None)})
    finally:
        lc.MIN_AREA_HA = lc_min
    assert feats == [] and dropped == 1


def test_worldcover_keeps_only_the_cropland_class_and_names_it_honestly():
    feats, _ = _features([[40, 40, 10], [40, 50, 10], [80, 80, 30]], {10: ("Tree cover", None), 40: ("Cropland", None), 50: ("Built-up", None)}, source="worldcover")
    assert {f["properties"]["crop"] for f in feats} == {"Cropland (crop type not identified)"}


# ---- service and API ----
@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.cache import Cache
    main._cache = Cache(str(tmp_path / "c.sqlite3")); main._limiter.per_minute = 1000
    calls = []
    def fake(west, south, east, north, source=None, **kw):
        calls.append(source); return AMES if source == "cdl" else LAHORE
    monkeypatch.setattr(lc, "fetch", fake)
    return TestClient(main.app), calls


def test_endpoint_picks_the_right_dataset_and_says_which(api):
    c, calls = api
    us = c.get("/api/crops?west=-93.66&south=42.0&east=-93.62&north=42.04").json()
    pk = c.get("/api/crops?west=74.05&south=31.4&east=74.09&north=31.44").json()
    assert us["meta"]["source"] == "cdl" and us["meta"]["crop_type_available"] is True
    assert pk["meta"]["source"] == "worldcover" and pk["meta"]["crop_type_available"] is False
    assert us["meta"]["is_live"] is False and calls == ["cdl", "worldcover"]


def test_the_same_box_is_served_from_cache(api):
    c, calls = api
    q = "/api/crops?west=-93.66&south=42.0&east=-93.62&north=42.04"
    c.get(q); second = c.get(q).json()
    assert second["meta"]["served_from_cache"] is True and len(calls) == 1


@pytest.mark.parametrize("q", ["west=-93.7&south=42.0&east=-93.5&north=42.04",            # too wide
                               "west=-93.62&south=42.0&east=-93.66&north=42.04",           # west > east
                               "west=-93.66&south=42.04&east=-93.62&north=42.0",           # south > north
                               "west=-93.66&south=42.0&east=-93.62&north=42.04&source=bogus",
                               "west=-193.66&south=42.0&east=-93.62&north=42.04",          # out of range
                               "west=-93.66&south=42.0&east=-93.62"])                       # missing north
def test_bad_boxes_are_rejected(api, q):
    c, _ = api
    assert c.get("/api/crops?" + q).status_code in (400, 422)


def test_a_failing_dataset_is_an_error_never_invented_polygons(api, monkeypatch):
    c, _ = api
    monkeypatch.setattr(lc, "fetch", lambda *a, **k: (_ for _ in ()).throw(lc.LandcoverError("catalogue answered HTTP 503")))
    r = c.get("/api/crops?west=10&south=10&east=10.04&north=10.04")
    assert r.status_code == 502 and "features" not in r.json()
