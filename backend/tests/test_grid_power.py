import datetime as dt
import pytest

from app import grid
from app.providers import power
from conftest import load


def test_cell_edges_match_the_edges_measured_on_the_live_POWER_api():
    # Measured 2026-11-14: values identical at lon 74.375..74.68, different at 74.70
    assert grid.power_cell(31.5, 74.375)["key"] == grid.power_cell(31.5, 74.68)["key"]
    assert grid.power_cell(31.5, 74.68)["key"] != grid.power_cell(31.5, 74.70)["key"]
    # latitude edges at 31.25 and 31.75
    assert grid.power_cell(31.74, 74.375)["key"] == grid.power_cell(31.70, 74.375)["key"]
    assert grid.power_cell(31.74, 74.375)["key"] != grid.power_cell(31.76, 74.375)["key"]
    assert grid.power_cell(31.24, 74.375)["key"] != grid.power_cell(31.26, 74.375)["key"]


def test_three_points_inside_one_cell_share_a_cache_key():
    keys = {grid.power_cell(*p)["key"] for p in [(31.55, 74.35), (31.60, 74.40), (31.70, 74.50)]}
    assert len(keys) == 1


def test_bad_coordinates_are_rejected():
    for bad in [(91, 0), (-91, 0), (0, 181), (0, -181)]:
        with pytest.raises(ValueError):
            grid.check_lat_lon(*bad)


def test_parse_real_power_response():
    p = power.parse(load("power_lahore_2024.json"))
    assert set(["T2M", "PRECTOTCORR", "GWETROOT"]) <= set(p["series"])
    assert len(p["series"]["T2M"]) == 366
    assert "MERRA2" in p["sources"]
    assert p["empty_parameters"] == []


def test_imerg_parameter_that_returns_only_fill_values_is_dropped_not_kept():
    # real response (Jan 2025): IMERG_PRECTOT is -999 on all 31 days
    p = power.parse(load("power_lahore_2025-01_with_empty_imerg.json"))
    assert "IMERG_PRECTOT" in p["empty_parameters"]
    assert "IMERG_PRECTOT" not in p["series"]
    assert "IMERG_PRECTOT" not in power.PARAMS      # and we never ask for it


def test_fill_values_become_none_not_numbers():
    p = power.parse({"properties": {"parameter": {"T2M": {"20260101": 10.5, "20260102": -999.0}}}})
    assert p["series"]["T2M"] == {"20260101": 10.5, "20260102": None}
    assert power.last_valid_date(p["series"]) == "20260101"


def test_odd_response_shape_is_an_error_not_silently_empty():
    with pytest.raises(power.PowerError):
        power.parse({"unexpected": 1})
