import importlib.util
import os

spec = importlib.util.spec_from_file_location("probe", os.path.join(os.path.dirname(__file__), "..", "tools", "probe_opendap.py"))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)

# a hand-made DAP4-shaped snippet: these test the tool's parsing only, they are NOT NASA data
DMR = """<Dataset xmlns="http://xml.opendap.org/ns/DAP/4.0#" name="x">
  <Dimension name="time" size="1"/><Dimension name="lon" size="3600"/>
  <Group name="Soil_Moisture_Retrieval_Data_AM"><Float32 name="soil_moisture"><Dim name="/row"/><Dim name="/col"/></Float32></Group>
  <Group name="Soil_Moisture_Retrieval_Data_PM"><Float32 name="soil_moisture"><Dim name="/row"/><Dim name="/col"/></Float32></Group>
  <Float32 name="precipitation"><Dim name="/time"/><Dim name="/lon"/></Float32>
</Dataset>"""


def test_finds_variables_inside_groups_and_at_top_level():
    got = probe.find_variables(DMR, "soil_moisture")
    assert [p for p, _ in got] == ["/Soil_Moisture_Retrieval_Data_AM/soil_moisture", "/Soil_Moisture_Retrieval_Data_PM/soil_moisture"]
    assert probe.find_variables(DMR, "precipitation") == [("/precipitation", ["/time", "/lon"])]
    assert probe.find_variables(DMR, "nothing") == []


def test_reads_dimension_sizes():
    assert probe.dim_sizes(DMR) == {"time": "1", "lon": "3600"}


def test_token_is_never_written_to_the_report(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path); monkeypatch.setenv("EARTHDATA_TOKEN", "SECRET-TOKEN-XYZ")
    monkeypatch.setattr(probe, "newest", lambda s: (_ for _ in ()).throw(RuntimeError("offline")))
    probe.LINES.clear(); probe.main()
    out = capsys.readouterr().out + (tmp_path / "opendap_probe_report.txt").read_text()
    assert "SECRET-TOKEN-XYZ" not in out
