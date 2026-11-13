import json, sys, tempfile, csv
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import build_cache as bc

def test_power_and_soilgrids_parse():
    with tempfile.TemporaryDirectory() as t:
        t = Path(t); d = t / "x"; d.mkdir()
        days = {"20040115": 2.0, "20040116": 60.0, "20040201": -999.0, "20050101": 1.0}
        power = {"properties": {"parameter": {"PRECTOTCORR": days,
                 "T2M": {k: 10.0 for k in days}, "T2M_MAX": {"20040115": 36.0, "20040116": 20.0},
                 "T2M_MIN": {"20040115": -1.0, "20040116": 5.0}}}}
        (d / "power.json").write_text(json.dumps(power))
        years, c, _ = bc.parse_power(d / "power.json", 2004, 2005)
        assert years == [2004, 2005]
        assert c["rain"][0][0] == 62.0           # Jan 2004: 2 + 60, -999 ignored
        assert c["extreme_days"][0][0] == 1      # the 60 mm day
        assert c["heat_days"][0][0] == 1 and c["frost_days"][0][0] == 1
        sg = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10}, "depths": [
              {"label": "0-5cm", "values": {"Q0.05": 78, "mean": 82, "Q0.95": 86}},
              {"label": "5-15cm", "values": {"Q0.05": 78, "mean": 82, "Q0.95": 86}}]}]}}
        (d / "sg.json").write_text(json.dumps(sg))
        assert bc.parse_soilgrids(d / "sg.json")["ph"] == {"q05": 7.8, "mean": 8.2, "q95": 8.6}
        with open(d / "n.csv", "w", newline="") as f:
            w = csv.writer(f); w.writerow(["Date", "MOD13Q1_061__250m_16_days_NDVI"])
            w.writerow(["2004-01-01", 4000]); w.writerow(["2005-01-01", 6000]); w.writerow(["2005-02-01", -3000])
        clim = bc.monthly_clim_from_csv(d / "n.csv", "NDVI", scale=0.0001, min_valid=-0.2)
        assert clim[0] == 0.5 and clim[1] is None  # fill value skipped

if __name__ == "__main__":
    test_power_and_soilgrids_parse(); print("python tests passed")
