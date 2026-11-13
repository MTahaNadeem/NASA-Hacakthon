import json, sys, tempfile, csv
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import build_cache as bc

def test_power_and_soilgrids_parse():
    with tempfile.TemporaryDirectory() as t:
        t = Path(t); d = t / "x"; d.mkdir()
        days = {"20040115": 2.0, "20040116": 60.0, "20040201": -999.0, "20050101": 1.0}
        power = {"properties": {"parameter": {"PRECTOTCORR": days,
                 "T2M": {k: 10.0 for k in days}, "T2M_MAX": {"20040115": 36.0, "20040116": 20.0, "20040201": 34.0},
                 "T2M_MIN": {"20040115": -1.0, "20040116": 5.0}}}}
        (d / "power.json").write_text(json.dumps(power))
        years, c, _ = bc.parse_power(d / "power.json", 2004, 2005)
        assert years == [2004, 2005]
        assert c["rain"][0][0] == 62.0           # Jan 2004: 2 + 60, -999 ignored
        assert c["extreme_days"][0][0] == 1      # the 60 mm day
        assert c["heat_days"][0][0] == 1 and c["frost_days"][0][0] == 1
        # warming scenario counts: 34 C only counts once the threshold drops to 34 (+1 C); 36 C counts at every step
        assert c["heat_by_dt"]["0"][0][1] == 0 and c["heat_by_dt"]["1"][0][1] == 1 and c["heat_by_dt"]["4"][0][0] == 1
        assert c["heat_by_dt"]["0"] == c["heat_days"] and c["frost_by_dt"]["0"] == c["frost_days"]
        assert c["frost_by_dt"]["1"][0][0] == 1 and c["frost_by_dt"]["2"][0][0] == 0  # a -1 C night is frost at +1 C of warming but not at +2 C
        sg = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [
              {"label": "0-5cm", "values": {"Q0.05": 78, "mean": 82, "Q0.95": 86}},
              {"label": "5-15cm", "values": {"Q0.05": 78, "mean": 82, "Q0.95": 86}}]}]}}
        (d / "sg.json").write_text(json.dumps(sg))
        soil, ok = bc.parse_soilgrids(d / "sg.json")
        assert soil["ph"] == {"q05": 7.8, "mean": 8.2, "q95": 8.6} and ok
        # variant: range-based depths, different key case, thickness weighting (10 cm of 8.0, 20 cm of 9.0 -> 8.67)
        sg2 = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [
              {"range": {"top_depth": 0, "bottom_depth": 10}, "label": "0-10cm", "values": {"q0.05": 70, "MEAN": 80, "Q0.95": 90}},
              {"range": {"top_depth": 10, "bottom_depth": 30}, "label": "10-30cm", "values": {"q0.05": 80, "MEAN": 90, "Q0.95": 100}}]}]}}
        (d / "sg2.json").write_text(json.dumps(sg2)); s2, ok2 = bc.parse_soilgrids(d / "sg2.json")
        assert s2["ph"]["mean"] == 8.67 and ok2
        # null values (point with no data) -> empty, never a fake number
        sg3 = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [{"label": "0-5cm", "values": {"Q0.05": None, "mean": None, "Q0.95": None}}]}]}}
        (d / "sg3.json").write_text(json.dumps(sg3)); assert bc.parse_soilgrids(d / "sg3.json")[0] == {}
        # mean only -> still usable, but flagged as having no uncertainty bands
        sg4 = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [{"label": "0-5cm", "values": {"mean": 80}}]}]}}
        (d / "sg4.json").write_text(json.dumps(sg4)); s4, ok4 = bc.parse_soilgrids(d / "sg4.json")
        assert s4["ph"] == {"q05": 8.0, "mean": 8.0, "q95": 8.0} and not ok4
        with open(d / "n.csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["Date", "MOD13Q1_061__250m_16_days_NDVI"])
            w.writerow(["2004-01-01", 4000]); w.writerow(["2005-01-01", 6000]); w.writerow(["2005-02-01", -3000])
        # two places in ONE csv (how AppEEARS returns a multi-location task): each must get only its own rows
        with open(d / "multi.csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["ID", "Date", "MOD13Q1_061__250m_16_days_NDVI"])
            w.writerow(["a", "2004-01-01", 2000]); w.writerow(["b", "2004-01-01", 8000]); w.writerow(["a", "2005-01-01", 4000])
        assert bc.monthly_clim_from_csv(d / "multi.csv", "NDVI", scale=0.0001, row_id="a")[0] == 0.3
        assert bc.monthly_clim_from_csv(d / "multi.csv", "NDVI", scale=0.0001, row_id="b")[0] == 0.8
        assert bc.monthly_clim_from_csv(d / "multi.csv", "NDVI", scale=0.0001, row_id="zzz")[0] is None
        clim = bc.monthly_clim_from_csv(d / "n.csv", "NDVI", scale=0.0001, min_valid=-0.2)
        assert clim[0] == 0.5 and clim[1] is None  # fill value skipped

if __name__ == "__main__":
    test_power_and_soilgrids_parse(); print("python tests passed")
