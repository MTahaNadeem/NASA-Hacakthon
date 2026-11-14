import numpy as np
import pandas as pd

from app import indicators as ind


def mk(days, **cols):
    idx = pd.date_range("2020-01-01", periods=days)
    return pd.DataFrame({k: pd.Series(v, index=idx) for k, v in cols.items()})


# ---- function behaviour, checked with small hand-made inputs (these are test inputs, not NASA data) ----
def test_longest_dry_spell_counts_consecutive_days_under_1mm():
    assert ind._longest_run([True, True, False, True, True, True, False]) == 3


def test_gdd_heat_frost_and_heavy_rain_counts_on_a_known_year():
    n = 366
    df = mk(n, T2M=[10.0] * n, T2M_MAX=[20.0] * 100 + [36.0] * 10 + [20.0] * (n - 110),
            T2M_MIN=[10.0] * 5 + [-1.0] * 3 + [10.0] * (n - 8),
            PRECTOTCORR=[0.0] * 50 + [25.0] * 2 + [0.5] * (n - 52), GWETROOT=[0.4] * n)
    row = ind.annual(df)[0]
    assert row["heat_days_35"] == 10 and row["frost_days"] == 3 and row["heavy_rain_days_20"] == 2
    assert row["longest_dry_spell_days"] == 314      # days 0-49 are dry, 50-51 are heavy rain, days 52-365 are 0.5 mm (< 1 mm) = 314 in a row
    assert row["rain_mm"] == round(2 * 25.0 + (n - 52) * 0.5, 1)


def test_gdd_never_negative():
    n = 366
    df = mk(n, T2M=[0.0] * n, T2M_MAX=[2.0] * n, T2M_MIN=[-3.0] * n, PRECTOTCORR=[0.0] * n)
    assert ind.annual(df)[0]["gdd_base_10"] == 0


def test_unfinished_year_is_excluded_not_extrapolated():
    df = mk(200, T2M=[20.0] * 200, PRECTOTCORR=[1.0] * 200)
    assert ind.annual(df) == []


def test_trend_needs_ten_years_and_warns():
    rows = [{"year": 2000 + i, "rain_mm": 500 + 10 * i, "t_mean_c": 20.0} for i in range(12)]
    t = ind.trends(rows)
    assert t["rain_mm_per_decade"] == 100.0 and "caution" in t and "not a climate projection" in t["caution"]
    assert ind.trends(rows[:5]) == {}


# ---- against the REAL Lahore 2024 NASA POWER record ----
def test_real_lahore_2024_year_is_complete_and_plausible(power_2024):
    out = ind.compute(power_2024["series"])
    assert [r["year"] for r in out["annual"]] == [2024]
    y = out["annual"][0]
    assert 20 < y["t_mean_c"] < 30 and y["gdd_base_10"] > 4000
    assert y["frost_days"] == 0                       # Lahore plains: no frost in 2024 record
    assert len(out["monthly_climatology"]) == 12
    jul = next(m for m in out["monthly_climatology"] if m["month"] == 7)
    jan = next(m for m in out["monthly_climatology"] if m["month"] == 1)
    assert jul["t_mean_c"] > jan["t_mean_c"] + 10 and jul["rain_mm"] > jan["rain_mm"]     # monsoon city


def test_definitions_are_returned_so_thresholds_are_not_hidden(power_2024):
    out = ind.compute(power_2024["series"])
    assert "35 C" in out["definitions"]["heat_days_35"] and "not SMAP" in out["definitions"]["root_wetness"]
