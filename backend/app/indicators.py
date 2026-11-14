"""Agricultural indicators CALCULATED from NASA POWER daily data.

Nothing here is an observation. The thresholds are this app's own, documented definitions,
and the API returns them in `definitions` so nobody mistakes them for NASA values."""
import numpy as np
import pandas as pd

DEFINITIONS = {
    "gdd_base_10": "Growing degree days: sum over days of max(0, (Tmax+Tmin)/2 - 10 C).",
    "heat_days_35": "Days with maximum temperature of 35 C or more.",
    "frost_days": "Days with minimum temperature of 0 C or less.",
    "heavy_rain_days_20": "Days with 20 mm or more of rain (MERRA-2 grid-cell average, so point storms are under-represented).",
    "longest_dry_spell_days": "Longest run of consecutive days with less than 1 mm of rain in the calendar year.",
    "root_wetness": "MERRA-2 modelled root-zone soil wetness, 0 (dry) to 1 (saturated). A model estimate, not SMAP.",
    "recent_window_days": "The last 90 days with valid data, compared with the same 90-day window in earlier years.",
}
RECENT_DAYS = 90
MIN_VALID_DAYS_FOR_YEAR = 350


def frame(series):
    df = pd.DataFrame({k: pd.Series(v) for k, v in series.items()})
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    return df.sort_index()


def _longest_run(mask):
    best = cur = 0
    for m in mask:
        cur = cur + 1 if m else 0
        best = max(best, cur)
    return best


def annual(df):
    rows = []
    for year, g in df.groupby(df.index.year):
        if g["T2M"].notna().sum() < MIN_VALID_DAYS_FOR_YEAR:
            continue   # an unfinished year would distort totals; it is excluded, not guessed
        tmax, tmin = g.get("T2M_MAX"), g.get("T2M_MIN")
        row = {"year": int(year), "rain_mm": round(float(g["PRECTOTCORR"].sum()), 1) if "PRECTOTCORR" in g else None,
               "t_mean_c": round(float(g["T2M"].mean()), 2)}
        if tmax is not None and tmin is not None:
            row["gdd_base_10"] = round(float(np.maximum(0, (tmax + tmin) / 2 - 10).sum()), 0)
            row["heat_days_35"] = int((tmax >= 35).sum())
            row["frost_days"] = int((tmin <= 0).sum())
        if "PRECTOTCORR" in g:
            row["heavy_rain_days_20"] = int((g["PRECTOTCORR"] >= 20).sum())
            row["longest_dry_spell_days"] = _longest_run((g["PRECTOTCORR"].fillna(0) < 1).tolist())
        if "GWETROOT" in g:
            row["root_wetness_mean"] = round(float(g["GWETROOT"].mean()), 3)
        rows.append(row)
    return rows


def monthly_climatology(df, full_years):
    sub = df[df.index.year.isin(full_years)] if full_years else df
    out = []
    for m in range(1, 13):
        g = sub[sub.index.month == m]
        if g.empty:
            continue
        rain = g["PRECTOTCORR"].groupby(g.index.year).sum().mean() if "PRECTOTCORR" in g else np.nan
        row = {"month": m, "t_mean_c": round(float(g["T2M"].mean()), 2), "rain_mm": None if np.isnan(rain) else round(float(rain), 1)}
        for key, col in (("t_max_c", "T2M_MAX"), ("t_min_c", "T2M_MIN"), ("humidity_pct", "RH2M"),
                         ("solar_mj_m2_day", "ALLSKY_SFC_SW_DWN"), ("root_wetness", "GWETROOT")):
            if col in g:
                row[key] = round(float(g[col].mean()), 3 if key == "root_wetness" else 2)
        out.append(row)
    return out


def recent_vs_normal(df):
    t2m = df["T2M"].dropna()
    if len(t2m) < RECENT_DAYS:
        return None
    end = t2m.index[-1]
    start = end - pd.Timedelta(days=RECENT_DAYS - 1)
    cur = df[(df.index >= start) & (df.index <= end)]
    res = {"window_start": start.strftime("%Y-%m-%d"), "window_end": end.strftime("%Y-%m-%d"),
           "t_mean_c": round(float(cur["T2M"].mean()), 2)}
    hist = {"t": [], "rain": [], "wet": []}
    for y in sorted(set(df.index.year) - {end.year, start.year}):
        try:
            s, e = start.replace(year=y), end.replace(year=y)
        except ValueError:
            continue
        if end.year != start.year:   # window straddles New Year; skip rather than mis-align years
            continue
        g = df[(df.index >= s) & (df.index <= e)]
        if g["T2M"].notna().sum() < RECENT_DAYS - 5:
            continue
        hist["t"].append(float(g["T2M"].mean()))
        if "PRECTOTCORR" in g:
            hist["rain"].append(float(g["PRECTOTCORR"].sum()))
        if "GWETROOT" in g:
            hist["wet"].append(float(g["GWETROOT"].mean()))
    res["years_compared"] = len(hist["t"])
    if "PRECTOTCORR" in cur:
        res["rain_mm"] = round(float(cur["PRECTOTCORR"].sum()), 1)
    if "GWETROOT" in cur:
        res["root_wetness"] = round(float(cur["GWETROOT"].mean()), 3)
    if len(hist["t"]) >= 5:
        res["t_anomaly_c"] = round(res["t_mean_c"] - float(np.mean(hist["t"])), 2)
        if hist["rain"] and "rain_mm" in res:
            norm = float(np.mean(hist["rain"]))
            res["rain_normal_mm"] = round(norm, 1)
            res["rain_anomaly_pct"] = None if norm < 1 else round((res["rain_mm"] - norm) / norm * 100, 0)
        if hist["wet"] and "root_wetness" in res:
            res["root_wetness_percentile"] = int(round(100 * float(np.mean(np.array(hist["wet"]) <= res["root_wetness"]))))
            p = res["root_wetness_percentile"]
            res["soil_state"] = "drier_than_usual" if p <= 20 else "wetter_than_usual" if p >= 80 else "typical"
    return res


def trends(annual_rows):
    out = {}
    for key, name in (("rain_mm", "rain_mm_per_decade"), ("t_mean_c", "t_mean_c_per_decade")):
        pts = [(r["year"], r[key]) for r in annual_rows if r.get(key) is not None]
        if len(pts) >= 10:
            x, y = np.array([p[0] for p in pts], float), np.array([p[1] for p in pts], float)
            out[name] = round(float(np.polyfit(x, y, 1)[0] * 10), 2)
    for key, name in (("rain_mm", "rain_mm"), ("t_mean_c", "t_mean_c")):
        pts = [r[key] for r in annual_rows if r.get(key) is not None]
        if len(pts) >= 10:
            half = len(pts) // 2
            out["earlier_mean_" + name] = round(float(np.mean(pts[:half])), 2)
            out["later_mean_" + name] = round(float(np.mean(pts[-half:])), 2)
    if out:
        out["years_used"] = len(annual_rows)
        out["caution"] = ("About 20 years only, from a reanalysis model. A few very wet, dry or hot years can dominate a straight-line "
                          "slope, so compare the earlier and later averages too. This is a description of the past, not a climate projection.")
    return out


def compute(series):
    df = frame(series)
    rows = annual(df)
    return {"definitions": DEFINITIONS, "annual": rows,
            "monthly_climatology": monthly_climatology(df, [r["year"] for r in rows]),
            "recent": recent_vs_normal(df), "trends": trends(rows)}
